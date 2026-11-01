// systems/scheduler.js — the Adventure scheduler and optional-entrance lifecycle.
//
// Pure logic (no DOM): takes the Run's ScheduleProgress plus the RunState, the
// elapsed Active_Flight_Time, and the frozen CONFIG, and SPAWNS avoidable
// optional opportunities into the flight world as Active_Flight_Time crosses
// the configured thresholds. This file covers the FULL Adventure schedule: the
// first Encounter (`encounterA`, the first ordinary Enemy type) and the first
// Shop (`shop1`), the second Encounter (`encounterB`, the OTHER ordinary Enemy
// type) and the second Shop (`shop2`), and the required Final_Boss presentation.
//
// Boss presentation (Req 4.3, 4.8): the Final_Boss is REQUIRED, not optional,
// so it is NOT a scrolling avoidable symbol and has no offered/skipped
// lifecycle. When Active_Flight_Time crosses the configured `boss` trigger the
// scheduler presents the boss at a SAFE CHECKPOINT (reusing
// systems/checkpoint.js `selectCheckpoint`), latches `progress.bossPresented =
// true` so it fires exactly once, and signals the presentation to the caller
// via the returned `bossPresented`/`bossCheckpoint` fields. The FSM then drives
// the transition into Battle_State against the boss.
//
// Spawning does NOT freeze flight (Req 4.15, 7.4): a crossed threshold only
// places an avoidable symbol into the world and marks its LifecycleEntry
// `offered`. Flight keeps running; pipes keep moving; Active_Flight_Time keeps
// accruing. Only CONTACT or an explicit interaction later promotes the entry to
// `entered` (the FSM then transitions to Battle_State / Shop_State and freezes
// flight) — see `markEntered`. Passing a symbol without interacting marks it
// `skipped` so it never retriggers — see `markSkipped`.
//
// Coordinate convention (matches spawner.js / collision.js / config.js):
//   - Ghosty's x/y are CENTER coordinates in logical px.
//   - A symbol's `x`/`y` are CENTER coordinates too; it has a `w`/`h` so the
//     FSM/renderer can build a top-left rect for contact tests and drawing.
//   - A symbol spawns off the right edge of the Logical_Playfield and scrolls
//     left with the world (the FSM moves it alongside the pipes), so it is
//     avoidable: the Player can simply not touch it.
//
// Safe-route guarantee (Req 4.14, 1.8): a symbol is positioned so at least one
// safe route through the CURRENT Gap stays unobstructed. We place the symbol to
// one side of the active pair's Gap center — never spanning the whole Gap — so
// the navigable opening through the pipes is never blocked by the opportunity.
// Placement reads the live pipe set; if no pair is near the spawn column it
// falls back to the playfield's vertical center, which is always clear because
// generated Gaps keep the configured minimum clearance from Ground and Ceiling.

/**
 * The lifecycle a single optional opportunity moves through (design Data
 * Models, Req 4.17, 4.18):
 *   pending   → not yet reached its threshold (initial)
 *   offered   → spawned into the flight world and avoidable
 *   entered   → contacted / explicitly interacted with (FSM enters Battle/Shop)
 *   completed → the Battle/Shop it led to has finished (set by later milestones)
 *   skipped   → passed without interacting; never retriggers
 * @readonly
 * @enum {string}
 */
import { selectCheckpoint } from "./checkpoint.js";

export const Lifecycle = Object.freeze({
  pending: "pending",
  offered: "offered",
  entered: "entered",
  completed: "completed",
  skipped: "skipped",
});

