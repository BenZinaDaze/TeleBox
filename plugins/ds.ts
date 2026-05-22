import axios from "axios";
import path from "path";
import sharp from "sharp";
import { JSONFilePreset } from "lowdb/node";
import { Api } from "teleproto";
import { Plugin } from "@utils/pluginBase";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getPrefixes } from "@utils/pluginManager";
import { safeGetMe } from "@utils/authGuards";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { TelegramFormatter } from "@utils/telegramFormatter";

type RouteKind = "text" | "vision";

type ProviderConfig = {
  apiKey: string;
  baseURL: string;
  textModel: string;
  visionModel: string;
  supportsText: boolean;
  supportsVision: boolean;
};

type DsConfig = {
  currentTextProvider: string;
  currentVisionProvider: string;
  systemPrompt: string;
  providers: Record<string, ProviderConfig>;
};

type ChatContentPart =
  | { type: "text"; text: string }
  | {
      type: "image_url";
      image_url: {
        url: string;
        detail?: "auto" | "low" | "high";
      };
    };

type ChatMessage = {
  role: "system" | "user";
  content: string | ChatContentPart[];
};

type ProviderDefinition = {
  id: string;
  displayName: string;
  defaultBaseURL: string;
  defaultTextModel: string;
  defaultVisionModel: string;
  supportsText: boolean;
  supportsVision: boolean;
  supportsStream: boolean;
};

type PreparedImage = {
  buffer: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  originalBytes: number;
  finalBytes: number;
};

type AskContext =
  | {
      route: "text";
      question: string;
      repliedText?: string;
    }
  | {
      route: "vision";
      question: string;
      caption: string;
      image: PreparedImage;
    };

const PLUGIN_NAME = "ds";
const DEFAULT_TEXT_PROVIDER = "deepseek";
const DEFAULT_VISION_PROVIDER = "siliconflow";
const TELEGRAM_TEXT_LIMIT = 3500;
const STREAM_EDIT_INTERVAL_MS = 900;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const TARGET_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCE_DIMENSION = 2048;
const MAX_CAPTION_CHARS = 1000;
const MAX_QUESTION_CHARS = 2000;
const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";
const CONFIG_PATH = path.join(
  createDirectoryInAssets(PLUGIN_NAME),
  "config.json",
);

const PROVIDERS: Record<string, ProviderDefinition> = {
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    defaultBaseURL: "https://api.deepseek.com",
    defaultTextModel: "deepseek-v4-flash",
    defaultVisionModel: "",
    supportsText: true,
    supportsVision: false,
    supportsStream: true,
  },
  siliconflow: {
    id: "siliconflow",
    displayName: "SiliconFlow",
    defaultBaseURL: "https://api.siliconflow.cn/v1",
    defaultTextModel: "",
    defaultVisionModel: "Qwen/Qwen3-VL-32B-Instruct",
    supportsText: true,
    supportsVision: true,
    supportsStream: true,
  },
};

