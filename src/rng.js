// rng.js — a small seeded deterministic RNG for the spawner and tests.
//
// Uses the mulberry32 algorithm: a fast 32-bit generator with a single 32-bit
// state word. Determinism matters twice over:
//   1. The spawner draws all randomness from here so a given seed replays an
//      identical Run (supports frame-rate-independence testing).
//   2. The internal state can be snapshotted and restored exactly, which the
//      ordinary-pause path needs to preserve the RNG state across a pause
//      (Property 30 / Requirement 9.11).

/** The RNG's internal state is a single unsigned 32-bit integer. */

/**
 * Advance a mulberry32 state word and produce the next float in [0, 1).
 * Pure with respect to its argument: returns both the value and the next state.
 * @param {number} state unsigned 32-bit integer state
 * @returns {{ value: number, state: number }}
 */
function mulberry32Next(state) {
  // Keep state within unsigned 32-bit range.
  let a = (state + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: a >>> 0 };
}

/**
 * Normalize an arbitrary seed into an unsigned 32-bit integer state.
 * @param {number} seed
 * @returns {number}
 */
function normalizeSeed(seed) {
  // Coerce to a 32-bit unsigned integer; default to 0 for non-finite input.
  if (!Number.isFinite(seed)) return 0;
  return (seed >>> 0) || (Math.floor(seed) >>> 0) || 0;
}

/**
 * An RNG instance. Mutates its own internal state as numbers are drawn.
 */
export class Rng {
  /**
   * @param {number} seed any number; coerced to a 32-bit unsigned state
   */
  constructor(seed = 0) {
    /** @type {number} unsigned 32-bit internal state */
    this._state = normalizeSeed(seed);
  }

  /**
   * Produce the next float in [0, 1) and advance the internal state.
   * @returns {number}
   */
  next() {
    const { value, state } = mulberry32Next(this._state);
    this._state = state;
    return value;
  }

  /**
   * Produce the next float in [min, max).
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  nextInRange(min, max) {
    return min + this.next() * (max - min);
  }

  /**
   * Produce the next integer in [min, max] inclusive.
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  nextInt(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /**
   * Snapshot the internal state for exact later restoration (e.g. pause).
   * The snapshot is a plain number and safe to store/clone.
   * @returns {number}
   */
  snapshot() {
    return this._state;
  }

  /**
   * Restore a previously snapshotted internal state exactly.
   * @param {number} state value returned by {@link snapshot}
   * @returns {void}
   */
  restore(state) {
    this._state = normalizeSeed(state);
  }

  /**
   * Create an independent copy of this RNG at its current state.
   * @returns {Rng}
   */
  clone() {
    const copy = new Rng(0);
    copy._state = this._state;
    return copy;
  }
}

/**
 * Create an RNG from a seed.
 * @param {number} seed
 * @returns {Rng}
 */
export function createRng(seed = 0) {
  return new Rng(seed);
}

export default createRng;
