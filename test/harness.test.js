// test/harness.test.js — smoke test proving the no-browser harness works.
//
// This file does two jobs:
//   1. Confirms Node's built-in test runner can import the pure ES modules
//      (`src/config.js`, `src/rng.js`) with no DOM and assert on them.
//   2. Confirms `fast-check` is wired in and that the property helpers enforce
//      the tag convention and the 100-iteration minimum.
//
// It contains both a unit/example test and a property test, so it also serves
// as the reference for how later tasks should structure their tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRng } from "../src/rng.js";
import {
  fc,
  assertProperty,
  propertyName,
  MIN_RUNS,
} from "../test-support/helpers.js";

// --- Unit/example tests ------------------------------------------------------

test("harness: CONFIG is frozen and holds the expected defaults", () => {
  assert.equal(Object.isFrozen(CONFIG), true, "CONFIG must be frozen");
  // A couple of spec-anchored values to prove we imported the real config.
  assert.equal(CONFIG.playfield.width, 960);
  assert.equal(CONFIG.playfield.height, 640);
  assert.equal(CONFIG.normalFlapVelocity, -480);
  assert.equal(CONFIG.ghosty.initialCenter.x, 160);
  assert.equal(CONFIG.ghosty.initialCenter.y, 320);
  // Mutation attempts are silently ignored on a frozen object.
  assert.throws(() => {
    "use strict";
    CONFIG.gravity = 0;
  });
});

test("harness: the seeded RNG is deterministic for a given seed", () => {
  const a = createRng(12345);
  const b = createRng(12345);
  const seqA = [a.next(), a.next(), a.next()];
  const seqB = [b.next(), b.next(), b.next()];
  assert.deepEqual(seqA, seqB, "same seed must replay the same sequence");
  // Values are floats in [0, 1).
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1, `value ${v} out of [0, 1)`);
  }
});

test("harness: the property tag convention is well-formed", () => {
  assert.equal(
    propertyName(2, "Normal_Flap sets velocity"),
    "Feature: flappy-kiro, Property 2: Normal_Flap sets velocity",
  );
  assert.equal(MIN_RUNS, 100);
});

// --- Property test (proves fast-check is wired in) ---------------------------

test(
  propertyName(0, "seeded RNG replays identically from the same seed"),
  () => {
    assertProperty(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 20 }), (seed, n) => {
        const left = createRng(seed);
        const right = createRng(seed);
        for (let i = 0; i < n; i += 1) {
          const l = left.next();
          const r = right.next();
          if (l !== r) return false;
          if (!(l >= 0 && l < 1)) return false;
        }
        return true;
      }),
    );
  },
);
