// save.js — browser-local persistence for the handful of values that outlive a
// Run: high score, Candy, owned/equipped Hats, and the audio/motion prefs.
//
// This module is the IO shell for persistence, but it is written to be
// *testable without a browser*. Every localStorage access is guarded so the
// no-browser test runner (where `localStorage` is undefined) exercises the
// same validation and default-fallback paths the browser does. The pure,
// reusable piece is the validator (`sanitizeSave`), which task 5.5
// (export/import) and task 5.4 (load-tolerance property) build on.
//
// Core guarantees (Req 11.1–11.5):
//   - `loadSave` NEVER throws. Missing, unparseable, or schema-invalid stored
//     data falls back to safe defaults (Req 11.2, 11.3).
//   - `writeSave` persists promptly and NEVER throws. Storage exceptions
//     (quota exceeded, disabled/absent storage) are caught and reported as
//     `{ ok: false, error }` so the caller can surface a non-blocking message
//     and keep playing (Req 11.4, 11.5).
//
// The persisted schema (design "SaveData" / "Save schema") carries no run
// state, so an unfinished Run is never persisted or restored (Req 11.12).
// Tuning (the save-format version, the game id) flows in from config.js — no
// version constant is hardcoded here.

import { CONFIG } from "./config.js";

/** The fixed game identifier stamped into every save (design Save schema). */
export const GAME_ID = "flappy-kiro";

/** The localStorage key under which the single save slot lives. */
export const SAVE_KEY = "flappy-kiro:save";

/** The implicit Hat that is always owned and is the safe equipped default. */
export const NONE_HAT = "none";

/**
 * The set of Hat ids that are valid to own/equip for a given config. Derived
 * from `config.hats` (the only place Hats are defined) plus the implicit
 * {@link NONE_HAT}, so adding a Hat in config.js extends validation for free.
 *
 * @param {object} [config] the frozen CONFIG
 * @returns {string[]} known Hat ids, always including 'none'
 */
export function knownHatIds(config = CONFIG) {
  const hats = config && config.hats ? Object.keys(config.hats) : [];
  return [NONE_HAT, ...hats];
}

/**
 * Build a fresh, schema-valid default SaveData (design "Save schema"). Used as
 * the fallback whenever stored data is missing or fails validation, and as the
 * base that {@link sanitizeSave} fills in from partially-valid input.
 *
 * @param {object} [config] the frozen CONFIG (supplies the save version)
 * @returns {{gameId: string, version: number, highScore: number, candy: number, ownedHats: string[], equippedHat: string, prefs: {muted: boolean, reducedMotion: boolean}}}
 */
export function defaultSave(config = CONFIG) {
  return {
    gameId: GAME_ID,
    version: config.saveVersion,
    highScore: 0,
    candy: 0,
    ownedHats: [NONE_HAT],
    equippedHat: NONE_HAT,
    prefs: { muted: false, reducedMotion: false },
  };
}