const DEFAULT_CONFIG: DsConfig = {
  currentTextProvider: DEFAULT_TEXT_PROVIDER,
  currentVisionProvider: DEFAULT_VISION_PROVIDER,
  systemPrompt: "",
  providers: Object.fromEntries(
    Object.values(PROVIDERS).map((provider) => [
      provider.id,
      {
        apiKey: "",
        baseURL: provider.defaultBaseURL,
        textModel: provider.defaultTextModel,
        visionModel: provider.defaultVisionModel,
        supportsText: provider.supportsText,
        supportsVision: provider.supportsVision,
      },
    ]),
  ),
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function getComparableId(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["userId", "chatId", "channelId", "senderId", "id"]) {
    const nested = getComparableId(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

function getMessageSenderId(msg: Api.Message): string | undefined {
  return (
    getComparableId((msg as Api.Message & { senderId?: unknown }).senderId) ||
    getComparableId((msg as Api.Message & { fromId?: unknown }).fromId)
  );
}

function getMatchedPrefix(text: string): string {
  return prefixes.find((prefix) => text.startsWith(prefix)) || text[0] || mainPrefix;
}

function getCommandPayload(text: string): string {
  const prefix = getMatchedPrefix(text);
  const rest = text.slice(prefix.length).trim();
  if (!rest) return "";
  const firstSpace = rest.indexOf(" ");
  if (firstSpace === -1) return "";
  return rest.slice(firstSpace + 1).trim();
}

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  return `${text.slice(0, TELEGRAM_TEXT_LIMIT)}\n\n…(输出过长，已截断)`;
}

function maskApiKey(apiKey: string): string {
  const value = apiKey.trim();
  if (!value) return "未配置";
  if (value.length <= 7) {
    return `${value[0] || "*"}***${value[value.length - 1] || "*"}`;
  }
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function formatAiOutput(content: string): string {
  const body = content.trim() || "(无内容)";
  return TelegramFormatter.markdownToHtml(truncateForTelegram(body));
}

function renderAnswer(params: {
  providerName: string;
  model: string;
  answer: string;
  question?: string;
}): string {
  const header = `🤖 <b>${escapeHtml(params.providerName)} · ${escapeHtml(params.model)}</b>`;
  const answer = formatAiOutput(params.answer);
  const question = params.question?.trim() || "";
  if (question) {
    return `${escapeHtml(question)}\n\n──────────\n\n${header}\n\n${answer}`;
  }
  return `${header}\n\n${answer}`;
}

function routeLabel(route: RouteKind): string {
  return route === "text" ? "Text Route" : "Vision Route";
}

function getRouteProviderId(config: DsConfig, route: RouteKind): string {
  return route === "text" ? config.currentTextProvider : config.currentVisionProvider;
}

function getRouteModel(config: DsConfig, route: RouteKind, providerId: string): string {
  const provider = config.providers[providerId];
  if (!provider) return "";
  return route === "text" ? provider.textModel : provider.visionModel;
}

function getRouteFixCommand(config: DsConfig, route: RouteKind): string {
  const providerId = getRouteProviderId(config, route);
  return `${mainPrefix}ds key set ${providerId} <apiKey>`;
}

function normalizeProviderConfig(
  name: string,
  raw?: Partial<ProviderConfig> | null,
): ProviderConfig {
  const provider = PROVIDERS[name];
  const base = provider
    ? {
        apiKey: "",
        baseURL: provider.defaultBaseURL,
        textModel: provider.defaultTextModel,
        visionModel: provider.defaultVisionModel,
        supportsText: provider.supportsText,
        supportsVision: provider.supportsVision,
      }
    : {
        apiKey: "",
        baseURL: "",
        textModel: "",
        visionModel: "",
        supportsText: false,
        supportsVision: false,
      };

  const legacyModel =
    typeof (raw as { model?: unknown } | undefined)?.model === "string"
      ? String((raw as { model?: string }).model).trim()
      : "";

  return {
    apiKey: raw?.apiKey?.trim() || base.apiKey,
    baseURL: raw?.baseURL?.trim() || base.baseURL,
    textModel: raw?.textModel?.trim() || legacyModel || base.textModel,
    visionModel: raw?.visionModel?.trim() || base.visionModel,
    supportsText: provider ? provider.supportsText : !!raw?.supportsText,
    supportsVision: provider ? provider.supportsVision : !!raw?.supportsVision,
  };
}

function normalizeConfig(raw?: Partial<DsConfig> | null): DsConfig {
  const rawRecord = (raw || {}) as Partial<DsConfig> & {
    providers?: Record<string, Partial<ProviderConfig>>;
  };

  const providers = Object.fromEntries(
    Object.keys(PROVIDERS).map((name) => [
      name,
      normalizeProviderConfig(name, rawRecord.providers?.[name]),
    ]),
  );

  const currentTextProvider =
    rawRecord.currentTextProvider?.trim().toLowerCase() ||
    DEFAULT_TEXT_PROVIDER;
  const currentVisionProvider =
    rawRecord.currentVisionProvider?.trim().toLowerCase() ||
    DEFAULT_VISION_PROVIDER;

  return {
    currentTextProvider: PROVIDERS[currentTextProvider]
      ? currentTextProvider
      : DEFAULT_TEXT_PROVIDER,
    currentVisionProvider: PROVIDERS[currentVisionProvider]?.supportsVision
      ? currentVisionProvider
      : DEFAULT_VISION_PROVIDER,
    systemPrompt: rawRecord.systemPrompt?.trim() || "",
    providers,
  };
}

function takeWithMarker(text: string, maxChars: number, label: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return `[${label}已截断]\n${trimmed.slice(0, maxChars)}`;
}

async function safeEditMessage(
  msg: Api.Message,
  text: string,
  parseMode?: "html",
): Promise<void> {
  if (parseMode) {
    await msg.edit({ text, parseMode }).catch(() => undefined);
    return;
  }
  await msg.edit({ text }).catch(() => undefined);
}

async function ensureSelfInvocation(msg: Api.Message): Promise<boolean> {
  if (msg.out) return true;
  if (!msg.client) return false;

  try {
    const me = await safeGetMe(msg.client);
    const ownerId = getComparableId(me?.id);
    const senderId = getMessageSenderId(msg);
    return !!ownerId && !!senderId && ownerId === senderId;
  } catch {
    return false;
  }
}

function getProviderOrThrow(providerId: string): ProviderDefinition {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(`Provider ${providerId} 尚未实现。`);
  }
  return provider;
}

function getMessageImageMimeType(message: Api.Message): string {
  const documentMime = (message.media as { document?: { mimeType?: unknown } } | undefined)
    ?.document?.mimeType;
  if (typeof documentMime === "string" && documentMime.startsWith("image/")) {
    return documentMime;
  }
  if ((message.media as { photo?: unknown } | undefined)?.photo) {
    return "image/jpeg";
  }
  return "image/png";
}

function isSupportedMimeType(mimeType: string): mimeType is PreparedImage["mimeType"] {
  return (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/webp"
  );
}

async function getReplyImageBuffer(msg: Api.Message): Promise<Buffer | null> {
  const replyMsg = await safeGetReplyMessage(msg);
  if (!replyMsg?.media) return null;
  if (!msg.client) {
    throw new Error("无法获取 Telegram 客户端实例");
  }

  const client = msg.client as {
    downloadMedia: (
      media: unknown,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  const mediaData = await client.downloadMedia(replyMsg.media, { workers: 1 });
  if (Buffer.isBuffer(mediaData)) {
    return mediaData.length ? mediaData : null;
  }
  if (mediaData && typeof (mediaData as { read?: unknown }).read === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of mediaData as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    return buffer.length ? buffer : null;
  }
  return null;
}

async function prepareReplyImage(msg: Api.Message): Promise<PreparedImage | null> {
  const replyMsg = await safeGetReplyMessage(msg);
  if (!replyMsg?.media) return null;

  if ((replyMsg as Api.Message & { groupedId?: unknown }).groupedId) {
    throw new Error(
      `当前仅支持单张静态图片。请回复单张静态图片后执行 <code>${escapeHtml(mainPrefix)}ds</code> 或 <code>${escapeHtml(mainPrefix)}ds 这是什么</code>。`,
    );
  }

  const sourceBuffer = await getReplyImageBuffer(msg);
  if (!sourceBuffer?.length) {
    throw new Error("未能获取图片数据。请确认被回复消息确实包含单张静态图片。");
  }

  const originalMime = getMessageImageMimeType(replyMsg);
  let transformer: sharp.Sharp;
  try {
    transformer = sharp(sourceBuffer, { animated: true, failOn: "warning" });
  } catch {
    throw new Error(
      `当前仅支持单张静态图片。请回复单张静态图片后执行 <code>${escapeHtml(mainPrefix)}ds</code> 或 <code>${escapeHtml(mainPrefix)}ds 这是什么</code>。`,
    );
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await transformer.metadata();
  } catch {
    throw new Error("无法读取图片信息，请换一张静态 JPG/PNG/WebP 图片。");
  }

  if ((metadata.pages || 1) > 1) {
    throw new Error(
      `当前仅支持单张静态图片。请回复单张静态图片后执行 <code>${escapeHtml(mainPrefix)}ds</code> 或 <code>${escapeHtml(mainPrefix)}ds 这是什么</code>。`,
    );
  }

  const normalizedMime: PreparedImage["mimeType"] = isSupportedMimeType(originalMime)
    ? originalMime
    : "image/jpeg";

  let pipeline = sharp(sourceBuffer)
    .rotate()
    .resize({
      width: MAX_REFERENCE_DIMENSION,
      height: MAX_REFERENCE_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    });

  if (normalizedMime === "image/png") {
    pipeline = pipeline.png({ compressionLevel: 9, palette: true });
  } else if (normalizedMime === "image/webp") {
    pipeline = pipeline.webp({ quality: 85 });
  } else {
    pipeline = pipeline.jpeg({ quality: 85, mozjpeg: true });
  }

  let output = await pipeline.toBuffer();
  let finalMime = normalizedMime;

  if (output.length > TARGET_REFERENCE_BYTES) {
    output = await sharp(output)
      .rotate()
      .resize({
        width: 1536,
        height: 1536,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
    finalMime = "image/jpeg";
  }

  if (output.length > MAX_REFERENCE_BYTES) {
    throw new Error(
      `图片处理后仍然过大（${formatBytes(output.length)}），请换一张更小的静态图片。`,
    );
  }

  return {
    buffer: output,
    mimeType: finalMime,
    originalBytes: sourceBuffer.length,
    finalBytes: output.length,
  };
}

class OpenAICompatProvider {
  readonly definition: ProviderDefinition;

  constructor(definition: ProviderDefinition) {
    this.definition = definition;
  }

  private getEndpoint(baseURL: string): string {
    return `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  }

  async complete(
    route: RouteKind,
    providerConfig: ProviderConfig,
    messages: ChatMessage[],
  ): Promise<string> {
    const response = await axios.post(
      this.getEndpoint(providerConfig.baseURL),
      {
        model: route === "text" ? providerConfig.textModel : providerConfig.visionModel,
        messages,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${providerConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 60_000,
      },
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (content.trim()) return content;
    throw new Error(route === "vision" ? "视觉接口返回为空" : "接口返回为空");
  }

  async stream(
    route: RouteKind,
    providerConfig: ProviderConfig,
    messages: ChatMessage[],
    onDelta: (text: string) => void,
  ): Promise<void> {
    const response = await axios.post(
      this.getEndpoint(providerConfig.baseURL),
      {
        model: route === "text" ? providerConfig.textModel : providerConfig.visionModel,
        messages,
        stream: true,
      },
      {
        headers: {
          Authorization: `Bearer ${providerConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        responseType: "stream",
        timeout: 120_000,
      },
    );

    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const stream: NodeJS.ReadableStream = response.data;

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") return;

        try {
          const parsed = JSON.parse(payload);
          const choice = parsed?.choices?.[0];
          const delta = choice?.delta?.content;
          if (delta) onDelta(delta);
        } catch {
          // ignore partial JSON chunks
        }
      };

      stream.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          processLine(line);
          newlineIndex = buffer.indexOf("\n");
        }
      });

      stream.on("end", () => {
        if (buffer.trim()) processLine(buffer);
        resolve();
      });

      stream.on("error", reject);
    });
  }
}

