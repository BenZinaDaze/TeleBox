import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { createDirectoryInAssets } from "./pathHelpers";
import {
  collectChatIdCandidates,
  normalizeText,
  toCanonicalChatId,
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

export interface ArchiveNormalizationStats {
  aliasMappings: number;
  chatsRewritten: number;
  messageRowsRewritten: number;
  mergedMessageGroups: number;
  versionRowsRewritten: number;
  blacklistRewritten: number;
  backfillTargetsRewritten: number;
  backfillJobsUpdated: number;
  droppedChannelChats: number;
  droppedChannelMessages: number;
  droppedChannelVersions: number;
}

export interface ArchiveNormalizationProgress {
  stage: string;
  detail: string;
}

type StoredMessageRow = {
  chat_id: string;
  message_id: number;
  edit_date: number;
  sender_id: string | null;
  date: number;
  raw_text: string;
  text_normalized: string;
  message_type: string;
  caption: string | null;
  link: string | null;
  is_deleted: number;
};

type LegacyMessageRow = {
  id: number;
  chat_id: string;
  message_id: number;
  sender_id: string | null;
  date: number;
  raw_text: string;
  text_normalized: string;
  message_type: string;
  caption: string | null;
  link: string | null;
  is_deleted: number;
};

type LegacyMessageVersionRow = {
  message_row_id: number;
  version: number;
  raw_text: string;
  text_normalized: string;
  caption: string | null;
  edited_at: number;
};

type LegacyBackfillTargetRow = {
  chat_id: string;
  title: string;
  username: string | null;
  chat_type: ArchiveChatType;
  status: BackfillTargetStatus;
  completed_once: number;
  cursor_message_id: number | null;
  processed_messages: number;
  last_backfill_started_at: number | null;
  last_backfill_finished_at: number | null;
  last_error: string | null;
};

type LegacyChatRow = {
  chat_id: string;
  chat_type: ArchiveChatType;
};

type LegacyBlacklistRow = {
  chat_id: string;
  title: string;
  username: string | null;
  created_at: number;
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

const ARCHIVE_DIR = createDirectoryInAssets("archive");
const LEGACY_DB_PATH = path.join(ARCHIVE_DIR, "archive.db");
const V2_DB_PATH = path.join(ARCHIVE_DIR, "archive_v2.db");
const LEGACY_MIGRATION_BATCH_SIZE = 1000;

function rowCount(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { count: number };
  return row.count > 0;
}

function pickPreferredText(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value && value.trim()) return value;
  }
  return null;
}

export class ArchiveDB {
  private db: Database.Database;

