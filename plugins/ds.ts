import axios from "axios";
import path from "path";
import { JSONFilePreset } from "lowdb/node";
import { Api, TelegramClient } from "teleproto";
import { NewMessage, NewMessageEvent } from "teleproto/events";
import { Plugin, type PluginRuntimeContext } from "@utils/pluginBase";
import { createDirectoryInAssets } from "@utils/pathHelpers";
import { getPrefixes } from "@utils/pluginManager";
import { safeGetMe } from "@utils/authGuards";
import { safeGetReplyMessage } from "@utils/safeGetMessages";
import type { GenerationContext } from "@utils/generationContext";
import { TelegramFormatter } from "@utils/telegramFormatter";

type ProviderConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
};

type DsConfig = {
  currentProvider: string;
  systemPrompt: string;
  providers: Record<string, ProviderConfig>;
};

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

const PLUGIN_NAME = "ds";
const DEFAULT_PROVIDER = "deepseek";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const API_KEY_TIMEOUT_MS = 60_000;
const STREAM_EDIT_INTERVAL_MS = 900;
const TELEGRAM_TEXT_LIMIT = 3500;
const prefixes = getPrefixes();
const mainPrefix = prefixes[0] || ".";
const CONFIG_PATH = path.join(
  createDirectoryInAssets(PLUGIN_NAME),
  "config.json"
);

const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  apiKey: "",
  baseURL: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
};

