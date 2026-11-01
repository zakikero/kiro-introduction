// ui/hud.js — the heads-up display overlay (thin DOM/IO view).
//
// This is a UI view module: it only draws to a Canvas 2D context handed to it.
// It holds no gameplay state and never mutates the RunState. The renderer calls
// `drawHud(ctx, runState, config, opts)` once per frame AFTER the letterboxed
// world has been drawn, so the HUD is painted in screen space (not under the
// world transform) and stays crisp and readable at any viewport size.
//
// What the HUD surfaces (Req 12.6 "readable health, currency, prices, effects,
// and cooldowns", Req 12.2 feedback):
//   - Pipe_Score, Soul_Coins, and Candy shown DISTINCTLY (each labeled, with
//     its own icon glyph) so the three are never confused,
//   - the Battle_HP pool when Ghosty is damaged (health readability),
//   - the Shield charge status (text + icon, not color alone),
//   - the Hover (Flight_Power) readiness / cooldown,
//   - a transient feedback banner for flap / score / shield break / rewards /
//     purchases / possession / fatal collision / boss victory (Req 12.2), fed
//     from the pure ui/feedback.js buffer.
//
// Accessibility (Req 12.7, 12.8): every stat is conveyed by TEXT (and an icon
// glyph) in addition to color, so nothing relies on color alone. Under the
// saved reduced-motion preference the HUD skips the opacity fade on feedback
// cues (they appear and vanish rather than visibly animating). Nothing here
// touches gameplay coordinates or the three simulation clocks — feedback aging
// uses a caller-supplied wall-clock time only.
//
// Importing this module in a non-browser context (e.g. `node --check`) must not
// throw — it touches no browser globals at import time; drawing only happens
// when a real 2D context is passed in.

import { spiritProvidesFlightPower } from "../input.js";
import { activeFeedback } from "./feedback.js";

/** HUD inset from the top-left corner, in screen (device) pixels. */
const HUD_MARGIN = 20;

/** Soft illustrated Halloween palette shared with the other HUD/menu views. */
const HUD = {
  halo: "rgba(20, 8, 40, 0.85)",
  score: "#ffb347", // pumpkin orange
  coin: "#ffd86b", // soul-coin gold
  candy: "#ff9ecb", // candy pink — distinct from the coin gold
  hp: "#8ad17f", // soft green
  hpBack: "rgba(20, 8, 40, 0.6)",
  hpLow: "#e06a6a", // soft red when health is low
  shield: "#9ad0ff", // airy blue
  shieldOff: "rgba(154, 208, 255, 0.5)",
  hover: "#9ad0ff",
  hoverOff: "rgba(154, 208, 255, 0.55)",
  feedbackGood: "#8ad17f",
  feedbackInfo: "#d8c6ff",
  feedbackWarn: "#ffb347",
  feedbackBad: "#e06a6a",
};

/**
 * The Hover (Storm_Bat Flight_Power) readiness to show on the HUD, or null when
 * the equipped Spirit provides no Flight_Power so nothing is drawn (Req 1.7).
 * Pure so it is unit-testable with no DOM: it reports whether Hover is ready
 * (cooldown elapsed) and a 0..1 recharge fraction for a progress cue, derived
 * from `runState.hoverCooldown` against the configured cooldown.
 *
 * @param {object|null|undefined} runState the active RunState
 * @param {object} [config] the frozen CONFIG (reads hover.cooldown)
 * @returns {{ ready: boolean, remaining: number, fraction: number }|null}
 */
export function hoverReadiness(runState, config) {
  if (!runState || !spiritProvidesFlightPower(runState.equippedSpirit)) {
    return null;
  }
  const cooldownMax =
    config && config.hover && typeof config.hover.cooldown === "number"
      ? config.hover.cooldown
      : 0;
  const remaining = Math.max(0, runState.hoverCooldown || 0);
  const fraction =
    cooldownMax > 0 ? Math.max(0, Math.min(1, 1 - remaining / cooldownMax)) : 1;
  return { ready: remaining <= 0, remaining, fraction };
}

/**
 * Build the distinct resource readouts for the HUD (Req 12.6). PURE and DOM-
 * free so it is unit-testable: each row carries its own label, icon glyph, and
 * value so the three pools (Pipe_Score, Soul_Coins, Candy) read DISTINCTLY and
 * are never conflated. Candy is persistent progress and lives on SaveData, so
 * it is included only when a `save` is supplied; the other two come from the
 * live RunState. Missing/garbage values degrade to 0 so the HUD never shows NaN.
 *
 * @param {object|null|undefined} runState the active RunState
 * @param {object|null|undefined} [save] the loaded SaveData (for Candy)
 * @returns {Array<{ id: string, label: string, icon: string, value: number, color: string }>}
 */
