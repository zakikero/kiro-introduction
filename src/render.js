// render.js â€” Canvas layer drawing (thin DOM/IO module).
//
// This is one of the few modules allowed to touch the DOM/Canvas. It holds no
// gameplay state and never mutates the simulation: it reads the FSM state and
// paints it. All gameplay logic stays in systems/* and state.js.
//
// Correctness-relevant rules this module honors:
//   - RENDER-ONLY interpolation (Req 1.10 / 12.10): Ghosty is drawn at the
//     position tweened between its committed previous (prevX/prevY) and current
//     (x/y) CENTER coordinates using `alpha`. Collisions never read this value.
//   - CENTER coordinates (structure / Req 12.10): Ghosty's x/y are the center
//     of the logical body rect. The draw rect is center Â± half the configured
//     logical body size (â‰ˆ32Ã—39). The ghosty.png's natural pixel dimensions are
//     NEVER used as gameplay dimensions; the image is only fit (aspect
//     preserved) inside that logical rect.
//   - Letterboxed fit (Req 12.9): the fixed 960Ã—640 Logical_Playfield is fit to
//     the canvas via a uniform scale + centering transform at DRAW TIME ONLY.
//     Display scaling never changes physics or collision geometry.
//   - Graceful degradation (Req 12.1): a missing/pending Ghosty sprite falls
//     back to a labeled placeholder in the soft illustrated Halloween style, so
//     absent art never blocks proving the core loop.
//   - Reduced motion (steering): when a reduced-motion preference is set,
//     motion-heavy effects are toned down.
//
// Importing this module must not require a browser. All browser-global access
// is `typeof`-guarded so `node --check` / a headless import never crashes;
// actual drawing only runs when a real canvas/2D context is supplied.

import { CONFIG } from "./config.js";
import { States } from "./state.js";
import { drawHud } from "./ui/hud.js";
import { drawBattle, drawPossessionOffer } from "./ui/battle.js";
import { drawShop } from "./ui/shop.js";
import { resultsSummary, drawResults } from "./ui/results.js";
import { drawMenu } from "./ui/menu.js";
import { drawWardrobe } from "./ui/wardrobe.js";
import {
  resolveAppearance,
  spriteDrawRect,
  standaloneHatRect,
  APPEARANCE_GEOMETRY,
} from "./appearance.js";
import { loadImage, imageReady, getImage, firstReady } from "./assets.js";

/** Path to the provided Ghosty sprite, relative to index.html. */
// Ghosty and all other sprites now load through the shared cached loader
// (assets.js) and the appearance resolver (appearance.js); the legacy
// `assets/ghosty.png` remains only as the final fallback in each resolved
// fallback chain. No per-module image state lives here anymore.

// --- FSM / RunState access helpers ------------------------------------------

/**
 * Resolve the thing `render` was handed into a `{ state, runState }` pair.
 * `loop.js` passes `fsm.state` (a string), but callers/tests may pass the FSM
 * object directly; support both without assuming either.
 * @param {any} stateArg the first argument to {@link render}
 * @returns {{ stateName: string|null, runState: object|null }}
 */
function resolveState(stateArg) {
  if (stateArg && typeof stateArg === "object") {
    // Looks like an FSM (has a `state` getter and maybe `runState`).
    const stateName =
      typeof stateArg.state === "string" ? stateArg.state : null;
    const runState =
      stateArg.runState && typeof stateArg.runState === "object"
        ? stateArg.runState
        : null;
    return { stateName, runState };
  }
  if (typeof stateArg === "string") {
    return { stateName: stateArg, runState: null };
  }
  return { stateName: null, runState: null };
}

/** States in which the flight world (background + pipes + Ghosty) is drawn. */
const FLIGHT_LIKE_STATES = new Set([
  States.Ready_State,
  States.Active_Flight_State,
  States.Pause_State,
  States.Resume_Countdown_State,
]);

// --- Letterbox transform -----------------------------------------------------

/**
 * Compute the uniform scale + centering offsets that fit the fixed logical
 * playfield inside the given device-pixel canvas size, preserving aspect ratio
 * (letterboxed). This is a pure helper so the fit math is trivially inspectable.
 *
 * @param {number} canvasW canvas backing-store width in device px
 * @param {number} canvasH canvas backing-store height in device px
 * @param {number} logicalW logical playfield width (960)
 * @param {number} logicalH logical playfield height (640)
 * @returns {{ scale: number, offsetX: number, offsetY: number }}
 */
export function computeLetterbox(canvasW, canvasH, logicalW, logicalH) {
  const safeW = canvasW > 0 ? canvasW : logicalW;
  const safeH = canvasH > 0 ? canvasH : logicalH;
  const scale = Math.min(safeW / logicalW, safeH / logicalH);
  const offsetX = (safeW - logicalW * scale) / 2;
  const offsetY = (safeH - logicalH * scale) / 2;
  return { scale, offsetX, offsetY };
}