const DEFAULT_CONFIG: DsConfig = {
  currentProvider: DEFAULT_PROVIDER,
  systemPrompt: "",
  providers: {
    [DEFAULT_PROVIDER]: { ...DEFAULT_PROVIDER_CONFIG },
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

function normalizeProviderConfig(raw?: Partial<ProviderConfig> | null): ProviderConfig {
  return {
    apiKey: raw?.apiKey?.trim() || "",
    baseURL: raw?.baseURL?.trim() || DEFAULT_PROVIDER_CONFIG.baseURL,
    model: raw?.model?.trim() || DEFAULT_PROVIDER_CONFIG.model,
  };
}

function normalizeConfig(raw?: Partial<DsConfig> | null): DsConfig {
  const providers = typeof raw?.providers === "object" && raw?.providers
    ? Object.fromEntries(
      Object.entries(raw.providers)
        .map(([name, config]) => [name.trim().toLowerCase(), normalizeProviderConfig(config)])
        .filter(([name]) => !!name)
    )
    : {};

  const currentProvider = raw?.currentProvider?.trim().toLowerCase() || DEFAULT_PROVIDER;

  if (!providers[currentProvider]) {
    providers[currentProvider] = { ...DEFAULT_PROVIDER_CONFIG };
  }

  if (!providers[DEFAULT_PROVIDER]) {
    providers[DEFAULT_PROVIDER] = { ...DEFAULT_PROVIDER_CONFIG };
  }

  return {
    currentProvider,
    systemPrompt: raw?.systemPrompt?.trim() || "",
    providers,
  };
}

function getCurrentProviderConfig(config: DsConfig): ProviderConfig {
  return normalizeProviderConfig(config.providers[config.currentProvider]);
}

function getMatchedPrefix(text: string): string {
  return prefixes.find((prefix) => text.startsWith(prefix)) || text[0] || mainPrefix;
}

function getCommandPayload(text: string): string {
  const prefix = getMatchedPrefix(text);
  const rest = text.slice(prefix.length).trim();
  if (!rest) return "";
  const firstSpace = rest.indexOf(" ");
  if (firstSpace === -1) return "";
  return rest.slice(firstSpace + 1).trim();
}

function maskApiKey(apiKey: string): string {
  const value = apiKey.trim();
  if (!value) return "未配置";
  if (value.length <= 7) {
    return `${value[0] || "*"}***${value[value.length - 1] || "*"}`;
  }
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function getComparableId(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
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
  return getComparableId((msg as Api.Message & { senderId?: unknown }).senderId)
    || getComparableId((msg as Api.Message & { fromId?: unknown }).fromId);
}

function getMessageChatId(msg: Api.Message): string | undefined {
  return getComparableId((msg as Api.Message & { chatId?: unknown }).chatId)
    || getComparableId((msg as Api.Message & { peerId?: unknown }).peerId);
}

function getReplyToMsgId(msg: Api.Message): number | undefined {
  const replyTo = (msg as Api.Message & {
    replyTo?: { replyToMsgId?: number };
    replyToMsgId?: number;
  }).replyTo;
  return replyTo?.replyToMsgId ?? (msg as Api.Message & { replyToMsgId?: number }).replyToMsgId;
}

function truncateForTelegram(text: string): string {
  if (text.length <= TELEGRAM_TEXT_LIMIT) return text;
  return `${text.slice(0, TELEGRAM_TEXT_LIMIT)}\n\n…(输出过长，已截断)`;
}

function formatAiOutput(content: string): string {
  const body = content.trim() || "(无内容)";
  const truncatedBody = truncateForTelegram(body);
  return TelegramFormatter.markdownToHtml(truncatedBody);
}

function formatQuestionAndAnswer(question: string, model: string, answer: string): string {
  const safeQuestion = escapeHtml(question.trim());
  const renderedAnswer = formatAiOutput(answer);
  return `${safeQuestion}\n\n──────────\n\n🤖 <b>DeepSeek · ${escapeHtml(model)}</b>\n\n${renderedAnswer}`;
}

async function safeEditMessage(
  msg: Api.Message,
  text: string,
  parseMode?: "html"
): Promise<void> {
  if (parseMode) {
    await msg.edit({ text, parseMode }).catch(() => undefined);
    return;
  }
  await msg.edit({ text }).catch(() => undefined);
}

async function ensureSelfInvocation(msg: Api.Message): Promise<boolean> {
  if (msg.out) return true;
  if (!msg.client) return false;

  try {
    const me = await safeGetMe(msg.client);
    const ownerId = getComparableId(me?.id);
    const senderId = getMessageSenderId(msg);
    return !!ownerId && !!senderId && ownerId === senderId;
  } catch {
    return false;
  }
}

class DsConfigStore {
  private readonly dbPromise = JSONFilePreset<DsConfig>(CONFIG_PATH, DEFAULT_CONFIG);

  async get(): Promise<DsConfig> {
    const db = await this.dbPromise;
    const normalized = normalizeConfig(db.data);
    const changed = JSON.stringify(db.data) !== JSON.stringify(normalized);
    if (changed) {
      db.data = normalized;
      await db.write();
    }
    return normalized;
  }

  async set(patch: Partial<DsConfig>): Promise<DsConfig> {
    const db = await this.dbPromise;
    db.data = normalizeConfig({ ...db.data, ...patch });
    await db.write();
    return db.data;
  }

  async setProviderConfig(
    providerName: string,
    patch: Partial<ProviderConfig>
  ): Promise<DsConfig> {
    const db = await this.dbPromise;
    const normalized = normalizeConfig(db.data);
    const providerKey = providerName.trim().toLowerCase();
    normalized.providers[providerKey] = normalizeProviderConfig({
      ...normalized.providers[providerKey],
      ...patch,
    });
    db.data = normalized;
    await db.write();
    return db.data;
  }
}

async function waitForOwnerReply(params: {
  client: TelegramClient;
  promptMessage: Api.Message;
  lifecycle: GenerationContext;
  ownerId?: string;
  timeoutMs: number;
}): Promise<Api.Message> {
  const { client, promptMessage, lifecycle, ownerId, timeoutMs } = params;
  const expectedChatId = getMessageChatId(promptMessage);
  const expectedReplyId = promptMessage.id;

  return lifecycle.runTask(
    async (signal) =>
      await new Promise<Api.Message>((resolve, reject) => {
        let settled = false;
        const eventBuilder = new NewMessage({});
        let cleanup: (() => Promise<void>) | null = null;

        const finish = async (cb: () => void): Promise<void> => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (cleanup) {
            await cleanup().catch(() => undefined);
            cleanup = null;
          }
          cb();
        };

        const onAbort = (): void => {
          void finish(() => reject(new Error("等待设置 API Key 已取消")));
        };

        const handler = (event: NewMessageEvent): void => {
          const candidate = event.message;
          if (!candidate) return;
          if (ownerId && getMessageSenderId(candidate) !== ownerId) return;
          if (getMessageChatId(candidate) !== expectedChatId) return;
          if (getReplyToMsgId(candidate) !== expectedReplyId) return;
          void finish(() => resolve(candidate));
        };

        client.addEventHandler(handler, eventBuilder);
        const disposeListener = lifecycle.trackDisposable(
          () => client.removeEventHandler(handler, eventBuilder),
          { label: "ds:wait-owner-reply", kind: "handler" }
        );

        const timeout = lifecycle.setTimeout(() => {
          void finish(() => reject(new Error("等待设置 API Key 超时，请重新执行命令。")));
        }, timeoutMs, { label: "ds:wait-owner-reply-timeout" });

        cleanup = async () => {
          clearTimeout(timeout);
          await Promise.resolve(disposeListener()).catch(() => undefined);
        };

        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
        }
      }),
    { label: "ds:wait-owner-reply", kind: "conversation" }
  );
}

async function promptForApiKey(params: {
  commandMessage: Api.Message;
  lifecycle: GenerationContext;
  ownerId?: string;
}): Promise<string> {
  const { commandMessage, lifecycle, ownerId } = params;

  await safeEditMessage(
    commandMessage,
    [
      "🔐 当前 Provider 缺少 API Key。",
      "",
      "请直接回复这条消息发送你的 DeepSeek API Key。",
      `超时时间：${Math.floor(API_KEY_TIMEOUT_MS / 1000)} 秒`,
    ].join("\n")
  );

  const reply = await waitForOwnerReply({
    client: commandMessage.client!,
    promptMessage: commandMessage,
    lifecycle,
    ownerId,
    timeoutMs: API_KEY_TIMEOUT_MS,
  });

  const value = (reply.message || "").trim();
  if (!value) {
    throw new Error("收到的 API Key 为空，请重新执行命令。");
  }
  return value;
}

class DeepSeekProvider {
  readonly id = DEFAULT_PROVIDER;
  readonly displayName = "DeepSeek";

  private getEndpoint(baseURL: string): string {
    return `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  }

  async complete(providerConfig: ProviderConfig, messages: ChatMessage[]): Promise<string> {
    const response = await axios.post(
      this.getEndpoint(providerConfig.baseURL || DEFAULT_BASE_URL),
      {
        model: providerConfig.model || DEFAULT_MODEL,
        messages,
        stream: false,
      },
      {
        headers: {
          Authorization: `Bearer ${providerConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 60_000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content;
    }
    throw new Error("接口返回为空");
  }

  async stream(
    providerConfig: ProviderConfig,
    messages: ChatMessage[],
    onDelta: (text: string) => void
  ): Promise<void> {
    const response = await axios.post(
      this.getEndpoint(providerConfig.baseURL || DEFAULT_BASE_URL),
      {
        model: providerConfig.model || DEFAULT_MODEL,
        messages,
        stream: true,
      },
      {
        headers: {
          Authorization: `Bearer ${providerConfig.apiKey}`,
          "Content-Type": "application/json",
        },
        responseType: "stream",
        timeout: 120_000,
      }
    );

    await new Promise<void>((resolve, reject) => {
      let buffer = "";
      const stream: NodeJS.ReadableStream = response.data;

      const processLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") return;

        try {
          const parsed = JSON.parse(payload);
          const choice = parsed?.choices?.[0];
          const delta = choice?.delta?.content;
          if (typeof delta === "string" && delta) {
            onDelta(delta);
          }
        } catch {
          // ignore partial or non-JSON lines
        }
      };

      stream.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          processLine(line);
          newlineIndex = buffer.indexOf("\n");
        }
      });

      stream.on("end", () => {
        if (buffer.trim()) {
          processLine(buffer);
        }
        resolve();
      });

      stream.on("error", (error) => reject(error));
    });
  }
}

