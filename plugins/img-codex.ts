import axios from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import sharp from "sharp";
import type { Low } from "lowdb";
import { JSONFilePreset } from "lowdb/node";
import { Api } from "teleproto";
import { CustomFile } from "teleproto/client/uploads.js";
import {
  Plugin,
  type PluginRuntimeContext,
} from "@utils/pluginBase";
import { parseCliOptions, parseCommandInput, tokenizeCliArgs } from "@utils/commandParser";
import type { GenerationContext } from "@utils/generationContext";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { safeGetReplyMessage } from "@utils/safeGetMessages";

const PLUGIN_NAME = "img-codex";
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_MODEL = "gpt-5.4";
const CODEX_MAX_WAIT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;
const STATUS_EDIT_INTERVAL_MS = 1500;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const TARGET_REFERENCE_BYTES = 4 * 1024 * 1024;
const MAX_REFERENCE_DIMENSION = 2048;
const CONFIG_PATH = path.join(
  createDirectoryInAssets(PLUGIN_NAME),
  "config.json",
);
const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");

type CodexImageConfig = {
  manualAccessToken: string;
};

type AuthSource = "manual_override" | "codex_auth_json" | "missing";

type ResolvedAuth = {
  token: string;
  source: AuthSource;
};

type PreparedReferenceImage = {
  buffer: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  wasCompressed: boolean;
  originalBytes: number;
  finalBytes: number;
};

type GenerateOptions = {
  transparentBackground: boolean;
};

type CodexResponseResult = {
  imageBase64: string | null;
  revisedPrompt: string | null;
  status: string | null;
  responseId: string | null;
  errorMessage: string | null;
  errorDetail: string | null;
};

type CodexErrorCode =
  | "auth_error"
  | "rate_limit"
  | "timeout"
  | "input_error"
  | "remote_error"
  | "parse_error";

class CodexImageError extends Error {
  code: CodexErrorCode;
  status?: number;

