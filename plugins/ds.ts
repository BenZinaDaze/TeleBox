import axios from "axios";
import path from "path";
import sharp from "sharp";
import { JSONFilePreset } from "lowdb/node";
import { Api } from "teleproto";
import { Plugin } from "@utils/pluginBase";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import {
  parseCliOptions,
  parseCommandInput,
  type ParsedCliOptions,
  type ParsedCommandInput,
} from "@utils/commandParser";
import { getPrefixes } from "@utils/pluginManager";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { TelegramFormatter } from "@utils/telegramFormatter";
import {
  createChatCompletion,
  streamChatCompletion,
  type OpenAICompatDelta,
} from "@utils/openAICompat";

type RouteKind = "text" | "vision";
type ProviderId = "deepseek" | "siliconflow" | "ark" | "kimi" | "mimo";
type KeyProviderId = "deepseek" | "siliconflow" | "ark" | "kimi" | "mimo";

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

type RoleCollection = Record<string, string>;

type DsConfig = {
  text: RouteConfig;
  vision: RouteConfig;
  roles: {
    builtin: RoleCollection;
    custom: RoleCollection;
  };
  activeRoles: Record<RouteKind, string>;
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
      thinkEnabled: boolean;
      roleOverrideName?: string;
    }
  | {
      route: "vision";
      question: string;
      caption: string;
      image: PreparedImage;
      thinkEnabled: boolean;
      roleOverrideName?: string;
    };

type RouteSelection = {
  config: DsConfig;
  provider: ProviderDefinition;
  model: string;
  pool: string[];
  selectedIndex: number;
};

type DsCliContext = {
  command: ParsedCommandInput | null;
  cli: ParsedCliOptions;
  route: RouteKind | null;
  mainCommand: string;
  subCommand: string;
  args: string[];
  hasRouteConflict: boolean;
};

const PLUGIN_NAME = "ds";
const TELEGRAM_TEXT_LIMIT = 3500;
const COLLAPSIBLE_ANSWER_THRESHOLD = 50;
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
const DEFAULT_ROLE_NAME = "default";
const BUILTIN_ROLE_PROMPTS = {
  default:
    "你是一个乐于助人、简洁且无害的AI助手。始终以清晰、结构良好的语言回复。适当时使用项目符号或编号列表。如果你不知道答案，直接说出来。不要编造信息。",
  coder:
    "你是一个严谨的编程助手。优先给出可执行的方案、明确的代码修改建议和必要的边界条件。不要编造不存在的 API 或行为。",
  translator:
    "你是一个专业翻译助手。准确保留原意、语气和专有名词；必要时给出更自然的表达，并避免过度解释。",
  summarizer:
    "你是一个高密度总结助手。优先提炼结论、关键信息和行动项，用尽量短的结构化表达输出。",
  "vision-ocr":
    "你是一个偏 OCR 和视觉理解的助手。优先提取图片中的可见文字，再结合版式和图像内容进行保守判断；看不清时明确说明，不要臆测。",
} as const satisfies Record<string, string>;
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
  mimo: {
    id: "mimo",
    displayName: "MiMo",
    baseURL: "https://token-plan-cn.xiaomimimo.com/v1",
    keyProviderId: "mimo",
    supportsText: true,
    supportsVision: true,
    supportsStream: true,
    model: "mimo-v2.5",
    description: "MiMo Token Plan 模型配置",
  },
};