/**
 * The full set of OPTIONAL scheduled opportunities, each paired with the kind of
 * symbol it spawns and the config trigger (seconds of Active_Flight_Time) that
 * releases it:
 *   - `encounterA` — the first optional Enemy symbol, the configured FIRST
 *     ordinary Enemy type 'A' (the Storm_Bat enemy), Req 4.10;
 *   - `shop1` — the first avoidable Shop entrance (Req 4.2, 7.4);
 *   - `encounterB` — the second optional Enemy symbol, the OTHER ordinary Enemy
 *     type 'B' (the Pumpkin_Guardian enemy), at the configured second-Enemy
 *     trigger, so each ordinary type is presented at least once before the boss
 *     (Req 4.11);
 *   - `shop2` — the second avoidable Shop entrance, at the configured
 *     second-Shop trigger, after the first Battle-and-Shop loop (Req 4.12).
 *
 * The second-Enemy and second-Shop triggers sit strictly after the first-Shop
 * trigger and strictly before the boss trigger (Req 4.13); that ordering lives
 * in config.triggers (firstShop=35 < secondEnemy=60 < secondShop=85 < boss=120)
 * and is preserved here simply by driving off those config values.
 *
 * The Final_Boss is REQUIRED and is NOT in this table — it is not an avoidable
 * scrolling symbol with an offered/skipped lifecycle. It is presented at a safe
 * checkpoint by {@link stepScheduler} via `progress.bossPresented` (Req 4.3).
 *
 * Keeping the table data-driven means the stepping logic does not grow a branch
 * per opportunity. `triggerKey` names the field under `config.triggers`; the
 * value is the Active_Flight_Time (seconds) at which the opportunity is offered.
 * @type {ReadonlyArray<{ key: string, kind: 'enemy'|'shop', triggerKey: string, enemyType?: string }>}
 */
const SCHEDULE = Object.freeze([
  {
    key: "encounterA",
    kind: "enemy",
    triggerKey: "firstEncounter",
    enemyType: "A",
  },
  { key: "shop1", kind: "shop", triggerKey: "firstShop" },
  {
    key: "encounterB",
    kind: "enemy",
    triggerKey: "secondEnemy",
    enemyType: "B",
  },
  { key: "shop2", kind: "shop", triggerKey: "secondShop" },
]);

/**
 * Find the Pipe_Pair whose horizontal span is nearest the spawn column so the
 * symbol can be offset from that pair's Gap center and never block the safe
 * route through it (Req 4.14). Prefers a pair the spawn column already overlaps;
 * otherwise picks the pair whose center is closest to the spawn column.
 *
 * @param {Array<{ x: number, gapCenter: number, gapHeight: number }>} pipes
 * @param {number} spawnX the symbol's spawn column (CENTER x), logical px
 * @param {number} pipeWidth config.pipe.width
 * @returns {{ gapCenter: number, gapHeight: number }|null} the reference pair, or null
 */
