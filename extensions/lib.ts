/**
 * pi-autoname pure utility functions.
 * Extracted for testability — no side effects, no fs, no network.
 */

/** A name this short was likely a failed AI response */
export const MIN_NAME_LENGTH = 3;

/** Default max length for a session name — anything longer is likely a raw sentence */
export const MAX_NAME_LENGTH = 30;

export const MIN_CONFIG_NAME_LENGTH = MIN_NAME_LENGTH;
export const MAX_CONFIG_NAME_LENGTH = 120;

/** Names matching this pattern are raw-slice fallbacks (bad) */
export const RAW_SLICE_RE =
  /^(?:我|你|他|她|它|请|帮|能|可|可以|能不能|请帮|感觉|突然|我想|我想知道|有没有|是不是|为什么|怎么|如何|What|Can|Could|Please|Help|I want|I need|Is there|Why|How)/;

/** Sentence-ending punctuation — a real session name should not contain these */
export const SENTENCE_END_RE = /[。！？!?.…]+\s*$/;

export const MIN_COOLDOWN_MINUTES = 1;
export const MAX_COOLDOWN_MINUTES = 24 * 60;

export const SENSITIVE_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: "[REDACTED_PRIVATE_KEY]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[REDACTED_AWS_KEY]" },
  { re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: "[REDACTED_API_KEY]" },
  { re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi, replacement: "$1[REDACTED]" },
  { re: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*(?:"[^"]*"|'[^']*'|[^"'\s,;]+)/g, replacement: "$1=[REDACTED]" },
  { re: /\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^"'\s,;]+)/gi, replacement: "$1=[REDACTED]" },
];

export interface AutonameConfig {
  enabled?: boolean;
  model?: string;
  fallbackModels?: string[];
  cooldownMinutes?: number;
  debug?: boolean;
  /** Локаль для названия. Пустая строка включает PI_LOCALE, LC_ALL или LANG. */
  locale?: string;
  /** Max accepted generated name length, in characters. */
  maxNameLength?: number;
  /** Extra instruction appended to the naming prompt. */
  promptExtra?: string;
  /** Optional regex. First capture group, or the full match, is forced as the name prefix. */
  ticketPattern?: string;
  /**
   * When `false` (default), pi-autoname owns session naming:
   * automatic naming runs on first dialogue and periodically
   * (every `cooldownMinutes`), and may overwrite a name the
   * user set via `/name` or `/autoname`. The only escape hatch
   * is `respectManualName: true`, which preserves the legacy
   * behavior of treating a user-issued rename as sticky.
   *
   * Note: with the default behavior, Pi's built-in `/name`
   * command is largely redundant — prefer `/autoname` if you
   * want to force a re-name from the current conversation.
   */
  respectManualName?: boolean;
}

export const DEFAULT_CONFIG: Required<AutonameConfig> = {
  enabled: true,
  model: "",
  fallbackModels: [],
  cooldownMinutes: 10,
  debug: false,
  locale: "",
  maxNameLength: MAX_NAME_LENGTH,
  promptExtra: "",
  ticketPattern: "",
  respectManualName: false,
};

export function normalizeConfig(input: unknown): AutonameConfig {
  if (!input || typeof input !== "object") return { ...DEFAULT_CONFIG };

  const raw = input as Record<string, unknown>;
  const cooldown =
    typeof raw.cooldownMinutes === "number" && Number.isFinite(raw.cooldownMinutes)
      ? Math.min(MAX_COOLDOWN_MINUTES, Math.max(MIN_COOLDOWN_MINUTES, raw.cooldownMinutes))
      : DEFAULT_CONFIG.cooldownMinutes;
  const maxNameLength =
    typeof raw.maxNameLength === "number" && Number.isFinite(raw.maxNameLength)
      ? Math.min(MAX_CONFIG_NAME_LENGTH, Math.max(MIN_CONFIG_NAME_LENGTH, Math.floor(raw.maxNameLength)))
      : DEFAULT_CONFIG.maxNameLength;

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    model: typeof raw.model === "string" ? raw.model.trim() : DEFAULT_CONFIG.model,
    fallbackModels: Array.isArray(raw.fallbackModels)
      ? raw.fallbackModels
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      : [...DEFAULT_CONFIG.fallbackModels],
    cooldownMinutes: cooldown,
    debug: typeof raw.debug === "boolean" ? raw.debug : DEFAULT_CONFIG.debug,
    locale: typeof raw.locale === "string" ? raw.locale.trim() : DEFAULT_CONFIG.locale,
    maxNameLength,
    promptExtra: typeof raw.promptExtra === "string" ? raw.promptExtra.trim() : DEFAULT_CONFIG.promptExtra,
    ticketPattern: typeof raw.ticketPattern === "string" ? raw.ticketPattern.trim() : DEFAULT_CONFIG.ticketPattern,
    respectManualName:
      typeof raw.respectManualName === "boolean" ? raw.respectManualName : DEFAULT_CONFIG.respectManualName,
  };
}

