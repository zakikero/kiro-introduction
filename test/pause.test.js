// test/pause.test.js — Property 30: ordinary-pause exact-state preservation.
//
// This is a mandatory critical-subset property (design.md Testing Strategy). It
// pins down the ordinary-pause contract (Requirements 9.10, 9.11): an ORDINARY
// pause (Active_Flight → Pause) must preserve the EXACT frozen flight state, and
// resuming after the Resume countdown must return to Active_Flight_State from
// that exact state with NO recenter and NO velocity reset.
//
// Unlike the checkpoint path (Battle/Reward/Shop exit, Req 9.14 — which centers
// Ghosty in a Gap and zeroes vy), the ordinary-pause path (state.js `pause()` →
// `requestResume()`) never calls resumeFromCheckpoint. It relies entirely on the
// three-clock model freezing flight outside Active_Flight_State, so the state is
// preserved simply by not being mutated. This test proves that: everything —
// Ghosty's position/velocity/prev, the full pipe set (incl. each pair's
// shieldGrace/scored/x/gapCenter), activeFlightTime, the Hover remainder, every
// cooldown, shieldCharges, pipeScore, lastGapCenter, AND the seeded RNG's
// internal state — is byte-for-byte identical at the moment flight resumes.
//
// Strategy: build an FSM wired with the REAL flight stepping, the REAL seeded
// RNG (so the internal spawner actually runs and produces a non-trivial pipe
// set), and the REAL scoring. Start a Run, enter Active_Flight_State, and tick
// it for an fc-generated number of steps with fc-generated flap intents so
// Ghosty has non-trivial motion, pipes exist, and activeFlightTime > 0. Layer on
// extra non-default state (Hover remainder, cooldowns, shield charges, a pipe's
// shieldGrace flag). Snapshot EVERYTHING (including rng.snapshot()). Pause; tick
// arbitrarily while paused (must change nothing); requestResume(); tick through
// arbitrary dt steps until the FSM re-enters Active_Flight_State, capturing the
// resume-moment state the instant that happens (before any further flight tick).
// Assert that resume-moment snapshot deep-equals the pre-pause snapshot exactly.
//
// NOTE on collision: this test deliberately does NOT inject sweptHitboxVsPipes.
// The FSM's internal collision call would otherwise be able to transition the
// Run to Results on a fatal hit during the warm-up flight, which is irrelevant
// to (and would obscure) the pause-preservation property. Flight physics,
// spawning, scoring, and Active_Flight_Time accrual all run regardless, which is
// exactly the state whose preservation across a pause we are asserting.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRng } from "../src/rng.js";
import { stepFlight as realStepFlight } from "../src/systems/flight.js";
import { stepScoring as realStepScoring } from "../src/systems/scoring.js";
import { createFSM, States } from "../src/state.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

// Minimal SaveData stand-in: the FSM only reads prefs/high-score elsewhere and
// never mutates it on the pause path, so an empty object suffices.
const SAVE = Object.freeze({});

/**
 * Deep, order-stable snapshot of every flight-relevant RunState field plus the
 * RNG's internal state. JSON gives an exact value comparison for the plain
 * numeric/boolean/array flight state; the RNG state (a plain uint32) is folded
 * in so an advance of the generator across the pause would be detected too.
 *
 * @param {object} rs the active RunState
 * @param {{ snapshot: () => number }} rng the seeded RNG driving the spawner
 * @returns {string}
 */
function fullSnapshot(rs, rng) {
  return JSON.stringify({
    ghosty: {
      x: rs.ghosty.x,
      y: rs.ghosty.y,
      vy: rs.ghosty.vy,
      prevX: rs.ghosty.prevX,
      prevY: rs.ghosty.prevY,
    },
    pipes: rs.pipes,
    activeFlightTime: rs.activeFlightTime,
    hoverRemaining: rs.hoverRemaining,
    hoverCooldown: rs.hoverCooldown,
    flightPowerCooldown: rs.flightPowerCooldown,
    lightningCooldown: rs.lightningCooldown,
    shieldCharges: rs.shieldCharges,
    pipeScore: rs.pipeScore,
    lastGapCenter: rs.lastGapCenter,
    rngState: rng.snapshot(),
  });
}

// Arbitraries. dt is kept in a realistic positive range, including the clamped
// max frame time, so the spawner and countdown math see a full span of steps.
const dtArb = fc.double({ min: 0.001, max: 0.1, noNaN: true });
const flapArb = fc.record({ flap: fc.boolean() });

