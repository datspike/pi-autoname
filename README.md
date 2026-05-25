# pi-autoname

> **Give your Pi sessions meaningful names — powered by AI.**

`pi-autoname` is a Pi extension that replaces the default "first 60 characters of user message" session naming with **LLM-generated semantic names**.

## ✨ Before / After

| Input | Default (slice) | pi-autoname (AI) |
|---|---|---|
| `"帮我看看 .doc 的文档约束，然后聊聊怎么建立知识图谱关系"` | `"帮我看看 .doc 的文档约束，然后聊"` | `"pi-dflow 文档约束审查与知识图谱设计"` |
| `"fix the auth middleware in src/auth.ts, it's not validating tokens"` | `"fix the auth middleware in src/auth.ts, it'"` | `"Auth 中间件 Token 校验修复"` |

## 🚀 Install

```bash
pi install npm:pi-autoname
```

**Works out of the box.** No configuration needed — uses your current session's model by default.

## ⚙️ Configuration

Config file is **auto-generated** on first use at `~/.pi/agent/pi-autoname.json`:

```json
{
  "enabled": true,
  "model": ""
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Set to `false` to disable AI naming (falls back to text slice) |
| `model` | string | _(session model)_ | Override model (`provider/modelId`). Empty = use current session's active model |

### Why override the model?

By default, autoname uses whatever model your session is running on — this means **zero config, works immediately**. But if you want a cheaper/faster model specifically for naming (it's a <1s task), you can set one:

```json
{
  "enabled": true,
  "model": "minimax-cn/MiniMax-M2.7"
}
```

> **Tip**: Naming only needs ~64 tokens of output. A cheap model is perfectly fine.

## 🌍 Locale support

Auto-detected from system environment (`PI_LOCALE` > `LC_ALL` > `LANG`). Session names are generated in the detected language:

| Locale | Example output |
|---|---|
| `zh-CN`, `zh_*` | `"pi-dflow 文档约束审查与知识图谱设计"` |
| `ja-*` | `"認証ミドルウェアのトークン検証修正"` |
| `ko-*` | `"인증 미들웨어 토큰 검증 수정"` |
| other | `"Auth Middleware Token Validation Fix"` |

## 🏗️ How it works

```
session_start → check if already named
        ↓
agent_end (first turn) → extract user + assistant messages
        ↓
Read ~/.pi/agent/pi-autoname.json (auto-created if missing)
        ↓
enabled? → call LLM (session model or configured model)
              → setSessionName(AI name)
disabled / API failed → fallback to text slice(.slice(0, 60))
```

The extension uses `@earendil-works/pi-ai`'s `complete()` — the same LLM interface used by `pi-compaction-i18n`. No subagent, no fork context, no extra process.

## 🔗 Related

- [pi-compaction-i18n](https://github.com/ssdiwu/pi-compaction-i18n) — Localized compaction summaries (sibling project)

## License

MIT
