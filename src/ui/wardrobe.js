// ui/wardrobe.js — the Wardrobe screen: buy, equip, and unequip cosmetic Hats.
//
// Split in the same spirit as ui/shop.js + systems/economy.js: the HAT LOGIC
// (catalog, buy/equip/unequip validation) is pure and operates on plain-object
// SaveData plus the frozen CONFIG, so it is testable headlessly with no DOM.
// Only {@link drawWardrobe} touches a Canvas context, and it is fully guarded so
// importing or calling it in a non-browser context never throws.
//
// Hats are purely cosmetic (Req 8.9, 8.13): none of these functions touch
// stats, powers, physics, the Hitbox, scores, or rewards — they only move
// Candy, `ownedHats`, and `equippedHat` on SaveData. Prices and hat ids flow in
// from config.hats (the single source of Hat truth, Req 8.8); no price is ever
// hardcoded here. The implicit free "no-hat" default is {@link NONE_HAT} from
// save.js, which is always owned and is the safe equipped default.
//
// Core guarantees:
//   - Buying a Hat already owned is rejected, Candy unchanged (Req 8.10).
//   - Buying a Hat the Player can't afford is rejected, Candy AND ownership
//     unchanged (Req 8.12); Candy can never go negative.
//   - A successful buy deducts exactly the configured price and adds the Hat to
//     `ownedHats` (Req 8.8).
//   - Equipping/unequipping an owned Hat costs no Candy; equipping an unowned
//     Hat is rejected (Req 8.11).

import { NONE_HAT, knownHatIds } from '../save.js';

/**
 * Human-readable display names for the four purchasable Hats, keyed by the hat
 * id used in config.hats and SaveData.ownedHats. {@link NONE_HAT} renders as the
 * free default appearance. Names are presentation only — the ids are canonical.
 * @readonly
 */
export const HAT_NAMES = Object.freeze({
  [NONE_HAT]: 'No Hat',
  witchHat: 'Witch Hat',
  pumpkinCap: 'Pumpkin Cap',
  batBonnet: 'Bat Bonnet',
  hauntedCrown: 'Haunted Crown',
});

/**
 * Stable rejection reason codes returned by {@link buyHat} / {@link equipHat}
 * when `ok` is false, mirroring economy.js's PurchaseReason convention so
 * callers can switch without magic strings and tests can assert against them.
 * @readonly
 * @enum {string}
 */
export const HatReason = Object.freeze({
  UNKNOWN_HAT: 'unknown_hat',
  ALREADY_OWNED: 'already_owned',
  UNAFFORDABLE: 'unaffordable',
  NOT_OWNED: 'not_owned',
});

/**
 * Build the Wardrobe catalog for the current config (Req 8.8): one row per
 * purchasable Hat plus the free no-hat default, each carrying the live
 * owned/equipped/affordable state derived from the given SaveData so the view
 * and any test share one source of truth.
 *
 * Each row carries:
 *   - id          the hat id ('none' | 'witchHat' | 'pumpkinCap' | ...)
 *   - name        the human-readable display name
 *   - price       Candy cost (0 for the free no-hat default)
 *   - free        true for the no-hat default (always owned, costs nothing)
 *   - owned       whether the Player already owns this Hat
 *   - equipped    whether this Hat is currently equipped
 *   - affordable  whether Candy >= price (always true for the free default)
 *   - buyable     not owned AND affordable — exactly when `buyHat` would succeed
 *
 * @param {object} save the SaveData (candy, ownedHats, equippedHat)
 * @param {object} config the frozen CONFIG
 * @returns {Array<{ id: string, name: string, price: number, free: boolean, owned: boolean, equipped: boolean, affordable: boolean, buyable: boolean }>}
 */
export function hatCatalog(save, config) {
  const candy = save && typeof save.candy === 'number' ? save.candy : 0;
  const owned = new Set(
    save && Array.isArray(save.ownedHats) ? save.ownedHats : [NONE_HAT],
  );
  owned.add(NONE_HAT); // the free default is always owned
  const equippedHat = save && typeof save.equippedHat === 'string' ? save.equippedHat : NONE_HAT;
  const hats = (config && config.hats) || {};

  // Order: the free default first, then the four Hats in config declaration order.
  const ids = [NONE_HAT, ...Object.keys(hats)];

  return ids.map((id) => {
    const free = id === NONE_HAT;
    const price = free ? 0 : hats[id];
    const isOwned = owned.has(id);
    const affordable = free || candy >= price;
    return {
      id,
      name: HAT_NAMES[id] || id,
      price,
      free,
      owned: isOwned,
      equipped: equippedHat === id,
      affordable,
      buyable: !isOwned && affordable,
    };
  });
}