/**
 * Coerce an arbitrary value into a safe non-negative integer, falling back to
 * `fallback` for anything non-finite or negative. High score and Candy are
 * both non-negative counters, so this keeps a corrupt stored value from
 * poisoning the loaded save.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function safeNonNegativeInt(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  // Normalize the result so it is a canonical non-negative integer. Adding 0
  // collapses negative zero (-0) to +0; without this, a stored -0 survives
  // sanitize but serializes to "0" on export, so an export/import round-trip
  // would not be a fixed point (Req 11.7, 11.11).
  return Math.floor(value) + 0;
}

/**
 * STRICT predicate: is `value` a finite, non-negative integer exactly as
 * stored? Used by the import validator, which rejects (rather than coerces)
 * anything that is not already a clean non-negative integer — the opposite of
 * {@link safeNonNegativeInt}'s tolerant repair.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isNonNegativeInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Validate and repair an arbitrary parsed object into a schema-valid SaveData.
 * This is the reusable validation core shared by load (this file) and import
 * (task 5.5). It is total: ANY input — including `null`, wrong types, or a
 * mismatched game id/version — yields a schema-valid SaveData and never throws.
 *
 * Repair rules (field by field, each independently defended):
 *   - gameId / version: always stamped from the current config so the returned
 *     object is canonical for this build. (Import performs the stricter
 *     accept/reject on id and version; load is tolerant and normalizes.)
 *   - highScore / candy: coerced to safe non-negative integers (Req 11.2).
 *   - ownedHats: kept only if an array; filtered to KNOWN hat ids; 'none' is
 *     always present; duplicates removed.
 *   - equippedHat: kept only if it is a known id AND actually owned, else
 *     falls back to 'none' (schema invariant: equipped must be owned).
 *   - prefs.muted / prefs.reducedMotion: coerced to booleans, default false.
 *
 * @param {*} raw any parsed value
 * @param {object} [config] the frozen CONFIG
 * @returns {{gameId: string, version: number, highScore: number, candy: number, ownedHats: string[], equippedHat: string, prefs: {muted: boolean, reducedMotion: boolean}}}
 */
export function sanitizeSave(raw, config = CONFIG) {
  const base = defaultSave(config);

  if (raw === null || typeof raw !== "object") {
    return base;
  }

  const known = new Set(knownHatIds(config));

  // High score and Candy: non-negative integers or default.
  const highScore = safeNonNegativeInt(raw.highScore, base.highScore);
  const candy = safeNonNegativeInt(raw.candy, base.candy);

  // Owned hats: an array of known ids, always including 'none', deduplicated.
  const ownedSet = new Set([NONE_HAT]);
  if (Array.isArray(raw.ownedHats)) {
    for (const id of raw.ownedHats) {
      if (typeof id === "string" && known.has(id)) {
        ownedSet.add(id);
      }
    }
  }
  const ownedHats = [...ownedSet];

  // Equipped hat: must be a known id AND currently owned, else 'none'.
  let equippedHat = NONE_HAT;
  if (
    typeof raw.equippedHat === "string" &&
    known.has(raw.equippedHat) &&
    ownedSet.has(raw.equippedHat)
  ) {
    equippedHat = raw.equippedHat;
  }

  // Prefs: booleans with safe defaults.
  const rawPrefs = raw.prefs && typeof raw.prefs === "object" ? raw.prefs : {};
  const prefs = {
    muted: rawPrefs.muted === true,
    reducedMotion: rawPrefs.reducedMotion === true,
  };

  return {
    gameId: GAME_ID,
    version: config.saveVersion,
    highScore,
    candy,
    ownedHats,
    equippedHat,
    prefs,
  };
}

/**
 * Resolve the Storage object to use, tolerating environments where it is
 * absent (the no-browser test runner) or throws on access (some privacy
 * modes). Returns `null` when storage is unavailable rather than throwing.
 *
 * @returns {Storage|null}
 */
function getStorage() {
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      return localStorage;
    }
  } catch {
    // Accessing localStorage can itself throw (e.g. blocked by the browser).
  }
  return null;
}

/**
 * Load the SaveData from browser-local storage (Req 11.2, 11.3). Reads the save
 * slot, parses it, and validates/repairs it against the schema. ANY failure —
 * storage unavailable, missing slot, unparseable JSON, or schema-invalid data —
 * returns a safe default SaveData. This function NEVER throws.
 *
 * @param {object} [config] the frozen CONFIG
 * @returns {{gameId: string, version: number, highScore: number, candy: number, ownedHats: string[], equippedHat: string, prefs: {muted: boolean, reducedMotion: boolean}}}
 */
