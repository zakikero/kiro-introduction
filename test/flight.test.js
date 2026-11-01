// test/flight.test.js — flight physics property and example tests.
//
// Task 1.8 — Property 2: Normal_Flap sets velocity.
//
// Requirement 1.3: a Flap_Input SETS Ghosty's vertical velocity to exactly the
// configured Normal_Flap value, regardless of the current velocity (set, not
// add). This file proves that at two levels:
//
//   1. Directly on `applyFlap`: for an arbitrary prior vy, applyFlap leaves vy
//      EXACTLY equal to config.normalFlapVelocity — the cleanest "set, not add"
//      assertion.
//   2. Through `stepFlight` with intents.flap === true: the flap resolves
//      before gravity, so immediately after the step vy equals
//      normalFlapVelocity + gravity*dt, independent of the starting vy. If the
//      flap had ADDED to velocity, the result would depend on the prior vy;
//      that it does not proves the flap SET the velocity.
//
// See design.md "Testing Strategy" and systems/flight.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { applyFlap, stepFlight } from "../src/systems/flight.js";
import { FIXED_DT } from "../src/loop.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

// Tolerance for the stepFlight float comparison (vy = flap + gravity*dt).
const EPSILON = 1e-9;

// --- Unit/example tests ------------------------------------------------------

test("applyFlap sets vy to the Normal_Flap velocity from a resting ghosty", () => {
  const ghosty = { x: 160, y: 320, vy: 0, prevX: 160, prevY: 320 };
  applyFlap(ghosty, CONFIG);
  assert.equal(ghosty.vy, CONFIG.normalFlapVelocity);
});

test("applyFlap overwrites (does not add to) a fast downward velocity", () => {
  const ghosty = { x: 160, y: 320, vy: CONFIG.terminalVelocity, prevX: 160, prevY: 320 };
  applyFlap(ghosty, CONFIG);
  // If the flap added, vy would be terminalVelocity + normalFlapVelocity.
  assert.equal(ghosty.vy, CONFIG.normalFlapVelocity);
});

test("stepFlight with a flap sets vy to flap + gravity*dt regardless of prior vy", () => {
  const dt = FIXED_DT;
  const expected = CONFIG.normalFlapVelocity + CONFIG.gravity * dt;

  const fromUp = { ghosty: { x: 160, y: 320, vy: -300, prevX: 160, prevY: 320 } };
  const fromDown = { ghosty: { x: 160, y: 320, vy: 300, prevX: 160, prevY: 320 } };

  stepFlight(fromUp, { flap: true }, dt, CONFIG);
  stepFlight(fromDown, { flap: true }, dt, CONFIG);

  assert.ok(Math.abs(fromUp.ghosty.vy - expected) < EPSILON);
  assert.ok(Math.abs(fromDown.ghosty.vy - expected) < EPSILON);
  // Same post-step velocity whatever the prior velocity: the flap SET it.
  assert.equal(fromUp.ghosty.vy, fromDown.ghosty.vy);
});

// --- Property test -----------------------------------------------------------

// **Validates: Requirements 1.3**
test(propertyName(2, "Normal_Flap sets velocity"), () => {
  // Part 1: applyFlap sets vy to EXACTLY the Normal_Flap value, regardless of
  // the arbitrary prior velocity (including large positive/negative values).
  assertProperty(
    fc.property(
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      (startVy) => {
        const ghosty = { x: 160, y: 320, vy: startVy, prevX: 11, prevY: 22 };
        const returned = applyFlap(ghosty, CONFIG);
        // SET, not add: exactly the configured value whatever the prior vy was.
        return (
          returned.vy === CONFIG.normalFlapVelocity &&
          ghosty.vy === CONFIG.normalFlapVelocity
        );
      },
    ),
  );

  // Part 2: through stepFlight, a flap resolves before gravity, so the post-step
  // vy equals normalFlapVelocity + gravity*dt independent of the starting vy —
  // proving the flap SET (not added to) the velocity. prevX/prevY are also
  // synced to the pre-step center.
  assertProperty(
    fc.property(
      fc.double({ noNaN: true, noDefaultInfinity: true, min: -5000, max: 5000 }),
      fc.double({ noNaN: true, min: 0, max: FIXED_DT }),
      fc.double({ noNaN: true, min: -5000, max: 5000 }),
      fc.double({ noNaN: true, min: -5000, max: 5000 }),
      (startVy, dt, startX, startY) => {
        const runState = {
          ghosty: { x: startX, y: startY, vy: startVy, prevX: 0, prevY: 0 },
        };
        stepFlight(runState, { flap: true }, dt, CONFIG);

        const expected = CONFIG.normalFlapVelocity + CONFIG.gravity * dt;
        const g = runState.ghosty;

        // Post-step vy is the flap-set velocity plus one gravity step, with no
        // dependence on startVy (within float tolerance). The expected value
        // never exceeds terminalVelocity for dt <= FIXED_DT, so the downward
        // clamp does not interfere.
        const vyOk = Math.abs(g.vy - expected) <= EPSILON * (1 + Math.abs(expected));

        // prevX/prevY synced to the pre-step center (Req 1.10 support).
        const prevOk = g.prevX === startX && g.prevY === startY;

        return vyOk && prevOk;
      },
    ),
  );
});
