// ui/shop.js — the Shop_State view (thin DOM/IO module).
//
// A UI view module like ui/hud.js and ui/battle.js: it only draws to a Canvas
// 2D context handed to it, holds no gameplay state, and never mutates the
// RunState. The economy LOGIC (inventory, purchase validation, the one-charge
// shield cap, the per-run attack-upgrade limit) lives in systems/economy.js
// (pure); in-shop potion USE lives in systems/combat.js's `usePotion`. This
// module presents them.
//
// What the shop view shows (Req 7.5): for each stocked item — its effect, its
// price, the quantity owned/remaining this Run, and whether the Player can
// currently afford it — plus the Player's Soul_Coins balance and the in-shop
// potion-use affordance. "Can afford" and "remaining" are derived from the live
// RunState through the pure {@link shopRows} helper so the view and any test
// share one source of truth and the display can never disagree with what
// `purchase` would actually allow.
//
// Because this is Shop_State, using a potion here costs no combat turn and
// accrues no Candy time (Req 7.13) — that is guaranteed by combat.js's
// `usePotion(runState, null, config)`; this view only surfaces the affordance.
//
// Headless-safe: importing in a non-browser context never throws; every draw is
// guarded. The pure {@link shopRows} / {@link canUsePotion} helpers are exported
// for unit testing with no DOM.

import {
  shopInventory,
  purchasedCount,
  PurchaseReason,
} from "../systems/economy.js";

/**
 * Build the per-item rows the shop view renders (Req 7.5). Pure: derives each
 * row's live quantity, remaining-this-Run, and affordability from the RunState
 * and config, using the SAME economy helpers `purchase` uses, so the display can
 * never claim something is buyable that `purchase` would reject (or vice versa).
 *
 * Each row carries:
 *   - id            the ShopItem id ('potion' | 'shield' | 'attack_upgrade')
 *   - effectText    the human-readable effect (from economy.shopInventory)
 *   - price         Soul_Coins cost
 *   - owned         how many bought this Run (potion stacks; shield/upgrade 0|1)
 *   - maxQuantity   per-Run cap (null = uncapped)
 *   - remaining     maxQuantity - owned, or null when uncapped
 *   - atCap         true when a capped item is already maxed this Run
 *   - affordable    true when Soul_Coins >= price
 *   - buyable       affordable AND not at cap — exactly when `purchase` succeeds
 *
 * @param {object} runState the active RunState (soulCoins, items, etc.)
 * @param {object} config the frozen CONFIG
 * @returns {Array<{ id: string, effectText: string, price: number, owned: number, maxQuantity: (number|null), remaining: (number|null), atCap: boolean, affordable: boolean, buyable: boolean }>}
 */
export function shopRows(runState, config) {
  const coins = runState && typeof runState.soulCoins === "number" ? runState.soulCoins : 0;
  return shopInventory(config).map((item) => {
    const owned = runState ? purchasedCount(runState, item.id) : 0;
    const capped = item.maxQuantity != null;
    const atCap = capped && owned >= item.maxQuantity;
    const remaining = capped ? Math.max(0, item.maxQuantity - owned) : null;
    const affordable = coins >= item.price;
    return {
      id: item.id,
      effectText: item.effectText,
      price: item.price,
      owned,
      maxQuantity: item.maxQuantity,
      remaining,
      atCap,
      affordable,
      buyable: affordable && !atCap,
    };
  });
}

/**
 * Whether the in-shop "Use Potion" affordance should be enabled (Req 7.14): the
 * Player must own at least one potion AND be below the Run maximum Battle_HP.
 * Mirrors combat.js's `usePotion` no-op conditions so the button's enabled state
 * matches exactly what a use would do. Pure, DOM-free.
 *
 * @param {object} runState the active RunState
 * @returns {boolean}
 */
export function canUsePotion(runState) {
  if (!runState) return false;
  const owned = runState.items ? runState.items.potion : 0;
  if (!owned || owned <= 0) return false;
  return runState.battleHp < runState.maxBattleHp;
}

/**
 * Map a {@link PurchaseReason} to a short player-facing message, so a rejected
 * purchase can be explained legibly in the shop. Returns '' for a successful
 * purchase (null reason). Pure.
 * @param {string|null} reason a PurchaseReason value, or null
 * @returns {string}
 */
export function purchaseMessage(reason) {
  switch (reason) {
    case PurchaseReason.UNAFFORDABLE:
      return "Not enough Soul Coins.";
    case PurchaseReason.SHIELD_AT_CAP:
      return "Shield already at full charge.";
    case PurchaseReason.ATTACK_LIMIT_REACHED:
      return "Attack upgrade already purchased this Run.";
    case PurchaseReason.UNKNOWN_ITEM:
      return "That item is unavailable.";
    default:
      return "";
  }
}

// --- Palette (shared feel with render.js / battle.js) -----------------------

