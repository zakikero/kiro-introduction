// systems/collision.js — Ghosty's forgiving Hitbox, swept pipe collision, and
// the Ground/Ceiling checks, plus the shield/Shield_Grace outcome model.
//
// Pure logic (no DOM). Everything here is a pure function of plain-object state
// plus the frozen CONFIG; there is no mutation of the inputs and no hidden
// state. This is a mandatory critical test surface (property task 1.12), so the
// contracts below are written to be cleanly property-testable.
//
// Coordinate convention (matches src/config.js and the design doc):
//   - Ghosty's x/y are CENTER coordinates in logical px.
//   - The Hitbox is a top-left + size rect: { x, y, w, h }. It derives from
//     Ghosty's center ± half the configured LOGICAL BODY size, then inset by
//     config.ghosty.hitboxInset on every side (≈24×31). It is NEVER derived
//     from the PNG's natural pixels and is NEVER enlarged by hats, spirit
//     decorations, transparent sprite margins, particles, animation, or display
//     scale (Req 3.8, 3.9).
//   - A PipePair's `x` is its LEFT edge; it occupies [x, x+width] horizontally.
//     The Gap spans [gapCenter - gapHeight/2, gapCenter + gapHeight/2]; the
//     SOLID pipe parts are everything above and below that Gap. Ghosty overlaps
//     a pair when its Hitbox horizontally overlaps [x, x+width] AND vertically
//     overlaps a solid part (i.e. is NOT fully inside the Gap).
//
// Shield model (Req 3.1–3.4, 3.7, 3.14): the Shield is the ONLY source of
// flight collision immunity. On overlap with a non-grace pair:
//   - zero shield charges  → outcome 'fatal'
//   - ≥1 shield charge      → outcome 'shield' (the CALLER consumes exactly one
//                             charge and starts Shield_Grace for `pipeId`)
// While a pair is under Shield_Grace it is non-fatal (even with zero charges
// left); all OTHER pairs stay fatal. When the Hitbox has fully cleared the
// grace pair horizontally the function reports `clearedGraceId` so the caller
// can end that pair's grace.
//
// State-change contract: these functions do NOT mutate shield charge counts or
// pair.shieldGrace flags. They return the OUTCOME plus which pipe the FSM should
// act on (`pipeId` to consume-and-grace, `clearedGraceId` to un-grace). Keeping
// the state deltas in the caller (the FSM) keeps collision math pure and the
// shield/grace bookkeeping observable and testable.
//
// Fatal-collision ordering (Req 3.11, 3.12, 3.13) is a RULE the FSM enforces
// using this module's result: when `outcome === 'fatal'` the simulation must
// stop all flight movement, scoring, and Encounter triggering BEFORE any
// collision animation, and a fatal collision in the same step as an Encounter
// trigger wins (the Encounter does not start). This module reports the fatal
// outcome deterministically from committed simulation state so the FSM can
// apply that ordering; see `FATAL_COLLISION_ORDERING` below.

/**
 * @typedef {Object} Hitbox
 * @property {number} x top-left x, logical px
 * @property {number} y top-left y, logical px
 * @property {number} w width, logical px
 * @property {number} h height, logical px
 */

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
 * @typedef {Object} CollisionResult
 * @property {'none'|'shield'|'fatal'} outcome the collision outcome for the step
 * @property {number|null} pipeId the id of the pair involved in a 'shield' or
 *   'fatal' outcome (the pair to consume a charge for and start grace on, for a
 *   'shield' outcome); null when outcome is 'none'
 * @property {number|null} clearedGraceId the id of a pair whose Shield_Grace has
 *   ended this step because the Hitbox fully cleared it horizontally, or null
 */

