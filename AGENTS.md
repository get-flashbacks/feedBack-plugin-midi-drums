# feedBack Plugin Template — Agent Guide

## What this template does

A reference implementation demonstrating the fundamental feedBack plugin contract: a client screen, a server-persisted settings panel, and namespaced server routes. It is meant to be copied and renamed, not used as-is.

## Files

| File | Purpose |
|---|---|
| `my-plugin/plugin.json` | Manifest — id `my-plugin`, nav entry, script/styles/settings/routes, type, icon, minHost |
| `my-plugin/screen.js` | Client screen logic — finds its root by `plugin-<id>`, wires up an example counter, loads persisted settings |
| `my-plugin/settings.html` | Settings panel markup, grouped under `settings.category` |
| `my-plugin/routes.py` | FastAPI `setup(app, context)` — registers GET/POST `/api/plugins/my-plugin/settings` with schema validation and persistence |
| `my-plugin/assets/plugin.css` | Styling scoped to the plugin |
| `my-plugin/README.md` | Per-plugin documentation for whoever copies this template |

## Actual API shape

- **Routes:** `GET /api/plugins/my-plugin/settings`, `POST /api/plugins/my-plugin/settings`
- **Settings schema:** `{color: "indigo"|"crimson"|"emerald"|"amber", intensity: int 0-10, enable_animations: bool}`
- **GET response:** current settings, merged with defaults for any missing keys
- **POST body:** a JSON object containing a subset of recognized settings; unknown keys or invalid values return `400`
- **POST limits:** request body capped at `MAX_SETTINGS_BODY_BYTES` (16 KiB); oversized or malformed bodies return `413`/`400`
- **Persistence:** settings are written to `<config_dir>/my-plugin.json` off the event loop via `asyncio.to_thread`

## Key conventions (feedBack plugin contract)

- **plugin.json id must match directory name** — `my-plugin` == `my-plugin/`
- **Nav screen** uses `"nav": { "label": "My Plugin", "screen": "plugin-my-plugin" }`
- **screen.js finds its own root** via `document.getElementById('plugin-<id>')` — the Host injects markup into that container
- **Settings persist server-side**, not in browser storage — always go through the plugin's own routes
- **routes.py exports `setup(app, context)`** — receives the FastAPI app and a context dict with `config_dir` and `log`
- **Configuration validation happens once in `setup()`**, before any route is registered, so a broken config fails plugin load loudly rather than failing silently on first request
- **API path** is `/api/plugins/<plugin_id>/<route>`
- **No build step** — vanilla JS, no npm

## Known issues / code notes

- `screen.js` uses a `window[\`__${PLUGIN_ID}_setup\`]` guard to avoid double-initializing on re-hydration.
- `loadSettings()` fails soft on fetch errors (`console.warn`) rather than throwing, so a settings-load failure degrades the screen instead of crashing it.
- `_is_valid_setting()` in `routes.py` uses `type(value) is int` / `type(value) is bool` (not `isinstance`) specifically to reject `bool` being accepted where `int` is expected (Python's `bool` is an `int` subclass).

## Verification checklist

1. Plugin loads without server errors (`setup()` validates config before registering routes)
2. Nav entry "My Plugin" appears in sidebar
3. Clicking the counter button increments the on-screen counter
4. GET `/api/plugins/my-plugin/settings` returns defaults on first load
5. POSTing a valid settings subset persists and is reflected on next GET
6. POSTing an unknown key or invalid value returns `400`
7. Oversized POST body returns `413`

## Common pitfalls

- **Folder name must equal `plugin.json` id**, including case
- **Route collisions** — always prefix with `/api/plugins/<id>/`
- **FastAPI POST routes** need `from fastapi import Request` and `async def route(request: Request)` reading the body via a bounded stream, not `await request.json()` directly, if you want the size cap to apply before full deserialization