// --- Palette (soft illustrated Halloween) -----------------------------------

const PALETTE = {
  skyTop: "#2a0f4a", // deep moonlit purple
  skyBottom: "#5a2a6e", // warmer dusk purple
  moon: "#ffe9b3",
  moonGlow: "rgba(255, 233, 179, 0.25)",
  ground: "#1b0b2e",
  pipe: "#6a3f2a", // warm pumpkin-wood brown
  pipeEdge: "#a7613b",
  ghostBody: "#efe6ff",
  ghostEdge: "#b9a9e6",
  ghostEye: "#3a2a55",
  letterbox: "#0b0416",
  placeholderText: "#3a2a55",
};

// Soft illustrated placeholder colors for the four cosmetic Hats. These are
// labeled placeholder shapes (Req 12.1) drawn ON TOP of Ghosty in the flight
// entity layer; real hat art drops in later with no logic change. Hats are
// purely cosmetic â€” nothing here reads or affects the Hitbox (steering).
const HAT_STYLES = {
  witchHat: { body: "#2a0f4a", edge: "#b9a9e6", label: "Witch" },
  pumpkinCap: { body: "#ff8c2b", edge: "#a7613b", label: "Pumpkin" },
  batBonnet: { body: "#1b0b2e", edge: "#6e4a8e", label: "Bat" },
  hauntedCrown: { body: "#ffd86b", edge: "#a7613b", label: "Crown" },
};

// Soft illustrated placeholder tints for the two Spirits. Drawn as a gentle
// aura BEHIND Ghosty so possession reads clearly in flight as well as battle
// (steering: recognizable in both flight and battle), without ever touching
// the Hitbox. A missing spirit (base Ghosty) draws no aura.
const SPIRIT_STYLES = {
  storm_bat: { tint: "#9ad0ff", label: "Storm Bat" }, // airy blue
  pumpkin_guardian: { tint: "#ffb347", label: "Pumpkin Guardian" }, // orange
};

// --- Layer drawing -----------------------------------------------------------

/**
 * Draw the moonlit Halloween background in logical coordinates.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} config
 */
