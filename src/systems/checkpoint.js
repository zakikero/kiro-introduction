// systems/checkpoint.js — the safe flight checkpoint used when returning to
// Active_Flight_State from Battle_State / Reward_State / Shop_State (Req 9.14,
// 9.15, 9.16). This is the ONLY resumption path that repositions Ghosty; the
// ordinary-pause path restores the exact frozen flight state instead and must
// never call into here (design.md, Battle/Reward/Shop-exit resumption).
//
// Pure logic (no DOM). `selectCheckpoint` is a pure function of the run state
// plus the frozen CONFIG and returns a plain `{ x, y, vy: 0 }` with no mutation.
// `resumeFromCheckpoint` is the single mutating entry point: it applies the
// selected checkpoint to `runState.ghosty` and synchronizes the render-only
// prev positions, and it awards NO Pipe_Score for unpassed pairs. This module
// is a mandatory critical test surface (Property 31, task 2.8), so the contracts
// below are written to be cleanly property-testable.
//
// Coordinate convention (matches src/config.js, systems/collision.js, and the
// design doc):
//   - Ghosty's x/y are CENTER coordinates in logical px. The Hitbox is the
//     forgiving inset rect returned by `hitboxFor` (center ± half the logical
//     body size, inset by config.ghosty.hitboxInset). Because the Hitbox stays
//     centered on Ghosty's center, centering the Gap on `ghosty.y` (setting
//     y = gapCenter) centers the Hitbox in the Gap as well.
//   - A PipePair's `x` is its LEFT edge; the pair occupies [x, x + pipe.width]
//     horizontally. The Gap spans [gapCenter - gapHeight/2, gapCenter +
//     gapHeight/2]; the solid pipe parts are everything above and below it.
//
// Clearance note (deliberate, documented): the design pseudocode references
// `config.checkpointClearance`, but that tuning constant does NOT exist in
// config.js — the Configurable Initial Defaults table (and therefore the frozen
// CONFIG built in task 1.1) has no such value, and config.js is the single
// source of tuning truth, so we do NOT invent a new constant here. Instead we
// derive a safe clearance from values that already exist: we place the
// checkpoint x so Ghosty's Hitbox sits fully to the LEFT of the nearest upcoming
// pair's left edge with a margin of at least the Hitbox width and at least half
// the fixed inter-pair spacing (config.pipe.spacing / 2). Half the spacing is a
// natural "full clearance before that pair" distance because pairs are exactly
// `spacing` apart, and the Hitbox-width floor guarantees the Hitbox never grazes
// the pair even when the derived x is clamped back into the playfield. See
// `checkpointClearance` below.

import { hitboxFor, groundCeilingFatal } from './collision.js';

/**
 * @typedef {Object} PipePair
 * @property {number} id          unique id for this pair
 * @property {number} x           left edge, logical px
 * @property {number} gapCenter   gap center y, logical px
 * @property {number} gapHeight   gap height, logical px
 * @property {boolean} [scored]   whether this pair has awarded its point
 * @property {boolean} [shieldGrace] whether a shield currently excuses this pair
 */

/**
 * @typedef {Object} Checkpoint
 * @property {number} x   Ghosty CENTER x at the checkpoint, logical px
 * @property {number} y   Ghosty CENTER y at the checkpoint, logical px
 * @property {number} vy  always 0 (Req 9.14)
 */

/**
 * The horizontal clearance placed between Ghosty's Hitbox and the LEFT edge of
 * the nearest upcoming pair when repositioning in front of it. Derived from
 * existing config only (see the module header): at least the Hitbox width and
 * at least half the fixed inter-pair spacing, so the Hitbox is comfortably clear
 * of the pair even after the checkpoint x is clamped into the playfield.
 *
 * @param {{ pipe: { width: number, spacing: number }, ghosty: { bodyWidth: number, hitboxInset: number } }} config
 * @returns {number} clearance distance in logical px (non-negative)
 */
function checkpointClearance(config) {
  const hitboxWidth = config.ghosty.bodyWidth - 2 * config.ghosty.hitboxInset;
  const halfSpacing = config.pipe.spacing / 2;
  return Math.max(hitboxWidth, halfSpacing);
}

/**
 * The pair whose horizontal span [x, x + pipe.width] contains Ghosty's Hitbox
 * center x. If several overlap (they should not under normal spacing), the one
 * with the smallest left edge is returned so the result is deterministic.
 *
 * @param {number} boxCenterX Hitbox center x (equals Ghosty's center x)
 * @param {PipePair[]} pipes
 * @param {number} pipeWidth
 * @returns {PipePair|null}
 */
