// test/hover.test.js — Hover (Storm_Bat Flight_Power) property and example tests.
//
// Task 3.4 — Property 29: Hover suspends gravity for its duration while the
// world keeps moving.
//
// The Hover state machine lives entirely on the RunState as two Active_Flight-
// seconds clocks (`hoverRemaining`, `hoverCooldown`) advanced only inside
// `stepFlight` (see systems/flight.js). This file proves the full contract
// (Req 6.9, 6.12–6.17):
//
//   - Activation sets vy = 0 and arms the configured Hover duration + cooldown
//     (via activateHover, gated on hoverCooldown <= 0). (Req 6.12)
//   - While hoverRemaining > 0, gravity is NOT applied: vy stays 0 and Ghosty
//     holds its vertical position, even though the step still runs (pipes keep
//     moving, Active_Flight_Time keeps accruing, collisions stay active — all
//     owned by the FSM, not suspended here). (Req 6.9, 6.12, 6.13)
//   - A Normal_Flap during an active Hover CANCELS it (clears hoverRemaining),
//     applies the flap velocity, and does NOT refund the cooldown. (Req 6.14)
//   - A same-tick flap BEATS a Hover activation request: the flap is applied
//     and Hover does not activate that tick. (Req 6.16)
//   - Natural expiry (hoverRemaining reaching 0 without a flap) resumes gravity
//     from vy = 0. (Req 6.15)
//   - The duration/cooldown advance ONLY in Active_Flight (only stepFlight
//     touches them) and are NEVER refilled by switching Spirits — confirmed via
//     spirits.possess(). (Req 6.17)
//
// See design.md "Testing Strategy" (mandatory critical subset),
// src/systems/flight.js and src/systems/spirits.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { activateHover, stepFlight } from "../src/systems/flight.js";
import { possess, SpiritId } from "../src/systems/spirits.js";
import { FIXED_DT } from "../src/loop.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

const EPSILON = 1e-9;

/** Fresh RunState fixture with Hover ready (cooldown elapsed). */
function makeRunState(overrides = {}) {
  return {
    ghosty: { x: 160, y: 320, vy: 0, prevX: 160, prevY: 320 },
    hoverRemaining: 0,
    hoverCooldown: 0,
    ...overrides,
  };
}

// --- Example tests -----------------------------------------------------------

test("activateHover zeros vy and arms the configured duration + cooldown", () => {
  const rs = makeRunState({ ghosty: { x: 10, y: 20, vy: 350, prevX: 10, prevY: 20 } });
  activateHover(rs, CONFIG);
  assert.equal(rs.ghosty.vy, 0);
  assert.equal(rs.hoverRemaining, CONFIG.hover.duration);
  assert.equal(rs.hoverCooldown, CONFIG.hover.cooldown);
});

test("activateHover is ignored while on cooldown (no change)", () => {
  const rs = makeRunState({ hoverCooldown: 2.5, ghosty: { x: 10, y: 20, vy: 123, prevX: 10, prevY: 20 } });
  activateHover(rs, CONFIG);
  assert.equal(rs.ghosty.vy, 123);
  assert.equal(rs.hoverRemaining, 0);
  assert.equal(rs.hoverCooldown, 2.5);
});

test("gravity is suspended for the full Hover duration, then resumes from vy = 0", () => {
  const dt = FIXED_DT;
  const rs = makeRunState();
  // Activate via a flightPower intent on this tick.
  stepFlight(rs, { flightPower: true }, dt, CONFIG);
  // After activation the first step keeps vy at 0 (gravity suspended).
  assert.equal(rs.ghosty.vy, 0);

  // Step until Hover expires naturally. Count steps that hold gravity.
  let steps = 1; // the activation step above counted as one held step
  while (rs.hoverRemaining > 0) {
    stepFlight(rs, {}, dt, CONFIG);
    if (rs.hoverRemaining > 0) {
      assert.equal(rs.ghosty.vy, 0, "vy stays 0 while Hover is active");
    }
    steps += 1;
  }
  // Duration covered: steps * dt >= configured duration.
  assert.ok(steps * dt + EPSILON >= CONFIG.hover.duration);

  // The step on which hoverRemaining reaches 0 still had gravity suspended
  // (expiry resumes NEXT step from vy = 0). vy is 0 right now.
  assert.equal(rs.ghosty.vy, 0);
  // Next step: gravity resumes from 0.
  stepFlight(rs, {}, dt, CONFIG);
  assert.ok(Math.abs(rs.ghosty.vy - CONFIG.gravity * dt) < EPSILON);
});

