<p align="center">
  <img src="https://github.com/ssdiwu/pi-autoname/releases/download/readme-assets/pi-autoname-cover.png" alt="pi-autoname cover" width="100%" />
</p>

<p align="center">
  <strong>AI-powered semantic session naming for Pi.</strong>
</p>

<p align="center">
  Automatically name sessions after the first dialogue, periodically re-name as the conversation evolves, and regenerate on demand with <code>/autoname</code>.
</p>

<p align="center">
  <code>pi install npm:pi-autoname</code>
</p>

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
  "locale": "",
  "maxNameLength": 30,
  "promptExtra": "",
  "ticketPattern": "",
  "respectManualName": false
}
```

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Set to `false` to disable AI naming |
| `model` | string | _(session model)_ | Primary model (`provider/modelId`). Empty = use session model |
| `fallbackModels` | string[] | `[]` | Additional models to try if primary fails |
| `cooldownMinutes` | number | `10` | Minutes between periodic re-names |
| `debug` | boolean | `false` | Enable debug logging |
| `locale` | string | `""` | Naming locale override. Empty = auto-detect from `PI_LOCALE` > `LC_ALL` > `LANG` |
| `maxNameLength` | number | `30` | Max accepted generated name length. Clamped to `3..120` |
| `promptExtra` | string | `""` | Extra instruction appended to the naming prompt |
| `ticketPattern` | string | `""` | Optional regex. Exactly one unique match in the first user message is pinned and forced as the prefix of later generated names |
| `respectManualName` | boolean | `false` | When `false` (default), pi-autoname owns session naming: automatic naming runs on first dialogue and periodically, and may overwrite a name set via `/name` or `/autoname`. Set to `true` for the legacy behavior of treating a user-issued rename as sticky. |

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

### Example: Longer names with work-ticket prefixes

```json
{
  "maxNameLength": 80,
  "promptExtra": "Prefer longer, descriptive names.",
  "ticketPattern": "\\b((?:DVR|OST|ZATO)-\\d+)\\b"
}
```

pi-autoname checks only the first user message and pins the ticket only when the configured pattern produces exactly one unique value. Assistant replies, later dialogue, and an existing session name are not ticket sources. Periodic and `/autoname` renames retain a safely pinned ticket after it leaves the recent conversation window. When no trusted ticket is pinned, a ticket-like prefix suggested by the naming model is removed before the name is saved.

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

### Built-in `/name` is largely redundant

Pi's native command still works:

```bash
/name My custom title
```

However, with `pi-autoname` installed, the periodic re-naming (`cooldownMinutes` default 10 min) will likely overwrite your `/name` change on the next `agent_end`. This is the **default** behavior (`respectManualName: false`) — pi-autoname owns the session name.

- For a one-shot rename that pi-autoname will then take over again: use `/name`.
- To force a re-name from the current conversation right now: use `/autoname`.
- To opt out of pi-autoname ever overwriting your `/name`: set `respectManualName: true` in the config.

#### `/name` grace period

When you `/name` a session, pi-autoname detects the out-of-band change on the next `agent_end` and **resets the rename cooldown to now**. That gives your `/name` choice a full `cooldownMinutes` window before the next periodic rename is allowed to consider overwriting it. If the conversation topic changes earlier, the periodic rename will still run normally — `/name` is a grace period, not a lock.

## 🔐 Privacy note

`pi-autoname` sends a short, recent conversation excerpt to the selected naming model. Before sending, it redacts common secret patterns such as API keys, bearer tokens, AWS access keys, private keys, and `*_TOKEN` / `*_SECRET` / `*_PASSWORD` environment assignments. If the AI call fails and the user text contained a detected secret, the local fallback name is skipped to avoid turning secrets into session names.

## 🌍 Locale support

Auto-detected from system environment (`PI_LOCALE` > `LC_ALL` > `LANG`) unless `locale` is set in `pi-autoname.json`. The config value takes priority, so naming language does not depend on the shell locale.

## 🔗 Related

- [pi-compaction-i18n](https://github.com/ssdiwu/pi-compaction-i18n) — localized compaction summaries

## License

MIT
