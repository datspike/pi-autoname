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

Or install from a local path:

```bash
pi install /absolute/path/to/pi-autoname
```

## ⚙️ Configuration

Create `~/.pi/pi-autoname.json`:

```json
{
  "enabled": true,
  "model": "minimax-cn/MiniMax-M2.7"
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Set to `false` to disable AI naming |
| `model` | string | _(fallback to slice)_ | Model ID for name generation (`provider/modelId`). Uses a cheap model by default. |

### Fallback behavior

- **No config file** → falls back to original text slice (`.slice(0, 60)`)
- **API error** → silently falls back to slice, shows warning notification
- **No assistant message yet** → waits until first round completes, then generates

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
Read ~/.pi/pi-autoname.json
        ↓
Configured? → call LLM (cheap model) → setSessionName(AI name)
Not configured? → fallback to text slice(.slice(0, 60))
```

The extension uses `@earendil-works/pi-ai`'s `complete()` — the same LLM interface used by `pi-compaction-i18n`. No subagent, no fork context, no extra process.

## 🔗 Related

- [pi-compaction-i18n](https://github.com/ssdiwu/pi-compaction-i18n) — Localized compaction summaries (sibling project)
- [pi-dflow](https://github.com/ssdiwu/pi-dflow) — AI coding workflow framework (will absorb this extension)

## License

MIT
