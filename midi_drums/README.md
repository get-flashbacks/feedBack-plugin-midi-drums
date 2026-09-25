# MIDI Drums

Play feedBack drum-tab charts live with a MIDI drum controller (electronic
kit, pad controller, or a MIDI keyboard mapped to General MIDI drum notes).

**Status: placeholder.** The plugin currently loads and shows an empty
screen. No MIDI input, mapping, or scoring is implemented yet — this repo
exists so the feature can be scoped and built incrementally.

## Planned scope

- Web MIDI input (`navigator.requestMIDIAccess`), General MIDI drum-map
  note mapping (kick=36, snare=38, hi-hat=42, etc.), configurable per kit.
- Consume drum-tab arrangements (as produced by
  `gp2rs.convert_drum_track_to_drumtab` / feedpak drum-tab data).
- Reuse `feedback-plugin-notedetect`'s scoring layer (hits/misses/streak/
  score/grade, HUD, `notedetect:hit`/`notedetect:miss` events) rather than
  duplicating it, following the same pattern as other instrument inputs.
- `setRenderer`-compatible visualization for drum lanes, modeled on
  `feedback-plugin-piano`'s per-instance factory + lifecycle contract.

See the org's plugin spec (`feedback-plugin-spec`) and `feedBack`'s
`CLAUDE.md` for the plugin manifest, `setRenderer`, and note-state-provider
contracts this plugin will build on.

## License

AGPL-3.0-or-later. See the repository `LICENSE` file.