const implementedProviders = {
  [DEFAULT_PROVIDER]: new DeepSeekProvider(),
};

function buildUserPrompt(question: string, repliedText?: string): string {
  if (repliedText && question) {
    return `被回复消息：\n${repliedText}\n\n当前问题：\n${question}`;
  }
  if (repliedText) {
    return repliedText;
  }
  return question;
}

class DsPlugin extends Plugin {
  name = PLUGIN_NAME;
  description =
    `DeepSeek 对话插件\n` +
    `<code>${mainPrefix}ds [问题]</code> - 直接提问\n` +
    `<code>${mainPrefix}ds status</code> - 查看当前配置\n` +
    `<code>${mainPrefix}ds config</code> - 查看格式化配置\n` +
    `<code>${mainPrefix}ds test</code> - 测试当前 Provider\n` +
    `<code>${mainPrefix}ds provider list</code> - 列出当前可用 Provider\n` +
    `<code>${mainPrefix}ds provider set deepseek</code> - 切换 Provider，缺 API Key 时会交互补录\n` +
    `<code>${mainPrefix}ds model set ${DEFAULT_MODEL}</code> - 设置默认模型\n` +
    `<code>${mainPrefix}ds prompt show</code> - 查看系统提示词\n` +
    `<code>${mainPrefix}ds prompt set 你是一个助手</code> - 设置系统提示词\n` +
    `<code>${mainPrefix}ds prompt clear</code> - 清空系统提示词\n` +
    `<code>${mainPrefix}ds help</code> - 查看帮助`;

