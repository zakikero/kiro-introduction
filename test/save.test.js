// test/save.test.js — load-tolerance tests for browser-local persistence
// (src/save.js). Pure logic, no DOM: the no-browser runner has no
// `localStorage`, so these tests exercise the reusable validation core
// (`sanitizeSave`) and the full JSON.parse-then-sanitize load pipeline
// directly, which is exactly the path `loadSave` runs after reading storage.
//
// Covers:
//   - Property 25: Load tolerates any stored value — any stored string
//     (including missing/corrupt) yields schema-valid SaveData with safe
//     defaults and never throws.
//     Validates: Requirements 11.2, 11.3
//   - Unit tests pinning the schema-default fallback for the obvious
//     corrupt-input cases (null, wrong types, unowned equipped hat, unknown
//     hat ids) so the repair rules are anchored by example as well as property.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import {
  sanitizeSave,
  defaultSave,
  knownHatIds,
  GAME_ID,
  NONE_HAT,
} from '../src/save.js';
import { fc, assertProperty, propertyName } from '../test-support/helpers.js';

const KNOWN = new Set(knownHatIds(CONFIG));

/**
 * Assert that `save` satisfies the full SaveData schema and all its
 * invariants. Throws (failing the enclosing test) on any violation. Returns
 * nothing; used by both the property body and the unit tests.
 */
function assertSchemaValid(save) {
  // Shape.
  assert.ok(save && typeof save === 'object', 'save must be an object');

  // gameId / version are stamped from config, never from input.
  assert.equal(save.gameId, GAME_ID, 'gameId must be the canonical game id');
  assert.equal(save.version, CONFIG.saveVersion, 'version must come from config');

  // highScore / candy are non-negative integers.
  for (const field of ['highScore', 'candy']) {
    const v = save[field];
    assert.equal(typeof v, 'number', `${field} must be a number`);
    assert.ok(Number.isInteger(v), `${field} must be an integer`);
    assert.ok(v >= 0, `${field} must be non-negative`);
  }

  // ownedHats is an array of known ids, always including 'none', no dupes.
  assert.ok(Array.isArray(save.ownedHats), 'ownedHats must be an array');
  assert.ok(save.ownedHats.includes(NONE_HAT), "ownedHats must include 'none'");
  const seen = new Set();
  for (const id of save.ownedHats) {
    assert.ok(KNOWN.has(id), `owned hat ${id} must be a known id`);
    assert.ok(!seen.has(id), `owned hat ${id} must not be duplicated`);
    seen.add(id);
  }

  // equippedHat is a known id that is actually owned.
  assert.ok(KNOWN.has(save.equippedHat), 'equippedHat must be a known id');
  assert.ok(seen.has(save.equippedHat), 'equippedHat must be owned');

  // prefs.muted / prefs.reducedMotion are booleans.
  assert.ok(save.prefs && typeof save.prefs === 'object', 'prefs must be an object');
  assert.equal(typeof save.prefs.muted, 'boolean', 'prefs.muted must be boolean');
  assert.equal(
    typeof save.prefs.reducedMotion,
    'boolean',
    'prefs.reducedMotion must be boolean',
  );
}

// --- Unit tests -------------------------------------------------------------

test('sanitizeSave(null) returns the schema default (Req 11.3)', () => {
  const save = sanitizeSave(null, CONFIG);
  assert.deepEqual(save, defaultSave(CONFIG));
  assertSchemaValid(save);
});

test('sanitizeSave of a non-object (string/number/array) returns the default (Req 11.3)', () => {
  for (const raw of ['', 'garbage', 42, true, []]) {
    const save = sanitizeSave(raw, CONFIG);
    assertSchemaValid(save);
    // Non-object input carries no recoverable fields → full default.
    if (!Array.isArray(raw)) {
      assert.deepEqual(save, defaultSave(CONFIG));
    }
  }
});

test('sanitizeSave coerces wrong-typed numeric fields to safe defaults (Req 11.2)', () => {
  const save = sanitizeSave(
    { highScore: 'lots', candy: -5, prefs: { muted: 'yes', reducedMotion: 1 } },
    CONFIG,
  );
  assert.equal(save.highScore, 0);
  assert.equal(save.candy, 0);
  assert.equal(save.prefs.muted, false);
  assert.equal(save.prefs.reducedMotion, false);
  assertSchemaValid(save);
});

test('sanitizeSave drops unknown hat ids and keeps known owned ones (Req 11.2)', () => {
  const save = sanitizeSave(
    { ownedHats: [NONE_HAT, 'witchHat', 'not_a_hat', 123, 'witchHat'] },
    CONFIG,
  );
  assert.deepEqual([...new Set(save.ownedHats)], save.ownedHats, 'no duplicates');
  assert.ok(save.ownedHats.includes('witchHat'));
  assert.ok(!save.ownedHats.includes('not_a_hat'));
  assertSchemaValid(save);
});

