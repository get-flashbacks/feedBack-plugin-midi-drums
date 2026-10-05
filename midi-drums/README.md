# midi-drums

Device-access layer for MIDI drum controllers. Scans for input devices, opens
several at once, and merges their note-ons into a single tagged stream — the
foundation the kit-profile work builds on.

This plugin never touches the Web MIDI API. It goes through the Host's
capability layer, `window.feedBack.midiInput`, and is written to work when that
domain is absent or mid-version.

## Files

| File | Purpose |
|---|---|
| `plugin.json` | Manifest — capability declaration, `type: "input"`, nav entry, no settings panel |
| `screen.html` | Device list, rescan control, saved-device status, bounded hit log |
| `screen.js` | Device layer (`window.midiDrumsDevices`) + screen lifecycle |
| `routes.py` | Server-persisted selection (`source_keys`) at `/api/plugins/midi-drums/settings` |
| `assets/plugin.css` | Styling scoped to the plugin |

## How it talks to MIDI

`plugin.json` asks for a narrow slice of the domain:

```json
"capabilities": {
  "midiInput": {
    "roles": ["requester"],
    "requests": ["discover", "list-sources", "select-source", "open-source", "close-source"],
    "mode": "active",
    "compatibility": "degrade-noop",
    "ownership": "requester-only",
    "safety": "sensitive",
    "version": 1
  }
}
```

- **`mode: "active"`** — the screen calls `discover()` only once it is the
  active screen, so the permission prompt never appears while the user is on
  some other part of the Host.
- **`compatibility: "degrade-noop"`** — an older Host without the domain still
  loads the plugin. The screen explains the situation instead of failing.
- **`ownership: "requester-only"`** — the plugin never asserts itself as a MIDI
  provider, so it cannot collide with core `input_setup`.
- **`safety: "sensitive"`** — device access is a deliberate user act, reached
  through an explicit tick per device.

`availability` is gated on `mi && mi.version === 1`, not on
`navigator.requestMIDIAccess`. A version mismatch, a late-loading domain, and a
genuinely unavailable Host all read as "not available" rather than as a crash.

## The `window.midiDrumsDevices` API

```js
const devices = window.midiDrumsDevices;

const state = devices.getState();
// { available, ready, discovered, active, sources, savedKeys, openKeys,
//   status: 'idle'|'scanning'|'ready'|'empty'|'denied'|'unavailable'|'failed',
//   reason }

const stop = devices.subscribe((state) => { /* re-render */ });
stop();   // unsubscribe

await devices.discover({ force: true });  // retry after denial
devices.setEnabled('web-midi::pads', true);
devices.setActive(false);                  // close everything, no rediscovery
devices.dispose();                         // release listeners + bus handles

const offHits = devices.onHit((hit) => {
// hit.logicalSourceKey, hit.note, hit.velocity, hit.channel (0-based)
});
offHits();
```

`subscribe` fires immediately with the current state. `onHit` is the merged
stream across every open source; each hit carries the `logicalSourceKey` it came
from, so a consumer never has to track connections itself.

## Device identity

Sources are keyed by `logicalSourceKey` (`web-midi::<stable-id>`), never by a
label or list index. Labels come from user-supplied hardware and can change or
be duplicated between connections; keys do not. The selected keys are persisted
in `routes.py`, so a selection survives reloads.

## Behaviour worth knowing

- **Replug, no fallback-switching.** A ticked device that is unplugged keeps its
  tick, the screen says it will reopen automatically, and a different device is
  *never* substituted in its place. A stale or renamed device must not silently
  become someone else's input.
- **Denial is retryable.** `discover()` is the permission boundary, so a denied
  result is recorded but never latched — the rescan button re-runs it.
- **Per-source serialisation.** The domain keeps one shared session per source,
  refcounted by requester name. Two concurrent opens add a single reference,
  while two closes would remove it twice and tear the session out from under
  whichever open survived. Every open and close for a source therefore runs
  through a promise chain (`chains` in `screen.js`), and a superseded open
  releases the reference it just took. A redundant queued open short-circuits,
  which is what keeps one listener per source.
- **Opens never outrun the screen.** `active` is re-checked where the open
  actually happens, not just before the loop that started it. A user who
  navigates away while a tick's POST is still in flight would otherwise leave a
  session that `closeAll()` had already walked past.
- **Generation guard.** Each source carries a generation counter, bumped on
  every close. An `open()` that resolves against a retired generation is
  discarded rather than resurrecting a session the user has already cancelled.
- **Everything closes.** Sessions are released on untick, unplug, `screen:
  changing`, `pagehide`, and view disposal. `screen:changed` and `pageshow`
  reopen the saved selection. `screen:changing` is best-effort rather than a
  spec guarantee; `pagehide` is the guaranteed backstop.
- **Late Host wiring.** `window.feedBack` and the `midiInput` domain can both
  appear after this script runs. The bus subscription is retried on every
  activation, including no-op transitions, so a late bus cannot silently kill
  replug recovery for the session.
- **Only declared verbs.** The plugin calls the five verbs in `plugin.json` and
  nothing else. `getSelected()` is treated as an optional optimisation: absent
  or throwing is normal, since a Host may implement only what is declared.
- **Device labels use `textContent`.** A MIDI device name is user-controlled
  hardware text and is never parsed as markup.
- **Bounded work.** At most 8 sources and 200 characters per key
  (`MAX_SOURCES` / `MAX_SOURCE_KEY_LEN`, matching `routes.py`), so an over-long
  key can't turn every save into a rejected POST; the hit log keeps its newest
  12 rows and its own running total.
- **Settings failures degrade.** A failed load leaves discovery intact; a failed
  save keeps the session and the in-memory selection working. Saves are
  chained, so overlapping POSTs can't roll the file back to an older selection.
- **A hand-edited config can't wipe a selection.** POST validates strictly, but
  a file containing one bad entry is salvaged key-by-key on read rather than
  discarded wholesale, and writes go through a temp file + rename so a torn
  write cannot produce the corrupt JSON that recovery would then treat as empty.

## Verification

The repository has no build, lint, or test tooling, so verification was done
with throwaway harnesses outside the tree (jsdom + a fake MIDI domain, and
FastAPI + `httpx` against `routes.py`). Behaviour covered: fail-soft on an
absent domain, late domain arrival, denial then retry, two simultaneous sources
with tagged/merged hits, note-on filtering (note-off, zero-velocity strikes and
other channel traffic ignored), replug without fallback-switching, close and
reopen across screen changes, no discovery while inactive, rescan picking up a
later device, idempotent re-hydration, the source cap and its visible rejection,
the bounded hit log, settings-load/save failure, navigating away mid-save, a
Host without `getSelected()`, and a bus that only appears after the script runs.

For a manual pass, follow the checklist in the repository `AGENTS.md` against a
real Host build with a device attached: the plugin loads, the nav entry appears,
ticking a device opens it, strikes show in the hit log, and navigating away
closes the session.