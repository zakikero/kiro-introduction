// State-scoped HTML controls. Nodes stay mounted so animation-frame updates
// cannot remove a pressed/focused button between pointerdown and click.
import { States } from "../state.js";
import { hatCatalog, HAT_NAMES } from "./wardrobe.js";
import { shopRows, canUsePotion } from "./shop.js";
import { PLAYER_SPRITES } from "../appearance.js";
import { drawGhostyPreview } from "../render.js";

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value != null) node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child != null) node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

const STATE_PANEL = {
  [States.Main_Menu_State]: "menu",
  [States.Results_State]: "results",
  [States.Pause_State]: "pause",
  [States.Wardrobe]: "wardrobe",
  [States.Shop_State]: "shop",
};

export function createOverlay(opts) {
  if (typeof document === "undefined" || !opts || !opts.root) {
    return {
      sync() {}, destroy() {}, selectByIndex() {}, selectShopByIndex() {},
      isActive: () => false, getWardrobeSelection: () => "none",
      setWardrobeMessage() {},
    };
  }
  const { root, fsm, getSave, config, actions } = opts;
  let wardrobeSelection = "none";
  let wardrobeMessage = "";
  let shopSelection = null;
  let shopMessage = "";
  let lastShown = null;
  const panels = {};
  const container = el("div", { class: "kiro-overlay", hidden: "hidden" });
  root.appendChild(container);

  function invoke(name, ...args) {
    if (typeof actions[name] !== "function") return false;
    const result = actions[name](...args);
    sync();
    return result;
  }
  function button(label, action, primary = false) {
    return el("button", {
      class: "kiro-btn" + (primary ? " kiro-primary" : ""),
      type: "button", onclick: action,
    }, label);
  }

  const howTo = el("div", { class: "kiro-howto", id: "kiro-howto", hidden: "hidden" }, [
    el("p", { text: "Space or click the playfield to flap. E uses an available spirit flight power." }),
    el("p", { text: "P or Escape pauses. Q while paused ends the run." }),
    el("p", { text: "In battle: 1 Attack, 2 Defend, 3 Item, 4 Spirit. Choose optional encounters and reach the Final Boss." }),
  ]);
  const howToButton = button("How to Play", () => {
    howTo.hidden = !howTo.hidden;
    howToButton.setAttribute("aria-expanded", String(!howTo.hidden));
  });
  howToButton.setAttribute("aria-controls", "kiro-howto");
  howToButton.setAttribute("aria-expanded", "false");
  const muteCb = el("input", { type: "checkbox", id: "kiro-mute" });
  muteCb.addEventListener("change", () => invoke("setMuted", Boolean(muteCb.checked)));
  const motionCb = el("input", { type: "checkbox", id: "kiro-motion" });
  motionCb.addEventListener("change", () => invoke("setReducedMotion", Boolean(motionCb.checked)));
  const fileInput = el("input", { type: "file", accept: "application/json,.json", hidden: "hidden" });
  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) invoke("importProgress", file);
    fileInput.value = "";
  });
  const menuStats = el("p", { class: "kiro-stats" });
  const menuMessage = el("p", { class: "kiro-msg", role: "status" });
  const start = button("Start Adventure", () => {
    if (fsm.state === States.Main_Menu_State) invoke("startRun");
  }, true);
  start.setAttribute("data-first", "1");
  panels.menu = el("div", { class: "kiro-panel kiro-menu", role: "dialog", "aria-label": "Main menu" }, [
    el("h2", { text: "Kiro's Haunted Flight" }), menuStats,
    el("div", { class: "kiro-actions" }, [
      start, button("Wardrobe", () => invoke("openWardrobe")), howToButton,
    ]),
    howTo,
    el("div", { class: "kiro-progress" }, [
      el("h3", { text: "Progress & Settings" }),
      el("div", { class: "kiro-settings-row" }, [
        el("label", {}, [muteCb, el("span", { text: "Mute audio" })]),
        el("label", {}, [motionCb, el("span", { text: "Reduced motion" })]),
      ]),
      el("div", { class: "kiro-settings-row" }, [
        button("Export Save", () => invoke("exportProgress")),
        button("Import Save", () => fileInput.click()),
        button("Fullscreen", () => invoke("toggleFullscreen")), fileInput,
      ]),
    ]), menuMessage,
  ]);

  const resultsTitle = el("h2", { text: "Results" });
  const resultsStats = el("p", { class: "kiro-stats" });
  panels.results = el("div", { class: "kiro-panel kiro-results", role: "dialog", "aria-label": "Run results" }, [
    resultsTitle, resultsStats,
    el("div", { class: "kiro-actions" }, [
      button("Restart", () => invoke("restart"), true),
      button("Main Menu", () => invoke("toMainMenu")),
      button("Wardrobe", () => invoke("openWardrobe")),
    ]),
  ]);
  panels.pause = el("div", { class: "kiro-panel kiro-pause", role: "dialog", "aria-label": "Paused" }, [
    el("h2", { text: "Paused" }),
    el("div", { class: "kiro-actions" }, [
      button("Resume", () => invoke("resume"), true),
      button("End Run", () => invoke("endRun")),
    ]),
  ]);

  // The preview has its own canvas beside the choices; it is never painted
  // behind the controls on the world canvas.
  const wardrobeCandy = el("p", { class: "kiro-stats" });
  const previewCanvas = el("canvas", {
    class: "kiro-preview", id: "kiro-wardrobe-preview", width: "320", height: "360",
    "aria-label": "Preview of the selected hat on Ghosty",
  });
  const previewName = el("h3");
  const previewStatus = el("p", { class: "kiro-preview-status" });
  const wardrobeCards = el("div", { class: "kiro-cards", role: "group", "aria-label": "Hat choices" });
  const wardrobeMessageEl = el("p", { class: "kiro-msg", role: "status" });
  const wardrobeReason = el("p", { class: "kiro-reason" });
  const equippedNotice = el("span", { class: "kiro-equipped-note", text: "Equipped" });
  const wardrobeCardNodes = new Map();

  const buyHatButton = button("Buy", () => {
    if (fsm.state !== States.Wardrobe) return;
    const row = hatCatalog(getSave(), config).find((item) => item.id === wardrobeSelection);
    if (!row || !row.buyable) return;
    const ok = actions.buyHat(row.id);
    wardrobeMessage = ok ? "Bought " + row.name + ". Choose Equip to wear it." : "Could not buy this hat.";
    sync();
    if (ok) equipHatButton.focus();
  }, true);
  const equipHatButton = button("Equip", () => {
    if (fsm.state !== States.Wardrobe) return;
    const row = hatCatalog(getSave(), config).find((item) => item.id === wardrobeSelection);
    if (!row || !row.owned || row.equipped) return;
    const ok = actions.equipHat(row.id);
    wardrobeMessage = ok ? "Equipped " + row.name + "." : "Could not equip this hat.";
    sync();
    if (ok) wardrobeCardNodes.get(row.id).card.focus();
  }, true);
  panels.wardrobe = el("div", { class: "kiro-panel kiro-wardrobe", role: "dialog", "aria-label": "Wardrobe" }, [
    el("h2", { text: "Wardrobe" }), wardrobeCandy,
    el("div", { class: "kiro-wardrobe-layout" }, [
      el("aside", { class: "kiro-preview-wrap" }, [
        previewCanvas, previewName, previewStatus,
        el("p", { class: "kiro-preview-hint", text: "Selecting previews a look. Buy unlocks it; Equip puts it on." }),
      ]),
      el("div", { class: "kiro-wardrobe-options" }, [
        wardrobeCards, wardrobeReason,
        el("div", { class: "kiro-actions" }, [
          buyHatButton, equipHatButton, equippedNotice,
          button("Back to Menu", () => invoke("leaveWardrobe")),
        ]), wardrobeMessageEl,
      ]),
    ]),
  ]);

  function renderWardrobe() {
    const save = getSave();
    const rows = hatCatalog(save, config);
    if (!rows.some((row) => row.id === wardrobeSelection)) wardrobeSelection = "none";
    wardrobeCandy.textContent = "Candy: " + save.candy + " | Equipped: " + (HAT_NAMES[save.equippedHat] || save.equippedHat);
    rows.forEach((row, index) => {
      let nodes = wardrobeCardNodes.get(row.id);
      if (!nodes) {
        const name = el("span", { class: "kiro-card-name" });
        const status = el("span", { class: "kiro-card-status" });
        const image = el("img", { class: "kiro-card-art", src: "assets/" + PLAYER_SPRITES[row.id], alt: "", loading: "lazy" });
        image.addEventListener("error", () => { image.hidden = true; });
        const card = el("button", {
          class: "kiro-card", type: "button", "data-hat": row.id,
          onclick: () => {
            if (fsm.state !== States.Wardrobe) return;
            wardrobeSelection = row.id;
            wardrobeMessage = "";
            renderWardrobe();
          },
        }, [image, name, status]);
        nodes = { card, name, status };
        wardrobeCardNodes.set(row.id, nodes);
        wardrobeCards.appendChild(card);
      }
      const selected = row.id === wardrobeSelection;
      nodes.card.classList.toggle("kiro-selected", selected);
      nodes.card.classList.toggle("kiro-equipped", row.equipped);
      nodes.card.setAttribute("aria-pressed", String(selected));
      nodes.name.textContent = (index + 1) + ". " + row.name;
      nodes.status.textContent = row.equipped ? "Equipped" : row.owned ? "Owned" : row.price + " Candy";
    });
    const selected = rows.find((row) => row.id === wardrobeSelection);
    const need = Math.max(0, selected.price - save.candy);
    buyHatButton.hidden = selected.owned;
    buyHatButton.disabled = !selected.buyable;
    buyHatButton.textContent = "Buy for " + selected.price + " Candy";
    equipHatButton.hidden = !selected.owned || selected.equipped;
    equipHatButton.textContent = selected.free ? "Equip (remove hat)" : "Equip";
    equippedNotice.hidden = !selected.equipped;
    wardrobeReason.textContent = !selected.owned && need > 0 ? "Need " + need + " more Candy" : "";
    previewName.textContent = selected.name;
    previewStatus.textContent = selected.equipped ? "Currently equipped" : "Preview only";
    wardrobeMessageEl.textContent = wardrobeMessage;
  }

  function paintPreview() {
    try {
      const ctx = previewCanvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
      drawGhostyPreview(ctx, previewCanvas.width / 2, 230, 110, wardrobeSelection, null);
    } catch { /* A missing canvas must not prevent menu interaction. */ }
  }

  const shopCoins = el("p", { class: "kiro-stats" });
  const shopCards = el("div", { class: "kiro-cards", role: "group", "aria-label": "Shop items" });
  const shopReason = el("p", { class: "kiro-reason" });
  const shopMessageEl = el("p", { class: "kiro-msg", role: "status" });
  const shopCardNodes = new Map();
  const buyItemButton = button("Buy", () => {
    if (fsm.state !== States.Shop_State || !fsm.runState) return;
    const row = shopRows(fsm.runState, config).find((item) => item.id === shopSelection);
    if (!row || !row.buyable) return;
    const ok = actions.buyItem(row.id);
    shopMessage = ok ? "Bought " + row.effectText + "." : "Could not buy this item.";
    sync();
  }, true);
  const usePotionButton = button("Use Potion", () => {
    if (fsm.state !== States.Shop_State || !canUsePotion(fsm.runState)) return;
    const ok = actions.usePotion();
    shopMessage = ok ? "Used a potion." : "Could not use a potion.";
    sync();
  });
  panels.shop = el("div", { class: "kiro-panel kiro-shop", role: "dialog", "aria-label": "Haunted shop" }, [
    el("h2", { text: "Haunted Shop" }), shopCoins, shopCards, shopReason,
    el("div", { class: "kiro-actions" }, [
      buyItemButton, usePotionButton, button("Leave Shop", () => invoke("leaveShop")),
    ]), shopMessageEl,
  ]);

  function renderShop() {
    const run = fsm.runState;
    if (!run) return;
    const rows = shopRows(run, config);
    if (!rows.some((row) => row.id === shopSelection)) shopSelection = rows[0] && rows[0].id;
    shopCoins.textContent = "Soul Coins: " + run.soulCoins + " | Battle HP: " + Math.round(run.battleHp) + "/" + run.maxBattleHp + " | Potions: " + (run.items.potion || 0);
    rows.forEach((row, index) => {
      let nodes = shopCardNodes.get(row.id);
      if (!nodes) {
        const name = el("span", { class: "kiro-card-name" });
        const status = el("span", { class: "kiro-card-status" });
        const card = el("button", {
          class: "kiro-card", type: "button", "data-item": row.id,
          onclick: () => {
            if (fsm.state !== States.Shop_State) return;
            shopSelection = row.id;
            shopMessage = "";
            renderShop();
          },
        }, [name, status]);
        nodes = { card, name, status };
        shopCardNodes.set(row.id, nodes);
        shopCards.appendChild(card);
      }
      const selected = row.id === shopSelection;
      nodes.card.classList.toggle("kiro-selected", selected);
      nodes.card.setAttribute("aria-pressed", String(selected));
      nodes.name.textContent = (index + 1) + ". " + row.effectText;
      nodes.status.textContent = row.price + " SC | Owned " + row.owned + (row.atCap ? " | At limit" : "");
    });
    const selected = rows.find((row) => row.id === shopSelection);
    buyItemButton.disabled = !selected || !selected.buyable;
    buyItemButton.textContent = selected ? "Buy (" + selected.price + " SC)" : "Buy";
    shopReason.textContent = !selected || selected.buyable ? "" : selected.atCap ? "Already at the limit this run" : "Not enough Soul Coins";
    usePotionButton.disabled = !canUsePotion(run);
    usePotionButton.title = usePotionButton.disabled ? run.items.potion > 0 ? "Already at full Battle HP" : "No potion owned" : "Restore Battle HP (U)";
    shopMessageEl.textContent = shopMessage;
  }

  // Only actual screen panels belong here. Re-appending nested help/settings
  // would detach them from the menu and leave them visible during gameplay.
  for (const panel of Object.values(panels)) {
    panel.hidden = true;
    container.appendChild(panel);
  }

  function sync() {
    const active = STATE_PANEL[fsm.state] || null;
    const entering = active !== lastShown;
    if (entering) {
      howTo.hidden = true;
      howToButton.setAttribute("aria-expanded", "false");
      if (active === "wardrobe") {
        wardrobeSelection = getSave().equippedHat || "none";
        wardrobeMessage = "";
      }
      if (active === "shop") { shopSelection = null; shopMessage = ""; }
    }
    for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== active;
    container.hidden = !active;
    container.classList.toggle("kiro-active", Boolean(active));

    if (active === "menu") {
      const save = getSave();
      menuStats.textContent = "High Score: " + save.highScore + " | Candy: " + save.candy + " | Hat: " + (HAT_NAMES[save.equippedHat] || save.equippedHat);
      muteCb.checked = Boolean(save.prefs && save.prefs.muted);
      motionCb.checked = Boolean(save.prefs && save.prefs.reducedMotion);
    } else if (active === "results") {
      const save = getSave();
      resultsTitle.textContent = save.__lastOutcome === "victory" ? "Victory!" : "Results";
      resultsStats.textContent = save.__resultsLine || "";
    } else if (active === "wardrobe") {
      renderWardrobe();
      paintPreview();
    } else if (active === "shop") renderShop();

    if (entering) {
      const target = active === "wardrobe"
        ? wardrobeCardNodes.get(wardrobeSelection)?.card
        : active ? panels[active].querySelector("button") : root.querySelector("#game-canvas");
      if (target && typeof target.focus === "function") {
        try { target.focus({ preventScroll: true }); } catch { target.focus(); }
      }
    }
    lastShown = active;
  }

  function onKeydown(event) {
    if (!STATE_PANEL[fsm.state]) return;
    const target = event.target;
    const nativeControl = target && ["BUTTON", "INPUT", "LABEL"].includes(target.tagName);
    if (nativeControl && (event.code === "Space" || event.code === "Enter")) {
      event.stopPropagation();
      if (event.repeat) event.preventDefault();
    }
    if (event.code === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (fsm.state === States.Wardrobe) invoke("leaveWardrobe");
      else if (fsm.state === States.Shop_State) invoke("leaveShop");
      else if (fsm.state === States.Pause_State) invoke("resume");
      else {
        howTo.hidden = true;
        howToButton.setAttribute("aria-expanded", "false");
      }
    }
  }
  container.addEventListener("keydown", onKeydown);

  return {
    sync,
    isActive: () => Boolean(STATE_PANEL[fsm.state]),
    getWardrobeSelection: () => wardrobeSelection,
    selectByIndex(index) {
      if (fsm.state !== States.Wardrobe) return;
      const row = hatCatalog(getSave(), config)[index];
      if (row) {
        wardrobeSelection = row.id; wardrobeMessage = ""; renderWardrobe();
        wardrobeCardNodes.get(row.id)?.card.focus();
      }
    },
    selectShopByIndex(index) {
      if (fsm.state !== States.Shop_State || !fsm.runState) return;
      const row = shopRows(fsm.runState, config)[index];
      if (row) {
        shopSelection = row.id; shopMessage = ""; renderShop();
        shopCardNodes.get(row.id)?.card.focus();
      }
    },
    setWardrobeMessage(message) {
      wardrobeMessage = String(message || "");
      wardrobeMessageEl.textContent = wardrobeMessage;
      menuMessage.textContent = wardrobeMessage;
    },
    destroy() {
      container.removeEventListener("keydown", onKeydown);
      if (container.parentNode) container.parentNode.removeChild(container);
    },
  };
}

export default { createOverlay };
