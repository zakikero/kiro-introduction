// systems/scoring.js — Pipe_Score accrual for fully-passed Pipe_Pairs.
//
// Pure logic (no DOM): takes the committed RunState plus the frozen CONFIG and
// awards exactly one Pipe_Score point per pair once Ghosty's Hitbox has FULLY
// passed that pair's trailing edge, and never double-awards a pair (Req 10.1,
// 10.2). It mutates RunState in place (incrementing `pipeScore` and latching
// each pair's `scored` flag), matching the injectable `stepScoring(runState,
// config)` hook the FSM calls from its flight tick.
//
// Coordinate convention (matches collision.js / spawner.js / config.js):
//   - Ghosty's x/y are CENTER coordinates; the Hitbox is a top-left + size rect
//     derived via `hitboxFor` (center ± half the logical body size, then inset).
//   - A PipePair's `x` is its LEFT edge; it occupies [x, x+width] horizontally,
//     so its TRAILING edge is `x + config.pipe.width`.
//
// "Fully passes the trailing edge" means Ghosty's Hitbox is entirely to the
// right of the whole pair — the Hitbox's LEFT edge is at or past the pair's
// trailing edge (hitbox.x >= pair.x + pipe.width). The per-pair `scored` flag
// (Req 10.2) guards against awarding the same pair twice: once latched true the
// pair can never score again, even on later ticks.
//
// This runs in flight-tick step 5 (after movement, before the scheduler) and
// only in Active_Flight_State, so Pipe_Score advances on the flight clock only
// (the three-clock model). A fatal collision ends the Run before this hook runs
// that step (fatal-collision ordering, Req 3.11), so no point is awarded on the
// fatal step.

import { hitboxFor } from './collision.js';

/**
 * Whether Ghosty's Hitbox has FULLY passed a pair's trailing edge — i.e. the
 * Hitbox is entirely to the right of the pair's [x, x+width] span. This is the
 * single condition that qualifies a pair to award its one point (Req 10.1).
 *
 * @param {{ x: number }} hitbox top-left + size Hitbox (only `x` is read)
 * @param {{ x: number }} pair the PipePair (its `x` is the LEFT edge)
 * @param {{ pipe: { width: number } }} config
 * @returns {boolean} true once hitbox.x >= pair.x + config.pipe.width
 */
export function hasFullyPassed(hitbox, pair, config) {
  const trailingEdge = pair.x + config.pipe.width;
  return hitbox.x >= trailingEdge;
}

/**
 * Award Pipe_Score for every pair Ghosty has fully passed this step, latching
 * each so it never scores twice (Req 10.1, 10.2). Mutates `runState` in place:
 * sets `pair.scored = true` and increments `runState.pipeScore` by exactly one
 * for each newly-passed pair. A pair already marked `scored` is skipped, so the
 * total can never double-award regardless of how many ticks the Hitbox stays
 * past the pair.
 *
 * @param {object} runState the active RunState (its `ghosty`, `pipes`, and
 *   `pipeScore` are read/updated)
 * @param {{ pipe: { width: number }, ghosty: object }} config the frozen CONFIG
 * @returns {void}
 */
export function stepScoring(runState, config) {
  if (!runState || !Array.isArray(runState.pipes)) return;

  const hitbox = hitboxFor(runState.ghosty, config);

  for (const pair of runState.pipes) {
    // The `scored` latch (Req 10.2) is the double-award guard: skip any pair
    // that has already awarded its point.
    if (pair.scored) continue;
    if (hasFullyPassed(hitbox, pair, config)) {
      pair.scored = true; // latch before incrementing so it can never repeat
      runState.pipeScore += 1; // exactly one point per pair (Req 10.1)
    }
  }
}

export default stepScoring;
