import { Plugin, type PluginRuntimeContext } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/globalClient";
import { safeGetMe } from "@utils/authGuards";
import {
  type ArchiveNormalizationStats,
  ArchiveDB,
  type ArchiveSearchParams,
  type ArchiveSearchRow,
  type ArchiveStats,
  type BackfillTargetRecord,
  type BackfillTargetStatus,
} from "@utils/archiveDb";
import {
  buildArchiveInput,
  collectChatIdCandidates,
  getDateNumber,
  normalizeId,
  resolveChatContext,
  toCanonicalChatId,
  type ArchiveChatType,
  type ArchiveMessageInput,
} from "@utils/archiveMessageBuilder";
import type { GenerationContext } from "@utils/generationContext";
import { Api, TelegramClient, utils } from "teleproto";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";
const pluginName = "archive";
const commandName = `${mainPrefix}${pluginName}`;
const MAX_RESULT_COUNT = 20;
const MAX_CHUNK_LENGTH = 3500;
const BACKFILL_LIST_PAGE_SIZE = 10;
const BACKFILL_BATCH_SIZE = 100;
const BACKFILL_BATCH_PAUSE_MS = 2000;
const MANUAL_BACKFILL_STOP_REASON = "Archive backfill stopped by command";

type ArchiveRuntimeStats = {
  seenEvents: number;
  storedEvents: number;
  skippedEvents: number;
  lastSeenAt: number;
  lastStoredAt: number;
  lastSkipReason: string;
  lastError: string;
};

type BackfillAbortContext = {
  chatId: string;
  title: string;
  cursorMessageId?: number;
  processedMessages: number;
};

interface BackfillDialogOption {
  chatId: string;
  title: string;
  username?: string;
  chatType: ArchiveChatType;
  inputEntity: any;
}

type ActiveBackfillRuntime = {
  chatId: string;
  title: string;
  processedMessages: number;
  cursorMessageId?: number;
};

function createRuntimeStats(): ArchiveRuntimeStats {
  return {
    seenEvents: 0,
    storedEvents: 0,
    skippedEvents: 0,
    lastSeenAt: 0,
    lastStoredAt: 0,
    lastSkipReason: "",
    lastError: "",
  };
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

type CommandFilters = {
  keyword?: string;
  chat?: string;
  user?: string;
  from?: string;
  to?: string;
  limit?: number;
};

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function compact(text: string, limit = 180): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function buildExpandableBlockquote(lines: string[]): string {
  return `<blockquote expandable>${lines.join("\n\n")}</blockquote>`;
}

function canUseFtsKeyword(keyword: string): boolean {
  return /^[\p{L}\p{N}\s_-]+$/u.test(keyword);
}

function getFloodWaitMs(error: unknown): number | null {
  const message = extractErrorMessage(error);
  const match = /FLOOD(?:_PREMIUM)?_WAIT_(\d+)/.exec(message) || /A wait of (\d+) seconds/i.exec(message);
  if (!match) return null;
  const seconds = parseInt(match[1], 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return (seconds + 1) * 1000;
}

function parseDateInput(value?: string, endOfDay = false): number | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, m, d] = match;
  const suffix = endOfDay ? "T23:59:59.999+08:00" : "T00:00:00.000+08:00";
  const parsed = Date.parse(`${y}-${m}-${d}${suffix}`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseCommandFilters(args: string[]): CommandFilters {
  const filters: CommandFilters = {};
  const keywordParts: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("chat=")) {
      filters.chat = arg.slice("chat=".length);
      continue;
    }
    if (arg.startsWith("user=")) {
      filters.user = arg.slice("user=".length);
      continue;
    }
    if (arg.startsWith("from=")) {
      filters.from = arg.slice("from=".length);
      continue;
    }
    if (arg.startsWith("to=")) {
      filters.to = arg.slice("to=".length);
      continue;
    }
    if (arg.startsWith("limit=")) {
      const parsed = parseInt(arg.slice("limit=".length), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        filters.limit = Math.min(parsed, MAX_RESULT_COUNT);
      }
      continue;
    }
    keywordParts.push(arg);
  }

  const keyword = keywordParts.join(" ").trim();
  if (keyword) filters.keyword = keyword;
  return filters;
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string") return new Error(reason);
  return new Error("Archive operation aborted");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError(signal.reason);
  }
}

function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error) {
    return /aborted|abort/i.test(error.message);
  }
  return typeof error === "string" && /aborted|abort/i.test(error);
}

async function ensureSelfInvocation(
  msg: Api.Message,
  ownerIdCacheRef: { current: string | null }
): Promise<boolean> {
  if (msg.out) return true;
  if (!msg.client) return false;

  if (!ownerIdCacheRef.current) {
    const me = await safeGetMe(msg.client);
    ownerIdCacheRef.current = me ? getMarkedPeerId(me) || String(me.id) : "";
  }

  const senderId = msg.senderId ? String(msg.senderId) : undefined;
  return Boolean(ownerIdCacheRef.current) && Boolean(senderId) && ownerIdCacheRef.current === senderId;
}

async function resolveEntityWithFallback(client: TelegramClient, raw: string): Promise<any> {
  const attempts: Array<string | number> = [raw];
  if (/^-?\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isSafeInteger(numeric)) attempts.push(numeric);
  }

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await client.getEntity(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return "未知错误";
}

