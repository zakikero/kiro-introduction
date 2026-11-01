// test/results.test.js — unit + property tests for the Results_State content
// model (task 4.5, Req 10.5, 10.6).
//
// These exercise ONLY the pure content-building helpers in src/ui/results.js
// (resultsSummary / candyBreakdown / runOutcome / formatDuration). The drawing
// function (drawResults) needs a Canvas and is not called here; it is a thin
// paint of this model. We also assert the FSM records a Run-ending outcome code
// so the summary can report the cause of defeat.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fc, assertProperty } from "../test-support/helpers.js";
import { CONFIG } from "../src/config.js";
import { createFSM, States, createRunState } from "../src/state.js";
import {
  resultsSummary,
  candyBreakdown,
  runOutcome,
  formatDuration,
  ResultsAction,
} from "../src/ui/results.js";

/** A fresh RunState with a few fields set, for content assertions. */
function endedRun(overrides = {}) {
  const rs = createRunState(CONFIG, 1);
  return Object.assign(rs, overrides);
}

// --- candyBreakdown ---------------------------------------------------------

test("candyBreakdown computes floor(time/divisor) with no boss bonus on defeat (Req 10.5, 8.1)", () => {
  const rs = endedRun({ activeFlightTime: 47, bossDefeated: false });
  const b = candyBreakdown(rs, CONFIG);
  assert.equal(b.divisor, CONFIG.candy.perRunDivisor);
  assert.equal(b.timeComponent, Math.floor(47 / CONFIG.candy.perRunDivisor));
  assert.equal(b.bossBonus, 0);
  assert.equal(b.earned, b.timeComponent);
});

test("candyBreakdown adds the boss-victory bonus when the boss was defeated (Req 10.5, 8.2)", () => {
  const rs = endedRun({ activeFlightTime: 120, bossDefeated: true });
  const b = candyBreakdown(rs, CONFIG);
  const expectedTime = Math.floor(120 / CONFIG.candy.perRunDivisor);
  assert.equal(b.timeComponent, expectedTime);
  assert.equal(b.bossBonus, CONFIG.candy.bossVictoryBonus);
  assert.equal(b.earned, expectedTime + CONFIG.candy.bossVictoryBonus);
});

test("candyBreakdown degrades a missing/negative/NaN time to 0 earned", () => {
  for (const t of [undefined, null, -5, NaN, "nope"]) {
    const b = candyBreakdown({ activeFlightTime: t, bossDefeated: false }, CONFIG);
    assert.equal(b.earned, 0);
    assert.equal(b.timeComponent, 0);
  }
});

// --- runOutcome -------------------------------------------------------------

test("runOutcome reports Victory when the boss was defeated", () => {
  const o = runOutcome(endedRun({ bossDefeated: true, outcome: "victory" }));
  assert.equal(o.victory, true);
  assert.equal(o.status, "Victory");
  assert.equal(o.cause, null);
});

test("runOutcome maps each defeat code to a readable cause (Req 10.5)", () => {
  const cases = {
    pipe: "Fatal pipe collision",
    "ground-ceiling": "Hit the ground or ceiling",
    battle: "Defeated in battle",
  };
  for (const [code, label] of Object.entries(cases)) {
    const o = runOutcome(endedRun({ outcome: code }));
    assert.equal(o.victory, false);
    assert.equal(o.status, "Defeat");
    assert.equal(o.cause, label);
  }
});

test("runOutcome degrades an unknown/missing defeat code to a generic label", () => {
  const o = runOutcome(endedRun({ outcome: null }));
  assert.equal(o.victory, false);
  assert.equal(o.cause, "Run ended");
});

// --- formatDuration ---------------------------------------------------------

test("formatDuration renders M:SS and clamps garbage to 0:00", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(5), "0:05");
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(125), "2:05");
  assert.equal(formatDuration(-3), "0:00");
  assert.equal(formatDuration(NaN), "0:00");
});

// --- resultsSummary ---------------------------------------------------------

test("resultsSummary surfaces every required Results field (Req 10.5)", () => {
  const rs = endedRun({
    pipeScore: 7,
    activeFlightTime: 95,
    enemiesDefeated: 2,
    bossDefeated: true,
    outcome: "victory",
  });
  const save = { candy: 42 };
  const s = resultsSummary(rs, save, CONFIG);

  assert.equal(s.victory, true);
  assert.equal(s.status, "Victory");
  assert.equal(s.cause, null);
  assert.equal(s.pipeScore, 7);
  assert.equal(s.activeFlightTime, 95);
  assert.equal(s.activeFlightTimeLabel, "1:35");
  assert.equal(s.enemiesDefeated, 2);
  assert.equal(
    s.candyEarned,
    Math.floor(95 / CONFIG.candy.perRunDivisor) + CONFIG.candy.bossVictoryBonus,
  );
  assert.equal(s.totalCandy, 42);
});

