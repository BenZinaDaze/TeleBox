import { Api } from "teleproto";

type CommandSource = Api.Message | string;

type ParsedCommandInput = {
  prefix: string;
  command: string;
  body: string;
  args: string[];
  text: string;
};

type CliOptionSpec = {
  name: string;
  aliases: string[];
  kind: "boolean" | "string";
  multiple?: boolean;
};

type ParsedCliOptions = {
  tokens: string[];
  positionals: string[];
  options: Record<string, boolean | string | string[] | undefined>;
  unknownFlags: string[];
  missingValueFlags: string[];
};

function getMessageText(source: CommandSource): string {
  if (typeof source === "string") return source;
  return source.message || source.text || "";
}

function tokenizeCliArgs(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  const flush = () => {
    if (!current) return;
    tokens.push(current);
    current = "";
  };

  for (const char of text) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      flush();
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  flush();

  return tokens;
}

function getPluginManagerModule(): {
  getCommandFromMessage: (msg: Api.Message | string, diyPrefixes?: string[]) => string | null;
  getPrefixes: () => string[];
} {
  return require("@utils/pluginManager");
}

function parseCommandInput(
  source: CommandSource,
  diyPrefixes?: string[],
): ParsedCommandInput | null {
  const text = getMessageText(source);
  if (!text) return null;

  const { getCommandFromMessage, getPrefixes } = getPluginManagerModule();
  const prefixes = diyPrefixes?.length ? diyPrefixes : getPrefixes();
  const prefix = prefixes.find((candidate) => text.startsWith(candidate));
  if (!prefix) return null;

  const command = getCommandFromMessage(text, diyPrefixes);
  if (!command) return null;

  const rest = text.slice(prefix.length).trim();
  let body = rest;
  for (const token of command.split(/\s+/).filter(Boolean)) {
    if (!body.startsWith(token)) {
      break;
    }
    body = body.slice(token.length).trimStart();
  }

  return {
    prefix,
    command,
    body,
    args: tokenizeCliArgs(body),
    text,
  };
}

function parseCliOptions(
  tokens: string[],
  specs: CliOptionSpec[],
): ParsedCliOptions {
  const aliasMap = new Map<string, CliOptionSpec>();
  const options: ParsedCliOptions["options"] = {};
  for (const spec of specs) {
    for (const alias of spec.aliases) {
      aliasMap.set(alias, spec);
    }
    options[spec.name] = spec.kind === "boolean"
      ? false
      : (spec.multiple ? [] : undefined);
  }

  const positionals: string[] = [];
  const unknownFlags: string[] = [];
  const missingValueFlags: string[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const [flagAlias, inlineValue] = token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, undefined];

    const spec = aliasMap.get(flagAlias);
    if (!spec) {
      unknownFlags.push(token);
      positionals.push(token);
      continue;
    }

    if (spec.kind === "boolean") {
      options[spec.name] = true;
      continue;
    }

    const value = inlineValue ?? tokens[index + 1];
    if (value == null) {
      missingValueFlags.push(flagAlias);
      continue;
    }

    if (inlineValue == null) {
      index += 1;
    }

    if (spec.multiple) {
      const list = Array.isArray(options[spec.name])
        ? options[spec.name] as string[]
        : [];
      list.push(value);
      options[spec.name] = list;
      continue;
    }

    options[spec.name] = value;
  }

  return {
    tokens: [...tokens],
    positionals,
    options,
    unknownFlags,
    missingValueFlags,
  };
}

export {
  parseCliOptions,
  parseCommandInput,
  tokenizeCliArgs,
  type CliOptionSpec,
  type ParsedCliOptions,
  type ParsedCommandInput,
};