const DEFAULT_CONFIG: DsConfig = {
  text: {
    provider: "deepseek",
  },
  vision: {
    provider: "ark",
  },
  roles: {
    builtin: { ...BUILTIN_ROLE_PROMPTS },
    custom: {},
  },
  activeRoles: {
    text: DEFAULT_ROLE_NAME,
    vision: DEFAULT_ROLE_NAME,
  },
  keys: {
    deepseek: "",
    siliconflow: "",
    ark: "",
    kimi: "",
    mimo: "",
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
    mimo: {
      model: "mimo-v2.5",
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
    normalized === "kimi" ||
    normalized === "mimo"
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

function normalizeRoleName(value?: string | null): string {
  return (value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "");
}

function normalizeRoleCollection(value: unknown): RoleCollection {
  if (!value || typeof value !== "object") return {};

  const normalized: RoleCollection = {};
  for (const [rawKey, rawPrompt] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeRoleName(rawKey);
    const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
    if (!key || !prompt) continue;
    normalized[key] = prompt;
  }
  return normalized;
}

function getBuiltinRoles(): RoleCollection {
  return { ...BUILTIN_ROLE_PROMPTS };
}

function hasRole(config: DsConfig, roleName: string): boolean {
  return !!getRolePrompt(config, roleName);
}

function getRolePrompt(config: DsConfig, roleName: string): string {
  const normalized = normalizeRoleName(roleName);
  if (!normalized) return "";
  return config.roles.custom[normalized] || config.roles.builtin[normalized] || "";
}

function isBuiltinRole(roleName: string): boolean {
  return Object.prototype.hasOwnProperty.call(BUILTIN_ROLE_PROMPTS, normalizeRoleName(roleName));
}

function resolveRoleForRoute(config: DsConfig, route: RouteKind): { name: string; prompt: string } {
  const activeName = normalizeRoleName(config.activeRoles[route]) || DEFAULT_ROLE_NAME;
  const prompt = getRolePrompt(config, activeName);
  if (prompt) {
    return { name: activeName, prompt };
  }
  return {
    name: DEFAULT_ROLE_NAME,
    prompt: getRolePrompt(config, DEFAULT_ROLE_NAME),
  };
}

function resolveRoleForAsk(
  config: DsConfig,
  route: RouteKind,
  overrideName?: string,
): { name: string; prompt: string } {
  const normalizedOverride = normalizeRoleName(overrideName);
  if (normalizedOverride) {
    const prompt = getRolePrompt(config, normalizedOverride);
    if (prompt) {
      return { name: normalizedOverride, prompt };
    }
  }
  return resolveRoleForRoute(config, route);
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
  const rawRoles = record.roles && typeof record.roles === "object"
    ? (record.roles as Record<string, unknown>)
    : {};
  const rawBuiltinRoles = rawRoles.builtin;
  const rawCustomRoles = rawRoles.custom;
  const rawActiveRoles = record.activeRoles && typeof record.activeRoles === "object"
    ? (record.activeRoles as Record<string, unknown>)
    : {};
  const legacySystemPrompt = typeof record.systemPrompt === "string" ? record.systemPrompt.trim() : "";

  const builtinRoles = {
    ...getBuiltinRoles(),
    ...normalizeRoleCollection(rawBuiltinRoles),
  };
  const customRoles = normalizeRoleCollection(rawCustomRoles);

  let activeTextRole = normalizeRoleName(
    typeof rawActiveRoles.text === "string" ? rawActiveRoles.text : "",
  );
  let activeVisionRole = normalizeRoleName(
    typeof rawActiveRoles.vision === "string" ? rawActiveRoles.vision : "",
  );

  if (!activeTextRole && !activeVisionRole && legacySystemPrompt) {
    customRoles.legacy = legacySystemPrompt;
    activeTextRole = "legacy";
    activeVisionRole = "legacy";
  }

  if (!activeTextRole || (!customRoles[activeTextRole] && !builtinRoles[activeTextRole])) {
    activeTextRole = DEFAULT_ROLE_NAME;
  }
  if (!activeVisionRole || (!customRoles[activeVisionRole] && !builtinRoles[activeVisionRole])) {
    activeVisionRole = DEFAULT_ROLE_NAME;
  }

  return {
    text: {
      provider: normalizeRouteProvider("text", typeof rawText.provider === "string" ? rawText.provider : ""),
    },
    vision: {
      provider: normalizeRouteProvider("vision", typeof rawVision.provider === "string" ? rawVision.provider : ""),
    },
    roles: {
      builtin: builtinRoles,
      custom: customRoles,
    },
    activeRoles: {
      text: activeTextRole,
      vision: activeVisionRole,
    },
    keys: {
      deepseek: typeof rawKeys.deepseek === "string" ? rawKeys.deepseek.trim() : "",
      siliconflow: typeof rawKeys.siliconflow === "string" ? rawKeys.siliconflow.trim() : "",
      ark: typeof rawKeys.ark === "string" ? rawKeys.ark.trim() : "",
      kimi: typeof rawKeys.kimi === "string" ? rawKeys.kimi.trim() : "",
      mimo: typeof rawKeys.mimo === "string" ? rawKeys.mimo.trim() : "",
    },
    providers: {
      deepseek: normalizeProviderConfig("deepseek", rawProviders.deepseek),
      siliconflow: normalizeProviderConfig("siliconflow", rawProviders.siliconflow),
      ark: normalizeProviderConfig("ark", rawProviders.ark),
      kimi: normalizeProviderConfig("kimi", rawProviders.kimi),
      mimo: normalizeProviderConfig("mimo", rawProviders.mimo),
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

function formatAiOutput(content: string, options?: { collapseSafe?: boolean }): string {
  const body = content.trim() || "(无内容)";
  return TelegramFormatter.markdownToHtml(
    truncateForTelegram(body),
    options,
  );
}

function renderAnswerBody(answer: string, wrapExpandable: boolean): string {
  if (!answer.trim()) return formatAiOutput(answer);
  if (!wrapExpandable) {
    return formatAiOutput(answer);
  }
  return `<blockquote expandable>${formatAiOutput(answer, { collapseSafe: true })}</blockquote>`;
}

function renderAnswer(params: {
  providerName: string;
  model: string;
  answer: string;
  reasoning?: string;
  question?: string;
}): string {
  const header = `🤖 <b>${escapeHtml(params.providerName)} · ${escapeHtml(params.model)}</b>`;
  const reasoning = params.reasoning?.trim()
    ? `🧠 <b>思考过程</b>\n<blockquote expandable>${formatAiOutput(params.reasoning, { collapseSafe: true })}</blockquote>\n\n`
    : "";
  const answerText = params.answer.trim();
  const wrapAnswerExpandable = answerText.length >= COLLAPSIBLE_ANSWER_THRESHOLD;
  const answer = answerText
    ? `${reasoning ? "📝 <b>最终答案</b>\n" : ""}${renderAnswerBody(answerText, wrapAnswerExpandable)}`
    : (reasoning ? "📝 <b>最终答案</b>\n<i>思考中…</i>" : formatAiOutput(params.answer));
  const question = params.question?.trim() || "";
  if (question) {
    return `💬 ${escapeHtml(question)}\n──────────\n${header}\n\n${reasoning}${answer}`;
  }
  return `${header}\n\n${reasoning}${answer}`;
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

function routeShortLabel(route: RouteKind): string {
  return route === "text" ? "text" : "vision";
}

function buildDsCliContext(msg: Api.Message): DsCliContext {
  const command = parseCommandInput(msg);
  const args = command?.args || [];
  const cli = parseCliOptions(args, [
    { name: "think", aliases: ["-t", "--think"], kind: "boolean" },
    { name: "role", aliases: ["-r", "--role"], kind: "string" },
    { name: "routeText", aliases: ["-txt", "--text"], kind: "boolean" },
    { name: "routeVision", aliases: ["-vis", "--vision"], kind: "boolean" },
  ]);
  const hasText = cli.options.routeText === true;
  const hasVision = cli.options.routeVision === true;
  const positionals = cli.positionals;
  return {
    command,
    cli,
    args,
    route: hasText ? "text" : hasVision ? "vision" : null,
    mainCommand: ((positionals[0] || "") as string).toLowerCase(),
    subCommand: ((positionals[1] || "") as string).toLowerCase(),
    hasRouteConflict: hasText && hasVision,
  };
}

function truncatePreview(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…`;
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

function buildMessages(
  config: DsConfig,
  context: AskContext,
  resolvedRole: { name: string; prompt: string },
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (resolvedRole.prompt) {
    messages.push({ role: "system", content: resolvedRole.prompt });
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

async function resolveAskContext(msg: Api.Message, cli: ParsedCliOptions): Promise<AskContext> {
  const replied = await safeGetReplyMessage(msg);
  const question = takeWithMarker(cli.positionals.join(" "), MAX_QUESTION_CHARS, "问题");
  const roleOverrideName = typeof cli.options.role === "string"
    ? normalizeRoleName(cli.options.role)
    : undefined;

  if (!replied) {
    if (!question) {
      throw new Error(
        `❌ 用法错误：请直接提问，或回复一条消息后再发送 <code>${escapeHtml(mainPrefix)}ds</code>。`,
      );
    }
    return {
      route: "text",
      question,
      thinkEnabled: cli.options.think === true,
      roleOverrideName,
    };
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
      thinkEnabled: cli.options.think === true,
      roleOverrideName,
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
    thinkEnabled: cli.options.think === true,
    roleOverrideName,
  };
}

function getProviderExtraBody(
  providerId: ProviderId,
  thinkEnabled: boolean,
): Record<string, unknown> | undefined {
  if (providerId === "kimi" || providerId === "deepseek" || providerId === "mimo") {
    return {
      thinking: {
        type: thinkEnabled ? "enabled" : "disabled",
      },
    };
  }
  return undefined;
}

function extractCompletionContent(response: unknown): string | null {
  const content = (response as Record<string, any>)?.choices?.[0]?.message?.content;
  return typeof content === "string" && content.trim() ? content : null;
}

function extractCompletionReasoning(response: unknown): string | null {
  const reasoningContent = (response as Record<string, any>)?.choices?.[0]?.message?.reasoning_content;
  return typeof reasoningContent === "string" && reasoningContent.trim() ? reasoningContent : null;
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

  async setActiveRole(route: RouteKind, roleName: string): Promise<DsConfig> {
    return this.update((config) => {
      const normalized = normalizeRoleName(roleName);
      if (hasRole(config, normalized)) {
        config.activeRoles[route] = normalized;
      }
    });
  }

  async resetActiveRole(route: RouteKind): Promise<DsConfig> {
    return this.update((config) => {
      config.activeRoles[route] = DEFAULT_ROLE_NAME;
    });
  }

  async setCustomRole(roleName: string, prompt: string): Promise<DsConfig> {
    return this.update((config) => {
      const normalized = normalizeRoleName(roleName);
      if (!normalized) return;
      config.roles.custom[normalized] = prompt.trim();
    });
  }

  async deleteCustomRole(roleName: string): Promise<DsConfig> {
    return this.update((config) => {
      delete config.roles.custom[normalizeRoleName(roleName)];
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
            `<code>${mainPrefix}ds -t [问题]</code> - 本次请求开启 think`,
            `<code>${mainPrefix}ds -r &lt;role&gt; [问题]</code> - 本次请求临时使用指定 role`,
            `<code>${mainPrefix}ds</code> - 回复文本继续对话，或回复单张静态图片做识别`,
            `<code>${mainPrefix}ds 这是什么</code> - 回复图片并提问`,
          ],
        },
        {
          heading: "⚙️ 配置命令：",
          lines: [
            `<code>${mainPrefix}ds use -txt|--text &lt;provider&gt;</code> - 配置文本路由`,
            `<code>${mainPrefix}ds use -vis|--vision &lt;provider&gt;</code> - 配置多模态路由`,
            `<code>${mainPrefix}ds key &lt;provider&gt; &lt;apiKey&gt;</code> - 设置 API Key`,
            `<code>${mainPrefix}ds model set &lt;provider&gt; &lt;model&gt;</code> - 设置 provider 的单模型`,
            `<code>${mainPrefix}ds models set &lt;provider&gt; &lt;m1,m2,m3&gt;</code> - 设置 provider 的轮询模型池`,
            `<code>${mainPrefix}ds role list</code> - 查看全部 system role`,
            `<code>${mainPrefix}ds role use -txt|--text &lt;name&gt;</code> - 切换路由 role（` +
              `<code>-vis|--vision</code> 同理）`,
            `<code>${mainPrefix}ds role add &lt;name&gt;</code> - 回复一条消息，创建自定义 role`,
            `<code>${mainPrefix}ds role update &lt;name&gt;</code> - 回复一条消息，覆盖自定义 role`,
            `<code>${mainPrefix}ds role del &lt;name&gt;</code> - 删除自定义 role`,
            `<code>${mainPrefix}ds role show &lt;name&gt;</code> - 查看 role 内容`,
            `<code>${mainPrefix}ds role reset -txt|--text</code> - 路由 role 重置为 default（` +
              `<code>-vis|--vision</code> 同理）`,
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
    const context = buildDsCliContext(msg);
    const positionals = context.cli.positionals;

    if (context.hasRouteConflict) {
      await safeEditMessage(
        msg,
        `❌ 不能同时指定 <code>-txt</code>/<code>--text</code> 和 <code>-vis</code>/<code>--vision</code>。`,
        "html",
      );
      return;
    }

    if (context.mainCommand === "help") {
      await this.handleHelp(msg);
      return;
    }
    if (context.mainCommand === "status") {
      await this.handleStatus(msg);
      return;
    }
    if (context.mainCommand === "key") {
      await this.handleKey(msg, positionals);
      return;
    }
    if (context.mainCommand === "role") {
      await this.handleRole(msg, context);
      return;
    }
    if (context.mainCommand === "model" && context.subCommand === "set") {
      await this.handleModelSet(msg, positionals);
      return;
    }
    if (context.mainCommand === "models" && context.subCommand === "set") {
      await this.handleModelsSet(msg, positionals);
      return;
    }
    if (context.route && context.mainCommand === "use") {
      await this.handleRouteUse(msg, context.route, positionals[1] || "");
      return;
    }

    await this.handleAsk(msg, context);
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
      const role = resolveRoleForRoute(config, route);
      lines.push(`${route === "text" ? "📝" : "🖼️"} <b>${routeLabel(route)}</b>`);
      lines.push(`• Provider: <code>${escapeHtml(provider.displayName)}</code> (<code>${escapeHtml(provider.id)}</code>)`);
      if (providerConfig.models?.length) {
        lines.push(`• Models: ${providerConfig.models.map((model) => `<code>${escapeHtml(model)}</code>`).join(" / ")}`);
        lines.push(`• Next Slot: <code>${String(config.cursors[route] % providerConfig.models.length)}</code>`);
      } else {
        lines.push(`• Model: <code>${escapeHtml(providerConfig.model || provider.model || "(未设置)")}</code>`);
      }
      lines.push(`• Role: <code>${escapeHtml(role.name)}</code>`);
      lines.push(`• Role Preview: <code>${escapeHtml(truncateForTelegram(truncatePreview(role.prompt, 120)))}</code>`);
      lines.push(`• API Key: <code>${escapeHtml(maskApiKey(key))}</code>`);
      lines.push(key ? "• 状态: 已就绪" : "• 状态: 未配置 Key");
      lines.push("");
    }

    lines.push(`📦 Built-in Roles: <code>${String(Object.keys(config.roles.builtin).length)}</code>`);
    lines.push(`🗂️ Custom Roles: <code>${String(Object.keys(config.roles.custom).length)}</code>`);

    await safeEditMessage(msg, lines.join("\n"), "html");
  }

  private async handleKey(msg: Api.Message, args: string[]): Promise<void> {
    const providerId = normalizeProviderId(args[1]);
    const apiKey = args.slice(2).join(" ").trim();

    if (!providerId || !apiKey) {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds key &lt;provider&gt; &lt;apiKey&gt;</code>\n` +
          `provider: <code>deepseek</code> / <code>siliconflow</code> / <code>ark</code> / <code>kimi</code> / <code>mimo</code>`,
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

  private async handleRole(msg: Api.Message, context: DsCliContext): Promise<void> {
    const parts = context.cli.positionals;

    if (context.subCommand === "list" || context.subCommand === "ls") {
      await this.handleRoleList(msg);
      return;
    }
    if (context.subCommand === "show") {
      await this.handleRoleShow(msg, parts[2] || "");
      return;
    }
    if (context.subCommand === "use") {
      await this.handleRoleUse(msg, context.route, parts[2] || "");
      return;
    }
    if (context.subCommand === "add") {
      await this.handleRoleAdd(msg, parts[2] || "");
      return;
    }
    if (context.subCommand === "update") {
      await this.handleRoleUpdate(msg, parts[2] || "");
      return;
    }
    if (context.subCommand === "del" || context.subCommand === "delete" || context.subCommand === "rm") {
      await this.handleRoleDelete(msg, parts[2] || "");
      return;
    }
    if (context.subCommand === "reset") {
      await this.handleRoleReset(msg, context.route);
      return;
    }

    await safeEditMessage(
      msg,
      `未知 role 子命令：<code>${escapeHtml(context.subCommand || "(空)")}</code>\n` +
        `用法：<code>${escapeHtml(mainPrefix)}ds role list</code> / <code>${escapeHtml(mainPrefix)}ds role use -txt|--text &lt;name&gt;</code>`,
      "html",
    );
  }

  private async handleRoleList(msg: Api.Message): Promise<void> {
    const config = await this.configStore.get();
    const lines = ["🤖 <b>DS System Roles</b>", ""];

    const builtinNames = Object.keys(config.roles.builtin).sort();
    const customNames = Object.keys(config.roles.custom).sort();

    lines.push("📦 <b>Built-in</b>");
    if (builtinNames.length) {
      for (const name of builtinNames) {
        const tags = (["text", "vision"] as const)
          .filter((route) => config.activeRoles[route] === name)
          .map((route) => routeShortLabel(route));
        const prompt = config.roles.builtin[name] || "";
        lines.push(
          `• <code>${escapeHtml(name)}</code>${tags.length ? ` [${tags.join(", ")}]` : ""} - ${escapeHtml(truncatePreview(prompt, 60))}`,
        );
      }
    } else {
      lines.push("• (无)");
    }

    lines.push("");
    lines.push("🗂️ <b>Custom</b>");
    if (customNames.length) {
      for (const name of customNames) {
        const tags = (["text", "vision"] as const)
          .filter((route) => config.activeRoles[route] === name)
          .map((route) => routeShortLabel(route));
        const prompt = config.roles.custom[name] || "";
        lines.push(
          `• <code>${escapeHtml(name)}</code>${tags.length ? ` [${tags.join(", ")}]` : ""} - ${escapeHtml(truncatePreview(prompt, 60))}`,
        );
      }
    } else {
      lines.push("• (无)");
    }

    await safeEditMessage(msg, lines.join("\n"), "html");
  }

  private async handleRoleShow(msg: Api.Message, rawRoleName: string): Promise<void> {
    const roleName = normalizeRoleName(rawRoleName);
    const config = await this.configStore.get();
    const prompt = getRolePrompt(config, roleName);

    if (!roleName || !prompt) {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds role show &lt;name&gt;</code>\n未找到该 role。`,
        "html",
      );
      return;
    }

    const source = config.roles.custom[roleName] ? "custom" : "builtin";
    await safeEditMessage(
      msg,
      `🤖 <b>Role: ${escapeHtml(roleName)}</b>\n` +
        `来源: <code>${source}</code>\n\n<blockquote expandable>${escapeHtml(prompt)}</blockquote>`,
      "html",
    );
  }

  private async handleRoleUse(
    msg: Api.Message,
    route: RouteKind | null,
    rawRoleName: string,
  ): Promise<void> {
    const roleName = normalizeRoleName(rawRoleName);
    const config = await this.configStore.get();

    if (!route || !roleName || !hasRole(config, roleName)) {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds role use -txt|--text &lt;name&gt;</code>\n` +
          `<code>${escapeHtml(mainPrefix)}ds role use -vis|--vision &lt;name&gt;</code>`,
        "html",
      );
      return;
    }

    await this.configStore.setActiveRole(route, roleName);
    await safeEditMessage(
      msg,
      `✅ ${routeLabel(route)} 已切换到 role <code>${escapeHtml(roleName)}</code>`,
      "html",
    );
  }

  private async readRolePromptFromReply(msg: Api.Message): Promise<string> {
    const replyMsg = await safeGetReplyMessage(msg);
    const text = (replyMsg?.message || "").trim();
    return text;
  }

  private async handleRoleAdd(msg: Api.Message, rawRoleName: string): Promise<void> {
    const roleName = normalizeRoleName(rawRoleName);
    const prompt = await this.readRolePromptFromReply(msg);
    const config = await this.configStore.get();

    if (!roleName || !prompt) {
      await safeEditMessage(
        msg,
        `用法：回复一条包含 prompt 的消息后执行 <code>${escapeHtml(mainPrefix)}ds role add &lt;name&gt;</code>`,
        "html",
      );
      return;
    }
    if (isBuiltinRole(roleName) || config.roles.custom[roleName]) {
      await safeEditMessage(msg, `❌ role <code>${escapeHtml(roleName)}</code> 已存在。`, "html");
      return;
    }

    await this.configStore.setCustomRole(roleName, prompt);
    await safeEditMessage(
      msg,
      `✅ 已创建自定义 role <code>${escapeHtml(roleName)}</code>`,
      "html",
    );
  }

  private async handleRoleUpdate(msg: Api.Message, rawRoleName: string): Promise<void> {
    const roleName = normalizeRoleName(rawRoleName);
    const prompt = await this.readRolePromptFromReply(msg);
    const config = await this.configStore.get();

    if (!roleName || !prompt) {
      await safeEditMessage(
        msg,
        `用法：回复一条包含 prompt 的消息后执行 <code>${escapeHtml(mainPrefix)}ds role update &lt;name&gt;</code>`,
        "html",
      );
      return;
    }
    if (isBuiltinRole(roleName)) {
      await safeEditMessage(msg, "❌ 内置 role 不允许修改。", "html");
      return;
    }
    if (!config.roles.custom[roleName]) {
      await safeEditMessage(msg, `❌ 自定义 role <code>${escapeHtml(roleName)}</code> 不存在。`, "html");
      return;
    }

    await this.configStore.setCustomRole(roleName, prompt);
    await safeEditMessage(
      msg,
      `✅ 已更新自定义 role <code>${escapeHtml(roleName)}</code>`,
      "html",
    );
  }

  private async handleRoleDelete(msg: Api.Message, rawRoleName: string): Promise<void> {
    const roleName = normalizeRoleName(rawRoleName);
    const config = await this.configStore.get();

    if (!roleName) {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds role del &lt;name&gt;</code>`,
        "html",
      );
      return;
    }
    if (isBuiltinRole(roleName)) {
      await safeEditMessage(msg, "❌ 内置 role 不允许删除。", "html");
      return;
    }
    if (!config.roles.custom[roleName]) {
      await safeEditMessage(msg, `❌ 自定义 role <code>${escapeHtml(roleName)}</code> 不存在。`, "html");
      return;
    }
    if (config.activeRoles.text === roleName || config.activeRoles.vision === roleName) {
      await safeEditMessage(
        msg,
        `❌ role <code>${escapeHtml(roleName)}</code> 正在被使用，请先切换对应路由。`,
        "html",
      );
      return;
    }

    await this.configStore.deleteCustomRole(roleName);
    await safeEditMessage(
      msg,
      `✅ 已删除自定义 role <code>${escapeHtml(roleName)}</code>`,
      "html",
    );
  }

  private async handleRoleReset(msg: Api.Message, route: RouteKind | null): Promise<void> {
    if (!route) {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds role reset -txt|--text</code>\n` +
          `<code>${escapeHtml(mainPrefix)}ds role reset -vis|--vision</code>`,
        "html",
      );
      return;
    }

    await this.configStore.resetActiveRole(route);
    await safeEditMessage(
      msg,
      `✅ ${routeLabel(route)} role 已重置为 <code>${DEFAULT_ROLE_NAME}</code>`,
      "html",
    );
  }

  private async handleModelSet(msg: Api.Message, args: string[]): Promise<void> {
    const providerId = normalizeProviderId(args[2]);
    const model = args.slice(3).join(" ").trim();

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

  private async handleModelsSet(msg: Api.Message, args: string[]): Promise<void> {
    const providerId = normalizeProviderId(args[2]);
    const rawModels = args.slice(3).join(" ").trim();
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
        `用法：<code>${escapeHtml(mainPrefix)}ds use ${route === "text" ? "-txt|--text" : "-vis|--vision"} &lt;provider&gt;</code>\n` +
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

  private async handleAsk(msg: Api.Message, context: DsCliContext): Promise<void> {
    await safeEditMessage(msg, "🤖 正在整理上下文…");

    let askContext: AskContext;
    try {
      askContext = await resolveAskContext(msg, context.cli);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await safeEditMessage(msg, message, message.includes("<code>") ? "html" : undefined);
      return;
    }

    const route = askContext.route;
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

    if (askContext.roleOverrideName && !hasRole(selection.config, askContext.roleOverrideName)) {
      await safeEditMessage(
        msg,
        `❌ 未找到 role <code>${escapeHtml(askContext.roleOverrideName)}</code>。\n` +
          `请先执行 <code>${escapeHtml(mainPrefix)}ds role list</code> 查看可用 role。`,
        "html",
      );
      return;
    }

    const resolvedRole = resolveRoleForAsk(selection.config, route, askContext.roleOverrideName);
    const messages = buildMessages(selection.config, askContext, resolvedRole);
    const extraBody = getProviderExtraBody(selection.provider.id, askContext.thinkEnabled);

    const thinkingLabel = `🤖 正在使用 ${selection.provider.displayName} (${selection.model})${askContext.thinkEnabled ? " [think]" : ""}…`;
    if (askContext.question) {
      await safeEditMessage(msg, `💬 ${escapeHtml(askContext.question)}\n──────────\n${thinkingLabel}`, "html");
    } else {
      await safeEditMessage(msg, thinkingLabel);
    }

    let reasoning = "";
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
          reasoning: askContext.thinkEnabled ? reasoning : undefined,
          answer: combined,
          question: askContext.question,
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
          (delta: OpenAICompatDelta) => {
            if (askContext.thinkEnabled && delta.reasoningContent) {
              reasoning += delta.reasoningContent;
            }
            if (delta.content) {
              combined += delta.content;
            }
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
        if (askContext.thinkEnabled) {
          reasoning = extractCompletionReasoning(response) || "";
        }
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
