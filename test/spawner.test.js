// test/spawner.test.js — property tests for the obstacle spawner.
//
// Exercises src/systems/spawner.js (pure logic, no DOM) with fast-check:
//   Property 5: Scroll speed schedule — speed = base + increment × milestones
//               reached, is non-decreasing, and never exceeds max.
//   Property 6: Every generated pipe pair is valid — the full gap keeps
//               min clearance from Ground/Ceiling, and consecutive gap-center
//               deltas stay within maxGapCenterDelta.
//   Property 7: Off-screen pipes are bounded — no surviving pair has its
//               trailing edge past the left edge (x + width < 0).
//
// All randomness is drawn from the seeded RNG in rng.js; never Math.random.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRng } from "../src/rng.js";
import {
  currentScrollSpeed,
  placeGap,
  stepSpawner,
} from "../src/systems/spawner.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

// Count how many scroll milestones a given activeFlightTime has reached.
function milestonesReached(t, config) {
  let reached = 0;
  for (const m of config.scroll.milestones) {
    if (t >= m) reached += 1;
  }
  return reached;
}

// --- Property 5: Scroll speed schedule --------------------------------------

test(
  propertyName(5, "Scroll speed schedule"),
  () => {
    const { base, increment, max } = CONFIG.scroll;

    // Part A: for any non-negative time, speed equals the capped schedule value
    // and always stays within [base, max].
    assertProperty(
      fc.property(
        fc.double({ min: 0, max: 1000, noNaN: true }),
        (activeFlightTime) => {
          const speed = currentScrollSpeed(activeFlightTime, CONFIG);
          const expected = Math.min(
            base + increment * milestonesReached(activeFlightTime, CONFIG),
            max,
          );
          assert.equal(speed, expected);
          assert.ok(speed >= base, `speed ${speed} below base ${base}`);
          assert.ok(speed <= max, `speed ${speed} above max ${max}`);
          return true;
        },
      ),
    );

    // Part B: along any ascending sequence of times, speed is non-decreasing.
    assertProperty(
      fc.property(
        fc.array(fc.double({ min: 0, max: 1000, noNaN: true }), {
          minLength: 2,
          maxLength: 30,
        }),
        (times) => {
          const sorted = [...times].sort((a, b) => a - b);
          let prev = -Infinity;
          for (const t of sorted) {
            const speed = currentScrollSpeed(t, CONFIG);
            assert.ok(
              speed >= prev,
              `speed decreased: ${speed} < ${prev} at t=${t}`,
            );
            prev = speed;
          }
          return true;
        },
      ),
    );
  },
);

// --- Property 6: Every generated pipe pair is valid -------------------------