test("a Normal_Flap during Hover cancels it, applies flap velocity, keeps the cooldown", () => {
  const dt = FIXED_DT;
  const rs = makeRunState();
  stepFlight(rs, { flightPower: true }, dt, CONFIG);
  assert.ok(rs.hoverRemaining > 0);
  const cooldownBefore = rs.hoverCooldown;

  // Flap while hovering.
  stepFlight(rs, { flap: true }, dt, CONFIG);
  assert.equal(rs.hoverRemaining, 0, "flap cancels Hover");
  // Flap set vy, then gravity resumed the same step (Hover was cancelled first).
  assert.ok(
    Math.abs(rs.ghosty.vy - (CONFIG.normalFlapVelocity + CONFIG.gravity * dt)) < EPSILON,
  );
  // Cooldown is not refunded — it kept ticking down by exactly one dt.
  assert.ok(Math.abs(rs.hoverCooldown - Math.max(0, cooldownBefore - dt)) < EPSILON);
});

test("a same-tick flap beats a Hover activation request", () => {
  const dt = FIXED_DT;
  const rs = makeRunState();
  stepFlight(rs, { flap: true, flightPower: true }, dt, CONFIG);
  assert.equal(rs.hoverRemaining, 0, "Hover did not activate this tick");
  assert.equal(rs.hoverCooldown, 0, "cooldown not started — Hover never activated");
  assert.ok(
    Math.abs(rs.ghosty.vy - (CONFIG.normalFlapVelocity + CONFIG.gravity * dt)) < EPSILON,
  );
});

test("switching spirits never refills hoverCooldown", () => {
  const rs = makeRunState({
    hoverCooldown: 3.2,
    hoverRemaining: 0.4,
    equippedSpirit: SpiritId.STORM_BAT,
    shieldCharges: 0,
    pumpkinShieldGiftUsed: false,
  });
  possess(rs, SpiritId.PUMPKIN_GUARDIAN, CONFIG);
  assert.equal(rs.hoverCooldown, 3.2);
  assert.equal(rs.hoverRemaining, 0.4);
});

// --- Property test -----------------------------------------------------------

