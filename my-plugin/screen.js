// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Client screen for my-plugin.
//
// This script runs on the main thread when the plugin's screen is active.
// The Host creates a container element (id="plugin-my-plugin") and sets its
// markup from screen.html. This script finds its own DOM by ID and wires up
// behavior. Keep all DOM and CSS scoped to the plugin's root (data-plugin-id)
// so nothing leaks into the rest of the app (spec §6.3, §6.4).

const PLUGIN_ID = "my-plugin";

// Guard against re-hydration: run setup only once.
if (!window[`__${PLUGIN_ID}_setup`]) {
  window[`__${PLUGIN_ID}_setup`] = true;

  // Find the plugin's root element. The Host assigns an id of the form
  // "plugin-<id>", but querying by data-plugin-id is more readable.
  const root = document.getElementById(`plugin-${PLUGIN_ID}`);
  if (!root) {
    console.warn(`${PLUGIN_ID}: root element not found`);
  } else {
    // Set up the screen UI and load settings from the server.
    setupScreen(root);
    loadSettings(root);
  }
}

function setupScreen(root) {
  // Example: wire up click handlers, event listeners, etc.
  const button = root.querySelector("[data-role='increment-button']");
  const counter = root.querySelector("[data-role='counter']");

  if (button && counter) {
    let count = 0;
    button.addEventListener("click", () => {
      count++;
      counter.textContent = count;
    });
  }
}

async function loadSettings(root) {
  // Fetch the plugin's persisted settings from the server.
  // This assumes routes.py defines a GET /api/plugins/my-plugin/settings endpoint.
  try {
    const res = await fetch(`/api/plugins/${PLUGIN_ID}/settings`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const settings = await res.json();
    const colorDisplay = root.querySelector("[data-role='color-display']");
    if (colorDisplay) {
      colorDisplay.textContent = settings.color || "indigo";
    }
  } catch (err) {
    // Fail soft: a fetch failure degrades the screen, it doesn't crash the plugin.
    console.warn(`${PLUGIN_ID}: could not load settings`, err);
  }
}
