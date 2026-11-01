// systems/spawner.js — the obstacle spawner and bounded difficulty curve.
//
// Pure logic (no DOM): takes the current pipe list plus config/RNG and returns
// a new pipe list. All randomness is drawn from the seeded RNG passed in (see
// rng.js) so a given seed replays an identical Run; never use Math.random here.
//
// Coordinate convention: a PipePair's `x` is its LEFT edge in logical px. Pipes
// move right-to-left. The gap is vertically centered on `gapCenter` and spans
// `gapHeight`. Ground is y = 0 at the top of the measured clearance and the
// Ceiling is y = config.playfield.height; clearance is measured from both.
//
// Difficulty is bounded and progressive (Req 2.2, 2.3): the scroll speed steps
// up at fixed Active_Flight_Time milestones and is capped at a maximum, but the
// HORIZONTAL SPACING between pairs stays constant regardless of speed (Req 2.4)
// — spacing is a distance, not a time, so faster scrolling simply brings pairs
// past sooner without packing them closer.

/**
 * @typedef {Object} PipePair
 * @property {number} id          unique id for this pair
 * @property {number} x           left edge, logical px
 * @property {number} gapCenter   gap center y, logical px
 * @property {number} gapHeight   gap height, logical px (config.pipe.gapHeight)
 * @property {boolean} scored     whether this pair has awarded its point
 * @property {boolean} shieldGrace whether a shield currently excuses this pair
 */

/**
 * Compute the current scroll speed from elapsed Active_Flight_Time.
 *
 * Speed = base + increment × (number of milestones reached), capped at max
 * (Req 2.2, 2.3). A milestone counts as "reached" once activeFlightTime is at
 * or past it, so the result is a non-decreasing step function of time and never
 * exceeds config.scroll.max.
 *
 * @param {number} activeFlightTime elapsed Active_Flight simulation seconds
 * @param {{ scroll: { base: number, increment: number, milestones: number[], max: number } }} config
 * @returns {number} scroll speed in logical px/s
 */
export function currentScrollSpeed(activeFlightTime, config) {
  const { base, increment, milestones, max } = config.scroll;
  let reached = 0;
  for (const milestone of milestones) {
    if (activeFlightTime >= milestone) reached += 1;
  }
  const speed = base + increment * reached;
  return Math.min(speed, max);
}

/**
 * The valid range of gap centers that keeps the FULL gap at least the
 * configured minimum clearance from both the Ground (y = 0) and the Ceiling
 * (y = config.playfield.height) (Req 2.5).
 *
 * @param {{ playfield: { height: number }, pipe: { gapHeight: number, minClearance: number } }} config
 * @returns {{ min: number, max: number }} inclusive gap-center bounds
 */
function gapCenterBounds(config) {
  const { height } = config.playfield;
  const { gapHeight, minClearance } = config.pipe;
  const half = gapHeight / 2;
  const min = minClearance + half;
  const max = height - minClearance - half;
  // If the playfield cannot fit the gap with both clearances, fall back to the
  // vertical center so a pair is still produced rather than an invalid range.
  if (min > max) {
    const mid = height / 2;
    return { min: mid, max: mid };
  }
  return { min, max };
}

/**
 * Choose a gap center for a new Pipe_Pair.
 *
 * The center is drawn uniformly from the intersection of two constraints:
 *   1. The full gap stays at least config.pipe.minClearance from Ground and
 *      Ceiling (Req 2.5).
 *   2. The change from the previous pair's center is at most
 *      config.pipe.maxGapCenterDelta (Req 2.6).
 *
 * Those two constraints together guarantee every generated pair is navigable
 * with Normal_Flap movement alone — no Spirit, Flight_Power, Shield, or item is
 * ever required (Req 2.7). For the first pair of a Run, pass `prevCenter` as
 * null/undefined to draw from the full clearance-bounded range.
 *
 * @param {number|null|undefined} prevCenter previous pair's gap center, or null for the first pair
 * @param {{ next: () => number }} rng seeded RNG; `next()` returns a float in [0, 1)
 * @param {{ playfield: { height: number }, pipe: { gapHeight: number, minClearance: number, maxGapCenterDelta: number } }} config
 * @returns {number} the chosen gap center, logical px
 */