// **Validates: Requirements 6.9, 6.12, 6.13, 6.14, 6.15, 6.16, 6.17**
test(
  propertyName(
    29,
    "Hover suspends gravity for its duration while the world keeps moving",
  ),
  () => {
    const dt = FIXED_DT;
    // Number of whole fixed steps the configured Hover duration spans. The
    // suspended-gravity window holds for ceil(duration / dt) steps because the
    // step that drives hoverRemaining to 0 still has gravity suspended (expiry
    // resumes NEXT step).
    const heldSteps = Math.ceil(CONFIG.hover.duration / dt - EPSILON);

    // Part A — Activation zeroes vy and arms both clocks; suspended gravity
    // holds vy at 0 for the full duration while time keeps advancing; natural
    // expiry resumes gravity from 0. Active_Flight_Time accrual, pipe movement,
    // and collisions are the FSM's job — here we prove the per-step integration
    // does NOT touch vy/position while Hover is active (so the world moving is
    // unaffected by Hover), and the clocks advance by exactly dt each step.
    assertProperty(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true, min: -700, max: 700 }),
        fc.double({ noNaN: true, min: 0, max: 640 }),
        (startVy, startY) => {
          const rs = makeRunState({
            ghosty: { x: 160, y: startY, vy: startVy, prevX: 1, prevY: 2 },
          });

          // Activate uncontested (cooldown is 0).
          activateHover(rs, CONFIG);
          if (rs.ghosty.vy !== 0) return false; // Req 6.12: vy set to 0
          if (rs.hoverRemaining !== CONFIG.hover.duration) return false;
          if (rs.hoverCooldown !== CONFIG.hover.cooldown) return false;

          // Step through the whole suspended-gravity window with no flap.
          for (let i = 0; i < heldSteps; i += 1) {
            const yBefore = rs.ghosty.y;
            const cdBefore = rs.hoverCooldown;
            stepFlight(rs, {}, dt, CONFIG);
            // Gravity suspended: vy stays 0 and y does not drift (Req 6.13).
            if (rs.ghosty.vy !== 0) return false;
            if (rs.ghosty.y !== yBefore) return false;
            // Cooldown advances by exactly dt in Active_Flight (Req 6.17).
            const expectedCd = Math.max(0, cdBefore - dt);
            if (Math.abs(rs.hoverCooldown - expectedCd) > EPSILON) return false;
          }

          // Hover has now expired naturally; vy is still 0 (Req 6.15).
          if (rs.hoverRemaining !== 0) return false;
          if (rs.ghosty.vy !== 0) return false;

          // Next step resumes gravity from 0 (Req 6.15).
          stepFlight(rs, {}, dt, CONFIG);
          const expectedVy = CONFIG.gravity * dt;
          return Math.abs(rs.ghosty.vy - expectedVy) <= EPSILON * (1 + Math.abs(expectedVy));
        },
      ),
    );

    // Part B — A Normal_Flap during an active Hover CANCELS it (Req 6.14): it
    // applies the flap velocity (set, not add), clears hoverRemaining, and does
    // NOT refund the cooldown (cooldown just keeps ticking by dt). Tested after
    // an arbitrary number of held steps.
    assertProperty(
      fc.property(
        fc.integer({ min: 0, max: heldSteps - 1 }),
        fc.double({ noNaN: true, noDefaultInfinity: true, min: -700, max: 700 }),
        (stepsBeforeFlap, startVy) => {
          const rs = makeRunState({
            ghosty: { x: 160, y: 300, vy: startVy, prevX: 1, prevY: 2 },
          });
          activateHover(rs, CONFIG);
          for (let i = 0; i < stepsBeforeFlap; i += 1) {
            stepFlight(rs, {}, dt, CONFIG);
          }
          const cooldownBefore = rs.hoverCooldown;

          stepFlight(rs, { flap: true }, dt, CONFIG);

          // Hover cancelled.
          if (rs.hoverRemaining !== 0) return false;
          // Flap applied (set), gravity resumed the same step since Hover was
          // cancelled before the gravity phase.
          const expectedVy = CONFIG.normalFlapVelocity + CONFIG.gravity * dt;
          if (Math.abs(rs.ghosty.vy - expectedVy) > EPSILON * (1 + Math.abs(expectedVy))) {
            return false;
          }
          // Cooldown NOT refunded: it only ticked down by this one dt.
          const expectedCd = Math.max(0, cooldownBefore - dt);
          return Math.abs(rs.hoverCooldown - expectedCd) <= EPSILON;
        },
      ),
    );

    // Part C — A same-tick flap BEATS a Hover activation request (Req 6.16):
    // the flap wins and Hover does not activate that tick, so the cooldown is
    // never started.
    assertProperty(
      fc.property(
        fc.double({ noNaN: true, noDefaultInfinity: true, min: -700, max: 700 }),
        (startVy) => {
          const rs = makeRunState({
            ghosty: { x: 160, y: 300, vy: startVy, prevX: 1, prevY: 2 },
          });
          stepFlight(rs, { flap: true, flightPower: true }, dt, CONFIG);
          if (rs.hoverRemaining !== 0) return false; // Hover did not activate
          if (rs.hoverCooldown !== 0) return false; // cooldown never started
          const expectedVy = CONFIG.normalFlapVelocity + CONFIG.gravity * dt;
          return Math.abs(rs.ghosty.vy - expectedVy) <= EPSILON * (1 + Math.abs(expectedVy));
        },
      ),
    );

    // Part D — Switching Spirits never refills the Hover clocks (Req 6.17).
    // After arming Hover and burning some of the cooldown, a possess() to any
    // spirit leaves hoverRemaining and hoverCooldown untouched.
    assertProperty(
      fc.property(
        fc.integer({ min: 0, max: heldSteps - 1 }),
        fc.constantFrom(SpiritId.NONE, SpiritId.STORM_BAT, SpiritId.PUMPKIN_GUARDIAN),
        (stepsBefore, toSpirit) => {
          const rs = makeRunState({
            ghosty: { x: 160, y: 300, vy: 0, prevX: 1, prevY: 2 },
            equippedSpirit: SpiritId.NONE,
            shieldCharges: 0,
            pumpkinShieldGiftUsed: false,
          });
          activateHover(rs, CONFIG);
          for (let i = 0; i < stepsBefore; i += 1) {
            stepFlight(rs, {}, dt, CONFIG);
          }
          const remainingBefore = rs.hoverRemaining;
          const cooldownBefore = rs.hoverCooldown;

          possess(rs, toSpirit, CONFIG);

          return (
            rs.hoverRemaining === remainingBefore &&
            rs.hoverCooldown === cooldownBefore
          );
        },
      ),
    );
  },
);
