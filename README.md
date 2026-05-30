# pi-autoname

> **Give your Pi sessions meaningful names — powered by AI.**

`pi-autoname` automatically names your session after the first dialogue, **periodically renames as the conversation evolves**, and provides **`/autoname`** for manual re-naming.

## ✨ What it does

| Scenario | Behavior |
|---|---|
| First dialogue completes | Automatically generates a semantic session name |
| Conversation continues | Silently re-names every 10 minutes (configurable) |
| Session topic drifts | Name updates to reflect the new focus |
| Run `/autoname` | Manually regenerate from recent context |
| AI naming fails | Falls back to smart text extraction |

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
  "model": "",
  "fallbackModels": [],
  "cooldownMinutes": 10,
  "debug": false,
  "respectManualName": true
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Set to `false` to disable AI naming |
| `model` | string | _(session model)_ | Primary model (`provider/modelId`). Empty = use session model |
| `fallbackModels` | string[] | `[]` | Additional models to try if primary fails |
| `cooldownMinutes` | number | `10` | Minutes between periodic re-names |
| `debug` | boolean | `false` | Enable debug logging |
| `respectManualName` | boolean | `true` | Do not automatically overwrite names set outside `pi-autoname` |

### Example: Model fallback chain

```json
{
  "enabled": true,
  "model": "minimax-cn/MiniMax-M2.7",
  "fallbackModels": [
    "xiaomi-token-plan-cn/mimo-v2-omni"
  ],
  "cooldownMinutes": 10
}
```

This tries models in order: `MiniMax-M2.7` → `mimo-v2-omni` → session model.

## 🏗️ How it works

### Automatic naming

```
first user message
        ↓
first assistant reply finishes
        ↓
AI generates semantic session name
        ↓
setSessionName(name)
```

### Periodic re-naming

```
agent_end event (new message processed)
        ↓
cooldown passed? (10 min default)
        ↓
AI generates new name from recent context
        ↓
name changed? → silently update
name same? → skip
```

### Model fallback chain

```
primary model (from config)
        ↓ failed?
fallback models (from config)
        ↓ failed?
session model (automatic)
        ↓ failed?
smart text extraction (no AI)
```

### Manual naming

```bash
/autoname
```

Regenerates the session name from recent conversation context. Useful when you want to force an immediate rename.

### Built-in `/name` still works

Pi's native command remains unchanged:

```bash
/name My custom title
```

Use `/name` for manual fixed naming, and `/autoname` for AI-generated naming.

## 🔐 Privacy note

`pi-autoname` sends a short, recent conversation excerpt to the selected naming model. Before sending, it redacts common secret patterns such as API keys, bearer tokens, AWS access keys, private keys, and `*_TOKEN` / `*_SECRET` / `*_PASSWORD` environment assignments. If the AI call fails and the user text contained a detected secret, the local fallback name is skipped to avoid turning secrets into session names.

## 🌍 Locale support

Auto-detected from system environment (`PI_LOCALE` > `LC_ALL` > `LANG`). Names are generated in the detected language.

## 🔗 Related

- [pi-compaction-i18n](https://github.com/ssdiwu/pi-compaction-i18n) — localized compaction summaries

## License

MIT
