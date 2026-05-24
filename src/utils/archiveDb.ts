import Database from "better-sqlite3";
import path from "path";
import { createDirectoryInAssets } from "./pathHelpers";
import {
  normalizeText,
  type ArchiveChatType,
  type ArchiveMessageInput,
} from "./archiveMessageBuilder";

export type BackfillTargetStatus = "idle" | "running" | "completed" | "failed" | "stopped";

export interface ArchiveSearchParams {
  keyword?: string;
  chatId?: string;
  senderId?: string;
  fromTs?: number;
  toTs?: number;
  limit: number;
}

export interface ArchiveSearchRow {
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

export interface ArchiveStats {
  chats: number;
  users: number;
  messages: number;
  versions: number;
  deletedMessages: number;
  blacklistedChats: number;
  dbSizeBytes: number;
}

export interface BackfillTargetRecord {
  chatId: string;
  title: string;
  username?: string;
  chatType: ArchiveChatType;
  status: BackfillTargetStatus;
  completedOnce: boolean;
  cursorMessageId?: number;
  processedMessages: number;
  lastBackfillStartedAt?: number | null;
  lastBackfillFinishedAt?: number | null;
  lastError?: string | null;
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

const BACKFILL_TARGET_SELECT = `
  chat_id AS chatId,
  title,
  username,
  chat_type AS chatType,
  status,
  completed_once AS completedOnce,
  cursor_message_id AS cursorMessageId,
  processed_messages AS processedMessages,
  last_backfill_started_at AS lastBackfillStartedAt,
  last_backfill_finished_at AS lastBackfillFinishedAt,
  last_error AS lastError
`;

function canUseFtsKeyword(keyword: string): boolean {
  return /^[\p{L}\p{N}\s_-]+$/u.test(keyword);
}

export class ArchiveDB {
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
        resume_after_current_chat INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS archive_backfill_targets (
        chat_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        username TEXT,
        chat_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        completed_once INTEGER NOT NULL DEFAULT 0,
        cursor_message_id INTEGER,
        processed_messages INTEGER NOT NULL DEFAULT 0,
        last_backfill_started_at INTEGER,
        last_backfill_finished_at INTEGER,
        last_error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat_date ON messages(chat_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_sender_date ON messages(sender_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date DESC);
      CREATE INDEX IF NOT EXISTS idx_versions_message_version ON message_versions(message_row_id, version DESC);
      CREATE INDEX IF NOT EXISTS idx_backfill_targets_status ON archive_backfill_targets(status);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        search_text,
        tokenize='trigram'
      );
    `);

    const columns = this.db.prepare(`PRAGMA table_info(backfill_jobs)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "window_spec")) {
      this.db.exec(`ALTER TABLE backfill_jobs ADD COLUMN window_spec TEXT`);
    }
    if (!columns.some((column) => column.name === "resume_after_current_chat")) {
      this.db.exec(`ALTER TABLE backfill_jobs ADD COLUMN resume_after_current_chat INTEGER NOT NULL DEFAULT 0`);
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

  private replaceFtsRow(rowId: number, searchText: string): void {
    this.db.prepare(`DELETE FROM messages_fts WHERE rowid = ?`).run(rowId);
    this.db
      .prepare(`INSERT INTO messages_fts(rowid, search_text) VALUES (?, ?)`)
      .run(rowId, searchText);
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
      if (keyword.length >= 3 && canUseFtsKeyword(keyword)) {
        fromClause = `messages_fts f JOIN messages m ON m.id = f.rowid`;
        where.push(`f.search_text MATCH ?`);
        values.push(keyword);
      } else {
        where.push(`(
          m.text_normalized LIKE ?
          OR m.raw_text LIKE ?
          OR COALESCE(m.caption, '') LIKE ?
          OR COALESCE(m.sender_display, '') LIKE ?
        )`);
        values.push(`%${normalizeText(keyword)}%`);
        values.push(`%${keyword}%`);
        values.push(`%${keyword}%`);
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

  public upsertBackfillTargetMeta(record: {
    chatId: string;
    title: string;
    username?: string;
    chatType: ArchiveChatType;
  }): void {
    this.db.prepare(`
      INSERT INTO archive_backfill_targets (chat_id, title, username, chat_type)
      VALUES (@chatId, @title, @username, @chatType)
      ON CONFLICT(chat_id) DO UPDATE SET
        title = excluded.title,
        username = excluded.username,
        chat_type = excluded.chat_type
    `).run(record);
  }

  public updateBackfillTarget(chatId: string, patch: Partial<BackfillTargetRecord>): void {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    const mapping: Record<string, string> = {
      title: "title",
      username: "username",
      chatType: "chat_type",
      status: "status",
      completedOnce: "completed_once",
      cursorMessageId: "cursor_message_id",
      processedMessages: "processed_messages",
      lastBackfillStartedAt: "last_backfill_started_at",
      lastBackfillFinishedAt: "last_backfill_finished_at",
      lastError: "last_error",
    };

    for (const [key, column] of Object.entries(mapping)) {
      const value = patch[key as keyof BackfillTargetRecord];
      if (value !== undefined) {
        fields.push(`${column} = ?`);
        values.push(typeof value === "boolean" ? (value ? 1 : 0) : value as string | number | null);
      }
    }

    if (fields.length === 0) return;
    values.push(chatId);
    this.db.prepare(`UPDATE archive_backfill_targets SET ${fields.join(", ")} WHERE chat_id = ?`).run(...values);
  }

  public getBackfillTarget(chatId: string): BackfillTargetRecord | undefined {
    return this.db.prepare<[string], BackfillTargetRecord>(`
      SELECT ${BACKFILL_TARGET_SELECT}
      FROM archive_backfill_targets
      WHERE chat_id = ?
      LIMIT 1
    `).get(chatId);
  }

  public getBackfillTargetsMap(): Map<string, BackfillTargetRecord> {
    const rows = this.db.prepare<[], BackfillTargetRecord>(`
      SELECT ${BACKFILL_TARGET_SELECT}
      FROM archive_backfill_targets
    `).all();
    return new Map(rows.map((row) => [row.chatId, row]));
  }

  public getLatestResumableBackfillTarget(): BackfillTargetRecord | undefined {
    return this.db.prepare<[], BackfillTargetRecord>(`
      SELECT ${BACKFILL_TARGET_SELECT}
      FROM archive_backfill_targets
      WHERE status IN ('running', 'failed', 'stopped')
      ORDER BY COALESCE(last_backfill_started_at, 0) DESC, COALESCE(last_backfill_finished_at, 0) DESC
      LIMIT 1
    `).get();
  }

  public getAutoResumableBackfillTarget(): BackfillTargetRecord | undefined {
    return this.db.prepare<[], BackfillTargetRecord>(`
      SELECT ${BACKFILL_TARGET_SELECT}
      FROM archive_backfill_targets
      WHERE status = 'running'
      ORDER BY COALESCE(last_backfill_started_at, 0) DESC
      LIMIT 1
    `).get();
  }

  public getBackfillTargetSummary(): {
    completed: number;
    running: number;
    failed: number;
    stopped: number;
  } {
    const rows = this.db.prepare<[], { status: BackfillTargetStatus; count: number }>(`
      SELECT status, COUNT(*) AS count
      FROM archive_backfill_targets
      GROUP BY status
    `).all();
    return {
      completed: rows.find((row) => row.status === "completed")?.count || 0,
      running: rows.find((row) => row.status === "running")?.count || 0,
      failed: rows.find((row) => row.status === "failed")?.count || 0,
      stopped: rows.find((row) => row.status === "stopped")?.count || 0,
    };
  }

  public close(): void {
    this.db.close();
  }
}