export function redactSensitiveText(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let output = text;

  for (const { re, replacement } of SENSITIVE_PATTERNS) {
    output = output.replace(re, (...args) => {
      redacted = true;
      return replacement.replace(/\$(\d+)/g, (_, index) => String(args[Number(index)] ?? ""));
    });
  }

  return { text: output, redacted };
}

export function isHighQualityName(name: string, maxNameLength = MAX_NAME_LENGTH): boolean {
  if (name.length < MIN_NAME_LENGTH || name.length > maxNameLength) return false;
  if (RAW_SLICE_RE.test(name)) return false;
  if (SENTENCE_END_RE.test(name)) return false;
  if ((name.match(/[，,。！？!?]/g) || []).length > 1) return false;
  return /[\p{L}\p{N}]/u.test(name);
}

export function compileTicketPattern(pattern: string | undefined): RegExp | undefined {
  if (!pattern) return undefined;
  try {
    return new RegExp(pattern, "iu");
  } catch {
    return undefined;
  }
}

/** Возвращает единственный тикет только из пользовательских сообщений. */
export function extractTicketPrefix(
  parts: Array<{ role: string; text: string }>,
  ticketPattern: string | undefined,
): string | undefined {
  const pattern = compileTicketPattern(ticketPattern);
  if (!pattern) return undefined;

  const candidates = new Set<string>();
  const globalPattern = new RegExp(pattern.source, `${pattern.flags}g`);
  const userText = parts
    .filter((part) => part.role === "user")
    .map((part) => part.text)
    .join("\n");

  for (const match of userText.matchAll(globalPattern)) {
    const candidate = (match[1] ?? match[0])?.trim();
    if (candidate) candidates.add(candidate.toUpperCase());
  }

  return candidates.size === 1 ? candidates.values().next().value : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function withTicketPrefix(name: string, ticketPrefix: string | undefined): string {
  if (!ticketPrefix) return name;
  const duplicatePrefix = new RegExp(`^${escapeRegExp(ticketPrefix)}[\\s:–—-]*`, "iu");
  return `${ticketPrefix} ${name.replace(duplicatePrefix, "").trim()}`.trim();
}

/** Удаляет недоверенный тикет в начале имени, созданного моделью. */
export function withoutTicketPrefix(name: string, ticketPattern: string | undefined): string {
  const pattern = compileTicketPattern(ticketPattern);
  if (!pattern) return name;

  const match = name.match(pattern);
  if (!match || match.index !== 0) return name;
  return name.slice(match[0].length).replace(/^[\s:–—-]+/, "").trim();
}

export function blockText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ")
    .trim();
}

