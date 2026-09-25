# feedBack Plugin Template

A reference template for creating [feedBack plugins](https://github.com/got-feedBack/feedback-plugin-spec).

## ⚠️ DISCLAIMER AND WARRANTY

**This template is provided "AS-IS" without any warranty of any kind, express or implied.** No warranty is given that this template is correct, complete, safe, or fit for any particular purpose.

**You MUST read and follow the official [Plugin Specification](https://github.com/get-flashbacks/feedback-plugin-spec/blob/main/spec/plugin-spec-v1.md) before creating a plugin.** This template is an example that demonstrates some common patterns, but:

- The specification is the authoritative reference. This template may not cover all requirements.
- You are responsible for ensuring your plugin complies with the specification.
- Compliance with this template does not guarantee compliance with the specification.
- If this template conflicts with the specification, the specification takes precedence.

**Liability:** The authors, contributors, and distributors of this template disclaim all liability for any damages, losses, or consequences arising from the use or inability to use this template, including but not limited to data loss, system failures, security vulnerabilities, or any other issues related to plugin development or deployment.

**Read the spec. This is your responsibility.**

## Quick start

1. **Copy the template:** Duplicate the `my-plugin/` directory and rename it to your plugin's `id`.
   ```bash
   cp -r my-plugin your-plugin
   ```

2. **Update the manifest:** Edit `your-plugin/plugin.json`:
   - Change `"id"` to match your folder name (e.g., `"your-plugin"`)
   - Update `name`, `version`, `description`, `type`, `icon`

3. **Customize the plugin:** Edit the files in your plugin directory:
   - `screen.js` — Client-side screen logic
   - `settings.html` — Settings panel markup and behavior
   - `routes.py` — Server-side logic and persistence
   - `assets/plugin.css` — Styling

4. **Drop into feedBack:** Copy your plugin folder into the feedBack plugins directory (default: `~/.config/feedback/plugins/` on Linux, or the platform equivalent).

5. **Reload plugins:** Restart feedBack or use the plugin manager to reload. Your plugin should appear in the plugin list.

## What's included

### `my-plugin/`

A complete, working plugin that demonstrates:

- A **client screen** (`screen.js`) with lifecycle management
- **Settings persistence** (HTML form + server routes)
- **Server routes** (`routes.py`) for reading/writing settings
- **Styling** (`assets/plugin.css`) scoped to the plugin
- **Documentation** (`README.md`) with common tasks and tips

Each file is heavily commented and shows best practices from the [Plugin Specification](https://github.com/get-flashbacks/feedback-plugin-spec/blob/main/spec/plugin-spec-v1.md).

## Key concepts

### The folder name must match the `id`

This is the most common cause of "why won't my plugin load?" The folder name and manifest `id` must be **exactly identical**, including case.

```
tuner/                  ✅ Loads as id: "tuner"
├── plugin.json        →  {"id": "tuner", ...}
└── ...

Tuner/                  ❌ Will not load (name doesn't match id)
├── plugin.json        →  {"id": "tuner", ...}
└── ...
```

### Settings are server-persisted

Settings are stored server-side in the Host's config directory (usually `~/.config/feedback/plugins/<id>/<id>.json`), not in browser storage. Always fetch/post through your routes:

```javascript
// Load
const res = await fetch(`/api/plugins/${PLUGIN_ID}/settings`);
const settings = await res.json();

// Save
await fetch(`/api/plugins/${PLUGIN_ID}/settings`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ key: "value" }),
});
```

### Keep everything namespaced

Because all plugins share one document and one `window`, prefix everything with your plugin `id`:

- DOM ids/classes: `.my-plugin`, `#plugin-my-plugin`
- `window` globals: `window.my_plugin_state`
- `localStorage` keys: `my_plugin_config`
- Route paths: `/api/plugins/my_plugin/...`

Namespace collisions silently clobber each other, so be explicit.

### The script must be idempotent

The Host may execute your `screen.js` more than once (e.g., during plugin reloads). Guard against duplicate listeners:

```javascript
if (!window.__my_plugin_setup) {
  window.__my_plugin_setup = true;
  // Set up listeners, timers, observers — only once
}
```

See the template's `screen.js` for the pattern.

## Further reading

- **[Plugin Specification](https://github.com/get-flashbacks/feedback-plugin-spec/blob/main/spec/plugin-spec-v1.md)** — The normative contract. Start here if something doesn't work.
- **[Best Practices Guide](https://github.com/get-flashbacks/feedback-plugin-spec/blob/main/spec/best-practices.md)** — Non-normative advice on building good plugins.
- **[Full Example Plugin](https://github.com/get-flashbacks/feedback-plugin-spec/tree/main/examples/full-plugin)** — Another worked example in the spec repo.

## Troubleshooting

### Plugin doesn't load

1. Check the folder name matches the manifest `id` (case-sensitive).
2. Run the reference validator: `python tools/validate.py <plugin-folder>` (if cloned from the spec repo).
3. Check the Host's logs for import errors in `routes.py` or `script` parsing errors.

### Settings don't persist

1. Check browser DevTools Network tab for errors on POST to `/api/plugins/<id>/settings`.
2. Verify the Host can write to its config directory.
3. Check the Host's logs for route errors in your `routes.py`.

### Styles not applied

1. Verify the manifest `styles` key points to the correct CSS file.
2. Check that selectors are scoped to your plugin's class (not `.screen` or global).
3. DevTools may show the Host's styles overriding yours — use higher specificity if needed.

## License

This template and all example code are licensed under the [GNU Affero General Public License v3.0 or later](LICENSE) (AGPL-3.0-or-later). See the `LICENSE` file for full details.

### About Your Plugin's License

When you create a plugin from this template:

- **You own your plugin.** You are free to choose any license for your plugin code. The template is provided under AGPL-3.0-or-later, but your derivative work can use a different license if you prefer.
- **Recommended licenses:**
  - **AGPL-3.0-or-later** — Ensures derivatives remain free and open. Good for plugins you want to keep community-driven.
  - **MIT** — Permissive, widely used, minimal requirements. Good for permissive distribution.
  - **Apache-2.0** — Permissive with explicit patent grant. Good for corporate environments.
  - **GPL-3.0-or-later** — Copyleft without the network clause. Simpler than AGPL for non-network plugins.

- **Include a LICENSE file** in your plugin's directory with your chosen license text.
- **Add SPDX headers** to each source file (see the template files for examples).
- **Document your license** in your plugin's README.

The feedBack project itself uses AGPL-3.0-or-later to ensure the platform and its ecosystem remain free and community-driven. Your plugin's license is independent of this choice.
