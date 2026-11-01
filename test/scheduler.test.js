// test/scheduler.test.js — unit + property tests for the Adventure scheduler.
//
// Exercises src/systems/scheduler.js (pure logic, no DOM):
//   - stepScheduler spawns encounterA / shop1 as Active_Flight_Time crosses the
//     configured first-Encounter / first-Shop thresholds, without freezing
//     flight and without blocking the current safe Gap route (Req 4.2, 4.5,
//     4.10, 4.14, 4.15, 7.4).
//   - Lifecycle: pending → offered on spawn; markEntered / markSkipped move an
//     offered entry to entered / skipped; a skipped/entered symbol never
//     retriggers (Req 4.16, 4.17, 4.18).
//   - Broad-input check: every spawned symbol leaves at least one safe route
//     through the current Gap unobstructed, and no opportunity spawns before
//     its threshold or spawns twice.
//
// Note: the design document assigns no numbered correctness Property to the
// scheduler's safe-route/lifecycle behavior (Property 8 is the collision suite's
// "Fatal unshielded pipe contact"), and task 2.1 is an implementation task, not
// a PBT task. The fast-check case below is therefore an UNNUMBERED broad-input
// unit check — it is deliberately NOT tagged with the project's
// `Property {n}: ...` convention so it does not claim a design-doc property.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import {
  stepScheduler,
  markEntered,
  markSkipped,
  Lifecycle,
} from "../src/systems/scheduler.js";
import { fc, assertProperty } from "../test-support/helpers.js";

// A minimal ScheduleProgress like the one state.js builds.
function freshProgress() {
  return {
    encounterA: { id: 0, state: Lifecycle.pending, spawned: false },
    shop1: { id: 1, state: Lifecycle.pending, spawned: false },
    encounterB: { id: 2, state: Lifecycle.pending, spawned: false },
    shop2: { id: 3, state: Lifecycle.pending, spawned: false },
    bossPresented: false,
  };
}

// A minimal RunState with just the flight-world fields the scheduler reads.
function freshRunState(pipes = []) {
  return {
    activeFlightTime: 0,
    pipes,
    symbols: [],
    ghosty: { x: 160, y: 320, vy: 0, prevX: 160, prevY: 320 },
  };
}

// Whether a symbol leaves at least one safe vertical route through `pair`'s Gap:
// the symbol's body must not cover the entire Gap opening — some part of the Gap
// (top or bottom) stays clear for Normal_Flap navigation.
function leavesSafeRoute(symbol, pair) {
  const half = pair.gapHeight / 2;
  const gapTop = pair.gapCenter - half;
  const gapBottom = pair.gapCenter + half;
  const symTop = symbol.y - symbol.h / 2;
  const symBottom = symbol.y + symbol.h / 2;
  // Clear space above the symbol within the Gap, or below it within the Gap.
  const clearAbove = symTop - gapTop;
  const clearBelow = gapBottom - symBottom;
  return clearAbove > 0 || clearBelow > 0;
}

// --- Unit: spawning on threshold crossing -----------------------------------

test("stepScheduler spawns nothing before the first-Encounter threshold", () => {
  const progress = freshProgress();
  const runState = freshRunState();
  const res = stepScheduler(
    progress,
    runState,
    CONFIG.triggers.firstEncounter - 0.001,
    CONFIG,
  );
  assert.equal(res.spawned.length, 0);
  assert.equal(runState.symbols.length, 0);
  assert.equal(progress.encounterA.state, Lifecycle.pending);
  assert.equal(progress.encounterA.spawned, false);
});

test("stepScheduler spawns encounterA at the first-Encounter threshold", () => {
  const progress = freshProgress();
  const runState = freshRunState();
  const res = stepScheduler(
    progress,
    runState,
    CONFIG.triggers.firstEncounter,
    CONFIG,
  );
  assert.equal(res.spawned.length, 1);
  const sym = res.spawned[0];
  assert.equal(sym.key, "encounterA");
  assert.equal(sym.kind, "enemy");
  assert.equal(sym.enemyType, "A"); // configured first Enemy type (Req 4.10)
  assert.equal(runState.symbols.length, 1);
  assert.equal(progress.encounterA.state, Lifecycle.offered); // Req 4.17/4.18
  assert.equal(progress.encounterA.spawned, true);
  // shop1 is still pending (its threshold is later).
  assert.equal(progress.shop1.state, Lifecycle.pending);
});

test("stepScheduler spawns shop1 at the first-Shop threshold", () => {
  const progress = freshProgress();
  const runState = freshRunState();
  // Past both thresholds at once: both encounterA and shop1 spawn.
  const res = stepScheduler(
    progress,
    runState,
    CONFIG.triggers.firstShop,
    CONFIG,
  );
  const keys = res.spawned.map((s) => s.key).sort();
  assert.deepEqual(keys, ["encounterA", "shop1"]);
  assert.equal(progress.shop1.state, Lifecycle.offered);
  assert.equal(progress.shop1.kind === undefined, true); // kind lives on the symbol, not the entry
  const shopSym = runState.symbols.find((s) => s.key === "shop1");
  assert.equal(shopSym.kind, "shop");
});