function drawBackground(ctx, config) {
  const { width, height } = config.playfield;

  // Prefer the illustrated background art (scaled to fill the logical
  // playfield; it is 1536x1024, the same 3:2 ratio, so it fills exactly). The
  // manifest warns not to draw a duplicate moon over it, so when the image is
  // used we skip the procedural moon and return. A missing/pending image falls
  // through to the gradient + moon placeholder (graceful degradation).
  loadImage("background.png");
  if (imageReady("background.png")) {
    const bg = getImage("background.png");
    if (bg) {
      try {
        ctx.drawImage(bg, 0, 0, width, height);
        const groundH = Math.max(24, height * 0.06);
        ctx.fillStyle = PALETTE.ground;
        ctx.fillRect(0, height - groundH, width, groundH);
        return;
      } catch {
        // fall through to the procedural backdrop
      }
    }
  }

  // Sky gradient: purple-and-orange moonlit feel.
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, PALETTE.skyTop);
  sky.addColorStop(1, PALETTE.skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // Moon with a soft glow.
  const moonX = width * 0.82;
  const moonY = height * 0.2;
  const moonR = 46;
  const glow = ctx.createRadialGradient(
    moonX,
    moonY,
    moonR * 0.4,
    moonX,
    moonY,
    moonR * 2.4,
  );
  glow.addColorStop(0, PALETTE.moonGlow);
  glow.addColorStop(1, "rgba(255, 233, 179, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(moonX, moonY, moonR * 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.moon;
  ctx.beginPath();
  ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
  ctx.fill();

  // Ground band at the bottom edge.
  const groundH = Math.max(24, height * 0.06);
  ctx.fillStyle = PALETTE.ground;
  ctx.fillRect(0, height - groundH, width, groundH);
}

/**
 * Draw a rounded-rect path. Falls back to a plain rect when the context lacks
 * `roundRect` (older engines), so drawing never throws.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 */
function roundedRectPath(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Draw all PipePairs as top and bottom pillars around each gap, in logical
 * coordinates. A pair spans [x, x + pipe.width]; its gap is centered on
 * `gapCenter` with height `pipe.gapHeight`. Placeholder soft-wood style.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object[]} pipes
 * @param {object} config
 */
function drawPipes(ctx, pipes, config, prefs = {}) {
  if (!Array.isArray(pipes) || pipes.length === 0) return;
  const { height } = config.playfield;
  const pw = config.pipe.width;
  const halfGap = config.pipe.gapHeight / 2;

  for (const pair of pipes) {
    if (!pair || typeof pair.x !== "number") continue;
    const gapCenter =
      typeof pair.gapCenter === "number" ? pair.gapCenter : height / 2;
    const x = pair.x;
    const gapTop = gapCenter - halfGap;
    const gapBottom = gapCenter + halfGap;

    // Stable per-pipe variation from its id/x, NOT the gameplay RNG, so wood
    // grain never affects spawner determinism (prompt §6).
    const seed = pipeVisualSeed(pair);

    // Top pillar (ceiling -> gap top) and bottom pillar (gap bottom -> ground).
    // All detail is clipped WITHIN the collision rect so nothing protrudes into
    // the safe gap or creates a misleading apparent collision (prompt §6).
    drawPipePillar(ctx, x, 0, pw, gapTop, seed, true, prefs);
    drawPipePillar(ctx, x, gapBottom, pw, height - gapBottom, seed + 97, false, prefs);
  }
}

/** Stable integer visual seed for a pipe (never the gameplay RNG). */
function pipeVisualSeed(pair) {
  if (typeof pair.id === "number") return (pair.id * 2654435761) >>> 0;
  const x = typeof pair.x === "number" ? Math.round(pair.x) : 0;
  return (x * 40503 + 12345) >>> 0;
}

/** Tiny deterministic 0..1 PRNG from a seed (visual detail only). */
function vrand(seed) {
  let s = (seed >>> 0) || 1;
  s ^= s << 13; s >>>= 0;
  s ^= s >> 17;
  s ^= s << 5; s >>>= 0;
  return (s % 100000) / 100000;
}

/**
 * Draw one haunted-wooden pillar fully inside its collision rect [x,y,w,h].
 * Layered shading + restrained grain + inset bands + a carved detail + a
 * gap-facing cap with a strong edge. Everything is clipped to the rect so the
 * safe opening stays obvious and no ornament reaches into the gap (prompt §6).
 */
function drawPipePillar(ctx, x, y, w, h, seed, capAtBottom, prefs) {
  if (h <= 0) return;
  const r = 8;
  ctx.save();
  // Clip to the collision rect so no detail can spill into the safe path.
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.clip();

  // Base wood with a vertical light-to-dark shade for soft volume.
  const grad = ctx.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0, "#7a4a30");
  grad.addColorStop(0.5, PALETTE.pipe);
  grad.addColorStop(1, "#4f2e1e");
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  // Restrained vertical grain lines (cached-cheap, deterministic).
  ctx.strokeStyle = "rgba(40, 22, 12, 0.35)";
  ctx.lineWidth = 1;
  const lines = 3;
  for (let i = 1; i <= lines; i += 1) {
    const gx = x + (w * i) / (lines + 1) + (vrand(seed + i) - 0.5) * 4;
    ctx.beginPath();
    ctx.moveTo(gx, y + 2);
    ctx.lineTo(gx, y + h - 2);
    ctx.stroke();
  }

  // Inset bands across the pillar for a carved, banded look.
  ctx.fillStyle = "rgba(167, 97, 59, 0.5)";
  const bandSpacing = 46;
  for (let by = y + 24; by < y + h - 10; by += bandSpacing) {
    ctx.fillRect(x + 3, by, w - 6, 5);
  }

  // A small carved detail (moon / rune / pumpkin) chosen stably per pillar.
  const motif = Math.floor(vrand(seed + 7) * 3);
  const mx = x + w / 2;
  const my = capAtBottom ? y + 22 : y + h - 22;
  ctx.fillStyle = "rgba(255, 220, 150, 0.6)";
  ctx.strokeStyle = "rgba(255, 220, 150, 0.6)";
  if (motif === 0) {
    ctx.beginPath(); ctx.arc(mx, my, 7, 0, Math.PI * 2); ctx.fill();
  } else if (motif === 1) {
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(mx - 6, my - 6); ctx.lineTo(mx + 6, my + 6);
    ctx.moveTo(mx + 6, my - 6); ctx.lineTo(mx - 6, my + 6); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.ellipse(mx, my, 7, 6, 0, 0, Math.PI * 2); ctx.fill();
  }

  ctx.restore();

  // Gap-facing cap + strong readable outline (drawn un-clipped but still inside
  // the rect bounds), so the obstacle family reads as one and the gap edge is
  // unmistakable. The cap height is modest and stays within the rect.
  ctx.save();
  ctx.fillStyle = PALETTE.pipeEdge;
  const capH = Math.min(14, h);
  const capY = capAtBottom ? y : y + h - capH;
  roundedRectPath(ctx, x - 1, capY, w + 2, capH, 6);
  ctx.fill();
  ctx.strokeStyle = "#3a2112";
  ctx.lineWidth = 2;
  roundedRectPath(ctx, x, y, w, h, r);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw the avoidable optional Enemy/Shop symbols spawned into the flight world
 * by the scheduler, with a pre-contact label so the Player can read what they
 * are BEFORE touching them (Req 4.6, 7.4). Symbols use CENTER x/y with a w/h
 * body rect, mirroring the scheduler's coordinate convention. Enemy symbols
 * show their identity and relative-danger band; shop entrances show a shop tag.
 * Missing symbol art is a labeled placeholder shape (Req 12.1).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{ kind: string, enemyType?: string, x: number, y: number, w: number, h: number }>} symbols
 * @param {object} config
 */
