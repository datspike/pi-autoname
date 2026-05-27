/**
 * pi-autoname — AI-powered session naming for Pi
 *
 * Reads config from ~/.pi/agent/pi-autoname.json.
 * Automatically names the session once after the first complete dialogue
 * (first user message + first assistant reply), and provides /autoname for manual renaming.
 *
 * Fixes v0.5.1→v0.5.2:
 * - Model resolution failure now warns instead of silent fallback
 * - Fallback name uses smart extraction instead of raw text slice
 * - named flag allows retry when previous name was a low-quality fallback
 * - AI output validated and cleaned
 * - Compaction-aware dialogue extraction
 * - Added timeout + structured error reporting
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { complete, getModel } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

interface AutonameConfig {
  enabled?: boolean;
  model?: string; // primary model (empty = use session model)
  fallbackModels?: string[]; // additional models to try before session model
  cooldownMinutes?: number; // minutes between periodic renames (default: 10)
  debug?: boolean; // enable debug logging
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-autoname.json");
const DEFAULT_CONFIG: AutonameConfig = {
  enabled: true,
  model: "",
  debug: false,
};

/** Max time to wait for AI naming response (ms) */
const AI_TIMEOUT_MS = 30_000;

/** Debug logging helper */
let _debugEnabled = false;
function debugLog(...args: any[]) {
  if (_debugEnabled) {
    console.error('[pi-autoname]', ...args);
  }
}

/** A name this short was likely a failed AI response */
const MIN_NAME_LENGTH = 3;

/** Max length for a session name — anything longer is likely a raw sentence */
const MAX_NAME_LENGTH = 30;

/** Names matching this pattern are raw-slice fallbacks (bad) */
const RAW_SLICE_RE = /^(?:我|你|他|她|它|请|帮|能|可|可以|能不能|请帮|感觉|突然|我想|我想知道|有没有|是不是|为什么|怎么|如何|What|Can|Could|Please|Help|I want|I need|Is there|Why|How)/;

/** Sentence-ending punctuation — a real session name should not contain these */
const SENTENCE_END_RE = /[。！？!?.…]+\s*$/;

function loadConfig(): AutonameConfig {
  try {
    if (!existsSync(CONFIG_PATH)) {
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
      _debugEnabled = DEFAULT_CONFIG.debug ?? false;
      return DEFAULT_CONFIG;
    }
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as AutonameConfig;
    _debugEnabled = config.debug ?? false;
    return config;
  } catch {
    _debugEnabled = DEFAULT_CONFIG.debug ?? false;
    return DEFAULT_CONFIG;
  }
}

function resolveModelFromString(modelStr: string) {
  const slashIndex = modelStr.indexOf("/");
  if (slashIndex === -1) return null;
  const provider = modelStr.slice(0, slashIndex);
  const modelId = modelStr.slice(slashIndex + 1);
  return getModel(provider, modelId);
}

function blockText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join(" ")
    .trim();
}

/**
 * Smart fallback: extract key semantic content from user text
 * instead of blindly slicing first 60 chars.
 *
 * Strategy:
 * 1. Strip common conversational prefixes ("我感觉到", "Can you help me", etc.)
 * 2. Find the first sentence-ending punctuation and truncate there
 * 3. If still long, find last space/char boundary near 40 chars
 * 4. Clean up trailing particles
 */
