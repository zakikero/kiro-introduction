// test-support/helpers.js — shared helpers for the no-browser test harness.
//
// Lives OUTSIDE the `test/` tree on purpose: Node's built-in runner
// (`node --test`) treats every `.js` file under a `test/` directory as a test
// file, so support modules kept there would be run as empty suites. Placing
// shared helpers here keeps test discovery limited to real `*.test.js` files.
//
// The harness exercises the pure logic modules (`src/systems/*`, `src/save.js`,
// and the FSM tick in `src/state.js`) with NO DOM and NO browser. Only
// pure-function modules are imported by tests; nothing here touches the Canvas,
// localStorage, or any other browser global.
//
// Property-based tests use `fast-check` (never hand-rolled generators). This
// module centralizes two project conventions so every property test follows
// them automatically:
//
//   1. Naming/tag convention. Every property test is tagged
//          `Feature: flappy-kiro, Property {n}: {property text}`
//      Use `propertyName(n, text)` to build that exact string and pass it as
//      the `node:test` test name.
//
//   2. Minimum iterations. Each property runs at least `MIN_RUNS` (100)
//      iterations. `assertProperty` forces `numRuns` to be at least that many,
//      so a property can ask for more but never fewer than the spec requires.
//
// Example (a later property task):
//
//   import { test } from 'node:test';
//   import { fc, propertyName, assertProperty } from '../test-support/helpers.js';
//
//   test(propertyName(2, 'Normal_Flap sets velocity'), () => {
//     assertProperty(
//       fc.property(fc.double(), (v) => { ... }),
//     );
//   });

import fc from "fast-check";

/** Spec feature tag used in every property-test name. */
export const FEATURE_TAG = "flappy-kiro";

/** Minimum fast-check iterations per property, per the Testing Strategy. */
export const MIN_RUNS = 100;

/**
 * Build the canonical property-test name/tag:
 *   `Feature: flappy-kiro, Property {n}: {property text}`
 * @param {number} n the property number from the design document
 * @param {string} text the property's short descriptive text
 * @returns {string}
 */
export function propertyName(n, text) {
  return `Feature: ${FEATURE_TAG}, Property ${n}: ${text}`;
}

/**
 * Run a fast-check property, enforcing the project minimum iteration count.
 * Throws (failing the enclosing `node:test` case) on a counterexample.
 *
 * @param {fc.IRawProperty<unknown>} property a property built with fast-check
 * @param {fc.Parameters<unknown>} [params] optional fast-check parameters;
 *   `numRuns` is clamped up to at least {@link MIN_RUNS}
 * @returns {void}
 */
export function assertProperty(property, params = {}) {
  const numRuns = Math.max(MIN_RUNS, params.numRuns ?? MIN_RUNS);
  fc.assert(property, { ...params, numRuns });
}

export { fc };
