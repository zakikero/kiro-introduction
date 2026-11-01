// test/end-run.test.js — example/integration tests for the Pause "End Run"
// action and the started/unstarted distinction (Requirements 9.7, 9.8, 9.9).
//
// These live alongside the three-clock property (state.test.js) and the
// ordinary-pause property (pause.test.js); End Run is Input/Error-Handling
// behavior that the design verifies by example rather than a numbered property.
//
// What is pinned down here:
//   - Req 9.8: while in Pause_State the FSM offers an End Run action that
//     FINALIZES the current Run and transitions to Results_State.
//   - Req 9.9 / 8.5: End Run on a STARTED Run finalizes rewards (Candy award +
//     high-score bump via the injected finalizeRun hook), whereas cancelling an
//     UNSTARTED Run (started === false) finalizes NOTHING — no Candy, no
//     high-score change — and is kept distinct (no 'ended' outcome recorded).
//   - Req 9.7: the auto-pause entry point (onVisibilityLost) drops live flight
//     into Pause_State, from which End Run is reachable; resuming afterward
//     still requires the deliberate countdown.
//   - The finalize award is one-shot: the finalizeRun latch means repeated End
//     Run / Results views never double-award.
//   - End Run is a no-op outside Pause_State (state guard), and the single-
//     consumption barrier flushes the input queue on the transition (Req 9.6).
//
// The REAL candy.js finalizeRun and a real default SaveData are wired in so the
// started/unstarted award logic is exercised end to end, not mocked.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRng } from "../src/rng.js";
import { createFSM, States } from "../src/state.js";
import { finalizeRun } from "../src/systems/candy.js";
import { defaultSave } from "../src/save.js";

/**
 * Build an FSM wired with the real finalize hook and a fresh default SaveData.
 * Returns both so a test can assert on the save the finalize path mutates.
 */
function makeFsm(seed = 1) {
  const save = defaultSave(CONFIG); // candy 0, highScore 0
  const fsm = createFSM(CONFIG, save, {
    rng: createRng(seed),
    finalizeRun,
  });
  return { fsm, save };
}

// --- Req 9.8/9.9: End Run on a STARTED, in-progress Run -----------------------

test("End Run from pause finalizes a started Run and goes to Results (Req 9.8)", () => {
  const { fsm, save } = makeFsm();

  // Main_Menu → Ready → Active_Flight: the first-flight edge sets started=true.
  fsm.startNewRun(1);
  fsm.transition(States.Active_Flight_State);
  assert.equal(fsm.runState.started, true);

  // Give the Run some Active_Flight_Time and a Pipe_Score so finalize has
  // something to award. 30 s → floor(30/15) = 2 Candy; Pipe_Score 5 > 0.
  fsm.runState.activeFlightTime = 30;
  fsm.runState.pipeScore = 5;

  // Pause (manually here; auto-pause is covered below), then End Run.
  assert.equal(fsm.pause(), true);
  assert.equal(fsm.state, States.Pause_State);

  const expectedCandy = Math.floor(30 / CONFIG.candy.perRunDivisor);
  const res = fsm.endRun();

  assert.equal(res.ended, true, "End Run should apply from Pause_State");
  assert.equal(res.finalized, true, "a started Run should finalize rewards");
  assert.equal(fsm.state, States.Results_State, "End Run goes to Results");
  // The Run is recorded as deliberately ended so Results can report it.
  assert.equal(fsm.runState.outcome, "ended");
  // Candy was awarded and the high score bumped exactly once.
  assert.equal(save.candy, expectedCandy);
  assert.equal(save.highScore, 5);
  // The one-shot latch is set so no later view re-awards.
  assert.equal(fsm.runState.finalized, true);
});

test("End Run award is one-shot: a repeat finalize never double-awards (Req 8.6)", () => {
  const { fsm, save } = makeFsm();
  fsm.startNewRun(1);
  fsm.transition(States.Active_Flight_State);
  fsm.runState.activeFlightTime = 45; // floor(45/15) = 3 Candy
  fsm.runState.pipeScore = 7;
  fsm.pause();

  const expectedCandy = Math.floor(45 / CONFIG.candy.perRunDivisor);
  fsm.endRun();
  assert.equal(save.candy, expectedCandy);
  assert.equal(save.highScore, 7);

  // A direct re-finalize (as repeated Results views / reloads would do) is a
  // no-op: the latch keeps the award at exactly once.
  const again = finalizeRun(fsm.runState, save, CONFIG);
  assert.equal(again.finalized, false);
  assert.equal(save.candy, expectedCandy, "Candy must not double-award");
  assert.equal(save.highScore, 7, "high score must not change on repeat");
});

// --- Req 9.9/8.5: cancelling an UNSTARTED Run ---------------------------------