function smartFallbackName(text: string): string {
  let s = text.slice(0, 200).replace(/\n/g, " ").trim();

  // Strip conversational openers
  s = s.replace(
    /^(?:我(?:觉得|感觉|发现|想要|想知道|怀疑)?\s*|你(?:能|可以|帮)\s*(?:我\s*)?|请(?:你|帮我)?\s*|Can you\s*(?:please\s*)?|Could you\s*(?:please\s*)?|Please\s*(?:help me\s*)?|I\s*(?:think|feel|want|need|noticed)\s*(?:that\s*)?|Is it possible to\s*|I wonder if\s*|I\'m wondering about\s*)/i,
    "",
  ).trim();

  // Truncate at first sentence boundary (.!?!。！？)
  const sentenceEnd = s.match(/[.!?。！？]/);
  if (sentenceEnd && sentenceEnd.index! < 60) {
    s = s.slice(0, sentenceEnd.index! + 1);
  } else if (s.length > 45) {
    // Find last word boundary before 45
    const cut = s.lastIndexOf(" ", 45);
    s = cut > 10 ? s.slice(0, cut) : s.slice(0, 42);
  }

  // Strip trailing particles
  s = s.replace(/(?:吗|呢|吧|啊|呀|哦|嘛|的|了|着|过)[\s,，.。]*$/, "").trim();

  // Strip trailing sentence-ending punctuation
  s = s.replace(/[。！？!?.…]+\s*$/, "").trim();

  return s || text.slice(0, 40).replace(/\n/g, " ").trim();
}

/**
 * Check if a name looks like a high-quality AI-generated name
 * (vs a raw-text fallback).
 */
function isHighQualityName(name: string): boolean {
  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) return false;
  if (RAW_SLICE_RE.test(name)) return false;
  // Reject sentence-like names (ending with punctuation)
  if (SENTENCE_END_RE.test(name)) return false;
  // Reject names with internal sentence punctuation (multiple clauses)
  if ((name.match(/[，,。！？!?]/g) || []).length > 1) return false;
  // Should contain at least one CJK char OR be mixed alphanumeric (not pure noise)
  const hasContent = /[\u4e00-\u9fff]/.test(name) || /^[A-Za-z][A-Za-z0-9_\-\s]{2,30}$/.test(name);
  return hasContent;
}

/**
 * Extract dialogue from session branch, handling:
 * - Standard message entries
 * - Compaction entries (which contain summarized messages)
 */
function getFirstDialogue(branch: any[]) {
  let firstUser: string | undefined;
  let firstAssistant: string | undefined;

  for (const entry of branch) {
    // Standard message entries
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

    // Compaction entries contain summarized conversation
    if (entry?.type === "compaction" && !firstUser) {
      const summary = blockText(entry.summary ?? entry.content);
      if (summary) firstUser = summary;
    }
  }

  return { firstUser, firstAssistant };
}

