// test/scoring.test.js — property test for Pipe_Score accrual.
//
// Exercises src/systems/scoring.js (pure logic, no DOM) with fast-check:
//   Property 24: One point per fully-passed pipe — each pair increases
//                Pipe_Score by exactly one, only AFTER the Hitbox has fully
//                passed the pair's trailing edge, and never twice.
//
// Validates: Requirements 10.1, 10.2
//
// Construction (per the task guidance): fix Ghosty at a chosen x, scatter N
// pairs at random distinct x positions to Ghosty's right, then repeatedly
// scroll every pair LEFT by random positive deltas, calling stepScoring on
// every step. Because pipes only ever move left (Ghosty's hitbox effectively
// moves right past them), a pair can only ever become fully-passed and never
// un-pass, which makes the scored latch observable.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { stepScoring, hasFullyPassed } from "../src/systems/scoring.js";
import { hitboxFor } from "../src/systems/collision.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

const PIPE_WIDTH = CONFIG.pipe.width; // 70

// Build a minimal RunState for scoring: only ghosty center, pipes, pipeScore
// are read/written by stepScoring.
function makeRunState(ghostyX, ghostyY, pipes) {
  return {
    ghosty: { x: ghostyX, y: ghostyY },
    pipes,
    pipeScore: 0,
  };
}

// --- Property 24: One point per fully-passed pipe ---------------------------

test(propertyName(24, "One point per fully-passed pipe"), () => {
  assertProperty(
    fc.property(
      // Ghosty's fixed center x/y (y is irrelevant to the horizontal pass rule
      // but kept realistic within the playfield).
      fc.double({ min: 100, max: 500, noNaN: true }),
      fc.double({ min: 50, max: 590, noNaN: true }),
      // Distinct left-edge x positions for N pairs, all strictly to Ghosty's
      // right initially (offsets added to ghostyX so none start passed).
      fc.uniqueArray(fc.integer({ min: 1, max: 4000 }), {
        minLength: 1,
        maxLength: 8,
      }),
      // A sequence of leftward scroll deltas (strictly positive) to apply.
      fc.array(fc.double({ min: 0.5, max: 300, noNaN: true }), {
        minLength: 1,
        maxLength: 40,
      }),
      (ghostyX, ghostyY, offsets, deltas) => {
        // Place each pair's left edge to the right of Ghosty so initially
        // nothing is passed. Offsets are distinct so left edges are distinct.
        const pipes = offsets.map((off, i) => ({
          id: i,
          x: ghostyX + off,
          gapCenter: 320,
          gapHeight: CONFIG.pipe.gapHeight,
          scored: false,
          shieldGrace: false,
        }));

        const runState = makeRunState(ghostyX, ghostyY, pipes);
        const hitbox = hitboxFor(runState.ghosty, CONFIG);
        const hitboxX = hitbox.x; // fixed; only pipes move

        const N = pipes.length;

        // Invariant checked every step: a pair is `scored` iff the hitbox has
        // fully passed its trailing edge, and pipeScore equals the count of
        // scored pairs. We also assert no pair scores before being passed.
        function scoredCountShouldBe() {
          return pipes.filter((p) => hasFullyPassed(hitbox, p, CONFIG)).length;
        }

        // Step 0: nothing has moved, nothing to Ghosty's right is passed yet.
        stepScoring(runState, CONFIG);
        if (runState.pipeScore !== scoredCountShouldBe()) return false;

        for (const d of deltas) {
          // Scroll every pair left.
          for (const p of pipes) p.x -= d;

          // Before scoring, record which pairs are NOT yet passed; scoring
          // must not award any of them this step.
          const notPassedBefore = pipes.filter(
            (p) => !hasFullyPassed(hitbox, p, CONFIG),
          );

          const prevScore = runState.pipeScore;
          stepScoring(runState, CONFIG);

          // (a) No un-passed pair got scored this step.
          for (const p of notPassedBefore) {
            if (p.scored && !hasFullyPassed(hitbox, p, CONFIG)) {
              return false; // scored while not fully passed
            }
          }

          // Score only ever increases and matches the fully-passed count.
          if (runState.pipeScore < prevScore) return false;
          if (runState.pipeScore !== scoredCountShouldBe()) return false;

          // (b/c) pipeScore equals count of pairs whose trailing edge the
          // hitbox has fully passed, and never exceeds N.
          const expected = pipes.filter(
            (p) => hitboxX >= p.x + PIPE_WIDTH,
          ).length;
          if (runState.pipeScore !== expected) return false;
          if (runState.pipeScore > N) return false;

          // Every scored pair must genuinely be fully passed (latch is honest).
          for (const p of pipes) {
            if (p.scored && hitboxX < p.x + PIPE_WIDTH) return false;
          }
        }

        // (b) Idempotence: calling stepScoring again with no movement changes
        // nothing — no pair is double-awarded.
        const settled = runState.pipeScore;
        stepScoring(runState, CONFIG);
        stepScoring(runState, CONFIG);
        if (runState.pipeScore !== settled) return false;

        // Final: pipeScore equals the number of pairs fully passed, within N.
        const finalExpected = pipes.filter(
          (p) => hitboxX >= p.x + PIPE_WIDTH,
        ).length;
        if (runState.pipeScore !== finalExpected) return false;
        if (runState.pipeScore > N) return false;

        return true;
      },
    ),
  );
});
