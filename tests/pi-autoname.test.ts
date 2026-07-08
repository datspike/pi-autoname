import { describe, it, expect } from "vitest";
import {
  normalizeConfig,
  redactSensitiveText,
  isHighQualityName,
  extractTicketPrefix,
  withTicketPrefix,
  blockText,
  smartFallbackName,
  getFirstDialogue,
  getRecentDialogue,
  parseRenameMarker,
  DEFAULT_CONFIG,
  MIN_NAME_LENGTH,
  MAX_NAME_LENGTH,
  MIN_COOLDOWN_MINUTES,
  MAX_COOLDOWN_MINUTES,
  MIN_CONFIG_NAME_LENGTH,
  MAX_CONFIG_NAME_LENGTH,
} from "../extensions/lib.js";

// ---------------------------------------------------------------------------
// normalizeConfig
// ---------------------------------------------------------------------------
describe("normalizeConfig", () => {
  it("returns defaults for null/undefined/empty", () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig("bad")).toEqual(DEFAULT_CONFIG);
  });

  it("preserves valid fields", () => {
    const result = normalizeConfig({
      enabled: false,
      model: "openai/gpt-4o",
      fallbackModels: ["anthropic/claude-3"],
      cooldownMinutes: 5,
      debug: true,
      maxNameLength: 80,
      promptExtra: "  Prefer work-ticket prefixes  ",
      ticketPattern: "  \\b([A-Z]+-\\d+)\\b  ",
      respectManualName: false,
    });
    expect(result.enabled).toBe(false);
    expect(result.model).toBe("openai/gpt-4o");
    expect(result.fallbackModels).toEqual(["anthropic/claude-3"]);
    expect(result.cooldownMinutes).toBe(5);
    expect(result.debug).toBe(true);
    expect(result.maxNameLength).toBe(80);
    expect(result.promptExtra).toBe("Prefer work-ticket prefixes");
    expect(result.ticketPattern).toBe("\\b([A-Z]+-\\d+)\\b");
    expect(result.respectManualName).toBe(false);
  });

  it("clamps cooldownMinutes to valid range", () => {
    expect(normalizeConfig({ cooldownMinutes: -10 }).cooldownMinutes).toBe(MIN_COOLDOWN_MINUTES);
    expect(normalizeConfig({ cooldownMinutes: 0 }).cooldownMinutes).toBe(MIN_COOLDOWN_MINUTES);
    expect(normalizeConfig({ cooldownMinutes: 2000 }).cooldownMinutes).toBe(MAX_COOLDOWN_MINUTES);
    expect(normalizeConfig({ cooldownMinutes: NaN }).cooldownMinutes).toBe(DEFAULT_CONFIG.cooldownMinutes);
    expect(normalizeConfig({ cooldownMinutes: Infinity }).cooldownMinutes).toBe(DEFAULT_CONFIG.cooldownMinutes);
  });

  it("clamps maxNameLength to valid range", () => {
    expect(normalizeConfig({ maxNameLength: -10 }).maxNameLength).toBe(MIN_CONFIG_NAME_LENGTH);
    expect(normalizeConfig({ maxNameLength: 0 }).maxNameLength).toBe(MIN_CONFIG_NAME_LENGTH);
    expect(normalizeConfig({ maxNameLength: 2000 }).maxNameLength).toBe(MAX_CONFIG_NAME_LENGTH);
    expect(normalizeConfig({ maxNameLength: 41.9 }).maxNameLength).toBe(41);
    expect(normalizeConfig({ maxNameLength: NaN }).maxNameLength).toBe(DEFAULT_CONFIG.maxNameLength);
  });

  it("respectManualName: true override is preserved (legacy escape hatch)", () => {
    const result = normalizeConfig({ respectManualName: true });
    expect(result.respectManualName).toBe(true);
  });

  it("DEFAULT_CONFIG defaults respectManualName to false (pi-autoname owns naming)", () => {
    // Product intent: once pi-autoname is installed, automatic naming owns
    // the session name. `/name` is effectively redundant. The legacy
    // `respectManualName: true` opt-in must remain an explicit escape hatch.
    expect(DEFAULT_CONFIG.respectManualName).toBe(false);
  });

  it("rejects non-string fallbackModels entries", () => {
    const result = normalizeConfig({ fallbackModels: ["a/b", 123, null, "c/d", ""] });
    expect(result.fallbackModels).toEqual(["a/b", "c/d"]);
  });

  it("defaults fallbackModels to empty array when not array", () => {
    expect(normalizeConfig({ fallbackModels: "bad" }).fallbackModels).toEqual([]);
  });

  it("trims model strings", () => {
    expect(normalizeConfig({ model: "  openai/gpt-4o  " }).model).toBe("openai/gpt-4o");
  });

  it("uses default for wrong types", () => {
    const result = normalizeConfig({ enabled: "yes", debug: 1, maxNameLength: "80", promptExtra: 123, ticketPattern: 456, respectManualName: "true" });
    expect(result.enabled).toBe(DEFAULT_CONFIG.enabled);
    expect(result.debug).toBe(DEFAULT_CONFIG.debug);
    expect(result.maxNameLength).toBe(DEFAULT_CONFIG.maxNameLength);
    expect(result.promptExtra).toBe(DEFAULT_CONFIG.promptExtra);
    expect(result.ticketPattern).toBe(DEFAULT_CONFIG.ticketPattern);
    expect(result.respectManualName).toBe(DEFAULT_CONFIG.respectManualName);
  });
});

