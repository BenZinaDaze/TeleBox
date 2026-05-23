import { Plugin, type PluginRuntimeContext } from "@utils/pluginBase";
import { getPrefixes } from "@utils/pluginManager";
import { getGlobalClient } from "@utils/globalClient";
import { safeGetMe } from "@utils/authGuards";
import type { GenerationContext } from "@utils/generationContext";
import Database from "better-sqlite3";
import path from "path";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { Api, TelegramClient } from "teleproto";

const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";
const pluginName = "archive";
const commandName = `${mainPrefix}${pluginName}`;
const MAX_RESULT_COUNT = 20;
const MAX_CHUNK_LENGTH = 3500;
const BACKFILL_WAIT_TIME_SECONDS = 1;
const BACKFILL_BATCH_SIZE = 100;
const BACKFILL_BATCH_PAUSE_MS = 2000;
const BACKFILL_DIALOG_PAUSE_MS = 1500;
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

type BackfillAbortContext = {
  jobId: number;
  processedChats: number;
  processedMessages: number;
  currentChatId?: string;
  currentChatTitle?: string;
  cursorMessageId?: number;
};

type ArchiveChatType = "group" | "supergroup" | "channel";

interface ArchiveMessageInput {
  chatId: string;
  messageId: number;
  senderId?: string;
  senderDisplay?: string;
  date: number;
  rawText: string;
  textNormalized: string;
  messageType: string;
  caption?: string;
  replyToMsgId?: number;
  groupedId?: string;
  link?: string;
}

interface ArchiveSearchParams {
  keyword?: string;
  chatId?: string;
  senderId?: string;
  fromTs?: number;
  toTs?: number;
  limit: number;
}

interface ArchiveSearchRow {
  chatId: string;
  messageId: number;
  senderId?: string;
  senderDisplay?: string;
  chatTitle: string;
  chatUsername?: string;
  date: number;
  rawText: string;
  textNormalized: string;
  messageType: string;
  caption?: string;
  link?: string;
  latestVersion: number;
  isDeleted: number;
}

interface ArchiveStats {
  chats: number;
  users: number;
  messages: number;
  versions: number;
  deletedMessages: number;
  blacklistedChats: number;
  dbSizeBytes: number;
}

interface BackfillJobRecord {
  id: number;
  status: string;
  windowSpec?: string;
  startedAt: number;
  finishedAt?: number | null;
  currentChatId?: string;
  currentChatTitle?: string;
  cursorMessageId?: number;
  processedChats: number;
  processedMessages: number;
  lastError?: string | null;
}

interface BackfillResumeState {
  currentChatId?: string;
  cursorMessageId?: number;
  processedChats: number;
  processedMessages: number;
}

type ExistingMessageRow = {
  id: number;
  latest_version: number;
  raw_text: string;
  text_normalized: string;
  caption: string | null;
  sender_id: string | null;
  sender_display: string | null;
  message_type: string;
  date: number;
  reply_to_msg_id: number | null;
  grouped_id: string | null;
  link: string | null;
  is_deleted: number;
};

class ArchiveDB {
  private db: Database.Database;

  constructor(
    dbPath: string = path.join(createDirectoryInAssets("archive"), "archive.db")
  ) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        chat_id TEXT PRIMARY KEY,
        chat_type TEXT NOT NULL,
        title TEXT NOT NULL,
        username TEXT,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT,
        display_name TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        sender_id TEXT,
        sender_display TEXT,
        date INTEGER NOT NULL,
        raw_text TEXT NOT NULL,
        text_normalized TEXT NOT NULL,
        message_type TEXT NOT NULL,
        caption TEXT,
        reply_to_msg_id INTEGER,
        grouped_id TEXT,
        link TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        latest_version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(chat_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS message_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_row_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        raw_text TEXT NOT NULL,
        text_normalized TEXT NOT NULL,
        caption TEXT,
        edited_at INTEGER NOT NULL,
        edit_source TEXT NOT NULL,
        UNIQUE(message_row_id, version)
      );