test(
  propertyName(30, "Ordinary pause preserves exact flight state"),
  () => {
    assertProperty(
      fc.property(
        // Seed for the deterministic RNG/spawner.
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        // A non-trivial warm-up flight: a sequence of (dt, flap) steps.
        fc.array(fc.tuple(dtArb, flapArb), { minLength: 5, maxLength: 60 }),
        // Non-default extra state layered on before the pause.
        fc.double({ min: 0, max: 0.6, noNaN: true }), // hoverRemaining
        fc.double({ min: 0, max: 5, noNaN: true }), // hoverCooldown
        fc.double({ min: 0, max: 5, noNaN: true }), // flightPowerCooldown
        fc.integer({ min: 0, max: 3 }), // lightningCooldown (battle turns)
        fc.integer({ min: 0, max: 1 }), // shieldCharges (cap is 1)
        // Number of idle ticks while paused (must change nothing).
        fc.array(dtArb, { minLength: 0, maxLength: 8 }),
        // dt sequence driving the Resume countdown to completion.
        fc.array(dtArb, { minLength: 1, maxLength: 20 }),
        (
          seed,
          flightSteps,
          hoverRemaining,
          hoverCooldown,
          flightPowerCooldown,
          lightningCooldown,
          shieldCharges,
          pausedTicks,
          countdownTicks,
        ) => {
          // The RNG instance the FSM uses for spawning. We keep our own handle
          // so we can read its snapshot() before/after the pause.
          const rng = createRng(seed);

          const fsm = createFSM(CONFIG, SAVE, {
            rng,
            stepFlight: realStepFlight,
            stepScoring: realStepScoring,
            // No collision injected on purpose (see file header): we never want
            // the warm-up flight to transition to Results mid-test.
          });

          // Main_Menu → Ready → Active_Flight (started = true), as the game does.
          fsm.startNewRun(seed);
          fsm.transition(States.Active_Flight_State);

          // Warm-up flight: real physics + real spawner + real scoring so the
          // RunState accrues a non-trivial Ghosty motion, a real pipe set, a
          // positive activeFlightTime, and advances the RNG state.
          for (const [dt, intents] of flightSteps) {
            // Guard: if some future wiring ever ends the Run mid-warm-up, stop
            // ticking flight (we only pause from Active_Flight_State).
            if (fsm.state !== States.Active_Flight_State) break;
            fsm.tick(dt, intents);
          }

          // If we somehow left Active_Flight (not expected without collision),
          // the pause precondition does not hold — treat as a vacuous pass.
          if (fsm.state !== States.Active_Flight_State) return true;

          const rs = fsm.runState;

          // Layer on clearly-non-default extra state so the preservation check
          // is meaningful across every field the requirement enumerates.
          rs.hoverRemaining = hoverRemaining;
          rs.hoverCooldown = hoverCooldown;
          rs.flightPowerCooldown = flightPowerCooldown;
          rs.lightningCooldown = lightningCooldown;
          rs.shieldCharges = shieldCharges;
          // Mark the first pipe pair, if any, as under Shield_Grace so the
          // grace flag's survival across the pause is exercised.
          if (rs.pipes.length > 0) rs.pipes[0].shieldGrace = true;

          // Snapshot EVERYTHING at the instant before the ordinary pause.
          const beforePause = fullSnapshot(rs, rng);

          // --- Ordinary pause -------------------------------------------------
          const paused = fsm.pause(); // Active_Flight → Pause_State
          assert.equal(paused, true, "pause() should apply from Active_Flight");
          assert.equal(fsm.state, States.Pause_State);
          // Nothing may have changed merely by pausing.
          assert.equal(
            fullSnapshot(fsm.runState, rng),
            beforePause,
            "pausing mutated the frozen flight state",
          );

          // Idle ticks while paused: the Pause_State bears no clock, so the
          // flight world (and the RNG) must stay frozen tick after tick.
          for (const dt of pausedTicks) {
            fsm.tick(dt, { flap: true });
            assert.equal(
              fsm.state,
              States.Pause_State,
              "a paused tick changed state",
            );
            assert.equal(
              fullSnapshot(fsm.runState, rng),
              beforePause,
              "a paused tick mutated the frozen flight state",
            );
          }

          // --- Deliberate resumption -----------------------------------------
          const resuming = fsm.requestResume(); // Pause → Resume_Countdown
          assert.equal(resuming, true, "requestResume() should apply");
          assert.equal(fsm.state, States.Resume_Countdown_State);
          assert.equal(
            fsm.countdownRemaining,
            CONFIG.resumeCountdown,
            "countdown should arm from config.resumeCountdown",
          );
          // The countdown must not have touched flight state or the RNG.
          assert.equal(
            fullSnapshot(fsm.runState, rng),
            beforePause,
            "arming the countdown mutated the frozen flight state",
          );

          // Drive the countdown to zero. Capture the EXACT resume-moment state
          // the instant the FSM re-enters Active_Flight_State — BEFORE any
          // further flight tick advances anything.
          let resumeMoment = null;
          for (const dt of countdownTicks) {
            if (fsm.state === States.Resume_Countdown_State) {
              // Flight is frozen for as long as the countdown runs.
              assert.equal(
                fullSnapshot(fsm.runState, rng),
                beforePause,
                "flight state changed during the countdown",
              );
            }
            fsm.tick(dt, { flap: true });
            if (
              fsm.state === States.Active_Flight_State &&
              resumeMoment === null
            ) {
              // The instant we are back in flight: snapshot before looping again
              // (the next iteration / later ticks WOULD advance flight).
              resumeMoment = fullSnapshot(fsm.runState, rng);
              break;
            }
          }

          // The supplied countdownTicks always sum past config.resumeCountdown
          // in the worst case? Not guaranteed — top up with max-frame ticks so
          // the countdown definitely completes and we observe the resume moment.
          let safety = 0;
          while (
            resumeMoment === null &&
            fsm.state !== States.Active_Flight_State &&
            safety < 10000
          ) {
            fsm.tick(0.1, { flap: true });
            safety += 1;
            if (fsm.state === States.Active_Flight_State) {
              resumeMoment = fullSnapshot(fsm.runState, rng);
            }
          }

          assert.equal(
            fsm.state,
            States.Active_Flight_State,
            "FSM did not return to Active_Flight_State after the countdown",
          );
          assert.notEqual(
            resumeMoment,
            null,
            "failed to capture the resume-moment state",
          );

          // THE core assertion (Req 9.10, 9.11): the exact preserved state —
          // position, velocity, prev coords, full pipe set, Hover remainder,
          // every cooldown, shield charges, Pipe_Score, scheduler/lastGapCenter,
          // and the RNG state — is byte-for-byte identical. No recenter, no
          // velocity reset, nothing refilled, the RNG not advanced.
          assert.equal(
            resumeMoment,
            beforePause,
            "ordinary-pause resumption did not restore the exact frozen state",
          );

          return true;
        },
      ),
    );
  },
);