const providerClients: Record<string, OpenAICompatProvider> = Object.fromEntries(
  Object.values(PROVIDERS).map((provider) => [provider.id, new OpenAICompatProvider(provider)]),
);

class DsConfigStore {
  private readonly dbPromise = JSONFilePreset<DsConfig>(CONFIG_PATH, DEFAULT_CONFIG);

  async get(): Promise<DsConfig> {
    const db = await this.dbPromise;
    const normalized = normalizeConfig(db.data);
    const changed = JSON.stringify(db.data) !== JSON.stringify(normalized);
    if (changed) {
      db.data = normalized;
      await db.write();
    }
    return normalized;
  }

  async set(patch: Partial<DsConfig>): Promise<DsConfig> {
    const db = await this.dbPromise;
    db.data = normalizeConfig({ ...db.data, ...patch });
    await db.write();
    return db.data;
  }

  async setProviderConfig(
    providerName: string,
    patch: Partial<ProviderConfig>,
  ): Promise<DsConfig> {
    const db = await this.dbPromise;
    const normalized = normalizeConfig(db.data);
    const providerKey = providerName.trim().toLowerCase();
    if (!PROVIDERS[providerKey]) {
      throw new Error(`Provider <code>${escapeHtml(providerKey)}</code> 尚未实现。`);
    }
    normalized.providers[providerKey] = normalizeProviderConfig(providerKey, {
      ...normalized.providers[providerKey],
      ...patch,
    });
    db.data = normalized;
    await db.write();
    return db.data;
  }
}

