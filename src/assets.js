// assets.js — one shared, cached image loader with ready/error states.
//
// Thin IO module (like audio.js): the ONLY place that constructs Image objects
// for sprites. It loads each file at most once, caches the element, and tracks
// a per-file status so the renderer can ask "is this ready?" and fall back to a
// labeled placeholder when it is not — a missing optional asset never stops the
// game (prompt §7, tech.md graceful degradation).
//
// Headless-safe: importing this module never requires a browser. If `Image` is
// unavailable (Node/tests) every load no-ops and `imageReady` returns false, so
// callers always take the placeholder path.

/** Asset directory, relative to index.html. */
const BASE = "assets/";

/**
 * @typedef {{ img: HTMLImageElement|null, ready: boolean, failed: boolean }} Entry
 */

/** @type {Map<string, Entry>} cache keyed by file name (e.g. 'ghosty_base.png'). */
const cache = new Map();

/** True when the browser image API is available. */
function imageApiAvailable() {
  return typeof Image === "function";
}

/**
 * Begin loading an image by file name (idempotent). Returns the cache entry.
 * A failed/blocked load is latched as `failed` so it is never retried and never
 * throws. In a non-browser context this returns a permanently-not-ready entry.
 * @param {string} file e.g. 'enemy_storm_bat.png'
 * @returns {Entry}
 */
export function loadImage(file) {
  if (typeof file !== "string" || !file) {
    return { img: null, ready: false, failed: true };
  }
  const existing = cache.get(file);
  if (existing) return existing;

  const entry = { img: null, ready: false, failed: false };
  cache.set(file, entry);

  if (!imageApiAvailable()) {
    entry.failed = true;
    return entry;
  }

  try {
    const img = new Image();
    img.addEventListener("load", () => {
      entry.ready = true;
    });
    img.addEventListener("error", () => {
      entry.failed = true;
    });
    img.src = BASE + file;
    entry.img = img;
  } catch {
    entry.failed = true;
  }
  return entry;
}

/**
 * Preload a batch of files (best-effort). Safe to call repeatedly; already-
 * cached files are not reloaded. A no-op without the image API.
 * @param {string[]} files
 * @returns {void}
 */
export function preloadImages(files) {
  if (!Array.isArray(files)) return;
  for (const f of files) loadImage(f);
}

/**
 * Whether an image is loaded and safe to draw. False while pending, on failure,
 * or in a non-browser context — so the caller takes the placeholder path.
 * @param {string} file
 * @returns {boolean}
 */
export function imageReady(file) {
  const entry = cache.get(file) || loadImage(file);
  return Boolean(entry.ready && entry.img && !entry.failed);
}

/**
 * The ready HTMLImageElement for a file, or null when not drawable yet.
 * @param {string} file
 * @returns {HTMLImageElement|null}
 */
export function getImage(file) {
  const entry = cache.get(file) || loadImage(file);
  return entry.ready && !entry.failed ? entry.img : null;
}

/**
 * Walk a fallback chain and return the first ready file, or null if none is
 * ready yet. Used with the appearance resolver's per-layer `fallbacks`.
 * @param {string[]} files ordered most- to least-preferred
 * @returns {string|null}
 */
export function firstReady(files) {
  if (!Array.isArray(files)) return null;
  for (const f of files) {
    if (imageReady(f)) return f;
  }
  return null;
}

/** Clear the cache (tests). */
export function _resetAssets() {
  cache.clear();
}

export default { loadImage, preloadImages, imageReady, getImage, firstReady, _resetAssets };