function pipePairContaining(boxCenterX, pipes, pipeWidth) {
  let found = null;
  for (const pair of pipes) {
    if (boxCenterX >= pair.x && boxCenterX <= pair.x + pipeWidth) {
      if (found === null || pair.x < found.x) found = pair;
    }
  }
  return found;
}

/**
 * The nearest upcoming pair: the one with the smallest left edge that is at or
 * ahead of Ghosty (i.e. the pair has not already been fully passed). "Ahead"
 * means the pair's left edge is at or to the right of the Hitbox center x, so a
 * pair Ghosty is still approaching qualifies. Returns null when there is no such
 * pair (all pipes are behind, or the list is empty).
 *
 * @param {number} boxCenterX Hitbox center x
 * @param {PipePair[]} pipes
 * @returns {PipePair|null}
 */
function nearestUpcomingPair(boxCenterX, pipes) {
  let found = null;
  for (const pair of pipes) {
    if (pair.x >= boxCenterX) {
      if (found === null || pair.x < found.x) found = pair;
    }
  }
  return found;
}

/**
 * Clamp a candidate Ghosty CENTER y so the resulting Hitbox stays strictly
 * inside the playfield (clear of Ground and Ceiling). The Hitbox is vertically
 * centered on `y`, so the center must stay within [halfH, height - halfH].
 *
 * @param {number} y candidate center y
 * @param {{ playfield: { height: number }, ghosty: { bodyHeight: number, hitboxInset: number } }} config
 * @returns {number} clamped center y
 */
function clampCenterY(y, config) {
  const halfH = (config.ghosty.bodyHeight - 2 * config.ghosty.hitboxInset) / 2;
  const { height } = config.playfield;
  const lo = halfH;
  const hi = height - halfH;
  if (lo > hi) return height / 2; // degenerate playfield; defensive only
  return Math.min(hi, Math.max(lo, y));
}

/**
 * Clamp a candidate Ghosty CENTER x so the resulting Hitbox stays within the
 * playfield horizontally.
 *
 * @param {number} x candidate center x
 * @param {{ playfield: { width: number }, ghosty: { bodyWidth: number, hitboxInset: number } }} config
 * @returns {number} clamped center x
 */
