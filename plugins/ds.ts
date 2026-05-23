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
import {
  createChatCompletion,
  streamChatCompletion,
} from "@utils/openAICompat";

type RouteKind = "text" | "vision";
type ProviderId = "deepseek" | "siliconflow" | "ark" | "kimi";
type KeyProviderId = "deepseek" | "siliconflow" | "ark" | "kimi";

type ProviderDefinition = {
  id: ProviderId;
  displayName: string;
  baseURL: string;
  keyProviderId: KeyProviderId;
  supportsText: boolean;
  supportsVision: boolean;
  supportsStream: boolean;
  model?: string;
  models?: string[];
  description: string;
};

type RouteConfig = {
  provider: ProviderId;
};

type ProviderConfig = {
  model?: string;
  models?: string[];
};

type DsConfig = {
  text: RouteConfig;
  vision: RouteConfig;
  systemPrompt: string;
  keys: Record<KeyProviderId, string>;
  providers: Record<ProviderId, ProviderConfig>;
  cursors: Record<RouteKind, number>;
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

type RouteSelection = {
  config: DsConfig;
  provider: ProviderDefinition;
  model: string;
  pool: string[];
  selectedIndex: number;
};

const PLUGIN_NAME = "ds";
const TELEGRAM_TEXT_LIMIT = 3500;
const STREAM_EDIT_INTERVAL_MS = 900;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const TARGET_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCE_DIMENSION = 2048;
const MAX_CAPTION_CHARS = 1000;
const MAX_QUESTION_CHARS = 2000;
const ARK_BALANCED_MODELS = [
  "doubao-seed-2-0-lite-260428",
  "doubao-seed-2-0-pro-260215",
  "doubao-seed-2-0-mini-260428",
];
const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";
const CONFIG_PATH = path.join(
  createDirectoryInAssets(PLUGIN_NAME),
  "config.json",
);

const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  deepseek: {
    id: "deepseek",
    displayName: "DeepSeek",
    baseURL: "https://api.deepseek.com",
    keyProviderId: "deepseek",
    supportsText: true,
    supportsVision: false,
    supportsStream: true,
    model: "deepseek-v4-flash",
    description: "DeepSeek 默认文本模型",
  },
  siliconflow: {
    id: "siliconflow",
    displayName: "SiliconFlow",
    baseURL: "https://api.siliconflow.cn/v1",
    keyProviderId: "siliconflow",
    supportsText: true,
    supportsVision: true,
    supportsStream: true,
    model: "Qwen/Qwen3-VL-32B-Instruct",
    description: "SiliconFlow 模型配置",
  },
  ark: {
    id: "ark",
    displayName: "Ark",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    keyProviderId: "ark",
    supportsText: true,
    supportsVision: true,
    supportsStream: true,
    model: "doubao-seed-2-0-lite-260428",
    description: "Ark 模型配置",
  },
  kimi: {
    id: "kimi",
    displayName: "Kimi",
    baseURL: "https://api.moonshot.cn/v1",
    keyProviderId: "kimi",
    supportsText: true,
    supportsVision: true,
    supportsStream: true,
    model: "kimi-k2.6",
    description: "Kimi 模型配置",
  },
};

const DEFAULT_CONFIG: DsConfig = {
  text: {
    provider: "deepseek",
  },
  vision: {
    provider: "ark",
  },
  systemPrompt:
    "你是一个乐于助人、简洁且无害的AI助手。始终以清晰、结构良好的语言回复。适当时使用项目符号或编号列表。如果你不知道答案，直接说出来。不要编造信息。",
  keys: {
    deepseek: "",
    siliconflow: "",
    ark: "",
    kimi: "",
  },
  providers: {
    deepseek: {
      model: "deepseek-v4-flash",
      models: [],
    },
    siliconflow: {
      model: "Qwen/Qwen3-VL-32B-Instruct",
      models: [],
    },
    ark: {
      model: "",
      models: [...ARK_BALANCED_MODELS],
    },
    kimi: {
      model: "kimi-k2.6",
      models: [],
    },
  },
  cursors: {
    text: 0,
    vision: 0,
  },
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

function normalizeProviderId(value?: string | null): ProviderId | null {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "deepseek" ||
    normalized === "siliconflow" ||
    normalized === "ark" ||
    normalized === "kimi"
  ) {
    return normalized;
  }
  return null;
}

