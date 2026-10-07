# SPDX-License-Identifier: AGPL-3.0-or-later
"""Server routes for midi-drums.

Persists which logicalSourceKeys the user has ticked as drum-trigger devices, so
a reload (or a replug after an unplug) reopens the same devices instead of
guessing. Keys — not device labels — are stored: a label is hardware text that
can change with a driver update, while the domain's logicalSourceKey is stable
per provider + source id.

Also persists kit profiles (piece-id -> {note, channel, logicalSourceKey}
mappings), the active profile, per-profile last-modified stamps, and per-song
piece overrides.

Follows the same shape as the template's routes.py: all work happens inside
setup(), configuration is read tolerantly, routes are namespaced under the
plugin id, and setup() validates before registering anything.
"""

import asyncio
import json
import logging
import os
import threading
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

PLUGIN_ID = "midi-drums"
MAX_SETTINGS_BODY_BYTES = 16 * 1024
# Must match MAX_SOURCES in screen.js: the client caps its selection here, and
# the server refuses anything larger rather than silently truncating.
MAX_SOURCE_KEYS = 8
# Must match MAX_SOURCE_KEY_LEN in screen.js, so an over-long key read back from
# here can still be re-saved without the server rejecting the POST.
MAX_SOURCE_KEY_LEN = 200
# Kit-profile collection bounds. Piece-id values are deliberately NOT checked
# against a closed vocabulary: lib/drums.py lets unknown piece-ids round-trip
# for forward-compat, and a profile saved by a newer plugin build must keep
# loading here. Shape-level bounds only.
MAX_KIT_PROFILES = 64
MAX_PROFILE_NAME_LEN = 100
MAX_PIECE_ID_LEN = 50
MAX_PIECES_PER_PROFILE = 64
# Per-song overrides are a sparse overlay of the active kit profile, so they
# share the profile bounds plus a generous song-key bound.
MAX_SONG_OVERRIDE_KEYS = 256
MAX_SONG_ID_LEN = 200
# The profiles document is the biggest thing this plugin stores (64 profiles of
# up to 18-piece e-kits can plausibly reach ~200 KiB of JSON), so the profile
# routes take their own, larger body cap than the 16 KiB selection cap.
MAX_KIT_PROFILES_BODY_BYTES = 256 * 1024

_DEFAULTS = {
    "source_keys": [],
    "active_kit": "default",
    "kit_profiles": {},
    "kit_updated_at": {},
    "per_song_overrides": {},
}


def _is_valid_setting(name: str, value: object) -> bool:
    """Return whether a setting value matches the schema."""
    if name == "source_keys":
        if not isinstance(value, list) or len(value) > MAX_SOURCE_KEYS:
            return False
        # `type(x) is str` rather than isinstance: nothing else should reach here,
        # and bool/int slipping in as a key would produce an unopenable selection.
        if any(type(item) is not str for item in value):
            return False
        if any(not item or len(item) > MAX_SOURCE_KEY_LEN for item in value):
            return False
        # A duplicate would open one device twice — the client never sends one, so
        # this only rejects a hand-edited file, which _read() then salvages.
        return len(set(value)) == len(value)
    if name == "active_kit":
        return isinstance(value, str) and 0 < len(value) < MAX_PROFILE_NAME_LEN
    if name == "kit_profiles":
        if not isinstance(value, dict) or len(value) > MAX_KIT_PROFILES:
            return False
        # Basic validation - each profile is a dict of piece->mapping
        for profile_name, profile in value.items():
            if not isinstance(profile_name, str) or not profile_name or len(profile_name) > MAX_PROFILE_NAME_LEN:
                return False
            if not isinstance(profile, dict):
                return False
            if len(profile) > MAX_PIECES_PER_PROFILE:
                return False
            for piece_id, mapping in profile.items():
                if not isinstance(piece_id, str) or not piece_id or len(piece_id) > MAX_PIECE_ID_LEN:
                    return False
                if not _is_valid_trigger_mapping(mapping):
                    return False
        return True
    if name == "kit_updated_at":
        if not isinstance(value, dict) or len(value) > MAX_KIT_PROFILES:
            return False
        # Stamps are display-only ISO strings, so a loose-but-typed check is
        # enough: bounded key, bounded string.
        return all(
            type(stamp_key) is str
            and 0 < len(stamp_key) < MAX_PROFILE_NAME_LEN
            and type(stamp) is str
            and 0 < len(stamp) <= 40
            for stamp_key, stamp in value.items()
        )
    if name == "per_song_overrides":
        if not isinstance(value, dict) or len(value) > MAX_SONG_OVERRIDE_KEYS:
            return False
        for song_id, pieces in value.items():
            if type(song_id) is not str or not song_id or len(song_id) > MAX_SONG_ID_LEN:
                return False
            if not isinstance(pieces, dict) or len(pieces) > MAX_PIECES_PER_PROFILE:
                return False
            for piece_id, mapping in pieces.items():
                if type(piece_id) is not str or not piece_id or len(piece_id) > MAX_PIECE_ID_LEN:
                    return False
                if not _is_valid_trigger_mapping(mapping):
                    return False
        return True
    return False


