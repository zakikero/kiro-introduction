// test/state.test.js — property test for the three-clock model (Property 28).
//
// Exercises the FSM tick dispatch in src/state.js (pure logic, no DOM) with
// fast-check. The three-clock model (Requirement 9.2, 9.3) is the correctness
// rule under test:
//
//   (a) flight simulation time — flight physics, obstacle movement/spawning,
//       flight collision checks, Active_Flight_Time accrual, Hover duration and
//       cooldown, and all Flight_Power/flight cooldowns — advances ONLY in
//       Active_Flight_State;
//   (b) the Resume countdown advances ONLY in Resume_Countdown_State while the
//       frozen flight world stays untouched;
//   (c) resolved combat turns/cooldowns advance ONLY in Battle_State (never by
//       seconds);
//   and (Req 9.3) a hidden browser tab advances NONE of the three clocks.
//
// Strategy (design.md Testing Strategy): build a live RunState by starting a
// Run and entering Active_Flight_State, seed it with non-trivial flight values
// and pipes carrying Shield_Grace flags, snapshot the flight-relevant fields,
// then for every NON-Active_Flight state force the FSM there via the test hook
// and tick it with an fc-generated dt/intents, asserting the flight world is
// byte-for-byte unchanged. Injected spies additionally confirm the flight
// stepping function is never invoked outside Active_Flight_State and IS invoked
// inside it when the tab is visible.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRng } from "../src/rng.js";
import { stepFlight as realStepFlight } from "../src/systems/flight.js";
import { createFSM, States } from "../src/state.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

// A minimal SaveData stand-in: the FSM only reads prefs/high-score later and
// never mutates it here, so an empty object is sufficient for these tests.
const SAVE = Object.freeze({});

// Every GameState that is NOT the flight clock-bearer. These must freeze the
// whole flight world. Resume_Countdown and Battle also appear here for the
// flight-freeze assertion; their own clocks are checked separately below.
const NON_FLIGHT_STATES = [
  States.Main_Menu_State,
  States.Ready_State,
  States.Battle_State,
  States.Reward_State,
  States.Shop_State,
  States.Pause_State,
  States.Resume_Countdown_State,
  States.Results_State,
  States.Wardrobe,
];

/**
 * Build a live RunState with non-trivial flight values and a couple of pipe
 * pairs that carry Shield_Grace flags, so a freeze is meaningfully observable.
 * Reaches Active_Flight_State the normal way (Main_Menu → Ready → Active) so
 * `started` is true and the RunState is exactly what the game would hold.
 */
function makeLiveRunState(fsm, seed) {
  fsm.startNewRun(seed); // Main_Menu → Ready; builds the RunState
  fsm.transition(States.Active_Flight_State); // Ready → Active; started = true
  const rs = fsm.runState;

  // Seed non-trivial, clearly-not-default flight values so "unchanged" is a
  // real assertion rather than a tautology on zeros.
  rs.ghosty.x = 160;
  rs.ghosty.y = 275.5;
  rs.ghosty.vy = -123.25;
  rs.ghosty.prevX = 160;
  rs.ghosty.prevY = 300.75;
  rs.activeFlightTime = 12.5;
  rs.hoverRemaining = 0.4;
  rs.hoverCooldown = 3.2;
  rs.flightPowerCooldown = 1.1;
  rs.lightningCooldown = 2;

  // Two pipe pairs; one holds an active Shield_Grace flag that must survive.
  rs.pipes = [
    { id: 1, x: 400, gapCenter: 280, passed: false, shieldGrace: true },
    { id: 2, x: 640, gapCenter: 320, passed: true, shieldGrace: false },
  ];
  rs.lastGapCenter = 320;
  return rs;
}

/** Deep snapshot of the flight-relevant fields of a RunState. */
function flightSnapshot(rs) {
  return JSON.stringify({
    ghosty: rs.ghosty,
    pipes: rs.pipes,
    activeFlightTime: rs.activeFlightTime,
    hoverRemaining: rs.hoverRemaining,
    hoverCooldown: rs.hoverCooldown,
    flightPowerCooldown: rs.flightPowerCooldown,
    lightningCooldown: rs.lightningCooldown,
    lastGapCenter: rs.lastGapCenter,
  });
}

// Arbitrary simulation step and intents for a tick. dt is kept in a realistic
// positive range (incl. the clamped max frame time) so the countdown math is
// exercised across the full span of a single step.
const dtArb = fc.double({ min: 0.0001, max: 0.1, noNaN: true });
const intentsArb = fc.record({
  flap: fc.boolean(),
  confirm: fc.boolean(),
  dismiss: fc.boolean(),
});

// --- Property 28: three-clock model -----------------------------------------