  constructor(code: CodexErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

type StatusUpdater = (phase: string) => Promise<void>;

type StreamPayload = Record<string, unknown>;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}秒`;
  return `${minutes}分${seconds}秒`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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

function maskToken(token: string): string {
  const value = token.trim();
  if (!value) return "未配置";
  if (value.length <= 8) {
    return `${value.slice(0, 2)}***${value.slice(-2)}`;
  }
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
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

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("IMG generation aborted");
}

function isAbortError(error: unknown): boolean {
  if (axios.isAxiosError(error) && error.code === "ERR_CANCELED") {
    return true;
  }
  if (error instanceof Error) {
    return /aborted|abort|canceled|cancelled/i.test(error.message);
  }
  return typeof error === "string" && /aborted|abort|canceled|cancelled/i.test(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError(signal.reason);
  }
}

class CodexImageConfigStore {
  private dbPromise: Promise<Low<CodexImageConfig>> | null = null;

  private async getDb(): Promise<Low<CodexImageConfig>> {
    if (!this.dbPromise) {
      this.dbPromise = JSONFilePreset<CodexImageConfig>(CONFIG_PATH, {
        manualAccessToken: "",
      });
    }
    const db = await this.dbPromise;
    db.data ||= { manualAccessToken: "" };
    return db;
  }

  async getManualAccessToken(): Promise<string> {
    const db = await this.getDb();
    return (db.data?.manualAccessToken || "").trim();
  }

  async setManualAccessToken(token: string): Promise<void> {
    const db = await this.getDb();
    db.data!.manualAccessToken = token.trim();
    await db.write();
  }

  async clearManualAccessToken(): Promise<void> {
    const db = await this.getDb();
    db.data!.manualAccessToken = "";
    await db.write();
  }

  cleanup(): void {
    this.dbPromise = null;
  }
}

function readCodexAuthToken(): string {
  try {
    if (!fs.existsSync(CODEX_AUTH_PATH)) return "";
    const raw = fs.readFileSync(CODEX_AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      access_token?: unknown;
      tokens?: { access_token?: unknown };
    };

    const nestedToken =
      typeof parsed?.tokens?.access_token === "string"
        ? parsed.tokens.access_token.trim()
        : "";
    if (nestedToken) return nestedToken;

    const rootToken =
      typeof parsed?.access_token === "string"
        ? parsed.access_token.trim()
        : "";
    return rootToken;
  } catch {
    return "";
  }
}

async function resolveAuth(
  configStore: CodexImageConfigStore,
): Promise<ResolvedAuth> {
  const manualToken = await configStore.getManualAccessToken();
  if (manualToken) {
    return { token: manualToken, source: "manual_override" };
  }

  const authToken = readCodexAuthToken();
  if (authToken) {
    return { token: authToken, source: "codex_auth_json" };
  }

  return { token: "", source: "missing" };
}

function parseGenerateOptions(rawPrompt: string): {
  prompt: string;
  options: GenerateOptions;
} {
  const parts = tokenizeCliArgs(rawPrompt);
  const options: GenerateOptions = {
    transparentBackground: false,
  };
  const parsed = parseCliOptions(parts, [
    { name: "transparentBackground", aliases: ["-t", "--transparent"], kind: "boolean" },
  ]);
  options.transparentBackground = parsed.options.transparentBackground === true;

  return {
    prompt: parsed.positionals.join(" ").trim(),
    options,
  };
}

function getAuthSourceLabel(source: AuthSource): string {
  switch (source) {
    case "manual_override":
      return "手动覆盖";
    case "codex_auth_json":
      return `.codex/auth.json`;
    default:
      return "未配置";
  }
}

function isSupportedMimeType(mimeType: string): mimeType is PreparedReferenceImage["mimeType"] {
  return (
    mimeType === "image/jpeg" ||
    mimeType === "image/png" ||
    mimeType === "image/webp"
  );
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

async function getReplyImageBuffer(msg: Api.Message): Promise<Buffer | null> {
  const replyMsg = await safeGetReplyMessage(msg);
  if (!replyMsg?.media) return null;
  if (!msg.client) {
    throw new CodexImageError("input_error", "无法获取 Telegram 客户端实例");
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
    for await (const chunk of mediaData as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    return buffer.length ? buffer : null;
  }
  return null;
}

async function prepareReferenceImage(msg: Api.Message): Promise<PreparedReferenceImage | null> {
  const replyMsg = await safeGetReplyMessage(msg);
  if (!replyMsg?.media) return null;

  const sourceBuffer = await getReplyImageBuffer(msg);
  if (!sourceBuffer?.length) {
    throw new CodexImageError("input_error", "未能获取参考图数据");
  }

  const originalMime = getMessageImageMimeType(replyMsg);
  let transformer: sharp.Sharp;
  try {
    transformer = sharp(sourceBuffer, { animated: true, failOn: "warning" });
  } catch {
    throw new CodexImageError("input_error", "参考图格式无法处理，请改用静态 JPG/PNG/WebP");
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await transformer.metadata();
  } catch {
    throw new CodexImageError("input_error", "无法读取参考图信息，请改用静态 JPG/PNG/WebP");
  }

  if ((metadata.pages || 1) > 1) {
    throw new CodexImageError("input_error", "暂不支持动图，请回复静态 JPG/PNG/WebP 图片");
  }

  const normalizedMime: PreparedReferenceImage["mimeType"] = isSupportedMimeType(originalMime)
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
  let wasCompressed = output.length !== sourceBuffer.length || output !== sourceBuffer;

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
    wasCompressed = true;
  }

  if (output.length > MAX_REFERENCE_BYTES) {
    throw new CodexImageError(
      "input_error",
      `参考图处理后仍然过大（${formatBytes(output.length)}），请换一张更小的静态图片`,
    );
  }

  return {
    buffer: output,
    mimeType: finalMime,
    wasCompressed,
    originalBytes: sourceBuffer.length,
    finalBytes: output.length,
  };
}

function mapAxiosError(error: unknown): CodexImageError {
  if (!axios.isAxiosError(error)) {
    if (error instanceof CodexImageError) return error;
    return new CodexImageError(
      "remote_error",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (error.code === "ECONNABORTED") {
    return new CodexImageError("timeout", "请求 Codex 超时");
  }

  const status = error.response?.status;
  const detail =
    typeof error.response?.data === "string"
      ? error.response.data.slice(0, 300)
      : error.message;

  if (status === 400) {
    return new CodexImageError("input_error", detail || "请求参数无效", status);
  }
  if (status === 401 || status === 403) {
    return new CodexImageError("auth_error", "鉴权失败，请检查登录状态或重新设置 token", status);
  }
  if (status === 408 || status === 504) {
    return new CodexImageError("timeout", "Codex 返回超时", status);
  }
  if (status === 429) {
    return new CodexImageError("rate_limit", "请求过于频繁，请稍后再试", status);
  }
  return new CodexImageError(
    "remote_error",
    detail || "Codex 服务请求失败",
    status,
  );
}

function buildPayload(
  prompt: string,
  options: GenerateOptions,
  referenceImage?: PreparedReferenceImage,
): Record<string, unknown> {
  const content = referenceImage
    ? [
        { type: "input_text", text: prompt },
        {
          type: "input_image",
          image_url: `data:${referenceImage.mimeType};base64,${referenceImage.buffer.toString("base64")}`,
        },
      ]
    : prompt;

  return {
    model: CODEX_MODEL,
    instructions: "You are a helpful assistant. Use tools when available.",
    input: [
      {
        role: "user",
        content,
      },
    ],
    store: false,
    tools: [
      {
        type: "image_generation",
        ...(options.transparentBackground
          ? {
              background: "transparent",
              output_format: "png",
            }
          : {}),
      },
    ],
    reasoning: { effort: "low" },
    include: [],
    tool_choice: { type: "image_generation" },
    parallel_tool_calls: true,
    prompt_cache_key: null,
    stream: true,
  };
}

function applyStreamPayload(
  payload: StreamPayload,
  current: CodexResponseResult,
): CodexResponseResult {
  const next = { ...current };
  const eventType = typeof payload.type === "string" ? payload.type : "";
  const response = payload.response as { id?: unknown; status?: unknown } | undefined;

  if (eventType === "response.created") {
    if (typeof response?.id === "string") next.responseId = response.id;
    if (typeof response?.status === "string") next.status = response.status;
    const error = payload.error as Record<string, unknown> | undefined;
    if (typeof error?.message === "string" && error.message) {
      next.errorMessage = error.message;
    }
    if (typeof payload.detail === "string" && payload.detail) {
      next.errorDetail = payload.detail;
    }
    return next;
  }

  if (eventType === "response.image_generation_call.partial_image") {
    if (typeof payload.partial_image_b64 === "string" && payload.partial_image_b64) {
      next.imageBase64 = payload.partial_image_b64;
    }
    if (typeof payload.revised_prompt === "string" && payload.revised_prompt) {
      next.revisedPrompt = payload.revised_prompt;
    }
    if (typeof payload.status === "string" && payload.status) {
      next.status = payload.status;
    }
    return next;
  }

  if (eventType === "response.completed") {
    if (typeof response?.id === "string") next.responseId = response.id;
    if (typeof response?.status === "string") next.status = response.status;
    const error = payload.error as Record<string, unknown> | undefined;
    if (typeof error?.message === "string" && error.message) {
      next.errorMessage = error.message;
    }
    if (typeof payload.detail === "string" && payload.detail) {
      next.errorDetail = payload.detail;
    }
    return next;
  }

  return next;
}

async function readStreamResult(
  token: string,
  payload: Record<string, unknown>,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<CodexResponseResult> {
  let response;
  try {
    response = await axios.post(CODEX_URL, payload, {
      responseType: "stream",
      timeout: Math.max(1000, deadlineAt - Date.now()),
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    throw mapAxiosError(error);
  }

  let buffer = "";
  let result: CodexResponseResult = {
    imageBase64: null,
    revisedPrompt: null,
    status: null,
    responseId: null,
    errorMessage: null,
    errorDetail: null,
  };

  try {
    for await (const chunk of response.data as AsyncIterable<Buffer>) {
      throwIfAborted(signal);
      buffer += chunk.toString("utf8");

      let delimiterIndex = buffer.indexOf("\n\n");
      while (delimiterIndex !== -1) {
        const rawEvent = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);

        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
          .trim();

        if (data && data !== "[DONE]") {
          let parsed: StreamPayload;
          try {
            parsed = JSON.parse(data) as StreamPayload;
          } catch {
            throw new CodexImageError("parse_error", "Codex 流式响应解析失败");
          }
          result = applyStreamPayload(parsed, result);
        }

        delimiterIndex = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (error instanceof CodexImageError) throw error;
    throw new CodexImageError("remote_error", "读取 Codex 流式响应失败");
  }

  return result;
}

function extractImageFields(value: unknown, current: CodexResponseResult): void {
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (typeof record.partial_image_b64 === "string" && record.partial_image_b64) {
    current.imageBase64 = record.partial_image_b64;
  }
  if (typeof record.revised_prompt === "string" && record.revised_prompt) {
    current.revisedPrompt = record.revised_prompt;
  }
  const error = record.error as Record<string, unknown> | undefined;
  if (typeof error?.message === "string" && error.message) {
    current.errorMessage = error.message;
  }
  if (typeof record.detail === "string" && record.detail) {
    current.errorDetail = record.detail;
  }

  if (Array.isArray(value)) {
    for (const item of value) extractImageFields(item, current);
    return;
  }
  for (const nested of Object.values(record)) {
    extractImageFields(nested, current);
  }
}

async function fetchResponseStatus(
  token: string,
  responseId: string,
  deadlineAt: number,
  signal: AbortSignal,
): Promise<CodexResponseResult> {
  let response;
  try {
    response = await axios.get(`${CODEX_URL}/${responseId}`, {
      timeout: Math.min(60000, Math.max(1000, deadlineAt - Date.now())),
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    throw mapAxiosError(error);
  }

  const data = (response.data?.response || response.data) as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    throw new CodexImageError("parse_error", "Codex 轮询响应格式无效");
  }

  const result: CodexResponseResult = {
    imageBase64: null,
    revisedPrompt: null,
    status: typeof data.status === "string" ? data.status : null,
    responseId: typeof data.id === "string" ? data.id : responseId,
    errorMessage: null,
    errorDetail: null,
  };
  extractImageFields(data, result);
  return result;
}

async function callCodexImage(params: {
  prompt: string;
  token: string;
  options: GenerateOptions;
  referenceImage?: PreparedReferenceImage;
  deadlineAt: number;
  lifecycle: GenerationContext;
  signal: AbortSignal;
  updateStatus?: StatusUpdater;
}): Promise<CodexResponseResult> {
  const {
    prompt,
    token,
    options,
    referenceImage,
    deadlineAt,
    lifecycle,
    signal,
    updateStatus,
  } = params;
  const payload = buildPayload(prompt, options, referenceImage);
  const streamResult = await readStreamResult(token, payload, deadlineAt, signal);

  if (
    streamResult.imageBase64 ||
    !streamResult.responseId ||
    streamResult.status !== "in_progress"
  ) {
    return streamResult;
  }

  await updateStatus?.("⏳ 正在生成图片...");

  while (Date.now() < deadlineAt) {
    throwIfAborted(signal);
    await lifecycle.delay(
      Math.min(POLL_INTERVAL_MS, Math.max(1000, deadlineAt - Date.now())),
      { label: "img-codex:poll-delay" },
    );
    const polled = await fetchResponseStatus(
      token,
      streamResult.responseId,
      deadlineAt,
      signal,
    );
    if (polled.imageBase64) return polled;
    if (polled.status && polled.status !== "in_progress") {
      return {
        ...streamResult,
        ...polled,
        imageBase64: polled.imageBase64 || streamResult.imageBase64,
        revisedPrompt: polled.revisedPrompt || streamResult.revisedPrompt,
      };
    }
  }

  throw new CodexImageError("timeout", "生成超时，已等待超过 10 分钟");
}

function formatUserFacingError(error: unknown): string {
  if (error instanceof CodexImageError) {
    return error.message;
  }
  if (axios.isAxiosError(error)) {
    return mapAxiosError(error).message;
  }
  return error instanceof Error ? error.message : String(error);
}

function buildMissingImageDetail(result: CodexResponseResult): string {
  if (result.errorMessage) {
    return `（${result.errorMessage}）`;
  }
  if (result.errorDetail) {
    return `（${result.errorDetail}）`;
  }
  if (result.status) {
    return `（status: ${result.status}）`;
  }
  return "";
}

async function sendResultImage(
  msg: Api.Message,
  prompt: string,
  result: CodexResponseResult,
  elapsed: string,
): Promise<void> {
  if (!msg.client) {
    throw new CodexImageError("input_error", "无法获取 Telegram 客户端实例");
  }
  if (!result.imageBase64) {
    throw new CodexImageError(
      "remote_error",
      `未收到生成图片${buildMissingImageDetail(result)}`,
    );
  }

  const imageBuffer = Buffer.from(result.imageBase64, "base64");
  const file = new CustomFile(
    `codex_image_${Date.now()}.png`,
    imageBuffer.length,
    "",
    imageBuffer,
  );

  const caption = [
    `<b>提示词:</b> ${escapeHtml(prompt)}`,
    `<b>耗时:</b> ${escapeHtml(elapsed)}`,
    result.revisedPrompt
      ? `<b>修订提示词:</b> ${escapeHtml(result.revisedPrompt)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const replyMsg = await safeGetReplyMessage(msg);
  await msg.client.sendFile(msg.peerId, {
    file,
    caption,
    parseMode: "html",
    replyTo: replyMsg?.id || msg.id,
  });
}

async function handleAuthCommand(
  msg: Api.Message,
  args: string[],
  configStore: CodexImageConfigStore,
): Promise<void> {
  const subcommand = (args[0] || "").toLowerCase();

  if (subcommand === "set") {
    const token = args.slice(1).join(" ").trim();
    if (!token) {
      await safeEditMessage(
        msg,
        "❌ 用法：<code>.img auth set &lt;access_token&gt;</code>",
        "html",
      );
      return;
    }
    await configStore.setManualAccessToken(token);
    await safeEditMessage(msg, "✅ 已保存手动覆盖 token");
    return;
  }

  if (subcommand === "clear") {
    await configStore.clearManualAccessToken();
    const resolved = await resolveAuth(configStore);
    const fallback =
      resolved.source === "codex_auth_json"
        ? "，已恢复使用 .codex/auth.json"
        : "";
    await safeEditMessage(msg, `✅ 已清除手动覆盖 token${fallback}`);
    return;
  }

  if (subcommand === "status") {
    const manualToken = await configStore.getManualAccessToken();
    const resolved = await resolveAuth(configStore);
    await safeEditMessage(
      msg,
      [
        "🔐 <b>Codex 鉴权状态</b>",
        `<b>当前来源:</b> ${escapeHtml(getAuthSourceLabel(resolved.source))}`,
        `<b>当前 token:</b> <code>${escapeHtml(maskToken(resolved.token))}</code>`,
        `<b>手动覆盖:</b> <code>${escapeHtml(maskToken(manualToken))}</code>`,
        `<b>auth.json:</b> <code>${escapeHtml(maskToken(readCodexAuthToken()))}</code>`,
      ].join("\n"),
      "html",
    );
    return;
  }

  await safeEditMessage(
    msg,
    [
      "❌ 用法：",
      "<code>.img auth set &lt;access_token&gt;</code>",
      "<code>.img auth status</code>",
      "<code>.img auth clear</code>",
    ].join("\n"),
    "html",
  );
}

async function handleImgHelp(msg: Api.Message): Promise<void> {
  await safeEditMessage(
    msg,
    renderHelpSections(
      "🖼️ <b>IMG 帮助</b>",
      `通过 Codex 调用 <code>${CODEX_MODEL}</code> 生成图片。`,
      [
        {
          heading: "📌 基本用法：",
          lines: [
            "<code>.img 提示词</code> - 纯文本生成图片",
            "<code>.img -t 提示词</code> - 生成透明背景图片",
            "<code>.img</code> 回复图片后发送提示词 - 使用参考图生成",
          ],
        },
        {
          heading: "🔐 鉴权管理：",
          lines: [
            "<code>.img auth set &lt;access_token&gt;</code> - 设置手动覆盖 token",
            "<code>.img auth status</code> - 查看当前鉴权来源",
            "<code>.img auth clear</code> - 清除手动覆盖 token",
            "<code>.img help</code> - 查看帮助",
          ],
        },
      ],
    ),
    "html",
  );
}

async function handleGenerateCommand(params: {
  msg: Api.Message;
  prompt: string;
  configStore: CodexImageConfigStore;
  lifecycle: GenerationContext;
  signal: AbortSignal;
}): Promise<void> {
  const {
    msg,
    prompt,
    configStore,
    lifecycle,
    signal,
  } = params;
  const parsed = parseGenerateOptions(prompt);
  const normalizedPrompt = parsed.prompt;
  const options = parsed.options;

  if (!normalizedPrompt) {
    await safeEditMessage(
      msg,
      [
        "❌ 请输入提示词，例如：",
        "<code>.img 一只戴墨镜的柴犬坐在跑车里</code>",
        "<code>.img -t 站在雪地里的白发少女立绘</code>",
        "鉴权管理：<code>.img auth status</code>",
      ].join("\n"),
      "html",
    );
    return;
  }

  const auth = await resolveAuth(configStore);
  if (!auth.token) {
    await safeEditMessage(
      msg,
      [
        "❌ 未找到可用的 Codex access token",
        "可选方式：",
        "1. 登录本机 Codex，确保 <code>~/.codex/auth.json</code> 可用",
        "2. 手动设置 <code>.img auth set &lt;access_token&gt;</code>",
      ].join("\n"),
      "html",
    );
    return;
  }

  const startedAt = Date.now();
  const deadlineAt = startedAt + CODEX_MAX_WAIT_MS;
  let lastStatusEdit = 0;
  const updateStatus: StatusUpdater = async (phase) => {
    const now = Date.now();
    if (now - lastStatusEdit < STATUS_EDIT_INTERVAL_MS) return;
    lastStatusEdit = now;
    await safeEditMessage(
      msg,
      `${phase}\n⏱️ 已耗时：${formatDuration(now - startedAt)}`,
    );
  };

  try {
    throwIfAborted(signal);
    const hasReplyImage = !!(await safeGetReplyMessage(msg))?.media;
    await updateStatus(
      hasReplyImage ? "🖼️ 正在检查参考图..." : "🎨 正在生成图片...",
    );
    const referenceImage = await prepareReferenceImage(msg);

    if (referenceImage) {
      const extra = referenceImage.wasCompressed
        ? `（已压缩 ${formatBytes(referenceImage.originalBytes)} -> ${formatBytes(referenceImage.finalBytes)}）`
        : "";
      await updateStatus(`🧰 已处理参考图${extra}，正在生成图片...`);
    }

    const result = await callCodexImage({
      prompt: normalizedPrompt,
      token: auth.token,
      options,
      referenceImage: referenceImage || undefined,
      deadlineAt,
      lifecycle,
      signal,
      updateStatus,
    });

    const elapsed = formatDuration(Date.now() - startedAt);
    await sendResultImage(msg, normalizedPrompt, result, elapsed);

    try {
      await msg.delete();
    } catch {
      await safeEditMessage(msg, `✅ 图片生成完成\n⏱️ 耗时：${elapsed}`);
    }
  } catch (error) {
    if (isAbortError(error) || signal.aborted) {
      return;
    }
    const elapsed = formatDuration(Date.now() - startedAt);
    await safeEditMessage(
      msg,
      `❌ ${escapeHtml(formatUserFacingError(error))}\n⏱️ 耗时：${elapsed}`,
      "html",
    );
  }
}

class CodexImagePlugin extends Plugin {
  name = PLUGIN_NAME;
  private lifecycle: GenerationContext | null = null;
  private readonly configStore = new CodexImageConfigStore();