function isProviderSupported(route: RouteKind, providerId: ProviderId): boolean {
  return route === "text"
    ? PROVIDERS[providerId].supportsText
    : PROVIDERS[providerId].supportsVision;
}

function normalizeRouteProvider(route: RouteKind, value?: string | null): ProviderId {
  const providerId = normalizeProviderId(value);
  if (providerId && isProviderSupported(route, providerId)) {
    return providerId;
  }
  return DEFAULT_CONFIG[route].provider;
}

function normalizeModelList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function getDefaultRouteModel(route: RouteKind, providerId: ProviderId): string {
  const provider = PROVIDERS[providerId];
  return provider.model || DEFAULT_CONFIG.providers[providerId].model || "";
}

function getDefaultRouteModels(route: RouteKind, providerId: ProviderId): string[] {
  const provider = PROVIDERS[providerId];
  if (provider.models?.length) return [...provider.models];
  return DEFAULT_CONFIG.providers[providerId].models || [];
}

function normalizeProviderConfig(
  providerId: ProviderId,
  raw?: unknown,
): ProviderConfig {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const hasModel = Object.prototype.hasOwnProperty.call(record, "model");
  const hasModels = Object.prototype.hasOwnProperty.call(record, "models");
  const models = normalizeModelList(record.models);
  const model = typeof record.model === "string" ? record.model.trim() : "";

  if (models.length > 0) {
    return {
      model: "",
      models,
    };
  }

  if (hasModel || hasModels) {
    return {
      model: model || getDefaultRouteModel("text", providerId),
      models: [],
    };
  }

  return {
    model: getDefaultRouteModel("text", providerId),
    models: getDefaultRouteModels("text", providerId),
  };
}

function normalizeConfig(raw?: unknown): DsConfig {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawText = record.text && typeof record.text === "object"
    ? (record.text as Record<string, unknown>)
    : {};
  const rawVision = record.vision && typeof record.vision === "object"
    ? (record.vision as Record<string, unknown>)
    : {};
  const rawKeys = record.keys && typeof record.keys === "object"
    ? (record.keys as Record<string, unknown>)
    : {};
  const rawProviders = record.providers && typeof record.providers === "object"
    ? (record.providers as Record<string, unknown>)
    : {};
  const rawCursors = record.cursors && typeof record.cursors === "object"
    ? (record.cursors as Record<string, unknown>)
    : {};

  return {
    text: {
      provider: normalizeRouteProvider("text", typeof rawText.provider === "string" ? rawText.provider : ""),
    },
    vision: {
      provider: normalizeRouteProvider("vision", typeof rawVision.provider === "string" ? rawVision.provider : ""),
    },
    systemPrompt: typeof record.systemPrompt === "string" ? record.systemPrompt.trim() : "",
    keys: {
      deepseek: typeof rawKeys.deepseek === "string" ? rawKeys.deepseek.trim() : "",
      siliconflow: typeof rawKeys.siliconflow === "string" ? rawKeys.siliconflow.trim() : "",
      ark: typeof rawKeys.ark === "string" ? rawKeys.ark.trim() : "",
      kimi: typeof rawKeys.kimi === "string" ? rawKeys.kimi.trim() : "",
    },
    providers: {
      deepseek: normalizeProviderConfig("deepseek", rawProviders.deepseek),
      siliconflow: normalizeProviderConfig("siliconflow", rawProviders.siliconflow),
      ark: normalizeProviderConfig("ark", rawProviders.ark),
      kimi: normalizeProviderConfig("kimi", rawProviders.kimi),
    },
    cursors: {
      text: typeof rawCursors.text === "number" && Number.isFinite(rawCursors.text)
        ? Math.max(0, Math.floor(rawCursors.text))
        : 0,
      vision: typeof rawCursors.vision === "number" && Number.isFinite(rawCursors.vision)
        ? Math.max(0, Math.floor(rawCursors.vision))
        : 0,
    },
  };
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
    return `💬 ${escapeHtml(question)}\n──────────\n${header}\n${answer}`;
  }
  return `${header}\n\n${answer}`;
}