function getMarkedPeerId(peer: unknown): string | undefined {
  if (!peer) return undefined;
  try {
    return utils.getPeerId(peer as never);
  } catch {
    return undefined;
  }
}

function getChatTypeFromEntity(entity: unknown): ArchiveChatType | undefined {
  if (entity instanceof Api.Channel) {
    return entity.megagroup ? "supergroup" : "channel";
  }
  if (entity instanceof Api.Chat) {
    return "group";
  }
  return undefined;
}

async function resolveChatIdFilter(client: TelegramClient, input?: string): Promise<string | undefined> {
  if (!input) return undefined;
  if (/^-?\d+$/.test(input)) return input;
  let entity: any;
  try {
    entity = await resolveEntityWithFallback(client, input);
  } catch (error) {
    throw new Error(
      `无法解析聊天目标: ${input}\n请使用 @username 或数字 chatId\n原因: ${extractErrorMessage(error)}`
    );
  }
  return getMarkedPeerId(entity);
}

async function resolveUserIdFilter(client: TelegramClient, input?: string): Promise<string | undefined> {
  if (!input) return undefined;
  if (/^-?\d+$/.test(input)) return input;
  let entity: any;
  try {
    entity = await resolveEntityWithFallback(client, input);
  } catch (error) {
    throw new Error(
      `无法解析用户目标: ${input}\n请使用 @username 或数字 userId\n原因: ${extractErrorMessage(error)}`
    );
  }
  return getMarkedPeerId(entity);
}

class ArchivePlugin extends Plugin {
  name = pluginName;
  private backfillPromise: Promise<void> | null = null;
  private activeBackfill: ActiveBackfillRuntime | null = null;
  private backfillAbortController: AbortController | null = null;
  private lifecycle: GenerationContext | null = null;
  private ownerIdCache: { current: string | null } = { current: null };
  private runtimeStats: ArchiveRuntimeStats = createRuntimeStats();

  setup(context: PluginRuntimeContext): void {
    this.lifecycle = context.lifecycle;
    this.ownerIdCache.current = null;
    this.runtimeStats = createRuntimeStats();
    const db = new ArchiveDB();
    db.close();
    console.log("[archive] plugin initialized");
    void this.resumeBackfillIfNeeded();
  }

  cleanup(): void {
    this.lifecycle = null;
    this.backfillPromise = null;
    this.activeBackfill = null;
    this.backfillAbortController = null;
    this.ownerIdCache.current = null;
    this.runtimeStats = createRuntimeStats();
  }

  description: string = renderHelpSections(
    "🗂️ <b>Archive 帮助</b>",
    "持久化归档群组消息，并提供全文检索与单会话历史补抓。",
    [
      {
        heading: "📌 基本命令：",
        lines: [
          `<code>${commandName} help</code> - 查看帮助`,
          `<code>${commandName} status</code> - 查看归档状态`,
          `<code>${commandName} normalize</code> - 归一化历史 chatId 并合并旧结构残留`,
          `<code>${commandName} backfill</code> - 查看可补抓会话列表`,
          `<code>${commandName} backfill list [页码]</code> - 分页展示可补抓会话`,
          `<code>${commandName} backfill run &lt;chatId或@username&gt;</code> - 补抓单个会话`,
          `<code>${commandName} backfill resume</code> - 恢复最近失败/停止的会话补抓`,
          `<code>${commandName} backfill stop</code> - 停止当前会话补抓并保留断点`,
        ],
      },
      {
        heading: "🚫 黑名单：",
        lines: [
          `<code>${commandName} bl</code> - 将当前会话加入黑名单（不采集、不搜索）`,
          `<code>${commandName} bl rm</code> - 将当前会话移出黑名单`,
          `<code>${commandName} bl list</code> - 查看黑名单`,
        ],
      },
      {
        heading: "🔎 检索命令：",
        lines: [
          `<code>${commandName} search 关键词 [chat=@xxx] [user=@xxx] [from=2026-05-01] [to=2026-05-22] [limit=10]</code>`,
          `<code>${commandName} chat @chat或chatId [关键词] [from=YYYY-MM-DD] [to=YYYY-MM-DD] [limit=10]</code>`,
          `<code>${commandName} user @user或userId [关键词] [chat=@chat] [from=YYYY-MM-DD] [to=YYYY-MM-DD] [limit=10]</code>`,
        ],
      },
    ],
  );

  ignoreEdited = false;
  listenMessageHandlerIgnoreEdited = false;