  cmdHandlers: Record<
    string,
    (msg: Api.Message, trigger?: Api.Message) => Promise<void>
  > = {
    ds: async (msg, trigger) => {
      if (!(await ensureSelfInvocation(msg))) {
        return;
      }

      await this.handleDs(msg, trigger);
    },
  };

  private readonly configStore = new DsConfigStore();
  private lifecycle: GenerationContext | null = null;

  setup(context: PluginRuntimeContext): void {
    this.lifecycle = context.lifecycle;
  }

  cleanup(): void {
    this.lifecycle = null;
  }

  private requireLifecycle(): GenerationContext {
    if (!this.lifecycle) {
      throw new Error("DS 插件尚未初始化");
    }
    return this.lifecycle;
  }

  private async handleDs(msg: Api.Message, trigger?: Api.Message): Promise<void> {
    const payload = getCommandPayload(msg.message || "");
    const [first = "", second = ""] = payload.split(/\s+/);
    const lowerFirst = first.toLowerCase();
    const lowerSecond = second.toLowerCase();

    if (lowerFirst === "help") {
      await this.handleHelp(msg);
      return;
    }

    if (lowerFirst === "status") {
      await this.handleStatus(msg);
      return;
    }

    if (lowerFirst === "config") {
      await this.handleConfig(msg);
      return;
    }

    if (lowerFirst === "test") {
      await this.handleTest(msg);
      return;
    }

    if (lowerFirst === "provider") {
      await this.handleProvider(msg, lowerSecond, payload);
      return;
    }

    if (lowerFirst === "model") {
      await this.handleModel(msg, lowerSecond, payload);
      return;
    }

    if (lowerFirst === "prompt") {
      await this.handlePrompt(msg, lowerSecond, payload);
      return;
    }

    await this.handleAsk(msg, payload);
  }

  private async handleHelp(msg: Api.Message): Promise<void> {
    await safeEditMessage(msg, this.description, "html");
  }

  private async handleStatus(msg: Api.Message): Promise<void> {
    const config = await this.configStore.get();
    const providerConfig = getCurrentProviderConfig(config);
    const text = [
      "🤖 <b>DS 当前状态</b>",
      `• Provider: <code>${escapeHtml(config.currentProvider)}</code>`,
      `• Base URL: <code>${escapeHtml(providerConfig.baseURL || DEFAULT_BASE_URL)}</code>`,
      `• Model: <code>${escapeHtml(providerConfig.model || DEFAULT_MODEL)}</code>`,
      `• API Key: <code>${escapeHtml(maskApiKey(providerConfig.apiKey))}</code>`,
      `• System Prompt: ${
        config.systemPrompt
          ? `<code>${escapeHtml(truncateForTelegram(config.systemPrompt))}</code>`
          : "未设置"
      }`,
    ].join("\n");
    await safeEditMessage(msg, text, "html");
  }

  private async handleConfig(msg: Api.Message): Promise<void> {
    const config = await this.configStore.get();
    const maskedConfig: DsConfig = {
      currentProvider: config.currentProvider,
      systemPrompt: config.systemPrompt,
      providers: Object.fromEntries(
        Object.entries(config.providers).map(([name, providerConfig]) => [
          name,
          {
            ...normalizeProviderConfig(providerConfig),
            apiKey: maskApiKey(providerConfig.apiKey),
          },
        ])
      ),
    };

    const pretty = JSON.stringify(maskedConfig, null, 2);
    await safeEditMessage(
      msg,
      `⚙️ <b>DS Config</b>\n<pre>${escapeHtml(truncateForTelegram(pretty))}</pre>`,
      "html"
    );
  }