/**
 * Documentation handle for the fatal-collision ordering rule the FSM applies
 * using a 'fatal' {@link CollisionResult} (Req 3.11, 3.12, 3.13). Exported so
 * the rule is discoverable and greppable from the collision module that reports
 * the fatal outcome. This module does not itself run animations, award points,
 * or start encounters; it only reports the deterministic outcome.
 * @type {Readonly<{ stopBeforeAnimation: true, noScoringAfterFatal: true, noEncounterAfterFatal: true, collisionWinsSameStepEncounter: true }>}
 */
export const FATAL_COLLISION_ORDERING = Object.freeze({
  // On a fatal collision, stop flight movement, scoring, and encounter
  // triggering BEFORE any collision animation plays (Req 3.11, 3.12).
  stopBeforeAnimation: true,
  noScoringAfterFatal: true,
  noEncounterAfterFatal: true,
  // A fatal collision in the same step as an Encounter trigger wins; the
  // Encounter does not start (Req 3.13).
  collisionWinsSameStepEncounter: true,
});

/**
 * Compute Ghosty's forgiving Hitbox from his CENTER coordinates.
 *
 * The Hitbox is the logical body rect (center ± half body size) inset by
 * config.ghosty.hitboxInset on each side, giving ≈24×31 logical px. It is NEVER
 * derived from the sprite PNG's natural pixels and is NEVER enlarged by hats,
 * spirit decorations, transparent sprite margins, particles, animation, or
 * display scale (Req 3.8, 3.9) — nothing but the ghost's center position and
 * the frozen config feeds this computation.
 *
 * @param {{ x: number, y: number }} ghosty Ghosty with CENTER coords (extra
 *   fields such as vy/prevX/prevY are ignored)
 * @param {{ ghosty: { bodyWidth: number, bodyHeight: number, hitboxInset: number } }} config
 * @returns {Hitbox} top-left + size Hitbox, logical px
 */
export function hitboxFor(ghosty, config) {
  const { bodyWidth, bodyHeight, hitboxInset } = config.ghosty;
  const w = bodyWidth - 2 * hitboxInset;
  const h = bodyHeight - 2 * hitboxInset;
  // Center the (already inset) rect on Ghosty's center. Insetting from both
  // sides of a centered body leaves the rect centered on the same point.
  return {
    x: ghosty.x - w / 2,
    y: ghosty.y - h / 2,
    w,
    h,
  };
}

/**
 * Whether two axis-aligned rects (top-left + size) overlap. Touching edges
 * count as overlap (>=/<=) so a Hitbox exactly grazing a pipe is a contact.
 * @param {Hitbox} a
 * @param {Hitbox} b
 * @returns {boolean}
 */
function rectsOverlap(a, b) {
  return (
    a.x <= b.x + b.w &&
    a.x + a.w >= b.x &&
    a.y <= b.y + b.h &&
    a.y + a.h >= b.y
  );
}

/**
 * Whether a Hitbox horizontally overlaps a pair's span [x, x+width].
 * @param {Hitbox} box
 * @param {PipePair} pair
 * @param {number} pipeWidth
 * @returns {boolean}
 */
function overlapsPairHorizontally(box, pair, pipeWidth) {
  return box.x <= pair.x + pipeWidth && box.x + box.w >= pair.x;
}

/**
 * Whether a Hitbox has FULLY cleared a pair horizontally (no horizontal
 * overlap at all). Used to end Shield_Grace (Req 3.3): grace ends only once the
 * Hitbox is entirely past (or entirely before) the pair's [x, x+width] span.
 * @param {Hitbox} box
 * @param {PipePair} pair
 * @param {number} pipeWidth
 * @returns {boolean}
 */
function fullyClearedHorizontally(box, pair, pipeWidth) {
  return !overlapsPairHorizontally(box, pair, pipeWidth);
}

/**
 * Whether a Hitbox at a given horizontal overlap vertically hits a SOLID part
 * of the pair — i.e. it is NOT fully contained within the Gap. The Gap spans
 * [gapCenter - gapHeight/2, gapCenter + gapHeight/2]; the Hitbox is safe only if
 * it lies strictly within that opening.
 * @param {Hitbox} box
 * @param {PipePair} pair
 * @returns {boolean}
 */