  setup(context: PluginRuntimeContext): void {
    this.lifecycle = context.lifecycle;
  }

  cleanup(): void {
    this.lifecycle = null;
    this.configStore.cleanup();
  }

  private requireLifecycle(): GenerationContext {
    if (!this.lifecycle) {
      throw new Error("IMG 插件尚未初始化");
    }
    return this.lifecycle;
  }

  description = renderHelpSections(
    "🖼️ <b>IMG 帮助</b>",
    `通过 Codex 调用 <code>${CODEX_MODEL}</code> 生成图片。`,
    [
      {
        heading: "📌 基本用法：",
        lines: [
          "<code>.img 提示词</code> - 纯文本生成图片",
          "<code>.img -t 提示词</code> - 生成透明背景图片",
          "<code>.img</code> 回复图片并发送提示词 - 使用参考图生成",
        ],
      },
      {
        heading: "🔐 鉴权管理：",
        lines: [
          "<code>.img auth set token</code> - 设置手动覆盖 token",
          "<code>.img auth status</code> - 查看当前鉴权来源",
          "<code>.img auth clear</code> - 清除手动覆盖 token",
          "<code>.img help</code> - 查看帮助",
        ],
      },
    ],
  );

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    img: async (msg) => {
      const parsed = parseCommandInput(msg);
      const body = parsed?.body || "";
      const args = parsed?.args || [];
      const head = (args[0] || "").toLowerCase();

      if (head === "auth") {
        await handleAuthCommand(msg, args.slice(1), this.configStore);
        return;
      }

      if (head === "help") {
        await handleImgHelp(msg);
        return;
      }

      const lifecycle = this.requireLifecycle();
      await lifecycle.runTask(
        async (signal) =>
          await handleGenerateCommand({
            msg,
            prompt: body,
            configStore: this.configStore,
            lifecycle,
            signal,
          }),
        { label: "img-codex:generate", kind: "promise" },
      );
    },
  };
}

export default new CodexImagePlugin();