  private async handleProvider(
    msg: Api.Message,
    subCommand: string,
    payload: string
  ): Promise<void> {
    if (subCommand === "list") {
      const config = await this.configStore.get();
      const lines = Object.values(implementedProviders).map((provider) => {
        const providerConfig = normalizeProviderConfig(config.providers[provider.id]);
        const current = config.currentProvider === provider.id ? "✅ 当前" : "•";
        const status = providerConfig.apiKey ? "已配置 Key" : "未配置 Key";
        return `${current} <code>${escapeHtml(provider.id)}</code> - ${provider.displayName} (${status})`;
      });
      await safeEditMessage(msg, `🧩 <b>可用 Provider</b>\n${lines.join("\n")}`, "html");
      return;
    }

    if (subCommand === "set") {
      const target = payload.split(/\s+/)[2]?.trim().toLowerCase();
      if (!target) {
        await safeEditMessage(
          msg,
          `用法：<code>${escapeHtml(mainPrefix)}ds provider set ${DEFAULT_PROVIDER}</code>`,
          "html"
        );
        return;
      }

      const provider = implementedProviders[target as keyof typeof implementedProviders];
      if (!provider) {
        await safeEditMessage(msg, `❌ Provider <code>${escapeHtml(target)}</code> 尚未实现。`, "html");
        return;
      }

      let config = await this.configStore.get();
      let providerConfig = normalizeProviderConfig(config.providers[provider.id]);
      if (!providerConfig.apiKey) {
        const me = msg.client ? await safeGetMe(msg.client) : undefined;
        const ownerId = getComparableId(me?.id) || getMessageSenderId(msg);
        const apiKey = await promptForApiKey({
          commandMessage: msg,
          lifecycle: this.requireLifecycle(),
          ownerId,
        });
        config = await this.configStore.setProviderConfig(provider.id, { apiKey });
        providerConfig = getCurrentProviderConfig({
          ...config,
          currentProvider: provider.id,
        });
      }

      config = await this.configStore.set({ currentProvider: provider.id });
      providerConfig = normalizeProviderConfig(config.providers[provider.id]);
      await safeEditMessage(
        msg,
        [
          `✅ Provider 已切换为 <code>${escapeHtml(provider.id)}</code>`,
          `API Key: <code>${escapeHtml(maskApiKey(providerConfig.apiKey))}</code>`,
          `Model: <code>${escapeHtml(providerConfig.model)}</code>`,
        ].join("\n"),
        "html"
      );
      return;
    }

    await safeEditMessage(
      msg,
      `用法：<code>${escapeHtml(mainPrefix)}ds provider list</code>\n<code>${escapeHtml(mainPrefix)}ds provider set ${DEFAULT_PROVIDER}</code>`,
      "html"
    );
  }