function renderHelpSections(
  title: string,
  intro: string,
  sections: Array<{ heading: string; lines: string[] }>,
): string {
  const blocks = [title, "", `<blockquote>${intro}</blockquote>`];
  for (const section of sections) {
    blocks.push("", section.heading, `<blockquote>${section.lines.join("\n")}</blockquote>`);
  }
  return blocks.join("\n");
}

function routeLabel(route: RouteKind): string {
  return route === "text" ? "文本路由" : "多模态路由";
}

function getRouteProviders(route: RouteKind): ProviderDefinition[] {
  return (Object.values(PROVIDERS) as ProviderDefinition[]).filter((provider) =>
    route === "text" ? provider.supportsText : provider.supportsVision,
  );
}

function getRouteProvider(route: RouteKind, providerId: string): ProviderDefinition | undefined {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) return undefined;
  const provider = PROVIDERS[normalized];
  if (!isProviderSupported(route, provider.id)) return undefined;
  return provider;
}

function getDefaultRouteProvider(route: RouteKind): ProviderDefinition {
  return PROVIDERS[DEFAULT_CONFIG[route].provider];
}

function formatProviderList(route: RouteKind): string {
  return getRouteProviders(route)
    .map((provider) => `<code>${escapeHtml(provider.id)}</code>`)
    .join(" / ");
}

function getRouteProviderDescription(route: RouteKind, provider: ProviderDefinition): string {
  const config = DEFAULT_CONFIG.providers[provider.id];
  const mode = config.models?.length
    ? `轮询模型池：${config.models.map((model) => `<code>${escapeHtml(model)}</code>`).join(" / ")}`
    : `默认模型：<code>${escapeHtml(config.model || provider.model || "(未设置)")}</code>`;
  return `${route} <code>${escapeHtml(provider.id)}</code> - ${mode}`;
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

function getProviderExtraBody(providerId: ProviderId): Record<string, unknown> | undefined {
  if (providerId === "kimi") {
    return { thinking: { type: "enabled" } };
  }
  return undefined;
}

function extractCompletionContent(response: unknown): string | null {
  const content = (response as Record<string, any>)?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content : null;
}

class DsConfigStore {
  private readonly dbPromise = JSONFilePreset<DsConfig>(CONFIG_PATH, DEFAULT_CONFIG);
  private cache?: DsConfig;

  async get(): Promise<DsConfig> {
    if (this.cache) {
      return this.cache;
    }

    const db = await this.dbPromise;
    const normalized = normalizeConfig(db.data);
    if (JSON.stringify(db.data) !== JSON.stringify(normalized)) {
      db.data = normalized;
      await db.write();
    }
    this.cache = normalized;
    return this.cache;
  }

  async update(mutator: (config: DsConfig) => void): Promise<DsConfig> {
    const db = await this.dbPromise;
    const source = this.cache ?? normalizeConfig(db.data);
    const normalized = normalizeConfig(source);
    mutator(normalized);
    db.data = normalizeConfig(normalized);
    await db.write();
    this.cache = db.data;
    return this.cache;
  }

  async setRouteProvider(route: RouteKind, providerId: string): Promise<DsConfig> {
    return this.update((config) => {
      config[route].provider = normalizeRouteProvider(route, providerId);
      config.cursors[route] = 0;
    });
  }

  async setKey(providerId: ProviderId, apiKey: string): Promise<DsConfig> {
    return this.update((config) => {
      config.keys[PROVIDERS[providerId].keyProviderId] = apiKey.trim();
    });
  }

  async setProviderModel(providerId: ProviderId, model: string): Promise<DsConfig> {
    return this.update((config) => {
      config.providers[providerId].model = model.trim();
      config.providers[providerId].models = [];
    });
  }

  async setProviderModels(providerId: ProviderId, models: string[]): Promise<DsConfig> {
    return this.update((config) => {
      config.providers[providerId].model = "";
      config.providers[providerId].models = models;
    });
  }

  async selectRouteModel(route: RouteKind): Promise<RouteSelection> {
    const config = await this.get();
    const provider = getRouteProvider(route, config[route].provider) || getDefaultRouteProvider(route);
    const providerConfig = config.providers[provider.id];
    const pool = providerConfig.models?.length
      ? [...providerConfig.models]
      : provider.models
        ? [...provider.models]
        : [];

    if (pool.length > 0) {
      const cursor = config.cursors[route] % pool.length;
      return {
        config,
        provider,
        model: pool[cursor] || pool[0],
        pool,
        selectedIndex: cursor,
      };
    }

    return {
      config,
      provider,
      model: providerConfig.model || provider.model || "",
      pool,
      selectedIndex: 0,
    };
  }

  async advanceRouteCursor(route: RouteKind, poolLength: number, selectedIndex: number): Promise<DsConfig> {
    if (poolLength <= 0) {
      return this.get();
    }

    return this.update((config) => {
      config.cursors[route] = (selectedIndex + 1) % poolLength;
    });
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
      data.detail,
    ];
    detail = (candidates.find(
      (value) => typeof value === "string" && value.trim(),
    ) as string | undefined) || "";
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
    return `当前视觉模型 <code>${escapeHtml(routeModel)}</code> 可能不支持图像输入。`;
  }
  if (status && status >= 400 && status < 500) {
    return detail || "请求参数无效。";
  }
  return detail || "远端服务请求失败。";
}

