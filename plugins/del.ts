import { Plugin } from "@utils/pluginBase";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import { safeGetMe } from "@utils/authGuards";
import { Api } from "teleproto";

type DeletableMessage = Api.Message & {
  safeDelete?: (options?: { revoke?: boolean }) => Promise<void>;
};

async function trySafeDelete(msg?: Api.Message | null): Promise<void> {
  if (!msg) return;

  try {
    await (msg as DeletableMessage).safeDelete?.({ revoke: true });
  } catch {
    // Keep .del silent even when deletion fails.
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

class DelPlugin extends Plugin {
  name = "del";
  description = "回复消息时删除本人消息，否则删除 .del 命令消息；直接发送 .del 也删除自身";

  cleanup(): void {
    // 当前插件不持有需要在 reload 时额外释放的长期资源。
  }

  cmdHandlers = {
    del: async (msg: Api.Message) => {
      if (!(await ensureSelfInvocation(msg))) {
        return;
      }

      const reply = await safeGetReplyMessage(msg);

      if (!reply) {
        await trySafeDelete(msg);
        return;
      }

      if (await isSelfMessage(reply)) {
        await trySafeDelete(reply);
      }

      await trySafeDelete(msg);
    },
  };
}

export default new DelPlugin();
