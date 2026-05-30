/**
 * pi-autoname — AI-powered session naming for Pi
 *
 * Reads config from ~/.pi/agent/pi-autoname.json.
 * Automatically names the session once after the first complete dialogue
 * (first user message + first assistant reply), and provides /autoname for manual renaming.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { complete, getModel } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

import {
  normalizeConfig,
  redactSensitiveText,
  isHighQualityName,
  blockText,
  smartFallbackName,
  getFirstDialogue,
  getRecentDialogue,
  DEFAULT_CONFIG,
  type AutonameConfig,
} from "./lib.js";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-autoname.json");

/** Max time to wait for AI naming response (ms) */
const AI_TIMEOUT_MS = 30_000;

/** Debug logging helper */
let _debugEnabled = false;
function debugLog(...args: any[]) {
  if (_debugEnabled) {
    console.error("[pi-autoname]", ...args);
  }
}

function loadConfig(): AutonameConfig {
  try {
    if (!existsSync(CONFIG_PATH)) {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
      _debugEnabled = DEFAULT_CONFIG.debug;
      return { ...DEFAULT_CONFIG };
    }

    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = normalizeConfig(JSON.parse(raw));
    _debugEnabled = config.debug ?? false;
    return config;
  } catch (error) {
    _debugEnabled = DEFAULT_CONFIG.debug;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[pi-autoname] failed to load config; using defaults: ${message}`);
    return { ...DEFAULT_CONFIG };
  }
}

function resolveModelFromString(modelStr: string, ctx: any) {
  const slashIndex = modelStr.indexOf("/");
  if (slashIndex <= 0 || slashIndex === modelStr.length - 1) return null;

  const provider = modelStr.slice(0, slashIndex);
  const modelId = modelStr.slice(slashIndex + 1);
  return ctx?.modelRegistry?.find?.(provider, modelId) ?? (getModel as any)(provider, modelId);
}

const STATE_ENTRY_TYPE = "pi-autoname-state";

type NamingSource = "ai" | "fallback";

function getLastAutonameState(ctx: any): { name?: string; source?: NamingSource } | undefined {
  let state: { name?: string; source?: NamingSource } | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry?.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
    const data = entry.data;
    if (!data || typeof data !== "object") continue;
    if (data.source !== "ai" && data.source !== "fallback") continue;
    state = {
      name: typeof data.name === "string" ? data.name : undefined,
      source: data.source,
    };
  }

  return state;
}

function rememberGeneratedName(pi: ExtensionAPI, name: string, source: NamingSource) {
  pi.appendEntry(STATE_ENTRY_TYPE, { name, source, timestamp: Date.now() });
}

const SYSTEM_PROMPT =
  "You are a session namer for an AI coding assistant. Generate a concise, meaningful session name based on the conversation context.";

let namingSequence = 0;

async function generateAIName(
  parts: Array<{ role: string; text: string }>,
  model: any,
  ctx: any,
): Promise<string | undefined> {
  const modelId = model?.provider + "/" + model?.id;
  debugLog("generateAIName called with model:", modelId);
  debugLog("dialogue parts count:", parts.length);
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
    const safe = redactSensitiveText(part.text);
    if (safe.redacted) debugLog("redacted sensitive content before AI naming");
    promptParts.push("", `<${part.role}>`, safe.text.slice(0, 700), `</${part.role}>`);
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    debugLog("no API key for model:", model.provider + "/" + model.id);
    return undefined;
  }
  debugLog("API key found, calling complete");

  // Abort the underlying request on timeout/cancellation; Promise.race alone would leak work.
  let response: any;
  let timedOut = false;
  const controller = new AbortController();
  const parentSignal = ctx.signal as AbortSignal | undefined;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("AI naming timed out"));
  }, AI_TIMEOUT_MS);

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  try {
    response = await complete(
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
        signal: controller.signal,
      },
    );
    debugLog("complete returned, stopReason:", response.stopReason);
    if (response.errorMessage) {
      debugLog("API error:", response.errorMessage);
    }
  } catch (err) {
    const errMsg = timedOut ? "AI naming timed out" : err instanceof Error ? err.message : String(err);
    debugLog("complete threw error:", errMsg);
    throw new Error(errMsg);
  } finally {
    clearTimeout(timeoutId);
    parentSignal?.removeEventListener("abort", abortFromParent);
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
      debugLog("using thinking content as fallback");
    }
  }

  debugLog("response text:", text?.slice(0, 100));

  // Validate and clean
  const cleaned = text
    ?.replace(/^["'`\u201c\u201d\u3001]+|["'`\u201c\u201d\u3001]+$/g, "")
    .replace(/[^\w\u4e00-\u9fff\s\-_/]/g, "")
    .trim();

  if (!cleaned || !isHighQualityName(cleaned)) {
    debugLog("AI name rejected by quality check:", cleaned);
    return undefined;
  }

  return cleaned;
}

async function maybeAutoname(
  pi: ExtensionAPI,
  ctx: any,
  mode: "first-dialogue" | "manual",
): Promise<{ ok: boolean; source: NamingSource | false }> {
  const requestId = ++namingSequence;
  debugLog("maybeAutoname called, mode:", mode);
  const config = loadConfig();
  if (config.enabled === false) {
    debugLog("disabled in config");
    return { ok: false, source: false };
  }

  // --- Build model fallback chain ---
  const models: any[] = [];
  const addedModels = new Set<string>();

  function addModel(modelStr: string, source: string) {
    const resolved = resolveModelFromString(modelStr, ctx);
    if (resolved) {
      const key = resolved.provider + "/" + resolved.id;
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
    addModel(config.model, "primary");
  }

  // 2. Additional fallback models
  if (config.fallbackModels && Array.isArray(config.fallbackModels)) {
    for (const fb of config.fallbackModels) {
      addModel(fb, "fallback");
    }
  }

  // 3. Session model (as final fallback)
  if (ctx.model) {
    const key = ctx.model.provider + "/" + ctx.model.id;
    if (!addedModels.has(key)) {
      models.push(ctx.model);
      addedModels.add(key);
      debugLog("added session model:", key);
    }
  }

  if (models.length === 0) {
    debugLog("no models available");
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

  function applyName(name: string, source: NamingSource) {
    if (requestId !== namingSequence) {
      debugLog("skip stale naming result:", name);
      return false;
    }
    const trimmed = name.trim();
    pi.setSessionName(trimmed);
    rememberGeneratedName(pi, trimmed, source);
    return true;
  }

  // --- Try AI naming with model fallback chain ---
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    debugLog(`trying model ${i + 1}/${models.length}:`, model.provider + "/" + model.id);

    try {
      const aiName = await generateAIName(parts, model, ctx);
      debugLog("AI response:", aiName);
      if (aiName?.trim()) {
        debugLog("setting session name to:", aiName.trim());
        if (!applyName(aiName, "ai")) return { ok: false, source: false };
        return { ok: true, source: "ai" };
      }
      debugLog("model returned empty, trying next...");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLog("model failed:", msg);
      // Continue to next model
    }
  }

  debugLog("all models failed, using smart fallback");

  // --- Smart fallback ---
  const userText = parts.find((p) => p.role === "user")?.text;
  if (userText) {
    const safeUserText = redactSensitiveText(userText);
    if (safeUserText.redacted) {
      debugLog("fallback skipped because user text contained sensitive content");
      return { ok: false, source: false };
    }

    const fb = smartFallbackName(safeUserText.text);
    debugLog("fallback name generated:", fb);
    // Only use fallback if it passes quality check
    if (isHighQualityName(fb)) {
      debugLog("using fallback name:", fb);
      if (!applyName(fb, "fallback")) return { ok: false, source: false };
      return { ok: true, source: "fallback" };
    } else {
      debugLog("fallback name rejected by quality check:", fb);
    }
  }

  return { ok: false, source: false };
}

export default function extension(pi: ExtensionAPI) {
  /**
   * Track naming state.
   * - false = never attempted
   * - "ai" = successfully AI-named
   * - "fallback" = only got a fallback name (allow retry on later turns)
   * - "manual" = existing name was set outside this extension; do not overwrite automatically
   */
  let namedState: false | NamingSource | "manual" = false;

  /** Last rename timestamp */
  let lastRenameTime = 0;
  let lastGeneratedName: string | undefined;

  loadConfig();

  pi.on("session_start", async (_event, ctx) => {
    const existing = pi.getSessionName();
    const currentConfig = loadConfig();
    const lastAutonameState = getLastAutonameState(ctx);

    // On resume, only treat an existing name as extension-owned when we persisted it.
    if (existing && lastAutonameState?.name === existing && lastAutonameState.source) {
      namedState = lastAutonameState.source;
      lastGeneratedName = existing;
    } else if (existing && currentConfig.respectManualName !== false) {
      namedState = "manual";
      lastGeneratedName = undefined;
    } else if (existing && !isHighQualityName(existing)) {
      namedState = "fallback"; // allow retry for low-quality legacy names
      lastGeneratedName = undefined;
    } else if (existing) {
      namedState = "ai";
      lastGeneratedName = existing;
    } else {
      namedState = false;
      lastGeneratedName = undefined;
    }
    // Reset cooldown on session start
    lastRenameTime = Date.now();
  });

  pi.on("agent_end", async (_event, ctx) => {
    const now = Date.now();
    const timeSinceLastRename = now - lastRenameTime;
    const currentConfig = loadConfig();
    const renameCooldownMs = (currentConfig.cooldownMinutes ?? DEFAULT_CONFIG.cooldownMinutes) * 60 * 1000;

    debugLog(
      "agent_end, namedState:",
      namedState,
      "timeSinceLastRename:",
      Math.round(timeSinceLastRename / 1000) + "s",
    );

    // First dialogue: always try if not yet named
    if (namedState === false || namedState === "fallback") {
      const result = await maybeAutoname(pi, ctx, "first-dialogue");
      debugLog("first-dialogue result:", result);
      if (result.ok) {
        namedState = result.source;
        lastGeneratedName = pi.getSessionName();
        lastRenameTime = now;
      }
      return;
    }

    if (namedState === "manual") {
      debugLog("manual session name detected, skipping automatic rename");
      return;
    }

    const currentSessionName = pi.getSessionName();
    if (
      currentConfig.respectManualName !== false &&
      currentSessionName &&
      lastGeneratedName &&
      currentSessionName !== lastGeneratedName
    ) {
      namedState = "manual";
      debugLog("session name changed outside pi-autoname, skipping automatic rename");
      return;
    }

    // Periodic renaming: only if cooldown has passed
    if (timeSinceLastRename >= renameCooldownMs) {
      debugLog("cooldown passed, trying periodic rename");
      const currentName = pi.getSessionName();
      const result = await maybeAutoname(pi, ctx, "manual");

      if (result.ok) {
        const newName = pi.getSessionName();
        // Only update if name actually changed
        if (newName && newName !== currentName) {
          debugLog("name updated:", currentName, "->", newName);
          lastGeneratedName = newName;
          lastRenameTime = now;
        } else {
          debugLog("name unchanged, resetting cooldown");
          lastGeneratedName = newName ?? lastGeneratedName;
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
        lastGeneratedName = current;
      } else {
        ctx.ui.notify("pi-autoname: could not generate a name", "warning");
      }
    },
  });
}