test('sanitizeSave resets equippedHat to none when it is not owned (Req 11.2)', () => {
  const save = sanitizeSave(
    { ownedHats: [NONE_HAT], equippedHat: 'hauntedCrown' },
    CONFIG,
  );
  assert.equal(save.equippedHat, NONE_HAT);
  assertSchemaValid(save);
});

test('sanitizeSave keeps a known, owned equippedHat (Req 11.2)', () => {
  const save = sanitizeSave(
    { ownedHats: [NONE_HAT, 'pumpkinCap'], equippedHat: 'pumpkinCap' },
    CONFIG,
  );
  assert.equal(save.equippedHat, 'pumpkinCap');
  assert.ok(save.ownedHats.includes('pumpkinCap'));
  assertSchemaValid(save);
});

// --- Property test ----------------------------------------------------------

// An arbitrary that leans toward *plausible-but-corrupt* save objects: some
// fields present with right types, others with wrong types, plus unknown hat
// ids and unowned equipped hats. fast-check builds and shrinks these; we never
// hand-roll generators.
const hatIdArb = fc.oneof(
  fc.constantFrom(...knownHatIds(CONFIG)), // known ids (incl. 'none')
  fc.string(), // random strings (mostly unknown ids)
);

const saveLikeObjectArb = fc.record(
  {
    gameId: fc.oneof(fc.constant(GAME_ID), fc.string(), fc.constant(undefined)),
    version: fc.oneof(fc.integer(), fc.string(), fc.constant(undefined)),
    highScore: fc.oneof(
      fc.integer(),
      fc.double(),
      fc.string(),
      fc.constant(undefined),
    ),
    candy: fc.oneof(
      fc.integer(),
      fc.double(),
      fc.string(),
      fc.constant(undefined),
    ),
    ownedHats: fc.oneof(
      fc.array(hatIdArb),
      fc.string(),
      fc.constant(undefined),
    ),
    equippedHat: fc.oneof(hatIdArb, fc.constant(undefined)),
    prefs: fc.oneof(
      fc.record(
        {
          muted: fc.oneof(fc.boolean(), fc.string(), fc.integer()),
          reducedMotion: fc.oneof(fc.boolean(), fc.string(), fc.integer()),
        },
        { requiredKeys: [] },
      ),
      fc.string(),
      fc.constant(undefined),
    ),
  },
  { requiredKeys: [] },
);

// Any stored value at all: structured save-like objects, arbitrary JSON values,
// and raw/undefined. Covers the "any stored value" breadth of the property.
const anyStoredValueArb = fc.oneof(
  saveLikeObjectArb,
  fc.anything(),
  fc.constant(null),
  fc.constant(undefined),
);

test(
  propertyName(
    25,
    'Load tolerates any stored value — any stored string (including missing/corrupt) yields schema-valid SaveData with safe defaults and never throws',
  ),
  () => {
    assertProperty(
      fc.property(anyStoredValueArb, (raw) => {
        // sanitizeSave must be total: never throws, always schema-valid.
        const sanitized = sanitizeSave(raw, CONFIG);
        assertSchemaValid(sanitized);
        return true;
      }),
      { numRuns: 500 },
    );
  },
);

test(
  propertyName(
    25,
    'Load pipeline tolerates any stored string — JSON.parse-then-sanitize never throws and yields a valid save',
  ),
  () => {
    assertProperty(
      fc.property(fc.string(), (storedText) => {
        // Mirror loadSave's stored-string handling: parse (catching corrupt
        // JSON), then sanitize. The whole path must never throw and must
        // always produce a schema-valid save.
        let parsed;
        try {
          parsed = JSON.parse(storedText);
        } catch {
          parsed = undefined; // corrupt/unparseable → default fallback
        }
        const save = sanitizeSave(parsed, CONFIG);
        assertSchemaValid(save);
        return true;
      }),
      { numRuns: 500 },
    );
  },
);

test(
  propertyName(
    25,
    'Load pipeline tolerates JSON-encoded save-like values — serialize then parse-then-sanitize stays valid',
  ),
  () => {
    assertProperty(
      fc.property(anyStoredValueArb, (raw) => {
        // Round-trip a value through JSON the way it would actually be stored,
        // then run the load path over the serialized string.
        let storedText;
        try {
          storedText = JSON.stringify(raw);
        } catch {
          storedText = undefined;
        }
        let parsed;
        try {
          parsed = storedText == null ? undefined : JSON.parse(storedText);
        } catch {
          parsed = undefined;
        }
        const save = sanitizeSave(parsed, CONFIG);
        assertSchemaValid(save);
        return true;
      }),
      { numRuns: 500 },
    );
  },
);