def _is_valid_trigger_mapping(mapping: object) -> bool:
    """A piece trigger mapping is exactly {note, channel, logicalSourceKey}.

    Exact-keys matching (rather than "has the required keys") keeps a stray
    leftover field from a hand-edit out of the stored shape, where it would be
    silently carried forever.
    """
    if not isinstance(mapping, dict) or len(mapping) != 3:
        return False
    for key in ("note", "channel", "logicalSourceKey"):
        if key not in mapping:
            return False
    if type(mapping["note"]) is not int or not 0 <= mapping["note"] <= 127:
        return False
    if type(mapping["channel"]) is not int or not 0 <= mapping["channel"] <= 15:
        return False
    if type(mapping["logicalSourceKey"]) is not str or not mapping["logicalSourceKey"]:
        return False
    return True


def _sanitise_source_keys(keys: object) -> list:
    """Coerce a persisted source_keys value into something openable.

    Keeps every usable key and drops only the unusable ones, rather than
    discarding the whole selection because of one bad entry: a file with a
    duplicate, an over-long key, or a stray non-string would otherwise silently
    reset the user to "no devices" and lose every valid key in it. Enforced
    order and de-duplication also make the "no duplicate opens" invariant hold
    even for a hand-edited file.
    """
    if not isinstance(keys, list):
        return []
    clean = []
    for key in keys:
        if type(key) is not str or not key or len(key) > MAX_SOURCE_KEY_LEN:
            continue
        if key in clean:
            continue
        clean.append(key)
        if len(clean) == MAX_SOURCE_KEYS:
            break
    return clean


