/**
 * pi-autoname — AI-powered session naming for Pi
 *
 * Reads config from ~/.pi/agent/pi-autoname.json.
 * Automatically names the session once after the first complete dialogue
 * (first user + first assistant reply), and provides /autoname for manual renaming.
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

function fallbackName(text: string): string {
  return text.slice(0, 60).replace(/\n/g, " ").trim();
}

function getFirstDialogue(branch: any[]) {
  let firstUser: string | undefined;
  let firstAssistant: string | undefined;

  for (const entry of branch) {
    if (entry?.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    const text = blockText(entry.message.content);
    if (!text) continue;
    if (!firstUser && role === "user") firstUser = text;
    if (firstUser && !firstAssistant && role === "assistant") {
      firstAssistant = text;
      break;
    }
  }

  return { firstUser, firstAssistant };
}

function getRecentDialogue(branch: any[], maxMessages = 6) {
  const items: Array<{ role: string; text: string }> = [];
  for (const entry of branch) {
    if (entry?.type !== "message" || !entry.message) continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = blockText(entry.message.content);
    if (!text) continue;
    items.push({ role, text });
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
  if (!auth.ok || !auth.apiKey) return undefined;

  const response = await complete(
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
  );

  const text = response.content
    ?.filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("")
    .trim();

  return text?.replace(/^["'`]+|["'`]+$/g, "").trim() || undefined;
}

async function maybeAutoname(pi: ExtensionAPI, ctx: any, mode: "first-dialogue" | "manual") {
  const config = loadConfig();
  if (config.enabled === false) return false;

  let model = ctx.model;
  if (config.model) {
    const resolved = resolveModelFromString(config.model);
    if (resolved) model = resolved;
  }
  if (!model) return false;

  const branch = ctx.sessionManager.getBranch();
  let parts: Array<{ role: string; text: string }> = [];

  if (mode === "first-dialogue") {
    const { firstUser, firstAssistant } = getFirstDialogue(branch);
    if (!firstUser || !firstAssistant) return false;
    parts = [
      { role: "user", text: firstUser },
      { role: "assistant", text: firstAssistant },
    ];
  } else {
    parts = getRecentDialogue(branch);
    if (parts.length === 0) return false;
  }

  try {
    const aiName = await generateAIName(parts, model, ctx);
    if (aiName?.trim()) {
      pi.setSessionName(aiName.trim());
      return true;
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`pi-autoname: AI naming failed (${msg})`, "warning");
  }

  if (mode === "first-dialogue") {
    const userText = parts.find((p) => p.role === "user")?.text;
    if (userText) {
      pi.setSessionName(fallbackName(userText));
      return true;
    }
  }

  return false;
}

export default function extension(pi: ExtensionAPI) {
  let named = false;
  loadConfig();

  pi.on("session_start", async () => {
    named = !!pi.getSessionName();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (named) return;
    const ok = await maybeAutoname(pi, ctx, "first-dialogue");
    if (ok) named = true;
  });

  pi.registerCommand("autoname", {
    description: "AI-generate a session name from the current conversation context",
    handler: async (_args, ctx) => {
      const ok = await maybeAutoname(pi, ctx, "manual");
      const current = pi.getSessionName();
      if (ok && current) {
        ctx.ui.notify(`Session renamed: ${current}`, "info");
      } else if (current) {
        ctx.ui.notify(`Session unchanged: ${current}`, "info");
      } else {
        ctx.ui.notify("pi-autoname: could not generate a session name", "warning");
      }
    },
  });
}