  cmdHandlers: Record<string, (msg: Api.Message) => Promise<void>> = {
    archive: async (msg) => {
      if (!(await ensureSelfInvocation(msg, this.ownerIdCache))) {
        await msg.edit({ text: "❌ 仅 TeleBox 所属账号本人可使用 archive 命令" }).catch(() => undefined);
        return;
      }

      const parts = String(msg.message || msg.text || "").trim().split(/\s+/).filter(Boolean);
      const subCommand = parts[1]?.toLowerCase() || "help";

      if (subCommand === "help") {
        await msg.edit({ text: this.description, parseMode: "html", linkPreview: false });
        return;
      }
      if (subCommand === "status") {
        await this.handleStatus(msg);
        return;
      }
      if (subCommand === "normalize") {
        await this.handleNormalize(msg);
        return;
      }
      if (subCommand === "backfill") {
        await this.handleBackfill(msg, parts.slice(2));
        return;
      }
      if (subCommand === "bl") {
        await this.handleBlacklist(msg, parts.slice(2));
        return;
      }
      if (subCommand === "search") {
        await this.handleSearch(msg, parts.slice(2));
        return;
      }
      if (subCommand === "chat") {
        await this.handleChatSearch(msg, parts.slice(2));
        return;
      }
      if (subCommand === "user") {
        await this.handleUserSearch(msg, parts.slice(2));
        return;
      }

      await msg.edit({ text: this.description, parseMode: "html", linkPreview: false });
    },
  };