def setup(app: FastAPI, context: dict) -> None:
    """Register routes for midi-drums.

    Args:
        app: FastAPI application instance
        context: dict with config_dir and log keys
    """
    config_dir = Path(context["config_dir"])
    log = context.get("log") or logging.getLogger(f"feedBack.plugin.{PLUGIN_ID}")
    config_file = config_dir / f"{PLUGIN_ID}.json"
    # The read-modify-write in _merge_and_persist runs in a worker thread, so it
    # is guarded by a threading lock. Two overlapping POSTs would otherwise
    # interleave their read and write and lose one of the two selections.
    write_lock = threading.Lock()

    def _sanitise_trigger_mapping(mapping: object) -> dict | None:
        """Return a clean {note, channel, logicalSourceKey} dict or None."""
        if not isinstance(mapping, dict):
            return None
        note = mapping.get("note")
        channel = mapping.get("channel")
        logical_source_key = mapping.get("logicalSourceKey")
        if type(note) is not int or note < 0 or note > 127:
            return None
        if type(channel) is not int or channel < 0 or channel > 15:
            return None
        if type(logical_source_key) is not str or not logical_source_key:
            return None
        return {
            "note": note,
            "channel": channel,
            "logicalSourceKey": logical_source_key,
        }

    def _sanitise_piece_mappings(mappings: object) -> dict:
        """Salvage a piece-id -> mapping dict key-by-key."""
        if not isinstance(mappings, dict):
            return {}
        clean = {}
        for piece_id, mapping in mappings.items():
            if not isinstance(piece_id, str) or not piece_id or len(piece_id) > MAX_PIECE_ID_LEN:
                continue
            clean_mapping = _sanitise_trigger_mapping(mapping)
            if clean_mapping is not None:
                clean[piece_id] = clean_mapping
            if len(clean) == MAX_PIECES_PER_PROFILE:
                break
        return clean

    _RESERVED_KEYS = frozenset({"__proto__", "constructor", "prototype"})

    def _sanitise_kit_profiles(value: object) -> dict:
        """Coerce persisted kit profiles into something valid."""
        if not isinstance(value, dict):
            return {}
        clean = {}
        for profile_name, profile in value.items():
            if profile_name in _RESERVED_KEYS:
                continue
            if not isinstance(profile_name, str) or not profile_name or len(profile_name) > MAX_PROFILE_NAME_LEN:
                continue
            if not isinstance(profile, dict):
                continue
            clean_profile = _sanitise_piece_mappings(profile)
            if clean_profile:
                clean[profile_name] = clean_profile
            if len(clean) == MAX_KIT_PROFILES:
                break
        return clean

    def _sanitise_stamps(value: object) -> dict:
        """Coerce persisted kit_updated_at stamps into something displayable."""
        if not isinstance(value, dict):
            return {}
        clean = {}
        for profile_name, stamp in value.items():
            if profile_name in _RESERVED_KEYS:
                continue
            if type(profile_name) is not str or not profile_name or len(profile_name) >= MAX_PROFILE_NAME_LEN:
                continue
            if type(stamp) is not str or not stamp or len(stamp) > 40:
                continue
            clean[profile_name] = stamp
            if len(clean) == MAX_KIT_PROFILES:
                break
        return clean

    def _sanitise_song_overrides(value: object) -> dict:
        """Coerce persisted per-song piece overrides into something valid."""
        if not isinstance(value, dict):
            return {}
        clean = {}
        for song_id, pieces in value.items():
            if type(song_id) is not str or not song_id or len(song_id) > MAX_SONG_ID_LEN:
                continue
            clean_pieces = _sanitise_piece_mappings(pieces)
            if clean_pieces:
                clean[song_id] = clean_pieces
            if len(clean) == MAX_SONG_OVERRIDE_KEYS:
                break
        return clean

    def _read() -> dict:
        """Read the persisted device selection, tolerating a bad file."""
        if not config_file.exists():
            return dict(_DEFAULTS)
        try:
            data = json.loads(config_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("%s: unreadable config, using defaults: %s", PLUGIN_ID, exc)
            return dict(_DEFAULTS)
        if not isinstance(data, dict):
            return dict(_DEFAULTS)
        # Rebuilt per read rather than shallow-copied from _DEFAULTS, so an
        # in-place edit here can't reach the module-level default list.
        settings = dict(_DEFAULTS)
        settings["source_keys"] = []
        for key, value in data.items():
            if key not in _DEFAULTS:
                continue
            if key == "source_keys":
                settings[key] = _sanitise_source_keys(value)
            elif key == "kit_profiles":
                settings[key] = _sanitise_kit_profiles(value)
            elif key == "kit_updated_at":
                settings[key] = _sanitise_stamps(value)
            elif key == "per_song_overrides":
                settings[key] = _sanitise_song_overrides(value)
            elif key == "active_kit":
                if isinstance(value, str) and value:
                    settings[key] = value[:MAX_PROFILE_NAME_LEN - 1]
                else:
                    settings[key] = "default"
        # An active profile that was lost to salvage (or a hand edit) falls
        # back to the default profile rather than pointing at nothing.
        if settings["active_kit"] not in settings["kit_profiles"]:
            has_any = bool(settings["kit_profiles"])
            settings["active_kit"] = next(iter(settings["kit_profiles"]), "default") if has_any else "default"
        return settings

    # Fail fast on an unusable config_dir, before any route is registered — a
    # path we cannot even name would otherwise surface as a 500 on first use.
    try:
        config_dir.mkdir(parents=True, exist_ok=True)
        _read()
        log.info("%s: configuration validated", PLUGIN_ID)
    except Exception as exc:
        log.error("%s: configuration validation failed: %s", PLUGIN_ID, exc)
        raise

    @app.get(f"/api/plugins/{PLUGIN_ID}/settings")
    def get_settings() -> JSONResponse:
        """Get the saved device selection, kit profiles, and overrides."""
        return JSONResponse(_read())

    @app.post(f"/api/plugins/{PLUGIN_ID}/settings")
    async def set_settings(request: Request) -> JSONResponse:
        """Replace the saved settings.

        Accepts a bounded JSON object holding `source_keys`, `active_kit`,
        `kit_profiles`, `kit_updated_at`, and/or `per_song_overrides`.
        """
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                content_length_value = int(content_length)
                if content_length_value < 0:
                    return JSONResponse(
                        {"error": "invalid Content-Length header"}, status_code=400
                    )
                if content_length_value > MAX_SETTINGS_BODY_BYTES:
                    return JSONResponse(
                        {"error": "request body too large"}, status_code=413
                    )
            except ValueError:
                return JSONResponse(
                    {"error": "invalid Content-Length header"}, status_code=400
                )

        body = bytearray()
        try:
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_SETTINGS_BODY_BYTES:
                    return JSONResponse(
                        {"error": "request body too large"}, status_code=413
                    )
                body.extend(chunk)
            incoming = json.loads(body)
        except (UnicodeDecodeError, ValueError):
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)

        if not isinstance(incoming, dict):
            return JSONResponse(
                {"error": "body must be a JSON object"}, status_code=400
            )
        if incoming.keys() - _DEFAULTS.keys():
            return JSONResponse(
                {"error": "body contains unknown settings"}, status_code=400
            )
        if not all(_is_valid_setting(key, value) for key, value in incoming.items()):
            return JSONResponse(
                {"error": "body contains invalid setting values"}, status_code=400
            )

        def _merge_and_persist() -> dict:
            """Merge incoming settings with existing ones and persist. Runs off
            the event loop (asyncio.to_thread below) since _read() and the write
            are blocking filesystem calls, and set_settings must stay `async def`
            to stream the request body above."""
            with write_lock:
                merged = {**_read(), **incoming}
                # config_dir was created in setup() before any route was
                # registered, so it is already there.
                # Written to a sibling then renamed: a torn or truncated write
                # would leave invalid JSON, and _read()'s corrupt-file recovery
                # would then reset the user's whole selection to empty.
                tmp_file = config_file.with_name(config_file.name + ".tmp")
                tmp_file.write_text(json.dumps(merged, indent=2), encoding="utf-8")
                os.replace(tmp_file, config_file)
                return merged

        try:
            merged = await asyncio.to_thread(_merge_and_persist)
            log.info("%s: settings updated", PLUGIN_ID)
        except Exception as exc:
            log.error("%s: failed to write settings: %s", PLUGIN_ID, exc)
            # The exception text can carry absolute filesystem paths, so it is
            # logged rather than returned to the caller.
            return JSONResponse(
                {"error": "failed to save settings"}, status_code=500
            )

        return JSONResponse(merged)

    # Kit profile-specific endpoints for easier manipulation. These carry the
    # larger document (64 profiles' worth of mappings), so they take their own
    # body cap instead of MAX_SETTINGS_BODY_BYTES.
    @app.get(f"/api/plugins/{PLUGIN_ID}/kit-profiles")
    def get_kit_profiles() -> JSONResponse:
        """Get all kit profiles with their stamps and per-song overrides."""
        settings = _read()
        return JSONResponse({
            "active_kit": settings["active_kit"],
            "kit_profiles": settings["kit_profiles"],
            "kit_updated_at": settings["kit_updated_at"],
            "per_song_overrides": settings["per_song_overrides"],
        })

    @app.post(f"/api/plugins/{PLUGIN_ID}/kit-profiles")
    async def set_kit_profiles(request: Request) -> JSONResponse:
        """Update kit profiles, the active profile, stamps, and/or overrides."""
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                content_length_value = int(content_length)
                if content_length_value < 0:
                    return JSONResponse(
                        {"error": "invalid Content-Length header"}, status_code=400
                    )
                if content_length_value > MAX_KIT_PROFILES_BODY_BYTES:
                    return JSONResponse(
                        {"error": "request body too large"}, status_code=413
                    )
            except ValueError:
                return JSONResponse(
                    {"error": "invalid Content-Length header"}, status_code=400
                )

        body = bytearray()
        try:
            async for chunk in request.stream():
                if len(body) + len(chunk) > MAX_KIT_PROFILES_BODY_BYTES:
                    return JSONResponse(
                        {"error": "request body too large"}, status_code=413
                    )
                body.extend(chunk)
            incoming = json.loads(body)
        except (UnicodeDecodeError, ValueError):
            return JSONResponse({"error": "invalid JSON body"}, status_code=400)

        if not isinstance(incoming, dict):
            return JSONResponse(
                {"error": "body must be a JSON object"}, status_code=400
            )
        if incoming.keys() - {"active_kit", "kit_profiles", "kit_updated_at", "per_song_overrides"}:
            return JSONResponse(
                {"error": "body contains unknown settings"}, status_code=400
            )
        if not all(_is_valid_setting(key, value) for key, value in incoming.items()):
            return JSONResponse(
                {"error": "body contains invalid setting values"}, status_code=400
            )

        def _merge_and_persist() -> dict:
            with write_lock:
                merged = {**_read(), **incoming}
                tmp_file = config_file.with_name(config_file.name + ".tmp")
                tmp_file.write_text(json.dumps(merged, indent=2), encoding="utf-8")
                os.replace(tmp_file, config_file)
                return merged

        try:
            merged = await asyncio.to_thread(_merge_and_persist)
            log.info("%s: kit profiles updated", PLUGIN_ID)
            return JSONResponse(merged)
        except Exception as exc:
            log.error("%s: failed to write settings: %s", PLUGIN_ID, exc)
            return JSONResponse(
                {"error": "failed to save settings"}, status_code=500
            )

    log.info("%s: routes registered", PLUGIN_ID)