      CREATE TABLE IF NOT EXISTS backfill_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        status TEXT NOT NULL,
        window_spec TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        current_chat_id TEXT,
        current_chat_title TEXT,
        cursor_message_id INTEGER,
        processed_chats INTEGER NOT NULL DEFAULT 0,
        processed_messages INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS archive_blacklist (
        chat_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        username TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_date ON messages(chat_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_sender_date ON messages(sender_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date DESC);
      CREATE INDEX IF NOT EXISTS idx_versions_message_version ON message_versions(message_row_id, version DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        search_text,
        tokenize='trigram'
      );
    `);
    const columns = this.db.prepare(`PRAGMA table_info(backfill_jobs)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "window_spec")) {
      this.db.exec(`ALTER TABLE backfill_jobs ADD COLUMN window_spec TEXT`);
    }
  }

  private buildSearchText(input: ArchiveMessageInput): string {
    return [
      input.textNormalized,
      input.caption || "",
      input.senderDisplay || "",
      input.messageType || "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  public upsertChat(record: {
    chatId: string;
    chatType: ArchiveChatType;
    title: string;
    username?: string;
    lastSeenAt: number;
  }): void {
    this.db
      .prepare(`
        INSERT INTO chats (chat_id, chat_type, title, username, last_seen_at)
        VALUES (@chatId, @chatType, @title, @username, @lastSeenAt)
        ON CONFLICT(chat_id) DO UPDATE SET
          chat_type = excluded.chat_type,
          title = excluded.title,
          username = excluded.username,
          last_seen_at = excluded.last_seen_at
      `)
      .run(record);
  }

  public upsertUser(record: {
    userId: string;
    username?: string;
    displayName: string;
    lastSeenAt: number;
  }): void {
    this.db
      .prepare(`
        INSERT INTO users (user_id, username, display_name, last_seen_at)
        VALUES (@userId, @username, @displayName, @lastSeenAt)
        ON CONFLICT(user_id) DO UPDATE SET
          username = excluded.username,
          display_name = excluded.display_name,
          last_seen_at = excluded.last_seen_at
      `)
      .run(record);
  }

  public insertOrUpdateMessage(
    input: ArchiveMessageInput,
    editSource: "new" | "edit" | "backfill" = "new"
  ): { inserted: boolean; updated: boolean; version: number } {
    const now = Date.now();
    const existing = this.db
      .prepare<[string, number], ExistingMessageRow>(`
        SELECT *
        FROM messages
        WHERE chat_id = ? AND message_id = ?
      `)
      .get(input.chatId, input.messageId);

    if (!existing) {
      const result = this.db
        .prepare(`
          INSERT INTO messages (
            chat_id, message_id, sender_id, sender_display, date,
            raw_text, text_normalized, message_type, caption,
            reply_to_msg_id, grouped_id, link, is_deleted, latest_version,
            created_at, updated_at
          ) VALUES (
            @chatId, @messageId, @senderId, @senderDisplay, @date,
            @rawText, @textNormalized, @messageType, @caption,
            @replyToMsgId, @groupedId, @link, 0, 1,
            @createdAt, @updatedAt
          )
        `)
        .run({
          ...input,
          createdAt: now,
          updatedAt: now,
        });

      const rowId = Number(result.lastInsertRowid);
      this.db
        .prepare(`
          INSERT INTO message_versions (
            message_row_id, version, raw_text, text_normalized, caption, edited_at, edit_source
          ) VALUES (?, 1, ?, ?, ?, ?, ?)
        `)
        .run(
          rowId,
          input.rawText,
          input.textNormalized,
          input.caption || null,
          now,
          editSource
        );

      this.replaceFtsRow(rowId, this.buildSearchText(input));
      return { inserted: true, updated: false, version: 1 };
    }

    const changed =
      existing.raw_text !== input.rawText ||
      existing.text_normalized !== input.textNormalized ||
      (existing.caption || "") !== (input.caption || "") ||
      (existing.sender_id || "") !== (input.senderId || "") ||
      (existing.sender_display || "") !== (input.senderDisplay || "") ||
      existing.message_type !== input.messageType ||
      existing.date !== input.date ||
      (existing.reply_to_msg_id || 0) !== (input.replyToMsgId || 0) ||
      (existing.grouped_id || "") !== (input.groupedId || "") ||
      (existing.link || "") !== (input.link || "") ||
      existing.is_deleted !== 0;

    const nextVersion = changed ? existing.latest_version + 1 : existing.latest_version;

    this.db
      .prepare(`
        UPDATE messages
        SET sender_id = @senderId,
            sender_display = @senderDisplay,
            date = @date,
            raw_text = @rawText,
            text_normalized = @textNormalized,
            message_type = @messageType,
            caption = @caption,
            reply_to_msg_id = @replyToMsgId,
            grouped_id = @groupedId,
            link = @link,
            is_deleted = 0,
            latest_version = @latestVersion,
            updated_at = @updatedAt
        WHERE id = @id
      `)
      .run({
        ...input,
        id: existing.id,
        latestVersion: nextVersion,
        updatedAt: now,
      });

    if (changed) {
      this.db
        .prepare(`
          INSERT INTO message_versions (
            message_row_id, version, raw_text, text_normalized, caption, edited_at, edit_source
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          existing.id,
          nextVersion,
          input.rawText,
          input.textNormalized,
          input.caption || null,
          now,
          editSource
        );
      this.replaceFtsRow(existing.id, this.buildSearchText(input));
    }

    return { inserted: false, updated: changed, version: nextVersion };
  }

  public markMessageDeleted(chatId: string, messageId: number): void {
    const row = this.db
      .prepare<[string, number], { id: number }>(`
        SELECT id
        FROM messages
        WHERE chat_id = ? AND message_id = ?
      `)
      .get(chatId, messageId);

    if (!row) return;

    this.db
      .prepare(`
        UPDATE messages
        SET is_deleted = 1, updated_at = ?
        WHERE id = ?
      `)
      .run(Date.now(), row.id);
    this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(row.id);
  }

  private replaceFtsRow(rowId: number, searchText: string): void {
    this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(rowId);
    this.db
      .prepare(`INSERT INTO messages_fts(rowid, search_text) VALUES (?, ?)`)
      .run(rowId, searchText);
  }

  public createBackfillJob(windowSpec?: string): number {
    const result = this.db
      .prepare(`
        INSERT INTO backfill_jobs (status, window_spec, started_at)
        VALUES ('running', ?, ?)
      `)
      .run(windowSpec || null, Date.now());
    return Number(result.lastInsertRowid);
  }

  public updateBackfillJob(jobId: number, patch: Partial<BackfillJobRecord>): void {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    const mapping: Record<string, string> = {
      status: "status",
      finishedAt: "finished_at",
      currentChatId: "current_chat_id",
      currentChatTitle: "current_chat_title",
      cursorMessageId: "cursor_message_id",
      processedChats: "processed_chats",
      processedMessages: "processed_messages",
      lastError: "last_error",
    };

    for (const [key, column] of Object.entries(mapping)) {
      const value = patch[key as keyof BackfillJobRecord];
      if (value !== undefined) {
        fields.push(`${column} = ?`);
        values.push(value as string | number | null);
      }
    }

    if (fields.length === 0) return;
    values.push(jobId);
    this.db.prepare(`UPDATE backfill_jobs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  public getLatestBackfillJob(): BackfillJobRecord | undefined {
    return this.db
      .prepare<[], BackfillJobRecord>(`
        SELECT
          id,
          status,
          window_spec AS windowSpec,
          started_at AS startedAt,
          finished_at AS finishedAt,
          current_chat_id AS currentChatId,
          current_chat_title AS currentChatTitle,
          cursor_message_id AS cursorMessageId,
          processed_chats AS processedChats,
          processed_messages AS processedMessages,
          last_error AS lastError
        FROM backfill_jobs
        ORDER BY id DESC
        LIMIT 1
      `)
      .get();
  }

  public getLatestResumableBackfillJob(): BackfillJobRecord | undefined {
    return this.db
      .prepare<[], BackfillJobRecord>(`
        SELECT
          id,
          status,
          window_spec AS windowSpec,
          started_at AS startedAt,
          finished_at AS finishedAt,
          current_chat_id AS currentChatId,
          current_chat_title AS currentChatTitle,
          cursor_message_id AS cursorMessageId,
          processed_chats AS processedChats,
          processed_messages AS processedMessages,
          last_error AS lastError
        FROM backfill_jobs
        WHERE status IN ('running', 'aborted')
        ORDER BY id DESC
        LIMIT 1
      `)
      .get();
  }

  public getStats(): ArchiveStats {
    const chats = this.db.prepare(`SELECT COUNT(*) AS count FROM chats`).get() as { count: number };
    const users = this.db.prepare(`SELECT COUNT(*) AS count FROM users`).get() as { count: number };
    const messages = this.db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number };
    const versions = this.db.prepare(`SELECT COUNT(*) AS count FROM message_versions`).get() as { count: number };
    const deleted = this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE is_deleted = 1`).get() as {
      count: number;
    };
    const blacklisted = this.db.prepare(`SELECT COUNT(*) AS count FROM archive_blacklist`).get() as {
      count: number;
    };
    const pageCount = this.db.pragma("page_count", { simple: true }) as number;
    const pageSize = this.db.pragma("page_size", { simple: true }) as number;

    return {
      chats: chats.count,
      users: users.count,
      messages: messages.count,
      versions: versions.count,
      deletedMessages: deleted.count,
      blacklistedChats: blacklisted.count,
      dbSizeBytes: pageCount * pageSize,
    };
  }

  public searchMessages(params: ArchiveSearchParams): ArchiveSearchRow[] {
    const where: string[] = [
      `m.is_deleted = 0`,
      `NOT EXISTS (SELECT 1 FROM archive_blacklist bl WHERE bl.chat_id = m.chat_id)`,
    ];
    const values: Array<string | number> = [];
    let fromClause = `messages m`;

    if (params.keyword) {
      const keyword = params.keyword.trim();
      if (keyword.length >= 3) {
        fromClause = `messages_fts f JOIN messages m ON m.id = f.rowid`;
        where.push(`f.search_text MATCH ?`);
        values.push(keyword);
      } else {
        where.push(`m.text_normalized LIKE ?`);
        values.push(`%${keyword}%`);
      }
    }

    if (params.chatId) {
      where.push(`m.chat_id = ?`);
      values.push(params.chatId);
    }
    if (params.senderId) {
      where.push(`m.sender_id = ?`);
      values.push(params.senderId);
    }
    if (params.fromTs) {
      where.push(`m.date >= ?`);
      values.push(params.fromTs);
    }
    if (params.toTs) {
      where.push(`m.date <= ?`);
      values.push(params.toTs);
    }

    values.push(params.limit);
    return this.db.prepare(`
      SELECT
        m.chat_id AS chatId,
        m.message_id AS messageId,
        m.sender_id AS senderId,
        m.sender_display AS senderDisplay,
        c.title AS chatTitle,
        c.username AS chatUsername,
        m.date,
        m.raw_text AS rawText,
        m.text_normalized AS textNormalized,
        m.message_type AS messageType,
        m.caption,
        m.link,
        m.latest_version AS latestVersion,
        m.is_deleted AS isDeleted
      FROM ${fromClause}
      LEFT JOIN chats c ON c.chat_id = m.chat_id
      WHERE ${where.join(" AND ")}
      ORDER BY m.date DESC
      LIMIT ?
    `).all(...values) as ArchiveSearchRow[];
  }

  public close(): void {
    this.db.close();
  }

  public isChatBlacklisted(chatId: string): boolean {
    const row = this.db
      .prepare<[string], { found: number }>(`
        SELECT 1 AS found
        FROM archive_blacklist
        WHERE chat_id = ?
        LIMIT 1
      `)
      .get(chatId);
    return !!row;
  }

  public addChatBlacklist(record: {
    chatId: string;
    title: string;
    username?: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO archive_blacklist (chat_id, title, username, created_at)
        VALUES (@chatId, @title, @username, @createdAt)
        ON CONFLICT(chat_id) DO UPDATE SET
          title = excluded.title,
          username = excluded.username
      `)
      .run({
        ...record,
        createdAt: Date.now(),
      });
  }

  public removeChatBlacklist(chatId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM archive_blacklist WHERE chat_id = ?`)
      .run(chatId);
    return result.changes > 0;
  }

  public listBlacklistedChats(): Array<{
    chatId: string;
    title: string;
    username?: string;
    createdAt: number;
  }> {
    return this.db
      .prepare<[], {
        chatId: string;
        title: string;
        username?: string;
        createdAt: number;
      }>(`
        SELECT
          chat_id AS chatId,
          title,
          username,
          created_at AS createdAt
        FROM archive_blacklist
        ORDER BY created_at DESC
      `)
      .all();
  }
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

function normalizeText(text: string): string {
  return text
    .replace(/\s*\r?\n\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (
    typeof value === "object"
    && value
    && typeof (value as { toString?: () => string }).toString === "function"
  ) {
    const stringified = (value as { toString: () => string }).toString();
    if (stringified && stringified !== "[object Object]") {
      return stringified;
    }
  }
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["userId", "chatId", "channelId", "senderId", "id"]) {
    const nested = normalizeId(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

function getDateNumber(input: unknown): number {
  if (input instanceof Date) return input.getTime();
  if (typeof input === "number") return input > 10_000_000_000 ? input : input * 1000;
  if (typeof input === "bigint") return Number(input) * 1000;
  return Date.now();
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

function getFloodWaitMs(error: unknown): number | null {
  const message = extractErrorMessage(error);
  const match = /FLOOD(?:_PREMIUM)?_WAIT_(\d+)/.exec(message) || /A wait of (\d+) seconds/i.exec(message);
  if (!match) return null;
  const seconds = parseInt(match[1], 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return (seconds + 1) * 1000;
}

function parseBackfillWindowSpec(input?: string): { windowSpec?: string; cutoffTs?: number } {
  if (!input) return {};
  const match = /^(\d+)(d|h|min)$/.exec(input.trim());
  if (!match) {
    throw new Error(
      `时间窗口格式错误: ${input}\n支持格式: 3d / 5h / 10min\n示例: ${commandName} backfill 1d`
    );
  }

  const amount = parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `时间窗口格式错误: ${input}\n数值必须大于 0，支持格式: 3d / 5h / 10min`
    );
  }

  const unit = match[2];
  let durationMs = 0;
  if (unit === "d") durationMs = amount * 24 * 60 * 60 * 1000;
  else if (unit === "h") durationMs = amount * 60 * 60 * 1000;
  else durationMs = amount * 60 * 1000;

  return {
    windowSpec: `${amount}${unit}`,
    cutoffTs: Date.now() - durationMs,
  };
}

function buildEntityDisplay(entity: any, fallback: string): string {
  const parts: string[] = [];
  if (entity?.title) parts.push(String(entity.title));
  if (entity?.firstName) parts.push(String(entity.firstName));
  if (entity?.lastName) parts.push(String(entity.lastName));
  if (entity?.username) parts.push(`@${entity.username}`);
  if (parts.length === 0 && entity?.id !== undefined && entity?.id !== null) {
    parts.push(String(entity.id));
  }
  return parts.join(" ").trim() || fallback;
}

function buildMessageLink(chatEntity: any, messageId: number): string | undefined {
  if (!messageId) return undefined;
  if (chatEntity?.username) return `https://t.me/${chatEntity.username}/${messageId}`;
  if (chatEntity instanceof Api.Channel && chatEntity?.id) {
    return `https://t.me/c/${chatEntity.id}/${messageId}`;
  }
  return undefined;
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

function isBackfillStatusNote(message?: string | null): boolean {
  if (!message) return false;
  return message === "Archive 插件重载后自动续跑中"
    || message === "手动恢复补抓中";
}

async function ensureSelfInvocation(
  msg: Api.Message,
  ownerIdCacheRef: { current: string | null }
): Promise<boolean> {
  if (msg.out) return true;
  if (!msg.client) return false;

  if (!ownerIdCacheRef.current) {
    const me = await safeGetMe(msg.client);
    ownerIdCacheRef.current = normalizeId(me?.id) || "";
  }

  const senderId = normalizeId((msg as Api.Message & { senderId?: unknown }).senderId)
    || normalizeId((msg as Api.Message & { fromId?: unknown }).fromId);
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
  return normalizeId(entity?.id);
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
  return normalizeId(entity?.id);
}

function describeServiceMessage(message: any): string {
  const actionName = String(message?.action?.className || "")
    .replace(/^MessageAction/, "")
    .trim();
  return actionName ? `[服务消息:${actionName}]` : "[服务消息]";
}

function describeDocumentMessage(message: any): string {
  const attributes = Array.isArray(message?.document?.attributes) ? message.document.attributes : [];
  if (attributes.some((attr: any) => attr instanceof Api.DocumentAttributeSticker)) return "[贴纸]";
  if (attributes.some((attr: any) => attr instanceof Api.DocumentAttributeAnimated)) return "[动图]";
  if (
    attributes.some((attr: any) => attr instanceof Api.DocumentAttributeAudio && Boolean(attr.voice))
  ) {
    return "[语音]";
  }
  if (attributes.some((attr: any) => attr instanceof Api.DocumentAttributeAudio)) return "[音频]";
  if (attributes.some((attr: any) => attr instanceof Api.DocumentAttributeVideo)) return "[视频]";
  return "[文档]";
}

function buildMessageText(message: any): { rawText: string; messageType: string; caption?: string } {
  const rawText = String(message?.message || message?.text || "").trim();

  if (message?.className === "MessageService") {
    const text = rawText || describeServiceMessage(message);
    return { rawText: text, messageType: "service" };
  }

  let placeholder = "";
  let messageType = "text";

  if (message?.photo) {
    placeholder = "[图片]";
    messageType = "photo";
  } else if (message?.video) {
    placeholder = "[视频]";
    messageType = "video";
  } else if (message?.voice) {
    placeholder = "[语音]";
    messageType = "voice";
  } else if (message?.audio) {
    placeholder = "[音频]";
    messageType = "audio";
  } else if (message?.sticker) {
    placeholder = "[贴纸]";
    messageType = "sticker";
  } else if (message?.document) {
    placeholder = describeDocumentMessage(message);
    messageType = "document";
  } else if (message?.poll) {
    placeholder = "[投票]";
    messageType = "poll";
  } else if (message?.contact) {
    placeholder = "[联系人]";
    messageType = "contact";
  } else if (message?.location || message?.venue) {
    placeholder = "[位置]";
    messageType = "location";
  } else if (message?.media) {
    placeholder = "[媒体消息]";
    messageType = "media";
  }

  if (rawText && placeholder) {
    return { rawText: `${placeholder} ${rawText}`, messageType, caption: rawText };
  }
  if (rawText) return { rawText, messageType };
  if (placeholder) return { rawText: placeholder, messageType };
  return { rawText: "[空消息]", messageType: "empty" };
}

async function resolveChatContext(message: Api.Message): Promise<{
  chatId?: string;
  chatType?: ArchiveChatType;
  chatTitle?: string;
  chatUsername?: string;
  chatEntity?: any;
}> {
  if (message.isPrivate) return {};
  if (!message.isGroup && !message.isChannel) return {};

  let chat: any;
  try {
    chat = await message.getChat();
  } catch {
    chat = undefined;
  }

  const chatId =
    normalizeId(message.chatId)
    || normalizeId(chat?.id)
    || normalizeId(message.inputChat);
  if (!chatId) return {};

  let chatType: ArchiveChatType | undefined;
  if (chat instanceof Api.Channel) {
    chatType = chat.megagroup ? "supergroup" : "channel";
  } else if (chat instanceof Api.Chat) {
    chatType = "group";
  } else if (message.isChannel) {
    chatType = "channel";
  } else if (message.isGroup) {
    chatType = "group";
  }
  if (!chatType) return {};

  return {
    chatId,
    chatType,
    chatTitle: String(chat?.title || chat?.username || chatId),
    chatUsername: chat?.username ? String(chat.username) : undefined,
    chatEntity: chat,
  };
}

async function resolveSenderContext(message: Api.Message): Promise<{
  senderId?: string;
  senderDisplay?: string;
  senderUsername?: string;
}> {
  let sender: any;
  try {
    sender = await message.getSender();
  } catch {
    sender = undefined;
  }

  const senderId = normalizeId(message.senderId) || normalizeId(sender?.id);

  const senderDisplay = sender
    ? buildEntityDisplay(sender, senderId || "unknown")
    : String((message as any).postAuthor || senderId || "unknown");
  const senderUsername = sender?.username ? String(sender.username) : undefined;

  return { senderId, senderDisplay, senderUsername };
}

async function buildArchiveInput(message: Api.Message): Promise<{
  chatType?: ArchiveChatType;
  chatTitle?: string;
  chatUsername?: string;
  senderUsername?: string;
  input?: ArchiveMessageInput;
}> {
  const chat = await resolveChatContext(message);
  if (!chat.chatId || !chat.chatType || !chat.chatTitle) return {};

  const sender = await resolveSenderContext(message);
  const text = buildMessageText(message);
  const messageId = Number((message as any).id);
  if (!messageId) return {};

  return {
    chatType: chat.chatType,
    chatTitle: chat.chatTitle,
    chatUsername: chat.chatUsername,
    senderUsername: sender.senderUsername,
    input: {
      chatId: chat.chatId,
      messageId,
      senderId: sender.senderId,
      senderDisplay: sender.senderDisplay,
      date: getDateNumber((message as any).date),
      rawText: text.rawText,
      textNormalized: normalizeText(text.rawText),
      messageType: text.messageType,
      caption: text.caption,
      replyToMsgId:
        (message as any).replyTo?.replyToMsgId
        || (message as any).replyToMsgId
        || undefined,
      groupedId: normalizeId((message as any).groupedId),
      link: buildMessageLink(chat.chatEntity, messageId),
    },
  };
}

class ArchivePlugin extends Plugin {
  name = pluginName;
  private backfillPromise: Promise<void> | null = null;
  private activeJobId: number | null = null;
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
    this.activeJobId = null;
    this.backfillAbortController = null;
    this.ownerIdCache.current = null;
    this.runtimeStats = createRuntimeStats();
  }

  description: string = renderHelpSections(
    "🗂️ <b>Archive 帮助</b>",
    "持久化归档群组/频道消息，并提供全文检索与历史补抓。",
    [
      {
        heading: "📌 基本命令：",
        lines: [
          `<code>${commandName} help</code> - 查看帮助`,
          `<code>${commandName} status</code> - 查看归档状态`,
          `<code>${commandName} backfill</code> - 启动历史补抓`,
          `<code>${commandName} backfill resume</code> - 手动恢复最近一次可续跑补抓`,
          `<code>${commandName} backfill stop</code> - 停止当前补抓并保留断点`,
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
      if (subCommand === "backfill") {
        await this.handleBackfill(msg);
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
        this.runtimeStats.lastSkipReason = "未解析出群组/频道上下文";
        return;
      }
      if (!["group", "supergroup", "channel"].includes(archive.chatType)) {
        this.runtimeStats.skippedEvents += 1;
        this.runtimeStats.lastSkipReason = `不在采集范围: ${archive.chatType}`;
        return;
      }

      const db = new ArchiveDB();
      try {
        if (db.isChatBlacklisted(archive.input.chatId)) {
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

        if (archive.input.senderId) {
          db.upsertUser({
            userId: archive.input.senderId,
            username: archive.senderUsername,
            displayName: archive.input.senderDisplay || archive.input.senderId,
            lastSeenAt: Date.now(),
          });
        }

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

  private async handleStatus(msg: Api.Message): Promise<void> {
    const db = new ArchiveDB();
    try {
      const stats = db.getStats();
      const latestJob = db.getLatestBackfillJob();
      const lines = [
        "🗃️ <b>Archive 状态</b>",
        "",
        `<b>聊天数:</b> ${stats.chats}`,
        `<b>用户数:</b> ${stats.users}`,
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

      if (latestJob) {
        lines.push("");
        lines.push("🛠️ <b>最近补抓任务</b>");
        lines.push(`<b>ID:</b> ${latestJob.id}`);
        lines.push(`<b>状态:</b> ${htmlEscape(latestJob.status)}`);
        lines.push(`<b>时间窗口:</b> ${htmlEscape(latestJob.windowSpec || "全量")}`);
        lines.push(`<b>开始:</b> ${formatTime(latestJob.startedAt)}`);
        if (latestJob.finishedAt) lines.push(`<b>结束:</b> ${formatTime(latestJob.finishedAt)}`);
        if (latestJob.currentChatTitle) {
          lines.push(`<b>当前会话:</b> ${htmlEscape(latestJob.currentChatTitle)}`);
        }
        lines.push(`<b>已处理会话:</b> ${latestJob.processedChats}`);
        lines.push(`<b>已处理消息:</b> ${latestJob.processedMessages}`);
        if (latestJob.lastError) {
          lines.push(
            isBackfillStatusNote(latestJob.lastError)
              ? `<b>提示:</b> ${htmlEscape(latestJob.lastError)}`
              : `<b>错误:</b> ${htmlEscape(latestJob.lastError)}`
          );
        }
      }

      await msg.edit({ text: lines.join("\n"), parseMode: "html", linkPreview: false });
    } finally {
      db.close();
    }
  }

  private async handleBackfill(msg: Api.Message): Promise<void> {
    const parts = String(msg.message || msg.text || "").trim().split(/\s+/).filter(Boolean);
    const action = parts[2]?.toLowerCase();

    if (action === "resume") {
      await this.handleBackfillResume(msg);
      return;
    }
    if (action === "stop") {
      await this.handleBackfillStop(msg);
      return;
    }

    const client = await getGlobalClient();
    if (!client) {
      await msg.edit({ text: "❌ Telegram 客户端未初始化" });
      return;
    }
    if (this.backfillPromise) {
      await msg.edit({ text: "⚠️ 历史补抓已在运行中" });
      return;
    }
    if (!this.lifecycle) {
      await msg.edit({ text: "❌ Archive 插件生命周期尚未初始化" });
      return;
    }

    let windowSpec: string | undefined;
    let cutoffTs: number | undefined;
    try {
      ({ windowSpec, cutoffTs } = parseBackfillWindowSpec(parts[2]));
    } catch (error) {
      await msg.edit({ text: `❌ ${htmlEscape(extractErrorMessage(error))}`, parseMode: "html" }).catch(() => undefined);
      return;
    }

    const db = new ArchiveDB();
    const jobId = db.createBackfillJob(windowSpec);
    this.activeJobId = jobId;
    db.close();

    await msg.edit({
      text: [
        `🔄 已启动历史补抓任务 #${jobId}`,
        `⏱️ 时间窗口: <code>${htmlEscape(windowSpec || "全量")}</code>`,
        `可用 <code>${commandName} status</code> 查看进度`,
      ].join("\n"),
      parseMode: "html",
    });

    this.startBackfillJob(client, jobId, cutoffTs);
  }

  private startBackfillJob(
    client: TelegramClient,
    jobId: number,
    cutoffTs?: number,
    resumeState?: BackfillResumeState
  ): void {
    if (!this.lifecycle) {
      throw new Error("Archive 插件生命周期尚未初始化");
    }

    this.activeJobId = jobId;
    this.backfillAbortController = new AbortController();
    this.backfillPromise = this.lifecycle.runTask(
      async (lifecycleSignal) => {
        const signal = AbortSignal.any([lifecycleSignal, this.backfillAbortController!.signal]);
        await this.runBackfill(client, jobId, signal, cutoffTs, resumeState);
      },
      { label: `archive:backfill:${jobId}`, kind: "promise" }
    ).finally(() => {
      this.backfillPromise = null;
      this.activeJobId = null;
      this.backfillAbortController = null;
    });
  }

  private async handleBackfillResume(msg: Api.Message): Promise<void> {
    if (this.backfillPromise) {
      await msg.edit({ text: "⚠️ 历史补抓已在运行中" });
      return;
    }
    if (!this.lifecycle) {
      await msg.edit({ text: "❌ Archive 插件生命周期尚未初始化" });
      return;
    }

    const db = new ArchiveDB();
    let job: BackfillJobRecord | undefined;
    try {
      job = db.getLatestBackfillJob();
      if (!job || !["aborted", "stopped", "failed"].includes(job.status)) {
        await msg.edit({ text: "ℹ️ 没有可恢复的补抓任务" });
        return;
      }
    } finally {
      db.close();
    }

    const resumed = await this.resumeBackfillJob(job, false);
    if (!resumed) {
      await msg.edit({ text: "❌ 恢复补抓任务失败，请查看日志" });
      return;
    }

    await msg.edit({
      text: [
        `▶️ 已恢复历史补抓任务 #${job.id}`,
        `⏱️ 时间窗口: <code>${htmlEscape(job.windowSpec || "全量")}</code>`,
        `📍 断点: <code>${htmlEscape(job.currentChatTitle || job.currentChatId || "起点")}</code> / 消息 <code>${job.cursorMessageId || 0}</code>`,
      ].join("\n"),
      parseMode: "html",
    });
  }

  private async handleBackfillStop(msg: Api.Message): Promise<void> {
    if (!this.backfillPromise || !this.backfillAbortController || this.activeJobId == null) {
      await msg.edit({ text: "ℹ️ 当前没有正在运行的补抓任务" });
      return;
    }

    const activeJobId = this.activeJobId;
    this.backfillAbortController.abort(MANUAL_BACKFILL_STOP_REASON);

    try {
      await this.backfillPromise;
    } catch {
      // runBackfill handles abort as a normal state transition.
    }

    await msg.edit({
      text: [
        `⏹️ 已停止历史补抓任务 #${activeJobId}`,
        `可用 <code>${commandName} backfill resume</code> 从断点继续`,
      ].join("\n"),
      parseMode: "html",
    });
  }

  private async resumeBackfillIfNeeded(): Promise<void> {
    if (this.backfillPromise || !this.lifecycle) return;

    const db = new ArchiveDB();
    let job: BackfillJobRecord | undefined;
    try {
      job = db.getLatestResumableBackfillJob();
    } finally {
      db.close();
    }
    if (!job) return;
    await this.resumeBackfillJob(job, true);
  }

  private async resumeBackfillJob(job: BackfillJobRecord, automatic: boolean): Promise<boolean> {
    let cutoffTs: number | undefined;
    try {
      ({ cutoffTs } = parseBackfillWindowSpec(job.windowSpec));
    } catch (error) {
      console.error("[archive] Failed to parse resumable backfill window spec:", error);
      return false;
    }

    let client: TelegramClient;
    try {
      client = await getGlobalClient();
    } catch (error) {
      console.error("[archive] Failed to acquire client for backfill resume:", error);
      return false;
    }

    const resumeDb = new ArchiveDB();
    try {
      resumeDb.updateBackfillJob(job.id, {
        status: "running",
        finishedAt: null,
        lastError: automatic ? "Archive 插件重载后自动续跑中" : "手动恢复补抓中",
      });
    } finally {
      resumeDb.close();
    }

    console.log(
      `[archive] resuming backfill job #${job.id} from chat=${job.currentChatId || "start"} cursor=${job.cursorMessageId || 0} processedChats=${job.processedChats} processedMessages=${job.processedMessages}`
    );

    this.startBackfillJob(client, job.id, cutoffTs, {
      currentChatId: job.currentChatId,
      cursorMessageId: job.cursorMessageId,
      processedChats: job.processedChats,
      processedMessages: job.processedMessages,
    });
    return true;
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
        const removed = db.removeChatBlacklist(chat.chatId);
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

  private async runBackfill(
    client: TelegramClient,
    jobId: number,
    signal: AbortSignal,
    cutoffTs?: number,
    resumeState?: BackfillResumeState
  ): Promise<void> {
    const db = new ArchiveDB();
    let processedChats = resumeState?.processedChats ?? 0;
    let processedMessages = resumeState?.processedMessages ?? 0;
    let currentChatId: string | undefined;
    let currentChatTitle: string | undefined;
    let cursorMessageId: number | undefined;
    let remainingCompletedChatsToSkip = Math.max(0, resumeState?.processedChats ?? 0);
    let pendingResumeChatId = resumeState?.currentChatId;
    let pendingResumeCursorMessageId = resumeState?.cursorMessageId;
    let resumeCursorApplied = pendingResumeCursorMessageId == null;

    try {
      for await (const dialog of client.iterDialogs({})) {
        throwIfAborted(signal);
        if (!dialog?.entity) continue;
        if (!dialog.isGroup && !dialog.isChannel) continue;

        const entity = dialog.entity as any;
        const chatId = normalizeId(entity?.id);
        if (!chatId) continue;

        if (remainingCompletedChatsToSkip > 0) {
          remainingCompletedChatsToSkip -= 1;
          continue;
        }

        currentChatId = chatId;

        let chatType: ArchiveChatType = "group";
        if (entity instanceof Api.Channel) {
          chatType = entity.megagroup ? "supergroup" : "channel";
        }

        const title = String(dialog.title || dialog.name || entity?.title || chatId);
        currentChatTitle = title;

        if (db.isChatBlacklisted(chatId)) {
          processedChats += 1;
          db.updateBackfillJob(jobId, {
            status: "running",
            currentChatId: chatId,
            currentChatTitle: title,
            processedChats,
            processedMessages,
            lastError: `跳过黑名单会话: ${title}`,
          });
          continue;
        }

        db.upsertChat({
          chatId,
          chatType,
          title,
          username: entity?.username ? String(entity.username) : undefined,
          lastSeenAt: Date.now(),
        });

        db.updateBackfillJob(jobId, {
          status: "running",
          currentChatId: chatId,
          currentChatTitle: title,
          cursorMessageId: pendingResumeCursorMessageId,
          processedChats,
          processedMessages,
        });

        let lastMessageId = 0;
        const iterMessagesOptions: { reverse: true; minId?: number } = { reverse: true };
        if (!resumeCursorApplied && pendingResumeCursorMessageId != null) {
          if (!pendingResumeChatId || pendingResumeChatId === chatId) {
            iterMessagesOptions.minId = pendingResumeCursorMessageId;
            console.log(
              `[archive] applying backfill resume cursor for job #${jobId}: chat=${chatId} minId=${pendingResumeCursorMessageId}`
            );
          } else {
            console.warn(
              `[archive] resume chat mismatch for job #${jobId}: expected ${pendingResumeChatId}, got ${chatId}; replaying chat from the beginning`
            );
          }
          resumeCursorApplied = true;
          pendingResumeCursorMessageId = undefined;
          pendingResumeChatId = undefined;
        }

        while (true) {
          try {
            for await (const message of client.iterMessages(dialog.inputEntity || dialog.entity, iterMessagesOptions)) {
              throwIfAborted(signal);
              const messageTs = getDateNumber(message.date);
              if (cutoffTs && messageTs < cutoffTs) {
                break;
              }
              const archive = await buildArchiveInput(message as Api.Message);
              if (!archive.input) continue;
              if (archive.input.senderId) {
                db.upsertUser({
                  userId: archive.input.senderId,
                  username: archive.senderUsername,
                  displayName: archive.input.senderDisplay || archive.input.senderId,
                  lastSeenAt: Date.now(),
                });
              }
              db.insertOrUpdateMessage(archive.input, "backfill");
              processedMessages += 1;
              lastMessageId = archive.input.messageId;
              cursorMessageId = archive.input.messageId;

              if (processedMessages % BACKFILL_BATCH_SIZE === 0) {
                db.updateBackfillJob(jobId, {
                  status: "running",
                  currentChatId: chatId,
                  currentChatTitle: title,
                  cursorMessageId: lastMessageId,
                  processedChats,
                  processedMessages,
                });
                await this.requireLifecycle().delay(BACKFILL_BATCH_PAUSE_MS, {
                  label: `archive:backfill-batch-pause:${jobId}`,
                });
              }
            }
            break;
          } catch (error) {
            const floodWaitMs = getFloodWaitMs(error);
            if (floodWaitMs === null) {
              throw error;
            }
            db.updateBackfillJob(jobId, {
              status: "running",
              currentChatId: chatId,
              currentChatTitle: title,
              cursorMessageId: lastMessageId || undefined,
              processedChats,
              processedMessages,
              lastError: `FloodWait ${Math.ceil(floodWaitMs / 1000)}s，等待后继续`,
            });
            await this.requireLifecycle().delay(floodWaitMs, {
              label: `archive:backfill-floodwait:${jobId}`,
            });
          }
        }

        processedChats += 1;
        db.updateBackfillJob(jobId, {
          status: "running",
          currentChatId: chatId,
          currentChatTitle: title,
          cursorMessageId: lastMessageId || undefined,
          processedChats,
          processedMessages,
        });
        await this.requireLifecycle().delay(BACKFILL_DIALOG_PAUSE_MS, {
          label: `archive:backfill-dialog-pause:${jobId}`,
        });
      }

      db.updateBackfillJob(jobId, {
        status: "completed",
        finishedAt: Date.now(),
        processedChats,
        processedMessages,
        lastError: null,
      });
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        this.markBackfillAborted(db, {
          jobId,
          processedChats,
          processedMessages,
          currentChatId,
          currentChatTitle,
          cursorMessageId,
        }, signal.reason);
        return;
      }
      db.updateBackfillJob(jobId, {
        status: "failed",
        finishedAt: Date.now(),
        processedChats,
        processedMessages,
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
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
          row.chatTitle || row.chatId
        )}</b> · ${htmlEscape(row.senderDisplay || row.senderId || "unknown")}`;
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
    db.updateBackfillJob(context.jobId, {
      status: isManualStop ? "stopped" : "aborted",
      finishedAt: Date.now(),
      currentChatId: context.currentChatId,
      currentChatTitle: context.currentChatTitle,
      cursorMessageId: context.cursorMessageId,
      processedChats: context.processedChats,
      processedMessages: context.processedMessages,
      lastError: extractErrorMessage(
        reason || (isManualStop ? MANUAL_BACKFILL_STOP_REASON : "Runtime reload aborted archive backfill")
      ),
    });
  }
}

export default new ArchivePlugin();