function mapProviderError(error: unknown, route: RouteKind, routeModel: string): string {
  if (!axios.isAxiosError(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  const status = error.response?.status;
  let detail = "";
  if (typeof error.response?.data === "string") {
    detail = error.response.data.slice(0, 300);
  } else if (error.response?.data && typeof error.response.data === "object") {
    const data = error.response.data as Record<string, unknown>;
    const candidates = [
      data.message,
      data.error,
      (data.error as Record<string, unknown> | undefined)?.message,
      (data.detail as unknown),
    ];
    detail = candidates.find((value) => typeof value === "string" && value.trim()) as string || "";
  }
  if (!detail) {
    detail = error.message || "";
  }
  const normalizedDetail = detail.toLowerCase();

  if (error.code === "ECONNABORTED") {
    return route === "vision" ? "视觉请求超时，请稍后重试。" : "请求超时，请稍后重试。";
  }
  if (status === 401 || status === 403) {
    return "鉴权失败，请检查 API Key 配置。";
  }
  if (status === 429) {
    return "请求过于频繁，请稍后再试。";
  }
  if (status === 408 || status === 504) {
    return route === "vision" ? "视觉请求超时，请稍后重试。" : "请求超时，请稍后重试。";
  }
  if (
    route === "vision" &&
    status === 400 &&
    (
      normalizedDetail.includes("image") ||
      normalizedDetail.includes("vision") ||
      normalizedDetail.includes("multimodal") ||
      normalizedDetail.includes("content")
    )
  ) {
    return `当前视觉模型 <code>${escapeHtml(routeModel)}</code> 可能不支持图像输入，请更换 <code>visionModel</code>。`;
  }
  if (status && status >= 400 && status < 500) {
    return detail || "请求参数无效。";
  }
  return detail || "远端服务请求失败。";
}

function buildTextPrompt(question: string, repliedText?: string): string {
  if (repliedText && question) {
    return `被回复消息：\n${repliedText}\n\n当前问题：\n${question}`;
  }
  if (repliedText) return repliedText;
  return question;
}

function buildVisionTextBlock(question: string, caption: string): string {
  const lines: string[] = [];

  if (question) {
    lines.push(`当前问题：\n${question}`);
    lines.push("请先直接回答当前问题，必要时再引用图片中的可见文字或细节作为依据。");
  } else {
    lines.push("默认任务：请简洁描述图片内容。");
    lines.push("如果图片含有可辨认文字，优先提取关键文字，再结合图像内容回答。");
    lines.push("看不清就明确说明，不要臆测，并尽量区分可见文字与解释。");
    lines.push("如果不确定，请使用“可能”“看不清”“不确定”等保守表达。");
  }

  if (caption) {
    lines.push(`图片消息 caption：\n${caption}`);
  }

  return lines.join("\n\n");
}

async function resolveAskContext(msg: Api.Message, payload: string): Promise<AskContext> {
  const replied = await safeGetReplyMessage(msg);
  const question = takeWithMarker(payload.trim(), MAX_QUESTION_CHARS, "问题");

  if (!replied) {
    if (!question) {
      throw new Error(
        `❌ 用法错误：请直接提问，或回复一条消息后再发送 <code>${escapeHtml(mainPrefix)}ds</code>。`,
      );
    }
    return { route: "text", question };
  }

  if (replied.media) {
    const image = await prepareReplyImage(msg);
    if (!image) {
      throw new Error(
        `当前仅支持单张静态图片。请回复单张静态图片后执行 <code>${escapeHtml(mainPrefix)}ds</code> 或 <code>${escapeHtml(mainPrefix)}ds 这是什么</code>。`,
      );
    }
    const caption = takeWithMarker((replied.message || "").trim(), MAX_CAPTION_CHARS, "caption");
    return {
      route: "vision",
      question,
      caption,
      image,
    };
  }

  const repliedText = (replied.message || "").trim();
  if (!repliedText && !question) {
    throw new Error(
      `❌ 用法错误：请直接提问，或回复一条消息后再发送 <code>${escapeHtml(mainPrefix)}ds</code>。`,
    );
  }
  if (!repliedText) {
    throw new Error("❌ 被回复的消息没有可用文本。");
  }
  return {
    route: "text",
    question,
    repliedText,
  };
}

function buildMessages(config: DsConfig, context: AskContext): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (config.systemPrompt) {
    messages.push({ role: "system", content: config.systemPrompt });
  }

  if (context.route === "vision") {
    messages.push({
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: `data:${context.image.mimeType};base64,${context.image.buffer.toString("base64")}`,
            detail: "high",
          },
        },
        {
          type: "text",
          text: buildVisionTextBlock(context.question, context.caption),
        },
      ],
    });
    return messages;
  }

  messages.push({
    role: "user",
    content: buildTextPrompt(context.question, context.repliedText),
  });
  return messages;
}

