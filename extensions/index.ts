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
  model?: string; // empty = use session model
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-autoname.json");
const DEFAULT_CONFIG: AutonameConfig = {
  enabled: true,
  model: "",
};

/** Max time to wait for AI naming response (ms) */
const AI_TIMEOUT_MS = 30_000;

/** A name this short was likely a failed AI response */
const MIN_NAME_LENGTH = 3;

/** Names matching this pattern are raw-slice fallbacks (bad) */
const RAW_SLICE_RE = /^(?:我|你|他|她|它|请|帮|能|可|可以|能不能|请帮|感觉|突然|我想|我想知道|有没有|是不是|为什么|怎么|如何|What|Can|Could|Please|Help|I want|I need|Is there|Why|How)/;

function loadConfig(): AutonameConfig {
  try {
    if (!existsSync(CONFIG_PATH)) {
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
      return DEFAULT_CONFIG;
    }
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as AutonameConfig;
  } catch {
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

  return s || text.slice(0, 40).replace(/\n/g, " ").trim();
}

/**
 * Check if a name looks like a high-quality AI-generated name
 * (vs a raw-text fallback).
 */
function isHighQualityName(name: string): boolean {
  if (name.length < MIN_NAME_LENGTH || name.length > 50) return false;
  if (RAW_SLICE_RE.test(name)) return false;
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
  ];

  for (const part of parts) {
    promptParts.push("", `<${part.role}>`, part.text.slice(0, 700), `</${part.role}>`);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify(`pi-autoname: no API key for model`, "warning");
    return undefined;
  }

  // Wrap with timeout to prevent hanging on slow/unresponsive models
  const response = await Promise.race([
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
        maxTokens: 64,
      },
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("AI naming timed out")), AI_TIMEOUT_MS)
    ),
  ]);

  const text = response.content
    ?.filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("")
    .trim();

  // Validate and clean
  const cleaned = text?.replace(/^["'`\u201c\u201d\u3001]+|["'`\u201c\u201d\u3001]+$/g, "")
    .replace(/[^\w\u4e00-\u9fff\s\-_/]/g, "")
    .trim();

  if (cleaned && cleaned.length >= MIN_NAME_LENGTH && cleaned.length <= 60) {
    return cleaned;
  }
  return undefined; // AI output was unusable
}

async function maybeAutoname(pi: ExtensionAPI, ctx: any, mode: "first-dialogue" | "manual"): Promise<{ ok: boolean; source: "ai" | "fallback" | false }> {
  console.error('[pi-autoname] maybeAutoname called, mode:', mode);
  const config = loadConfig();
  if (config.enabled === false) {
    console.error('[pi-autoname] disabled in config');
    return { ok: false, source: false };
  }

  // --- Model resolution with warning ---
  let model = ctx.model;
  console.error('[pi-autoname] session model:', model?.id);
  if (config.model) {
    console.error('[pi-autoname] configured model:', config.model);
    const resolved = resolveModelFromString(config.model);
    if (resolved) {
      model = resolved;
      console.error('[pi-autoname] resolved model:', model?.id);
    } else {
      console.error('[pi-autoname] model not found, using session model');
      ctx.ui.notify(
        `pi-autoname: configured model "${config.model}" not found, using session model`,
        "warning",
      );
    }
  }
  if (!model) {
    console.error('[pi-autoname] no model available');
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

  // --- Try AI naming ---
  try {
    console.error('[pi-autoname] calling AI naming...');
    const aiName = await generateAIName(parts, model, ctx);
    console.error('[pi-autoname] AI response:', aiName);
    if (aiName?.trim()) {
      console.error('[pi-autoname] setting session name to:', aiName.trim());
      pi.setSessionName(aiName.trim());
      return { ok: true, source: "ai" };
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[pi-autoname] AI naming failed:', msg);
    ctx.ui.notify(`pi-autoname: AI naming failed (${msg.slice(0, 120)})`, "warning");
  }

  // --- Smart fallback ---
  if (mode === "first-dialogue") {
    const userText = parts.find((p) => p.role === "user")?.text;
    if (userText) {
      const fb = smartFallbackName(userText);
      console.error('[pi-autoname] using fallback name:', fb);
      pi.setSessionName(fb);
      return { ok: true, source: "fallback" };
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
  });

  pi.on("agent_end", async (_event, ctx) => {
    // Always allow retry if previous name was low-quality fallback
    if (namedState === "ai") return;

    console.error('[pi-autoname] agent_end event, namedState:', namedState);

    const result = await maybeAutoname(pi, ctx, "first-dialogue");
    console.error('[pi-autoname] maybeAutoname result:', result);
    if (result.ok) {
      namedState = result.source;
    }
  });

  pi.registerCommand("autoname", {
    description: "AI-generate a session name from the current conversation context",
    handler: async (_args, ctx) => {
      const result = await maybeAutoname(pi, ctx, "manual");
      const current = pi.getSessionName();
      if (result.ok && current) {
        ctx.ui.notify(`Session renamed: ${current} (${result.source})`, "info");
        namedState = result.source;
      } else if (current) {
        ctx.ui.notify(`Session unchanged: ${current}`, "info");
      } else {
        ctx.ui.notify("pi-autoname: could not generate a session name", "warning");
      }
    },
  });
}
