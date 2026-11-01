// ui/overlay.js — the vanilla-DOM interactive menu overlay (prompt §2, §4).
//
// The Canvas keeps drawing the world and the artwork; this module adds a THIN
// DOM layer of REAL, state-scoped HTML buttons over the game wrapper so menu
// choices are actually clickable and keyboard-operable — no framework, no
// decorative canvas text that does nothing. It owns no gameplay state and never
// mutates a RunState: every control calls an injected action callback that
// routes to the FSM / pure save+wardrobe functions.
//
// Panels, shown only in their matching FSM state:
//   - Main Menu: Start Adventure / Wardrobe / How to Play, high score, Candy,
//     equipped Ghosty, plus a Progress section (Export / Import, Mute,
//     Reduced motion, Fullscreen).
//   - Results: Restart / Main Menu / Wardrobe.
//   - Pause: Resume / End Run.
//   - Wardrobe: five selectable cards (select -> preview only), Buy, Equip,
//     Back, live Candy + equipped label.
//
// Accessibility (prompt §4): native <button>s (keyboard-activatable), a visible
// focus ring (index.html), text/icon labels in addition to color, disabled
// controls with an adjacent reason. The overlay stops its own key events from
// reaching the global flight handler so activating a button never also flaps.
//
// Headless-safe: constructing/using this module in a non-browser context is a
// no-op (guarded on `document`).

import { States } from "../state.js";
import { hatCatalog, HAT_NAMES, hatMessage } from "./wardrobe.js";