test("Cancelling an unstarted Run from pause finalizes NO rewards (Req 9.9, 8.5)", () => {
  const { fsm, save } = makeFsm();

  // Build a Run but never begin flight: started stays false.
  fsm.startNewRun(1);
  assert.equal(fsm.state, States.Ready_State);
  assert.equal(fsm.runState.started, false);

  // Even with Active_Flight_Time and a Pipe_Score that WOULD earn Candy, an
  // unstarted Run must award nothing. Force into Pause_State to invoke End Run
  // (the production path only reaches pause from flight, but an unstarted Run
  // can still be cancelled; finalize is what must award nothing).
  fsm.runState.activeFlightTime = 120; // plenty of Candy if it counted
  fsm.runState.pipeScore = 99;
  fsm._setStateForTest(States.Pause_State, fsm.runState);

  const res = fsm.endRun();

  assert.equal(res.ended, true, "the transition still applies");
  assert.equal(res.finalized, false, "an unstarted Run finalizes no rewards");
  assert.equal(fsm.state, States.Results_State);
  // No Candy, no high-score change — the save is untouched.
  assert.equal(save.candy, 0, "unstarted cancel must award no Candy");
  assert.equal(save.highScore, 0, "unstarted cancel must not change high score");
  // Distinct from a deliberately-ended started Run: no 'ended' outcome.
  assert.equal(fsm.runState.outcome, null);
  // Still latched so the result view is stable across repeats.
  assert.equal(fsm.runState.finalized, true);
});

// --- State guard --------------------------------------------------------------

test("End Run is a no-op outside Pause_State", () => {
  const { fsm, save } = makeFsm();
  fsm.startNewRun(1);
  fsm.transition(States.Active_Flight_State);
  fsm.runState.activeFlightTime = 30;

  // From Active_Flight (not paused) End Run does nothing: no finalize, no move.
  const res = fsm.endRun();
  assert.equal(res.ended, false);
  assert.equal(res.finalized, false);
  assert.equal(fsm.state, States.Active_Flight_State);
  assert.equal(save.candy, 0, "no finalize happened outside pause");
  assert.equal(fsm.runState.finalized, false);
});

// --- Req 9.7: auto-pause reaches the End Run action ---------------------------

test("Auto-pause drops flight into Pause_State, from which End Run finalizes (Req 9.7, 9.8)", () => {
  const { fsm, save } = makeFsm();
  fsm.startNewRun(1);
  fsm.transition(States.Active_Flight_State);
  fsm.runState.activeFlightTime = 15; // floor(15/15) = 1 Candy
  fsm.runState.pipeScore = 1;

  // Simulate a tab visibility / focus loss during flight.
  const applied = fsm.onVisibilityLost();
  assert.equal(applied, true, "auto-pause should apply from Active_Flight");
  assert.equal(fsm.state, States.Pause_State, "auto-pause enters Pause_State");

  // End Run from the auto-paused state finalizes and goes to Results.
  const res = fsm.endRun();
  assert.equal(res.ended, true);
  assert.equal(res.finalized, true);
  assert.equal(fsm.state, States.Results_State);
  assert.equal(save.candy, 1);
  assert.equal(save.highScore, 1);
});

test("Auto-pause still requires the deliberate countdown to resume (Req 9.7)", () => {
  const { fsm } = makeFsm();
  fsm.startNewRun(1);
  fsm.transition(States.Active_Flight_State);

  fsm.onVisibilityLost();
  assert.equal(fsm.state, States.Pause_State);

  // Resuming does NOT jump straight to flight: it enters the Resume countdown
  // (armed from config), and only reaches Active_Flight once it elapses.
  assert.equal(fsm.requestResume(), true);
  assert.equal(fsm.state, States.Resume_Countdown_State);
  assert.equal(fsm.countdownRemaining, CONFIG.resumeCountdown);

  fsm.tick(CONFIG.resumeCountdown, { flap: false });
  assert.equal(fsm.state, States.Active_Flight_State);
});

// --- Req 9.6: input barrier flushes on the End Run transition -----------------

test("End Run flushes the input queue at the transition (Req 9.6)", () => {
  const save = defaultSave(CONFIG);
  // A tiny input-queue spy capturing the scope the FSM transitions it to.
  const transitions = [];
  const inputQueue = {
    transition(scope) {
      transitions.push(scope);
    },
  };
  const fsm = createFSM(CONFIG, save, {
    rng: createRng(1),
    finalizeRun,
    inputQueue,
  });

  fsm.startNewRun(1);
  fsm.transition(States.Active_Flight_State);
  fsm.pause();
  transitions.length = 0; // ignore the transitions leading up to End Run

  fsm.endRun();

  // The FSM must have driven the queue's barrier to the Results scope so the
  // End Run input cannot leak into Results and restart/act there.
  assert.deepEqual(transitions, [States.Results_State]);
});

// --- Defensive: missing finalize hook still transitions -----------------------

test("End Run with no finalize hook still goes to Results without awarding", () => {
  const save = defaultSave(CONFIG);
  const fsm = createFSM(CONFIG, save, { rng: createRng(1) }); // no finalizeRun
  fsm.startNewRun(1);
  fsm.transition(States.Active_Flight_State);
  fsm.runState.activeFlightTime = 30;
  fsm.pause();

  const res = fsm.endRun();
  assert.equal(res.ended, true);
  assert.equal(res.finalized, false, "no hook → no award reported");
  assert.equal(fsm.state, States.Results_State);
  assert.equal(save.candy, 0, "no finalize hook means no Candy awarded");
});
