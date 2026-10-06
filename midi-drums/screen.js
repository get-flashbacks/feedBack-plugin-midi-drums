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
// What this file owns is device access only. Kit calibration, drum-chart
// consumption and scoring build on top of `window.midiDrumsDevices`, which
// already hands them a single logical stream of note-ons tagged with the
// `logicalSourceKey` they arrived on (so a kick pedal on one interface and pads
// on another stay distinguishable).
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
    // Common drum piece IDs (as referenced in the host's drum tab)
    const PIECES = {
        kick: { name: 'Kick' },
        snare: { name: 'Snare' },
        hh_closed: { name: 'Hi-Hat Closed' },
        hh_open: { name: 'Hi-Hat Open' },
        crash: { name: 'Crash' },
        ride: { name: 'Ride' },
        tom1: { name: 'Tom 1' },
        tom2: { name: 'Tom 2' },
        tom3: { name: 'Tom 3' },
        floor_tom: { name: 'Floor Tom' },
        rim: { name: 'Rim Shot' },
        clap: { name: 'Clap' },
        cowbell: { name: 'Cowbell' },
        crash2: { name: 'Crash 2' },
        ride2: { name: 'Ride 2' },
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
        const hitListeners = new Set();
        const stateListeners = new Set();
        const activateListeners = new Set();
        const drumTabListeners = new Set();
        let activeKit = 'default';
        let kitProfiles = {};
        let currentDrumTab = null;
        let currentDrumHits = null;
        let currentDrumPart = null;
        let wizardState = null; // { phase, currentPiece, pendingPieces, captures, capturing }
        let noteStateProvider = null;
        let lastNoteState = null;
        let scoreState = {
            hits: 0,
            misses: 0,
            total: 0,
            accuracy: 0,
        };

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
                currentDrumTab,
                currentDrumHits,
                currentDrumPart,
                scoreState: { ...scoreState },
                wizard: wizardState ? { ...wizardState } : null,
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
            // Handle scoring for live hits
            handleHitForScoring(hit);
            // Update note state provider if registered
            updateNoteStateForHit(hit);
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
                    body: JSON.stringify({ active_kit: activeKit, kit_profiles: kitProfiles }),
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

        // ── kit profile / wizard ──────────────────────────────────────────────

        function getPieceDisplayName(pieceId) {
            if (PIECES[pieceId] && PIECES[pieceId].name) return PIECES[pieceId].name;
            // Title-case fallback
            return pieceId.replace(/_/g, ' ').replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.substr(1).toLowerCase());
        }

        function getActiveKitProfile() {
            if (!kitProfiles[activeKit]) kitProfiles[activeKit] = {};
            return kitProfiles[activeKit];
        }

        function setKitMapping(pieceId, mapping) {
            const profile = getActiveKitProfile();
            profile[pieceId] = mapping;
            saveKitProfiles().catch(() => {});
            emitState();
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
                saveKitProfiles().catch(() => {});
                emitState();
            }
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

        // ── scoring and hit matching ──────────────────────────────────────────
        function findPieceForHit(hit) {
            const profile = getActiveKitProfile();
            for (const pieceId of Object.keys(profile)) {
                const mapping = profile[pieceId];
                if (mapping &&
                    mapping.logicalSourceKey === hit.logicalSourceKey &&
                    mapping.note === hit.note &&
                    mapping.channel === hit.channel) {
                    return pieceId;
                }
            }
            return null;
        }

        function handleHitForScoring(hit) {
            const pieceId = findPieceForHit(hit);
            if (!pieceId) return;
            // For now, just count hits - full matching against chart timing
            // would require comparing against currentDrumHits array with timing
            scoreState.hits += 1;
            scoreState.total = scoreState.hits + scoreState.misses;
            if (scoreState.total > 0) {
                scoreState.accuracy = Math.round((scoreState.hits / scoreState.total) * 100);
            }
            emitState();
        }

        function resetScore() {
            scoreState = {
                hits: 0,
                misses: 0,
                total: 0,
                accuracy: 0,
            };
            emitState();
        }

        // ── note state provider (highway integration) ─────────────────────────
        function setNoteStateProvider(provider) {
            noteStateProvider = provider;
            lastNoteState = null;
        }

        // Expose the provider setter globally and also register with highway if available
        function registerWithHighway() {
            try {
                const hw = (window.feedBack && window.feedBack.highway) || window.highway;
                if (hw && typeof hw.setNoteStateProvider === 'function') {
                    hw.setNoteStateProvider({
                        setNoteState: (note, state, velocity) => {
                            if (noteStateProvider && typeof noteStateProvider.setNoteState === 'function') {
                                noteStateProvider.setNoteState(note, state, velocity);
                            }
                        },
                        clear: () => {
                            if (noteStateProvider && typeof noteStateProvider.clear === 'function') {
                                noteStateProvider.clear();
                            }
                        },
                    });
                }
            } catch (err) {
                console.warn(`${PLUGIN_ID}: could not register with highway`, err);
            }
        }

        function clearNoteStateProvider() {
            noteStateProvider = null;
            lastNoteState = null;
        }

        function updateNoteStateForHit(hit) {
            const pieceId = findPieceForHit(hit);
            if (!pieceId || !noteStateProvider || typeof noteStateProvider.setNoteState !== 'function') {
                return;
            }
            try {
                // Map to note index as expected by the provider
                // The provider typically takes (noteIndex, state, velocity)
                noteStateProvider.setNoteState(pieceId, true, hit.velocity / 127);
                // Clear after a short duration if needed - but the provider manages timing
            } catch (err) {
                console.warn(`${PLUGIN_ID}: note state provider error`, err);
            }
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

        // ── screen lifecycle ─────────────────────────────────────────────────

        function setActive(next) {
            // Bus binding is retried on every call, including a no-op
            // transition: the Host can install `window.feedBack` after this
            // script runs, while the layer is already active. Both hooks are
            // flag-guarded, so repeating them costs nothing.
            bindSourcesChanged();
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
                // survives, so re-entering restores the same devices.
                closeAll();
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
        }

        // Terminal teardown, used when screen.js is re-executed so the previous
        // layer cannot leave a second set of listeners or a live session behind.
        // Callers must re-bind a view afterwards, which is why this clears the
        // subscriber sets rather than leaving a half-dead view subscribed to
        // state it can no longer render.
        function dispose() {
            setActive(false);
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
            // Drum tab / wizard API
            setCurrentDrumTab(drumTab) {
                currentDrumTab = drumTab;
                emitState();
            },
            setCurrentDrumHits(hits) {
                currentDrumHits = hits;
                emitState();
            },
            setCurrentDrumPart(part) {
                currentDrumPart = part;
                emitState();
            },
            setNoteStateProvider,
            clearNoteStateProvider,
            resetScore,
            getScoreState() {
                return { ...scoreState };
            },
            onDrumTabChanged(fn) {
                if (typeof fn === 'function') drumTabListeners.add(fn);
                return () => drumTabListeners.delete(fn);
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
            setActiveKit(kit) {
                activeKit = kit || 'default';
                saveKitProfiles().catch(() => {});
                emitState();
            },
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

            // Score display
            if (scoreHitsEl) {
                scoreHitsEl.textContent = `${state.scoreState.hits}/${state.scoreState.total}`;
            }
            if (scoreAccuracyEl) {
                scoreAccuracyEl.textContent = `${state.scoreState.accuracy}%`;
            }

            // Wizard UI updates
            renderWizard(state);
            renderMappings(state);
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
        const onDrumTab = (ev) => {
            const data = (ev && (ev.detail || ev.data)) || ev;
            layer.setCurrentDrumTab(data);
        };
        const onDrumHits = (ev) => {
            const data = (ev && (ev.detail || ev.data)) || ev;
            layer.setCurrentDrumHits(data);
        };
        const onDrumPart = (ev) => {
            const data = (ev && (ev.detail || ev.data)) || ev;
            layer.setCurrentDrumPart(data);
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
            // Listen for drum chart/tab events
            bus.on('drum-tab', onDrumTab);
            bus.on('drum_tab', onDrumTab);
            bus.on('drum-hits', onDrumHits);
            bus.on('drum_hits', onDrumHits);
            bus.on('drum-part', onDrumPart);
        }
        bindBus();
        const unbindActivation = layer.addActivateListener(bindBus);

        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('pageshow', onPageShow);

        onState(layer.getState());
        registerWithHighway();

        return {
            dispose() {
                unsubscribeState();
                unsubscribeHit();
                unbindActivation();
                if (rescanBtn) rescanBtn.removeEventListener('click', onRescan);
                if (busBound && bus && typeof bus.off === 'function') {
                    bus.off('screen:changing', onScreenChanging);
                    bus.off('screen:changed', onScreenChanged);
                    bus.off('drum-tab', onDrumTab);
                    bus.off('drum_tab', onDrumTab);
                    bus.off('drum-hits', onDrumHits);
                    bus.off('drum_hits', onDrumHits);
                    bus.off('drum-part', onDrumPart);
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