test("stepScheduler does not re-spawn an already offered opportunity", () => {
  const progress = freshProgress();
  const runState = freshRunState();
  stepScheduler(progress, runState, CONFIG.triggers.firstEncounter, CONFIG);
  assert.equal(runState.symbols.length, 1);
  // Call again, well past the threshold — must NOT spawn a duplicate.
  const res = stepScheduler(
    progress,
    runState,
    CONFIG.triggers.firstEncounter + 10,
    CONFIG,
  );
  assert.equal(res.spawned.length, 0);
  assert.equal(runState.symbols.length, 1);
});

test("stepScheduler does not freeze flight: it only mutates symbols/progress", () => {
  const progress = freshProgress();
  const runState = freshRunState();
  const ghostyBefore = { ...runState.ghosty };
  const pipesRef = runState.pipes;
  stepScheduler(progress, runState, CONFIG.triggers.firstEncounter, CONFIG);
  // Ghosty untouched, pipes array reference untouched (no state transition here).
  assert.deepEqual(runState.ghosty, ghostyBefore);
  assert.equal(runState.pipes, pipesRef);
});

// --- Unit: lifecycle transitions --------------------------------------------

test("markEntered moves an offered entry to entered and removes its symbol", () => {
  const progress = freshProgress();
  const runState = freshRunState();
  stepScheduler(progress, runState, CONFIG.triggers.firstEncounter, CONFIG);
  const ok = markEntered(progress, "encounterA", runState);
  assert.equal(ok, true);
  assert.equal(progress.encounterA.state, Lifecycle.entered);
  assert.equal(
    runState.symbols.some((s) => s.key === "encounterA"),
    false,
  );
});

test("markSkipped moves an offered entry to skipped and it never retriggers", () => {
  const progress = freshProgress();
  const runState = freshRunState();
  stepScheduler(progress, runState, CONFIG.triggers.firstEncounter, CONFIG);
  const ok = markSkipped(progress, "encounterA", runState);
  assert.equal(ok, true);
  assert.equal(progress.encounterA.state, Lifecycle.skipped);
  assert.equal(
    runState.symbols.some((s) => s.key === "encounterA"),
    false,
  );

  // Re-running the scheduler far past the threshold must NOT re-spawn it.
  const res = stepScheduler(
    progress,
    runState,
    CONFIG.triggers.firstEncounter + 50,
    CONFIG,
  );
  assert.equal(
    res.spawned.some((s) => s.key === "encounterA"),
    false,
  );
  assert.equal(progress.encounterA.state, Lifecycle.skipped);
});

test("markEntered / markSkipped are no-ops unless the entry is offered", () => {
  const progress = freshProgress();
  // pending → cannot enter or skip.
  assert.equal(markEntered(progress, "encounterA"), false);
  assert.equal(markSkipped(progress, "encounterA"), false);
  assert.equal(progress.encounterA.state, Lifecycle.pending);

  // Once skipped, it cannot be re-entered (never retriggers).
  progress.shop1.state = Lifecycle.offered;
  assert.equal(markSkipped(progress, "shop1"), true);
  assert.equal(markEntered(progress, "shop1"), false);
  assert.equal(progress.shop1.state, Lifecycle.skipped);
});

// --- Unit: the full schedule (encounterB, shop2) and the Final_Boss ----------

test("stepScheduler spawns encounterB (type B) at the second-Enemy threshold", () => {
  const progress = freshProgress();
  const runState = freshRunState();
  // Advance past the first pair of triggers so they are already offered, then
  // reach the second-Enemy trigger.
  stepScheduler(progress, runState, CONFIG.triggers.firstShop, CONFIG);
  const res = stepScheduler(
    progress,
    runState,
    CONFIG.triggers.secondEnemy,
    CONFIG,
  );
  const sym = res.spawned.find((s) => s.key === "encounterB");
  assert.ok(sym, "encounterB should spawn at its threshold");
  assert.equal(sym.kind, "enemy");
  assert.equal(sym.enemyType, "B"); // the OTHER ordinary enemy type (Req 4.11)
  assert.equal(progress.encounterB.state, Lifecycle.offered);
  assert.equal(progress.encounterB.spawned, true);
  // shop2 is still pending (its threshold is later).
  assert.equal(progress.shop2.state, Lifecycle.pending);
});

test("stepScheduler spawns shop2 at the second-Shop threshold", () => {
  const progress = freshProgress();
  const runState = freshRunState();
  const res = stepScheduler(
    progress,
    runState,
    CONFIG.triggers.secondShop,
    CONFIG,
  );
  // By the second-Shop trigger all four optional opportunities are offered.
  const keys = res.spawned.map((s) => s.key).sort();
  assert.deepEqual(keys, ["encounterA", "encounterB", "shop1", "shop2"]);
  assert.equal(progress.shop2.state, Lifecycle.offered);
  const shopSym = runState.symbols.find((s) => s.key === "shop2");
  assert.equal(shopSym.kind, "shop");
});

