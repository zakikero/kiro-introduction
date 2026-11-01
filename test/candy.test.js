// test/candy.test.js — tests for the permanent Candy award and one-shot Run
// finalize (systems/candy.js).
//
// Pure logic, no DOM. Covers:
//   - Property 22: Candy formula — Candy equals floor(Active_Flight_Time / 15)
//     plus the boss-victory bonus when defeated, and depends on no other time
//     or field. Validates: Requirements 8.1, 8.2, 8.3
//   - Property 23: Finalize awards exactly once — across any number of
//     finalizeRun calls, the Run's Candy is added exactly once and the high
//     score is updated at most once (only when final Pipe_Score exceeds the
//     stored high score); an unstarted Run awards nothing.
//     Validates: Requirements 8.6, 11.14
//   - Unit tests anchoring the formula, the one-shot latch, the high-score
//     update rule, and the unstarted-run case.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { createRunState } from '../src/state.js';
import { defaultSave } from '../src/save.js';
import { candyForRun, finalizeRun } from '../src/systems/candy.js';
import { fc, assertProperty, propertyName } from '../test-support/helpers.js';

const DIVISOR = CONFIG.candy.perRunDivisor; // 15
const BOSS_BONUS = CONFIG.candy.bossVictoryBonus; // 3

// --- Unit tests -------------------------------------------------------------

test('candyForRun floors time by the divisor and adds no bonus without a boss defeat (Req 8.1)', () => {
  assert.equal(candyForRun(0, false, CONFIG), 0);
  assert.equal(candyForRun(14.9, false, CONFIG), 0);
  assert.equal(candyForRun(15, false, CONFIG), 1);
  assert.equal(candyForRun(44, false, CONFIG), 2);
  assert.equal(candyForRun(45, false, CONFIG), 3);
});

test('candyForRun adds the boss-victory bonus when the boss was defeated (Req 8.2)', () => {
  assert.equal(candyForRun(0, true, CONFIG), BOSS_BONUS);
  assert.equal(candyForRun(45, true, CONFIG), 3 + BOSS_BONUS);
});

test('candyForRun clamps a negative time to zero (never negative)', () => {
  assert.equal(candyForRun(-100, false, CONFIG), 0);
  assert.equal(candyForRun(-100, true, CONFIG), BOSS_BONUS);
});

test('finalizeRun awards Candy and updates high score once, then no-ops (Req 8.6, 11.14)', () => {
  const rs = createRunState(CONFIG);
  rs.started = true;
  rs.activeFlightTime = 45; // -> 3 Candy
  rs.bossDefeated = true; // -> +3 Candy
  rs.pipeScore = 7;
  const save = defaultSave(CONFIG); // candy 0, highScore 0

  const first = finalizeRun(rs, save, CONFIG);
  assert.equal(first.finalized, true);
  assert.equal(save.candy, 3 + BOSS_BONUS);
  assert.equal(save.highScore, 7);

  // Any later call is a no-op: no duplicate award, no high-score bump.
  const second = finalizeRun(rs, save, CONFIG);
  assert.equal(second.finalized, false);
  assert.equal(save.candy, 3 + BOSS_BONUS);
  assert.equal(save.highScore, 7);
});

test('finalizeRun leaves the high score unchanged when Pipe_Score does not beat it (Req 11.13)', () => {
  const rs = createRunState(CONFIG);
  rs.started = true;
  rs.activeFlightTime = 30;
  rs.pipeScore = 4;
  const save = defaultSave(CONFIG);
  save.highScore = 10; // already higher than this run's score

  finalizeRun(rs, save, CONFIG);
  assert.equal(save.highScore, 10); // unchanged
  assert.equal(save.candy, 2); // still awarded floor(30/15) = 2
});

test('finalizeRun on an unstarted Run awards nothing and leaves the save untouched (Req 8.5)', () => {
  const rs = createRunState(CONFIG); // started === false
  rs.activeFlightTime = 120; // would be plenty of Candy if it counted
  rs.bossDefeated = true;
  rs.pipeScore = 99;
  const save = defaultSave(CONFIG);

  const res = finalizeRun(rs, save, CONFIG);
  assert.equal(res.finalized, true); // still latched for a stable result view
  assert.equal(save.candy, 0);
  assert.equal(save.highScore, 0);

  // And it stays untouched on repeat.
  finalizeRun(rs, save, CONFIG);
  assert.equal(save.candy, 0);
  assert.equal(save.highScore, 0);
});

