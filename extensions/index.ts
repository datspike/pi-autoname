/**
 * pi-autoname — AI-powered session naming for Pi
 *
 * Reads config from ~/.pi/agent/pi-autoname.json.
 * Falls back to simple text slice if config missing or API fails.
 *
 * Replaces the original auto-session-name.ts (fayimora's 30-line slice version).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Types ───────────────────────────────────────────────

interface AutonameConfig {
  enabled?: boolean;
  model?: string; // e.g. "minimax-cn/MiniMax-M2.7", empty = use session model
}

// ── Config loading (auto-create if missing) ─────────────

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-autoname.json");

const DEFAULT_CONFIG: AutonameConfig = {
  enabled: true,
  model: "", // empty = use current session model (ctx.model)
};

function loadConfig(): AutonameConfig {
  try {
    if (!existsSync(CONFIG_PATH)) {
      // Auto-generate default config on first load
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

// ── Message extraction ───────────────────────────────────

function extractUserText(event: any): string | undefined {
  const userMsg = event.messages?.find((m: any) => m.role === "user");
  if (!userMsg) return undefined;

  const content = userMsg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => (b as { text: string }).text)
      .join(" ");
  }
  return undefined;
}

function extractAssistantText(event: any): string | undefined {
  const asstMsg = event.messages?.find((m: any) => m.role === "assistant");
  if (!asstMsg) return undefined;

  const content = asstMsg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => (b as { text: string }).text)
      .join(" ");
  }
  return undefined;
}

// ── Fallback: original slice behavior ────────────────────

function fallbackName(text: string): string {
  return text.slice(0, 60).replace(/\n/g, " ").trim();
}

// ── LLM-powered name generation ──────────────────────────

const SYSTEM_PROMPT =
  "You are a session namer for an AI coding assistant. Generate a concise, meaningful session name based on the conversation start.";

async function generateAIName(
  userText: string,
  assistantText: string,
  model: any,
  ctx: any,
): Promise<string | undefined> {
  const locale =
    process.env.PI_LOCALE || process.env.LC_ALL || process.env.LANG || "";
  const langHint = locale.startsWith("zh")
    ? "用中文（简体）输出名称"
    : locale.startsWith("ja")
    ? "日本語で出力"
    : locale.startsWith("ko")
    ? "한국어로 출력"
    : "Output in English";

  const prompt = [
    `${langHint}.`,
    "",
    "Based on this conversation start, generate a concise session name (5-15 characters).",
    "Describe what project and task this session is working on.",
    "Output ONLY the name string, nothing else. No punctuation, no quotes, no explanation.",
    "",
    `<user>`,
    userText.slice(0, 500),
    `</user>`,
    "",
    `<assistant>`,
    assistantText.slice(0, 500),
    `</assistant>`,
  ].join("\n");

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;

  const response = await complete(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: 64,
    },
  );

  const text = response.content
    ?.filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("")
    .trim();

  return text?.replace(/^["'`""''`]|["'`""''`]$/g, "").trim() || undefined;
}

// ── Extension entry point ────────────────────────────────

export default function extension(pi: ExtensionAPI) {
  let named = false;
  const config = loadConfig();
  const enabled = config.enabled !== false; // default true

  pi.on("session_start", async () => {
    named = !!pi.getSessionName();
  });

  pi.on("agent_end", async (event, ctx) => {
    if (named) return;

    const userText = extractUserText(event);
    if (!userText) return;

    // Try AI generation — always attempt when enabled
    if (enabled) {
      let model = ctx.model; // default: use session's active model

      // Override with configured model if set
      if (config.model) {
        const resolved = resolveModelFromString(config.model);
        if (resolved) model = resolved;
      }

      if (model) {
        const asstText = extractAssistantText(event);
        if (asstText) {
          try {
            const aiName = await generateAIName(userText, asstText, model, ctx);
            if (aiName?.trim()) {
              pi.setSessionName(aiName.trim());
              named = true;
              return;
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            ctx.ui.notify(
              `pi-autoname: AI naming failed, using fallback (${msg})`,
              "warning",
            );
          }
        }
      }
    }

    // Fallback: original slice behavior
    const name = fallbackName(userText);
    if (name) {
      pi.setSessionName(name);
      named = true;
    }
  });
}
