# Antigravity (AGY) ACP extension surface

There is **no official Antigravity ACP specification**. The only sources are the
community README at <https://github.com/shubzkothekar/antigravity-acp> and PR #14.
Everything documented here is therefore an **extension**, not spec conformance:
the code labels it accordingly and every method is capability-gated.

The live binary probed for this integration was `agy 1.5.1`
(`agy acp --stdio`).

## What `session/new` returns (probe result)

```json
{
  "sessionId": "…",
  "models": {
    "availableModels": [{ "modelId": "gemini-4-argon-medium", "name": "Gemini 4 Argon (Medium)" }],
    "currentModelId": "gemini-4-argon-medium"
  },
  "modes": {
    "currentModeId": "default",
    "availableModes": [{ "id": "default", "name": "Default", "description": "…" }]
  },
  "configOptions": [
    { "id": "model", "name": "Model", "category": "model", "type": "select",
      "currentValue": "gemini-4-argon", "options": [{ "value": "gemini-4-argon", "name": "…" }] },
    { "id": "thought_level", "name": "Thinking Level", "category": "thought_level", "type": "select",
      "currentValue": "medium", "options": ["low", "medium", "high"] },
    { "id": "mode", "name": "Mode", "category": "mode", "type": "select",
      "currentValue": "default", "options": ["default", "accept-edits", "plan"] }
  ]
}
```

Notes:

- `models.availableModels[].modelId` uses **variant-suffixed** ids
  (`gemini-3.8-flash-medium`) while `configOptions[id=model].currentValue` uses
  the **base** id (`gemini-3.8-flash`). The runtime preserves the requested
  variant id on the session and mirrors the config value separately.
- The exact key names are not specified anywhere, so the parser accepts the
  camelCase shape above **and** `available_models` / `current_model_id` /
  `config_options` at either level. Unknown keys never crash a session.
- `session/resume` returns the same shape as `session/new`.

## Capabilities advertised by `initialize`

`agy 1.5.1` advertises both spellings:

```
agentCapabilities.loadSession === true
agentCapabilities.load_session === true
agentCapabilities.sessionCapabilities.{load,resume,close,list,additionalDirectories}
agentCapabilities.session_capabilities.{…}
```

It does **not** advertise `delete`; `session/delete` answers `-32601`. The
runtime reads all spellings and never sends a method whose capability is absent.

## Methods

| Method | Kind | Runtime entry point |
| --- | --- | --- |
| `session/set_config_option` | primary (ACP v1) | `setConfigOption(sessionId, configId, value)` |
| `session/set_model` | legacy alias (PR #14) | `setModel(...)`, `setModelLegacy(...)` |
| `session/set_mode` | legacy alias (PR #14) | `setMode(...)`, `setModeLegacy(...)` |
| `session/list` | extension, gated | `listRemoteSessions(sessionId)` |
| `session/resume` | extension, gated | `resumeSession(sessionId)` |
| `session/close` | extension, gated | sent by `closeSession(...)` when advertised |
| `session/delete` | extension, gated | `deleteSession(sessionId)` |
| `session/load` | extension/v1, gated | used by `createSession({ resumeSessionId })` |

Alias fallback is one-directional and error-specific: a legacy alias falls back
to `session/set_config_option` **only** on `-32601` (and the `*Legacy` helpers
try the alias first and fall back the other way). Any other error is rethrown —
retrying a rejected mutation could apply a change the agent refused.

## REST surface

- `GET  /api/acp/sessions/:sessionId/config` — `configOptions`, modes, models,
  and the normalized capability flags.
- `POST /api/acp/sessions/:sessionId/config` — `{ configId, value }` →
  `session/set_config_option`.
- `POST /api/acp/sessions/:sessionId/model` — `{ modelId }` (primary config call,
  legacy fallback).
- `POST /api/acp/sessions/:sessionId/mode` — `{ modeId }`.
- `DELETE /api/acp/sessions/:sessionId` — closes, and calls `session/delete`
  only when advertised.

There is no ACP-specific mode/model picker in the UI (the existing picker drives
OpenCode provider/models), so the calls are exposed here for any client that
renders `configOptions`.

## Notifications

The spec delivers both as SessionUpdate variants inside `session/update`, which
is what `agy 1.5.1` does:

- `available_commands_update` → `availableCommands`
- `config_option_update` → `configOptions`

The extension surface also permits them as **standalone notifications**
(`session/available_commands_update`, `session/config_option_update`). Both
shapes are normalized by the same code and neither is answered: a notification
has no `id`, so a response would be a JSON-RPC violation. Unknown standalone
notifications are ignored.
