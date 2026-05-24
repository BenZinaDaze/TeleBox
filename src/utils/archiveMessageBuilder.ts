import { Api, utils } from "teleproto";

export type ArchiveChatType = "group" | "supergroup" | "channel";

export interface ArchiveMessageInput {
  chatId: string;
  messageId: number;
  senderId?: string;
  date: number;
  editDate: number;
  rawText: string;
  textNormalized: string;
  messageType: string;
  caption?: string;
  replyToMsgId?: number;
  groupedId?: string;
  link?: string;
}

function buildMessageLink(chatEntity: any, messageId: number): string | undefined {
  if (!messageId) return undefined;
  if (chatEntity?.username) return `https://t.me/${chatEntity.username}/${messageId}`;
  if (chatEntity instanceof Api.Channel && chatEntity?.id) {
    return `https://t.me/c/${chatEntity.id}/${messageId}`;
  }
  return undefined;
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

export function normalizeText(text: string): string {
  return text
    .replace(/\s*\r?\n\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function normalizeId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : undefined;
}

function getMarkedPeerId(peer: unknown): string | undefined {
  if (!peer) return undefined;
  try {
    return utils.getPeerId(peer as never);
  } catch {
    return undefined;
  }
}

function getBigIntLikeString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

export function collectChatIdCandidates(
  chatType: ArchiveChatType | undefined,
  ...values: unknown[]
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  for (const value of values) {
    const normalized = normalizeId(value);
    if (!normalized) continue;
    push(normalized);

    if (/^\d+$/.test(normalized)) {
      if (chatType === "channel" || chatType === "supergroup" || chatType === "group") {
        push(`-${normalized}`);
        push(`-100${normalized}`);
      }
      continue;
    }

    const channelMatch = normalized.match(/^-100(\d+)$/);
    if (channelMatch) {
      push(channelMatch[1]);
      push(`-${channelMatch[1]}`);
      continue;
    }

    const groupMatch = normalized.match(/^-(\d+)$/);
    if (groupMatch) {
      push(groupMatch[1]);
      push(`-100${groupMatch[1]}`);
    }
  }

  return candidates;
}

export function toCanonicalChatId(
  chatType: ArchiveChatType | undefined,
  ...values: unknown[]
): string | undefined {
  const candidates = collectChatIdCandidates(chatType, ...values);
  if (candidates.length === 0) return undefined;

  if (chatType === "channel" || chatType === "supergroup") {
    return candidates.find((candidate) => /^-100\d+$/.test(candidate))
      || candidates.find((candidate) => /^-\d+$/.test(candidate))
      || candidates[0];
  }

  if (chatType === "group") {
    return candidates.find((candidate) => /^-\d+$/.test(candidate) && !/^-100\d+$/.test(candidate))
      || candidates.find((candidate) => /^-100\d+$/.test(candidate))
      || candidates[0];
  }

  return candidates.find((candidate) => /^-\d+$/.test(candidate))
    || candidates[0];
}

export function getDateNumber(input: unknown): number {
  if (input instanceof Date) return input.getTime();
  if (typeof input === "number") return input > 10_000_000_000 ? input : input * 1000;
  if (typeof input === "bigint") return Number(input) * 1000;
  return Date.now();
}

export async function resolveChatContext(message: Api.Message): Promise<{
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

  const chatId = getMarkedPeerId(chat)
    || getMarkedPeerId(message.inputChat)
    || toCanonicalChatId(chatType, getBigIntLikeString(message.chatId), getBigIntLikeString(chat?.id));
  if (!chatId) return {};

  const chatTitle = chat instanceof Api.Channel || chat instanceof Api.Chat
    ? String(chat.title || chatId)
    : chatId;
  const chatUsername = chat instanceof Api.Channel && chat.username
    ? String(chat.username)
    : undefined;

  return {
    chatId,
    chatType,
    chatTitle,
    chatUsername,
    chatEntity: chat,
  };
}

async function resolveSenderContext(message: Api.Message): Promise<{
  senderId?: string;
}> {
  return { senderId: getBigIntLikeString(message.senderId) };
}

export async function buildArchiveInput(message: Api.Message): Promise<{
  chatType?: ArchiveChatType;
  chatTitle?: string;
  chatUsername?: string;
  input?: ArchiveMessageInput;
}> {
  const chat = await resolveChatContext(message);
  if (!chat.chatId || !chat.chatType || !chat.chatTitle) return {};

  const sender = await resolveSenderContext(message);
  const text = buildMessageText(message);
  const messageId = Number(message.id);
  if (!messageId) return {};

  return {
    chatType: chat.chatType,
    chatTitle: chat.chatTitle,
    chatUsername: chat.chatUsername,
    input: {
      chatId: chat.chatId,
      messageId,
      senderId: sender.senderId,
      date: getDateNumber(message.date),
      editDate: getDateNumber(message.editDate || message.date),
      rawText: text.rawText,
      textNormalized: normalizeText(text.rawText),
      messageType: text.messageType,
      caption: text.caption,
      replyToMsgId: message.replyToMsgId,
      groupedId: getBigIntLikeString(message.groupedId),
      link: buildMessageLink(chat.chatEntity, messageId),
    },
  };
}