  listenMessageHandler = async (msg: Api.Message, options?: { isEdited?: boolean }) => {
    this.runtimeStats.seenEvents += 1;
    this.runtimeStats.lastSeenAt = Date.now();

    if (!msg?.client) {
      this.runtimeStats.skippedEvents += 1;
      this.runtimeStats.lastSkipReason = "message.client 不存在";
      return;
    }

    try {
      const archive = await buildArchiveInput(msg);
      if (!archive.input || !archive.chatType || !archive.chatTitle) {
        this.runtimeStats.skippedEvents += 1;
        this.runtimeStats.lastSkipReason = "未解析出群组上下文";
        return;
      }
      if (!["group", "supergroup"].includes(archive.chatType)) {
        this.runtimeStats.skippedEvents += 1;
        this.runtimeStats.lastSkipReason = `不在采集范围: ${archive.chatType}`;
        return;
      }

      const db = new ArchiveDB();
      try {
        if (db.isChatBlacklisted(collectChatIdCandidates(archive.chatType, archive.input.chatId))) {
          this.runtimeStats.skippedEvents += 1;
          this.runtimeStats.lastSkipReason = `黑名单会话: ${archive.chatTitle}`;
          return;
        }

        db.upsertChat({
          chatId: archive.input.chatId,
          chatType: archive.chatType,
          title: archive.chatTitle,
          username: archive.chatUsername,
          lastSeenAt: Date.now(),
        });
        db.upsertBackfillTargetMeta({
          chatId: archive.input.chatId,
          chatType: archive.chatType,
          title: archive.chatTitle,
          username: archive.chatUsername,
        });

        db.insertOrUpdateMessage(archive.input, options?.isEdited ? "edit" : "new");
        this.runtimeStats.storedEvents += 1;
        this.runtimeStats.lastStoredAt = Date.now();
        this.runtimeStats.lastError = "";
      } finally {
        db.close();
      }
    } catch (error) {
      this.runtimeStats.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  private getBackfillDisplayStatus(record?: BackfillTargetRecord): string {
    if (!record) return "未抓取";
    if (record.status === "running") return "进行中";
    if (record.status === "failed") return "失败待恢复";
    if (record.status === "stopped") return "已停止待恢复";
    if (record.completedOnce) return "已完成";
    return "未抓取";
  }

  private formatBackfillTargetRef(target: { chatId: string; username?: string }): string {
    return target.username ? `@${target.username}` : target.chatId;
  }

  private async listAvailableBackfillDialogs(client: TelegramClient, db: ArchiveDB): Promise<BackfillDialogOption[]> {
    const dialogs: BackfillDialogOption[] = [];
    for await (const dialog of client.iterDialogs({})) {
      if (!dialog?.entity) continue;
      if (!dialog.isGroup && !dialog.isChannel) continue;
      const entity = dialog.entity as Api.Channel | Api.Chat;
      let chatType: ArchiveChatType = "group";
      if (entity instanceof Api.Channel) {
        chatType = entity.megagroup ? "supergroup" : "channel";
      }
      if (chatType === "channel") continue;
      const chatId = getMarkedPeerId(dialog.inputEntity)
        || getMarkedPeerId(entity)
        || toCanonicalChatId(chatType, dialog.id, entity.id);
      const chatIdCandidates = collectChatIdCandidates(chatType, chatId, dialog.id, entity.id);
      if (!chatId || db.isChatBlacklisted(chatIdCandidates)) continue;
      const title = String(dialog.title || dialog.name || entity.title || chatId);
      const username = entity instanceof Api.Channel && entity.username
        ? String(entity.username)
        : undefined;
      db.upsertBackfillTargetMeta({ chatId, title, username, chatType });
      dialogs.push({
        chatId,
        title,
        username,
        chatType,
        inputEntity: dialog.inputEntity || dialog.entity,
      });
    }
    return dialogs;
  }

  private async resolveBackfillDialog(
    client: TelegramClient,
    rawTarget: string,
    db: ArchiveDB
  ): Promise<BackfillDialogOption | undefined> {
    const normalized = rawTarget.trim().replace(/^@/, "").toLowerCase();
    const dialogs = await this.listAvailableBackfillDialogs(client, db);
    return dialogs.find((dialog) =>
      dialog.chatId === rawTarget
      || dialog.chatId === normalized
      || collectChatIdCandidates(dialog.chatType, dialog.chatId).includes(rawTarget.trim())
      || collectChatIdCandidates(dialog.chatType, dialog.chatId).includes(normalized)
      || dialog.username?.toLowerCase() === normalized
      || `@${dialog.username?.toLowerCase() || ""}` === `@${normalized}`
    );
  }

  private async handleStatus(msg: Api.Message): Promise<void> {
    const db = new ArchiveDB();
    try {
      const stats = db.getStats();
      const summary = db.getBackfillTargetSummary();
      const resumable = db.getLatestResumableBackfillTarget();
      const lines = [
        "🗃️ <b>Archive 状态</b>",
        "",
        `<b>聊天数:</b> ${stats.chats}`,
        `<b>消息数:</b> ${stats.messages}`,
        `<b>版本数:</b> ${stats.versions}`,
        `<b>已删除标记:</b> ${stats.deletedMessages}`,
        `<b>黑名单会话:</b> ${stats.blacklistedChats}`,
        `<b>DB 大小:</b> ${formatBytes(stats.dbSizeBytes)}`,
        "",
        "📡 <b>监听状态</b>",
        `<b>收到事件:</b> ${this.runtimeStats.seenEvents}`,
        `<b>入库事件:</b> ${this.runtimeStats.storedEvents}`,
        `<b>跳过事件:</b> ${this.runtimeStats.skippedEvents}`,
        `<b>最近收到:</b> ${this.runtimeStats.lastSeenAt ? formatTime(this.runtimeStats.lastSeenAt) : "暂无"}`,
        `<b>最近入库:</b> ${this.runtimeStats.lastStoredAt ? formatTime(this.runtimeStats.lastStoredAt) : "暂无"}`,
      ];

      if (this.runtimeStats.lastSkipReason) {
        lines.push(`<b>最近跳过原因:</b> ${htmlEscape(this.runtimeStats.lastSkipReason)}`);
      }
      if (this.runtimeStats.lastError) {
        lines.push(`<b>最近监听错误:</b> ${htmlEscape(this.runtimeStats.lastError)}`);
      }

      lines.push("");
      lines.push("🛠️ <b>Backfill 状态</b>");
      lines.push(`<b>已完成会话:</b> ${summary.completed}`);
      lines.push(`<b>进行中会话:</b> ${summary.running}`);
      lines.push(`<b>失败待恢复:</b> ${summary.failed}`);
      lines.push(`<b>停止待恢复:</b> ${summary.stopped}`);

      if (this.activeBackfill) {
        lines.push(
          `<b>当前运行:</b> ${htmlEscape(this.activeBackfill.title)} <code>${htmlEscape(this.activeBackfill.chatId)}</code>`
        );
        lines.push(`<b>运行中已处理消息:</b> ${this.activeBackfill.processedMessages}`);
      } else {
        lines.push("<b>当前运行:</b> 无");
      }

      if (resumable) {
        lines.push(
          `<b>最近可恢复:</b> ${htmlEscape(resumable.title)} <code>${htmlEscape(resumable.chatId)}</code> · ${htmlEscape(this.getBackfillDisplayStatus(resumable))}`
        );
        if (resumable.lastError) {
          lines.push(`<b>最近错误:</b> ${htmlEscape(resumable.lastError)}`);
        }
      }

      await msg.edit({ text: lines.join("\n"), parseMode: "html", linkPreview: false });
    } finally {
      db.close();
    }
  }

  private formatNormalizationStats(stats: ArchiveNormalizationStats): string {
    return [
      "✅ <b>Archive chatId 归一化完成</b>",
      "",
      `<b>别名映射:</b> ${stats.aliasMappings}`,
      `<b>聊天记录:</b> ${stats.chatsRewritten}`,
      `<b>黑名单:</b> ${stats.blacklistRewritten}`,
      `<b>Backfill 目标:</b> ${stats.backfillTargetsRewritten}`,
      `<b>Backfill Job 更新:</b> ${stats.backfillJobsUpdated}`,
      `<b>删除频道会话:</b> ${stats.droppedChannelChats}`,
      `<b>删除频道消息:</b> ${stats.droppedChannelMessages}`,
      `<b>删除频道版本:</b> ${stats.droppedChannelVersions}`,
      `<b>消息行:</b> ${stats.messageRowsRewritten}`,
      `<b>合并消息组:</b> ${stats.mergedMessageGroups}`,
      `<b>版本行:</b> ${stats.versionRowsRewritten}`,
    ].join("\n");
  }

  private async handleNormalize(msg: Api.Message): Promise<void> {
    if (this.backfillPromise || this.activeBackfill) {
      await msg.edit({ text: "❌ 当前有 backfill 正在运行，请先停止后再执行 normalize" });
      return;
    }

    await msg.edit({ text: "⏳ 正在从旧 DB 迁移到新 DB，请稍候..." }).catch(() => undefined);

    const db = new ArchiveDB();
    try {
      const stats = db.normalizeChatIds(new Map());
      await msg.edit({
        text: this.formatNormalizationStats(stats),
        parseMode: "html",
        linkPreview: false,
      });
    } catch (error) {
      await msg.edit({
        text: `❌ Archive 归一化失败\n${htmlEscape(extractErrorMessage(error))}`,
        parseMode: "html",
        linkPreview: false,
      }).catch(() => undefined);
      throw error;
    } finally {
      db.close();
    }
  }

  private async handleBackfill(msg: Api.Message, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase();

    if (!action || action === "list") {
      const pageRaw = action === "list" ? args[1] : args[0];
      await this.handleBackfillList(msg, pageRaw);
      return;
    }
    if (action === "run") {
      await this.handleBackfillRun(msg, args[1]);
      return;
    }
    if (action === "resume") {
      await this.handleBackfillResume(msg);
      return;
    }
    if (action === "stop") {
      await this.handleBackfillStop(msg);
      return;
    }

    if (/^\d+(d|h|min)$/i.test(action)) {
      await msg.edit({
        text: `❌ 已移除全量 backfill 模式\n请先用 <code>${commandName} backfill</code> 查看会话，再执行 <code>${commandName} backfill run &lt;chatId或@username&gt;</code>`,
        parseMode: "html",
      });
      return;
    }

    await msg.edit({ text: this.description, parseMode: "html", linkPreview: false });
  }

  private async handleBackfillList(msg: Api.Message, pageRaw?: string): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ Telegram 客户端未初始化" });
      return;
    }

    const page = Math.max(1, parseInt(pageRaw || "1", 10) || 1);
    const db = new ArchiveDB();
    try {
      const dialogs = await this.listAvailableBackfillDialogs(client, db);
      const statusMap = db.getBackfillTargetsMap();
      const totalPages = Math.max(1, Math.ceil(dialogs.length / BACKFILL_LIST_PAGE_SIZE));
      const safePage = Math.min(page, totalPages);
      const start = (safePage - 1) * BACKFILL_LIST_PAGE_SIZE;
      const items = dialogs.slice(start, start + BACKFILL_LIST_PAGE_SIZE);

      const lines = [
        "🧭 <b>Archive Backfill 列表</b>",
        `<b>页码:</b> ${safePage}/${totalPages}`,
        `<b>会话总数:</b> ${dialogs.length}`,
      ];

      if (this.activeBackfill) {
        lines.push(
          `<b>当前运行:</b> ${htmlEscape(this.activeBackfill.title)} <code>${htmlEscape(this.activeBackfill.chatId)}</code>`
        );
      }

      lines.push("");
      if (items.length === 0) {
        lines.push("暂无可补抓会话");
      } else {
        for (const [index, item] of items.entries()) {
          const status = statusMap.get(item.chatId);
          const ref = this.formatBackfillTargetRef(item);
          lines.push(
            `${start + index + 1}. <b>${htmlEscape(item.title)}</b> · <code>${htmlEscape(ref)}</code> · ${htmlEscape(this.getBackfillDisplayStatus(status))}`
          );
        }
      }

      lines.push("");
      lines.push(`运行: <code>${commandName} backfill run &lt;chatId或@username&gt;</code>`);
      if (safePage < totalPages) {
        lines.push(`下一页: <code>${commandName} backfill list ${safePage + 1}</code>`);
      }
      if (safePage > 1) {
        lines.push(`上一页: <code>${commandName} backfill list ${safePage - 1}</code>`);
      }

      await msg.edit({ text: lines.join("\n"), parseMode: "html", linkPreview: false });
    } finally {
      db.close();
    }
  }