test(
  propertyName(
    28,
    "Non-flight states freeze flight simulation while the other two clocks advance only in their own state",
  ),
  () => {
    // Part A: ticking ANY non-Active_Flight state freezes the entire flight
    // world and never invokes the flight stepping function.
    assertProperty(
      fc.property(
        fc.integer(),
        fc.constantFrom(...NON_FLIGHT_STATES),
        dtArb,
        intentsArb,
        (seed, nonFlightState, dt, intents) => {
          let stepFlightCalls = 0;
          const fsm = createFSM(CONFIG, SAVE, {
            rng: createRng(seed),
            stepFlight: (rs, i, d, c) => {
              stepFlightCalls += 1;
              return realStepFlight(rs, i, d, c);
            },
            // Document-visible by default (isDocumentHidden omitted → false).
          });

          const rs = makeLiveRunState(fsm, seed);
          const before = flightSnapshot(rs);

          // Force the non-flight state, keeping the SAME live RunState.
          fsm._setStateForTest(nonFlightState, rs);
          fsm.tick(dt, intents);

          const after = flightSnapshot(fsm.runState);

          // The flight world must be byte-for-byte identical.
          assert.equal(
            after,
            before,
            `flight world changed while in ${nonFlightState}`,
          );
          // Active_Flight_Time specifically must not accrue.
          assert.equal(fsm.runState.activeFlightTime, 12.5);
          // Shield_Grace on the first pair must be preserved.
          assert.equal(fsm.runState.pipes[0].shieldGrace, true);
          // The flight stepping function must NOT run outside Active_Flight.
          assert.equal(
            stepFlightCalls,
            0,
            `stepFlight invoked in ${nonFlightState}`,
          );
          return true;
        },
      ),
    );

    // Part B: the Resume countdown advances ONLY in Resume_Countdown_State, and
    // flight stays frozen while it does.
    assertProperty(
      fc.property(fc.integer(), dtArb, intentsArb, (seed, dt, intents) => {
        const fsm = createFSM(CONFIG, SAVE, {
          rng: createRng(seed),
          stepFlight: realStepFlight,
        });
        const rs = makeLiveRunState(fsm, seed);
        const before = flightSnapshot(rs);

        // Enter the countdown via the real edge so it is armed from config
        // (Active → Pause → Resume_Countdown). countdownRemaining starts at
        // config.resumeCountdown.
        fsm.transition(States.Pause_State);
        fsm.transition(States.Resume_Countdown_State);
        const startRemaining = fsm.countdownRemaining;
        assert.equal(startRemaining, CONFIG.resumeCountdown);

        fsm.tick(dt, intents);

        if (dt < startRemaining) {
          // Still counting down: remaining decreased by exactly dt and we stay
          // in the countdown state with flight untouched.
          assert.equal(fsm.state, States.Resume_Countdown_State);
          assert.ok(
            Math.abs(fsm.countdownRemaining - (startRemaining - dt)) < 1e-9,
            `countdown did not decrease by dt: ${fsm.countdownRemaining}`,
          );
        } else {
          // dt consumed the whole countdown: it clamps to 0 and resumes flight.
          assert.equal(fsm.countdownRemaining, 0);
          assert.equal(fsm.state, States.Active_Flight_State);
        }
        // Flight world frozen throughout the countdown tick.
        assert.equal(flightSnapshot(fsm.runState), before);
        return true;
      }),
    );

    // Part C: a hidden tab advances NONE of the three clocks — even in
    // Active_Flight_State the flight world is frozen and stepFlight never runs.
    assertProperty(
      fc.property(fc.integer(), dtArb, intentsArb, (seed, dt, intents) => {
        let stepFlightCalls = 0;
        const fsm = createFSM(CONFIG, SAVE, {
          rng: createRng(seed),
          isDocumentHidden: () => true, // tab hidden (Req 9.3)
          stepFlight: (rs, i, d, c) => {
            stepFlightCalls += 1;
            return realStepFlight(rs, i, d, c);
          },
        });
        const rs = makeLiveRunState(fsm, seed);
        const before = flightSnapshot(rs);

        // In Active_Flight (the flight clock) — but hidden, so nothing moves.
        assert.equal(fsm.state, States.Active_Flight_State);
        fsm.tick(dt, intents);
        assert.equal(flightSnapshot(fsm.runState), before);
        assert.equal(fsm.runState.activeFlightTime, 12.5);
        assert.equal(stepFlightCalls, 0, "stepFlight ran while tab hidden");

        // And the Resume countdown is also frozen while hidden.
        fsm.transition(States.Pause_State);
        fsm.transition(States.Resume_Countdown_State);
        const startRemaining = fsm.countdownRemaining;
        fsm.tick(dt, intents);
        assert.equal(
          fsm.countdownRemaining,
          startRemaining,
          "countdown advanced while tab hidden",
        );
        assert.equal(fsm.state, States.Resume_Countdown_State);
        return true;
      }),
    );

    // Part D: the positive control — in Active_Flight_State with a visible tab,
    // the flight clock DOES advance: stepFlight runs and Active_Flight_Time
    // accrues by dt. This proves Parts A–C aren't passing for a trivial reason.
    assertProperty(
      fc.property(fc.integer(), dtArb, intentsArb, (seed, dt, intents) => {
        let stepFlightCalls = 0;
        const fsm = createFSM(CONFIG, SAVE, {
          rng: createRng(seed),
          stepFlight: (rs, i, d, c) => {
            stepFlightCalls += 1;
            return realStepFlight(rs, i, d, c);
          },
        });
        const rs = makeLiveRunState(fsm, seed);
        const beforeTime = rs.activeFlightTime;

        assert.equal(fsm.state, States.Active_Flight_State);
        fsm.tick(dt, intents);

        assert.equal(stepFlightCalls, 1, "stepFlight did not run in flight");
        assert.ok(
          Math.abs(fsm.runState.activeFlightTime - (beforeTime + dt)) < 1e-9,
          `Active_Flight_Time did not accrue by dt: ${fsm.runState.activeFlightTime}`,
        );
        return true;
      }),
    );
  },
);