// --- Property 22: Candy formula ---------------------------------------------

test(
  propertyName(
    22,
    'Candy equals floor(Active_Flight_Time / 15) plus the boss bonus when defeated, and depends on no other time',
  ),
  () => {
    assertProperty(
      fc.property(
        // Active_Flight_Time in seconds (fractional allowed; the formula floors).
        fc.double({ min: 0, max: 100000, noNaN: true }),
        fc.boolean(),
        // Arbitrary OTHER fields that must NOT influence the Candy formula:
        // any other "time" or counter the Run happens to carry.
        fc.integer({ min: 0, max: 100000 }), // pipeScore
        fc.integer({ min: 0, max: 100000 }), // soulCoins
        fc.integer({ min: 0, max: 100000 }), // battleHp
        fc.double({ min: 0, max: 100000, noNaN: true }), // a stray "battle time"
        (activeFlightTime, bossDefeated, pipeScore, soulCoins, battleHp, otherTime) => {
          const expected =
            Math.floor(activeFlightTime / DIVISOR) + (bossDefeated ? BOSS_BONUS : 0);

          const actual = candyForRun(activeFlightTime, bossDefeated, CONFIG);
          if (actual !== expected) return false;

          // Depends on NO other field: build a RunState loaded with arbitrary
          // other values and confirm candyForRun, reading only the two inputs,
          // returns the same result regardless of those fields.
          const rs = createRunState(CONFIG);
          rs.activeFlightTime = activeFlightTime;
          rs.bossDefeated = bossDefeated;
          rs.pipeScore = pipeScore;
          rs.soulCoins = soulCoins;
          rs.battleHp = battleHp;
          rs.scratchTime = otherTime; // a field the formula never reads

          const viaState = candyForRun(rs.activeFlightTime, rs.bossDefeated, CONFIG);
          if (viaState !== expected) return false;

          // Non-negative integer always.
          if (!Number.isInteger(actual) || actual < 0) return false;

          return true;
        },
      ),
    );
  },
);

// --- Property 23: Finalize awards exactly once ------------------------------

test(
  propertyName(
    23,
    'finalizeRun adds the Run Candy exactly once and updates the high score at most once across any number of calls',
  ),
  () => {
    assertProperty(
      fc.property(
        fc.boolean(), // started
        fc.double({ min: 0, max: 100000, noNaN: true }), // activeFlightTime
        fc.boolean(), // bossDefeated
        fc.integer({ min: 0, max: 1000 }), // pipeScore this run
        fc.integer({ min: 0, max: 1000 }), // initial save.highScore
        fc.integer({ min: 0, max: 1000 }), // initial save.candy
        fc.integer({ min: 1, max: 25 }), // number of finalize calls
        (started, activeFlightTime, bossDefeated, pipeScore, initHigh, initCandy, calls) => {
          const rs = createRunState(CONFIG);
          rs.started = started;
          rs.activeFlightTime = activeFlightTime;
          rs.bossDefeated = bossDefeated;
          rs.pipeScore = pipeScore;

          const save = defaultSave(CONFIG);
          save.highScore = initHigh;
          save.candy = initCandy;

          // The single award the FIRST call should produce (0 for an unstarted
          // Run, which awards nothing — Req 8.5).
          const expectedAward = started
            ? candyForRun(activeFlightTime, bossDefeated, CONFIG)
            : 0;
          // The high score is updated only when a STARTED Run's final Pipe_Score
          // beats the stored value (Req 11.13).
          const expectedHigh =
            started && pipeScore > initHigh ? pipeScore : initHigh;

          let finalizedTrueCount = 0;
          for (let i = 0; i < calls; i += 1) {
            const res = finalizeRun(rs, save, CONFIG);
            if (res.finalized) finalizedTrueCount += 1;
            // The returned save is always the same mutated object.
            if (res.save !== save) return false;
          }

          // Exactly one call reported performing the finalize.
          if (finalizedTrueCount !== 1) return false;

          // Candy added exactly once: total delta equals a single award.
          if (save.candy !== initCandy + expectedAward) return false;

          // High score updated at most once, only when it should have been.
          if (save.highScore !== expectedHigh) return false;

          // High score never regresses below the initial stored value.
          if (save.highScore < initHigh) return false;

          return true;
        },
      ),
    );
  },
);
