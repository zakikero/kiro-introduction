// test/loop.test.js — property tests for the fixed-timestep loop (src/loop.js).
//
// Covers two design properties exercised headlessly against the pure
// `computeFixedSteps` helper (no DOM, no requestAnimationFrame):
//
//   Property 1 — Frame-rate independence (Requirements 1.1, 1.10)
//     For identical initial state, identical RNG seed, and inputs assigned to
//     identical simulation ticks, two partitions of the SAME total accepted
//     simulation time into frames yield equivalent committed state and
//     collision outcomes. Equivalence is defined over equal ACCEPTED simulation
//     time, not equal wall-clock time, so all frames here stay at or below
//     MAX_FRAME_TIME (nothing is clamped) and both partitions sum to the same
//     total time.
//
//   Property 4 — Max-step clamp (Requirement 1.9)
//     A single frame advances the simulation by at most MAX_FRAME_TIME of
//     simulation time, for ANY frame time including huge, negative, or
//     non-finite values. Tested separately from Property 1.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXED_DT,
  MAX_FRAME_TIME,
  computeFixedSteps,
} from '../src/loop.js';
import { fc, assertProperty, propertyName } from '../test-support/helpers.js';

// A tiny deterministic mock FSM whose "committed state" is fully determined by
// the number of fixed steps run and the per-tick intents handed to it. It
// records a running count plus a cheap order-sensitive hash of the intents it
// consumed, so two runs are "equivalent" only if they ran the same steps with
// the same intents in the same order.
function makeMockFsm() {
  return {
    steps: 0,
    // Order-sensitive running hash of consumed intents (committed state proxy).
    hash: 0,
    tick(dt, intent) {
      this.steps += 1;
      // Mix the intent into the hash deterministically; collisions here would
      // only weaken the test, and integer mixing is plenty for small intents.
      const v = Number.isFinite(intent) ? intent : 0;
      this.hash = (this.hash * 31 + this.steps + v) % 1_000_000_007;
    },
  };
}

/**
 * Drive the pure stepping helper over a sequence of frame times, calling
 * `fsm.tick` once per fixed step. Intents are assigned to GLOBAL simulation
 * ticks (not to frames), so the same tick index always receives the same
 * intent regardless of how the time was partitioned into frames.
 *
 * @param {number[]} frameTimes per-frame accepted times (seconds)
 * @param {(tickIndex: number) => number} intentForTick intent assigned to a tick
 * @returns {{ fsm: ReturnType<typeof makeMockFsm>, totalSteps: number }}
 */
function driveFrames(frameTimes, intentForTick) {
  const fsm = makeMockFsm();
  let accumulator = 0;
  let tickIndex = 0;
  for (const frameTime of frameTimes) {
    const { steps, accumulator: nextAcc } = computeFixedSteps(
      accumulator,
      frameTime
    );
    for (let i = 0; i < steps; i += 1) {
      fsm.tick(FIXED_DT, intentForTick(tickIndex));
      tickIndex += 1;
    }
    accumulator = nextAcc;
  }
  return { fsm, totalSteps: fsm.steps };
}

// Partition a total time into `count` frames whose sizes sum EXACTLY to total
// (the last frame absorbs any rounding remainder) and never exceed the clamp.
// Keeping every frame <= MAX_FRAME_TIME guarantees no frame is clamped, so the
// total accepted simulation time equals `total` for every partition.
function partitionTime(total, weights) {
  const sumW = weights.reduce((a, b) => a + b, 0) || 1;
  const frames = [];
  let used = 0;
  for (let i = 0; i < weights.length - 1; i += 1) {
    let slice = (total * weights[i]) / sumW;
    if (slice > MAX_FRAME_TIME) slice = MAX_FRAME_TIME;
    frames.push(slice);
    used += slice;
  }
  // Last frame takes the remainder; if that would exceed the clamp, spread the
  // overflow into additional max-sized frames so nothing is ever clamped.
  let remainder = total - used;
  while (remainder > MAX_FRAME_TIME) {
    frames.push(MAX_FRAME_TIME);
    remainder -= MAX_FRAME_TIME;
  }
  if (remainder > 0) frames.push(remainder);
  return frames;
}

// --- Property 1: Frame-rate independence -------------------------------------

