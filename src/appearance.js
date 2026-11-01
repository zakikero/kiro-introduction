// appearance.js — the SHARED, pure Ghosty-appearance resolver.
//
// One source of truth for "what images make up Ghosty right now", used by the
// wardrobe preview, the main-menu preview, flight rendering, and the battle
// scene so they can never disagree (prompt §3). It is PURE and DOM-free: it
// maps a saved `equippedHat` and a transient `equippedSpirit` to a small plain
// descriptor of which sprite(s) to draw and how to align them, reading the
// baked-in manifest geometry. It loads no images and touches no Canvas; the
// thin views (render.js / ui/*) consume the descriptor and do the drawing via
// the cached loader in assets.js.
//
// Rules it encodes (from assets/README.md + the manifest bindings):
//   - UNPOSSESSED: draw the ONE whole swappable Ghosty sprite for the saved hat
//     id (ghosty_base.png for 'none', else ghosty_<hat>.png). The equipped
//     sprites already CONTAIN the hat, so no separate hat is layered on top and
//     no second body is drawn underneath.
//   - POSSESSED: draw the whole spirit sprite INSTEAD of the normal body, then
//     add exactly one STANDALONE hat (hat_<id>.png) when a hat is equipped
//     ('none' draws no hat). Possession never changes the saved hat.
//   - Cosmetics never touch gameplay: the logical body stays 32x39 and the
//     hitbox 24x31 regardless of which sprite or hat is shown. Alignment uses
//     each sprite's body reference rect so a tall crown or wide brim never
//     shrinks Ghosty — the body reference is uniform-scaled to the logical
//     body and the whole image is drawn around it.
//
// Fallback order when an equipped sprite is unavailable (assets.js reports load
// state; this module just declares the chain): the composed spirit/hat form, or
// the whole equipped sprite, falls back to the new base PLUS its standalone hat,
// then to the legacy ghosty.png, then to a labeled placeholder — always keeping
// the saved selection. The resolver returns the PRIMARY plan plus that chain so
// the renderer can pick the first image that is actually ready.

import { NONE_HAT } from "./save.js";

/** Saved-hat id -> whole unpossessed Ghosty sprite (manifest `player_sprites`). */
export const PLAYER_SPRITES = Object.freeze({
  none: "ghosty_base.png",
  witchHat: "ghosty_witch_hat.png",
  pumpkinCap: "ghosty_pumpkin_cap.png",
  batBonnet: "ghosty_bat_bonnet.png",
  hauntedCrown: "ghosty_haunted_crown.png",
});

/** Spirit id -> whole possessed Ghosty sprite (manifest `spirits`). */
export const SPIRIT_SPRITES = Object.freeze({
  storm_bat: "spirit_storm_bat.png",
  pumpkin_guardian: "spirit_pumpkin_guardian.png",
});

/** Saved-hat id -> standalone hat sprite layered on a possessed body (manifest `hats`). */
export const STANDALONE_HATS = Object.freeze({
  witchHat: "hat_witch.png",
  pumpkinCap: "hat_pumpkin.png",
  batBonnet: "hat_bat.png",
  hauntedCrown: "hat_crown.png",
});

/** Legacy fallback body (the original supplied sprite). */
export const LEGACY_SPRITE = "ghosty.png";

// Body reference rects ([x,y,width,height] in source pixels) copied from
// assets/manifest.json. These are VISUAL alignment estimates: the resolver
// uniform-scales the reference width to the logical body width so the whole
// sprite is drawn around a stable body center, and a tall hat never resizes
// Ghosty. Refine optically in-browser if needed — gameplay geometry (32x39
// body, 24x31 hitbox) never derives from these.
const BODY_REFERENCE = Object.freeze({
  "ghosty_base.png": { natW: 1254, natH: 1254, rect: [288, 308, 671, 818] },
  "ghosty_witch_hat.png": { natW: 1254, natH: 1254, rect: [408, 530, 566, 690] },
  "ghosty_pumpkin_cap.png": { natW: 1254, natH: 1254, rect: [400, 610, 492, 600] },
  "ghosty_bat_bonnet.png": { natW: 1254, natH: 1254, rect: [359, 530, 533, 650] },
  "ghosty_haunted_crown.png": { natW: 1254, natH: 1254, rect: [400, 525, 574, 700] },
  "spirit_storm_bat.png": { natW: 1312, natH: 1199, rect: [434, 240, 629, 767] },
  "spirit_pumpkin_guardian.png": { natW: 1138, natH: 1382, rect: [212, 221, 805, 981] },
});

