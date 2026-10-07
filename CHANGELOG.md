# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `midi-drums/` — device-access layer for MIDI drum controllers. Scans for input devices through the core `window.feedBack.midiInput` capability, opens several at once, merges their note-ons into one stream tagged with `logicalSourceKey`, and exposes `window.midiDrumsDevices` (`getState`, `subscribe`, `discover`, `setEnabled`, `setActive`, `onHit`, `dispose`). Saved device keys persist server-side through `/api/plugins/midi-drums/settings`. Degrades to a no-op on a Host without the domain and retries a denied permission request rather than latching it.
- `nav` field in `my-plugin/plugin.json` (`{ "label": "My Plugin", "screen": "plugin-my-plugin" }`) so the plugin registers a sidebar entry.
- `AGENTS.md` — reference guide for AI assistants/contributors covering the actual API shape, plugin conventions, known code notes, and a verification checklist.

- `midi-drums` kit-profile persistence (#5) — `kit_updated_at` stamps, `per_song_overrides`, bounded server validation, and `settings.server_files` in `plugin.json` for Host-side export/import.
- `midi-drums` drum-chart consumption (#6) — the plugin holds its own listener on the highway WS (core exposes the chart to renderer bundles only, with no bus event or `getDrumTab()` getter), a `?drum_part=` picker for multi-part packs, and "no chart — scoring off" degradation for legacy packs.
- `midi-drums` live scoring engine (#7) — ±50 ms hit matching with EARLY/OK/LATE split, per-frame miss sweep with a connect-time floor and seek-back re-arm, streak/accuracy/streak counters, and bounded surfacing of unmapped strikes/missing chart pieces (mirrors `drum_highway_3d`).
- `midi-drums` note-state provider integration (#8) — a function provider `(note, chartTime) => state` registered on `window.highway` only while a device session is open, cleared with `setNoteStateProvider(null)` on exit/disposal.
- `midi-drums` kit-profile settings panel (#9) — `settings.html` with profile CRUD, active-profile switching, per-profile coverage chips, last-updated stamps, and remap deep-links into the player screen's single-piece remap path.
- `midi-drums` active-kit picker and profile creation on the plugin screen; part picker, chart status, streak/extras and unmapped readouts on the screen.

### Fixed
- `midi-drums` piece vocabulary drifted from the host's `lib/drums.py` (`tom1`/`floor_tom`/`rim`… were invented ids) — now the canonical 18-id set; unknown ids round-trip with a title-cased fallback.
- `midi-drums` registered an object wrapper with `highway.setNoteStateProvider` (the contract takes a function `(note, chartTime)` and was never invoked) and never cleared the slot — rewritten per feedBack#254, cleared on teardown.
- `midi-drums` calibrated against bus events `drum-tab`/`drum-hits`/`drum-part` that no host component emits; replaced with the plugin's own chart WS.
- `midi-drums` dead code removed: `onDrumTabChanged` runner, the unused note-state wrapper, and an unreachable view-scope `registerWithHighway()` call.

<!-- Add entries under Added, Changed, Deprecated, Removed, Fixed, or Security as changes land. -->