export function placeGap(prevCenter, rng, config) {
  const bounds = gapCenterBounds(config);
  let lo = bounds.min;
  let hi = bounds.max;

  if (prevCenter != null && Number.isFinite(prevCenter)) {
    const { maxGapCenterDelta } = config.pipe;
    // Constrain to within maxGapCenterDelta of the previous center, then clamp
    // back inside the clearance bounds. The intersection is always non-empty
    // because prevCenter itself was clearance-valid, so [prevCenter] alone is a
    // valid fallback point even if the delta window falls entirely outside.
    lo = Math.max(bounds.min, prevCenter - maxGapCenterDelta);
    hi = Math.min(bounds.max, prevCenter + maxGapCenterDelta);
    if (lo > hi) {
      // Delta window and clearance window do not overlap; clamp prevCenter into
      // the clearance range and use that single safe point.
      const clamped = Math.min(bounds.max, Math.max(bounds.min, prevCenter));
      lo = clamped;
      hi = clamped;
    }
  }

  return lo + rng.next() * (hi - lo);
}

/**
 * The x at which the first pair of a Run should appear: just off the right edge
 * of the playfield so it scrolls in rather than popping into view.
 * @param {{ playfield: { width: number } }} config
 * @returns {number}
 */
function firstSpawnX(config) {
  return config.playfield.width;
}

/**
 * Advance the spawner by one simulation step: move existing pipes left, spawn
 * any new pairs that fit at the fixed horizontal spacing, and drop pairs that
 * have fully left the playfield.
 *
 * Movement: each pair's left edge decreases by scrollSpeed × dt (Req 2.1).
 * Spacing: a new pair is spawned whenever the rightmost pair's left edge is at
 * least config.pipe.spacing inside the right edge, so successive left edges are
 * always exactly config.pipe.spacing apart regardless of scroll speed (Req 2.4).
 * Cleanup: a pair whose trailing (right) edge has passed x = 0, the left edge of
 * the Logical_Playfield, is removed so off-screen pipes never accumulate without
 * bound (Req 2.9, 2.10).
 *
 * Pure: returns a new pipes array and the updated lastGapCenter; does not mutate
 * the input list. The RNG IS advanced as a side effect (that is its contract).
 *
 * @param {PipePair[]} pipes current pipe list (left-to-right by x is not required)
 * @param {number} scrollSpeed logical px/s (from {@link currentScrollSpeed})
 * @param {number} dt simulation seconds for this step
 * @param {{ next: () => number }} rng seeded RNG
 * @param {number|null} lastGapCenter previous pair's gap center (null before the first pair)
 * @param {{ playfield: { width: number, height: number }, pipe: { width: number, spacing: number, gapHeight: number, minClearance: number, maxGapCenterDelta: number } }} config
 * @param {{ nextId?: number }} [idState] optional id allocator; defaults to deriving from existing ids
 * @returns {{ pipes: PipePair[], lastGapCenter: number|null }}
 */
export function stepSpawner(
  pipes,
  scrollSpeed,
  dt,
  rng,
  lastGapCenter,
  config,
) {
  const { width: pipeWidth, spacing } = config.pipe;
  const { gapHeight } = config.pipe;

  // 1. Move every pair left by the distance travelled this step.
  const distance = scrollSpeed * dt;
  const moved = pipes.map((p) => ({ ...p, x: p.x - distance }));

  // Determine the next id to allocate: one past the current maximum id.
  let nextId = 0;
  for (const p of moved) {
    if (p.id >= nextId) nextId = p.id + 1;
  }

  // 2. Spawn new pairs to maintain fixed horizontal spacing. We keep spawning
  //    while the rightmost left edge is far enough inside the right edge; this
  //    also bootstraps the first pair when the list is empty.
  let prevCenter = lastGapCenter;
  let rightmostX =
    moved.length === 0 ? -Infinity : Math.max(...moved.map((p) => p.x));

  // Guard against a non-positive spacing (would loop forever); spacing comes
  // from frozen config so this is defensive only.
  if (spacing > 0) {
    // The target x for the next pair: either the first spawn x (empty list) or
    // exactly `spacing` to the right of the current rightmost pair.
    const firstX = firstSpawnX(config);
    while (true) {
      // Decide the x for the next candidate pair: the first spawn x when the
      // list is empty, otherwise exactly `spacing` right of the rightmost pair.
      const spawnX = rightmostX === -Infinity ? firstX : rightmostX + spacing;
      // Only spawn if the pair's left edge would be at or left of the right
      // edge (i.e. it is time for it to exist). Stop once the next pair would
      // sit entirely off to the right.
      if (spawnX > config.playfield.width) break;

      const gapCenter = placeGap(prevCenter, rng, config);
      moved.push({
        id: nextId++,
        x: spawnX,
        gapCenter,
        gapHeight,
        scored: false,
        shieldGrace: false,
      });
      prevCenter = gapCenter;
      rightmostX = spawnX;
    }
  }

  // 3. Remove pairs whose trailing (right) edge has passed the left edge (x=0).
  const survivors = moved.filter((p) => p.x + pipeWidth >= 0);

  return { pipes: survivors, lastGapCenter: prevCenter };
}

export default stepSpawner;