function hitsSolidVertically(box, pair) {
  const half = pair.gapHeight / 2;
  const gapTop = pair.gapCenter - half;
  const gapBottom = pair.gapCenter + half;
  const insideGap = box.y >= gapTop && box.y + box.h <= gapBottom;
  return !insideGap;
}

/**
 * Whether a Hitbox at `box` overlaps a SOLID part of `pair` (horizontal span
 * AND vertical solid). This is the per-sample overlap test used by the sweep.
 * @param {Hitbox} box
 * @param {PipePair} pair
 * @param {number} pipeWidth
 * @returns {boolean}
 */
function boxOverlapsPairSolid(box, pair, pipeWidth) {
  const solidTop = { x: pair.x, y: -Infinity, w: pipeWidth, h: Infinity };
  // Cheap reject on horizontal span first, then the vertical solid test.
  if (!overlapsPairHorizontally(box, pair, pipeWidth)) return false;
  // Horizontal overlap confirmed; a rect test on the full column plus the gap
  // carve-out is equivalent to: horizontally overlapping AND not inside the gap.
  void solidTop;
  return hitsSolidVertically(box, pair);
}

/**
 * Perform a SWEPT collision check for one simulation step so a Pipe_Pair can
 * never be tunneled at any scroll speed up to the configured maximum (Req 3.10).
 *
 * Both Ghosty and the pipes move during the step. `prevBox`/`currBox` are the
 * Hitbox at the START and END of the committed simulation step. The `pipes`
 * array is the pairs at the END of the step (their committed positions). To
 * account for the pipes having scrolled left across the step, we reconstruct
 * each pair's START-of-step x from `scrollDistance` (how far pipes moved left
 * this step) and sample the RELATIVE motion between the Hitbox and the pair
 * along the step at fine sub-steps. Sampling density is derived from the worst-
 * case relative speed so the step is covered densely enough that no gap can be
 * skipped — at the real FIXED_DT and max speed this is only a couple of pixels,
 * but the sampler scales up for arbitrarily large synthetic steps too.
 *
 * Outcome precedence within the step:
 *   1. The FIRST sampled overlap that is NOT excused by Shield_Grace decides the
 *      outcome: 'fatal' if no shield charge is available, else 'shield' (the
 *      caller consumes one charge and starts grace for that `pipeId`).
 *   2. An overlap with the pair currently under Shield_Grace (`graceId`) is
 *      ignored (non-fatal), per Req 3.3; all OTHER pairs stay fatal (Req 3.4).
 *   3. If no un-excused overlap occurs, outcome is 'none'. Independently, if the
 *      grace pair is fully cleared horizontally by END of the step, its id is
 *      reported as `clearedGraceId` so the caller ends that grace (Req 3.3).
 *
 * Note: a single-shield cap means `shield` is effectively 0 or 1, but the check
 * only distinguishes "has a charge" from "has none", so any non-negative count
 * works.
 *
 * @param {Hitbox} prevBox Hitbox at the start of the step
 * @param {Hitbox} currBox Hitbox at the end of the step
 * @param {PipePair[]} pipes pairs at the END of the step (committed positions)
 * @param {number} shield available shield charges (0 or 1 in the first release)
 * @param {number|null} graceId id of the pair currently under Shield_Grace, or null
 * @param {{ pipe: { width: number }, scroll?: { max?: number } }} config
 * @param {{ scrollDistance?: number }} [motion] how far pipes moved LEFT this
 *   step (logical px); defaults to 0 (pipes stationary relative to the world).
 *   When provided, pipe START x = pair.x + scrollDistance (they scrolled left).
 * @returns {CollisionResult}
 */