/**
 * Attempt to buy the Hat `hatId` for the given SaveData (Req 8.8, 8.10, 8.12).
 * The Wardrobe's only Candy-spending path and its safety barrier.
 *
 * Validation order (every check happens BEFORE any state change, so a rejected
 * buy leaves Candy AND ownership exactly as they were):
 *   1. unknown hat id            → reject (UNKNOWN_HAT)
 *   2. already owned             → reject (ALREADY_OWNED), Candy unchanged
 *   3. not enough Candy          → reject (UNAFFORDABLE); never deducts, so
 *                                  Candy can never go negative
 * Only once all pass does it deduct exactly the configured price and append the
 * Hat to `ownedHats`. Equipping is a separate, free step ({@link equipHat}).
 *
 * The SaveData is mutated in place and also returned, matching economy.js's
 * `purchase`. Returns `{ save, ok, reason }`: `reason` is a {@link HatReason}
 * on rejection, null on success.
 *
 * @param {object} save the SaveData (candy, ownedHats)
 * @param {string} hatId the hat id to buy
 * @param {object} config the frozen CONFIG
 * @returns {{ save: object, ok: boolean, reason: (string|null) }}
 */
export function buyHat(save, hatId, config) {
  const hats = (config && config.hats) || {};

  // 1. Unknown hat — the free default and ids absent from config.hats are not
  //    purchasable. Nothing to do, nothing changed.
  if (hatId === NONE_HAT || !Object.prototype.hasOwnProperty.call(hats, hatId)) {
    return { save, ok: false, reason: HatReason.UNKNOWN_HAT };
  }

  if (!Array.isArray(save.ownedHats)) {
    save.ownedHats = [NONE_HAT];
  }

  // 2. Already owned — reject, Candy unchanged (Req 8.10).
  if (save.ownedHats.includes(hatId)) {
    return { save, ok: false, reason: HatReason.ALREADY_OWNED };
  }

  // 3. Affordability — checked before any deduction so a rejected buy leaves
  //    Candy and ownership unchanged (Req 8.12) and Candy never goes negative.
  const price = hats[hatId];
  const candy = typeof save.candy === 'number' ? save.candy : 0;
  if (candy < price) {
    return { save, ok: false, reason: HatReason.UNAFFORDABLE };
  }

  // --- All validations passed: apply exactly one buy. ---
  save.candy = candy - price;
  save.ownedHats.push(hatId);

  return { save, ok: true, reason: null };
}

/**
 * Equip the Hat `hatId` on the given SaveData at no Candy cost (Req 8.11). The
 * free no-hat default and any owned Hat may be equipped; equipping a Hat the
 * Player does not own is rejected and leaves `equippedHat` unchanged.
 *
 * Mutates and returns SaveData. Returns `{ save, ok, reason }` with a
 * {@link HatReason} on rejection, null on success.
 *
 * @param {object} save the SaveData (ownedHats, equippedHat)
 * @param {string} hatId the hat id to equip ('none' unequips)
 * @param {object} [config] the frozen CONFIG (validates the id is known)
 * @returns {{ save: object, ok: boolean, reason: (string|null) }}
 */
export function equipHat(save, hatId, config) {
  const known = new Set(knownHatIds(config));

  // Unknown id (not in config.hats and not the free default) → reject.
  if (!known.has(hatId)) {
    return { save, ok: false, reason: HatReason.UNKNOWN_HAT };
  }

  const owned = Array.isArray(save.ownedHats) ? save.ownedHats : [NONE_HAT];

  // The free default is always equippable (it unequips any worn Hat); any
  // other Hat must be owned (Req 8.11). Equipping is always free.
  if (hatId !== NONE_HAT && !owned.includes(hatId)) {
    return { save, ok: false, reason: HatReason.NOT_OWNED };
  }

  save.equippedHat = hatId;
  return { save, ok: true, reason: null };
}

/**
 * Unequip any worn Hat, returning Ghosty to the free no-hat default (Req 8.11).
 * A convenience wrapper over {@link equipHat} with {@link NONE_HAT}; always
 * succeeds and costs no Candy.
 *
 * @param {object} save the SaveData
 * @param {object} [config] the frozen CONFIG
 * @returns {{ save: object, ok: boolean, reason: (string|null) }}
 */
export function unequipHat(save, config) {
  return equipHat(save, NONE_HAT, config);
}

/**
 * Map a {@link HatReason} to a short player-facing message so a rejected
 * buy/equip can be explained legibly in the Wardrobe. Returns '' on success
 * (null reason). Pure.
 * @param {string|null} reason a HatReason value, or null
 * @returns {string}
 */
