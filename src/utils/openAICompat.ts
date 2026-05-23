import axios from "axios";

type OpenAICompatMessage =
  | {
      role: "system" | "user" | "assistant" | "tool";
      content: unknown;
    }
  | Record<string, unknown>;

type OpenAICompatRequestOptions = {
  baseURL: string;
  apiKey: string;
  model: string;
  messages: OpenAICompatMessage[];
  extraBody?: Record<string, unknown>;
  timeout?: number;
};

function buildEndpoint(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/chat/completions`;
}

function buildPayload(options: OpenAICompatRequestOptions, stream: boolean): Record<string, unknown> {
  return {
    model: options.model,
    messages: options.messages,
    stream,
    ...(options.extraBody || {}),
  };
}

async function createChatCompletion(options: OpenAICompatRequestOptions): Promise<unknown> {
  const response = await axios.post(
    buildEndpoint(options.baseURL),
    buildPayload(options, false),
    {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: options.timeout ?? 60_000,
    },
  );

  return response.data;
}

async function streamChatCompletion(
  options: OpenAICompatRequestOptions,
  onDelta: (text: string) => void,
): Promise<void> {
  const response = await axios.post(
    buildEndpoint(options.baseURL),
    buildPayload(options, true),
    {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      responseType: "stream",
      timeout: options.timeout ?? 120_000,
    },
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
        const delta = parsed?.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch {
        // ignore partial JSON chunks
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
      if (buffer.trim()) processLine(buffer);
      resolve();
    });

    stream.on("error", reject);
  });
}

export {
  createChatCompletion,
  streamChatCompletion,
  type OpenAICompatMessage,
  type OpenAICompatRequestOptions,
};