// ---------------------------------------------------------------------------
// redactSensitiveText
// ---------------------------------------------------------------------------
describe("redactSensitiveText", () => {
  it("returns clean text unchanged", () => {
    const r = redactSensitiveText("hello world");
    expect(r.text).toBe("hello world");
    expect(r.redacted).toBe(false);
  });

  it("redacts OpenAI-style API keys", () => {
    const r = redactSensitiveText("my key is sk-abc123def456ghi789jklmno");
    expect(r.text).not.toContain("sk-abc123def456ghi789jklmno");
    expect(r.text).toContain("[REDACTED_API_KEY]");
    expect(r.redacted).toBe(true);
  });

  it("redacts AWS access keys", () => {
    const r = redactSensitiveText("key: AKIAIOSFODNN7EXAMPLE");
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.text).toContain("[REDACTED_AWS_KEY]");
    expect(r.redacted).toBe(true);
  });

  it("redacts private keys", () => {
    const text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----";
    const r = redactSensitiveText(text);
    expect(r.text).toContain("[REDACTED_PRIVATE_KEY]");
    expect(r.redacted).toBe(true);
  });

  it("redacts Bearer tokens", () => {
    const r = redactSensitiveText("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def");
    expect(r.text).toContain("Bearer [REDACTED]");
    expect(r.redacted).toBe(true);
  });

  it("redacts KEY=VALUE patterns", () => {
    const r = redactSensitiveText("API_KEY=supersecret123");
    expect(r.text).toContain("API_KEY=[REDACTED]");
    expect(r.redacted).toBe(true);
  });

  it("redacts token/password key-value patterns", () => {
    const r = redactSensitiveText('token: "my-secret-token-value"');
    expect(r.text).toContain("token=[REDACTED]");
    expect(r.redacted).toBe(true);
  });

  it("handles multiple secrets in one text", () => {
    const r = redactSensitiveText("key sk-1234567890abcdef1234567890abcdef and AKIAIOSFODNN7EXAMPLE");
    expect(r.text).not.toContain("sk-1234567890abcdef1234567890abcdef");
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(r.redacted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isHighQualityName
// ---------------------------------------------------------------------------
describe("isHighQualityName", () => {
  it("accepts good CJK names", () => {
    expect(isHighQualityName("API重构")).toBe(true);
    expect(isHighQualityName("部署脚本调试")).toBe(true);
    expect(isHighQualityName("数据库迁移")).toBe(true);
  });

  it("accepts good English names", () => {
    expect(isHighQualityName("Session naming fix")).toBe(true);
    expect(isHighQualityName("Auth refactor")).toBe(true);
  });

  it("accepts good Cyrillic names", () => {
    expect(isHighQualityName("Настройка русских названий")).toBe(true);
    expect(isHighQualityName("ABC-123 настройка названий")).toBe(true);
  });

  it("rejects too short", () => {
    expect(isHighQualityName("ab")).toBe(false);
    expect(isHighQualityName("")).toBe(false);
  });

  it("rejects too long", () => {
    expect(isHighQualityName("a".repeat(MAX_NAME_LENGTH + 1))).toBe(false);
    expect(isHighQualityName("a".repeat(MAX_NAME_LENGTH + 1), 80)).toBe(true);
  });

  it("rejects sentence-like openers", () => {
    // RAW_SLICE_RE catches names starting with these patterns
    expect(isHighQualityName("我想知道如何修复")).toBe(false);
    expect(isHighQualityName("Can you help me")).toBe(false);
    expect(isHighQualityName("I want to know")).toBe(false);
    expect(isHighQualityName("为什么报错")).toBe(false);
  });

  it("rejects sentence-ending punctuation", () => {
    expect(isHighQualityName("已完成配置。")).toBe(false);
    expect(isHighQualityName("Good job!")).toBe(false);
    expect(isHighQualityName("Really?")).toBe(false);
  });

  it("rejects multiple internal punctuation marks", () => {
    expect(isHighQualityName("你好，世界！不错")).toBe(false);
  });

  it("accepts single comma in CJK (typical)", () => {
    // RAW_SLICE_RE rejects names starting with common prefixes like 你
    // but a comma in mid-phrase is allowed if the name itself is valid
    expect(isHighQualityName("修复，重构")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ticket prefix helpers
// ---------------------------------------------------------------------------
describe("ticket prefix helpers", () => {
  const parts = [{ role: "user", text: "Please handle ABC-123 naming config" }];

  it("extracts the first capture group from ticketPattern", () => {
    expect(extractTicketPrefix(parts, "\\b([A-Z]+-\\d+)\\b")).toBe("ABC-123");
  });

  it("returns undefined for missing or invalid ticketPattern", () => {
    expect(extractTicketPrefix(parts, "")).toBeUndefined();
    expect(extractTicketPrefix(parts, "[")).toBeUndefined();
  });

  it("adds ticket prefix without duplicating it", () => {
    expect(withTicketPrefix("naming config", "ABC-123")).toBe("ABC-123 naming config");
    expect(withTicketPrefix("ABC-123 naming config", "ABC-123")).toBe("ABC-123 naming config");
  });
});

// ---------------------------------------------------------------------------
// blockText
// ---------------------------------------------------------------------------
describe("blockText", () => {
  it("returns string as-is", () => {
    expect(blockText("hello")).toBe("hello");
  });

  it("joins text blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ];
    expect(blockText(content)).toBe("hello world");
  });

  it("filters non-text blocks", () => {
    const content = [
      { type: "text", text: "hello" },
      { type: "image", url: "img.png" },
      { type: "text", text: "world" },
    ];
    expect(blockText(content)).toBe("hello world");
  });

  it("returns empty for null/undefined", () => {
    expect(blockText(null)).toBe("");
    expect(blockText(undefined)).toBe("");
    expect(blockText(123)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// smartFallbackName
// ---------------------------------------------------------------------------
describe("smartFallbackName", () => {
  it("strips conversational openers (Chinese)", () => {
    const name = smartFallbackName("我想知道如何修复数据库连接错误的问题");
    expect(name).not.toMatch(/^我想知道/);
    expect(name.length).toBeGreaterThan(0);
  });

  it("strips conversational openers (English)", () => {
    const name = smartFallbackName("Can you please help me fix the database connection");
    expect(name).not.toMatch(/^Can you/i);
    expect(name.length).toBeGreaterThan(0);
  });

  it("truncates long text", () => {
    const long = "A".repeat(200);
    const name = smartFallbackName(long);
    expect(name.length).toBeLessThanOrEqual(50);
  });

  it("truncates at sentence boundary when early", () => {
    // Truncates at first . then strips trailing punctuation
    const name = smartFallbackName("Fix the bug. Then deploy it.");
    expect(name).toBe("Fix the bug");
  });

  it("strips trailing particles (Chinese)", () => {
    const name = smartFallbackName("数据库连接的问题吗");
    expect(name).not.toMatch(/[吗呢吧]$/);
  });

  it("returns raw slice for short text", () => {
    const name = smartFallbackName("短文本");
    expect(name).toBe("短文本");
  });

  it("handles empty text gracefully", () => {
    const name = smartFallbackName("   ");
    expect(name.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// getFirstDialogue
// ---------------------------------------------------------------------------
describe("getFirstDialogue", () => {
  it("extracts first user + assistant pair", () => {
    const branch = [
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: "hi there" } },
    ];
    const result = getFirstDialogue(branch);
    expect(result.firstUser).toBe("hello");
    expect(result.firstAssistant).toBe("hi there");
  });

  it("compaction summary fills firstUser before user messages", () => {
    // If a compaction entry appears before the first user message,
    // its summary becomes firstUser and later user messages are skipped
    const branch = [
      { type: "compaction", summary: "old summary" },
      { type: "message", message: { role: "user", content: "question" } },
      { type: "message", message: { role: "assistant", content: "answer" } },
    ];
    const result = getFirstDialogue(branch);
    expect(result.firstUser).toBe("old summary");
    expect(result.firstAssistant).toBe("answer");
  });

  it("uses compaction summary as user text when no user message yet", () => {
    const branch = [
      { type: "compaction", summary: [{ type: "text", text: "compacted user msg" }] },
      { type: "message", message: { role: "assistant", content: "reply" } },
    ];
    const result = getFirstDialogue(branch);
    expect(result.firstUser).toBe("compacted user msg");
    expect(result.firstAssistant).toBe("reply");
  });

  it("returns undefined for missing assistant", () => {
    const branch = [{ type: "message", message: { role: "user", content: "hello" } }];
    const result = getFirstDialogue(branch);
    expect(result.firstUser).toBe("hello");
    expect(result.firstAssistant).toBeUndefined();
  });

  it("returns undefined for empty branch", () => {
    const result = getFirstDialogue([]);
    expect(result.firstUser).toBeUndefined();
    expect(result.firstAssistant).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getRecentDialogue
// ---------------------------------------------------------------------------
describe("getRecentDialogue", () => {
  it("extracts recent messages in order", () => {
    const branch = [
      { type: "message", message: { role: "user", content: "a" } },
      { type: "message", message: { role: "assistant", content: "b" } },
      { type: "message", message: { role: "user", content: "c" } },
    ];
    const result = getRecentDialogue(branch, 2);
    expect(result).toEqual([
      { role: "assistant", text: "b" },
      { role: "user", text: "c" },
    ]);
  });

  it("skips non-user/assistant messages", () => {
    const branch = [
      { type: "message", message: { role: "system", content: "hidden" } },
      { type: "message", message: { role: "user", content: "visible" } },
    ];
    const result = getRecentDialogue(branch);
    expect(result).toEqual([{ role: "user", text: "visible" }]);
  });

  it("respects maxMessages limit", () => {
    const branch = Array.from({ length: 20 }, (_, i) => ({
      type: "message",
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}` },
    }));
    const result = getRecentDialogue(branch, 3);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe("msg-17");
  });

  it("returns empty for empty branch", () => {
    expect(getRecentDialogue([])).toEqual([]);
  });
});

describe("parseRenameMarker", () => {
  it("parses an ai source marker", () => {
    const marker = parseRenameMarker({
      name: "测试自动命名",
      source: "ai",
      timestamp: 1700000000000,
    });
    expect(marker).toEqual({
      kind: "ai",
      name: "测试自动命名",
      source: "ai",
      timestamp: 1700000000000,
    });
  });

  it("parses a fallback source marker", () => {
    const marker = parseRenameMarker({
      name: "fallback-name",
      source: "fallback",
      timestamp: 1700000000001,
    });
    expect(marker?.kind).toBe("fallback");
  });

  it("parses a user_rename marker (recorded by agent_end)", () => {
    const marker = parseRenameMarker({
      event: "user_rename",
      name: "My Custom Title",
      timestamp: 1700000000002,
    });
    expect(marker).toEqual({
      kind: "user_rename",
      name: "My Custom Title",
      timestamp: 1700000000002,
    });
  });

  it("prefers user_rename over source when both are present (defensive)", () => {
    // Defensive: malformed data shouldn't reach this point, but if it
    // does, the user_rename branch wins because it has more context.
    const marker = parseRenameMarker({
      event: "user_rename",
      name: "X",
      source: "ai",
      timestamp: 1,
    });
    expect(marker?.kind).toBe("user_rename");
  });

  it("returns undefined for non-object data", () => {
    expect(parseRenameMarker(null)).toBeUndefined();
    expect(parseRenameMarker(undefined)).toBeUndefined();
    expect(parseRenameMarker("string")).toBeUndefined();
    expect(parseRenameMarker(42)).toBeUndefined();
  });

  it("returns undefined when neither flavor matches", () => {
    expect(parseRenameMarker({})).toBeUndefined();
    expect(parseRenameMarker({ name: "x" })).toBeUndefined();
    expect(parseRenameMarker({ source: "bogus", name: "x" })).toBeUndefined();
    expect(parseRenameMarker({ event: "user_rename" })).toBeUndefined();
    expect(parseRenameMarker({ event: "user_rename", name: 123 })).toBeUndefined();
  });

  it("defaults missing timestamp to 0", () => {
    const marker = parseRenameMarker({
      name: "X",
      source: "ai",
    });
    expect(marker).toEqual({
      kind: "ai",
      name: "X",
      source: "ai",
      timestamp: 0,
    });
  });
});