export function loadSave(config = CONFIG) {
  const storage = getStorage();
  if (!storage) {
    return defaultSave(config);
  }

  let rawText = null;
  try {
    rawText = storage.getItem(SAVE_KEY);
  } catch {
    return defaultSave(config);
  }

  if (rawText == null) {
    return defaultSave(config);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return defaultSave(config);
  }

  // sanitizeSave is total and never throws, but guard defensively anyway so
  // loadSave's never-throw guarantee holds no matter what.
  try {
    return sanitizeSave(parsed, config);
  } catch {
    return defaultSave(config);
  }
}

/**
 * Persist the given SaveData to browser-local storage promptly (Req 11.4).
 * Catches every storage exception (quota exceeded, storage disabled/absent,
 * serialization failure) and reports it as `{ ok: false, error }` so the
 * caller can surface a non-blocking save-failure message and keep the Game
 * playable (Req 11.5). NEVER throws. Returns `{ ok: true }` on success.
 *
 * @param {object} save the SaveData to persist
 * @returns {{ ok: boolean, error?: Error }}
 */
export function writeSave(save) {
  const storage = getStorage();
  if (!storage) {
    return { ok: false, error: new Error("localStorage is unavailable") };
  }

  try {
    storage.setItem(SAVE_KEY, JSON.stringify(save));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

// ---------------------------------------------------------------------------
// Portable save: export / import (Req 11.6–11.11)
//
// Export and import are the "move progress between computers" path. They share
// the SAME schema as load/write, but import validation is deliberately STRICT
// where load is tolerant: load normalizes anything into a valid save, while
// import REJECTS a file that is not already a faithful save for this build
// (wrong game id, unsupported version, non-numeric counters, unknown Hat ids,
// or an equipped Hat that is not owned). A rejected import changes nothing
// (Req 11.9); an accepted import yields the full SaveData to REPLACE — never
// merge — the current progress (Req 11.11). The preview→confirm→replace→
// save-immediately flow and the "only outside an active Run" gating are UI
// wiring (task 5.9); this module provides the pure validate/serialize core.
// ---------------------------------------------------------------------------

/**
 * The suggested download filename for an exported save. A plain constant (no
 * timestamp) keeps export deterministic and testable; the UI may decorate it.
 */
export const EXPORT_FILENAME = "flappy-kiro-save.json";

/** JSON MIME type for the exported Blob when a DOM is present. */
const EXPORT_MIME = "application/json";

/**
 * Serialize a SaveData into a portable, clearly-named JSON payload (Req 11.7).
 *
 * The input is first run through {@link sanitizeSave}, which guarantees the
 * output is a canonical, schema-valid save for the current build and carries
 * ONLY persistent progress + prefs — never any unfinished-Run state, since the
 * schema has no room for it (Req 11.12). The game id and save-format version
 * are stamped from config so an importer can validate them.
 *
 * Runs headlessly: the returned `text` and `filename` never depend on the DOM.
 * A `Blob` is attached only when `Blob` exists in the environment (the browser);
 * in the no-browser test runner `blob` is `null` and callers use `text`.
 *
 * @param {object} save the SaveData (or partial) to export
 * @param {object} [config] the frozen CONFIG (supplies id + version)
 * @returns {{ text: string, filename: string, mime: string, blob: Blob|null }}
 */
export function exportSave(save, config = CONFIG) {
  const canonical = sanitizeSave(save, config);
  const text = JSON.stringify(canonical, null, 2);

  let blob = null;
  if (typeof Blob !== "undefined") {
    try {
      blob = new Blob([text], { type: EXPORT_MIME });
    } catch {
      // Some environments expose Blob but reject these args; degrade to text.
      blob = null;
    }
  }

  return { text, filename: EXPORT_FILENAME, mime: EXPORT_MIME, blob };
}

/**
 * Strictly validate a portable save file BEFORE any change (Req 11.8, 11.9).
 *
 * Unlike {@link sanitizeSave} (tolerant: normalizes any input), this is an
 * accept/reject gate. The WHOLE file is checked up front and the first failing
 * check short-circuits with a useful message; current progress is left
 * untouched because the caller only replaces on `ok: true`. On success the
 * returned `save` is the fully-validated SaveData to REPLACE (not merge) the
 * current save (Req 11.11).
 *
 * Rejection reasons (each distinct so the UI can show a useful message):
 *   - unparseable JSON
 *   - not a JSON object
 *   - wrong `gameId`
 *   - unsupported `version` (must equal config.saveVersion)
 *   - non-integer / negative `highScore` or `candy`
 *   - `ownedHats` not an array, or containing an unknown/non-string Hat id
 *     ('none' is always known)
 *   - `equippedHat` unknown, or known but NOT present in `ownedHats`
 *   - `prefs` missing or with non-boolean `muted` / `reducedMotion`
 *
 * @param {string} text the raw file contents
 * @param {object} [config] the frozen CONFIG (supplies id + version)
 * @returns {{ ok: true, save: object } | { ok: false, error: string }}
 */
export function parseImport(text, config = CONFIG) {
  if (typeof text !== "string") {
    return { ok: false, error: "Import must be text." };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "File is not valid JSON." };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Save file must be a JSON object." };
  }

  if (parsed.gameId !== GAME_ID) {
    return { ok: false, error: `Not a ${GAME_ID} save file.` };
  }

  if (parsed.version !== config.saveVersion) {
    return {
      ok: false,
      error: `Unsupported save version: expected ${config.saveVersion}, got ${String(parsed.version)}.`,
    };
  }

  if (!isNonNegativeInt(parsed.highScore)) {
    return { ok: false, error: "High score must be a non-negative integer." };
  }
  if (!isNonNegativeInt(parsed.candy)) {
    return { ok: false, error: "Candy must be a non-negative integer." };
  }

  const known = new Set(knownHatIds(config));

  if (!Array.isArray(parsed.ownedHats)) {
    return { ok: false, error: "Owned hats must be a list." };
  }
  for (const id of parsed.ownedHats) {
    if (typeof id !== "string" || !known.has(id)) {
      return { ok: false, error: `Unknown hat id: ${String(id)}.` };
    }
  }
  const ownedSet = new Set(parsed.ownedHats);

  if (
    typeof parsed.equippedHat !== "string" ||
    !known.has(parsed.equippedHat)
  ) {
    return {
      ok: false,
      error: `Unknown equipped hat: ${String(parsed.equippedHat)}.`,
    };
  }
  if (parsed.equippedHat !== NONE_HAT && !ownedSet.has(parsed.equippedHat)) {
    return {
      ok: false,
      error: `Equipped hat "${parsed.equippedHat}" is not owned.`,
    };
  }

  if (parsed.prefs === null || typeof parsed.prefs !== "object") {
    return { ok: false, error: "Preferences are missing." };
  }
  if (
    typeof parsed.prefs.muted !== "boolean" ||
    typeof parsed.prefs.reducedMotion !== "boolean"
  ) {
    return { ok: false, error: "Preferences must be true/false values." };
  }

  // Every check passed. Build the canonical SaveData to replace current
  // progress. 'none' is guaranteed present in ownedHats (schema invariant);
  // add it defensively without mutating the parsed array, then dedupe.
  const ownedHats = [...new Set([NONE_HAT, ...parsed.ownedHats])];

  const save = {
    gameId: GAME_ID,
    version: config.saveVersion,
    highScore: parsed.highScore,
    candy: parsed.candy,
    ownedHats,
    equippedHat: parsed.equippedHat,
    prefs: {
      muted: parsed.prefs.muted,
      reducedMotion: parsed.prefs.reducedMotion,
    },
  };

  return { ok: true, save };
}

export default {
  loadSave,
  writeSave,
  sanitizeSave,
  defaultSave,
  knownHatIds,
  exportSave,
  parseImport,
  GAME_ID,
  SAVE_KEY,
  NONE_HAT,
  EXPORT_FILENAME,
};