export function smartFallbackName(text: string): string {
  let s = text.slice(0, 200).replace(/\n/g, " ").trim();

  s = s
    .replace(
      /^(?:我(?:觉得|感觉|发现|想要|想知道|怀疑)?\s*|你(?:能|可以|帮)\s*(?:我\s*)?|请(?:你|帮我)?\s*|Can you\s*(?:please\s*)?|Could you\s*(?:please\s*)?|Please\s*(?:help me\s*)?|I\s*(?:think|feel|want|need|noticed)\s*(?:that\s*)?|Is it possible to\s*|I wonder if\s*|I'm wondering about\s*)/i,
      "",
    )
    .trim();

  const sentenceEnd = s.match(/[.!?。！？]/);
  if (sentenceEnd && sentenceEnd.index! < MAX_NAME_LENGTH) {
    s = s.slice(0, sentenceEnd.index! + 1);
  } else if (s.length > MAX_NAME_LENGTH) {
    const cut = s.lastIndexOf(" ", MAX_NAME_LENGTH);
    s = cut > 10 ? s.slice(0, cut) : s.slice(0, MAX_NAME_LENGTH);
  }

  s = s.replace(/(?:吗|呢|吧|啊|呀|哦|嘛|的|了|着|过)[\s,，.。]*$/, "").trim();
  s = s.replace(/[。！？!?.…]+\s*$/, "").trim();

  return s || text.slice(0, MAX_NAME_LENGTH).replace(/\n/g, " ").trim();
}
/** Сохранённое состояние переименования с закреплённым тикетом сессии. */
export type RenameMarker =
  | { kind: "ai"; name: string; source: "ai"; timestamp: number; ticketPrefix?: string }
  | { kind: "fallback"; name: string; source: "fallback"; timestamp: number; ticketPrefix?: string }
  | { kind: "user_rename"; name: string; timestamp: number; ticketPrefix?: string };

/**
 * Parse a single `pi-autoname-state` entry's `data` payload into a typed
 * RenameMarker. Returns undefined when the payload doesn't match any
 * known shape (e.g. legacy entries from older versions, or corrupted
 * data). When parsing the timestamp, defaults to 0 if missing/invalid
 * so that the marker is still useful for relative ordering.
 */
export function parseRenameMarker(data: unknown): RenameMarker | undefined {
  if (!data || typeof data !== "object") return undefined;
  const obj = data as Record<string, unknown>;

  const ticketPrefix =
    typeof obj.ticketPrefix === "string" && obj.ticketPrefix.trim()
      ? obj.ticketPrefix.trim()
      : undefined;

  // user_rename flavor — written by agent_end when it detects a /name
  // out-of-band change.
  if (obj.event === "user_rename" && typeof obj.name === "string") {
    return {
      kind: "user_rename",
      name: obj.name,
      timestamp: typeof obj.timestamp === "number" ? obj.timestamp : 0,
      ...(ticketPrefix ? { ticketPrefix } : {}),
    };
  }

  // ai / fallback flavor — written after a successful naming pass.
  if (obj.source === "ai" && typeof obj.name === "string") {
    return {
      kind: "ai",
      name: obj.name,
      source: "ai",
      timestamp: typeof obj.timestamp === "number" ? obj.timestamp : 0,
      ...(ticketPrefix ? { ticketPrefix } : {}),
    };
  }
  if (obj.source === "fallback" && typeof obj.name === "string") {
    return {
      kind: "fallback",
      name: obj.name,
      source: "fallback",
      timestamp: typeof obj.timestamp === "number" ? obj.timestamp : 0,
      ...(ticketPrefix ? { ticketPrefix } : {}),
    };
  }

  return undefined;
}

/** Определяет, разрешено ли автоматическое переименование при ручном имени. */
export function shouldRunAutomaticRename(
  respectManualName: boolean,
  currentNameKind: RenameMarker["kind"] | undefined,
 ): boolean {
  if (!respectManualName) return true;
  return currentNameKind !== "user_rename";
}

export function getFirstDialogue(branch: any[]) {
  let firstUser: string | undefined;
  let firstAssistant: string | undefined;

  for (const entry of branch) {
    if (entry?.type === "message" && entry.message) {
      const role = entry.message.role;
      const text = blockText(entry.message.content);
      if (!text) continue;
      if (!firstUser && role === "user") firstUser = text;
      if (firstUser && !firstAssistant && role === "assistant") {
        firstAssistant = text;
        break;
      }
    }

    if (entry?.type === "compaction" && !firstUser) {
      const summary = blockText(entry.summary ?? entry.content);
      if (summary) firstUser = summary;
    }
  }

  return { firstUser, firstAssistant };
}

export function getRecentDialogue(branch: any[], maxMessages = 6) {
  const items: Array<{ role: string; text: string }> = [];
  for (const entry of branch) {
    if (entry?.type === "message" && entry.message) {
      const role = entry.message.role;
      if (role !== "user" && role !== "assistant") continue;
      const text = blockText(entry.message.content);
      if (!text) continue;
      items.push({ role, text });
    }
  }
  return items.slice(-maxMessages);
}
