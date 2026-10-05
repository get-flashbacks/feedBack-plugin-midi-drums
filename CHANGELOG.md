# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `midi-drums/` — device-access layer for MIDI drum controllers. Scans for input devices through the core `window.feedBack.midiInput` capability, opens several at once, merges their note-ons into one stream tagged with `logicalSourceKey`, and exposes `window.midiDrumsDevices` (`getState`, `subscribe`, `discover`, `setEnabled`, `setActive`, `onHit`, `dispose`). Saved device keys persist server-side through `/api/plugins/midi-drums/settings`. Degrades to a no-op on a Host without the domain and retries a denied permission request rather than latching it.
- `nav` field in `my-plugin/plugin.json` (`{ "label": "My Plugin", "screen": "plugin-my-plugin" }`) so the plugin registers a sidebar entry.
- `AGENTS.md` — reference guide for AI assistants/contributors covering the actual API shape, plugin conventions, known code notes, and a verification checklist.

<!-- Add entries under Added, Changed, Deprecated, Removed, Fixed, or Security as changes land. -->
