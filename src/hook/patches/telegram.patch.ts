import { Api } from "teleproto/tl";
import * as TeleprotoHelpers from "teleproto/Helpers";

const { HTMLParser } = require("teleproto/extensions/html");
const mutableTeleprotoHelpers = require("teleproto/Helpers") as any;
const MAX_SAFE_TIMEOUT_MS = 2147483647;

const ENTITY_SENTINELS = {
  lt: "\uE000",
  gt: "\uE001",
  amp: "\uE002",
  quot: "\uE003",
  apos: "\uE004",
} as const;

function protectHtmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, ENTITY_SENTINELS.lt)
    .replace(/&gt;/g, ENTITY_SENTINELS.gt)
    .replace(/&quot;/g, ENTITY_SENTINELS.quot)
    .replace(/&#39;/g, ENTITY_SENTINELS.apos)
    .replace(/&amp;/g, ENTITY_SENTINELS.amp);
}

function restoreHtmlEntities(input: string): string {
  return input
    .replace(new RegExp(ENTITY_SENTINELS.lt, "g"), "<")
    .replace(new RegExp(ENTITY_SENTINELS.gt, "g"), ">")
    .replace(new RegExp(ENTITY_SENTINELS.quot, "g"), '"')
    .replace(new RegExp(ENTITY_SENTINELS.apos, "g"), "'")
    .replace(new RegExp(ENTITY_SENTINELS.amp, "g"), "&");
}

const originalHtmlParse = HTMLParser.parse.bind(HTMLParser);

HTMLParser.parse = function patchedHtmlParse(html: string) {
  const [text, entities] = originalHtmlParse(protectHtmlEntities(html));
  return [restoreHtmlEntities(text), entities];
};

const originalSleep = TeleprotoHelpers.sleep.bind(TeleprotoHelpers);

function clampTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  if (ms <= 0) return 0;
  return Math.min(ms, MAX_SAFE_TIMEOUT_MS);
}

mutableTeleprotoHelpers.sleep = function patchedSleep(
  ms: number,
  isUnref = false
) {
  return originalSleep(clampTimeoutMs(ms), isUnref);
};

Api.Message.prototype.deleteWithDelay = async function (
  delay: number,
  shouldThrowError: boolean
) {
  await TeleprotoHelpers.sleep(delay);
  try {
    return this.delete();
  } catch (e) {
    console.error(e);
    if (shouldThrowError) {
      throw e;
    }
  }
};

Api.Message.prototype.safeDelete = async function (
  { revoke }: { revoke: boolean } = { revoke: false }
) {
  try {
    return this.delete({ revoke });
  } catch (error) {
    console.log("safeDelete catch error:", error);
  }
};