test(
  propertyName(6, "Every generated pipe pair is valid"),
  () => {
    const { gapHeight, minClearance, maxGapCenterDelta } = CONFIG.pipe;
    const { height } = CONFIG.playfield;
    const half = gapHeight / 2;
    // A tiny tolerance absorbs floating-point drift from the uniform draw.
    const EPS = 1e-9;

    assertProperty(
      fc.property(
        fc.integer(),
        fc.integer({ min: 20, max: 200 }),
        fc.double({ min: 0.01, max: 0.05, noNaN: true }),
        (seed, steps, dt) => {
          const rng = createRng(seed);
          // Drive the spawner across many steps so plenty of pairs are born.
          let pipes = [];
          let lastGapCenter = null;
          const scrollSpeed = CONFIG.scroll.max; // fast: generate many pairs
          const centersInBirthOrder = [];

          for (let i = 0; i < steps; i += 1) {
            const before = new Set(pipes.map((p) => p.id));
            const res = stepSpawner(
              pipes,
              scrollSpeed,
              dt,
              rng,
              lastGapCenter,
              CONFIG,
            );
            // Record any newly born pairs (by first appearance) in order.
            for (const p of res.pipes) {
              if (!before.has(p.id)) {
                centersInBirthOrder.push({ id: p.id, gapCenter: p.gapCenter });
              }
            }
            pipes = res.pipes;
            lastGapCenter = res.lastGapCenter;
          }

          // Need at least a couple of pairs to meaningfully check deltas.
          // (With max scroll speed and >=20 steps, many pairs are produced.)
          for (const { gapCenter } of centersInBirthOrder) {
            // Full gap stays min clearance from Ground (y=0) and Ceiling (y=height).
            const gapTop = gapCenter - half;
            const gapBottom = gapCenter + half;
            assert.ok(
              gapTop >= minClearance - EPS,
              `gap top ${gapTop} < minClearance ${minClearance}`,
            );
            assert.ok(
              gapBottom <= height - minClearance + EPS,
              `gap bottom ${gapBottom} > ${height - minClearance}`,
            );
          }

          // Consecutive birth-order gap-center deltas stay within the max.
          for (let i = 1; i < centersInBirthOrder.length; i += 1) {
            const delta = Math.abs(
              centersInBirthOrder[i].gapCenter -
                centersInBirthOrder[i - 1].gapCenter,
            );
            assert.ok(
              delta <= maxGapCenterDelta + EPS,
              `gap-center delta ${delta} > max ${maxGapCenterDelta}`,
            );
          }

          return true;
        },
      ),
    );

    // Also exercise placeGap directly over a chain of prevCenters, since that
    // is the unit that enforces both constraints.
    assertProperty(
      fc.property(
        fc.integer(),
        fc.integer({ min: 2, max: 50 }),
        (seed, n) => {
          const rng = createRng(seed);
          let prev = null;
          for (let i = 0; i < n; i += 1) {
            const center = placeGap(prev, rng, CONFIG);
            const gapTop = center - half;
            const gapBottom = center + half;
            assert.ok(gapTop >= minClearance - EPS);
            assert.ok(gapBottom <= height - minClearance + EPS);
            if (prev != null) {
              assert.ok(
                Math.abs(center - prev) <= maxGapCenterDelta + EPS,
                `delta ${Math.abs(center - prev)} > ${maxGapCenterDelta}`,
              );
            }
            prev = center;
          }
          return true;
        },
      ),
    );
  },
);

// --- Property 7: Off-screen pipes are bounded -------------------------------

test(
  propertyName(7, "Off-screen pipes are bounded"),
  () => {
    const { width: pipeWidth } = CONFIG.pipe;

    assertProperty(
      fc.property(
        fc.integer(),
        fc.integer({ min: 50, max: 400 }),
        fc.double({ min: 0.01, max: 0.08, noNaN: true }),
        fc.double({
          min: CONFIG.scroll.base,
          max: CONFIG.scroll.max,
          noNaN: true,
        }),
        (seed, steps, dt, scrollSpeed) => {
          const rng = createRng(seed);
          let pipes = [];
          let lastGapCenter = null;

          for (let i = 0; i < steps; i += 1) {
            const res = stepSpawner(
              pipes,
              scrollSpeed,
              dt,
              rng,
              lastGapCenter,
              CONFIG,
            );
            pipes = res.pipes;
            lastGapCenter = res.lastGapCenter;

            // After every step, no surviving pair may be fully off the left edge.
            for (const p of pipes) {
              assert.ok(
                p.x + pipeWidth >= 0,
                `off-screen pipe survived: trailing edge ${p.x + pipeWidth} < 0`,
              );
            }
          }

          // The list stays bounded: it can never exceed the number of pairs that
          // fit across the playfield at the fixed spacing (plus a small margin).
          const maxExpected =
            Math.ceil(CONFIG.playfield.width / CONFIG.pipe.spacing) + 3;
          assert.ok(
            pipes.length <= maxExpected,
            `pipe list grew unbounded: ${pipes.length} > ${maxExpected}`,
          );

          return true;
        },
      ),
    );
  },
);
