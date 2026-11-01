// test/save-portable.test.js — property tests for the portable save path
// (export/import) in src/save.js. Pure logic, no DOM: `exportSave` runs
// headlessly (returns `text` even when no Blob exists) and `parseImport` is a
// pure validate/serialize function, so both are exercised directly by the
// no-browser runner.
//
// Covers:
//   - Property 26: Export/import round-trip — exporting then importing yields
//     SaveData equal to the original (replace, not merge). Because export
//     canonicalizes via sanitizeSave, the "original" compared against is the
//     canonical (sanitized) form.
//     Validates: Requirements 11.7, 11.11
//   - Property 27: Invalid imports leave progress unchanged — wrong game id,
//     unsupported version, non-numeric values, unknown Hat id, or an unowned
//     equipped Hat is rejected (ok:false) with no save returned and no mutation
//     of a separate "current save" the caller holds.
//     Validates: Requirements 11.8, 11.9

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import {
  exportSave,
  parseImport,
  sanitizeSave,
  defaultSave,
  knownHatIds,
  GAME_ID,
  NONE_HAT,
} from '../src/save.js';
import { fc, assertProperty, propertyName } from '../test-support/helpers.js';

const KNOWN_HATS = knownHatIds(CONFIG); // includes 'none'
const NON_NONE_HATS = KNOWN_HATS.filter((h) => h !== NONE_HAT);

// A hat id that is NOT a known id for this build (used for the unknown-hat
// rejection case). Keeps away from any real config hat id.
const UNKNOWN_HAT = '__definitely_not_a_hat__';

// --- Arbitraries ------------------------------------------------------------

// Build an arbitrary, possibly-messy save-like object, then canonicalize it
// with sanitizeSave so we have a guaranteed-valid SaveData to export. This
// mirrors how save.test.js builds plausible-but-corrupt inputs; we never
// hand-roll generators.
const hatIdArb = fc.oneof(
  fc.constantFrom(...KNOWN_HATS),
  fc.string(), // mostly unknown ids, dropped by sanitize
);