function drawSymbols(ctx, symbols, config) {
  if (!Array.isArray(symbols) || symbols.length === 0) return;

  for (const s of symbols) {
    if (!s || typeof s.x !== "number") continue;
    const left = s.x - s.w / 2;
    const top = s.y - s.h / 2;
    const isShop = s.kind === "shop";

    ctx.save();

    // Prefer the real illustrated sprite (aspect-preserved into the symbol body
    // rect). Missing/pending art falls back to the rounded token placeholder so
    // the opportunity is always visible pre-contact (Req 4.6, 12.1).
    const spriteFile = isShop
      ? "shop.png"
      : s.enemyType === "B"
        ? "enemy_pumpkin_guardian.png"
        : "enemy_storm_bat.png";
    loadImage(spriteFile);
    let spriteDrawn = false;
    if (imageReady(spriteFile)) {
      const img = getImage(spriteFile);
      if (img) {
        const natW = img.naturalWidth || img.width || s.w;
        const natH = img.naturalHeight || img.height || s.h;
        const fit = Math.min(s.w / natW, s.h / natH);
        const dw = natW * fit;
        const dh = natH * fit;
        try {
          ctx.drawImage(img, s.x - dw / 2, s.y - dh / 2, dw, dh);
          spriteDrawn = true;
        } catch {
          spriteDrawn = false;
        }
      }
    }

    if (!spriteDrawn) {
      // Soft illustrated token: a rounded body tinted by kind.
      ctx.fillStyle = isShop
        ? "rgba(255, 179, 71, 0.85)"
        : "rgba(201, 138, 223, 0.9)";
      ctx.strokeStyle = isShop ? "#a7613b" : "#7a3f98";
      ctx.lineWidth = 2;
      roundedRectPath(ctx, left, top, s.w, s.h, 10);
      ctx.fill();
      ctx.stroke();
    }

    // Pre-contact label (identity / shop tag), drawn above the token.
    ctx.fillStyle = "#efe6ff";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.shadowColor = "rgba(20, 8, 40, 0.85)";
    ctx.shadowBlur = 6;
    ctx.font = "600 14px 'Segoe UI', system-ui, sans-serif";
    let label;
    if (isShop) {
      label = "Shop";
    } else if (s.enemyType === "A") {
      label = "Storm Bat";
    } else if (s.enemyType === "B") {
      label = "Pumpkin Guardian";
    } else {
      label = "Enemy";
    }
    ctx.fillText(label, s.x, top - 4);
    ctx.restore();
  }
}

/**
 * Draw Ghosty at the interpolated CENTER position inside the logical body rect.
 * The sprite is fit (aspect preserved) into the rect; if unavailable, a labeled
 * soft-ghost placeholder is drawn instead. Never uses the PNG's native size as
 * gameplay dimensions.
 *
 * Cosmetics (purely visual, never touching the Hitbox â€” steering/Req 3): the
 * equipped Spirit (if any) draws a soft aura BEHIND Ghosty so possession reads
 * in flight, and the equipped Hat (if any) draws a labeled placeholder shape ON
 * TOP so it stays visible across every appearance. Both are drawn relative to
 * the interpolated center only; they never enlarge the body rect or the Hitbox.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} ghosty the Ghosty sub-state ({ x, y, prevX, prevY, ... })
 * @param {number} alpha render interpolation factor in [0, 1)
 * @param {object} config
 * @param {{ spirit?: string|null, hat?: string|null }} [cosmetics] the equipped
 *   Spirit id and Hat id (presentation only)
 */