export function resourceRows(runState, save) {
  const safe = (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  const rows = [
    {
      id: "score",
      label: "Score",
      icon: "★",
      value: safe(runState && runState.pipeScore),
      color: HUD.score,
    },
    {
      id: "soulCoins",
      label: "Soul Coins",
      icon: "◎",
      value: safe(runState && runState.soulCoins),
      color: HUD.coin,
    },
  ];
  if (save && typeof save === "object") {
    rows.push({
      id: "candy",
      label: "Candy",
      icon: "🍬",
      value: safe(save.candy),
      color: HUD.candy,
    });
  }
  return rows;
}

/**
 * Draw the HUD overlay for the current run.
 *
 * Fully guarded: a no-op (never throws) when the context or runState is absent.
 *
 * @param {CanvasRenderingContext2D|null|undefined} ctx the 2D context to draw into
 * @param {object|null|undefined} runState the active RunState (or null outside a Run)
 * @param {object} [config] the frozen CONFIG
 * @param {object} [opts]
 * @param {object|null} [opts.save] the loaded SaveData (for the Candy readout)
 * @param {{ events: Array<object> }|null} [opts.feedback] the feedback buffer (ui/feedback.js)
 * @param {number} [opts.now] current wall-clock time in seconds (for feedback aging)
 * @param {boolean} [opts.reducedMotion] honor the reduced-motion preference (Req 12.8)
 * @returns {void}
 */
export function drawHud(ctx, runState, config, opts = {}) {
  if (!ctx || !runState) return;
  if (typeof ctx.fillText !== "function") return;

  const save = opts.save || null;
  const reducedMotion = Boolean(opts.reducedMotion);

  ctx.save();

  // --- Distinct resource readouts: Score / Soul Coins / Candy (Req 12.6). ---
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.shadowColor = HUD.halo;
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  const rows = resourceRows(runState, save);
  let y = HUD_MARGIN;
  for (const row of rows) {
    ctx.font = "600 26px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle = row.color;
    // Icon + label + value: information by text/icon, not color alone (Req 12.7).
    ctx.fillText(`${row.icon} ${row.label}: ${row.value}`, HUD_MARGIN, y);
    y += 34;
  }

  ctx.restore();

  // --- Shield status + Battle_HP (readable health, Req 12.6). ---
  drawLoadoutStatus(ctx, runState, config, y);

  // --- Hover readiness (Req 1.7): only while a power-providing Spirit is
  //     equipped; text-plus-bar so readiness is legible without color alone. ---
  drawHoverStatus(ctx, runState, config);

  // --- Transient feedback banner (Req 12.2). ---
  drawFeedback(ctx, opts.feedback, opts.now, reducedMotion, config);
}

/**
 * Draw the Shield charge status and, when Ghosty is damaged, the Battle_HP pool
 * (Req 12.6). Text + icon so neither relies on color alone (Req 12.7). Placed
 * under the resource rows at `startY`.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} runState
 * @param {object} [config]
 * @param {number} startY the y to start drawing at (below the resource rows)
 */
function drawLoadoutStatus(ctx, runState, config, startY) {
  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.shadowColor = HUD.halo;
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;
  ctx.font = "600 18px 'Segoe UI', system-ui, sans-serif";

  let y = startY + 4;

  // Shield charge (Req 3.x readability): a clear owned/none cue by text + icon.
  const shields =
    typeof runState.shieldCharges === "number" ? runState.shieldCharges : 0;
  if (shields > 0) {
    ctx.fillStyle = HUD.shield;
    ctx.fillText("⛊ Shield: ready", HUD_MARGIN, y);
  } else {
    ctx.fillStyle = HUD.shieldOff;
    ctx.fillText("⛊ Shield: none", HUD_MARGIN, y);
  }
  y += 28;

  // Battle_HP pool — shown when it is below max so the Player can read their
  // combat survival pool after a battle (distinct from the flight Shield).
  const maxHp =
    typeof runState.maxBattleHp === "number" && runState.maxBattleHp > 0
      ? runState.maxBattleHp
      : (config && config.combat && config.combat.startingBattleHp) || 1;
  const hp = typeof runState.battleHp === "number" ? runState.battleHp : maxHp;
  if (hp < maxHp) {
    const low = hp <= maxHp * 0.34;
    ctx.fillStyle = low ? HUD.hpLow : HUD.hp;
    ctx.fillText(
      `♥ Battle HP: ${Math.max(0, Math.round(hp))}/${Math.round(maxHp)}`,
      HUD_MARGIN,
      y,
    );
    // A compact bar under the label (display-only).
    const barX = HUD_MARGIN;
    const barY = y + 24;
    const barW = 140;
    const barH = 7;
    const frac = Math.max(0, Math.min(1, hp / maxHp));
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = HUD.hpBack;
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = low ? HUD.hpLow : HUD.hp;
    ctx.fillRect(barX, barY, barW * frac, barH);
  }

  ctx.restore();
}

/**
 * Draw the Hover readiness indicator in the top-right (Req 1.7). A no-op when
 * the equipped Spirit provides no Flight_Power. Text-plus-bar for accessibility.
 * Moved to the right edge so it never collides with the resource/HP stack on
 * the left. Guarded against a missing text metric so headless draws stay safe.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} runState
 * @param {object} [config]
 */
function drawHoverStatus(ctx, runState, config) {
  const hover = hoverReadiness(runState, config);
  if (!hover) return;

  const canvasW =
    (ctx.canvas && ctx.canvas.width) ||
    (config && config.playfield && config.playfield.width) ||
    960;
  const barW = 140;
  const x = canvasW - HUD_MARGIN - barW;
  const y = HUD_MARGIN;

  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = "600 18px 'Segoe UI', system-ui, sans-serif";
  ctx.shadowColor = HUD.halo;
  ctx.shadowBlur = 6;
  ctx.shadowOffsetY = 2;

  if (hover.ready) {
    ctx.fillStyle = HUD.hover;
    ctx.fillText("✦ Hover READY", x, y);
  } else {
    ctx.fillStyle = HUD.hoverOff;
    ctx.fillText(`✦ Hover ${hover.remaining.toFixed(1)}s`, x, y);
  }

  const barY = y + 24;
  const barH = 8;
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillStyle = "rgba(20, 8, 40, 0.65)";
  ctx.fillRect(x, barY, barW, barH);
  ctx.fillStyle = hover.ready ? HUD.hover : HUD.hoverOff;
  ctx.fillRect(x, barY, barW * hover.fraction, barH);

  ctx.restore();
}

/**
 * Map a feedback severity band to its HUD color. Kept here (presentation) so
 * ui/feedback.js stays a pure data buffer with no palette.
 * @param {string} severity
 * @returns {string}
 */
function feedbackColor(severity) {
  switch (severity) {
    case "good":
      return HUD.feedbackGood;
    case "warn":
      return HUD.feedbackWarn;
    case "bad":
      return HUD.feedbackBad;
    default:
      return HUD.feedbackInfo;
  }
}

/**
 * Draw the transient feedback banner (Req 12.2): the live cues from the pure
 * feedback buffer, bottom-center, each with its icon glyph + message. A no-op
 * when there is no buffer or no live event. Under reduced motion the opacity
 * fade is skipped (cues appear/vanish, no animated fade — Req 12.8).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ events: Array<object> }|null|undefined} buffer the feedback buffer
 * @param {number|undefined} now wall-clock seconds for aging
 * @param {boolean} reducedMotion skip the fade when true
 * @param {object} [config]
 */
function drawFeedback(ctx, buffer, now, reducedMotion, config) {
  if (!buffer) return;
  const events = activeFeedback(buffer, now);
  if (!events.length) return;

  const canvasW =
    (ctx.canvas && ctx.canvas.width) ||
    (config && config.playfield && config.playfield.width) ||
    960;
  const canvasH =
    (ctx.canvas && ctx.canvas.height) ||
    (config && config.playfield && config.playfield.height) ||
    640;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.shadowColor = HUD.halo;
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 2;
  ctx.font = "700 22px 'Segoe UI', system-ui, sans-serif";

  const baseY = canvasH - HUD_MARGIN;
  const lineH = 30;
  events.forEach((e, i) => {
    // Newest at the bottom; stack older cues upward.
    const y = baseY - i * lineH;
    ctx.globalAlpha = reducedMotion ? 1 : Math.max(0.15, e.fade);
    ctx.fillStyle = feedbackColor(e.severity);
    const text = e.message ? `${e.icon} ${e.message}` : e.icon;
    ctx.fillText(text, canvasW / 2, y);
  });

  ctx.restore();
}

export default { drawHud, hoverReadiness, resourceRows };