export function hatMessage(reason) {
  switch (reason) {
    case HatReason.ALREADY_OWNED:
      return 'You already own that hat.';
    case HatReason.UNAFFORDABLE:
      return 'Not enough Candy.';
    case HatReason.NOT_OWNED:
      return "You don't own that hat yet.";
    case HatReason.UNKNOWN_HAT:
      return 'That hat is unavailable.';
    default:
      return '';
  }
}

// --- Palette (shared feel with menu.js / shop.js) ---------------------------

const WARDROBE = {
  skyTop: '#1f0f3a',
  skyBottom: '#3a1a52',
  panel: 'rgba(16, 7, 32, 0.78)',
  rowEdge: 'rgba(167, 97, 59, 0.45)',
  text: '#efe6ff',
  textDim: '#d8c6ff',
  candy: '#ff9ecb',
  affordable: '#8ad17f',
  unaffordable: '#e06a6a',
  owned: '#8ad17f',
  equipped: '#ffd86b',
  disabled: '#8a7aa6',
};

/**
 * Draw the Wardrobe screen (Req 8.8, 8.11). Fully guarded: a no-op when the
 * context is absent/unusable.
 *
 * Shows, in the soft illustrated Halloween style:
 *   - the persistent Candy balance (shown distinctly from Soul_Coins),
 *   - one row per Hat (the free default first) with its name, price, and its
 *     owned / equipped / affordable state conveyed by TEXT as well as color
 *     (Req 12.7), so nothing relies on color alone,
 *   - a back prompt to return to the Main Menu.
 *
 * Purely presentational — it reads SaveData through {@link hatCatalog} and never
 * mutates it; buy/equip happen through the pure functions above.
 *
 * @param {CanvasRenderingContext2D|null|undefined} ctx the 2D context
 * @param {object|null|undefined} save the SaveData
 * @param {object} config the frozen CONFIG
 * @returns {void}
 */
export function drawWardrobe(ctx, save, config) {
  if (!ctx || typeof ctx.fillRect !== 'function') return;

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
  sky.addColorStop(0, WARDROBE.skyTop);
  sky.addColorStop(1, WARDROBE.skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // Title.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = WARDROBE.text;
  ctx.font = "700 36px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText('Wardrobe', width / 2, height * 0.12);

  // Candy balance (distinct currency label from Soul_Coins).
  const candy = save && typeof save.candy === 'number' ? save.candy : 0;
  ctx.fillStyle = WARDROBE.candy;
  ctx.font = "600 22px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(`Candy: ${candy}`, width / 2, height * 0.17);

  // Hat rows.
  const rows = hatCatalog(save, config);
  const panelX = width * 0.12;
  const panelW = width * 0.76;
  const rowH = 58;
  const startY = height * 0.24;

  ctx.textBaseline = 'middle';
  rows.forEach((row, i) => {
    const y = startY + i * (rowH + 8);

    // Row panel.
    ctx.fillStyle = WARDROBE.panel;
    ctx.fillRect(panelX, y, panelW, rowH);
    ctx.strokeStyle = WARDROBE.rowEdge;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(panelX, y, panelW, rowH);

    // Name.
    ctx.textAlign = 'left';
    ctx.fillStyle = WARDROBE.text;
    ctx.font = "600 18px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(`${i + 1}. ${row.name}`, panelX + 16, y + 20);

    // Ownership / price line — text so it is readable without color.
    ctx.fillStyle = WARDROBE.textDim;
    ctx.font = "500 14px 'Segoe UI', system-ui, sans-serif";
    let subText;
    if (row.free) {
      subText = 'Free default';
    } else if (row.owned) {
      subText = 'Owned';
    } else {
      subText = `${row.price} Candy`;
    }
    ctx.fillText(subText, panelX + 16, y + 40);

    // Status (text + color — never color alone, Req 12.7).
    let statusText;
    let statusColor;
    if (row.equipped) {
      statusText = 'Equipped';
      statusColor = WARDROBE.equipped;
    } else if (row.owned) {
      statusText = 'Owned';
      statusColor = WARDROBE.owned;
    } else if (row.affordable) {
      statusText = 'Affordable';
      statusColor = WARDROBE.affordable;
    } else {
      statusText = 'Too costly';
      statusColor = WARDROBE.unaffordable;
    }
    ctx.textAlign = 'right';
    ctx.fillStyle = statusColor;
    ctx.font = "600 14px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(statusText, panelX + panelW - 16, y + 30);
  });

  // Back prompt.
  ctx.textAlign = 'center';
  ctx.fillStyle = WARDROBE.textDim;
  ctx.font = "500 16px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText('Press Esc to return to the menu', width / 2, height * 0.95);

  ctx.restore();
}

export default {
  drawWardrobe,
  hatCatalog,
  buyHat,
  equipHat,
  unequipHat,
  hatMessage,
  HAT_NAMES,
  HatReason,
};