function drawGhosty(ctx, ghosty, alpha, config, cosmetics = {}) {
  if (!ghosty) return;

  const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0;

  // Render-only interpolation between committed previous and current CENTER.
  const prevX = Number.isFinite(ghosty.prevX) ? ghosty.prevX : ghosty.x;
  const prevY = Number.isFinite(ghosty.prevY) ? ghosty.prevY : ghosty.y;
  const cx = prevX + (ghosty.x - prevX) * a;
  const cy = prevY + (ghosty.y - prevY) * a;

  // Logical body rect = center Â± half the configured body size.
  const bw = config.ghosty.bodyWidth;
  const bh = config.ghosty.bodyHeight;
  const left = cx - bw / 2;
  const top = cy - bh / 2;

  // Resolve the whole-sprite appearance (shared with wardrobe/menu/battle).
  // The resolver maps the saved hat + transient spirit to the body sprite (and
  // optional standalone hat on a possessed body); the loader decides which of
  // the fallback chain is actually ready. Cosmetics never touch the hitbox.
  const plan = resolveAppearance(
    cosmetics && cosmetics.hat,
    cosmetics && cosmetics.spirit,
  );

  // Kick off loads for the primary body + any standalone hat (idempotent).
  for (const layer of plan.layers) {
    for (const f of layer.fallbacks) loadImage(f);
  }

  const bodyFile = firstReady(plan.bodyFallbacks);
  const bodyMeta = bodyFile && APPEARANCE_GEOMETRY.bodyReference[bodyFile];

  let drawn = false;
  if (bodyFile && bodyMeta) {
    // Align the sprite's BODY REFERENCE to the logical body box so a tall hat
    // never resizes Ghosty (prompt §3). The hitbox is unchanged regardless.
    const rect = spriteDrawRect(bodyFile, cx, cy, bw, bh);
    const img = getImage(bodyFile);
    if (rect && img) {
      try {
        ctx.drawImage(img, rect.dx, rect.dy, rect.dw, rect.dh);
        drawn = true;
        // On a possessed body, layer exactly one standalone hat (if equipped).
        if (plan.possessed && plan.standaloneHatFile && imageReady(plan.standaloneHatFile)) {
          const hatRect = standaloneHatRect(
            plan.standaloneHatFile, bodyFile, rect, bodyMeta, bw,
          );
          const hatImg = getImage(plan.standaloneHatFile);
          if (hatRect && hatImg) {
            ctx.drawImage(hatImg, hatRect.dx, hatRect.dy, hatRect.dw, hatRect.dh);
          }
        }
      } catch {
        drawn = false;
      }
    }
  }

  if (!drawn) {
    // No real art ready yet: soft aura for possession + labeled placeholder +
    // placeholder hat, so the loop is fully playable before art loads (Req 12.1).
    drawSpiritAura(ctx, cx, cy, bw, bh, cosmetics && cosmetics.spirit);
    drawGhostyPlaceholder(ctx, left, top, bw, bh);
    drawHat(ctx, cx, top, bw, cosmetics && cosmetics.hat);
  }
}

/**
 * Draw a large, STATIC Ghosty preview centered at (cx, cy) with the given
 * target body width, wearing hat and optionally possessed by spirit. Shares
 * the appearance resolver + loader with flight/battle so the preview can never
 * disagree with the in-game look (prompt §2, §3). Falls back to the labeled
 * placeholder when art is not ready. Purely presentational; touches no state.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx preview center x (logical coords)
 * @param {number} cy preview center y
 * @param {number} bodyW target optical body width in logical px
 * @param {string|null} hat the hat id to preview
 * @param {string|null} spirit optional spirit id to preview
 */
export function drawGhostyPreview(ctx, cx, cy, bodyW, hat, spirit) {
  if (!ctx || typeof ctx.drawImage !== "function") return;
  const bodyH = bodyW * (39 / 32);
  const plan = resolveAppearance(hat, spirit);
  for (const layer of plan.layers) for (const f of layer.fallbacks) loadImage(f);
  const bodyFile = firstReady(plan.bodyFallbacks);
  const bodyMeta = bodyFile && APPEARANCE_GEOMETRY.bodyReference[bodyFile];
  if (bodyFile && bodyMeta) {
    const rect = spriteDrawRect(bodyFile, cx, cy, bodyW, bodyH);
    const img = getImage(bodyFile);
    if (rect && img) {
      try {
        ctx.drawImage(img, rect.dx, rect.dy, rect.dw, rect.dh);
        if (plan.possessed && plan.standaloneHatFile && imageReady(plan.standaloneHatFile)) {
          const hatRect = standaloneHatRect(plan.standaloneHatFile, bodyFile, rect, bodyMeta, bodyW);
          const hatImg = getImage(plan.standaloneHatFile);
          if (hatRect && hatImg) ctx.drawImage(hatImg, hatRect.dx, hatRect.dy, hatRect.dw, hatRect.dh);
        }
        return;
      } catch {
        // fall through to placeholder
      }
    }
  }
  // Placeholder preview.
  drawSpiritAura(ctx, cx, cy, bodyW, bodyH, spirit);
  drawGhostyPlaceholder(ctx, cx - bodyW / 2, cy - bodyH / 2, bodyW, bodyH);
  drawHat(ctx, cx, cy - bodyH / 2, bodyW, hat);
}

/**
 * Draw the equipped Spirit's soft aura behind Ghosty as a labeled placeholder
 * (Req 12.1). A null/absent/unknown spirit draws nothing (base Ghosty). Purely
 * cosmetic: positioned off the interpolated center, never affecting the Hitbox.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx interpolated center x
 * @param {number} cy interpolated center y
 * @param {number} bw logical body width
 * @param {number} bh logical body height
 * @param {string|null|undefined} spirit the equipped Spirit id
 */
