// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MIDI Drums — placeholder screen.
//
// This plugin does not yet do anything. It exists so the plugin loads
// cleanly (nav entry + an empty screen) while the MIDI-drum-input feature
// is scoped and built out. See README.md for the plan.

(function () {
  "use strict";

  const PLUGIN_ID = "midi_drums";

  // Idempotent guard: the Host may re-execute this script on plugin reload.
  if (window.__feedBackMidiDrumsSetup) return;
  window.__feedBackMidiDrumsSetup = true;

  function setupScreen() {
    const root = document.getElementById(`plugin-${PLUGIN_ID}`);
    if (!root) {
      console.warn(`${PLUGIN_ID}: root element not found`);
      return;
    }
    root.innerHTML =
      '<div class="midi-drums-placeholder">' +
      "<h2>MIDI Drums</h2>" +
      "<p>Coming soon: play drum charts with a MIDI drum controller.</p>" +
      "</div>";
  }

  if (window.feedBack && typeof window.feedBack.on === "function") {
    window.feedBack.on("screen:changed", (e) => {
      if (e && e.detail && e.detail.screen === `plugin-${PLUGIN_ID}`) {
        setupScreen();
      }
    });
  }

  setupScreen();
})();
