import { Plugin } from "@utils/pluginBase";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { safeGetMe } from "@utils/authGuards";
import { Api } from "teleproto";

const MAX_BULK_DELETE_COUNT = 100;
const FEEDBACK_DELETE_DELAY_MS = 3000;

type DeletableMessage = Api.Message & {
  safeDelete?: (options?: { revoke?: boolean }) => Promise<Api.messages.AffectedMessages[] | undefined>;
  deleteWithDelay?: (delay: number, shouldThrowError?: boolean) => Promise<Api.messages.AffectedMessages[] | undefined>;
};

type BulkDeleteMode =
  | { kind: "single" }
  | { kind: "bulk"; count: number };

function getCommandArgs(msg: Api.Message): string[] {
  const text = msg.message || msg.text || "";
  return text.trim().split(/\s+/).slice(1);
}

function parseDeleteMode(msg: Api.Message): BulkDeleteMode {
  const args = getCommandArgs(msg).filter(Boolean);
  if (args.length !== 1) {
    return { kind: "single" };
  }

  const count = Number.parseInt(args[0] || "", 10);
  if (!Number.isInteger(count) || count <= 0 || count > MAX_BULK_DELETE_COUNT) {
    return { kind: "single" };
  }

  return { kind: "bulk", count };
}

async function trySafeDelete(msg?: Api.Message | null): Promise<boolean> {
  if (!msg) return false;

  try {
    const result = await (msg as DeletableMessage).safeDelete?.({ revoke: true });
    return result !== undefined;
  } catch {
    // Keep .del silent even when deletion fails.
    return false;
  }
}

async function isSelfMessage(msg: Api.Message): Promise<boolean> {
  if (msg.out) return true;
  if (!msg.client) return false;

  try {
    const me = await safeGetMe(msg.client);
    return !!me?.id && msg.senderId === me.id;
  } catch {
    return false;
  }
}

async function ensureSelfInvocation(msg: Api.Message): Promise<boolean> {
  return await isSelfMessage(msg);
}

function getHistoryPeer(msg: Api.Message): any {
  return msg.inputChat ?? msg.peerId ?? msg.chatId;
}

function isTopicScopedMessage(msg: Api.Message): boolean {
  const reply = (msg as Api.Message & {
    replyTo?: { forumTopic?: boolean; replyToTopId?: number };
  }).replyTo;
  return !!(reply?.forumTopic || reply?.replyToTopId);
}

function getFeedbackReplyTo(msg: Api.Message): number | undefined {
  const reply = (msg as Api.Message & {
    replyTo?: { forumTopic?: boolean; replyToTopId?: number; replyToMsgId?: number };
    replyToMsgId?: number;
  }).replyTo;

  if (reply?.forumTopic && reply.replyToTopId) {
    return reply.replyToTopId;
  }

  return reply?.replyToMsgId ?? (msg as any).replyToMsgId;
}

async function sendTemporaryFeedback(msg: Api.Message, text: string): Promise<void> {
  if (!msg.client || !msg.peerId) {
    return;
  }

  try {
    const feedback = await msg.client.sendMessage(msg.peerId, {
      message: text,
      replyTo: getFeedbackReplyTo(msg),
    });
    await (feedback as DeletableMessage | undefined)?.deleteWithDelay?.(FEEDBACK_DELETE_DELAY_MS);
  } catch {
    // Keep .del quiet if feedback cannot be sent.
  }
}

async function collectRecentSelfMessages(msg: Api.Message, count: number): Promise<Api.Message[]> {
  const peer = getHistoryPeer(msg);
  if (!msg.client || !peer) {
    return [];
  }

  const matches: Api.Message[] = [];
  for await (const candidate of msg.client.iterMessages(peer, { offsetId: msg.id })) {
    if (!(candidate instanceof Api.Message)) {
      continue;
    }

    if (await isSelfMessage(candidate)) {
      matches.push(candidate);
      if (matches.length >= count) {
        break;
      }
    }
  }

  return matches;
}

async function deleteSingleMessageFlow(msg: Api.Message): Promise<void> {
  const reply = await safeGetReplyMessage(msg);

  if (!reply) {
    await trySafeDelete(msg);
    return;
  }

  if (await isSelfMessage(reply)) {
    await trySafeDelete(reply);
  }

  await trySafeDelete(msg);
}

async function deleteBulkMessagesFlow(msg: Api.Message, count: number): Promise<void> {
  if (isTopicScopedMessage(msg)) {
    await trySafeDelete(msg);
    await sendTemporaryFeedback(msg, "当前话题暂不支持批量删除");
    return;
  }

  const targets = await collectRecentSelfMessages(msg, count);
  if (targets.length < count) {
    await trySafeDelete(msg);
    await sendTemporaryFeedback(msg, `本人消息不足 ${count} 条，未执行删除`);
    return;
  }

  await trySafeDelete(msg);

  let deletedCount = 0;
  for (const target of targets) {
    if (await trySafeDelete(target)) {
      deletedCount += 1;
    }
  }

  await sendTemporaryFeedback(msg, `已删除最近 ${deletedCount} 条本人消息`);
}

class DelPlugin extends Plugin {
  name = "del";
  description = "回复消息时删除本人消息，否则删除 .del 命令消息；.del <number> 删除最近 N 条本人消息";

  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  cmdHandlers = {
    del: async (msg: Api.Message) => {
      if (!(await ensureSelfInvocation(msg))) {
        return;
      }

      const mode = parseDeleteMode(msg);
      if (mode.kind === "single") {
        await deleteSingleMessageFlow(msg);
        return;
      }

      await deleteBulkMessagesFlow(msg, mode.count);
    },
  };
}

export default new DelPlugin();