function clampCenterX(x, config) {
  const halfW = (config.ghosty.bodyWidth - 2 * config.ghosty.hitboxInset) / 2;
  const { width } = config.playfield;
  const lo = halfW;
  const hi = width - halfW;
  if (lo > hi) return width / 2; // degenerate playfield; defensive only
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Whether a candidate checkpoint's Hitbox clears the Ground, the Ceiling, and
 * every nearby pipe pair (its solid parts). "Clears" means no overlap: the
 * Hitbox must be inside the Gap of any pair it horizontally overlaps and must
 * not reach either boundary. Used to VERIFY a checkpoint before resuming
 * (Req 9.15).
 *
 * @param {Checkpoint} cp candidate checkpoint ({ x, y })
 * @param {PipePair[]} pipes
 * @param {{ pipe: { width: number }, playfield: { height: number }, ghosty: { bodyWidth: number, bodyHeight: number, hitboxInset: number } }} config
 * @returns {boolean} true when the Hitbox clears everything
 */
export function hitboxClears(cp, pipes, config) {
  const box = hitboxFor({ x: cp.x, y: cp.y }, config);
  if (groundCeilingFatal(box, config)) return false;

  const pipeWidth = config.pipe.width;
  for (const pair of pipes) {
    // Horizontal overlap with the pair's span?
    const overlapsH = box.x <= pair.x + pipeWidth && box.x + box.w >= pair.x;
    if (!overlapsH) continue;
    // Horizontally overlapping: the Hitbox must lie fully inside the Gap.
    const half = pair.gapHeight / 2;
    const gapTop = pair.gapCenter - half;
    const gapBottom = pair.gapCenter + half;
    const insideGap = box.y >= gapTop && box.y + box.h <= gapBottom;
    if (!insideGap) return false;
  }
  return true;
}

/**
 * Compute the safe flight checkpoint (Req 9.15).
 *
 * Algorithm:
 *   1. If Ghosty's Hitbox is within a Pipe_Pair's horizontal span, center Ghosty
 *      vertically in that pair's Gap at Ghosty's CURRENT x.
 *   2. Otherwise, center Ghosty vertically in the Gap of the nearest upcoming
 *      pair at an x that leaves full clearance before that pair (the Hitbox sits
 *      entirely to the left of the pair by {@link checkpointClearance}).
 *   3. If there are no pipes at all, fall back to the vertical center of the
 *      playfield at Ghosty's current (clamped) x.
 * In every case the chosen y and x are clamped so the Hitbox stays inside the
 * playfield, and the result is a plain `{ x, y, vy: 0 }`.
 *
 * Verification (Req 9.15): the caller — or {@link resumeFromCheckpoint} — can
 * assert {@link hitboxClears} on the result before resuming. A Gap produced by
 * the spawner respects the configured min-clearance, so centering in it always
 * clears Ground/Ceiling; the clamps keep that true even for degenerate inputs.
 *
 * @param {{ ghosty: { x: number, y: number }, pipes: PipePair[] }} runState
 * @param {object} config the frozen CONFIG
 * @returns {Checkpoint} `{ x, y, vy: 0 }`
 */
export function selectCheckpoint(runState, config) {
  const pipeWidth = config.pipe.width;
  const box = hitboxFor(runState.ghosty, config);
  // The Hitbox center x equals Ghosty's center x (the inset rect stays centered).
  const centerX = runState.ghosty.x;

  // Case 1: Hitbox center is within a pair's horizontal span → center in that
  // pair's Gap at the current x.
  const containing = pipePairContaining(centerX, runState.pipes, pipeWidth);
  if (containing != null) {
    const x = clampCenterX(runState.ghosty.x, config);
    const y = clampCenterY(containing.gapCenter, config);
    return { x, y, vy: 0 };
  }

  // Case 2: center in the nearest upcoming pair's Gap, placed fully before it.
  const next = nearestUpcomingPair(centerX, runState.pipes);
  if (next != null) {
    const clearance = checkpointClearance(config);
    const halfW = box.w / 2;
    // Place the Hitbox's RIGHT edge `clearance` px before the pair's left edge;
    // the center x is then that right edge minus half the Hitbox width.
    const targetCenterX = next.x - clearance - halfW;
    const x = clampCenterX(targetCenterX, config);
    const y = clampCenterY(next.gapCenter, config);
    return { x, y, vy: 0 };
  }

  // Case 3: no upcoming pair (empty list or all pipes behind) → playfield center
  // vertically at the current (clamped) x.
  const x = clampCenterX(runState.ghosty.x, config);
  const y = clampCenterY(config.playfield.height / 2, config);
  return { x, y, vy: 0 };
}

/**
 * Apply the safe checkpoint to the run state when returning to flight from
 * Battle_State / Reward_State / Shop_State (Req 9.14, 9.16). This is the ONLY
 * resumption path that repositions Ghosty; ordinary pause must not call it.
 *
 * Mutations (and only these): sets `ghosty.x`/`ghosty.y` to the checkpoint,
 * zeroes `ghosty.vy`, and synchronizes `ghosty.prevX`/`ghosty.prevY` with the
 * new position so render interpolation produces no visual jump and no false pass
 * (Req 9.16). It awards NO Pipe_Score and never marks any unpassed pair as
 * scored — `pipeScore` and every pair's `scored` flag are left untouched, so a
 * pair Ghosty has not actually passed can never be counted by repositioning.
 *
 * Run progress, the consumable inventory, Shield charges, the Hover remainder,
 * and all cooldowns are preserved because this function simply does not touch
 * them (Req 9.14). The FSM performs the transition to Resume_Countdown_State;
 * this module only prepares the flight state.
 *
 * @param {object} runState the current RunState (mutated in place)
 * @param {object} config the frozen CONFIG
 * @returns {Checkpoint} the applied checkpoint `{ x, y, vy: 0 }`
 */
export function resumeFromCheckpoint(runState, config) {
  const cp = selectCheckpoint(runState, config);

  runState.ghosty.x = cp.x;
  runState.ghosty.y = cp.y;
  runState.ghosty.vy = 0;

  // Req 9.16: sync the render-only previous position with the new current
  // position so interpolation does not draw a phantom sweep from the old spot
  // (which could otherwise read as a false pipe pass).
  runState.ghosty.prevX = cp.x;
  runState.ghosty.prevY = cp.y;

  // Req 9.16: award NO Pipe_Score for unpassed pairs. Repositioning deliberately
  // does not increment pipeScore and does not set any pair's `scored` flag.

  return cp;
}

export default resumeFromCheckpoint;