const saveLikeObjectArb = fc.record(
  {
    gameId: fc.oneof(fc.constant(GAME_ID), fc.string(), fc.constant(undefined)),
    version: fc.oneof(fc.integer(), fc.string(), fc.constant(undefined)),
    highScore: fc.oneof(
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.double(),
      fc.string(),
      fc.constant(undefined),
    ),
    candy: fc.oneof(
      fc.integer({ min: 0, max: 1_000_000 }),
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

// A canonical, schema-valid SaveData (the sanitized form of an arbitrary
// save-like object). This is exactly what export produces and what a
// round-trip must recover.
const canonicalSaveArb = saveLikeObjectArb.map((raw) => sanitizeSave(raw, CONFIG));

// --- Property 26: Export/import round-trip ----------------------------------

test(
  propertyName(
    26,
    'Export/import round-trip — exporting then importing yields SaveData equal to the canonical original (replace, not merge)',
  ),
  () => {
    assertProperty(
      fc.property(canonicalSaveArb, (canonical) => {
        const { text } = exportSave(canonical, CONFIG);
        assert.equal(typeof text, 'string');

        const result = parseImport(text, CONFIG);
        assert.equal(result.ok, true, 'a canonical save must import cleanly');
        assert.ok(result.save, 'ok import must carry a save');

        // Replace, not merge: the imported save deep-equals the canonical
        // original with no leftover fields from any prior state.
        assert.deepEqual(result.save, canonical);

        // Exporting the imported save again produces identical text — the
        // round-trip is a fixed point.
        const reexport = exportSave(result.save, CONFIG);
        assert.equal(reexport.text, text);

        return true;
      }),
      { numRuns: 300 },
    );
  },
);

test(
  propertyName(
    26,
    'Export/import round-trip — importing OVER a different current save replaces it entirely (no merge)',
  ),
  () => {
    assertProperty(
      fc.property(canonicalSaveArb, canonicalSaveArb, (incoming, current) => {
        // The caller holds some arbitrary "current" progress. A valid import
        // replaces it wholesale; none of current's fields survive unless they
        // happen to match incoming.
        const { text } = exportSave(incoming, CONFIG);
        const result = parseImport(text, CONFIG);
        assert.equal(result.ok, true);

        // The replacement is exactly `incoming` (canonical), independent of
        // `current`. parseImport itself must not have touched `current`.
        assert.deepEqual(result.save, incoming);
        assert.notEqual(result.save, current, 'must be a fresh object, not current');

        return true;
      }),
      { numRuns: 300 },
    );
  },
);

// --- Property 27: Invalid imports leave progress unchanged ------------------

// Each builder takes a valid canonical save and corrupts exactly ONE aspect so
// the file hits a specific rejection reason. The returned text is what a
// malicious/mismatched file would contain.
function corruptJson(canonical, mutate) {
  const clone = JSON.parse(JSON.stringify(canonical));
  mutate(clone);
  return JSON.stringify(clone, null, 2);
}

// Arbitrary that yields an invalid import payload plus a label describing which
// rejection reason it targets. Covers every reason named in the task:
// wrong game id, unsupported version, non-numeric values, unknown Hat id,
// unowned equipped Hat — plus not-JSON and not-an-object for completeness.
const invalidImportArb = fc.oneof(
  // 1. Not valid JSON at all.
  fc.string().map((s) => ({ reason: 'bad-json', text: s + '\u0000not json{' })),
  // 2. Valid JSON but not an object (array / scalar).
  fc
    .oneof(fc.integer(), fc.boolean(), fc.array(fc.integer()))
    .map((v) => ({ reason: 'not-object', text: JSON.stringify(v) })),
  // 3. Wrong game id.
  canonicalSaveArb.chain((c) =>
    fc
      .string()
      .filter((g) => g !== GAME_ID)
      .map((g) => ({
        reason: 'wrong-game-id',
        text: corruptJson(c, (o) => {
          o.gameId = g;
        }),
      })),
  ),
  // 4. Unsupported version.
  canonicalSaveArb.chain((c) =>
    fc
      .integer()
      .filter((v) => v !== CONFIG.saveVersion)
      .map((v) => ({
        reason: 'bad-version',
        text: corruptJson(c, (o) => {
          o.version = v;
        }),
      })),
  ),
  // 5. Non-numeric / negative highScore.
  canonicalSaveArb.chain((c) =>
    fc
      .oneof(fc.string(), fc.constant(null), fc.integer({ min: -1000, max: -1 }), fc.double({ min: 0.1, max: 0.9, noNaN: true }))
      .map((v) => ({
        reason: 'bad-highScore',
        text: corruptJson(c, (o) => {
          o.highScore = v;
        }),
      })),
  ),
  // 6. Non-numeric / negative candy.
  canonicalSaveArb.chain((c) =>
    fc
      .oneof(fc.string(), fc.constant(null), fc.integer({ min: -1000, max: -1 }), fc.double({ min: 1.1, max: 9.9, noNaN: true }).filter((x) => !Number.isInteger(x)))
      .map((v) => ({
        reason: 'bad-candy',
        text: corruptJson(c, (o) => {
          o.candy = v;
        }),
      })),
  ),
  // 7. Unknown Hat id in ownedHats.
  canonicalSaveArb.map((c) => ({
    reason: 'unknown-owned-hat',
    text: corruptJson(c, (o) => {
      o.ownedHats = [...new Set([NONE_HAT, ...o.ownedHats, UNKNOWN_HAT])];
    }),
  })),
  // 8. Unknown equipped Hat.
  canonicalSaveArb.map((c) => ({
    reason: 'unknown-equipped-hat',
    text: corruptJson(c, (o) => {
      o.equippedHat = UNKNOWN_HAT;
    }),
  })),
  // 9. Known equipped Hat that is NOT owned. Requires at least one non-'none'
  //    hat to exist in config; guard with a filter.
  ...(NON_NONE_HATS.length > 0
    ? [
        canonicalSaveArb.chain((c) =>
          fc.constantFrom(...NON_NONE_HATS).map((hat) => ({
            reason: 'unowned-equipped-hat',
            text: corruptJson(c, (o) => {
              // Ensure the equipped hat is known but absent from ownedHats.
              o.ownedHats = o.ownedHats.filter((h) => h !== hat);
              if (!o.ownedHats.includes(NONE_HAT)) o.ownedHats.unshift(NONE_HAT);
              o.equippedHat = hat;
            }),
          })),
        ),
      ]
    : []),
);

test(
  propertyName(
    27,
    'Invalid imports leave progress unchanged — wrong game id, unsupported version, non-numeric values, unknown/unowned Hat are rejected with no save and no mutation',
  ),
  () => {
    assertProperty(
      fc.property(invalidImportArb, canonicalSaveArb, ({ text }, current) => {
        // Snapshot the caller's current progress before attempting the import.
        const before = JSON.parse(JSON.stringify(current));

        const result = parseImport(text, CONFIG);

        // Rejected: ok is false, carries an error message, and no save.
        assert.equal(result.ok, false, 'invalid import must be rejected');
        assert.equal(result.save, undefined, 'rejected import carries no save');
        assert.equal(typeof result.error, 'string');
        assert.ok(result.error.length > 0, 'rejection must explain why');

        // Progress untouched: parseImport does not mutate anything the caller
        // holds. The current save is byte-for-byte what it was.
        assert.deepEqual(current, before, 'current progress must be unchanged');

        return true;
      }),
      { numRuns: 400 },
    );
  },
);

// --- Anchoring unit tests ---------------------------------------------------

test('a fresh default save round-trips through export/import unchanged (Req 11.7, 11.11)', () => {
  const save = defaultSave(CONFIG);
  const { text, filename, mime } = exportSave(save, CONFIG);
  assert.equal(filename, 'flappy-kiro-save.json');
  assert.equal(mime, 'application/json');

  const result = parseImport(text, CONFIG);
  assert.equal(result.ok, true);
  assert.deepEqual(result.save, save);
});

test('each named rejection reason is reported as ok:false with no save (Req 11.8, 11.9)', () => {
  const base = sanitizeSave(
    {
      highScore: 42,
      candy: 7,
      ownedHats: [NONE_HAT, 'witchHat'],
      equippedHat: 'witchHat',
      prefs: { muted: true, reducedMotion: false },
    },
    CONFIG,
  );

  const cases = [
    corruptJson(base, (o) => (o.gameId = 'some-other-game')),
    corruptJson(base, (o) => (o.version = CONFIG.saveVersion + 99)),
    corruptJson(base, (o) => (o.highScore = 'lots')),
    corruptJson(base, (o) => (o.candy = -3)),
    corruptJson(base, (o) => (o.ownedHats = [NONE_HAT, UNKNOWN_HAT])),
    corruptJson(base, (o) => (o.equippedHat = UNKNOWN_HAT)),
    // Known but unowned equipped hat.
    corruptJson(base, (o) => {
      o.ownedHats = [NONE_HAT];
      o.equippedHat = 'pumpkinCap';
    }),
    '{ not valid json',
    JSON.stringify([1, 2, 3]),
  ];

  for (const text of cases) {
    const result = parseImport(text, CONFIG);
    assert.equal(result.ok, false, `expected rejection for: ${text.slice(0, 40)}`);
    assert.equal(result.save, undefined);
    assert.equal(typeof result.error, 'string');
  }
});