test("second-Enemy and second-Shop triggers fall strictly between first-Shop and boss (Req 4.13)", () => {
  const { firstShop, secondEnemy, secondShop, boss } = CONFIG.triggers;
  assert.ok(firstShop < secondEnemy, "secondEnemy after firstShop");
  assert.ok(secondEnemy < secondShop, "secondShop after secondEnemy");
  assert.ok(secondShop < boss, "secondShop before boss");
});

test("stepScheduler presents the boss at a safe checkpoint when the boss trigger is crossed (Req 4.3)", () => {
  const progress = freshProgress();
  // A valid pair near Ghosty so selectCheckpoint produces a concrete gap-centered spot.
  const pair = {
    id: 0,
    x: 300,
    gapCenter: 320,
    gapHeight: CONFIG.pipe.gapHeight,
    scored: false,
    shieldGrace: false,
  };
  const runState = freshRunState([pair]);

  // Just before the boss trigger: not presented.
  let res = stepScheduler(
    progress,
    runState,
    CONFIG.triggers.boss - 0.001,
    CONFIG,
  );
  assert.equal(res.bossPresented, false);
  assert.equal(res.bossCheckpoint, null);
  assert.equal(progress.bossPresented, false);

  // At the boss trigger: presented once, at a safe checkpoint.
  res = stepScheduler(progress, runState, CONFIG.triggers.boss, CONFIG);
  assert.equal(res.bossPresented, true);
  assert.ok(res.bossCheckpoint, "a boss checkpoint should be returned");
  assert.equal(res.bossCheckpoint.vy, 0); // Req 9.14 vy = 0 at checkpoint
  assert.equal(typeof res.bossCheckpoint.x, "number");
  assert.equal(typeof res.bossCheckpoint.y, "number");
  assert.equal(progress.bossPresented, true);
  // The boss is NOT a scrolling avoidable symbol.
  assert.equal(
    runState.symbols.some((s) => s.key === "boss"),
    false,
  );
});

test("stepScheduler presents the boss exactly once (latched)", () => {
  const progress = freshProgress();
  const runState = freshRunState();
  const first = stepScheduler(progress, runState, CONFIG.triggers.boss, CONFIG);
  assert.equal(first.bossPresented, true);
  // Call again well past the trigger: must NOT re-present.
  const second = stepScheduler(
    progress,
    runState,
    CONFIG.triggers.boss + 30,
    CONFIG,
  );
  assert.equal(second.bossPresented, false);
  assert.equal(second.bossCheckpoint, null);
  assert.equal(progress.bossPresented, true);
});

// --- Broad-input check: spawned symbols keep a safe route; spawn is bounded --
// (Unnumbered — see the file header note. Covers Req 4.14, 4.15, 7.4.)

test("stepScheduler: spawned opportunities are optional and never block the safe Gap route", () => {
  const { firstEncounter, firstShop } = CONFIG.triggers;

  assertProperty(
    fc.property(
      // A pipe set straddling the spawn column so there is always a reference
      // pair for placement; gapCenter stays within clearance-valid bounds.
      fc.double({
        min: CONFIG.pipe.minClearance + CONFIG.pipe.gapHeight / 2,
        max:
          CONFIG.playfield.height -
          CONFIG.pipe.minClearance -
          CONFIG.pipe.gapHeight / 2,
        noNaN: true,
      }),
      // Active_Flight_Time swept across and past every trigger incl. the boss.
      fc.double({ min: 0, max: CONFIG.triggers.boss + 30, noNaN: true }),
      (gapCenter, t) => {
        const pair = {
          id: 0,
          x: CONFIG.playfield.width - 10, // near the spawn column
          gapCenter,
          gapHeight: CONFIG.pipe.gapHeight,
          scored: false,
          shieldGrace: false,
        };
        const progress = freshProgress();
        const runState = freshRunState([pair]);

        const res = stepScheduler(progress, runState, t, CONFIG);

        // No opportunity spawns before its threshold.
        if (t < firstEncounter) {
          assert.equal(res.spawned.length, 0);
        }

        // Every symbol in the world leaves a safe route through the Gap and
        // carries a valid lifecycle entry marked offered.
        for (const sym of runState.symbols) {
          assert.ok(
            leavesSafeRoute(sym, pair),
            `symbol ${sym.key} blocks the whole Gap route`,
          );
          assert.equal(progress[sym.key].state, Lifecycle.offered);
          assert.equal(progress[sym.key].spawned, true);
        }

        // Spawning is bounded: at most one symbol per OPTIONAL SCHEDULE
        // opportunity (encounterA, shop1, encounterB, shop2), and never
        // duplicated. The boss is required and never spawns as a symbol.
        assert.ok(runState.symbols.length <= 4);
        assert.equal(
          runState.symbols.some((s) => s.key === "boss"),
          false,
        );
        const keys = runState.symbols.map((s) => s.key);
        assert.equal(new Set(keys).size, keys.length);

        // Running the step again at the same time must not add duplicates.
        const before = runState.symbols.length;
        stepScheduler(progress, runState, t, CONFIG);
        assert.equal(runState.symbols.length, before);

        return true;
      },
    ),
  );
});