class DsPlugin extends Plugin {
  name = PLUGIN_NAME;
  description =
    `DS 对话插件\n` +
    `<code>${mainPrefix}ds [问题]</code> - 直接提问\n` +
    `<code>${mainPrefix}ds</code> - 回复文本继续对话，或回复单张静态图片做识别\n` +
    `<code>${mainPrefix}ds 这是什么</code> - 回复图片并提问\n` +
    `<code>${mainPrefix}ds status</code> - 查看 text / vision 路由状态\n` +
    `<code>${mainPrefix}ds config</code> - 查看格式化配置\n` +
    `<code>${mainPrefix}ds provider list</code> - 查看 Provider、能力和当前路由\n` +
    `<code>${mainPrefix}ds provider set text deepseek</code> - 设置文本路由 Provider\n` +
    `<code>${mainPrefix}ds provider set vision siliconflow</code> - 设置视觉路由 Provider\n` +
    `<code>${mainPrefix}ds key set &lt;provider&gt; &lt;apiKey&gt;</code> - 按 Provider 名设置 API Key\n` +
    `<code>${mainPrefix}ds model set text deepseek-v4-flash</code> - 设置文本模型\n` +
    `<code>${mainPrefix}ds model set vision Qwen/Qwen3-VL-32B-Instruct</code> - 设置视觉模型\n` +
    `<code>${mainPrefix}ds prompt show|set|clear</code> - 管理全局 System Prompt\n` +
    `<code>${mainPrefix}ds help</code> - 查看帮助`;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    ds: async (msg) => {
      if (!(await ensureSelfInvocation(msg))) return;
      await this.handleDs(msg);
    },
  };

  private readonly configStore = new DsConfigStore();

  private async handleDs(msg: Api.Message): Promise<void> {
    const payload = getCommandPayload(msg.message || "");
    const [first = "", second = ""] = payload.split(/\s+/);
    const lowerFirst = first.toLowerCase();
    const lowerSecond = second.toLowerCase();

    if (lowerFirst === "help") {
      await this.handleHelp(msg);
      return;
    }
    if (lowerFirst === "status") {
      await this.handleStatus(msg);
      return;
    }
    if (lowerFirst === "config") {
      await this.handleConfig(msg);
      return;
    }
    if (lowerFirst === "provider") {
      await this.handleProvider(msg, lowerSecond, payload);
      return;
    }
    if (lowerFirst === "model") {
      await this.handleModel(msg, lowerSecond, payload);
      return;
    }
    if (lowerFirst === "key") {
      await this.handleKey(msg, lowerSecond, payload);
      return;
    }
    if (lowerFirst === "prompt") {
      await this.handlePrompt(msg, lowerSecond, payload);
      return;
    }
    if (lowerFirst === "test") {
      await safeEditMessage(msg, "❌ `ds test` 已删除。请直接使用 `status`、`provider list` 和实际请求验证。");
      return;
    }

    await this.handleAsk(msg, payload);
  }

  private async handleHelp(msg: Api.Message): Promise<void> {
    await safeEditMessage(msg, this.description, "html");
  }

  private async handleStatus(msg: Api.Message): Promise<void> {
    const config = await this.configStore.get();
    const lines = ["🤖 <b>DS 当前状态</b>", ""];

    for (const route of ["text", "vision"] as const) {
      const providerId = getRouteProviderId(config, route);
      const provider = getProviderOrThrow(providerId);
      const providerConfig = config.providers[providerId];
      const model = getRouteModel(config, route, providerId);
      lines.push(`${route === "text" ? "📝" : "🖼️"} <b>${routeLabel(route)}</b>`);
      lines.push(`• Provider: <code>${escapeHtml(provider.displayName)}</code> (<code>${escapeHtml(provider.id)}</code>)`);
      lines.push(`• Base URL: <code>${escapeHtml(providerConfig.baseURL)}</code>`);
      lines.push(`• Model: <code>${escapeHtml(model || "(未设置)")}</code>`);
      lines.push(`• API Key: <code>${escapeHtml(maskApiKey(providerConfig.apiKey))}</code>`);
      if (!providerConfig.apiKey) {
        lines.push(`• 状态: <b>未配置 Key</b>`);
        lines.push(`• 修复: <code>${escapeHtml(getRouteFixCommand(config, route))}</code>`);
      } else {
        lines.push("• 状态: 已就绪");
      }
      lines.push("");
    }

    lines.push(
      `📝 <b>Global System Prompt</b>: ${
        config.systemPrompt
          ? `<code>${escapeHtml(truncateForTelegram(config.systemPrompt))}</code>`
          : "未设置"
      }`,
    );

    await safeEditMessage(msg, lines.join("\n"), "html");
  }

  private async handleConfig(msg: Api.Message): Promise<void> {
    const config = await this.configStore.get();
    const maskedConfig: DsConfig = {
      currentTextProvider: config.currentTextProvider,
      currentVisionProvider: config.currentVisionProvider,
      systemPrompt: config.systemPrompt,
      providers: Object.fromEntries(
        Object.entries(config.providers).map(([name, providerConfig]) => [
          name,
          {
            ...providerConfig,
            apiKey: maskApiKey(providerConfig.apiKey),
          },
        ]),
      ),
    };

    await safeEditMessage(
      msg,
      `⚙️ <b>DS Config</b>\n<pre>${escapeHtml(truncateForTelegram(JSON.stringify(maskedConfig, null, 2)))}</pre>`,
      "html",
    );
  }

  private async handleProvider(
    msg: Api.Message,
    subCommand: string,
    payload: string,
  ): Promise<void> {
    if (subCommand === "list") {
      const config = await this.configStore.get();
      const lines = ["🧩 <b>可用 Provider</b>"];

      for (const provider of Object.values(PROVIDERS)) {
        const providerConfig = config.providers[provider.id];
        const flags: string[] = [];
        if (config.currentTextProvider === provider.id) flags.push("Text Current");
        if (config.currentVisionProvider === provider.id) flags.push("Vision Current");
        const capabilities = [
          provider.supportsText ? "Text" : null,
          provider.supportsVision ? "Vision" : null,
        ].filter(Boolean).join(", ");

        lines.push(
          [
            `${flags.length ? "✅" : "•"} <b>${escapeHtml(provider.displayName)}</b> (<code>${escapeHtml(provider.id)}</code>)`,
            `能力: ${escapeHtml(capabilities || "无")}`,
            `状态: ${providerConfig.apiKey ? "已配置 Key" : "未配置 Key"}`,
            flags.length ? `路由: ${escapeHtml(flags.join(" / "))}` : "路由: 未选中",
          ].join(" | "),
        );
      }

      await safeEditMessage(msg, lines.join("\n"), "html");
      return;
    }

    if (subCommand !== "set") {
      await safeEditMessage(
        msg,
        [
          `用法：<code>${escapeHtml(mainPrefix)}ds provider list</code>`,
          `<code>${escapeHtml(mainPrefix)}ds provider set text deepseek</code>`,
          `<code>${escapeHtml(mainPrefix)}ds provider set vision siliconflow</code>`,
        ].join("\n"),
        "html",
      );
      return;
    }

    const parts = payload.split(/\s+/);
    if (parts.length === 3) {
      await safeEditMessage(
        msg,
        "❌ 旧命令 `ds provider set <provider>` 已废弃，请改用 `ds provider set text <provider>` 或 `ds provider set vision <provider>`。",
      );
      return;
    }

    const route = parts[2]?.trim().toLowerCase() as RouteKind | undefined;
    const providerId = parts[3]?.trim().toLowerCase();
    if ((route !== "text" && route !== "vision") || !providerId) {
      await safeEditMessage(
        msg,
        [
          `用法：<code>${escapeHtml(mainPrefix)}ds provider set text deepseek</code>`,
          `<code>${escapeHtml(mainPrefix)}ds provider set vision siliconflow</code>`,
        ].join("\n"),
        "html",
      );
      return;
    }

    const provider = PROVIDERS[providerId];
    if (!provider) {
      await safeEditMessage(msg, `❌ Provider <code>${escapeHtml(providerId)}</code> 尚未实现。`, "html");
      return;
    }
    if (route === "text" && !provider.supportsText) {
      await safeEditMessage(msg, `❌ Provider <code>${escapeHtml(providerId)}</code> 不支持 text 路由。`, "html");
      return;
    }
    if (route === "vision" && !provider.supportsVision) {
      await safeEditMessage(msg, `❌ Provider <code>${escapeHtml(providerId)}</code> 不支持 vision 路由。`, "html");
      return;
    }

    const patch =
      route === "text"
        ? { currentTextProvider: providerId }
        : { currentVisionProvider: providerId };
    const config = await this.configStore.set(patch);
    const providerConfig = config.providers[providerId];
    const model = getRouteModel(config, route, providerId);
    const lines = [
      `✅ ${routeLabel(route)} 已切换为 <code>${escapeHtml(provider.displayName)}</code> (<code>${escapeHtml(provider.id)}</code>)`,
      `Model: <code>${escapeHtml(model || "(未设置)")}</code>`,
      `API Key: <code>${escapeHtml(maskApiKey(providerConfig.apiKey))}</code>`,
    ];
    if (!providerConfig.apiKey) {
      lines.push(`提示：该路由尚未配置 API Key，可执行 <code>${escapeHtml(getRouteFixCommand(config, route))}</code>`);
    }
    await safeEditMessage(msg, lines.join("\n"), "html");
  }

  private async handleModel(
    msg: Api.Message,
    subCommand: string,
    payload: string,
  ): Promise<void> {
    if (subCommand !== "set") {
      await safeEditMessage(
        msg,
        [
          `用法：<code>${escapeHtml(mainPrefix)}ds model set text deepseek-v4-flash</code>`,
          `<code>${escapeHtml(mainPrefix)}ds model set vision Qwen/Qwen3-VL-32B-Instruct</code>`,
        ].join("\n"),
        "html",
      );
      return;
    }

    const parts = payload.split(/\s+/);
    if (parts.length === 3) {
      await safeEditMessage(
        msg,
        "❌ 旧命令 `ds model set <model>` 已废弃，请改用 `ds model set text <model>` 或 `ds model set vision <model>`。",
      );
      return;
    }

    const route = parts[2]?.trim().toLowerCase() as RouteKind | undefined;
    const model = payload.replace(/^model\s+set\s+(text|vision)\s+/i, "").trim();
    if ((route !== "text" && route !== "vision") || !model) {
      await safeEditMessage(
        msg,
        [
          `用法：<code>${escapeHtml(mainPrefix)}ds model set text deepseek-v4-flash</code>`,
          `<code>${escapeHtml(mainPrefix)}ds model set vision Qwen/Qwen3-VL-32B-Instruct</code>`,
        ].join("\n"),
        "html",
      );
      return;
    }

    const config = await this.configStore.get();
    const providerId = getRouteProviderId(config, route);
    const updated = await this.configStore.setProviderConfig(
      providerId,
      route === "text" ? { textModel: model } : { visionModel: model },
    );
    const provider = getProviderOrThrow(providerId);
    await safeEditMessage(
      msg,
      `✅ <code>${escapeHtml(provider.displayName)}</code> 的 ${route} 模型已设置为 <code>${escapeHtml(getRouteModel(updated, route, providerId))}</code>`,
      "html",
    );
  }

  private async handleKey(
    msg: Api.Message,
    subCommand: string,
    payload: string,
  ): Promise<void> {
    if (subCommand !== "set") {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds key set &lt;provider&gt; &lt;apiKey&gt;</code>`,
        "html",
      );
      return;
    }

    const parts = payload.split(/\s+/);
    const providerId = parts[2]?.trim().toLowerCase();
    const apiKey = payload.replace(/^key\s+set\s+\S+\s+/i, "").trim();
    if (!providerId || !apiKey) {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds key set &lt;provider&gt; &lt;apiKey&gt;</code>`,
        "html",
      );
      return;
    }
    if (!PROVIDERS[providerId]) {
      await safeEditMessage(msg, `❌ Provider <code>${escapeHtml(providerId)}</code> 尚未实现。`, "html");
      return;
    }

    await this.configStore.setProviderConfig(providerId, { apiKey });
    await safeEditMessage(
      msg,
      `✅ Provider <code>${escapeHtml(providerId)}</code> 的 API Key 已更新：<code>${escapeHtml(maskApiKey(apiKey))}</code>`,
      "html",
    );
  }

  private async handlePrompt(
    msg: Api.Message,
    subCommand: string,
    payload: string,
  ): Promise<void> {
    if (subCommand === "show") {
      const config = await this.configStore.get();
      await safeEditMessage(
        msg,
        config.systemPrompt
          ? `📝 <b>当前 Global System Prompt</b>\n<code>${escapeHtml(config.systemPrompt)}</code>`
          : "📝 当前未设置 Global System Prompt。",
        config.systemPrompt ? "html" : undefined,
      );
      return;
    }

    if (subCommand === "clear") {
      await this.configStore.set({ systemPrompt: "" });
      await safeEditMessage(msg, "✅ Global System Prompt 已清空。");
      return;
    }

    if (subCommand === "set") {
      const prompt = payload.replace(/^prompt\s+set\s+/i, "").trim();
      if (!prompt) {
        await safeEditMessage(
          msg,
          `用法：<code>${escapeHtml(mainPrefix)}ds prompt set 你是一个简洁的助手</code>`,
          "html",
        );
        return;
      }
      await this.configStore.set({ systemPrompt: prompt });
      await safeEditMessage(msg, "✅ Global System Prompt 已更新。");
      return;
    }

    await safeEditMessage(
      msg,
      [
        `用法：<code>${escapeHtml(mainPrefix)}ds prompt show</code>`,
        `<code>${escapeHtml(mainPrefix)}ds prompt set 你是一个简洁的助手</code>`,
        `<code>${escapeHtml(mainPrefix)}ds prompt clear</code>`,
      ].join("\n"),
      "html",
    );
  }

  private async handleAsk(msg: Api.Message, payload: string): Promise<void> {
    let context: AskContext;
    try {
      context = await resolveAskContext(msg, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await safeEditMessage(msg, message, message.includes("<code>") ? "html" : undefined);
      return;
    }

    const config = await this.configStore.get();
    const route = context.route;
    const providerId = getRouteProviderId(config, route);
    const provider = getProviderOrThrow(providerId);
    const providerConfig = config.providers[providerId];
    const routeModel = getRouteModel(config, route, providerId);

    if (!providerConfig.apiKey) {
      await safeEditMessage(
        msg,
        `❌ ${routeLabel(route)} 未配置 API Key，请先执行 <code>${escapeHtml(getRouteFixCommand(config, route))}</code>。`,
        "html",
      );
      return;
    }

    const messages = buildMessages(config, context);

    if (context.question) {
      await safeEditMessage(msg, `${escapeHtml(context.question)}\n\n──────────\n\n思考中…`, "html");
    } else {
      await safeEditMessage(
        msg,
        `🤖 正在请求 ${provider.displayName} (${routeModel})…`,
      );
    }

    let combined = "";
    let lastEditAt = 0;
    let renderChain = Promise.resolve();

    const flush = async (force = false): Promise<void> => {
      if (!force && Date.now() - lastEditAt < STREAM_EDIT_INTERVAL_MS) return;
      lastEditAt = Date.now();
      await safeEditMessage(
        msg,
        renderAnswer({
          providerName: provider.displayName,
          model: routeModel,
          answer: combined,
          question: context.question,
        }),
        "html",
      );
    };

    try {
      if (provider.supportsStream) {
        await providerClients[providerId].stream(route, providerConfig, messages, (delta) => {
          combined += delta;
          renderChain = renderChain.then(() => flush(false)).catch(() => undefined);
        });
        await renderChain;
      } else {
        combined = await providerClients[providerId].complete(route, providerConfig, messages);
      }

      if (!combined.trim()) {
        throw new Error(route === "vision" ? "视觉接口返回为空" : "接口返回为空");
      }
      await flush(true);
    } catch (error) {
      const friendly = mapProviderError(error, route, routeModel);
      await safeEditMessage(msg, `❌ ${friendly}`, friendly.includes("<code>") ? "html" : undefined);
    }
  }
}

export default new DsPlugin();