function getRecentDialogue(branch: any[], maxMessages = 6) {
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

const SYSTEM_PROMPT =
  "You are a session namer for an AI coding assistant. Generate a concise, meaningful session name based on the conversation context.";

async function generateAIName(
  parts: Array<{ role: string; text: string }>,
  model: any,
  ctx: any,
): Promise<string | undefined> {
  const modelId = model?.provider + '/' + model?.id;
  debugLog('generateAIName called with model:', modelId);
  debugLog('dialogue parts count:', parts.length);
  const locale = process.env.PI_LOCALE || process.env.LC_ALL || process.env.LANG || "";
  const langHint = locale.startsWith("zh")
    ? "用中文（简体）输出名称"
    : locale.startsWith("ja")
      ? "日本語で出力"
      : locale.startsWith("ko")
        ? "한국어로 출력"
        : "Output in English";

  const promptParts = [
    `${langHint}.`,
    "",
    "Generate a concise session name (5-15 characters/words) for this AI coding conversation.",
    "Reflect the real project/task being worked on, not the literal first sentence.",
    "Output ONLY the name string, nothing else. No punctuation, no quotes, no explanation.",
    "",
    "CRITICAL RULES:",
    "- NEVER copy or repeat any part of the conversation verbatim.",
    "- The name must be a short topic label, NOT a sentence or response.",
    "- Do NOT end with punctuation (。！？.!?).",
    "- Do NOT include commas or multiple clauses.",
    "- Examples of GOOD names: API重构, 部署脚本调试, 数据库迁移, Session naming fix",
    "- Examples of BAD names: 好的我来帮你做, Let me help you with that, 已经完成了配置",
  ];

  for (const part of parts) {
    promptParts.push("", `<${part.role}>`, part.text.slice(0, 700), `</${part.role}>`);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    debugLog('no API key for model:', model.provider + '/' + model.id);
    return undefined;
  }
  debugLog('API key found, calling complete');

  // Wrap with timeout to prevent hanging on slow/unresponsive models
  let response: any;
  try {
    response = await Promise.race([
      complete(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: promptParts.join("\n") }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: 256,
        },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AI naming timed out")), AI_TIMEOUT_MS)
      ),
    ]);
    debugLog('complete returned, stopReason:', response.stopReason);
    if (response.errorMessage) {
      debugLog('API error:', response.errorMessage);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    debugLog('complete threw error:', errMsg);
    throw err; // Re-throw to be caught by caller
  }

  // Extract text from response - try text first, then thinking
  let text = response.content
    ?.filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("")
    .trim();
  
  // If no text content, try thinking content
  if (!text) {
    text = response.content
      ?.filter((c: any) => c.type === "thinking")
      .map((c: any) => c.thinking)
      .join("")
      .trim();
    if (text) {
      debugLog('using thinking content as fallback');
    }
  }
  
  debugLog('response text:', text?.slice(0, 100));

  // Validate and clean
  const cleaned = text?.replace(/^["'`\u201c\u201d\u3001]+|["'`\u201c\u201d\u3001]+$/g, "")
    .replace(/[^\w\u4e00-\u9fff\s\-_/]/g, "")
    .trim();

  if (!cleaned || cleaned.length < MIN_NAME_LENGTH || cleaned.length > MAX_NAME_LENGTH) {
    debugLog('AI name rejected: length issue', cleaned?.length, cleaned);
    return undefined;
  }

  // Reject sentence-like names
  if (SENTENCE_END_RE.test(cleaned)) {
    debugLog('AI name rejected: sentence-like (ends with punctuation)', cleaned);
    return undefined;
  }
  if ((cleaned.match(/[，,。！？!?]/g) || []).length > 1) {
    debugLog('AI name rejected: multiple punctuation marks', cleaned);
    return undefined;
  }

  return cleaned;
}

async function maybeAutoname(pi: ExtensionAPI, ctx: any, mode: "first-dialogue" | "manual"): Promise<{ ok: boolean; source: "ai" | "fallback" | false }> {
  debugLog('maybeAutoname called, mode:', mode);
  const config = loadConfig();
  if (config.enabled === false) {
    debugLog('disabled in config');
    return { ok: false, source: false };
  }

  // --- Build model fallback chain ---
  const models: any[] = [];
  const addedModels = new Set<string>();
  
  function addModel(modelStr: string, source: string) {
    const resolved = resolveModelFromString(modelStr);
    if (resolved) {
      const key = resolved.provider + '/' + resolved.id;
      if (!addedModels.has(key)) {
        models.push(resolved);
        addedModels.add(key);
        debugLog(`added ${source} model:`, key);
      }
    } else {
      debugLog(`${source} model not found:`, modelStr);
    }
  }
  
  // 1. Primary configured model
  if (config.model) {
    addModel(config.model, 'primary');
  }
  
  // 2. Additional fallback models
  if (config.fallbackModels && Array.isArray(config.fallbackModels)) {
    for (const fb of config.fallbackModels) {
      addModel(fb, 'fallback');
    }
  }
  
  // 3. Session model (as final fallback)
  if (ctx.model) {
    const key = ctx.model.provider + '/' + ctx.model.id;
    if (!addedModels.has(key)) {
      models.push(ctx.model);
      addedModels.add(key);
      debugLog('added session model:', key);
    }
  }
  
  if (models.length === 0) {
    debugLog('no models available');
    return { ok: false, source: false };
  }

  // --- Dialogue extraction ---
  const branch = ctx.sessionManager.getBranch();
  let parts: Array<{ role: string; text: string }> = [];

  if (mode === "first-dialogue") {
    const { firstUser, firstAssistant } = getFirstDialogue(branch);
    if (!firstUser || !firstAssistant) return { ok: false, source: false };
    parts = [
      { role: "user", text: firstUser },
      { role: "assistant", text: firstAssistant },
    ];
  } else {
    parts = getRecentDialogue(branch);
    if (parts.length === 0) return { ok: false, source: false };
  }

  // --- Try AI naming with model fallback chain ---
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    debugLog(`trying model ${i + 1}/${models.length}:`, model.provider + '/' + model.id);
    
    try {
      const aiName = await generateAIName(parts, model, ctx);
      debugLog('AI response:', aiName);
      if (aiName?.trim()) {
        debugLog('setting session name to:', aiName.trim());
        pi.setSessionName(aiName.trim());
        return { ok: true, source: "ai" };
      }
      debugLog('model returned empty, trying next...');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLog('model failed:', msg);
      // Continue to next model
    }
  }

  debugLog('all models failed, using smart fallback');

  // --- Smart fallback ---
  const userText = parts.find((p) => p.role === "user")?.text;
  if (userText) {
    const fb = smartFallbackName(userText);
    debugLog('fallback name generated:', fb);
    // Only use fallback if it passes quality check
    if (isHighQualityName(fb)) {
      debugLog('using fallback name:', fb);
      pi.setSessionName(fb);
      return { ok: true, source: "fallback" };
    } else {
      debugLog('fallback name rejected by quality check:', fb);
    }
  }

  return { ok: false, source: false };
}

export default function extension(pi: ExtensionAPI) {
  /**
   * Track naming state.
   * - false = never attempted
   * - "ai" = successfully AI-named (locked, don't retry)
   * - "fallback" = only got a fallback name (allow retry on later turns)
   */
  let namedState: false | "ai" | "fallback" = false;

  /** Cooldown for periodic renaming (ms) */
  const config = loadConfig();
  const RENAME_COOLDOWN_MS = (config.cooldownMinutes ?? 10) * 60 * 1000;
  
  /** Last rename timestamp */
  let lastRenameTime = 0;

  loadConfig();

  pi.on("session_start", async () => {
    const existing = pi.getSessionName();
    // On resume, check if existing name looks like a raw fallback
    if (existing && !isHighQualityName(existing)) {
      namedState = "fallback"; // allow retry
    } else if (existing) {
      namedState = "ai"; // good name, lock it
    } else {
      namedState = false;
    }
    // Reset cooldown on session start
    lastRenameTime = Date.now();
  });

  pi.on("agent_end", async (_event, ctx) => {
    const now = Date.now();
    const timeSinceLastRename = now - lastRenameTime;
    
    debugLog('agent_end, namedState:', namedState, 'timeSinceLastRename:', Math.round(timeSinceLastRename / 1000) + 's');

    // First dialogue: always try if not yet named
    if (namedState === false || namedState === "fallback") {
      const result = await maybeAutoname(pi, ctx, "first-dialogue");
      debugLog('first-dialogue result:', result);
      if (result.ok) {
        namedState = result.source;
        lastRenameTime = now;
      }
      return;
    }

    // Periodic renaming: only if cooldown has passed
    if (timeSinceLastRename >= RENAME_COOLDOWN_MS) {
      debugLog('cooldown passed, trying periodic rename');
      const currentName = pi.getSessionName();
      const result = await maybeAutoname(pi, ctx, "manual");
      
      if (result.ok) {
        const newName = pi.getSessionName();
        // Only update if name actually changed
        if (newName && newName !== currentName) {
          debugLog('name updated:', currentName, '->', newName);
          lastRenameTime = now;
        } else {
          debugLog('name unchanged, resetting cooldown');
          lastRenameTime = now; // Reset cooldown even if name unchanged
        }
      }
    }
  });

  pi.registerCommand("autoname", {
    description: "AI-generate a session name from the current conversation context",
    handler: async (_args, ctx) => {
      const result = await maybeAutoname(pi, ctx, "manual");
      const current = pi.getSessionName();
      if (result.ok && current) {
        if (result.source === "ai") {
          ctx.ui.notify(`Session renamed: ${current}`, "info");
        } else {
          ctx.ui.notify(`Session renamed (fallback): ${current}`, "warning");
        }
        namedState = result.source;
      } else {
        ctx.ui.notify("pi-autoname: could not generate a name", "warning");
      }
    },
  });
}