/** Build an element with props/children; a tiny helper to keep code terse. */
function el(tag, props = {}, children = []) {
  if (typeof document === "undefined") return null;
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v != null) {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * Create the overlay controller.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.root the wrapper element the overlay is attached to
 * @param {object} opts.fsm the FSM (read `state`, call control methods)
 * @param {() => object} opts.getSave returns the live SaveData
 * @param {object} opts.config the frozen CONFIG
 * @param {object} opts.actions injected action callbacks:
 *   startRun, openWardrobe, leaveWardrobe, buyHat(id), equipHat(id),
 *   resume, endRun, restart, toMainMenu, exportProgress, importProgress(file),
 *   setMuted(bool), setReducedMotion(bool), toggleFullscreen
 * @returns {{ sync: () => void, destroy: () => void, getWardrobeSelection: () => string }}
 */
export function createOverlay(opts) {
  if (typeof document === "undefined" || !opts || !opts.root) {
    return { sync() {}, destroy() {}, getWardrobeSelection: () => "none" };
  }
  const { root, fsm, getSave, config, actions } = opts;

  // Wardrobe PREVIEW selection — separate from the equipped hat. Selecting a
  // card only changes this (prompt §2 interaction contract rule 1).
  let wardrobeSelection = "none";
  let wardrobeMessage = "";

  // The overlay container sits above the canvas; pointer events pass through
  // empty areas to the canvas (so flight clicks still work) but land on panels.
  const container = el("div", { class: "kiro-overlay", "aria-live": "polite" });
  root.appendChild(container);

  // Each panel is built once and shown/hidden by state.
  const panels = {};

  // --- Main Menu panel ------------------------------------------------------
  const menuStats = el("p", { class: "kiro-stats" });
  const menuMsg = el("p", { class: "kiro-msg", role: "status" });
  panels.menu = el("div", { class: "kiro-panel kiro-menu", role: "dialog", "aria-label": "Main menu" }, [
    el("h2", { text: "Kiro's Haunted Flight" }),
    menuStats,
    el("div", { class: "kiro-actions" }, [
      el("button", { class: "kiro-btn kiro-primary", type: "button", "data-first": "1", onclick: () => actions.startRun() }, "Start Adventure"),
      el("button", { class: "kiro-btn", type: "button", onclick: () => actions.openWardrobe() }, "Wardrobe"),
      el("button", { class: "kiro-btn", type: "button", onclick: () => toggleHowTo() }, "How to Play"),
    ]),
    buildHowTo(),
    buildProgressSection(),
    menuMsg,
  ]);

  // --- Results panel --------------------------------------------------------
  const resultsStats = el("p", { class: "kiro-stats" });
  panels.results = el("div", { class: "kiro-panel kiro-results", role: "dialog", "aria-label": "Run results" }, [
    el("h2", { class: "kiro-results-title", text: "Results" }),
    resultsStats,
    el("div", { class: "kiro-actions" }, [
      el("button", { class: "kiro-btn kiro-primary", type: "button", "data-first": "1", onclick: () => actions.restart() }, "Restart"),
      el("button", { class: "kiro-btn", type: "button", onclick: () => actions.toMainMenu() }, "Main Menu"),
      el("button", { class: "kiro-btn", type: "button", onclick: () => actions.openWardrobe() }, "Wardrobe"),
    ]),
  ]);

  // --- Pause panel ----------------------------------------------------------
  panels.pause = el("div", { class: "kiro-panel kiro-pause", role: "dialog", "aria-label": "Paused" }, [
    el("h2", { text: "Paused" }),
    el("div", { class: "kiro-actions" }, [
      el("button", { class: "kiro-btn kiro-primary", type: "button", "data-first": "1", onclick: () => actions.resume() }, "Resume"),
      el("button", { class: "kiro-btn kiro-danger", type: "button", onclick: () => actions.endRun() }, "End Run"),
    ]),
  ]);

  // --- Wardrobe panel -------------------------------------------------------
  const wardrobeCandy = el("p", { class: "kiro-stats" });
  const wardrobeCards = el("div", { class: "kiro-cards", role: "list" });
  const wardrobeActions = el("div", { class: "kiro-actions" });
  const wardrobeMsgEl = el("p", { class: "kiro-msg", role: "status" });
  panels.wardrobe = el("div", { class: "kiro-panel kiro-wardrobe", role: "dialog", "aria-label": "Wardrobe" }, [
    el("h2", { text: "Wardrobe" }),
    wardrobeCandy,
    wardrobeCards,
    wardrobeActions,
    wardrobeMsgEl,
  ]);

  for (const key of Object.keys(panels)) container.appendChild(panels[key]);

  // --- How to Play (collapsible) -------------------------------------------
  function buildHowTo() {
    const box = el("div", { class: "kiro-howto", hidden: "hidden" }, [
      el("p", { text: "Space or click the playfield to flap." }),
      el("p", { text: "E or the on-screen button for your spirit's flight power." }),
      el("p", { text: "P to pause. In battle, use the numbered actions." }),
      el("p", { text: "Fly past pipes, choose optional battles, reach the Final Boss." }),
    ]);
    panels._howto = box;
    return box;
  }
  function toggleHowTo() {
    if (!panels._howto) return;
    panels._howto.hidden = !panels._howto.hidden;
  }

  // --- Progress section (export/import + prefs + fullscreen) ----------------
  function buildProgressSection() {
    const muteCb = el("input", { type: "checkbox", id: "kiro-mute" });
    muteCb.addEventListener("change", () => actions.setMuted(Boolean(muteCb.checked)));
    const motionCb = el("input", { type: "checkbox", id: "kiro-motion" });
    motionCb.addEventListener("change", () => actions.setReducedMotion(Boolean(motionCb.checked)));
    const fileInput = el("input", { type: "file", accept: "application/json,.json", id: "kiro-import", hidden: "hidden" });
    fileInput.addEventListener("change", () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) actions.importProgress(f);
      fileInput.value = "";
    });
    panels._muteCb = muteCb;
    panels._motionCb = motionCb;

    return el("div", { class: "kiro-progress" }, [
      el("h3", { text: "Progress & Settings" }),
      el("div", { class: "kiro-settings-row" }, [
        el("label", {}, [muteCb, el("span", { text: " Mute audio" })]),
        el("label", {}, [motionCb, el("span", { text: " Reduced motion" })]),
      ]),
      el("div", { class: "kiro-settings-row" }, [
        el("button", { class: "kiro-btn kiro-small", type: "button", onclick: () => actions.exportProgress() }, "Export Save"),
        el("button", { class: "kiro-btn kiro-small", type: "button", onclick: () => fileInput.click() }, "Import Save"),
        el("button", { class: "kiro-btn kiro-small", type: "button", onclick: () => actions.toggleFullscreen() }, "Fullscreen"),
        fileInput,
      ]),
    ]);
  }

  // --- Wardrobe card rendering ---------------------------------------------
  function renderWardrobe() {
    const save = getSave();
    const rows = hatCatalog(save, config);
    // Keep selection valid.
    if (!rows.some((r) => r.id === wardrobeSelection)) wardrobeSelection = "none";

    wardrobeCandy.textContent = `Candy: ${save.candy}  ·  Equipped: ${HAT_NAMES[save.equippedHat] || save.equippedHat}`;

    // Cards.
    wardrobeCards.textContent = "";
    rows.forEach((row, i) => {
      const selected = row.id === wardrobeSelection;
      let status = row.equipped ? "Equipped" : row.owned ? "Owned" : row.free ? "Free" : `${row.price} Candy`;
      const card = el("button", {
        class: "kiro-card" + (selected ? " kiro-selected" : "") + (row.equipped ? " kiro-equipped" : ""),
        type: "button",
        role: "listitem",
        "aria-pressed": selected ? "true" : "false",
        "data-hat": row.id,
        onclick: () => { wardrobeSelection = row.id; wardrobeMessage = ""; renderWardrobe(); },
      }, [
        el("span", { class: "kiro-card-name", text: `${i + 1}. ${row.name}` }),
        el("span", { class: "kiro-card-status", text: status }),
      ]);
      wardrobeCards.appendChild(card);
    });

    // Contextual Buy / Equip / Back actions for the SELECTED card.
    wardrobeActions.textContent = "";
    const sel = rows.find((r) => r.id === wardrobeSelection) || rows[0];
    const candy = save.candy || 0;
    if (!sel.owned && !sel.free) {
      const need = Math.max(0, sel.price - candy);
      const buyBtn = el("button", {
        class: "kiro-btn kiro-primary",
        type: "button",
        onclick: () => {
          const ok = actions.buyHat(sel.id);
          wardrobeMessage = ok ? `Bought ${sel.name}.` : hatMessage("unaffordable");
          renderWardrobe();
        },
      }, `Buy for ${sel.price} Candy`);
      if (need > 0) {
        buyBtn.disabled = true;
        buyBtn.title = `Need ${need} more Candy`;
      }
      wardrobeActions.appendChild(buyBtn);
      if (need > 0) wardrobeActions.appendChild(el("span", { class: "kiro-reason", text: `Need ${need} more Candy` }));
    } else if (sel.owned && !sel.equipped) {
      wardrobeActions.appendChild(el("button", {
        class: "kiro-btn kiro-primary",
        type: "button",
        onclick: () => {
          const ok = actions.equipHat(sel.id);
          wardrobeMessage = ok ? `Equipped ${sel.name}.` : "";
          renderWardrobe();
        },
      }, sel.free ? "Equip (remove hat)" : "Equip"));
    } else if (sel.equipped) {
      wardrobeActions.appendChild(el("span", { class: "kiro-reason", text: "Already equipped" }));
    }
    wardrobeActions.appendChild(el("button", {
      class: "kiro-btn", type: "button", "data-first": "1",
      onclick: () => actions.leaveWardrobe(),
    }, "Back to Menu"));

    wardrobeMsgEl.textContent = wardrobeMessage;
  }

  // --- Visibility sync ------------------------------------------------------
  const STATE_PANEL = {
    [States.Main_Menu_State]: "menu",
    [States.Results_State]: "results",
    [States.Pause_State]: "pause",
    [States.Wardrobe]: "wardrobe",
  };

  let lastShown = null;

  /** Reflect the current FSM state + save into the overlay (call once/frame). */
  function sync() {
    const active = STATE_PANEL[fsm.state] || null;

    for (const key of Object.keys(panels)) {
      if (key.startsWith("_")) continue;
      panels[key].hidden = key !== active;
    }
    // The overlay container only intercepts pointer events when a panel is up,
    // so empty-space clicks still reach the canvas during flight.
    container.classList.toggle("kiro-active", Boolean(active));

    if (!active) { lastShown = null; return; }

    const save = getSave();
    if (active === "menu") {
      menuStats.textContent =
        `High Score: ${save.highScore}   ·   Candy: ${save.candy}   ·   Hat: ${HAT_NAMES[save.equippedHat] || save.equippedHat}`;
      if (panels._muteCb) panels._muteCb.checked = Boolean(save.prefs && save.prefs.muted);
      if (panels._motionCb) panels._motionCb.checked = Boolean(save.prefs && save.prefs.reducedMotion);
    } else if (active === "results") {
      panels.results.querySelector(".kiro-results-title").textContent =
        save.__lastOutcome === "victory" ? "Victory!" : "Results";
      resultsStats.textContent = save.__resultsLine || "";
    } else if (active === "wardrobe") {
      renderWardrobe();
    }

    // Move focus to the first control when a NEW panel appears (prompt §4).
    if (active !== lastShown) {
      const first = panels[active].querySelector('[data-first="1"], .kiro-btn, button');
      if (first && typeof first.focus === "function") {
        try { first.focus(); } catch { /* ignore */ }
      }
    }
    lastShown = active;
  }

  // Keep overlay key activity from leaking into the global flight handler: a
  // Space/Enter on a focused button activates the button only (prompt §4).
  function onKeydown(ev) {
    if (!container.classList.contains("kiro-active")) return;
    const t = ev.target;
    const isControl = t && (t.tagName === "BUTTON" || t.tagName === "INPUT" || t.tagName === "LABEL");
    if (isControl && (ev.code === "Space" || ev.code === "Enter")) {
      ev.stopPropagation();
    }
    if (ev.code === "Escape") {
      ev.stopPropagation();
      if (fsm.state === States.Wardrobe) actions.leaveWardrobe();
    }
  }
  container.addEventListener("keydown", onKeydown);

  function destroy() {
    container.removeEventListener("keydown", onKeydown);
    if (container.parentNode) container.parentNode.removeChild(container);
  }

  /**
   * Select a wardrobe card by its 0-based index (number-key support). Only
   * changes the PREVIEW selection — never buys or equips (prompt §4). No-op
   * outside the Wardrobe or for an out-of-range index.
   * @param {number} i
   */
  function selectByIndex(i) {
    if (fsm.state !== States.Wardrobe) return;
    const rows = hatCatalog(getSave(), config);
    if (i >= 0 && i < rows.length) {
      wardrobeSelection = rows[i].id;
      wardrobeMessage = "";
      renderWardrobe();
    }
  }

  return {
    sync,
    destroy,
    selectByIndex,
    getWardrobeSelection: () => wardrobeSelection,
    setWardrobeMessage: (m) => { wardrobeMessage = String(m || ""); },
  };
}

export default { createOverlay };