test(propertyName(1, 'Frame-rate independence'), () => {
  assertProperty(
    fc.property(
      // Total accepted simulation time to divide between the two partitions.
      // Bounded so runs stay fast but still span many fixed steps.
      fc.double({ min: 0, max: 5, noNaN: true }),
      // Two independent sets of positive weights → two different partitions of
      // the SAME total time into different frame sequences.
      fc.array(fc.double({ min: 0.01, max: 1, noNaN: true }), {
        minLength: 1,
        maxLength: 30,
      }),
      fc.array(fc.double({ min: 0.01, max: 1, noNaN: true }), {
        minLength: 1,
        maxLength: 30,
      }),
      // Seed for a deterministic per-tick intent function (intents are assigned
      // to identical simulation ticks across both partitions).
      fc.integer({ min: 1, max: 1_000_000 }),
      (total, weightsA, weightsB, seed) => {
        const intentForTick = (tick) => (tick * seed) % 7;

        const framesA = partitionTime(total, weightsA);
        const framesB = partitionTime(total, weightsB);

        const a = driveFrames(framesA, intentForTick);
        const b = driveFrames(framesB, intentForTick);

        // Equal accepted simulation time → equal committed fixed steps and
        // equal committed state (the intent hash). Allow at most a 1-step
        // difference from floating-point partition rounding, then require the
        // committed state to match whenever the step counts agree.
        const stepsEqual = a.totalSteps === b.totalSteps;
        const expectedSteps = Math.floor(total / FIXED_DT);

        // Both partitions should land within one step of the ideal count.
        if (Math.abs(a.totalSteps - expectedSteps) > 1) return false;
        if (Math.abs(b.totalSteps - expectedSteps) > 1) return false;

        // When they agree on step count, committed state must be identical.
        if (stepsEqual && a.fsm.hash !== b.fsm.hash) return false;
        return true;
      }
    )
  );
});

// A stricter, rounding-free variant: build both partitions from whole multiples
// of FIXED_DT so both ALWAYS run exactly the same number of steps, then require
// byte-for-byte identical committed state and step count. This is the core of
// frame-rate independence with no floating-point slack.
test(
  propertyName(1, 'Frame-rate independence') +
    ' (exact: identical committed state across partitions)',
  () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 0, max: 400 }), // total steps' worth of sim time
        fc.array(fc.integer({ min: 1, max: 11 }), {
          minLength: 1,
          maxLength: 25,
        }),
        fc.array(fc.integer({ min: 1, max: 11 }), {
          minLength: 1,
          maxLength: 25,
        }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (totalSteps, chunksA, chunksB, seed) => {
          const intentForTick = (tick) => (tick * seed + 3) % 13;

          // Each partition is a sequence of frames measured in whole fixed
          // steps (<= 11 steps ≈ 0.092 s < MAX_FRAME_TIME, so never clamped),
          // padded/trimmed so both sum to exactly `totalSteps` fixed steps.
          const toFrames = (chunks) => {
            const frames = [];
            let remaining = totalSteps;
            for (const c of chunks) {
              if (remaining <= 0) break;
              const n = Math.min(c, remaining);
              frames.push(n * FIXED_DT);
              remaining -= n;
            }
            while (remaining > 0) {
              const n = Math.min(11, remaining);
              frames.push(n * FIXED_DT);
              remaining -= n;
            }
            return frames;
          };

          const a = driveFrames(toFrames(chunksA), intentForTick);
          const b = driveFrames(toFrames(chunksB), intentForTick);

          if (a.totalSteps !== b.totalSteps) return false;
          if (a.fsm.hash !== b.fsm.hash) return false;
          return true;
        }
      )
    );
  }
);

// --- Property 4: Max-step clamp ----------------------------------------------

test(propertyName(4, 'Max-step clamp'), () => {
  // The simulation SHALL advance by at most MAX_FRAME_TIME of simulation time
  // for a single frame, for ANY frame time — including huge, negative, zero,
  // and non-finite values.
  const maxStepsPerFrame = Math.ceil(MAX_FRAME_TIME / FIXED_DT); // 12

  assertProperty(
    fc.property(
      // Any accumulator already carried from a previous frame, in [0, FIXED_DT).
      fc.double({ min: 0, max: FIXED_DT, noNaN: true }),
      // Any frame time at all: finite (incl. negative/huge) or non-finite.
      fc.oneof(
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        fc.constantFrom(
          Number.POSITIVE_INFINITY,
          Number.NEGATIVE_INFINITY,
          Number.NaN,
          -0
        )
      ),
      (accumulator, frameTime) => {
        const acc = Math.min(accumulator, FIXED_DT * 0.999999);
        const { steps, acceptedFrameTime } = computeFixedSteps(acc, frameTime);

        // Accepted frame time never exceeds the clamp (and is never negative).
        if (!(acceptedFrameTime <= MAX_FRAME_TIME)) return false;
        if (!(acceptedFrameTime >= 0)) return false;

        // The simulation time committed this frame is at most MAX_FRAME_TIME:
        // steps*FIXED_DT consumes accepted time plus at most the carried
        // sub-step accumulator, so steps can be at most ceil(MAX/FIXED_DT).
        if (steps > maxStepsPerFrame) return false;
        if (steps * FIXED_DT > MAX_FRAME_TIME + FIXED_DT) return false;

        return true;
      }
    )
  );
});