  private async handleBackfillRun(msg: Api.Message, rawTarget?: string): Promise<void> {
    if (!rawTarget) {
      await msg.edit({
        text: `用法: <code>${commandName} backfill run &lt;chatId或@username&gt;</code>`,
        parseMode: "html",
      });
      return;
    }
    if (this.backfillPromise) {
      await msg.edit({ text: "⚠️ 当前已有会话 backfill 正在运行" });
      return;
    }
    if (!this.lifecycle) {
      await msg.edit({ text: "❌ Archive 插件生命周期尚未初始化" });
      return;
    }

    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ Telegram 客户端未初始化" });
      return;
    }

    const db = new ArchiveDB();
    try {
      const target = await this.resolveBackfillDialog(client, rawTarget, db);
      if (!target) {
        await msg.edit({
          text: `❌ 未找到可补抓会话: <code>${htmlEscape(rawTarget)}</code>\n请先用 <code>${commandName} backfill</code> 查看列表`,
          parseMode: "html",
        });
        return;
      }

      const existing = db.getBackfillTarget(target.chatId);
      await msg.edit({
        text: [
          `🔄 开始补抓会话 <b>${htmlEscape(target.title)}</b>`,
          `目标: <code>${htmlEscape(this.formatBackfillTargetRef(target))}</code>`,
          existing?.completedOnce ? "状态: 已抓取过，本次将重新扫描该会话" : "状态: 首次补抓",
        ].join("\n"),
        parseMode: "html",
      });

      this.startBackfillTarget(client, target, {
        resume: false,
        processedMessages: 0,
      });
    } finally {
      db.close();
    }
  }

  private async handleBackfillResume(msg: Api.Message): Promise<void> {
    if (this.backfillPromise) {
      await msg.edit({ text: "⚠️ 当前已有会话 backfill 正在运行" });
      return;
    }

    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ Telegram 客户端未初始化" });
      return;
    }

    const db = new ArchiveDB();
    try {
      const targetState = db.getLatestResumableBackfillTarget();
      if (!targetState || !["failed", "stopped", "running"].includes(targetState.status)) {
        await msg.edit({ text: "ℹ️ 没有可恢复的会话补抓任务" });
        return;
      }
      const target = await this.resolveBackfillDialog(client, targetState.chatId, db);
      if (!target) {
        await msg.edit({
          text: `❌ 无法恢复 <code>${htmlEscape(targetState.chatId)}</code>\n该会话当前不可见或已被黑名单排除`,
          parseMode: "html",
        });
        return;
      }

      await msg.edit({
        text: [
          `▶️ 恢复会话补抓 <b>${htmlEscape(target.title)}</b>`,
          `目标: <code>${htmlEscape(this.formatBackfillTargetRef(target))}</code>`,
          `断点消息: <code>${targetState.cursorMessageId || 0}</code>`,
        ].join("\n"),
        parseMode: "html",
      });

      this.startBackfillTarget(client, target, {
        resume: true,
        cursorMessageId: targetState.cursorMessageId,
        processedMessages: targetState.processedMessages,
      });
    } finally {
      db.close();
    }
  }

  private async handleBackfillStop(msg: Api.Message): Promise<void> {
    if (!this.backfillPromise || !this.backfillAbortController || !this.activeBackfill) {
      await msg.edit({ text: "ℹ️ 当前没有正在运行的会话补抓任务" });
      return;
    }

    const active = this.activeBackfill;
    this.backfillAbortController.abort(MANUAL_BACKFILL_STOP_REASON);

    try {
      await this.backfillPromise;
    } catch {
      // runSingleChatBackfill handles abort as a state transition.
    }

    await msg.edit({
      text: [
        `⏹️ 已停止会话补抓 <b>${htmlEscape(active.title)}</b>`,
        `可用 <code>${commandName} backfill resume</code> 继续该会话`,
      ].join("\n"),
      parseMode: "html",
    });
  }

  private async resumeBackfillIfNeeded(): Promise<void> {
    if (this.backfillPromise || !this.lifecycle) return;

    const client = await getGlobalClient().catch(() => null);
    if (!client) return;

    const db = new ArchiveDB();
    try {
      const targetState = db.getAutoResumableBackfillTarget();
      if (!targetState) return;
      const target = await this.resolveBackfillDialog(client, targetState.chatId, db);
      if (!target) {
        db.updateBackfillTarget(targetState.chatId, {
          status: "failed",
          lastBackfillFinishedAt: Date.now(),
          lastError: "自动续跑失败：会话当前不可见或已被黑名单排除",
        });
        return;
      }
      this.startBackfillTarget(client, target, {
        resume: true,
        cursorMessageId: targetState.cursorMessageId,
        processedMessages: targetState.processedMessages,
        automatic: true,
      });
    } finally {
      db.close();
    }
  }

  private startBackfillTarget(
    client: TelegramClient,
    target: BackfillDialogOption,
    options: {
      resume: boolean;
      cursorMessageId?: number;
      processedMessages: number;
      automatic?: boolean;
    }
  ): void {
    if (!this.lifecycle) {
      throw new Error("Archive 插件生命周期尚未初始化");
    }

    this.activeBackfill = {
      chatId: target.chatId,
      title: target.title,
      processedMessages: options.processedMessages,
      cursorMessageId: options.cursorMessageId,
    };
    this.backfillAbortController = new AbortController();
    this.backfillPromise = this.lifecycle.runTask(
      async (lifecycleSignal) => {
        const signal = AbortSignal.any([lifecycleSignal, this.backfillAbortController!.signal]);
        await this.runSingleChatBackfill(client, target, signal, options);
      },
      { label: `archive:backfill:${target.chatId}`, kind: "promise" }
    ).finally(() => {
      this.backfillPromise = null;
      this.activeBackfill = null;
      this.backfillAbortController = null;
    });
  }

  private async runSingleChatBackfill(
    client: TelegramClient,
    target: BackfillDialogOption,
    signal: AbortSignal,
    options: {
      resume: boolean;
      cursorMessageId?: number;
      processedMessages: number;
      automatic?: boolean;
    }
  ): Promise<void> {
    const db = new ArchiveDB();
    let processedMessages = options.processedMessages;
    let cursorMessageId = options.resume ? options.cursorMessageId : undefined;
    let lastMessageId = cursorMessageId || 0;

    try {
      db.upsertChat({
        chatId: target.chatId,
        chatType: target.chatType,
        title: target.title,
        username: target.username,
        lastSeenAt: Date.now(),
      });
      db.upsertBackfillTargetMeta({
        chatId: target.chatId,
        title: target.title,
        username: target.username,
        chatType: target.chatType,
      });
      db.updateBackfillTarget(target.chatId, {
        status: "running",
        processedMessages,
        cursorMessageId,
        lastBackfillStartedAt: Date.now(),
        lastBackfillFinishedAt: null,
        lastError: options.automatic ? "Archive 插件重载后自动续跑中" : null,
      });

      const iterOptions: { reverse: true; minId?: number } = { reverse: true };
      if (cursorMessageId) {
        iterOptions.minId = cursorMessageId;
      }

      while (true) {
        try {
          for await (const message of client.iterMessages(target.inputEntity, iterOptions)) {
            throwIfAborted(signal);
            const archive = await buildArchiveInput(message as Api.Message);
            if (!archive.input) continue;
            db.insertOrUpdateMessage(archive.input, "backfill");
            processedMessages += 1;
            lastMessageId = archive.input.messageId;
            cursorMessageId = archive.input.messageId;
            if (this.activeBackfill?.chatId === target.chatId) {
              this.activeBackfill.processedMessages = processedMessages;
              this.activeBackfill.cursorMessageId = cursorMessageId;
            }

            if (processedMessages % BACKFILL_BATCH_SIZE === 0) {
              db.updateBackfillTarget(target.chatId, {
                status: "running",
                processedMessages,
                cursorMessageId,
                lastError: null,
              });
              await this.requireLifecycle().delay(BACKFILL_BATCH_PAUSE_MS, {
                label: `archive:backfill-batch-pause:${target.chatId}`,
              });
            }
          }
          break;
        } catch (error) {
          const floodWaitMs = getFloodWaitMs(error);
          if (floodWaitMs === null) {
            throw error;
          }
          db.updateBackfillTarget(target.chatId, {
            status: "running",
            processedMessages,
            cursorMessageId: lastMessageId || undefined,
            lastError: `FloodWait ${Math.ceil(floodWaitMs / 1000)}s，等待后继续`,
          });
          if (lastMessageId > 0) {
            iterOptions.minId = lastMessageId;
          }
          await this.requireLifecycle().delay(floodWaitMs, {
            label: `archive:backfill-floodwait:${target.chatId}`,
          });
        }
      }

      db.updateBackfillTarget(target.chatId, {
        status: "completed",
        completedOnce: true,
        processedMessages,
        cursorMessageId,
        lastBackfillFinishedAt: Date.now(),
        lastError: null,
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        this.markBackfillAborted(db, {
          chatId: target.chatId,
          title: target.title,
          cursorMessageId,
          processedMessages,
        }, signal.reason);
        return;
      }
      db.updateBackfillTarget(target.chatId, {
        status: "failed",
        processedMessages,
        cursorMessageId,
        lastBackfillFinishedAt: Date.now(),
        lastError: extractErrorMessage(error),
      });
      throw error;
    } finally {
      db.close();
    }
  }

  private async handleBlacklist(msg: Api.Message, args: string[]): Promise<void> {
    const action = args[0]?.toLowerCase() || "add";
    const db = new ArchiveDB();
    try {
      if (action === "list") {
        const rows = db.listBlacklistedChats();
        if (rows.length === 0) {
          await msg.edit({ text: "🧾 黑名单为空" });
          return;
        }

        const lines = ["🧾 <b>Archive 黑名单</b>", ""];
        for (const [index, row] of rows.entries()) {
          const title = row.username
            ? `${row.title} (@${row.username})`
            : row.title;
          lines.push(
            `${index + 1}. <b>${htmlEscape(title)}</b> <code>${htmlEscape(row.chatId)}</code>`
          );
        }
        await msg.edit({ text: lines.join("\n"), parseMode: "html", linkPreview: false });
        return;
      }

      const chat = await resolveChatContext(msg);
      if (!chat.chatId || !chat.chatTitle) {
        await msg.edit({ text: "❌ 当前消息不在群组/频道中，无法操作黑名单" });
        return;
      }

      if (action === "rm" || action === "remove" || action === "del") {
        const removed = db.removeChatBlacklist(
          collectChatIdCandidates(chat.chatType, chat.chatId, chat.chatEntity?.id)
        );
        await msg.edit({
          text: removed
            ? `✅ 已将 <b>${htmlEscape(chat.chatTitle)}</b> 移出 Archive 黑名单`
            : `ℹ️ <b>${htmlEscape(chat.chatTitle)}</b> 不在 Archive 黑名单中`,
          parseMode: "html",
          linkPreview: false,
        });
        return;
      }

      db.addChatBlacklist({
        chatId: chat.chatId,
        title: chat.chatTitle,
        username: chat.chatUsername,
        matchChatIds: collectChatIdCandidates(chat.chatType, chat.chatId, chat.chatEntity?.id),
      });
      await msg.edit({
        text: `✅ 已将 <b>${htmlEscape(chat.chatTitle)}</b> 加入 Archive 黑名单\n后续将不再采集，搜索结果也会忽略该会话历史消息。`,
        parseMode: "html",
        linkPreview: false,
      });
    } finally {
      db.close();
    }
  }

  private async handleSearch(msg: Api.Message, args: string[]): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ Telegram 客户端未初始化" });
      return;
    }

    const filters = parseCommandFilters(args);
    await this.runSearch(msg, client, filters, "search");
  }

  private async handleChatSearch(msg: Api.Message, args: string[]): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ Telegram 客户端未初始化" });
      return;
    }
    const [chatTarget, ...rest] = args;
    if (!chatTarget) {
      await msg.edit({ text: `用法: <code>${commandName} chat @chat或chatId [关键词] [from=YYYY-MM-DD] [to=YYYY-MM-DD] [limit=10]</code>`, parseMode: "html" });
      return;
    }
    const filters = parseCommandFilters(rest);
    filters.chat = chatTarget;
    await this.runSearch(msg, client, filters, "chat");
  }

  private async handleUserSearch(msg: Api.Message, args: string[]): Promise<void> {
    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ Telegram 客户端未初始化" });
      return;
    }
    const [userTarget, ...rest] = args;
    if (!userTarget) {
      await msg.edit({ text: `用法: <code>${commandName} user @user或userId [关键词] [chat=@chat] [from=YYYY-MM-DD] [to=YYYY-MM-DD] [limit=10]</code>`, parseMode: "html" });
      return;
    }
    const filters = parseCommandFilters(rest);
    filters.user = userTarget;
    await this.runSearch(msg, client, filters, "user");
  }

  private async runSearch(
    msg: Api.Message,
    client: TelegramClient,
    filters: CommandFilters,
    mode: "search" | "chat" | "user"
  ): Promise<void> {
    const db = new ArchiveDB();
    try {
      const limit = Math.min(Math.max(filters.limit || 10, 1), MAX_RESULT_COUNT);
      const chatId = await resolveChatIdFilter(client, filters.chat);
      const senderId = await resolveUserIdFilter(client, filters.user);
      const fromTs = parseDateInput(filters.from, false);
      const toTs = parseDateInput(filters.to, true);

      if (filters.from && !fromTs) {
        await msg.edit({ text: "❌ `from=` 日期格式错误，应为 YYYY-MM-DD", parseMode: "markdown" }).catch(() => undefined);
        return;
      }
      if (filters.to && !toTs) {
        await msg.edit({ text: "❌ `to=` 日期格式错误，应为 YYYY-MM-DD", parseMode: "markdown" }).catch(() => undefined);
        return;
      }
      if (mode === "search" && !filters.keyword) {
        await msg.edit({
          text: `用法: <code>${commandName} search 关键词 [chat=@xxx] [user=@xxx] [from=YYYY-MM-DD] [to=YYYY-MM-DD] [limit=10]</code>`,
          parseMode: "html",
        });
        return;
      }

      const rows = db.searchMessages({
        keyword: filters.keyword,
        chatId,
        senderId,
        fromTs,
        toTs,
        limit,
      });

      if (rows.length === 0) {
        await msg.edit({ text: "🔍 未找到匹配消息" });
        return;
      }

      const header = [
        "🔎 <b>Archive 查询结果</b>",
        `<b>结果数:</b> ${rows.length}`,
      ];
      if (filters.keyword) header.push(`<b>关键词:</b> ${htmlEscape(filters.keyword)}`);
      if (filters.chat) header.push(`<b>聊天过滤:</b> ${htmlEscape(filters.chat)}`);
      if (filters.user) header.push(`<b>用户过滤:</b> ${htmlEscape(filters.user)}`);
      if (filters.from) header.push(`<b>开始:</b> ${htmlEscape(filters.from)}`);
      if (filters.to) header.push(`<b>结束:</b> ${htmlEscape(filters.to)}`);

      const lines = rows.map((row, index) => {
        const summary = compact(row.rawText || row.caption || `[${row.messageType}]`);
        const prefix = `${index + 1}. <code>${htmlEscape(formatTime(row.date))}</code> <b>${htmlEscape(
          row.chatId
        )}</b> · ${htmlEscape(row.senderId || "unknown")}`;
        if (row.link) {
          return `${prefix}\n<a href="${htmlEscape(row.link)}">${htmlEscape(summary)}</a>`;
        }
        return `${prefix}\n${htmlEscape(summary)}`;
      });

      const chunks: string[] = [];
      let currentLines: string[] = [];
      let currentHeader = header.join("\n");
      for (const line of lines) {
        const candidateLines = [...currentLines, line];
        const candidate = `${currentHeader}\n\n${buildExpandableBlockquote(candidateLines)}`;
        if (candidate.length > MAX_CHUNK_LENGTH && currentLines.length > 0) {
          chunks.push(`${currentHeader}\n\n${buildExpandableBlockquote(currentLines)}`);
          currentHeader = "🔎 <b>Archive 查询结果</b>（续）";
          currentLines = [line];
        } else {
          currentLines = candidateLines;
        }
      }
      if (currentLines.length > 0) {
        chunks.push(`${currentHeader}\n\n${buildExpandableBlockquote(currentLines)}`);
      }

      await msg.edit({ text: chunks[0], parseMode: "html", linkPreview: false });
      for (let i = 1; i < chunks.length; i += 1) {
        await client.sendMessage(msg.peerId, {
          message: chunks[i],
          parseMode: "html",
          linkPreview: false,
        });
      }
    } finally {
      db.close();
    }
  }

  private requireLifecycle(): GenerationContext {
    if (!this.lifecycle) {
      throw new Error("Archive 插件生命周期尚未初始化");
    }
    return this.lifecycle;
  }

  private markBackfillAborted(
    db: ArchiveDB,
    context: BackfillAbortContext,
    reason?: unknown
  ): void {
    const isManualStop = reason === MANUAL_BACKFILL_STOP_REASON;
    db.updateBackfillTarget(context.chatId, {
      status: isManualStop ? "stopped" : "failed",
      title: context.title,
      cursorMessageId: context.cursorMessageId,
      processedMessages: context.processedMessages,
      lastBackfillFinishedAt: Date.now(),
      lastError: extractErrorMessage(
        reason || (isManualStop ? MANUAL_BACKFILL_STOP_REASON : "Runtime reload aborted archive backfill")
      ),
    });
  }
}

export default new ArchivePlugin();
