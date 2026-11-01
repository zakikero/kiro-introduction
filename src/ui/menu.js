// ui/menu.js — the Main_Menu_State view (thin DOM/IO view).
//
// This is a UI view module in the same spirit as ui/hud.js: it only draws to a
// Canvas 2D context handed to it, holds no gameplay state, and never mutates
// SaveData or the RunState. The renderer calls `drawMenu(ctx, save, config)`
// while the Game is in Main_Menu_State.
//
// For this task the menu surfaces two things in the soft illustrated Halloween
// style (Req 12.1, not pixel art): the game title "Kiro's Haunted Flight" and
// the saved high score (Req 10.4). Start / Wardrobe / import-export affordances
// are owned by later UI tasks; this view only paints the title and high score.
//
// Headless-safe: importing this module in a non-browser context (e.g.
// `node --check` or the no-browser test harness) must never throw. It touches
// no browser globals at import time, and every draw is guarded with `typeof`
// checks so a missing/absent context is a silent no-op rather than a crash
// (graceful degradation, consistent with tech.md).

/** The game title shown on the Main Menu. */
const TITLE = "Kiro's Haunted Flight";

/**
 * Read a finite, non-negative integer high score from SaveData defensively.
 * A missing, corrupt, or non-numeric value degrades to 0 so the menu always
 * renders something sensible even before SaveData exists (save.js, task 1.18).
 * @param {object|null|undefined} save the loaded SaveData (or null)
 * @returns {number} a safe high score to display
 */
export function highScoreOf(save) {
  const hs = save && typeof save.highScore === 'number' ? save.highScore : 0;
  if (!Number.isFinite(hs) || hs < 0) return 0;
  return Math.floor(hs);
}

/**
 * Draw the Main Menu: the title and the saved high score (Req 10.4).
 *
 * Fully guarded: a no-op (never throws) when the context is absent or is not a
 * usable 2D context. The high score is read from `save.highScore` via
 * {@link highScoreOf} and shown as a legible label.
 *
 * @param {CanvasRenderingContext2D|null|undefined} ctx the 2D context to draw into
 * @param {object|null|undefined} save the loaded SaveData (or null before load)
 * @param {object} config the frozen CONFIG (for playfield dimensions)
 * @returns {void}
 */
export function drawMenu(ctx, save, config) {
  if (!ctx || typeof ctx.fillText !== 'function') return;

  // Logical playfield dimensions drive centering. Fall back to the canvas
  // backing-store size, then to sane constants, so a partial config never
  // throws (defensive; CONFIG always carries playfield in the real game).
  const width =
    (config && config.playfield && config.playfield.width) ||
    (ctx.canvas && ctx.canvas.width) ||
    960;
  const height =
    (config && config.playfield && config.playfield.height) ||
    (ctx.canvas && ctx.canvas.height) ||
    640;

  const centerX = width / 2;
  const highScore = highScoreOf(save);

  ctx.save();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Soft dark halo for readability over the moonlit sky (no hard pixel grid).
  ctx.shadowColor = 'rgba(20, 8, 40, 0.85)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 3;

  // Title — moonlit lavender, the game's signature hue.
  ctx.fillStyle = '#e8d8ff';
  ctx.font = "700 48px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(TITLE, centerX, height * 0.38);

  // High score (Req 10.4) — warm pumpkin orange beneath the title.
  ctx.fillStyle = '#ffb347';
  ctx.font = "600 28px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(`High Score: ${highScore}`, centerX, height * 0.52);

  ctx.restore();
}

export default { drawMenu, highScoreOf };