const SHOP = {
  skyTop: "#1f0f3a",
  skyBottom: "#3a1a52",
  panel: "rgba(16, 7, 32, 0.78)",
  panelEdge: "rgba(167, 97, 59, 0.85)",
  rowEdge: "rgba(167, 97, 59, 0.45)",
  text: "#efe6ff",
  textDim: "#d8c6ff",
  coin: "#ffd86b",
  affordable: "#8ad17f",
  unaffordable: "#e06a6a",
  disabled: "#8a7aa6",
};

/**
 * Draw the Shop_State view (Req 7.5). Fully guarded: a no-op when the context is
 * absent/unusable or there is no RunState.
 *
 * Shows, in the soft illustrated Halloween style:
 *   - the Soul_Coins balance (shown distinctly from Candy/Pipe_Score),
 *   - one row per stocked item with its effect, price, owned/remaining, and an
 *     affordability/at-cap indicator conveyed by TEXT as well as color (Req 12.7),
 *   - the in-shop Use Potion affordance with its enabled/disabled state,
 *   - a continue/leave prompt.
 *
 * @param {CanvasRenderingContext2D|null|undefined} ctx the 2D context
 * @param {object|null|undefined} runState the active RunState
 * @param {object} config the frozen CONFIG
 * @returns {void}
 */
export function drawShop(ctx, runState, config) {
  if (!ctx || typeof ctx.fillRect !== "function") return;
  if (!runState) return;

  const width =
    (config && config.playfield && config.playfield.width) ||
    (ctx.canvas && ctx.canvas.width) ||
    960;
  const height =
    (config && config.playfield && config.playfield.height) ||
    (ctx.canvas && ctx.canvas.height) ||
    640;

  ctx.save();

  // Backdrop.
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, SHOP.skyTop);
  sky.addColorStop(1, SHOP.skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // Title.
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = SHOP.text;
  ctx.font = "700 36px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText("Haunted Shop", width / 2, height * 0.12);

  // Soul_Coins balance (distinct currency label, Req 12 presentation).
  ctx.fillStyle = SHOP.coin;
  ctx.font = "600 22px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(`Soul Coins: ${runState.soulCoins}`, width / 2, height * 0.17);

  // Item rows.
  const rows = shopRows(runState, config);
  const panelX = width * 0.12;
  const panelW = width * 0.76;
  const rowH = 64;
  const startY = height * 0.24;

  ctx.textBaseline = "middle";
  rows.forEach((row, i) => {
    const y = startY + i * (rowH + 10);

    // Row panel.
    ctx.fillStyle = SHOP.panel;
    ctx.fillRect(panelX, y, panelW, rowH);
    ctx.strokeStyle = SHOP.rowEdge;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(panelX, y, panelW, rowH);

    // Item number + effect.
    ctx.textAlign = "left";
    ctx.fillStyle = SHOP.text;
    ctx.font = "600 18px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(`${i + 1}. ${row.effectText}`, panelX + 16, y + 22);

    // Quantity owned / remaining — text so it is readable without color.
    ctx.fillStyle = SHOP.textDim;
    ctx.font = "500 14px 'Segoe UI', system-ui, sans-serif";
    const qtyText =
      row.maxQuantity == null
        ? `Owned: ${row.owned}`
        : `Owned: ${row.owned} / ${row.maxQuantity}`;
    ctx.fillText(qtyText, panelX + 16, y + 44);

    // Price.
    ctx.textAlign = "right";
    ctx.fillStyle = SHOP.coin;
    ctx.font = "600 18px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(`${row.price} SC`, panelX + panelW - 16, y + 22);

    // Status (text + color — never color alone, Req 12.7).
    let statusText;
    let statusColor;
    if (row.atCap) {
      statusText = "Maxed";
      statusColor = SHOP.disabled;
    } else if (row.affordable) {
      statusText = "Affordable";
      statusColor = SHOP.affordable;
    } else {
      statusText = "Too costly";
      statusColor = SHOP.unaffordable;
    }
    ctx.fillStyle = statusColor;
    ctx.font = "600 14px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(statusText, panelX + panelW - 16, y + 44);
  });

  // In-shop Use Potion affordance (Req 7.13, 7.14).
  const potionEnabled = canUsePotion(runState);
  const owned = runState.items ? runState.items.potion : 0;
  ctx.textAlign = "center";
  ctx.font = "600 16px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = potionEnabled ? SHOP.affordable : SHOP.disabled;
  const potionText = potionEnabled
    ? `Press U to use a Potion (${owned} owned)`
    : owned > 0
      ? "Potion: already at full Battle HP"
      : "Potion: none owned";
  ctx.fillText(potionText, width / 2, height * 0.9);

  // Leave prompt.
  ctx.fillStyle = SHOP.textDim;
  ctx.font = "500 16px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText("Press Enter to leave the shop", width / 2, height * 0.95);

  ctx.restore();
}

export default { drawShop, shopRows, canUsePotion, purchaseMessage };
