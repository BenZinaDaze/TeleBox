import { Api } from "teleproto";

export type ArchiveChatType = "group" | "supergroup" | "channel";

export interface ArchiveMessageInput {
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

export async function buildArchiveInput(message: Api.Message): Promise<{
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