  constructor(dbPath: string = V2_DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        chat_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        edit_date INTEGER NOT NULL,
        sender_id TEXT,
        date INTEGER NOT NULL,
        raw_text TEXT NOT NULL,
        text_normalized TEXT NOT NULL,
        message_type TEXT NOT NULL,
        caption TEXT,
        link TEXT,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (chat_id, message_id, edit_date)
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

      CREATE INDEX IF NOT EXISTS idx_messages_sender_date ON messages(sender_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_chat_date ON messages(chat_id, date DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date DESC);
      CREATE INDEX IF NOT EXISTS idx_backfill_targets_status ON archive_backfill_targets(status);
    `);

    this.db.exec(`
      DROP TABLE IF EXISTS users;
      DROP TABLE IF EXISTS chats;
      DROP TABLE IF EXISTS message_versions;
      DROP TABLE IF EXISTS messages_fts;
      DROP TABLE IF EXISTS messages_fts_data;
      DROP TABLE IF EXISTS messages_fts_idx;
      DROP TABLE IF EXISTS messages_fts_docsize;
      DROP TABLE IF EXISTS messages_fts_config;
      DROP TABLE IF EXISTS messages_fts_content;
      DROP TABLE IF EXISTS backfill_jobs;
    `);
  }

  private effectiveEditDate(input: ArchiveMessageInput): number {
    return input.editDate || input.date;
  }

  private countVersions(chatId: string, messageId: number): number {
    const row = this.db
      .prepare<[string, number], { count: number }>(`
        SELECT COUNT(*) AS count
        FROM messages
        WHERE chat_id = ? AND message_id = ?
      `)
      .get(chatId, messageId);
    return row?.count || 0;
  }

  public upsertChat(_record?: {
    chatId: string;
    chatType: ArchiveChatType;
    title: string;
    username?: string;
    lastSeenAt: number;
  }): void {
    // V2 no longer stores chat metadata outside backfill target state.
  }

  public insertOrUpdateMessage(
    input: ArchiveMessageInput,
    _editSource: "new" | "edit" | "backfill" = "new"
  ): { inserted: boolean; updated: boolean; version: number } {
    const editDate = this.effectiveEditDate(input);
    const existing = this.db
      .prepare<[string, number, number], StoredMessageRow>(`
        SELECT *
        FROM messages
        WHERE chat_id = ? AND message_id = ? AND edit_date = ?
      `)
      .get(input.chatId, input.messageId, editDate);

    if (!existing) {
      this.db
        .prepare(`
          INSERT INTO messages (
            chat_id, message_id, edit_date, sender_id, date, raw_text,
            text_normalized, message_type, caption, link, is_deleted
          ) VALUES (
            @chatId, @messageId, @editDate, @senderId, @date, @rawText,
            @textNormalized, @messageType, @caption, @link, 0
          )
        `)
        .run({
          ...input,
          editDate,
        });

      return {
        inserted: true,
        updated: false,
        version: this.countVersions(input.chatId, input.messageId),
      };
    }

    const changed =
      (existing.sender_id || "") !== (input.senderId || "")
      || existing.date !== input.date
      || existing.raw_text !== input.rawText
      || existing.text_normalized !== input.textNormalized
      || existing.message_type !== input.messageType
      || (existing.caption || "") !== (input.caption || "")
      || (existing.link || "") !== (input.link || "")
      || existing.is_deleted !== 0;

    if (!changed) {
      return {
        inserted: false,
        updated: false,
        version: this.countVersions(input.chatId, input.messageId),
      };
    }

    this.db
      .prepare(`
        UPDATE messages
        SET sender_id = @senderId,
            date = @date,
            raw_text = @rawText,
            text_normalized = @textNormalized,
            message_type = @messageType,
            caption = @caption,
            link = @link,
            is_deleted = 0
        WHERE chat_id = @chatId AND message_id = @messageId AND edit_date = @editDate
      `)
      .run({
        ...input,
        editDate,
      });

    return {
      inserted: false,
      updated: true,
      version: this.countVersions(input.chatId, input.messageId),
    };
  }

  public markMessageDeleted(chatId: string, messageId: number): void {
    this.db
      .prepare(`
        UPDATE messages
        SET is_deleted = 1
        WHERE chat_id = ? AND message_id = ? AND edit_date = (
          SELECT MAX(edit_date)
          FROM messages
          WHERE chat_id = ? AND message_id = ?
        )
      `)
      .run(chatId, messageId, chatId, messageId);
  }

  public getStats(): ArchiveStats {
    const chats = this.db.prepare(`
      SELECT COUNT(DISTINCT chat_id) AS count
      FROM messages
    `).get() as { count: number };
    const latestMessages = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT chat_id, message_id
        FROM messages
        GROUP BY chat_id, message_id
      )
    `).get() as { count: number };
    const versions = this.db.prepare(`SELECT COUNT(*) AS count FROM messages`).get() as { count: number };
    const deleted = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM (
        SELECT m.*
        FROM messages m
        WHERE NOT EXISTS (
          SELECT 1
          FROM messages newer
          WHERE newer.chat_id = m.chat_id
            AND newer.message_id = m.message_id
            AND newer.edit_date > m.edit_date
        )
          AND m.is_deleted = 1
      )
    `).get() as { count: number };
    const blacklisted = this.db.prepare(`SELECT COUNT(*) AS count FROM archive_blacklist`).get() as {
      count: number;
    };
    const pageCount = this.db.pragma("page_count", { simple: true }) as number;
    const pageSize = this.db.pragma("page_size", { simple: true }) as number;

    return {
      chats: chats.count,
      messages: latestMessages.count,
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

    if (params.keyword) {
      const keyword = params.keyword.trim();
      where.push(`(
        m.text_normalized LIKE ?
        OR m.raw_text LIKE ?
        OR COALESCE(m.caption, '') LIKE ?
        OR m.message_type LIKE ?
      )`);
      values.push(`%${normalizeText(keyword)}%`);
      values.push(`%${keyword}%`);
      values.push(`%${keyword}%`);
      values.push(`%${keyword}%`);
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
        m.date,
        m.raw_text AS rawText,
        m.text_normalized AS textNormalized,
        m.message_type AS messageType,
        m.caption,
        m.link,
        (
          SELECT COUNT(*)
          FROM messages versions
          WHERE versions.chat_id = m.chat_id AND versions.message_id = m.message_id
        ) AS latestVersion,
        m.is_deleted AS isDeleted
      FROM messages m
      WHERE NOT EXISTS (
        SELECT 1
        FROM messages newer
        WHERE newer.chat_id = m.chat_id
          AND newer.message_id = m.message_id
          AND newer.edit_date > m.edit_date
      )
        AND ${where.join(" AND ")}
      ORDER BY m.date DESC
      LIMIT ?
    `).all(...values) as ArchiveSearchRow[];
  }

  public isChatBlacklisted(chatId: string | string[]): boolean {
    return !!this.findBlacklistedChat(chatId);
  }

  public addChatBlacklist(record: {
    chatId: string;
    title: string;
    username?: string;
    matchChatIds?: string[];
  }): void {
    const existing = this.findBlacklistedChat(record.matchChatIds || record.chatId);
    if (existing && existing.chatId !== record.chatId) {
      this.db
        .prepare(`
          UPDATE archive_blacklist
          SET chat_id = @chatId,
              title = @title,
              username = @username
          WHERE chat_id = @existingChatId
        `)
        .run({
          chatId: record.chatId,
          title: record.title,
          username: record.username,
          existingChatId: existing.chatId,
        });
      return;
    }

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

  public removeChatBlacklist(chatId: string | string[]): boolean {
    const existing = this.findBlacklistedChat(chatId);
    if (!existing) return false;
    const result = this.db
      .prepare(`DELETE FROM archive_blacklist WHERE chat_id = ?`)
      .run(existing.chatId);
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

  private findBlacklistedChat(chatIds: string | string[]): { chatId: string } | undefined {
    const ids = Array.isArray(chatIds)
      ? Array.from(new Set(chatIds.filter(Boolean)))
      : chatIds
        ? [chatIds]
        : [];
    if (ids.length === 0) return undefined;

    return this.db
      .prepare<string[], { chatId: string }>(`
        SELECT chat_id AS chatId
        FROM archive_blacklist
        WHERE chat_id IN (${ids.map(() => "?").join(", ")})
        LIMIT 1
      `)
      .get(...ids);
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

  public async normalizeChatIds(
    aliasToCanonicalInput: Map<string, string> | Record<string, string>,
    onProgress?: (progress: ArchiveNormalizationProgress) => Promise<void> | void
  ): Promise<ArchiveNormalizationStats> {
    const aliasToCanonical = aliasToCanonicalInput instanceof Map
      ? aliasToCanonicalInput
      : new Map(Object.entries(aliasToCanonicalInput));

    const stats: ArchiveNormalizationStats = {
      aliasMappings: aliasToCanonical.size,
      chatsRewritten: 0,
      messageRowsRewritten: 0,
      mergedMessageGroups: 0,
      versionRowsRewritten: 0,
      blacklistRewritten: 0,
      backfillTargetsRewritten: 0,
      backfillJobsUpdated: 0,
      droppedChannelChats: 0,
      droppedChannelMessages: 0,
      droppedChannelVersions: 0,
    };

    if (!fs.existsSync(LEGACY_DB_PATH) || path.resolve(LEGACY_DB_PATH) === path.resolve(V2_DB_PATH)) {
      return stats;
    }

    const emit = async (stage: string, detail: string) => {
      await onProgress?.({ stage, detail });
    };

    const legacy = new Database(LEGACY_DB_PATH, { readonly: true });
    try {
      await emit("scan", "检查旧 DB 结构");
      const hasMessages = rowCount(legacy, "messages");
      const hasVersions = rowCount(legacy, "message_versions");
      const hasChats = rowCount(legacy, "chats");
      const hasBackfillTargets = rowCount(legacy, "archive_backfill_targets");
      const hasBlacklist = rowCount(legacy, "archive_blacklist");
      const hasBackfillJobs = rowCount(legacy, "backfill_jobs");
      if (!hasMessages) return stats;

      await emit("scan", "读取旧会话与 backfill 元数据");
      const legacyChats = hasChats
        ? legacy.prepare<[], LegacyChatRow>(`SELECT chat_id, chat_type FROM chats`).all()
        : [];
      const legacyTargets = hasBackfillTargets
        ? legacy.prepare<[], LegacyBackfillTargetRow>(`
            SELECT
              chat_id,
              title,
              username,
              chat_type,
              status,
              completed_once,
              cursor_message_id,
              processed_messages,
              last_backfill_started_at,
              last_backfill_finished_at,
              last_error
            FROM archive_backfill_targets
          `).all()
        : [];
      const typeHints = new Map<string, ArchiveChatType>();
      for (const row of legacyChats) {
        typeHints.set(row.chat_id, row.chat_type);
        for (const candidate of collectChatIdCandidates(row.chat_type, row.chat_id)) {
          typeHints.set(candidate, row.chat_type);
        }
      }
      for (const row of legacyTargets) {
        typeHints.set(row.chat_id, row.chat_type);
        for (const candidate of collectChatIdCandidates(row.chat_type, row.chat_id)) {
          typeHints.set(candidate, row.chat_type);
        }
      }

      const resolveCanonicalChatId = (chatId: string, chatType?: ArchiveChatType): string => {
        const candidates = collectChatIdCandidates(chatType || typeHints.get(chatId), chatId);
        for (const candidate of candidates) {
          const mapped = aliasToCanonical.get(candidate);
          if (mapped) return mapped;
        }
        return toCanonicalChatId(chatType || typeHints.get(chatId), chatId) || chatId;
      };

      const droppedChannelChatIds = new Set<string>();
      for (const row of legacyChats) {
        if (row.chat_type === "channel") {
          droppedChannelChatIds.add(resolveCanonicalChatId(row.chat_id, row.chat_type));
        }
      }
      for (const row of legacyTargets) {
        if (row.chat_type === "channel") {
          droppedChannelChatIds.add(resolveCanonicalChatId(row.chat_id, row.chat_type));
        }
      }
      stats.droppedChannelChats = droppedChannelChatIds.size;

      if (hasBlacklist) {
        await emit("blacklist", "迁移黑名单");
        const rows = legacy.prepare<[], LegacyBlacklistRow>(`
          SELECT chat_id, title, username, created_at
          FROM archive_blacklist
        `).all();
        for (const row of rows) {
          const chatId = resolveCanonicalChatId(row.chat_id);
          if (droppedChannelChatIds.has(chatId)) continue;
          this.addChatBlacklist({
            chatId,
            title: row.title,
            username: row.username || undefined,
            matchChatIds: collectChatIdCandidates(typeHints.get(row.chat_id), row.chat_id, chatId),
          });
          stats.blacklistRewritten += 1;
        }
      }

      await emit("targets", "迁移 backfill 列表状态");
      for (const row of legacyTargets) {
        const chatId = resolveCanonicalChatId(row.chat_id, row.chat_type);
        if (droppedChannelChatIds.has(chatId)) continue;
        this.upsertBackfillTargetMeta({
          chatId,
          title: row.title,
          username: row.username || undefined,
          chatType: row.chat_type,
        });
        this.updateBackfillTarget(chatId, {
          status: row.status,
          completedOnce: row.completed_once > 0,
          cursorMessageId: row.cursor_message_id || undefined,
          processedMessages: row.processed_messages,
          lastBackfillStartedAt: row.last_backfill_started_at,
          lastBackfillFinishedAt: row.last_backfill_finished_at,
          lastError: row.last_error,
        });
        stats.backfillTargetsRewritten += 1;
      }

      if (hasBackfillJobs) {
        const row = legacy.prepare(`
          SELECT COUNT(*) AS count
          FROM backfill_jobs
          WHERE current_chat_id IS NOT NULL
        `).get() as { count: number };
        stats.backfillJobsUpdated = row.count;
      }

      const totalMessagesRow = legacy.prepare(`
        SELECT COUNT(*) AS count
        FROM messages
      `).get() as { count: number };
      const totalMessages = totalMessagesRow.count;
      await emit("messages", `开始迁移，共 ${totalMessages} 条旧消息`);

      const fetchLegacyMessages = legacy.prepare<[number, number], LegacyMessageRow>(`
        SELECT
          id,
          chat_id,
          message_id,
          sender_id,
          date,
          raw_text,
          text_normalized,
          message_type,
          caption,
          link,
          is_deleted
        FROM messages
        WHERE id > ?
        ORDER BY id ASC
        LIMIT ?
      `);

      const seenChats = new Set<string>();
      let lastMessageRowId = 0;
      while (true) {
        const legacyMessages = fetchLegacyMessages.all(lastMessageRowId, LEGACY_MIGRATION_BATCH_SIZE);
        if (legacyMessages.length === 0) break;
        lastMessageRowId = legacyMessages[legacyMessages.length - 1].id;

        const versionsByMessageRowId = new Map<number, LegacyMessageVersionRow[]>();
        if (hasVersions) {
          const placeholders = legacyMessages.map(() => "?").join(", ");
          const rows = legacy.prepare<number[], LegacyMessageVersionRow>(`
            SELECT
              message_row_id,
              version,
              raw_text,
              text_normalized,
              caption,
              edited_at
            FROM message_versions
            WHERE message_row_id IN (${placeholders})
            ORDER BY message_row_id ASC, version ASC, edited_at ASC
          `).all(...legacyMessages.map((row) => row.id));
          for (const row of rows) {
            const bucket = versionsByMessageRowId.get(row.message_row_id) || [];
            bucket.push(row);
            versionsByMessageRowId.set(row.message_row_id, bucket);
          }
        }

        for (const row of legacyMessages) {
          const chatId = resolveCanonicalChatId(row.chat_id, typeHints.get(row.chat_id));
          if (droppedChannelChatIds.has(chatId)) {
            stats.droppedChannelMessages += 1;
            stats.droppedChannelVersions += (versionsByMessageRowId.get(row.id) || []).length;
            continue;
          }
          seenChats.add(chatId);
          const versions = versionsByMessageRowId.get(row.id) || [];
          if (versions.length === 0) {
            this.insertOrUpdateMessage({
              chatId,
              messageId: row.message_id,
              senderId: row.sender_id || undefined,
              date: row.date,
              editDate: row.date,
              rawText: row.raw_text,
              textNormalized: row.text_normalized,
              messageType: row.message_type,
              caption: row.caption || undefined,
              link: row.link || undefined,
            }, "backfill");
            if (row.is_deleted) this.markMessageDeleted(chatId, row.message_id);
            stats.messageRowsRewritten += 1;
            stats.versionRowsRewritten += 1;
          } else {
            for (const version of versions) {
              const effectiveEditDate = version.version === 1 ? row.date : Math.max(version.edited_at, row.date);
              this.insertOrUpdateMessage({
                chatId,
                messageId: row.message_id,
                senderId: row.sender_id || undefined,
                date: row.date,
                editDate: effectiveEditDate,
                rawText: version.raw_text,
                textNormalized: version.text_normalized,
                messageType: row.message_type,
                caption: version.caption || undefined,
                link: row.link || undefined,
              }, "backfill");
              stats.versionRowsRewritten += 1;
            }
            if (row.is_deleted) this.markMessageDeleted(chatId, row.message_id);
            stats.messageRowsRewritten += 1;
          }
        }
        await emit("messages", `已迁移 ${stats.messageRowsRewritten}/${totalMessages} 条消息`);
      }

      stats.chatsRewritten = seenChats.size;
      await emit("done", `迁移完成，共 ${stats.messageRowsRewritten} 条消息，${stats.versionRowsRewritten} 个版本`);
      return stats;
    } finally {
      legacy.close();
    }
  }

  public close(): void {
    this.db.close();
  }
}