// Standalone-hat attachment points ([x,y] in source pixels) + suggested width
// relative to the logical body, from the manifest `hat` entries. Used only when
// layering a standalone hat on a possessed body.
const HAT_GEOMETRY = Object.freeze({
  "hat_witch.png": { natW: 1254, natH: 1254, attach: [636, 1132], widthRel: 1.15 },
  "hat_pumpkin.png": { natW: 1254, natH: 1254, attach: [600, 1130], widthRel: 1.15 },
  "hat_bat.png": { natW: 1254, natH: 1254, attach: [622, 1067], widthRel: 1.15 },
  "hat_crown.png": { natW: 1254, natH: 1254, attach: [604, 1130], widthRel: 1.15 },
});

// Spirit hat anchors ([x,y] in source pixels) — where a standalone hat sits on
// a possessed body — from the manifest `spirit` entries.
const SPIRIT_HAT_ANCHOR = Object.freeze({
  "spirit_storm_bat.png": [748, 252],
  "spirit_pumpkin_guardian.png": [615, 235],
});

/**
 * Normalize a saved hat id to a known value, defaulting to {@link NONE_HAT}.
 * @param {*} hat
 * @returns {string}
 */
function normHat(hat) {
  return typeof hat === "string" && Object.prototype.hasOwnProperty.call(PLAYER_SPRITES, hat)
    ? hat
    : NONE_HAT;
}

/**
 * Normalize a spirit id: only the two real spirits possess; anything else
 * (including 'none'/null) is base Ghosty.
 * @param {*} spirit
 * @returns {string|null}
 */
function normSpirit(spirit) {
  return typeof spirit === "string" && Object.prototype.hasOwnProperty.call(SPIRIT_SPRITES, spirit)
    ? spirit
    : null;
}

/**
 * Compute how to draw a whole sprite so its body reference rect maps onto the
 * logical body box centered at (cx, cy). Returns the destination rect for a
 * full-image draw (drawImage(img, dx, dy, dw, dh)). Uniform scale = logical
 * body width / reference width, so hat extents never change Ghosty's size.
 *
 * @param {string} file the sprite file (must be in BODY_REFERENCE)
 * @param {number} cx logical body center x
 * @param {number} cy logical body center y
 * @param {number} bodyW logical body width (e.g. 32)
 * @param {number} bodyH logical body height (e.g. 39)
 * @returns {{ dx:number, dy:number, dw:number, dh:number }|null}
 */
export function spriteDrawRect(file, cx, cy, bodyW, bodyH) {
  const meta = BODY_REFERENCE[file];
  if (!meta) return null;
  const [rx, ry, rw, rh] = meta.rect;
  // Uniform scale driven by the body reference WIDTH -> logical body width, so
  // the optical body matches 32px wide regardless of hat height (prompt §3).
  const scale = bodyW / rw;
  const dw = meta.natW * scale;
  const dh = meta.natH * scale;
  // Place the image so the reference rect's center lands on (cx, cy).
  const refCenterX = rx + rw / 2;
  const refCenterY = ry + rh / 2;
  const dx = cx - refCenterX * scale;
  const dy = cy - refCenterY * scale;
  return { dx, dy, dw, dh };
}

/**
 * Compute the destination rect for a STANDALONE hat layered onto a possessed
 * body. The hat is sized to ~widthRel * bodyW and positioned so its attachment
 * point sits at the spirit's hat anchor, mapped into the drawn spirit rect.
 *
 * @param {string} hatFile standalone hat file (in HAT_GEOMETRY)
 * @param {string} spiritFile the possessed body file (in SPIRIT_HAT_ANCHOR)
 * @param {{ dx:number, dy:number, dw:number, dh:number }} spiritRect the drawn spirit rect
 * @param {object} spiritMeta BODY_REFERENCE entry for the spirit
 * @param {number} bodyW logical body width
 * @returns {{ dx:number, dy:number, dw:number, dh:number }|null}
 */
