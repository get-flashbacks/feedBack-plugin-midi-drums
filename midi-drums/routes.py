# SPDX-License-Identifier: AGPL-3.0-or-later
"""Server routes for midi-drums.

Persists which logicalSourceKeys the user has ticked as drum-trigger devices, so
a reload (or a replug after an unplug) reopens the same devices instead of
guessing. Keys — not device labels — are stored: a label is hardware text that
can change with a driver update, while the domain's logicalSourceKey is stable
per provider + source id.

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
_DEFAULTS = {
    "source_keys": [],
}


def _is_valid_setting(name: str, value: object) -> bool:
    """Return whether a setting value matches the device-selection schema."""
    if name != "source_keys":
        return False
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

    def _read() -> dict:
        """Read the persisted device selection, tolerating a bad file."""
        if not config_file.exists():
            return {"source_keys": []}
        try:
            data = json.loads(config_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log.warning("%s: unreadable config, using defaults: %s", PLUGIN_ID, exc)
            return {"source_keys": []}
        if not isinstance(data, dict):
            return {"source_keys": []}
        # Rebuilt per read rather than shallow-copied from _DEFAULTS, so an
        # in-place edit here can't reach the module-level default list.
        settings = {"source_keys": []}
        for key, value in data.items():
            if key not in _DEFAULTS:
                continue
            settings[key] = _sanitise_source_keys(value)
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
        """Get the saved drum-trigger device selection."""
        return JSONResponse(_read())

    @app.post(f"/api/plugins/{PLUGIN_ID}/settings")
    async def set_settings(request: Request) -> JSONResponse:
        """Replace the saved drum-trigger device selection.

        Accepts a bounded JSON object holding `source_keys` — the logical source
        keys of the ticked devices, in the user's order. Sending the key
        replaces the saved selection outright rather than adding to it, so
        unticking the last device ("none left") is expressible.
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
                config_dir.mkdir(parents=True, exist_ok=True)
                # Written to a sibling then renamed: a torn or truncated write
                # would leave invalid JSON, and _read()'s corrupt-file recovery
                # would then reset the user's whole selection to empty.
                tmp_file = config_file.with_name(config_file.name + ".tmp")
                tmp_file.write_text(json.dumps(merged, indent=2), encoding="utf-8")
                os.replace(tmp_file, config_file)
                return merged

        try:
            merged = await asyncio.to_thread(_merge_and_persist)
            log.info("%s: device selection updated (%d source(s))", PLUGIN_ID, len(merged["source_keys"]))
        except Exception as exc:
            log.error("%s: failed to write settings: %s", PLUGIN_ID, exc)
            # The exception text can carry absolute filesystem paths, so it is
            # logged rather than returned to the caller.
            return JSONResponse(
                {"error": "failed to save settings"}, status_code=500
            )

        return JSONResponse(merged)

    log.info("%s: routes registered", PLUGIN_ID)