function drawSpiritAura(ctx, cx, cy, bw, bh, spirit) {
  const style = spirit && SPIRIT_STYLES[spirit];
  if (!style) return;
  const r = Math.max(bw, bh) * 0.75;
  ctx.save();
  const glow = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r);
  glow.addColorStop(0, style.tint);
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * Draw the equipped Hat as a labeled placeholder shape resting on top of
 * Ghosty's head (Req 12.1). A null/absent/unknown hat (the free no-hat default)
 * draws nothing. Purely cosmetic: it is positioned relative to the logical body
 * rect's top edge and never enlarges the body rect or the Hitbox (steering).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx interpolated center x
 * @param {number} top logical body rect top (center y - bodyHeight/2)
 * @param {number} bw logical body width
 * @param {string|null|undefined} hat the equipped Hat id
 */
function drawHat(ctx, cx, top, bw, hat) {
  const style = hat && HAT_STYLES[hat];
  if (!style) return;

  const brimW = bw * 1.1;
  const brimY = top + 2;
  const coneH = bw * 0.7;

  ctx.save();
  ctx.fillStyle = style.body;
  ctx.strokeStyle = style.edge;
  ctx.lineWidth = 1.5;

  // Brim.
  ctx.beginPath();
  ctx.ellipse(cx, brimY, brimW / 2, bw * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Crown/cone â€” a simple pointed shape stands in for every hat; the per-hat
  // color and label make them distinguishable until real art arrives.
  ctx.beginPath();
  ctx.moveTo(cx - bw * 0.35, brimY);
  ctx.lineTo(cx, brimY - coneH);
  ctx.lineTo(cx + bw * 0.35, brimY);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

/**
 * Soft illustrated ghost placeholder drawn inside the logical body rect.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} left
 * @param {number} top
 * @param {number} w
 * @param {number} h
 */
function drawGhostyPlaceholder(ctx, left, top, w, h) {
  ctx.save();

  const cx = left + w / 2;
  const headR = w / 2;
  const headCy = top + headR;

  ctx.fillStyle = PALETTE.ghostBody;
  ctx.strokeStyle = PALETTE.ghostEdge;
  ctx.lineWidth = 2;

  // Rounded head + body with a gently scalloped hem.
  ctx.beginPath();
  ctx.arc(cx, headCy, headR, Math.PI, 0, false);
  const bodyBottom = top + h;
  ctx.lineTo(left + w, bodyBottom - 4);
  const scallops = 3;
  const step = w / scallops;
  for (let i = 0; i < scallops; i += 1) {
    const sx = left + w - i * step;
    ctx.quadraticCurveTo(
      sx - step / 2,
      bodyBottom + 4,
      sx - step,
      bodyBottom - 4,
    );
  }
  ctx.lineTo(left, headCy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Two soft eyes so it reads as "ghost" at a glance.
  ctx.fillStyle = PALETTE.ghostEye;
  const eyeR = Math.max(1.5, w * 0.08);
  ctx.beginPath();
  ctx.arc(cx - w * 0.16, headCy, eyeR, 0, Math.PI * 2);
  ctx.arc(cx + w * 0.16, headCy, eyeR, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/**
 * Draw a simple title screen for menu-ish states (full menus arrive later).
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} config
 */
function drawTitleScreen(ctx, config) {
  const { width, height } = config.playfield;
  drawBackground(ctx, config);

  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = "#efe6ff";
  ctx.shadowColor = "rgba(20, 8, 40, 0.85)";
  ctx.shadowBlur = 8;
  ctx.font = "700 44px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText("Kiro's Haunted Flight", width / 2, height / 2 - 10);
  ctx.font = "400 18px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = "#d8c6ff";
  ctx.fillText("Press to begin", width / 2, height / 2 + 28);
  ctx.restore();
}

// --- Public render entry ------------------------------------------------------

/**
 * Create a bound renderer for a specific canvas. The returned `render(state,
 * alpha)` is what `loop.js` calls each frame. Binding the canvas here keeps the
 * per-frame function cheap and lets `main.js` own canvas lifecycle.
 *
 * @param {HTMLCanvasElement} canvas the target canvas
 * @param {object} [options]
 * @param {object} [options.config] the frozen CONFIG (defaults to the imported one)
 * @param {{ reducedMotion?: boolean }|(() => { reducedMotion?: boolean })} [options.prefs]
 *   saved presentation prefs, or a getter returning them. Used to honor the
 *   reduced-motion preference where motion/effects are produced (steering).
 * @returns {(state: any, alpha: number) => void} the per-frame render function
 */
export function createRenderer(canvas, options = {}) {
  const config = options.config || CONFIG;
  const prefsSource = options.prefs;
  const saveSource = options.save;
  const feedbackSource = options.feedback;
  const previewSource = options.wardrobePreview;
  const overlaySource = options.overlayActive;

  /** Whether an interactive DOM panel owns this frame's menu content. */
  function currentOverlayActive() {
    try {
      return Boolean(typeof overlaySource === "function" ? overlaySource() : overlaySource);
    } catch {
      return false;
    }
  }

  /** @returns {object|null} the current feedback buffer (ui/feedback.js), or null */
  function currentFeedback() {
    let f = feedbackSource;
    if (typeof feedbackSource === "function") {
      try {
        f = feedbackSource();
      } catch {
        f = null;
      }
    }
    return f && typeof f === "object" ? f : null;
  }

  /** @returns {{ reducedMotion: boolean }} the current presentation prefs */
  function currentPrefs() {
    let p = prefsSource;
    if (typeof prefsSource === "function") {
      try {
        p = prefsSource();
      } catch {
        p = null;
      }
    }
    return { reducedMotion: Boolean(p && p.reducedMotion) };
  }

  /** @returns {string|null} the hat id previewed in the Wardrobe, or null */
  function currentPreview() {
    let p = previewSource;
    if (typeof previewSource === "function") {
      try { p = previewSource(); } catch { p = null; }
    }
    return typeof p === "string" ? p : null;
  }

  /** @returns {object|null} the current SaveData (for the Results total Candy) */
  function currentSave() {
    let s = saveSource;
    if (typeof saveSource === "function") {
      try {
        s = saveSource();
      } catch {
        s = null;
      }
    }
    return s && typeof s === "object" ? s : null;
  }

  /**
   * @param {any} stateArg `fsm.state` string or the FSM object
   * @param {number} alpha render interpolation factor in [0, 1)
   */
  return function render(stateArg, alpha) {
    if (!canvas || typeof canvas.getContext !== "function") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    renderToContext(
      ctx,
      canvas.width,
      canvas.height,
      stateArg,
      alpha,
      config,
      currentPrefs(),
      currentSave(),
      currentFeedback(),
      currentPreview(),
      currentOverlayActive(),
    );
  };
}

/**
 * Draw one frame into an explicit 2D context. Factored out of
 * {@link createRenderer} so it can be exercised with any context (including a
 * stub) without a real canvas element.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} canvasW backing-store width (device px)
 * @param {number} canvasH backing-store height (device px)
 * @param {any} stateArg `fsm.state` string or the FSM object
 * @param {number} alpha render interpolation factor in [0, 1)
 * @param {object} [config] the frozen CONFIG (defaults to the imported one)
 * @param {{ reducedMotion?: boolean }} [prefs] presentation prefs
 * @param {object|null} [save] the loaded SaveData (for the Results total Candy)
 * @param {object|null} [feedback] the transient feedback buffer (ui/feedback.js)
 * @param {string|null} [previewHat] selected hat for the Canvas-only wardrobe fallback
 * @param {boolean} [overlayActive] whether a DOM panel owns the menu content
 * @returns {void}
 */
export function renderToContext(
  ctx,
  canvasW,
  canvasH,
  stateArg,
  alpha,
  config = CONFIG,
  prefs = {},
  save = null,
  feedback = null,
  previewHat = null,
  overlayActive = false,
) {
  if (!ctx) return;

  const { width: logicalW, height: logicalH } = config.playfield;
  const { scale, offsetX, offsetY } = computeLetterbox(
    canvasW,
    canvasH,
    logicalW,
    logicalH,
  );

  const { stateName, runState } = resolveState(stateArg);

  // 1. Clear to the letterbox color (fills the bars around the playfield).
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PALETTE.letterbox;
  ctx.fillRect(0, 0, canvasW || logicalW, canvasH || logicalH);
  ctx.restore();

  // 2. World is drawn under the DRAW-TIME-ONLY letterbox transform. Clip to the
  //    logical playfield so nothing spills into the bars.
  ctx.save();
  ctx.setTransform(scale, 0, 0, scale, offsetX, offsetY);
  ctx.beginPath();
  ctx.rect(0, 0, logicalW, logicalH);
  ctx.clip();

  const isFlightLike = stateName === null || FLIGHT_LIKE_STATES.has(stateName);
  const hasDomPanel = Boolean(overlayActive && (
    stateName === States.Main_Menu_State ||
    stateName === States.Results_State ||
    stateName === States.Pause_State ||
    stateName === States.Wardrobe ||
    stateName === States.Shop_State
  ));

  if (hasDomPanel && stateName !== States.Pause_State) {
    // The DOM panel owns labels, choices and its dedicated Ghosty preview.
    // Repainting the legacy Canvas menu behind it causes overlapping text and
    // a second ghost. Keep only the shared atmosphere under those panels.
    drawBackground(ctx, config);
  } else if (isFlightLike && runState) {
    // Background -> pipes -> symbols -> Ghosty (entities, with cosmetic Spirit
    // aura + Hat) -> effects(stub). Cosmetics are presentation only: the Spirit
    // is read from the live RunState and the equipped Hat from SaveData; neither
    // touches gameplay or the Hitbox.
    drawBackground(ctx, config);
    drawPipes(ctx, runState.pipes, config, prefs);
    drawSymbols(ctx, runState.symbols, config);
    drawGhosty(ctx, runState.ghosty, alpha, config, {
      spirit: runState.equippedSpirit || null,
      hat:
        (save && typeof save.equippedHat === "string" && save.equippedHat) ||
        null,
    });
    drawEffects(ctx, runState, config, prefs);
  } else if (stateName === States.Battle_State && runState) {
    // Dedicated battle scene (Req 5.21â€“5.23), drawn SEPARATELY from the frozen
    // flight world. The live battle is carried on the RunState by the shell.
    drawBattle(ctx, runState, runState.activeBattle, config, save);
  } else if (stateName === States.Shop_State && runState) {
    // In-run shop view (Req 7.5): effect/price/quantity/affordability + potion.
    drawShop(ctx, runState, config);
  } else if (stateName === States.Reward_State && runState) {
    // Reward screen: present the Possession offer (Req 6.1, 6.2, 6.6) over a
    // soft backdrop. A null offer (boss / no spirit reward) draws just the
    // backdrop and the offer helper no-ops, so a confirm still leaves cleanly.
    drawBackground(ctx, config);
    drawPossessionOffer(ctx, runState.pendingOffer, config);
  } else if (stateName === States.Results_State) {
    // Results screen (Req 10.5, 10.6): outcome/cause, Pipe_Score, flight time,
    // enemies defeated, the Candy calculation + earned + updated total, and the
    // restart / Main Menu / Wardrobe actions. The content model is built PURELY
    // from the ended Run and SaveData; this draw is thin. A missing runState
    // (e.g. End Run with no Run) degrades to the soft backdrop + summary of an
    // empty Run rather than crashing.
    drawBackground(ctx, config);
    drawResults(ctx, resultsSummary(runState, save, config), config);
  } else if (stateName === States.Wardrobe) {
    // Wardrobe (Req 8.8, 8.11): the cosmetic Hat shop, reachable only OUTSIDE a
    // Run (from the menu/results). Reads the persistent SaveData â€” Candy,
    // owned/equipped Hats â€” and never touches a RunState. drawWardrobe paints
    // its own backdrop, so no separate background is needed.
    drawWardrobe(ctx, save, config);
    // A large LIVE preview of Ghosty wearing the SELECTED hat (prompt §2): the
    // previewed hat (overlay selection) is distinct from the equipped one. No
    // spirit in the wardrobe (meta screen, outside a Run), so this previews the
    // whole swappable sprite for the chosen hat.
    const previewId =
      typeof previewHat === "string" ? previewHat : (save && save.equippedHat) || "none";
    drawGhostyPreview(ctx, logicalW * 0.5, logicalH * 0.52, 120, previewId, null);
  } else if (stateName === States.Main_Menu_State) {
    // Main Menu (Req 10.4): title + saved high score over the soft backdrop.
    // The Export/Import affordances live in index.html's DOM chrome (exposed
    // only outside a Run by the shell), so the canvas view stays to the title.
    drawBackground(ctx, config);
    drawMenu(ctx, save, config);
    drawGhostyPreview(ctx, logicalW * 0.5, logicalH * 0.7, 90, (save && save.equippedHat) || "none", null);
  } else {
    // Any other non-run state: the soft title backdrop.
    drawTitleScreen(ctx, config);
  }

  ctx.restore();

  // 3. HUD overlay: drawn in SCREEN space (outside the world transform) so it
  //    stays crisp and legibly positioned at any viewport size.
  if (runState && !hasDomPanel) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawHud(ctx, runState, config, {
      save,
      feedback,
      // Wall-clock seconds for feedback aging only â€” NOT a simulation clock, so
      // it never affects physics, collisions, or the three-clock rule.
      now:
        typeof performance !== "undefined" &&
        typeof performance.now === "function"
          ? performance.now() / 1000
          : Date.now() / 1000,
      reducedMotion: Boolean(prefs && prefs.reducedMotion),
    });
    ctx.restore();
  }
}

/**
 * Effects layer (particles / trails / shake). A deliberate stub for this task:
 * extensible, and already honoring the reduced-motion preference so later
 * effects work degrades gracefully. Obstacles must stay readable beneath any
 * effect, so nothing here occludes the pipes.
 * @param {CanvasRenderingContext2D} _ctx
 * @param {object} _runState
 * @param {object} _config
 * @param {{ reducedMotion?: boolean }} _prefs
 */
function drawEffects(_ctx, _runState, _config, _prefs) {
  // No effects yet. When added, gate motion-heavy effects on
  // `_prefs.reducedMotion` and keep pipes/safe route fully visible.
}

// Exposed for tests: the placeholder-art tables for the cosmetics that have no
// real art yet (four Hats, two Spirits). Enemy/boss placeholder art lives in
// ui/battle.js. Frozen so a test can assert coverage without mutating them.
export const PLACEHOLDER_ART = Object.freeze({
  hats: Object.freeze({ ...HAT_STYLES }),
  spirits: Object.freeze({ ...SPIRIT_STYLES }),
});

export default {
  createRenderer,
  renderToContext,
  computeLetterbox,
  PLACEHOLDER_ART,
};