function nearestPairForSpawn(pipes, spawnX, pipeWidth) {
  if (!Array.isArray(pipes) || pipes.length === 0) return null;
  let best = null;
  let bestDist = Infinity;
  for (const p of pipes) {
    const left = p.x;
    const right = p.x + pipeWidth;
    // Distance from the spawn column to the pair's horizontal span (0 if inside).
    const dist =
      spawnX < left ? left - spawnX : spawnX > right ? spawnX - right : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/**
 * Choose a vertical CENTER for a newly spawned symbol so that at least one safe
 * route through the current Gap remains unobstructed (Req 4.14, 1.8).
 *
 * The symbol is offset toward one edge of the reference pair's Gap so the OTHER
 * side of the Gap is always a clear path through the pipes. The offset keeps the
 * symbol's own body fully inside the Gap opening (so it reads as "in the Gap,
 * off to the side"), while leaving a Normal_Flap-navigable opening next to it.
 * With no nearby pair, the symbol sits at the playfield's vertical center, which
 * is always clear of Ground/Ceiling given the configured clearances.
 *
 * @param {{ gapCenter: number, gapHeight: number }|null} pair reference pair, or null
 * @param {number} symbolHeight the symbol's logical height
 * @param {{ playfield: { height: number } }} config
 * @returns {number} the chosen CENTER y, logical px
 */
function placeSymbolY(pair, symbolHeight, config) {
  if (!pair) {
    return config.playfield.height / 2;
  }
  const half = pair.gapHeight / 2;
  const gapTop = pair.gapCenter - half;
  const gapBottom = pair.gapCenter + half;
  // Offset toward the TOP edge of the Gap, keeping the symbol's body inside the
  // opening so the bottom portion of the Gap stays an unobstructed safe route.
  const offset = Math.min(symbolHeight, half);
  let center = gapTop + offset;
  // Clamp so the whole symbol stays within the Gap opening.
  const minCenter = gapTop + symbolHeight / 2;
  const maxCenter = gapBottom - symbolHeight / 2;
  if (minCenter <= maxCenter) {
    center = Math.min(Math.max(center, minCenter), maxCenter);
  } else {
    center = pair.gapCenter; // Gap too small for the symbol; fall back to center
  }
  return center;
}

/**
 * Build a flight-world symbol for an offered opportunity. The symbol carries
 * everything the FSM/renderer needs to scroll it, test contact, and draw it —
 * without any DOM: a stable `key`, its `kind` (`'enemy'`/`'shop'`), optional
 * `enemyType`, CENTER `x`/`y`, and body `w`/`h`.
 *
 * It spawns just off the right edge so it scrolls in rather than popping into
 * view, mirroring how the spawner introduces the first Pipe_Pair.
 *
 * @param {{ key: string, kind: string, enemyType?: string }} item the SCHEDULE entry
 * @param {Array} pipes the live pipe set (read-only) for safe placement
 * @param {object} config the frozen CONFIG
 * @returns {object} a new symbol object for runState.symbols
 */
function makeSymbol(item, pipes, config) {
  // Size the symbol off the pipe width so it reads clearly but never spans the
  // whole Gap; a square-ish body derived from config keeps it config-driven.
  const w = config.pipe.width;
  const h = config.pipe.width;
  const spawnX = config.playfield.width + w / 2; // CENTER just off the right edge
  const pair = nearestPairForSpawn(pipes, spawnX, config.pipe.width);
  const y = placeSymbolY(pair, h, config);
  return {
    key: item.key, // links the symbol to its ScheduleProgress LifecycleEntry
    kind: item.kind, // 'enemy' | 'shop'
    enemyType: item.enemyType || null, // 'A' first Encounter / 'B' second Encounter
    x: spawnX, // CENTER x, logical px
    y, // CENTER y, logical px
    w,
    h,
  };
}

/**
 * Advance the Adventure scheduler by one flight-simulation step. For every
 * opportunity in the SCHEDULE whose configured threshold has been reached AND
 * that is still `pending`, spawn an avoidable symbol into `runState.symbols`,
 * mark its LifecycleEntry `offered`, and set `spawned = true`. Spawning NEVER
 * freezes flight (Req 4.15, 7.4) and NEVER blocks the current safe Gap route
 * (Req 4.14) — placement is handled by {@link makeSymbol}.
 *
 * Pure-ish: mutates `progress` and `runState` in place (matching the FSM's
 * fire-and-forget call), and also returns `{ progress, spawned }` so callers and
 * tests can see whether anything spawned this step. Idempotent per opportunity:
 * because only a `pending` entry spawns, repeated calls after the threshold do
 * not re-spawn a symbol (no duplicates, no retrigger).
 *
 * @param {object} progress the Run's ScheduleProgress (mutated)
 * @param {object} runState the active RunState; `runState.symbols` is created if
 *   absent and appended to (mutated)
 * @param {number} activeFlightTime elapsed Active_Flight simulation seconds
 * Boss presentation (Req 4.3, 4.8): when Active_Flight_Time reaches the
 * configured `boss` trigger AND the boss has not yet been presented, the boss is
 * presented at a SAFE CHECKPOINT (via {@link selectCheckpoint}) rather than as
 * an avoidable scrolling symbol. The latch `progress.bossPresented` is set true
 * so it fires exactly once, and the step signals it to the caller through the
 * returned `bossPresented` flag and `bossCheckpoint` ({ x, y, vy: 0 }); the FSM
 * uses those to transition into the Battle_State against the boss.
 *
 * @param {{ triggers: Record<string, number>, pipe: { width: number }, playfield: { width: number, height: number } }} config
 * @returns {{ progress: object, spawned: object[], bossPresented: boolean, bossCheckpoint: ?{ x: number, y: number, vy: number } }}
 *   the (same) progress, the list of symbols spawned on THIS step (empty when
 *   nothing crossed), whether the boss was presented on THIS step, and the safe
 *   checkpoint it was presented at (null unless presented this step)
 */
export function stepScheduler(progress, runState, activeFlightTime, config) {
  const spawned = [];
  let bossPresented = false;
  let bossCheckpoint = null;
  if (!progress || !runState)
    return { progress, spawned, bossPresented, bossCheckpoint };
  if (!Array.isArray(runState.symbols)) runState.symbols = [];

  for (const item of SCHEDULE) {
    const entry = progress[item.key];
    if (!entry) continue; // unknown opportunity; later milestones may add it
    if (entry.state !== Lifecycle.pending) continue; // already offered/handled
    const threshold = config.triggers[item.triggerKey];
    if (!Number.isFinite(threshold)) continue;
    if (activeFlightTime < threshold) continue; // not yet time

    // Threshold crossed for a still-pending opportunity: spawn it, avoidably,
    // without freezing flight (Req 4.15, 7.4).
    const symbol = makeSymbol(item, runState.pipes, config);
    runState.symbols.push(symbol);
    entry.spawned = true;
    entry.state = Lifecycle.offered; // Req 4.17, 4.18 lifecycle entry point
    spawned.push(symbol);
  }

  // The Final_Boss (Req 4.3, 4.8). REQUIRED, not optional: it is NOT spawned as
  // an avoidable scrolling symbol and has no offered/skipped lifecycle — it is
  // presented at a safe checkpoint when its trigger is crossed, exactly once
  // (latched by the boolean `progress.bossPresented`, not a LifecycleEntry).
  const bossTrigger = config.triggers.boss;
  if (
    Number.isFinite(bossTrigger) &&
    activeFlightTime >= bossTrigger &&
    !progress.bossPresented
  ) {
    // Position for the boss presentation at the safe flight checkpoint. This is
    // a pure read of the live flight world; the FSM applies the repositioning
    // (resumeFromCheckpoint) on the actual Battle transition.
    bossCheckpoint = selectCheckpoint(runState, config);
    progress.bossPresented = true; // latch so it presents exactly once
    bossPresented = true;
  }

  return { progress, spawned, bossPresented, bossCheckpoint };
}

/**
 * Mark an opportunity `entered` because Ghosty contacted its symbol or the
 * Player explicitly interacted with it (Req 4.16, 4.17, 4.18). This is the only
 * transition that leads the FSM into Battle_State / Shop_State (which then
 * freezes flight). Only an `offered` entry can be entered — a `skipped`,
 * `entered`, or `completed` entry is left untouched so a symbol never retriggers.
 *
 * Also removes the matching symbol from `runState.symbols` when a RunState is
 * supplied, since an entered opportunity is no longer a loose avoidable symbol
 * in the flight world.
 *
 * @param {object} progress the Run's ScheduleProgress (mutated)
 * @param {string} entranceId the opportunity key (e.g. 'encounterA', 'shop1')
 * @param {object} [runState] optional RunState; its `symbols` is pruned if present
 * @returns {boolean} true if the entry transitioned to `entered`
 */
export function markEntered(progress, entranceId, runState) {
  const entry = progress && progress[entranceId];
  if (!entry || entry.state !== Lifecycle.offered) return false;
  entry.state = Lifecycle.entered;
  removeSymbol(runState, entranceId);
  return true;
}

/**
 * Mark an opportunity `skipped` because Ghosty passed its symbol without
 * interacting (Req 4.17, 4.18). A skipped opportunity never retriggers. Only an
 * `offered` entry can be skipped — once `entered`/`completed`/`skipped` the
 * entry is left untouched so an opportunity already acted on is never downgraded.
 *
 * Also removes the matching symbol from `runState.symbols` when a RunState is
 * supplied, since a skipped symbol has left the playfield.
 *
 * @param {object} progress the Run's ScheduleProgress (mutated)
 * @param {string} entranceId the opportunity key (e.g. 'encounterA', 'shop1')
 * @param {object} [runState] optional RunState; its `symbols` is pruned if present
 * @returns {boolean} true if the entry transitioned to `skipped`
 */
export function markSkipped(progress, entranceId, runState) {
  const entry = progress && progress[entranceId];
  if (!entry || entry.state !== Lifecycle.offered) return false;
  entry.state = Lifecycle.skipped;
  removeSymbol(runState, entranceId);
  return true;
}

/**
 * Remove the flight-world symbol for `key` from a RunState's `symbols` list, if
 * present. Safe to call with a missing RunState or missing list.
 * @param {object|undefined} runState
 * @param {string} key
 * @returns {void}
 */
function removeSymbol(runState, key) {
  if (!runState || !Array.isArray(runState.symbols)) return;
  runState.symbols = runState.symbols.filter((s) => s.key !== key);
}

export default stepScheduler;