export function standaloneHatRect(hatFile, spiritFile, spiritRect, spiritMeta, bodyW) {
  const hat = HAT_GEOMETRY[hatFile];
  const anchor = SPIRIT_HAT_ANCHOR[spiritFile];
  if (!hat || !anchor || !spiritRect || !spiritMeta) return null;
  const hatW = bodyW * hat.widthRel;
  const hatScale = hatW / hat.natW;
  const hatH = hat.natH * hatScale;
  // Where the spirit's hat anchor lands in DRAW space:
  const spiritScale = spiritRect.dw / spiritMeta.natW;
  const anchorX = spiritRect.dx + anchor[0] * spiritScale;
  const anchorY = spiritRect.dy + anchor[1] * spiritScale;
  // Place the hat so its attachment point lands on the anchor.
  const dx = anchorX - hat.attach[0] * hatScale;
  const dy = anchorY - hat.attach[1] * hatScale;
  return { dx, dy, dw: hatW, dh: hatH };
}

/**
 * Resolve the full appearance plan for a given saved hat + transient spirit.
 * PURE: returns a plain descriptor; draws nothing. The renderer walks `layers`
 * back-to-front, drawing the first ready image in each layer's `fallbacks`
 * chain (via assets.js), and uses `spriteDrawRect` / `standaloneHatRect` for
 * geometry so a missing image degrades without ever changing the hitbox.
 *
 * @param {string|null|undefined} equippedHat saved hat id
 * @param {string|null|undefined} equippedSpirit transient spirit id
 * @returns {{
 *   possessed: boolean,
 *   hat: string,
 *   spirit: (string|null),
 *   bodyFile: string,
 *   bodyFallbacks: string[],
 *   standaloneHatFile: (string|null),
 *   layers: Array<{ role: string, file: string, fallbacks: string[] }>,
 * }}
 */
export function resolveAppearance(equippedHat, equippedSpirit) {
  const hat = normHat(equippedHat);
  const spirit = normSpirit(equippedSpirit);

  if (spirit) {
    // Possessed: whole spirit body + optional standalone hat. If the spirit
    // sprite is missing, fall back to the unpossessed whole sprite for the hat.
    const bodyFile = SPIRIT_SPRITES[spirit];
    const bodyFallbacks = [bodyFile, PLAYER_SPRITES[hat], PLAYER_SPRITES.none, LEGACY_SPRITE];
    const standaloneHatFile = hat === NONE_HAT ? null : STANDALONE_HATS[hat];
    const layers = [{ role: "body", file: bodyFile, fallbacks: bodyFallbacks }];
    if (standaloneHatFile) {
      layers.push({ role: "hat", file: standaloneHatFile, fallbacks: [standaloneHatFile] });
    }
    return { possessed: true, hat, spirit, bodyFile, bodyFallbacks, standaloneHatFile, layers };
  }

  // Unpossessed: ONE whole swappable sprite that already contains the hat.
  const bodyFile = PLAYER_SPRITES[hat];
  const bodyFallbacks = [bodyFile, PLAYER_SPRITES.none, LEGACY_SPRITE];
  return {
    possessed: false,
    hat,
    spirit: null,
    bodyFile,
    bodyFallbacks,
    standaloneHatFile: null,
    layers: [{ role: "body", file: bodyFile, fallbacks: bodyFallbacks }],
  };
}

/** Expose the raw geometry tables for the renderer and tests. */
export const APPEARANCE_GEOMETRY = Object.freeze({
  bodyReference: BODY_REFERENCE,
  hatGeometry: HAT_GEOMETRY,
  spiritHatAnchor: SPIRIT_HAT_ANCHOR,
});

export default {
  resolveAppearance,
  spriteDrawRect,
  standaloneHatRect,
  PLAYER_SPRITES,
  SPIRIT_SPRITES,
  STANDALONE_HATS,
  LEGACY_SPRITE,
  APPEARANCE_GEOMETRY,
};