export function sweptHitboxVsPipes(
  prevBox,
  currBox,
  pipes,
  shield,
  graceId,
  config,
  motion = {},
) {
  const pipeWidth = config.pipe.width;
  const scrollDistance =
    motion && Number.isFinite(motion.scrollDistance)
      ? motion.scrollDistance
      : 0;

  const hasShield = shield > 0;

  // Determine how many samples cover the step without skipping an overlap.
  // The worst-case RELATIVE horizontal travel is the Hitbox's own travel plus
  // the pipes' travel (they move opposite ways in the relative frame). Vertical
  // travel is the Hitbox's own. We require samples spaced at most ~1 px along
  // the larger of the two relative displacements, with a sane floor.
  const dxBox = currBox.x - prevBox.x;
  const dyBox = currBox.y - prevBox.y;
  // In the pair's start→end frame, relative horizontal motion combines Ghosty's
  // dx with the pipes closing in by `scrollDistance`.
  const relHoriz = Math.abs(dxBox) + Math.abs(scrollDistance);
  const relVert = Math.abs(dyBox);
  const maxTravel = Math.max(relHoriz, relVert);
  // One sample per ~1 logical px of the largest relative displacement; at least
  // 1 sub-step. Cap the count generously so pathological synthetic inputs can't
  // blow up, while still being far denser than any real FIXED_DT step needs.
  const samples = Math.min(
    100000,
    Math.max(1, Math.ceil(maxTravel) + 1),
  );

  let clearedGraceId = null;

  // If a grace pair exists, decide up-front whether it is fully cleared by the
  // END of the step; report that regardless of any other outcome so the caller
  // can end the grace. (The pair's committed END x is pair.x.)
  if (graceId != null) {
    const gracePair = pipes.find((p) => p.id === graceId);
    if (gracePair && fullyClearedHorizontally(currBox, gracePair, pipeWidth)) {
      clearedGraceId = graceId;
    }
  }

  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples; // 0 → start, 1 → end
    // Hitbox sampled along its own motion.
    const box = {
      x: prevBox.x + dxBox * t,
      y: prevBox.y + dyBox * t,
      w: currBox.w,
      h: currBox.h,
    };
    // Each pair sampled along ITS motion: it ends at pair.x and started at
    // pair.x + scrollDistance (pipes scroll leftward), so at fraction t its left
    // edge is start + (end - start) * t = pair.x + scrollDistance * (1 - t).
    for (const pair of pipes) {
      const sampledPair = {
        x: pair.x + scrollDistance * (1 - t),
        gapCenter: pair.gapCenter,
        gapHeight: pair.gapHeight,
      };
      if (!boxOverlapsPairSolid(box, sampledPair, pipeWidth)) continue;

      // Overlap detected. If this pair is the one under Shield_Grace, it is
      // non-fatal (Req 3.3) — ignore it and keep sampling.
      if (graceId != null && pair.id === graceId) continue;

      // An un-excused overlap: shield decides the outcome.
      if (hasShield) {
        return { outcome: 'shield', pipeId: pair.id, clearedGraceId };
      }
      return { outcome: 'fatal', pipeId: pair.id, clearedGraceId };
    }
  }

  return { outcome: 'none', pipeId: null, clearedGraceId };
}

/**
 * Whether a Hitbox reaches or crosses the Ground (bottom) or the Ceiling (top).
 * Ground and Ceiling are ALWAYS fatal, even when a Shield charge is available
 * (Req 3.5, 3.6) — the Shield only ever excuses a pipe collision, never a
 * boundary collision (Req 3.7).
 *
 * The Ceiling is y = 0 (top of the playfield); the Ground is
 * y = config.playfield.height (bottom). Touching counts (<=/>=).
 *
 * @param {Hitbox} box the Hitbox (top-left + size)
 * @param {{ playfield: { height: number } }} config
 * @returns {boolean} true if the box is at/over the Ground or Ceiling
 */
export function groundCeilingFatal(box, config) {
  const { height } = config.playfield;
  const hitsCeiling = box.y <= 0;
  const hitsGround = box.y + box.h >= height;
  return hitsCeiling || hitsGround;
}

export default sweptHitboxVsPipes;
