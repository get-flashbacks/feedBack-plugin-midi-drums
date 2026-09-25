# my-plugin

A feedBack plugin template with all common surfaces: client screen, settings panel, and server routes.

**Note:** Before using this template, read the [official Plugin Specification](https://github.com/get-flashbacks/feedback-plugin-spec/blob/main/spec/plugin-spec-v1.md). See the template repository's README for important disclaimers and warranty information.

## Overview

This template demonstrates a complete, working feedBack plugin that includes:

| Surface | File | Manifest key |
|---|---|---|
| Client screen | `screen.js` | `script` |
| Styles | `assets/plugin.css` | `styles` |
| Settings panel | `settings.html` | `settings` |
| Server routes | `routes.py` | `routes` |

The plugin persists user settings through its server routes and applies them on the client.

## Getting started

### 1. Rename the plugin

Before anything else, choose a unique `id` for your plugin. The folder name **must exactly match** the manifest `id`. This is the most common discovery failure.

- **Rename** the `my-plugin/` folder to your chosen name (e.g., `tuner`, `drum-highway-3d`).
- **Update** `plugin.json` to set `"id": "<your-new-id>"` to match the folder name.
- Use **lowercase alphanumeric with `-` or `_` separators** (e.g., `^[a-z0-9][a-z0-9_-]*$`).

**Important:** The `id` is permanent. Changing it orphans users' saved settings and breaks derived names across the app. Choose it carefully and don't rename later.

### 2. Edit the manifest

Open `plugin.json` and customize:

- `name` — Human-readable display name
- `version` — Start with `"0.1.0"`; bump on releases
- `description` — One-line description for the plugin list
- `type` — Plugin category (e.g., `"visualization"`, `"filter"`, `"utility"`)
- `icon` — An emoji or asset reference (emoji is simplest: `"🎨"`)

### 3. Edit the screen

Update `screen.js` to implement your plugin's functionality. The script:

- **Runs on load:** The Host executes it once when the screen is first displayed.
- **Is self-executing:** You don't export a function for the Host to call. Set up everything you need when the script runs.
- **Must be idempotent:** It may re-run if the plugins reload. Guard against duplicate listeners/timers using a flag (see the `window[__${PLUGIN_ID}_setup]` pattern in the template).
- **Shares the main thread:** Keep expensive work off the high-frequency render loop (see spec §6.4).

To query your own DOM, use the plugin ID:

```javascript
const root = document.getElementById(`plugin-${PLUGIN_ID}`);
```

All DOM queries and style writes should happen once at setup time, not on every frame.

### 4. Edit the settings panel

Customize `settings.html` to add the controls your plugin needs. The template includes:

- Form inputs (select, range, checkbox)
- Load/save logic using fetch to your server routes
- Scoped CSS classes to avoid leaking styles

**Important:** Settings are persisted through the server routes (`POST /api/plugins/<id>/settings`), not by writing to disk from the client.

### 5. Edit the server routes

Update `routes.py` to handle any server-side logic:

- Validate and persist user settings
- Serve data to the client
- Integrate with external services or files

**Key rules:**

- Do all work inside `setup()`. Never block at import time.
- Namespace all routes under `/api/plugins/<id>/...` to avoid collisions.
- Validate configuration before registering any route.
- Read/write only inside `context["config_dir"]` — never elsewhere.

### 6. Edit the styles

Customize `assets/plugin.css` for your plugin's visual appearance. Remember:

- **Scope all selectors** to your plugin's classes (`.my-plugin`, `.my-plugin-settings`) so styles don't leak.
- **Don't mutate the app shell.** Use the Host's contribution registries to add to shared surfaces (spec §6.3).
- The Host applies these styles only while your screen is active, then unloads them.

## How settings work

1. **Client loads settings:** Call `GET /api/plugins/<id>/settings` when the settings panel or screen mount.
2. **User modifies settings:** The settings panel collects form input.
3. **Client saves settings:** Call `POST /api/plugins/<id>/settings` with a JSON object.
4. **Server persists:** The routes module writes to `context["config_dir"]/<id>.json`.
5. **Client updates screen:** Refresh the display with the new values.

The template includes working examples of this flow in `settings.html` and `routes.py`.

## Common tasks

### Add a new setting

1. Add a form input to `settings.html` with `data-setting="<key>"`.
2. Add a default value in `routes.py` (_DEFAULTS dict).
3. The client-side JavaScript in `settings.html` handles loading and saving automatically.

### Perform work while the screen is active

Listen to the `screen:changed` event on the Host's event bus (if available):

```javascript
if (window.feedBackHost?.eventBus) {
  window.feedBackHost.eventBus.on("screen:changed", (screenId) => {
    if (screenId === PLUGIN_ID) {
      // Your screen is now active
    } else {
      // Your screen is now inactive
    }
  });
}
```

### Split client code into modules

If your screen script grows large, migrate to `scriptType: "module"` and split code:

1. Change `plugin.json`:
   ```json
   "scriptType": "module",
   "script": "screen.js",
   ```

2. Create a `src/` directory with your modules:
   ```
   src/
   ├── main.js
   ├── state.js
   └── ui.js
   ```

3. Have `screen.js` import from `src/`:
   ```javascript
   import './src/main.js';
   ```

The Host serves the `src/` tree so imports resolve (spec §6.8).

### Add navigation or contribute to shared surfaces

The Host exposes registries for contributing to shared surfaces (library cards, renderers, etc.). This prevents you from directly mutating the app shell's DOM, which would cause performance problems (spec §6.4).

Check the Host's event bus and contribution registries:

```javascript
if (window.feedBackHost?.eventBus) {
  // Subscribe to app events
  window.feedBackHost.eventBus.on("song:ready", () => { ... });
}
if (window.feedBackHost?.libraries?.registerCardAction) {
  // Register a library card action
  window.feedBackHost.libraries.registerCardAction(/* ... */);
}
```

The exact API is Host-provided and versioned; check the Host's documentation.

## Debugging

### Plugin not discovered?

1. Check the folder name matches the manifest `id` exactly (including case).
2. Run the reference validator: `python tools/validate.py <plugin-folder>`
3. Check server logs for import errors in `routes.py`.

### Settings don't persist?

1. Check browser DevTools for network errors on the POST to `/api/plugins/<id>/settings`.
2. Verify `context["config_dir"]` is writable.
3. Check server logs for route errors.

### Performance issues?

1. Avoid DOM queries and style reads on the high-frequency render loop.
2. Suspend animations and subscriptions when your screen is inactive.
3. Profile with DevTools to find hot spots.

## Spec reference

- [Plugin Specification](https://github.com/get-flashbacks/feedback-plugin-spec/blob/main/spec/plugin-spec-v1.md)
- [Best Practices Guide](https://github.com/get-flashbacks/feedback-plugin-spec/blob/main/spec/best-practices.md)

## License

This template code is licensed under the [GNU Affero General Public License v3.0 or later](../LICENSE) (AGPL-3.0-or-later). See the LICENSE file in the parent directory.

**When you create your own plugin:**
- You are free to choose any license for your plugin code
- Consider adding an SPDX license identifier to each source file (see examples in this template)
- Include a LICENSE file in your plugin directory with your chosen license text

**Common license choices for plugins:**
- `AGPL-3.0-or-later` — Ensures derivatives remain free (recommended for community plugins)
- `MIT` — Permissive, minimal requirements
- `Apache-2.0` — Permissive with patent grant
- `GPL-3.0-or-later` — Copyleft without the network clause