  private async handleModel(msg: Api.Message, subCommand: string, payload: string): Promise<void> {
    if (subCommand !== "set") {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds model set ${DEFAULT_MODEL}</code>`,
        "html"
      );
      return;
    }

    const model = payload.replace(/^model\s+set\s+/i, "").trim();
    if (!model) {
      await safeEditMessage(
        msg,
        `用法：<code>${escapeHtml(mainPrefix)}ds model set ${DEFAULT_MODEL}</code>`,
        "html"
      );
      return;
    }

    const current = await this.configStore.get();
    const config = await this.configStore.setProviderConfig(current.currentProvider, { model });
    const providerConfig = getCurrentProviderConfig(config);
    await safeEditMessage(
      msg,
      `✅ <code>${escapeHtml(config.currentProvider)}</code> 的默认模型已设置为 <code>${escapeHtml(providerConfig.model)}</code>`,
      "html"
    );
  }

  private async handlePrompt(msg: Api.Message, subCommand: string, payload: string): Promise<void> {
    if (subCommand === "show") {
      const config = await this.configStore.get();
      await safeEditMessage(
        msg,
        config.systemPrompt
          ? `📝 <b>当前 System Prompt</b>\n<code>${escapeHtml(config.systemPrompt)}</code>`
          : "📝 当前未设置 System Prompt。",
        config.systemPrompt ? "html" : undefined
      );
      return;
    }

    if (subCommand === "clear") {
      await this.configStore.set({ systemPrompt: "" });
      await safeEditMessage(msg, "✅ System Prompt 已清空。");
      return;
    }

    if (subCommand === "set") {
      const prompt = payload.replace(/^prompt\s+set\s+/i, "").trim();
      if (!prompt) {
        await safeEditMessage(
          msg,
          `用法：<code>${escapeHtml(mainPrefix)}ds prompt set 你是一个简洁的助手</code>`,
          "html"
        );
        return;
      }
      await this.configStore.set({ systemPrompt: prompt });
      await safeEditMessage(msg, "✅ System Prompt 已更新。");
      return;
    }

    await safeEditMessage(
      msg,
      [
        `用法：<code>${escapeHtml(mainPrefix)}ds prompt show</code>`,
        `<code>${escapeHtml(mainPrefix)}ds prompt set 你是一个简洁的助手</code>`,
        `<code>${escapeHtml(mainPrefix)}ds prompt clear</code>`,
      ].join("\n"),
      "html"
    );
  }

  private async handleTest(msg: Api.Message): Promise<void> {
    const config = await this.configStore.get();
    const provider = implementedProviders[config.currentProvider as keyof typeof implementedProviders];
    const providerConfig = getCurrentProviderConfig(config);
    if (!provider) {
      await safeEditMessage(msg, `❌ 当前 Provider <code>${escapeHtml(config.currentProvider)}</code> 不可用。`, "html");
      return;
    }
    if (!providerConfig.apiKey) {
      await safeEditMessage(
        msg,
        `❌ 当前 Provider 未配置 API Key，请先执行 <code>${escapeHtml(mainPrefix)}ds provider set ${escapeHtml(config.currentProvider)}</code>。`,
        "html"
      );
      return;
    }

    await safeEditMessage(msg, "🧪 正在测试当前 Provider…");
    const messages: ChatMessage[] = [
      { role: "user", content: "请回复“测试成功”四个字。" },
    ];

    const result = await provider.complete(providerConfig, messages);
    await safeEditMessage(
      msg,
      `✅ 测试成功\n\n${truncateForTelegram(result)}`
    );
  }

  private async handleAsk(msg: Api.Message, payload: string): Promise<void> {
    const config = await this.configStore.get();
    const provider = implementedProviders[config.currentProvider as keyof typeof implementedProviders];
    const providerConfig = getCurrentProviderConfig(config);
    if (!provider) {
      await safeEditMessage(msg, `❌ 当前 Provider <code>${escapeHtml(config.currentProvider)}</code> 不可用。`, "html");
      return;
    }
    if (!providerConfig.apiKey) {
      await safeEditMessage(
        msg,
        `❌ 当前 Provider 未配置 API Key，请先执行 <code>${escapeHtml(mainPrefix)}ds provider set ${escapeHtml(config.currentProvider)}</code>。`,
        "html"
      );
      return;
    }

    const replied = await safeGetReplyMessage(msg);
    const repliedText = (replied?.message || "").trim();
    const question = payload.trim();
    const shouldPreserveQuestion = question.length > 0;

    if (!repliedText && !question) {
      await safeEditMessage(
        msg,
        `❌ 用法错误：请直接提问，或回复一条消息后再发送 <code>${escapeHtml(mainPrefix)}ds</code>。`,
        "html"
      );
      return;
    }

    if (replied && !repliedText) {
      await safeEditMessage(msg, "❌ 被回复的消息没有可用文本。");
      return;
    }

    const messages: ChatMessage[] = [];
    if (config.systemPrompt) {
      messages.push({ role: "system", content: config.systemPrompt });
    }
    messages.push({
      role: "user",
      content: buildUserPrompt(question, repliedText || undefined),
    });

    if (shouldPreserveQuestion) {
      await safeEditMessage(
        msg,
        `${escapeHtml(question)}\n\n──────────\n\n思考中…`,
        "html"
      );
    } else {
      await safeEditMessage(msg, `🤖 正在请求 DeepSeek (${providerConfig.model})…`);
    }

    let combined = "";
    let lastEditAt = 0;
    let renderChain = Promise.resolve();

    const flush = async (force = false): Promise<void> => {
      if (!force && Date.now() - lastEditAt < STREAM_EDIT_INTERVAL_MS) return;
      lastEditAt = Date.now();
      const rendered = shouldPreserveQuestion
        ? formatQuestionAndAnswer(question, providerConfig.model, combined)
        : formatAiOutput(combined);
      await safeEditMessage(msg, rendered, "html");
    };

    await provider.stream(providerConfig, messages, (delta) => {
      combined += delta;
      renderChain = renderChain.then(() => flush(false)).catch(() => undefined);
    });

    await renderChain;
    await flush(true);
  }
}

export default new DsPlugin();
