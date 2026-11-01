// render.js — Canvas layer drawing (thin DOM/IO module).
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
//     of the logical body rect. The draw rect is center ± half the configured
//     logical body size (≈32×39). The ghosty.png's natural pixel dimensions are
//     NEVER used as gameplay dimensions; the image is only fit (aspect
//     preserved) inside that logical rect.
//   - Letterboxed fit (Req 12.9): the fixed 960×640 Logical_Playfield is fit to
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

/** Path to the provided Ghosty sprite, relative to index.html. */
const GHOSTY_SPRITE_PATH = "assets/ghosty.png";

// --- Ghosty sprite (guarded, lazy) ------------------------------------------

/**
 * The Ghosty Image, or null until constructed. Load success/failure is tracked
 * so a pending or failed load cleanly falls back to the placeholder shape and
 * never throws or blocks the loop.
 * @type {HTMLImageElement|null}
 */
let ghostyImage = null;
let ghostyImageReady = false;
let ghostyImageFailed = false;

/**
 * Lazily construct and begin loading the Ghosty sprite. Guarded so a
 * non-browser import (no `Image`) simply leaves the placeholder path active.
 * @returns {void}
 */
function ensureGhostySprite() {
  if (ghostyImage || ghostyImageFailed) return;
  if (typeof Image !== "function") return;
  try {
    const img = new Image();
    img.addEventListener("load", () => {
      ghostyImageReady = true;
    });
    img.addEventListener("error", () => {
      ghostyImageFailed = true;
    });
    img.src = GHOSTY_SPRITE_PATH;
    ghostyImage = img;
  } catch {
    ghostyImageFailed = true;
  }
}

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
// purely cosmetic — nothing here reads or affects the Hitbox (steering).
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
function drawPipes(ctx, pipes, config) {
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

    ctx.fillStyle = PALETTE.pipe;
    ctx.strokeStyle = PALETTE.pipeEdge;
    ctx.lineWidth = 3;

    // Top pillar: from the ceiling down to the gap top.
    roundedRectPath(ctx, x, 0, pw, gapTop, 8);
    ctx.fill();
    ctx.stroke();

    // Bottom pillar: from the gap bottom down to the ground.
    roundedRectPath(ctx, x, gapBottom, pw, height - gapBottom, 8);
    ctx.fill();
    ctx.stroke();
  }
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
    // Soft illustrated token: a rounded body tinted by kind.
    ctx.fillStyle = isShop
      ? "rgba(255, 179, 71, 0.85)"
      : "rgba(201, 138, 223, 0.9)";
    ctx.strokeStyle = isShop ? "#a7613b" : "#7a3f98";
    ctx.lineWidth = 2;
    roundedRectPath(ctx, left, top, s.w, s.h, 10);
    ctx.fill();
    ctx.stroke();

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
 * Cosmetics (purely visual, never touching the Hitbox — steering/Req 3): the
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

  // Logical body rect = center ± half the configured body size.
  const bw = config.ghosty.bodyWidth;
  const bh = config.ghosty.bodyHeight;
  const left = cx - bw / 2;
  const top = cy - bh / 2;

  // Spirit aura first, so it sits BEHIND the body/sprite (cosmetic only).
  drawSpiritAura(ctx, cx, cy, bw, bh, cosmetics && cosmetics.spirit);

  ensureGhostySprite();

  let drawn = false;
  if (ghostyImage && ghostyImageReady && !ghostyImageFailed) {
    // Fit the sprite inside the body rect, preserving its aspect ratio — never
    // scaling to the PNG's natural pixel dimensions as gameplay size.
    const natW = ghostyImage.naturalWidth || ghostyImage.width || bw;
    const natH = ghostyImage.naturalHeight || ghostyImage.height || bh;
    const fit = Math.min(bw / natW, bh / natH);
    const drawW = natW * fit;
    const drawH = natH * fit;
    const drawX = cx - drawW / 2;
    const drawY = cy - drawH / 2;
    try {
      ctx.drawImage(ghostyImage, drawX, drawY, drawW, drawH);
      drawn = true;
    } catch {
      // Fall through to the placeholder if drawImage throws for any reason.
    }
  }

  if (!drawn) {
    // Labeled placeholder: a soft rounded ghost silhouette in the illustrated
    // Halloween style. Missing art must never block the loop (Req 12.1).
    drawGhostyPlaceholder(ctx, left, top, bw, bh);
  }

  // Hat last, so the cosmetic sits ON TOP and is never hidden by the possessed
  // look (steering: hats stay visible across every spirit appearance).
  drawHat(ctx, cx, top, bw, cosmetics && cosmetics.hat);
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

  // Crown/cone — a simple pointed shape stands in for every hat; the per-hat
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

  if (isFlightLike && runState) {
    // Background -> pipes -> symbols -> Ghosty (entities, with cosmetic Spirit
    // aura + Hat) -> effects(stub). Cosmetics are presentation only: the Spirit
    // is read from the live RunState and the equipped Hat from SaveData; neither
    // touches gameplay or the Hitbox.
    drawBackground(ctx, config);
    drawPipes(ctx, runState.pipes, config);
    drawSymbols(ctx, runState.symbols, config);
    drawGhosty(ctx, runState.ghosty, alpha, config, {
      spirit: runState.equippedSpirit || null,
      hat:
        (save && typeof save.equippedHat === "string" && save.equippedHat) ||
        null,
    });
    drawEffects(ctx, runState, config, prefs);
  } else if (stateName === States.Battle_State && runState) {
    // Dedicated battle scene (Req 5.21–5.23), drawn SEPARATELY from the frozen
    // flight world. The live battle is carried on the RunState by the shell.
    drawBattle(ctx, runState, runState.activeBattle, config);
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
    // Run (from the menu/results). Reads the persistent SaveData — Candy,
    // owned/equipped Hats — and never touches a RunState. drawWardrobe paints
    // its own backdrop, so no separate background is needed.
    drawWardrobe(ctx, save, config);
  } else if (stateName === States.Main_Menu_State) {
    // Main Menu (Req 10.4): title + saved high score over the soft backdrop.
    // The Export/Import affordances live in index.html's DOM chrome (exposed
    // only outside a Run by the shell), so the canvas view stays to the title.
    drawBackground(ctx, config);
    drawMenu(ctx, save, config);
  } else {
    // Any other non-run state: the soft title backdrop.
    drawTitleScreen(ctx, config);
  }

  ctx.restore();

  // 3. HUD overlay: drawn in SCREEN space (outside the world transform) so it
  //    stays crisp and legibly positioned at any viewport size.
  if (runState) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawHud(ctx, runState, config, {
      save,
      feedback,
      // Wall-clock seconds for feedback aging only — NOT a simulation clock, so
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
