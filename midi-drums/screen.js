// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Client screen + device layer for midi-drums.
//
// MIDI devices are reached through the core `midi-input` capability domain
// (`window.feedBack.midiInput`), never through a private
// `navigator.requestMIDIAccess()` call. That is the shared device-access
// boundary `input_setup` and `drum_highway_3d` already use: one permission
// prompt, one source list, and uniform behaviour for a MIDI keyboard, a generic
// pad controller or an e-kit module — Web MIDI abstracts all three identically
// at this layer.
//
// What this file owns is the device layer plus everything built on it: the
// kit-profile CRUD (with per-profile last-modified stamps and per-song piece
// overrides), drum-chart consumption (its own WS listener — see below), the
// live hit-matching/scoring engine, and the note-state provider that hands
// judgments to whichever highway renderer is active
// (`highway.setNoteStateProvider`, core feedBack#254 contract). The device
// layer (`window.midiDrumsDevices`) hands all of it a single logical stream
// of note-ons tagged with the `logicalSourceKey` they arrived on (so a kick
// pedal on one interface and pads on another stay distinguishable).
(function () {
    'use strict';

    const PLUGIN_ID = 'midi-drums';
    const SCREEN_ID = `plugin-${PLUGIN_ID}`;
    // Identifies us to the domain's shared open/close refcount. One requester
    // name per plugin, matching `input_setup`'s usage.
    const REQUESTER = PLUGIN_ID;
    const GLOBAL_KEY = 'midiDrumsDevices';
    const VIEW_KEY = `__${PLUGIN_ID}_view`;
    // Bounded so a device farm can't grow the persisted selection without limit.
    // These must match MAX_SOURCE_KEYS / MAX_SOURCE_KEY_LEN in routes.py.
    const MAX_SOURCES = 8;
    const MAX_SOURCE_KEY_LEN = 200;
    const MAX_HIT_ROWS = 12;
    // Canonical drum piece vocabulary, 1:1 with the host's lib/drums.py
    // PIECES. Kit profiles key their mappings on these ids and must never
    // invent ids of their own — a newer sloppak may still reference a piece
    // missing here; such ids round-trip (title-cased display fallback) like
    // they do in lib/drums.py.
    const PIECES = {
        kick: { name: 'Kick' },
        snare: { name: 'Snare' },
        snare_xstick: { name: 'Snare Cross-Stick' },
        tom_hi: { name: 'Hi Tom' },
        tom_mid: { name: 'Mid Tom' },
        tom_low: { name: 'Low Tom' },
        tom_floor: { name: 'Floor Tom' },
        hh_closed: { name: 'Hi-Hat Closed' },
        hh_open: { name: 'Hi-Hat Open' },
        hh_pedal: { name: 'Hi-Hat Pedal' },
        stack: { name: 'Stack' },
        crash_l: { name: 'Crash Left' },
        crash_r: { name: 'Crash Right' },
        splash: { name: 'Splash' },
        china: { name: 'China' },
        ride: { name: 'Ride' },
        ride_bell: { name: 'Ride Bell' },
        bell: { name: 'Bell' },
    };

    // ── domain access ──────────────────────────────────────────────────────

    // Availability is the midi-input DOMAIN being present, not the Web-MIDI
    // browser API. The domain coordinates providers — the built-in Web-MIDI one
    // plus any native/desktop adapter — so gating on
    // `navigator.requestMIDIAccess` would hide a usable non-Web-MIDI provider
    // before discover() has ever run.
    function midiDomain() {
        const mi = window.feedBack && window.feedBack.midiInput;
        return (mi && mi.version === 1) ? mi : null;
    }

    // ── device layer ───────────────────────────────────────────────────────
    //
    // A singleton installed once on `window`. The Host may execute screen.js
    // more than once in a session (spec §6.1), and a second copy of this layer
    // would mean a second set of bus listeners and a second open session per
    // device — each MIDI hit then delivered twice.
    function createDeviceLayer() {
        // logicalSourceKey → { handle, listener } for every source we hold open.
        const sessions = new Map();
        // logicalSourceKey → generation. An open() that resolves after the user
        // switched away from that source (or unplugged it) must not install a
        // session for it. Scoped per key, so tearing down one device doesn't
        // discard an unrelated in-flight open.
        const generations = new Map();
        // The user's ticked selection, server-persisted. This is also the
        // recovery target after an unplug: a device that disappears is closed,
        // never silently replaced by a substitute.
        let savedKeys = [];
        let keysLoaded = false;
        // discover() has succeeded. Only a `handled` outcome latches, so a
        // denied or unavailable result leaves the screen able to prompt again.
        let discovered = false;
        let discovering = null;
        let lastOutcome = null;
        // Screen-visibility gate (spec §6.2): MIDI delivery is suspended while
        // our screen is not the active one.
        let active = false;
        let sourcesChangedBound = false;
        let chartBusBound = false;
        const hitListeners = new Set();
        const stateListeners = new Set();
        const activateListeners = new Set();
        let activeKit = 'default';
        let kitProfiles = {};
        // Per-profile last-modified stamps (ISO strings), keyed by profile
        // name — the flat companion of kitProfiles, moved alongside the
        // profile on rename and dropped with it on delete.
        let kitUpdatedAt = {};
        // Sparse per-song piece overrides: songKey -> {pieceId -> mapping}.
        // Consulted before the base profile so a song-specific trigger swap
        // survives profile switches.
        let perSongOverrides = {};
        // ── drum chart (own WS) ─────────────────────────────────────────
        // The highway buffers the chart into its renderer bundle only — no
        // bus event, no public getter — so the chart is consumed over this
        // plugin's own WS connection to the same endpoint.
        let chartWs = null;
        let chartWsGen = 0;
        let chartStatus = 'idle';   // idle|connecting|loading|ready|no-chart|closed|failed
        let chartReason = '';
        let drumParts = [];         // [{id, name}] from song_info
        let activePartId = null;    // ?drum_part= selection (null = primary)
        let chartSongKey = '';      // song the loaded chart belongs to
        let currentDrumTab = null;  // {version, name, kit: [{id,name}], part_id}
        let currentDrumHits = [];   // [{t, p, v?, g?, f?, k?}] sorted by t
        let wizardState = null; // { phase, currentPiece, pendingPieces, captures, capturing }
        let providerInstalled = false;
        // ── live scoring ────────────────────────────────────────────────
        let scoreState = {
            hits: 0,
            misses: 0,
            total: 0,
            accuracy: 0,
            streak: 0,
            bestStreak: 0,
            extras: 0,
        };
        // Chart-hit key ("t|piece") -> { state: 'hit'|'miss', at:
        // performance.now(), ts?: 'EARLY'|'OK'|'LATE' }. The note-state
        // provider reads this map per visible chart note; the miss sweep and
        // the hit matcher both write it.
        const scoredJudgments = new Map();
        // Song-time at-or-before which chart notes are exempt from the miss
        // sweep (notes that elapsed with no device able to record them).
        let missFloor = -Infinity;
        let lastPlaybackTime = null;
        let hadOpenSession = false;
        let sweepTimer = null;

        function nextGeneration(key) {
            const next = (generations.get(key) || 0) + 1;
            generations.set(key, next);
            return next;
        }

        function listSources() {
            const mi = midiDomain();
            if (!mi) return [];
            try { return mi.listSources() || []; } catch (_) { return []; }
        }

        function getState() {
            const mi = midiDomain();
            return {
                available: !!mi,
                discovered,
                active,
                outcome: lastOutcome ? { ...lastOutcome } : null,
                sources: mi ? listSources() : [],
                openKeys: Array.from(sessions.keys()),
                savedKeys: savedKeys.slice(),
                activeKit,
                kitProfiles: kitProfiles,
                kitUpdatedAt: kitUpdatedAt,
                perSongOverrides: perSongOverrides,
                chartStatus,
                chartReason,
                drumParts: drumParts.slice(),
                activePartId,
                currentDrumTab,
                currentDrumHits,
                scoreState: { ...scoreState },
                wizard: wizardState ? { ...wizardState } : null,
                unmapped: unmappedSummary(),
            };
        }

        function emitState() {
            const state = getState();
            stateListeners.forEach((fn) => {
                try { fn(state); } catch (_) { /* one bad subscriber must not stop the rest */ }
            });
        }

        // ── permission boundary ──────────────────────────────────────────────

        async function discover(opts) {
            const force = !!(opts && opts.force);
            const mi = midiDomain();
            if (!mi) {
                lastOutcome = { outcome: 'unavailable', reason: 'The midi-input domain is not registered.' };
                emitState();
                return lastOutcome;
            }
            if (discovered && !force) return lastOutcome || { outcome: 'handled', reason: '' };
            if (discovering) return discovering;

            discovering = (async () => {
                let result;
                try {
                    // The permission boundary. `requestMIDIAccess()` lives in
                    // core's built-in Web-MIDI provider, behind this call.
                    result = await mi.discover();
                } catch (err) {
                    result = { outcome: 'failed', reason: String((err && err.message) || err) };
                }
                lastOutcome = {
                    outcome: (result && result.outcome) || 'failed',
                    reason: (result && result.reason) || '',
                };
                discovered = lastOutcome.outcome === 'handled';
                // Render before restoring so the view's label map is populated:
                // restore() opens sessions, and a device can strike the instant
                // it opens, which would otherwise log a bare key on first hits.
                emitState();
                await restore();
                return lastOutcome;
            })();

            try {
                return await discovering;
            } finally {
                discovering = null;
            }
        }

        // ── open / close ─────────────────────────────────────────────────────
        //
        // The domain keeps one shared open session per source, refcounted by
        // requester NAME: two opens under the same name add a single reference,
        // while two closes would remove it twice and tear the session out from
        // under whichever open survived. So every open and close for a source is
        // serialised through `chains`, which keeps our reference count paired
        // with the domain's no matter how the calls interleave.
        const chains = new Map();

        function enqueue(key, task) {
            const prev = chains.get(key) || Promise.resolve();
            const next = prev.then(task, task);
            const tail = next.catch(() => { /* the task handles its own errors */ });
            chains.set(key, tail);
            // Forget a source nobody is holding, so a churn of hot-plugged
            // device keys can't grow this map for the life of the session.
            tail.then(() => {
                if (chains.get(key) === tail && !sessions.has(key)) chains.delete(key);
            });
            return next;
        }

        function closeSource(key) {
            // Retire the generation first, so an open() still in flight for
            // this key is discarded rather than resurrecting the session.
            nextGeneration(key);
            const session = sessions.get(key);
            if (!session) return;   // nothing to release: no reference was taken
            sessions.delete(key);
            try { session.handle.removeListener(session.listener); } catch (_) { /* best-effort */ }
            enqueue(key, () => {
                const mi = midiDomain();
                if (!mi) return;
                try { mi.close({ requester: REQUESTER, logicalSourceKey: key }); } catch (_) { /* best-effort */ }
            });
        }

        async function openSource(key) {
            const mi = midiDomain();
            if (!mi || !key) return false;
            if (sessions.has(key)) return true;
            return enqueue(key, async () => {
                // A queued open may have finished while this one waited its
                // turn. Re-checking here is what keeps one listener per source:
                // the domain returns the same shared handle to a second open,
                // so installing a second listener would double every hit.
                if (sessions.has(key)) return true;
                // The user can leave the screen while this task waits its turn
                // (or while the tick's POST is still in flight). Opening then
                // would strand a session that closeAll() has already passed.
                if (!active) return false;
                const gen = nextGeneration(key);
                try {
                    // The domain keeps one selected key. Point it at a source of
                    // ours so the Host (and `input_setup`) see a coherent pick
                    // even though several devices are open at once.
                    await mi.select(key);
                } catch (_) { /* selection is advisory — open() is what matters */ }

                let res;
                try {
                    res = await mi.open({ requester: REQUESTER, logicalSourceKey: key });
                } catch (err) {
                    lastOutcome = { outcome: 'failed', reason: String((err && err.message) || err) };
                    emitState();
                    return false;
                }
                // Superseded while opening: the device was unplugged, unticked,
                // or the screen was left. Release the reference we just took —
                // safe to do unconditionally, because `chains` guarantees no
                // other open for this source is pending or live.
                if (generations.get(key) !== gen) {
                    try { mi.close({ requester: REQUESTER, logicalSourceKey: key }); } catch (_) { /* best-effort */ }
                    return false;
                }
                if (!res || !res.handle) {
                    // Deliberately no close() here. A resolved result with no
                    // handle means the domain declined (denied/failed/
                    // unavailable) and, per the domain's own failure paths,
                    // took no reference — so closing would decrement a refcount
                    // we never incremented, tearing down a session another
                    // requester (core `input_setup`) legitimately owns. The
                    // other two failure branches above us DO hold a handle, and
                    // so DO release it.
                    lastOutcome = {
                        outcome: (res && res.outcome) || 'unavailable',
                        reason: (res && res.reason) || '',
                    };
                    emitState();
                    return false;
                }

                const listener = (data) => onHit(key, data);
                try {
                    res.handle.addListener(listener);
                } catch (err) {
                    try { mi.close({ requester: REQUESTER, logicalSourceKey: key }); } catch (_) { /* best-effort */ }
                    lastOutcome = { outcome: 'failed', reason: String((err && err.message) || err) };
                    emitState();
                    return false;
                }
                sessions.set(key, { handle: res.handle, listener });
                return true;
            });
        }

        function closeAll() {
            for (const key of Array.from(sessions.keys())) closeSource(key);
        }

        // Re-open every ticked source that is currently present. Called on
        // activation and after a replug; never adds a source the user did not
        // tick, so a transient unplug can't switch the kit to another device.
        async function restore() {
            if (!active || !discovered) return;
            const present = new Set(listSources().map((s) => s.logicalSourceKey));
            for (const key of savedKeys) {
                // Re-checked per device: each openSource() awaits the network
                // and the domain, so the screen can go inactive mid-loop. Opening
                // the rest would strand sessions nothing will close.
                if (!active) return;
                if (present.has(key) && !sessions.has(key)) await openSource(key);
            }
            syncPrimarySelection();
        }

        // The domain tracks a single selected key. With several devices open we
        // pin it to the first ticked one, so the Host's selection stays on a
        // source we are actually using rather than oscillating with whichever
        // box was ticked last.
        function syncPrimarySelection() {
            const mi = midiDomain();
            if (!mi) return;
            const primary = savedKeys.find((key) => sessions.has(key)) || null;
            if (!primary) return;
            // getSelected() is an optimisation only, and it is not among the
            // verbs this plugin declares in plugin.json. A Host that doesn't
            // implement it simply has nothing to compare against — so an
            // absent or throwing getter is normal, not an error.
            let current = null;
            try { current = typeof mi.getSelected === 'function' ? mi.getSelected() : null; } catch (_) { current = null; }
            if (primary === current) return;
            try { mi.select(primary); } catch (_) { /* best-effort */ }
        }

        // ── the merged logical stream ───────────────────────────────────────

        function onHit(key, data) {
            if (!data || data.length < 3) return;
            // 0x90 is note-on on any channel; velocity 0 is a note-off under
            // running status, so only a real strike counts.
            if ((data[0] & 0xf0) !== 0x90 || data[2] <= 0) return;
            const hit = {
                // Which device this arrived on — the tag calibration needs to
                // disambiguate a kick pedal on one interface from pads on another.
                logicalSourceKey: key,
                note: data[1],
                velocity: data[2],
                channel: data[0] & 0x0f,
                at: performance.now(),
            };
            hitListeners.forEach((fn) => {
                try { fn(hit); } catch (_) { /* listener isolation */ }
            });
            // Handle wizard capture
            if (wizardState && wizardState.phase === 'capturing') {
                wizardState = {
                    ...wizardState,
                    phase: 'gotHit',
                    lastHit: hit,
                };
                emitState();
            }
            // Score the strike against the loaded chart (also feeds the
            // judgment map the note-state provider reads).
            handleHitForScoring(hit);
        }

        function confirmWizardHit() {
            if (!wizardState || !wizardState.lastHit || !wizardState.currentPiece) return;
            const mapping = {
                note: wizardState.lastHit.note,
                channel: wizardState.lastHit.channel,
                logicalSourceKey: wizardState.lastHit.logicalSourceKey,
            };
            const conflict = findConflictingMapping(wizardState.currentPiece, mapping);
            if (conflict && !wizardState.warnedAmbiguous) {
                wizardState = {
                    ...wizardState,
                    phase: 'gotHit',
                    conflict,
                    warnedAmbiguous: true,
                };
                emitState();
                return;
            }
            setKitMapping(wizardState.currentPiece, mapping);
            wizardState = {
                ...wizardState,
                phase: 'confirmed',
                captures: { ...wizardState.captures, [wizardState.currentPiece]: mapping },
                conflict: null,
            };
            emitState();
        }

        function retryWizardHit() {
            if (!wizardState) return;
            wizardState = {
                ...wizardState,
                phase: 'capturing',
                lastHit: null,
                error: null,
            };
            emitState();
        }

        function startCapturing() {
            if (!wizardState) return;
            // Check if any devices are open
            const state = getState();
            if (state.openKeys.length === 0) {
                wizardState = {
                    ...wizardState,
                    phase: 'no-devices',
                    lastHit: null,
                    error: 'No MIDI devices open',
                };
                emitState();
                return;
            }
            wizardState = {
                ...wizardState,
                phase: 'capturing',
                lastHit: null,
                error: null,
            };
            emitState();
        }

        // ── replug / unplug ──────────────────────────────────────────────────

        function onSourcesChanged() {
            const present = new Set(listSources().map((s) => s.logicalSourceKey));
            // A vanished source is gone for now: drop its listener and release
            // the session. `savedKeys` is deliberately untouched so the same
            // device is picked up again when it returns.
            for (const key of Array.from(sessions.keys())) {
                if (!present.has(key)) closeSource(key);
            }
            // Recovery for the saved devices that are back — no fallback-switch.
            Promise.resolve(restore()).catch(() => {});
            emitState();
        }

        // The bus may not exist yet when screen.js first runs (async Host boot), so
        // this stays retryable: without it, a late bus would silently kill
        // replug recovery for the whole session. Idempotent — the flag means
        // "already subscribed", not "already attempted".
        function bindSourcesChanged() {
            if (sourcesChangedBound) return;
            const bus = window.feedBack;
            if (!bus || typeof bus.on !== 'function') return;
            sourcesChangedBound = true;
            bus.on('midi-input:sources-changed', onSourcesChanged);
        }

        // ── selection + persistence ──────────────────────────────────────────

        // Every tick POSTs the whole selection, so overlapping saves would race: an
        // earlier-issued request can land after a later one and roll the file
        // back. Chaining them keeps saves ordered and last-write-wins.
        let persistQueue = Promise.resolve();

        function persist() {
            persistQueue = persistQueue.then(async () => {
                try {
                    const res = await fetch(`/api/plugins/${PLUGIN_ID}/settings`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ source_keys: savedKeys }),
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                } catch (err) {
                    // Fail soft: the selection still works for this session.
                    console.warn(`${PLUGIN_ID}: could not save the device selection`, err);
                }
            });
            return persistQueue;
        }

        async function loadSaved() {
            try {
                const res = await fetch(`/api/plugins/${PLUGIN_ID}/settings`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const settings = await res.json();
                const keys = settings && settings.source_keys;
                if (Array.isArray(keys)) {
                    savedKeys = keys
                        .filter((key) => typeof key === 'string' && key)
                        .slice(0, MAX_SOURCES)
                        // Same bound the server enforces, so an over-long key
                        // can't turn every save into a rejected POST.
                        .map((key) => key.slice(0, MAX_SOURCE_KEY_LEN));
                }
                if (settings.active_kit) activeKit = settings.active_kit;
                if (settings.kit_profiles) kitProfiles = settings.kit_profiles;
                if (settings.kit_updated_at) kitUpdatedAt = settings.kit_updated_at;
                if (settings.per_song_overrides) perSongOverrides = settings.per_song_overrides;
                // The server salvages per key, but an older file can still be
                // missing a stamp for a profile it does carry — such a
                // profile simply shows no last-updated time.
            } catch (err) {
                console.warn(`${PLUGIN_ID}: could not load the saved settings`, err);
            }
            keysLoaded = true;
            emitState();
        }

        async function saveKitProfiles() {
            try {
                const res = await fetch(`/api/plugins/${PLUGIN_ID}/kit-profiles`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        active_kit: activeKit,
                        kit_profiles: kitProfiles,
                        kit_updated_at: kitUpdatedAt,
                        per_song_overrides: perSongOverrides,
                    }),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
            } catch (err) {
                console.warn(`${PLUGIN_ID}: could not save kit profiles`, err);
            }
        }

        async function setEnabled(key, enabled) {
            if (!key) return false;
            const next = new Set(savedKeys);
            if (enabled) {
                if (next.size >= MAX_SOURCES) {
                    // Re-render so the tick the user just made is visibly
                    // rejected, instead of leaving a box checked for a device
                    // we did not open.
                    emitState();
                    return false;
                }
                next.add(key);
            } else {
                next.delete(key);
                closeSource(key);
            }
            savedKeys = Array.from(next);
            await persist();
            // Persist first: a device that is unplugged the instant after the
            // tick must still be in the saved set, or recovery has nothing to
            // reconnect to.
            //
            // openSource() re-checks `active` itself, so a user who leaves the
            // screen while this POST is in flight gets no stranded session.
            if (enabled) await openSource(key);
            syncPrimarySelection();
            emitState();
            return true;
        }

        // ── kit profile management ───────────────────────────────────────────

        function getPieceDisplayName(pieceId) {
            if (PIECES[pieceId] && PIECES[pieceId].name) return PIECES[pieceId].name;
            // Title-case fallback — matches lib/drums.py normalise_kit() so a
            // piece-id this build predates still reads like the rest.
            return pieceId.replace(/_/g, ' ').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
        }

        function normalizeProfileName(name) {
            return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 99);
        }

        function getActiveKitProfile() {
            if (!kitProfiles[activeKit]) kitProfiles[activeKit] = {};
            return kitProfiles[activeKit];
        }

        // One persistence path for every profile mutation: stamp now, save,
        // re-render. Renames move the old profile's stamp so "last updated"
        // survives a name change.
        function stampProfile(name) {
            try {
                kitUpdatedAt[name] = new Date().toISOString();
            } catch (_) { /* stamping is display-only */ }
        }

        function saveNow() {
            saveKitProfiles().catch(() => {});
            emitState();
        }

        function createKitProfile(name) {
            const nameClean = normalizeProfileName(name);
            if (!nameClean) return { ok: false, error: 'A profile name is required.' };
            if (kitProfiles[nameClean]) return { ok: false, error: `"${nameClean}" already exists.` };
            kitProfiles[nameClean] = {};
            stampProfile(nameClean);
            activeKit = nameClean;
            saveNow();
            return { ok: true, name: nameClean };
        }

        function renameKitProfile(oldName, nextName) {
            const nameClean = normalizeProfileName(nextName);
            if (!kitProfiles[oldName]) return { ok: false, error: `"${oldName}" is not a saved profile.` };
            if (!nameClean) return { ok: false, error: 'A profile name is required.' };
            if (nameClean !== oldName && kitProfiles[nameClean]) {
                return { ok: false, error: `"${nameClean}" already exists.` };
            }
            kitProfiles[nameClean] = kitProfiles[oldName];
            delete kitProfiles[oldName];
            if (kitUpdatedAt[oldName]) {
                kitUpdatedAt[nameClean] = kitUpdatedAt[oldName];
                delete kitUpdatedAt[oldName];
            }
            if (activeKit === oldName) activeKit = nameClean;
            saveNow();
            return { ok: true, name: nameClean };
        }

        function deleteKitProfile(name) {
            if (!kitProfiles[name]) return { ok: false, error: `"${name}" is not a saved profile.` };
            delete kitProfiles[name];
            delete kitUpdatedAt[name];
            // Deleting the active profile falls back to the default rather
            // than leaving the plugin pointing at nothing — getActiveKitProfile()
            // recreates an empty `default` on the next access and saveNow()
            // persists that shape.
            if (activeKit === name) activeKit = 'default';
            saveNow();
            return { ok: true };
        }

        function setActiveKit(kit) {
            const name = normalizeProfileName(kit) || 'default';
            if (!kitProfiles[name]) return { ok: false, error: `"${name}" is not a saved profile.` };
            if (activeKit === name) return { ok: true, name };
            activeKit = name;
            scoreResetForProfileChange();
            saveNow();
            return { ok: true, name };
        }

        function getActiveKitName() {
            return activeKit;
        }

        function getPieces() {
            return Object.assign({}, PIECES);
        }

        function setKitMapping(pieceId, mapping) {
            const profile = getActiveKitProfile();
            profile[pieceId] = mapping;
            stampProfile(activeKit);
            saveNow();
        }

        function findConflictingMapping(pieceId, mapping) {
            const profile = getActiveKitProfile();
            for (const pid of Object.keys(profile)) {
                if (pid === pieceId) continue;
                const m = profile[pid];
                if (m && m.logicalSourceKey === mapping.logicalSourceKey && m.note === mapping.note && m.channel === mapping.channel) {
                    return pid;
                }
            }
            return null;
        }

        function clearKitMapping(pieceId) {
            const profile = getActiveKitProfile();
            if (profile[pieceId]) {
                delete profile[pieceId];
                stampProfile(activeKit);
                saveNow();
            }
        }

        // The song key the chart stream arrived under; per-song override
        // lookups qualify through it.
        function songKeyForChart() {
            return chartSongKey;
        }

        function resolveKitPiecesFromDrumTab(drumTab) {
            const pieces = new Set();
            if (drumTab && Array.isArray(drumTab.kit)) {
                for (const item of drumTab.kit) {
                    if (item && typeof item.piece === 'string') pieces.add(item.piece);
                    else if (item && typeof item.id === 'string') pieces.add(item.id);
                }
            }
            return Array.from(pieces);
        }

        function startWizard() {
            const profile = getActiveKitProfile();
            const requiredPieces = resolveKitPiecesFromDrumTab(currentDrumTab);
            const pendingPieces = requiredPieces.filter((p) => !profile[p]);
            wizardState = {
                phase: 'intro',
                currentPiece: pendingPieces[0] || null,
                pendingPieces: pendingPieces.slice(),
                remainingPieces: pendingPieces.slice(),
                captures: {},
                capturing: false,
                error: null,
                warnedAmbiguous: false,
            };
            emitState();
        }

        function resetWizard() {
            wizardState = null;
            emitState();
        }

        function advanceWizard() {
            if (!wizardState) return;
            const remaining = wizardState.remainingPieces.slice(1);
            if (remaining.length === 0) {
                wizardState = {
                    phase: 'complete',
                    currentPiece: null,
                    pendingPieces: [],
                    remainingPieces: [],
                    captures: wizardState.captures,
                    capturing: false,
                    error: null,
                };
            } else {
                wizardState = {
                    ...wizardState,
                    phase: 'awaiting',
                    currentPiece: remaining[0],
                    remainingPieces: remaining,
                    capturing: false,
                    error: null,
                };
            }
            emitState();
        }

        // ── live scoring ──────────────────────────────────────────────────
        // Mirrors drum_highway_3d's hit detection so the two plugins share
        // one timing feel: ±50 ms window, EARLY/OK/LATE split at 40% of that
        // window, misses swept per frame with a connect-time floor.
        const HIT_TOLERANCE_S = 0.05;
        const HIT_OK_FRACTION = 0.4;
        const HIT_GLOW_S = 0.45;    // struck-gem glow decay (provider alpha)
        const MISS_WASH_S = 1.2;    // missed-gem red wash decay
        const MAX_UNMAPPED_SAMPLE = 20;
        const MAX_CHART_HITS = 20000;

        // Trigger -> piece resolution: song overrides first, then the active
        // profile. An unmapped trigger is reported (count + bounded sample)
        // instead of silently dropped, so the wizard knows what to ask for.
        const unmappedSample = [];
        let unmappedCount = 0;

        function findPieceForHit(hit) {
            const matchIn = (profile) => {
                if (!profile) return null;
                for (const pieceId of Object.keys(profile)) {
                    const m = profile[pieceId];
                    if (m &&
                        m.logicalSourceKey === hit.logicalSourceKey &&
                        m.note === hit.note &&
                        m.channel === hit.channel) {
                        return pieceId;
                    }
                }
                return null;
            };
            const overrides = perSongOverrides[songKeyForChart()];
            return matchIn(overrides) || matchIn(getActiveKitProfile());
        }

        function recordUnmappedHit(hit) {
            unmappedCount += 1;
            if (unmappedSample.length < MAX_UNMAPPED_SAMPLE) {
                unmappedSample.push({
                    note: hit.note,
                    channel: hit.channel,
                    at: new Date().toISOString(),
                });
            }
        }

        // Chart pieces the active kit profile does not cover — the "needs
        // mapping" surface the wizard prompts for.
        function chartUnmappedPieces() {
            if (!currentDrumTab || !Array.isArray(currentDrumTab.kit)) return [];
            const profile = getActiveKitProfile();
            const overrides = perSongOverrides[songKeyForChart()] || {};
            return currentDrumTab.kit
                .map((entry) => entry && (entry.id || entry.piece))
                .filter((pieceId, idx, arr) => typeof pieceId === 'string' && arr.indexOf(pieceId) === idx)
                .filter((pieceId) => !(profile[pieceId] || overrides[pieceId]));
        }

        function unmappedSummary() {
            return {
                count: unmappedCount,
                sample: unmappedSample.slice(),
                missingPieces: chartUnmappedPieces(),
            };
        }

        function classifyTiming(delta, tol) {
            if (!Number.isFinite(delta) || !Number.isFinite(tol)) return 'OK';
            if (Math.abs(delta) <= tol * HIT_OK_FRACTION) return 'OK';
            return delta > 0 ? 'EARLY' : 'LATE';
        }

        function chartHitKey(t, pieceId) {
            const tNum = Number(t);
            return `${Number.isFinite(tNum) ? tNum.toFixed(3) : String(t)}|${pieceId}`;
        }

        // Nearest un-scored chart hit for this piece within the window. The
        // hits array is sorted by t, so the walk can stop once notes are
        // beyond the late edge of the window.
        function findMatchingChartHit(pieceId, now) {
            for (const hit of currentDrumHits) {
                if (hit.t > now + HIT_TOLERANCE_S) break;
                if (hit.t < now - HIT_TOLERANCE_S) continue;
                if (hit.p !== pieceId) continue;
                if (scoredJudgments.has(chartHitKey(hit.t, hit.p))) continue;
                return hit;
            }
            return null;
        }

        function handleHitForScoring(hit) {
            const pieceId = findPieceForHit(hit);
            if (!pieceId) {
                recordUnmappedHit(hit);
                emitState();
                return;
            }
            const now = playbackTime();
            if (now === null) {
                // Free-play (no playback clock): a strike is still practice,
                // but without a timeline there is nothing to score against.
                scoreState.extras += 1;
                emitState();
                return;
            }
            const matched = findMatchingChartHit(pieceId, now);
            if (matched) {
                scoredJudgments.set(chartHitKey(matched.t, matched.p), {
                    state: 'hit',
                    at: performance.now(),
                    ts: classifyTiming(matched.t - now, HIT_TOLERANCE_S),
                });
                scoreState.hits += 1;
                scoreState.streak += 1;
                if (scoreState.streak > scoreState.bestStreak) scoreState.bestStreak = scoreState.streak;
            } else {
                // A resolved piece with no chart note nearby: an extra or
                // unexpected hit. Fills and ghost taps that aren't in an
                // (often simplified) chart are practice, not failure — they
                // cost no penalty in v1 and are not counted as hits either.
                scoreState.extras += 1;
            }
            scoreState.total = scoreState.hits + scoreState.misses;
            if (scoreState.total > 0) {
                scoreState.accuracy = Math.round((scoreState.hits / scoreState.total) * 100);
            }
            emitState();
        }

        // One frame of miss accounting over the sorted chart: unhit notes
        // between the sweep floor and the tolerance edge become misses (the
        // per-frame cadence keeps the 2 s look-back window always populated,
        // same scheme as drum_highway_3d's _updateMissed).
        function sweepMisses(now) {
            if (!currentDrumHits.length) return;
            const cutoff = now - HIT_TOLERANCE_S - 0.02;
            let changed = false;
            for (const hit of currentDrumHits) {
                if (hit.t > cutoff) break;
                if (hit.t < cutoff - 2) continue;   // older than 2 s — already counted
                if (hit.t <= missFloor) continue;   // elapsed with no device able to record it
                const key = chartHitKey(hit.t, hit.p);
                if (scoredJudgments.has(key)) continue;
                scoredJudgments.set(key, { state: 'miss', at: performance.now() });
                scoreState.misses += 1;
                scoreState.streak = 0;
                changed = true;
            }
            if (changed) {
                scoreState.total = scoreState.hits + scoreState.misses;
                if (scoreState.total > 0) {
                    scoreState.accuracy = Math.round((scoreState.hits / scoreState.total) * 100);
                }
                emitState();
            }
        }

        function playbackTime() {
            const hw = window.highway;
            try {
                if (hw && typeof hw.getTime === 'function') {
                    const t = hw.getTime();
                    return Number.isFinite(t) ? t : null;
                }
            } catch (_) { /* no clock — scoring stays inert rather than throwing */ }
            return null;
        }

        // Drives the miss sweep off the highway's playback clock. Runs only
        // while this screen is active AND a device session is open — with no
        // device the user cannot hit anything, so counting passed notes as
        // misses would corrupt the accuracy readout.
        function startMissSweep() {
            if (sweepTimer !== null) return;
            const tick = () => {
                sweepTimer = null;
                if (!active) return;
                const openCount = sessions.size;
                const now = playbackTime();
                if (openCount === 0) {
                    hadOpenSession = false;
                    // Nothing can score with no device — release the highway
                    // slot so another scorer (notedetect) can claim it.
                    clearNoteStateProvider();
                } else {
                    if (!hadOpenSession) {
                        // First session on this chart: nothing is banked for
                        // notes that passed before input could reach us, and
                        // the provider slot arms only now that scoring can
                        // actually run.
                        hadOpenSession = true;
                        if (now !== null) missFloor = Math.max(missFloor, now);
                        registerWithHighway();
                    }
                    if (now !== null) {
                        // Seek-back re-arms the skipped region so replayed
                        // notes count again.
                        if (now < missFloor) missFloor = now;
                        sweepMisses(now);
                        lastPlaybackTime = now;
                    }
                }
                if (sweepTimer === null) sweepTimer = requestAnimationFrame(tick);
            };
            sweepTimer = requestAnimationFrame(tick);
        }

        function stopMissSweep() {
            if (sweepTimer !== null) {
                cancelAnimationFrame(sweepTimer);
                sweepTimer = null;
            }
        }

        function resetScoreInternal() {
            scoredJudgments.clear();
            scoreState = {
                hits: 0,
                misses: 0,
                total: 0,
                accuracy: 0,
                streak: 0,
                bestStreak: 0,
                extras: 0,
            };
            missFloor = -Infinity;
            lastPlaybackTime = null;
            unmappedCount = 0;
            unmappedSample.length = 0;
            hadOpenSession = false;
        }

        function resetScore() {
            resetScoreInternal();
            emitState();
        }

        // Profile switch mid-song: prior judgments resolve against the old
        // mapping, so they reset — without a song reload (issue #7).
        function scoreResetForProfileChange() {
            resetScoreInternal();
            emitState();
        }

        // ── note-state provider (renderer-agnostic feedback) ─────────────────
        // Contract (core CLAUDE.md, feedBack#254): highway.setNoteStateProvider
        // takes a FUNCTION (note, chartTime) => falsy | 'hit' | 'active' |
        // 'miss' | { state, alpha?, color? } — last call wins, cleared with
        // setNoteStateProvider(null). Drum hits aren't chorded, so chartTime
        // === note.t. The provider owns all fade timing: it returns a decaying
        // alpha for a struck/missed gem and falsy once the effect ends.
        function _noteStateFn(note, chartTime) {
            if (!note || !scoredJudgments.size) return null;
            const t = Number.isFinite(Number(chartTime)) ? chartTime : note.t;
            const judgment = scoredJudgments.get(chartHitKey(t, note.p));
            if (!judgment) return null;
            const decayS = judgment.state === 'hit' ? HIT_GLOW_S : MISS_WASH_S;
            const alpha = Math.max(0, 1 - (performance.now() - judgment.at) / (decayS * 1000));
            if (alpha <= 0) return null;   // glow over — release the gem
            return { state: judgment.state, alpha };
        }

        function registerWithHighway() {
            if (providerInstalled) return true;
            const hw = window.highway;
            if (!hw || typeof hw.setNoteStateProvider !== 'function') return false;
            try {
                const current = typeof hw.getNoteStateProvider === 'function' ? hw.getNoteStateProvider() : null;
                if (current === _noteStateFn) {
                    providerInstalled = true;
                    return true;
                }
                hw.setNoteStateProvider(_noteStateFn);
                providerInstalled = true;
                return true;
            } catch (err) {
                console.warn(`${PLUGIN_ID}: could not register with highway`, err);
                return false;
            }
        }

        function clearNoteStateProvider() {
            if (!providerInstalled) return;
            const hw = window.highway;
            try {
                if (hw && typeof hw.setNoteStateProvider === 'function') hw.setNoteStateProvider(null);
            } catch (_) { /* best-effort */ }
            providerInstalled = false;
        }

        function skipCurrentPiece() {
            if (!wizardState || !wizardState.currentPiece) return;
            advanceWizard();
        }

        function remapPiece(pieceId) {
            if (!pieceId) return;
            const profile = getActiveKitProfile();
            const isMapped = !!profile[pieceId];
            wizardState = {
                phase: 'awaiting',
                currentPiece: pieceId,
                pendingPieces: [pieceId],
                remainingPieces: [pieceId],
                captures: {},
                capturing: false,
                error: null,
                isRemap: true,
                wasMapped: isMapped,
            };
            emitState();
        }

        // ── drum chart consumption (own WS) ─────────────────────────────────
        // Ground truth (static/highway.js): the highway buffers drum_tab/
        // drum_hits into its renderer bundle only — neither is re-emitted as a
        // window.feedBack bus event and there is no getDrumTab() getter — so a
        // non-renderer plugin holds its own listener on the same WS endpoint.
        // The server's extraction caches make the second connection cheap.
        // Legacy packs (drums encoded as guitar notes) stream a notes stream
        // and no drum_tab: per issue #6 v1 treats those as "no drum chart"
        // rather than shipping its own legacy decoder.
        function chartFilename() {
            const song = window.feedBack && window.feedBack.currentSong;
            const fn = song && song.filename;
            return (typeof fn === 'string' && fn) ? fn : null;
        }

        function disconnectChartWs() {
            chartWsGen += 1;
            const ws = chartWs;
            chartWs = null;
            if (ws) {
                try { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close(); } catch (_) { /* best-effort */ }
            }
            chartStatus = 'idle';
            chartReason = '';
        }

        function connectChartWs() {
            if (!active) return;
            const filename = chartFilename();
            if (!filename) { chartStatus = currentDrumTab ? chartStatus : 'idle'; return; }
            const gen = ++chartWsGen;
            const prev = chartWs;
            chartWs = null;
            if (prev) {
                try { prev.onclose = null; prev.onerror = null; prev.onmessage = null; prev.close(); } catch (_) { /* best-effort */ }
            }
            if (chartSongKey !== filename) {
                // A different song invalidates the chart knowledge wholesale.
                currentDrumTab = null;
                currentDrumHits = [];
                drumParts = [];
                activePartId = null;
                resetScoreInternal();
            }
            chartSongKey = filename;
            chartStatus = 'connecting';
            emitState();

            let next;
            try {
                const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
                let url = `${proto}//${location.host}/ws/highway/${encodeURIComponent(filename)}`;
                if (activePartId) url += `?drum_part=${encodeURIComponent(activePartId)}`;
                next = new WebSocket(url);
            } catch (err) {
                chartStatus = 'failed';
                chartReason = String((err && err.message) || err);
                emitState();
                return;
            }
            chartWs = next;
            next.onmessage = (ev) => {
                if (chartWsGen !== gen) return;   // superseded mid-flight
                onChartMessage(ev);
            };
            next.onclose = () => {
                if (chartWsGen !== gen) return;
                chartWs = null;
                // Keep the last chart so mappings/wizard stay meaningful; the
                // next song:loaded (or re-activation) reconnects.
                chartStatus = 'closed';
                emitState();
            };
            next.onerror = () => {
                if (chartWsGen !== gen) return;
                chartStatus = 'failed';
                chartReason = 'could not reach the highway socket';
                emitState();
            };
        }

        function onChartMessage(ev) {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (_) { /* keep-alives only */ return; }
            if (!msg || typeof msg !== 'object' || !msg.type) return;
            switch (msg.type) {
                case 'song_info':
                    drumParts = Array.isArray(msg.drum_parts)
                        ? msg.drum_parts.filter((p) => p && typeof p.id === 'string').map((p) => ({ id: p.id, name: p.name || p.id }))
                        : [];
                    if (!msg.has_drum_tab) {
                        currentDrumTab = null;
                        currentDrumHits = [];
                        resetScoreInternal();
                        chartStatus = 'no-chart';
                    }
                    break;
                case 'drum_tab': {
                    currentDrumTab = {
                        version: Number.isInteger(msg.version) ? msg.version : 1,
                        name: (typeof msg.name === 'string' && msg.name) ? msg.name : 'Drums',
                        kit: Array.isArray(msg.kit) ? msg.kit : [],
                        part_id: (typeof msg.part_id === 'string' && msg.part_id) ? msg.part_id : null,
                    };
                    if (currentDrumTab.part_id) activePartId = currentDrumTab.part_id;
                    // Reset per drum_tab (hits stream after): defends against
                    // an arrangement-change replay reusing stale hits.
                    // Mirror the authoritative streaming part (the server
                    // resolves an unknown/absent ?drum_part= to the primary),
                    // so the picker stays honest after a fallback.
                    currentDrumHits = [];
                    resetScoreInternal();
                    chartStatus = 'loading';
                    break;
                }
                case 'drum_hits': {
                    if (!Array.isArray(msg.data)) break;
                    for (const hit of msg.data) {
                        if (currentDrumHits.length >= MAX_CHART_HITS) break;
                        if (!hit || typeof hit.p !== 'string' || !hit.p) continue;
                        const t = Number(hit.t);
                        if (!Number.isFinite(t)) continue;
                        const clean = { t, p: hit.p };
                        if (Number.isFinite(Number(hit.v))) clean.v = Number(hit.v);
                        if (hit.g) clean.g = true;
                        if (hit.f) clean.f = true;
                        if (Number.isFinite(Number(hit.k))) clean.k = Number(hit.k);
                        currentDrumHits.push(clean);
                    }
                    currentDrumHits.sort((a, b) => a.t - b.t);
                    break;
                }
                case 'ready':
                    // Wire order is drum_tab → drum_hits chunks → … → ready, so
                    // `ready` completes the chart.
                    if (currentDrumTab) chartStatus = 'ready';
                    break;
                default:
                    break;
            }
            emitState();
        }

        // `song:loaded` carries window.feedBack.currentSong (including
        // `filename`): the trigger for chart consumption on every song switch.
        function onSongLoaded(ev) {
            const song = (ev && ev.detail) || (window.feedBack && window.feedBack.currentSong) || null;
            const fn = song && typeof song.filename === 'string' ? song.filename : null;
            if (fn && active) connectChartWs();
            emitState();
        }

        // The bus may not exist yet when screen.js first runs, so this stays
        // retryable like the layer's own sources-changed binding.
        function bindChartBus() {
            if (chartBusBound) return;
            const bus = window.feedBack;
            if (!bus || typeof bus.on !== 'function') return;
            chartBusBound = true;
            bus.on('song:loaded', onSongLoaded);
        }

        function unbindChartBus() {
            const bus = window.feedBack;
            if (chartBusBound && bus && typeof bus.off === 'function') {
                try { bus.off('song:loaded', onSongLoaded); } catch (_) { /* best-effort */ }
            }
            chartBusBound = false;
        }

        // ── screen lifecycle ─────────────────────────────────────────────────

        function setActive(next) {
            // Bus binding is retried on every call, including a no-op
            // transition: the Host can install `window.feedBack` after this
            // script runs, while the layer is already active. Both hooks are
            // flag-guarded, so repeating them costs nothing.
            bindSourcesChanged();
            bindChartBus();
            // Views use this to re-subscribe their own bus handlers, which face
            // the same late-bus problem.
            activateListeners.forEach((fn) => {
                try { fn(); } catch (_) { /* one bad listener must not block activation */ }
            });
            if (active === !!next) return;
            active = !!next;
            if (!active) {
                // Exit path: release every session rather than leaving a device
                // held open behind a screen nobody is looking at. `savedKeys`
                // survives, so re-entering restores the same devices. Scoring
                // teardown mirrors it: the sweep stops, the note-state provider
                // releases its "last call wins" slot, and the chart WS closes.
                closeAll();
                stopMissSweep();
                clearNoteStateProvider();
                disconnectChartWs();
                emitState();
                return;
            }
            // The bus may only have appeared since the last activation.
            if (!keysLoaded) {
                // Serialise: the persisted selection decides what to re-open,
                // so it has to land before discovery triggers `restore()`.
                loadSaved().then(() => activate()).catch(() => {});
            } else {
                activate().catch(() => {});
            }
        }

        async function activate() {
            // A fresh discovery already restores, so restoring again here would
            // only repeat that work. Once discovery is latched, though,
            // discover() short-circuits and this is the only thing that re-opens
            // devices: returning to the screen (or re-binding after a
            // re-hydration) closed them on the way out.
            const alreadyDiscovered = discovered;
            await discover();
            if (alreadyDiscovered) await restore();
            if (sessions.size > 0) registerWithHighway();
            startMissSweep();
            connectChartWs();
        }

        // Terminal teardown, used when screen.js is re-executed so the previous
        // layer cannot leave a second set of listeners or a live session behind.
        // Callers must re-bind a view afterwards, which is why this clears the
        // subscriber sets rather than leaving a half-dead view subscribed to
        // state it can no longer render.
        function dispose() {
            setActive(false);
            unbindChartBus();
            const bus = window.feedBack;
            if (sourcesChangedBound && bus && typeof bus.off === 'function') {
                try { bus.off('midi-input:sources-changed', onSourcesChanged); } catch (_) { /* best-effort */ }
            }
            sourcesChangedBound = false;
            hitListeners.clear();
            stateListeners.clear();
            activateListeners.clear();
        }

        return {
            version: 1,
            getState,
            subscribe(fn) {
                if (typeof fn === 'function') stateListeners.add(fn);
                return () => stateListeners.delete(fn);
            },
            discover,
            setEnabled,
            setActive,
            dispose,
            // The merged stream every later stage (calibration, scoring) reads.
            onHit(fn) {
                if (typeof fn === 'function') hitListeners.add(fn);
                return () => hitListeners.delete(fn);
            },
            // Internal: lets a view re-subscribe its bus handlers on each
            // activation, for a Host that installs `window.feedBack` late.
            addActivateListener(fn) {
                if (typeof fn === 'function') activateListeners.add(fn);
                return () => activateListeners.delete(fn);
            },
            // Drum tab / wizard API. The chart flows in over the layer's own
            // WS once a song loads; these setters remain for hosts/tests that
            // push data directly.
            setCurrentDrumTab(drumTab) {
                currentDrumTab = drumTab;
                resetScoreInternal();
                emitState();
            },
            setCurrentDrumHits(hits) {
                currentDrumHits = Array.isArray(hits) ? hits.slice() : [];
                resetScoreInternal();
                emitState();
            },
            setCurrentDrumPart(partId) {
                activePartId = (typeof partId === 'string' && partId) ? partId : null;
                // Reconnect so the server streams the picked part's tab.
                connectChartWs();
                emitState();
            },
            getDrumParts() {
                return drumParts.slice();
            },
            getActivePartId() {
                return activePartId;
            },
            getChartStatus() {
                return { status: chartStatus, reason: chartReason };
            },
            clearNoteStateProvider,
            registerWithHighway,
            resetScore,
            getScoreState() {
                return { ...scoreState };
            },
            getUnmappedSummary() {
                return unmappedSummary();
            },
            startWizard,
            resetWizard,
            advanceWizard,
            skipCurrentPiece,
            remapPiece,
            startCapturing,
            confirmWizardHit,
            retryWizardHit,
            clearKitMapping,
            createKitProfile,
            renameKitProfile,
            deleteKitProfile,
            setActiveKit,
            getActiveKitName,
            getPieces,
            getPieceDisplayName,
        };
    }

    // ── screen view ────────────────────────────────────────────────────────

    function plural(count, word) {
        return `${count} ${word}${count === 1 ? '' : 's'}`;
    }

    function statusText(state) {
        if (!state.available) {
            return 'MIDI input is unavailable here — this build has no midi-input capability domain.';
        }
        if (!state.discovered) {
            const outcome = state.outcome;
            const reason = outcome && outcome.reason ? ` (${outcome.reason})` : '';
            if (outcome && outcome.outcome === 'denied') {
                return `MIDI access was denied${reason}. Allow it in your browser, then rescan.`;
            }
            if (outcome) {
                return `No MIDI provider could be reached${reason}. Rescan to try again.`;
            }
            return 'Looking for MIDI devices…';
        }
        const connected = state.sources.length
            ? `${plural(state.sources.length, 'device')} found`
            : 'No devices connected';
        return `${connected} · ${state.openKeys.length} open.`;
    }

    function savedHint(state) {
        if (!state.savedKeys.length) return '';
        const present = new Set(state.sources.map((s) => s.logicalSourceKey));
        const missing = state.savedKeys.filter((key) => !present.has(key)).length;
        const atCap = state.savedKeys.length >= MAX_SOURCES
            ? ` Up to ${MAX_SOURCES} can be open at once.`
            : '';
        if (!missing) {
            return `${plural(state.savedKeys.length, 'device')} saved.${atCap}`;
        }
        return `${plural(missing, 'saved device')} not connected — ${missing === 1 ? 'it' : 'they'} will reopen automatically when ${missing === 1 ? 'it' : 'they'} return.${atCap}`;
    }

    // Builds one row per present source. Rows are rebuilt only when the device
    // list changes (scan, tick, replug) — never on the MIDI event path, which
    // must stay free of DOM queries (spec §6.4).
    function renderDevices(listEl, state, onToggle) {
        listEl.textContent = '';
        if (!state.sources.length) return;

        for (const source of state.sources) {
            const key = source.logicalSourceKey;
            const ticked = state.savedKeys.indexOf(key) !== -1;
            const row = document.createElement('li');
            row.className = 'midi-drums__device';

            const label = document.createElement('label');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = ticked;
            box.className = 'midi-drums__device-box';
            box.addEventListener('change', () => { onToggle(key, box.checked); });
            const name = document.createElement('span');
            name.className = 'midi-drums__device-label';
            // textContent, not innerHTML: a device label is user-controlled
            // hardware text and must never be parsed as markup.
            name.textContent = source.label || 'MIDI input';
            label.appendChild(box);
            label.appendChild(name);
            row.appendChild(label);

            const meta = document.createElement('span');
            meta.className = 'midi-drums__device-meta';
            meta.textContent = state.openKeys.indexOf(key) !== -1
                ? (source.availability || 'available')
                : `${source.availability || 'available'} · closed`;
            row.appendChild(meta);

            listEl.appendChild(row);
        }
    }

    function bindView(layer) {
        const root = document.getElementById(SCREEN_ID);
        if (!root) {
            console.warn(`${PLUGIN_ID}: screen root #${SCREEN_ID} not found`);
            return null;
        }

        // Resolve every node once, at bind time (spec §6.4).
        const statusEl = root.querySelector('[data-role="status"]');
        const devicesEl = root.querySelector('[data-role="devices"]');
        const devicesEmptyEl = root.querySelector('[data-role="empty"]');
        const savedEl = root.querySelector('[data-role="saved"]');
        const rescanBtn = root.querySelector('[data-role="rescan"]');
        const hitsEl = root.querySelector('[data-role="hits"]');
        const hitsEmptyEl = root.querySelector('[data-role="hit-empty"]');
        const hitCountEl = root.querySelector('[data-role="hit-count"]');
        const scoreHitsEl = root.querySelector('[data-role="score-hits"]');
        const scoreAccuracyEl = root.querySelector('[data-role="score-accuracy"]');
        const scoreStreakEl = root.querySelector('[data-role="score-streak"]');
        const scoreExtrasEl = root.querySelector('[data-role="score-extras"]');
        const unmappedEl = root.querySelector('[data-role="score-unmapped"]');

        // Chart consumption elements
        const chartStatusEl = root.querySelector('[data-role="chart-status"]');
        const drumPartSel = root.querySelector('[data-role="drum-part"]');

        // Kit profile elements
        const profileSel = root.querySelector('[data-role="profile-select"]');
        const profileNameEl = root.querySelector('[data-role="profile-name"]');
        const profileCreateBtn = root.querySelector('[data-role="profile-create"]');

        // Wizard elements
        const wizardStartBtn = root.querySelector('[data-role="wizard-start"]');
        const wizardResetBtn = root.querySelector('[data-role="wizard-reset"]');
        const wizardEl = root.querySelector('[data-role="wizard"]');
        const drumtabHintEl = root.querySelector('[data-role="drumtab-hint"]');

        const wizardIntroEl = root.querySelector('[data-role="wizard-intro"]');
        const wizardAwaitingEl = root.querySelector('[data-role="wizard-awaiting"]');
        const wizardCapturingEl = root.querySelector('[data-role="wizard-capturing"]');
        const wizardGotHitEl = root.querySelector('[data-role="wizard-got-hit"]');
        const wizardConfirmedEl = root.querySelector('[data-role="wizard-confirmed"]');
        const wizardCompleteEl = root.querySelector('[data-role="wizard-complete"]');
        const wizardNoDevicesEl = root.querySelector('[data-role="wizard-no-devices"]');

        const wizardPieceEl = root.querySelector('[data-role="wizard-piece"]');
        const wizardRemainingEl = root.querySelector('[data-role="wizard-remaining"]');
        const wizardHitInfoEl = root.querySelector('[data-role="wizard-hit-info"]');

        const wizardBeginBtn = root.querySelector('[data-role="wizard-begin"]');
        const wizardSkipBtn = root.querySelector('[data-role="wizard-skip"]');
        const wizardConfirmBtn = root.querySelector('[data-role="wizard-confirm"]');
        const wizardRetryBtn = root.querySelector('[data-role="wizard-retry"]');
        const wizardNextBtn = root.querySelector('[data-role="wizard-next"]');
        const wizardDoneBtn = root.querySelector('[data-role="wizard-done"]');

        const mappingListEl = root.querySelector('[data-role="mapping-list"]');
        const mappingEmptyEl = root.querySelector('[data-role="mapping-empty"]');

        // The hit log is a capped FIFO: one row per hit, newest first, oldest
        // dropped. Rows are built on the hit path (a drum roll is a handful of
        // events per second, not a per-frame render), but the element count
        // never exceeds MAX_HIT_ROWS.
        let hitTotal = 0;

        // logicalSourceKey → label, for the hit log. Rebuilt with the devices.
        const labels = new Map();

        const onState = (state) => {
            labels.clear();
            for (const source of state.sources) labels.set(source.logicalSourceKey, source.label || 'MIDI input');
            if (statusEl) statusEl.textContent = statusText(state);
            renderDevices(devicesEl, state, (key, enabled) => {
                layer.setEnabled(key, enabled).catch(() => {});
            });
            if (devicesEmptyEl) devicesEmptyEl.hidden = !state.discovered || state.sources.length > 0;
            // Nothing to rescan without the domain; the status line explains why.
            if (rescanBtn) rescanBtn.disabled = !state.available;
            if (savedEl) {
                const hint = savedHint(state);
                savedEl.textContent = hint;
                savedEl.hidden = !hint;
            }

            // Score display. A fresh chart has nothing to be accurate ABOUT,
            // so the spot shows an em-dash rather than a lie of "100%".
            if (scoreHitsEl) {
                scoreHitsEl.textContent = `${state.scoreState.hits}/${state.scoreState.total}`;
            }
            if (scoreAccuracyEl) {
                scoreAccuracyEl.textContent = state.scoreState.total > 0 ? `${state.scoreState.accuracy}%` : '—';
            }
            if (scoreStreakEl) scoreStreakEl.textContent = String(state.scoreState.streak || 0);
            if (scoreExtrasEl) scoreExtrasEl.textContent = String(state.scoreState.extras || 0);
            if (unmappedEl) {
                const parts = [];
                if (state.unmapped.count > 0) {
                    parts.push(`${state.unmapped.count} strike${state.unmapped.count === 1 ? '' : 's'} matched no mapped piece`);
                }
                if (state.unmapped.missingPieces.length > 0) {
                    const names = state.unmapped.missingPieces.slice(0, 6).join(', ');
                    parts.push(`chart pieces not yet mapped: ${names}${state.unmapped.missingPieces.length > 6 ? '…' : ''}`);
                }
                unmappedEl.textContent = parts.join(' — ');
                unmappedEl.hidden = parts.length === 0;
            }

            // Chart status + part picker
            if (chartStatusEl) {
                const text = chartStatusText(state);
                chartStatusEl.textContent = text;
                chartStatusEl.hidden = !text;
            }
            if (drumPartSel) {
                syncDrumPartPicker(drumPartSel, state);
            }

            // Active-kit picker: only rebuilt when the profile set actually
            // changed, so the open dropdown isn't churned on every hit.
            if (profileSel) {
                const names = Object.keys(state.kitProfiles).sort((a, b) => a.localeCompare(b));
                const sig = names.join('\u0000') + '|' + names.length;
                if (profileSel.dataset.sig !== sig) {
                    profileSel.textContent = '';
                    for (const name of names) {
                        const opt = document.createElement('option');
                        opt.value = name;
                        opt.textContent = name;
                        profileSel.appendChild(opt);
                    }
                    profileSel.dataset.sig = sig;
                }
                profileSel.value = state.activeKit;
            }

            // Wizard UI updates
            renderWizard(state);
            renderMappings(state);
        };

        const chartStatusText = (state) => {
            if (!state.active) return '';
            switch (state.chartStatus) {
                case 'connecting': return 'Contacting the chart socket…';
                case 'loading':
                    return state.currentDrumTab ? `Loading “${state.currentDrumTab.name}”…` : 'Loading drum chart…';
                case 'ready': {
                    const tab = state.currentDrumTab;
                    if (!tab) return '';
                    const hits = state.currentDrumHits.length;
                    const part = tab.part_id ? ` · part ${tab.part_id}` : '';
                    return `Chart “${tab.name}” — ${hits} hit${hits === 1 ? '' : 's'}${part}`;
                }
                case 'no-chart': return 'This song streams no drum chart — scoring is off for it.';
                case 'closed': return 'The chart socket closed; it reopens on the next song change.';
                case 'failed': return `The chart socket failed${state.chartReason ? `: ${state.chartReason}` : ''}.`;
                default: return '';
            }
        };

        // The picker is hidden unless the pack actually streams more than one
        // part; the selected value mirrors what the layer will request, with
        // the pack's first part standing in for "primary".
        const syncDrumPartPicker = (sel, state) => {
            const parts = state.drumParts || [];
            const sig = parts.map((p) => p.id).join('\u0000') + '|' + String(state.activePartId || '');
            if (sel.dataset.sig !== sig) {
                sel.textContent = '';
                for (const part of parts) {
                    const opt = document.createElement('option');
                    opt.value = part.id;
                    opt.textContent = part.name;
                    sel.appendChild(opt);
                }
                sel.dataset.sig = sig;
            }
            sel.value = state.activePartId || (parts[0] ? parts[0].id : '');
            sel.hidden = parts.length <= 1;
        };

        const onHit = (hit) => {
            if (!hitsEl) return;
            const label = labels.get(hit.logicalSourceKey) || hit.logicalSourceKey;
            const row = document.createElement('li');
            row.className = 'midi-drums__hit';
            // textContent, not innerHTML: the label is hardware-supplied text.
            row.textContent = `${label} — note ${hit.note}, velocity ${hit.velocity}, channel ${hit.channel + 1}`;
            hitsEl.prepend(row);
            while (hitsEl.childElementCount > MAX_HIT_ROWS) hitsEl.lastElementChild.remove();
            hitTotal += 1;
            if (hitCountEl) hitCountEl.textContent = String(hitTotal);
            if (hitsEmptyEl) hitsEmptyEl.hidden = true;
        };

        // A rescan is also the retry for a denied prompt, so it re-runs
        // discovery even after a successful one — and restore() follows, which
        // picks up a saved device that has since been plugged back in.
        function renderMappings(state) {
            if (!mappingListEl || !mappingEmptyEl) return;
            mappingListEl.textContent = '';
            const profile = state.kitProfiles && state.kitProfiles[state.activeKit];
            const mappings = profile ? Object.keys(profile) : [];
            if (mappings.length === 0) {
                mappingEmptyEl.hidden = false;
                return;
            }
            mappingEmptyEl.hidden = true;
            for (const pieceId of mappings.sort()) {
                const m = profile[pieceId];
                const li = document.createElement('li');
                li.className = 'midi-drums__mapping';
                const info = document.createElement('div');
                info.className = 'midi-drums__mapping-info';
                const pieceEl = document.createElement('div');
                pieceEl.className = 'midi-drums__mapping-piece';
                pieceEl.textContent = layer.getPieceDisplayName(pieceId);
                const triggerEl = document.createElement('div');
                triggerEl.className = 'midi-drums__mapping-trigger';
                const devLabel = labels.get(m.logicalSourceKey) || m.logicalSourceKey;
                triggerEl.textContent = `${devLabel} — note ${m.note}, ch ${m.channel + 1}`;
                info.appendChild(pieceEl);
                info.appendChild(triggerEl);
                const actions = document.createElement('div');
                actions.className = 'midi-drums__mapping-actions';
                const remapBtn = document.createElement('button');
                remapBtn.type = 'button';
                remapBtn.className = 'midi-drums__button';
                remapBtn.textContent = 'Remap';
                remapBtn.addEventListener('click', () => layer.remapPiece(pieceId));
                const clearBtn = document.createElement('button');
                clearBtn.type = 'button';
                clearBtn.className = 'midi-drums__button';
                clearBtn.textContent = 'Clear';
                clearBtn.addEventListener('click', () => layer.clearKitMapping(pieceId));
                actions.appendChild(remapBtn);
                actions.appendChild(clearBtn);
                li.appendChild(info);
                li.appendChild(actions);
                mappingListEl.appendChild(li);
            }
        }

        function renderWizard(state) {
            if (!wizardEl || !drumtabHintEl || !wizardStartBtn || !wizardResetBtn) return;

            const hasDrumTab = state.currentDrumTab && Array.isArray(state.currentDrumTab.kit);
            const profile = state.kitProfiles && state.kitProfiles[state.activeKit];
            const requiredPieces = hasDrumTab
                ? (state.currentDrumTab.kit || [])
                    .map((item) => item && (item.piece || item.id))
                    .filter((x) => typeof x === 'string')
                : [];
            // Unique
            const uniqueRequired = Array.from(new Set(requiredPieces));
            const pendingCount = uniqueRequired.filter((p) => !(profile && profile[p])).length;

            if (wizardStartBtn) wizardStartBtn.disabled = !hasDrumTab || pendingCount === 0;
            if (wizardResetBtn) wizardResetBtn.disabled = !state.wizard;

            if (drumtabHintEl) {
                if (!hasDrumTab) {
                    drumtabHintEl.textContent = 'Waiting for a loaded song/drum chart to determine which pieces to calibrate.';
                    drumtabHintEl.hidden = false;
                } else if (pendingCount === 0) {
                    drumtabHintEl.textContent = `All ${uniqueRequired.length} required piece${uniqueRequired.length === 1 ? '' : 's'} are already mapped.`;
                    drumtabHintEl.hidden = false;
                } else {
                    drumtabHintEl.hidden = true;
                }
            }

            if (!state.wizard) {
                wizardEl.hidden = true;
                return;
            }
            wizardEl.hidden = false;

            // Hide all steps
            if (wizardIntroEl) wizardIntroEl.hidden = true;
            if (wizardAwaitingEl) wizardAwaitingEl.hidden = true;
            if (wizardCapturingEl) wizardCapturingEl.hidden = true;
            if (wizardGotHitEl) wizardGotHitEl.hidden = true;
            if (wizardConfirmedEl) wizardConfirmedEl.hidden = true;
            if (wizardCompleteEl) wizardCompleteEl.hidden = true;
            if (wizardNoDevicesEl) wizardNoDevicesEl.hidden = true;

            const phase = state.wizard.phase;
            if (phase === 'intro' && wizardIntroEl) wizardIntroEl.hidden = false;
            if (phase === 'awaiting' && wizardAwaitingEl) {
                wizardAwaitingEl.hidden = false;
                if (wizardPieceEl && state.wizard.currentPiece) wizardPieceEl.textContent = layer.getPieceDisplayName(state.wizard.currentPiece);
                if (wizardRemainingEl) {
                    const rem = state.wizard.remainingPieces ? state.wizard.remainingPieces.length : 0;
                    wizardRemainingEl.textContent = rem === 1 ? '1 piece remaining' : `${rem} pieces remaining`;
                }
            }
            if (phase === 'capturing' && wizardCapturingEl) wizardCapturingEl.hidden = false;
            if (phase === 'gotHit' && wizardGotHitEl) {
                wizardGotHitEl.hidden = false;
                if (wizardHitInfoEl && state.wizard.lastHit) {
                    const h = state.wizard.lastHit;
                    const devLabel = labels.get(h.logicalSourceKey) || h.logicalSourceKey;
                    let text = `${devLabel} — note ${h.note}, velocity ${h.velocity}, ch ${h.channel + 1}`;
                    if (state.wizard.conflict) {
                        text += ` (Warning: same trigger also mapped to ${layer.getPieceDisplayName(state.wizard.conflict)})`;
                    }
                    wizardHitInfoEl.textContent = text;
                }
            }
            if (phase === 'confirmed' && wizardConfirmedEl) wizardConfirmedEl.hidden = false;
            if (phase === 'complete' && wizardCompleteEl) wizardCompleteEl.hidden = false;
        }

        const onRescan = () => { layer.discover({ force: true }).catch(() => {}); };

        // `screen:changing` is best-effort, not a spec guarantee: it lets us release
        // sessions before navigation completes rather than after. `pagehide`
        // below is the guaranteed backstop.
        const onScreenChanging = (ev) => {
            const from = (ev && ev.detail && ev.detail.from) || (ev && ev.from) || null;
            if (from === SCREEN_ID) layer.setActive(false);
        };
        // `screen:changed` is the normative "I am on `id`" signal, so an explicit id
        // always wins — the Host may emit it before or after it swaps the
        // container's `active` class, and guessing from the class would fight
        // it. The class is only the fallback for a Host that sends no id at all,
        // so an unreadable payload fails towards the DOM instead of leaving the
        // screen permanently inert.
        const onScreenChanged = (ev) => {
            const id = (ev && ev.detail && ev.detail.id) || (ev && ev.id) || null;
            if (id === null) layer.setActive(root.classList.contains('active'));
            else layer.setActive(id === SCREEN_ID);
        };
        // A full page load is the other exit path. `pageshow` re-syncs so a
        // tab restored from bfcache resumes instead of sitting inactive.
        const onPageHide = () => layer.setActive(false);
        const onPageShow = () => layer.setActive(root.classList.contains('active'));

        const unsubscribeState = layer.subscribe(onState);
        const unsubscribeHit = layer.onHit(onHit);
        if (rescanBtn) rescanBtn.addEventListener('click', onRescan);

        // Wizard button handlers
        if (wizardStartBtn) wizardStartBtn.addEventListener('click', () => layer.startWizard());
        if (wizardResetBtn) wizardResetBtn.addEventListener('click', () => layer.resetWizard());
        if (wizardBeginBtn) wizardBeginBtn.addEventListener('click', () => layer.startCapturing());
        if (wizardSkipBtn) wizardSkipBtn.addEventListener('click', () => layer.skipCurrentPiece());
        if (wizardConfirmBtn) wizardConfirmBtn.addEventListener('click', () => layer.confirmWizardHit());
        if (wizardRetryBtn) wizardRetryBtn.addEventListener('click', () => layer.retryWizardHit());
        if (wizardNextBtn) wizardNextBtn.addEventListener('click', () => layer.advanceWizard());
        if (wizardDoneBtn) wizardDoneBtn.addEventListener('click', () => layer.resetWizard());

        // Kit profile controls. Failed CRUD (duplicate name, unknown profile)
        // leaves state untouched, which the next onState re-renders — no
        // separate error channel needed for v1.
        if (profileSel) profileSel.addEventListener('change', () => layer.setActiveKit(profileSel.value));
        if (profileCreateBtn) profileCreateBtn.addEventListener('click', () => {
            const result = layer.createKitProfile(profileNameEl ? profileNameEl.value : '');
            if (result.ok && profileNameEl) profileNameEl.value = '';
            emitOutcomeHint(result);
        });
        if (drumPartSel) drumPartSel.addEventListener('change', () => layer.setCurrentDrumPart(drumPartSel.value));

        function emitOutcomeHint(result) {
            if (!savedEl) return;
            if (!result || result.ok) return;
            savedEl.textContent = result.error || 'That change was rejected.';
            savedEl.hidden = false;
        }

        // Retryable for the same reason as the layer's own bus subscription: the
        // screen lifecycle events are what wake this screen back up, so losing
        // them would leave it permanently inert. `bindBus` is idempotent and is
        // re-run on every activation.
        let bus = null;
        let busBound = false;
        function bindBus() {
            if (busBound) return;
            const found = window.feedBack;
            if (!found || typeof found.on !== 'function') return;
            bus = found;
            busBound = true;
            bus.on('screen:changing', onScreenChanging);
            bus.on('screen:changed', onScreenChanged);
        }

        // Deep-linked single-piece remap from the Settings panel
        // (window.feedBack.navigate('plugin-midi-drums', { remapPiece })). The
        // params are one-shot — getNavParams clears them — and must be
        // consumed on the activation they arrived with.
        function onActivation() {
            bindBus();
            let params = null;
            try {
                params = (window.feedBack && typeof window.feedBack.getNavParams === 'function')
                    ? window.feedBack.getNavParams()
                    : null;
            } catch (_) { params = null; }
            if (params && typeof params.remapPiece === 'string' && params.remapPiece) {
                layer.remapPiece(params.remapPiece);
            }
        }
        bindBus();
        const unbindActivation = layer.addActivateListener(onActivation);

        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('pageshow', onPageShow);

        onState(layer.getState());

        return {
            dispose() {
                unsubscribeState();
                unsubscribeHit();
                unbindActivation();
                if (rescanBtn) rescanBtn.removeEventListener('click', onRescan);
                if (busBound && bus && typeof bus.off === 'function') {
                    bus.off('screen:changing', onScreenChanging);
                    bus.off('screen:changed', onScreenChanged);
                }
                window.removeEventListener('pagehide', onPageHide);
                window.removeEventListener('pageshow', onPageShow);
                layer.setActive(false);
            },
        };
    }

    // ── boot ───────────────────────────────────────────────────────────────

    // The layer is created once and reused; only the view binding is replaced,
    // so re-hydration swaps one set of listeners for another instead of
    // stacking a second copy (spec §6.1, `plugin-runtime-idempotent.v1`).
    if (!window[GLOBAL_KEY] || window[GLOBAL_KEY].version !== 1) {
        window[GLOBAL_KEY] = createDeviceLayer();
    }
    const layer = window[GLOBAL_KEY];

    const previous = window[VIEW_KEY];
    if (previous) previous.dispose();
    window[VIEW_KEY] = bindView(layer);

    // The Host toggles `active` on the screen container; adopt whatever state
    // the screen is already in, since `screen:changed` only fires on a change.
    const root = document.getElementById(SCREEN_ID);
    if (root) layer.setActive(root.classList.contains('active'));
})();