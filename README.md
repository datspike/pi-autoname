# pi-autoname

> **Give your Pi sessions meaningful names — powered by AI.**

`pi-autoname` names your session **once automatically after the first complete dialogue** (first user message + first assistant reply), and also provides **`/autoname`** for manual re-naming later.

## ✨ What it does

| Scenario | Behavior |
|---|---|
| First dialogue completes | Automatically generates a semantic session name |
| Session topic drifts later | Run `/autoname` to refresh the name |
| AI naming fails | Falls back to the first user message slice |

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
| `enabled` | boolean | `true` | Set to `false` to disable AI naming |
| `model` | string | _(session model)_ | Override model (`provider/modelId`). Empty = use current session's active model |

Example for a cheaper dedicated naming model:

```json
{
  "enabled": true,
  "model": "minimax-cn/MiniMax-M2.7"
}
```

## 🏗️ How it works

### Automatic naming

```
first user message
        ↓
first assistant reply finishes
        ↓
read ~/.pi/agent/pi-autoname.json (auto-created if missing)
        ↓
use configured model or current session model
        ↓
setSessionName(AI name)
```

### Manual naming

```bash
/autoname
```

This regenerates the session name from the **recent conversation context**, useful when the session has drifted or narrowed to a more specific task.

### Built-in `/name` still works

Pi's native command remains unchanged:

```bash
/name My custom title
```

Use `/name` for manual fixed naming, and `/autoname` for AI-generated naming.

## 🌍 Locale support

Auto-detected from system environment (`PI_LOCALE` > `LC_ALL` > `LANG`). Names are generated in the detected language.

## 🔗 Related

- [pi-compaction-i18n](https://github.com/ssdiwu/pi-compaction-i18n) — localized compaction summaries

## License

MIT