class DsPlugin extends Plugin {
  name = PLUGIN_NAME;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    ds: async (msg) => {
      if (!(await ensureSelfInvocation(msg))) return;
      await this.handleDs(msg);
    },
  };

  private readonly configStore = new DsConfigStore();

  private renderHelpText(): string {
    return renderHelpSections(
      "🤖 <b>DS 帮助</b>",
      "对话、识图与多 Provider 模型切换。",
      [
        {
          heading: "📌 基本用法：",
          lines: [
            `<code>${mainPrefix}ds [问题]</code> - 直接提问`,
            `<code>${mainPrefix}ds</code> - 回复文本继续对话，或回复单张静态图片做识别`,
            `<code>${mainPrefix}ds 这是什么</code> - 回复图片并提问`,
          ],
        },
        {
          heading: "⚙️ 配置命令：",
          lines: [
            `<code>${mainPrefix}ds text use &lt;provider&gt;</code> - 配置文本路由`,
            `<code>${mainPrefix}ds vision use &lt;provider&gt;</code> - 配置多模态路由`,
            `<code>${mainPrefix}ds key &lt;provider&gt; &lt;apiKey&gt;</code> - 设置 API Key`,
            `<code>${mainPrefix}ds model set &lt;provider&gt; &lt;model&gt;</code> - 设置 provider 的单模型`,
            `<code>${mainPrefix}ds models set &lt;provider&gt; &lt;m1,m2,m3&gt;</code> - 设置 provider 的轮询模型池`,
            `<code>${mainPrefix}ds status</code> - 查看当前配置`,
          ],
        },
        {
          heading: "🧭 可用 Provider：",
          lines: [
            `text: ${formatProviderList("text")}`,
            `vision: ${formatProviderList("vision")}`,
          ],
        },
      ],
    );
  }

  get description(): string {
    return this.renderHelpText();
  }

  private async handleDs(msg: Api.Message): Promise<void> {
    const payload = getCommandPayload(msg.message || "");
    const [first = "", second = "", third = ""] = payload.split(/\s+/);
    const lowerFirst = first.toLowerCase();
    const lowerSecond = second.toLowerCase();
    const lowerThird = third.toLowerCase();

    if (lowerFirst === "help") {
      await this.handleHelp(msg);
      return;
    }
    if (lowerFirst === "status") {
      await this.handleStatus(msg);
      return;
    }
    if (lowerFirst === "key") {
      await this.handleKey(msg, payload);
      return;
    }
    if (lowerFirst === "model" && lowerSecond === "set") {
      await this.handleModelSet(msg, payload);
      return;
    }
    if (lowerFirst === "models" && lowerSecond === "set") {
      await this.handleModelsSet(msg, payload);
      return;
    }
    if (lowerFirst === "text" && lowerSecond === "use") {
      await this.handleRouteUse(msg, "text", lowerThird);
      return;
    }
    if (lowerFirst === "vision" && lowerSecond === "use") {
      await this.handleRouteUse(msg, "vision", lowerThird);
      return;
    }

    await this.handleAsk(msg, payload);
  }

  private async handleHelp(msg: Api.Message): Promise<void> {
    await safeEditMessage(msg, this.renderHelpText(), "html");
  }

  private async handleStatus(msg: Api.Message): Promise<void> {
    const config = await this.configStore.get();
    const lines = ["🤖 <b>DS 当前状态</b>", ""];

    for (const route of ["text", "vision"] as const) {
      const provider = getRouteProvider(route, config[route].provider) || getDefaultRouteProvider(route);
      const providerConfig = config.providers[provider.id];
      const key = config.keys[provider.keyProviderId];
      lines.push(`${route === "text" ? "📝" : "🖼️"} <b>${routeLabel(route)}</b>`);
      lines.push(`• Provider: <code>${escapeHtml(provider.displayName)}</code> (<code>${escapeHtml(provider.id)}</code>)`);
      if (providerConfig.models?.length) {
        lines.push(`• Models: ${providerConfig.models.map((model) => `<code>${escapeHtml(model)}</code>`).join(" / ")}`);
        lines.push(`• Next Slot: <code>${String(config.cursors[route] % providerConfig.models.length)}</code>`);
      } else {
        lines.push(`• Model: <code>${escapeHtml(providerConfig.model || provider.model || "(未设置)")}</code>`);
      }
      lines.push(`• API Key: <code>${escapeHtml(maskApiKey(key))}</code>`);
      lines.push(key ? "• 状态: 已就绪" : "• 状态: 未配置 Key");
      lines.push("");
    }

    lines.push(
      `📝 <b>System Prompt</b>: ${
        config.systemPrompt
          ? `<code>${escapeHtml(truncateForTelegram(config.systemPrompt))}</code>`
          : "未设置"
      }`,
    );

    await safeEditMessage(msg, lines.join("\n"), "html");
  }

  private async handleKey(msg: Api.Message, payload: string): Promise<void> {
    const parts = payload.split(/\s+/);
    const providerId = normalizeProviderId(parts[1]);
    const apiKey = payload.replace(/^key\s+\S+\s+/i, "").trim();

    if (!providerId || !apiKey) {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds key &lt;provider&gt; &lt;apiKey&gt;</code>\n` +
          `provider: <code>deepseek</code> / <code>siliconflow</code> / <code>ark</code> / <code>kimi</code>`,
        "html",
      );
      return;
    }

    await this.configStore.setKey(providerId, apiKey);
    await safeEditMessage(
      msg,
      `✅ Provider <code>${escapeHtml(providerId)}</code> 的 API Key 已更新：<code>${escapeHtml(maskApiKey(apiKey))}</code>`,
      "html",
    );
  }

  private async handleModelSet(msg: Api.Message, payload: string): Promise<void> {
    const parts = payload.split(/\s+/);
    const providerId = normalizeProviderId(parts[2]);
    const model = payload.replace(/^model\s+set\s+\S+\s+/i, "").trim();

    if (!providerId || !model) {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds model set &lt;provider&gt; &lt;model&gt;</code>`,
        "html",
      );
      return;
    }

    await this.configStore.setProviderModel(providerId, model);
    await safeEditMessage(
      msg,
      `✅ Provider <code>${escapeHtml(providerId)}</code> 的单模型已设置为 <code>${escapeHtml(model)}</code>`,
      "html",
    );
  }

  private async handleModelsSet(msg: Api.Message, payload: string): Promise<void> {
    const parts = payload.split(/\s+/);
    const providerId = normalizeProviderId(parts[2]);
    const rawModels = payload.replace(/^models\s+set\s+\S+\s+/i, "").trim();
    const models = normalizeModelList(rawModels);

    if (!providerId || !models.length) {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds models set &lt;provider&gt; &lt;m1,m2,m3&gt;</code>`,
        "html",
      );
      return;
    }

    await this.configStore.setProviderModels(providerId, models);
    await safeEditMessage(
      msg,
      `✅ Provider <code>${escapeHtml(providerId)}</code> 的轮询模型池已更新：${models.map((model) => `<code>${escapeHtml(model)}</code>`).join(" / ")}`,
      "html",
    );
  }

  private async handleRouteUse(
    msg: Api.Message,
    route: RouteKind,
    providerId: string,
  ): Promise<void> {
    const provider = getRouteProvider(route, providerId);
    if (!provider) {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds ${route} use &lt;provider&gt;</code>\n` +
          `${route} providers: ${formatProviderList(route)}`,
        "html",
      );
      return;
    }

    const config = await this.configStore.setRouteProvider(route, provider.id);
    const providerConfig = config.providers[provider.id];
    const lines = [
      `✅ ${routeLabel(route)} 已切换到 <code>${escapeHtml(provider.id)}</code>`,
      `Provider: <code>${escapeHtml(provider.displayName)}</code>`,
    ];
    if (providerConfig.models?.length) {
      lines.push(`Models: ${providerConfig.models.map((model) => `<code>${escapeHtml(model)}</code>`).join(" / ")}`);
    } else {
      lines.push(`Model: <code>${escapeHtml(providerConfig.model || provider.model || "(未设置)")}</code>`);
    }
    await safeEditMessage(msg, lines.join("\n"), "html");
  }

  private async handleAsk(msg: Api.Message, payload: string): Promise<void> {
    await safeEditMessage(msg, "🤖 正在整理上下文…");

    let context: AskContext;
    try {
      context = await resolveAskContext(msg, payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await safeEditMessage(msg, message, message.includes("<code>") ? "html" : undefined);
      return;
    }

    const route = context.route;
    const selection = await this.configStore.selectRouteModel(route);
    const apiKey = selection.config.keys[selection.provider.keyProviderId];

    if (!apiKey) {
      await safeEditMessage(
        msg,
        `❌ ${routeLabel(route)} 使用的 Provider <code>${escapeHtml(selection.provider.id)}</code> 尚未配置 API Key。\n` +
          `请先执行 <code>${escapeHtml(mainPrefix)}ds key ${escapeHtml(selection.provider.id)} &lt;apiKey&gt;</code>。`,
        "html",
      );
      return;
    }
    if (!selection.model) {
      await safeEditMessage(msg, "❌ 当前路由没有可用模型。");
      return;
    }

    const messages = buildMessages(selection.config, context);
    const extraBody = getProviderExtraBody(selection.provider.id);

    const thinkingLabel = `🤖 正在使用 ${selection.provider.displayName} (${selection.model})…`;
    if (context.question) {
      await safeEditMessage(msg, `💬 ${escapeHtml(context.question)}\n──────────\n${thinkingLabel}`, "html");
    } else {
      await safeEditMessage(msg, thinkingLabel);
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
          providerName: selection.provider.displayName,
          model: selection.model,
          answer: combined,
          question: context.question,
        }),
        "html",
      );
    };

    try {
      if (selection.provider.supportsStream) {
        await streamChatCompletion(
          {
            baseURL: selection.provider.baseURL,
            apiKey,
            model: selection.model,
            messages,
            extraBody,
            timeout: 120_000,
          },
          (delta) => {
            combined += delta;
            renderChain = renderChain.then(() => flush(false)).catch(() => undefined);
          },
        );
        await renderChain;
      } else {
        const response = await createChatCompletion({
          baseURL: selection.provider.baseURL,
          apiKey,
          model: selection.model,
          messages,
          extraBody,
          timeout: 60_000,
        });
        combined = extractCompletionContent(response) || "";
      }

      if (!combined.trim()) {
        throw new Error(route === "vision" ? "视觉接口返回为空" : "接口返回为空");
      }
      if (selection.pool.length > 0) {
        await this.configStore.advanceRouteCursor(
          route,
          selection.pool.length,
          selection.selectedIndex,
        );
      }
      await flush(true);
    } catch (error) {
      const friendly = mapProviderError(error, route, selection.model);
      await safeEditMessage(msg, `❌ ${friendly}`, friendly.includes("<code>") ? "html" : undefined);
    }
  }
}

export default new DsPlugin();