test("resultsSummary presents the three actions in order (Req 10.6)", () => {
  const s = resultsSummary(endedRun(), null, CONFIG);
  assert.deepEqual(
    s.actions.map((a) => a.id),
    [ResultsAction.Restart, ResultsAction.MainMenu, ResultsAction.Wardrobe],
  );
  // Each action carries a human label for the view.
  for (const a of s.actions) assert.equal(typeof a.label, "string");
});

test("resultsSummary total Candy degrades to 0 without a SaveData candy field", () => {
  const s = resultsSummary(endedRun({ activeFlightTime: 30 }), null, CONFIG);
  assert.equal(s.totalCandy, 0);
});

// --- property: the Candy calculation shown matches the candy formula --------

test("Candy calculation shown equals floor(time/divisor) + boss bonus, over many runs", () => {
  assertProperty(
    fc.property(
      fc.double({ min: 0, max: 100000, noNaN: true }),
      fc.boolean(),
      fc.nat(10000),
      (time, bossDefeated, totalCandy) => {
        const rs = endedRun({ activeFlightTime: time, bossDefeated });
        const s = resultsSummary(rs, { candy: totalCandy }, CONFIG);
        const expectedTime = Math.floor(time / CONFIG.candy.perRunDivisor);
        const expectedBonus = bossDefeated ? CONFIG.candy.bossVictoryBonus : 0;
        return (
          s.candyEarned === expectedTime + expectedBonus &&
          s.candy.timeComponent === expectedTime &&
          s.candy.bossBonus === expectedBonus &&
          s.totalCandy === totalCandy &&
          s.victory === bossDefeated
        );
      },
    ),
  );
});

// --- the FSM records a Run-ending outcome so the cause of defeat is known ----

test("a fatal pipe collision records outcome='pipe' for the Results screen", () => {
  const fsm = createFSM(CONFIG, { candy: 0 }, {
    sweptHitboxVsPipes: () => ({ outcome: "fatal" }),
  });
  fsm.startNewRun(1); // Main_Menu -> Ready
  fsm.transition(States.Active_Flight_State);
  fsm.tick(1 / 120, { flap: false });
  assert.equal(fsm.state, States.Results_State);
  assert.equal(fsm.runState.outcome, "pipe");
  // And the summary reports it as the cause of defeat.
  const s = resultsSummary(fsm.runState, { candy: 0 }, CONFIG);
  assert.equal(s.victory, false);
  assert.equal(s.cause, "Fatal pipe collision");
});

test("a ground/ceiling fatal records outcome='ground-ceiling'", () => {
  // Force Ghosty below the floor so groundCeilingFatal fires immediately.
  const fsm = createFSM(CONFIG, { candy: 0 }, {});
  fsm.startNewRun(1);
  fsm.transition(States.Active_Flight_State);
  fsm.runState.ghosty.y = CONFIG.playfield.height + 1000;
  fsm.tick(1 / 120, { flap: false });
  assert.equal(fsm.state, States.Results_State);
  assert.equal(fsm.runState.outcome, "ground-ceiling");
});

// --- the Results -> Wardrobe / Main Menu actions are valid FSM transitions ---

test("Results offers restart, Main Menu, and Wardrobe transitions (Req 10.6)", () => {
  const mkResults = () => {
    const fsm = createFSM(CONFIG, { candy: 0 }, {
      sweptHitboxVsPipes: () => ({ outcome: "fatal" }),
    });
    fsm.startNewRun(1);
    fsm.transition(States.Active_Flight_State);
    fsm.tick(1 / 120, { flap: false });
    assert.equal(fsm.state, States.Results_State);
    return fsm;
  };

  const a = mkResults();
  assert.ok(a.restart(2));
  assert.equal(a.state, States.Ready_State);

  const b = mkResults();
  assert.equal(b.toMainMenu(), true);
  assert.equal(b.state, States.Main_Menu_State);

  const c = mkResults();
  assert.equal(c.openWardrobe(), true);
  assert.equal(c.state, States.Wardrobe);
});
