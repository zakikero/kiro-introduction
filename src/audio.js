// audio.js â€” guarded sound effects with graceful degradation.
//
// This is one of the thin IO modules: it is the only place that touches the
// Web Audio / HTMLAudioElement APIs. Gameplay logic never imports it for state;
// the FSM/render layer calls `playSfx(name)` for feedback.
//
// Hard guarantees (Req 1.4, 1.11, 12.4, 12.5):
//   - Browsers block audio until a user gesture. `playSfx` is a silent no-op
//     until audio has been unlocked on the first keydown/pointerdown, then
//     works afterward.
//   - If an asset fails to load, playback is blocked, or the browser lacks the
//     audio APIs entirely, every call no-ops and NEVER throws. A missing or
//     blocked sound must never interrupt a Run.
//   - The saved `muted` preference is respected; when muted, playback is skipped
//     (unlock still happens so unmuting mid-run works).
//
// Importing this module in a non-browser context (e.g. node) must not throw:
// all browser-API access is feature-detected with `typeof` guards.

/**
 * Logical sound names mapped to their asset paths (relative to index.html).
 * Keeping the map here keeps asset paths clear and in one place; callers use
 * the stable logical name, not the file path.
 * @type {Record<string, string>}
 */
const SOUND_PATHS = {
  jump: 'assets/jump.wav',
  game_over: 'assets/game_over.wav',
  score: 'assets/score.wav',
  shield_break: 'assets/shield_break.wav',
  battle_hit: 'assets/battle_hit.wav',
  battle_hurt: 'assets/battle_hurt.wav',
  heal: 'assets/heal.wav',
  hover: 'assets/hover.wav',
  purchase: 'assets/purchase.wav',
  possession: 'assets/possession.wav',
  victory: 'assets/victory.wav',
};

/** Path to the looping background music track (prompt §7). */
const MUSIC_PATH = 'assets/music.mp3';

/** Default music volume (manifest suggests a quiet 0.18). */
const MUSIC_VOLUME = 0.18;

/** Whether a user gesture has unlocked audio playback yet. */
let unlocked = false;

/** Current mute preference. When true, playback is skipped. */
let muted = false;

/** Whether we've attempted to wire up the one-shot unlock listeners. */
let unlockListenersAttached = false;

/**
 * Cache of preloaded HTMLAudioElement instances, keyed by logical name.
 * A `null` entry marks a sound that failed to construct/load so we don't retry
 * forever and never throw on a later call.
 * @type {Record<string, (HTMLAudioElement|null)>}
 */
const elements = {};

/** True when the required browser audio APIs are available. */
function audioAvailable() {
  return typeof window !== 'undefined' && typeof window.Audio === 'function';
}

/**
 * Lazily construct (and begin loading) the Audio element for a logical name.
 * Any failure is swallowed and cached as `null` so callers never throw.
 * @param {string} name
 * @returns {HTMLAudioElement|null}
 */
function getElement(name) {
  if (Object.prototype.hasOwnProperty.call(elements, name)) {
    return elements[name];
  }
  const path = SOUND_PATHS[name];
  if (!path || !audioAvailable()) {
    elements[name] = null;
    return null;
  }
  try {
    const el = new window.Audio(path);
    el.preload = 'auto';
    // A failed load (missing/blocked asset) must degrade silently.
    el.addEventListener('error', () => {
      elements[name] = null;
    });
    elements[name] = el;
    return el;
  } catch {
    elements[name] = null;
    return null;
  }
}

/**
 * Mark audio as unlocked and detach the one-shot gesture listeners. Called from
 * the first user gesture. Priming playback here is best-effort and guarded.
 * @returns {void}
 */
function unlock() {
  if (unlocked) return;
  unlocked = true;
  // Best-effort warm-up of known sounds so the first real play is prompt.
  for (const name of Object.keys(SOUND_PATHS)) {
    getElement(name);
  }
  // If music was requested before the unlock gesture, start it now.
  if (musicWanted) applyMusicState();
}

/**
 * Attach one-shot listeners that unlock audio on the first user gesture.
 * Safe to call repeatedly and in a non-browser context (no-op then).
 * @returns {void}
 */
function attachUnlockListeners() {
  if (unlockListenersAttached) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return;
  }
  unlockListenersAttached = true;
  const onGesture = () => {
    unlock();
    window.removeEventListener('keydown', onGesture);
    window.removeEventListener('pointerdown', onGesture);
  };
  // `once` is belt-and-suspenders with the explicit removeEventListener above.
  window.addEventListener('keydown', onGesture, { once: true });
  window.addEventListener('pointerdown', onGesture, { once: true });
}

/**
 * Play a sound effect by logical name. Fully guarded: a no-op (never throws)
 * when audio is unavailable, not yet unlocked, muted, the name is unknown, or
 * the asset failed to load/play.
 *
 * jump.wav is expected to be played at most once per Flap_Input; the caller is
 * responsible for the one-flap-per-press debounce (input.js). This function
 * rewinds and plays the element so rapid successive flaps each produce a sound.
 *
 * @param {string} name logical sound name (e.g. 'jump', 'game_over')
 * @returns {void}
 */
export function playSfx(name) {
  try {
    if (!unlocked || muted || !audioAvailable()) return;
    const el = getElement(name);
    if (!el) return;
    // Rewind so repeated plays retrigger from the start.
    try {
      el.currentTime = 0;
    } catch {
      // Some elements throw if not yet seekable; ignore and still try play().
    }
    const result = el.play();
    // play() returns a promise in modern browsers; swallow autoplay/blocked
    // rejections so a blocked sound never interrupts the Run.
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch {
    // Absolutely never let audio interrupt a Run.
  }
}

/**
 * Set the mute preference (typically from SaveData.prefs.muted). Guarded against
 * missing/garbage input: anything truthy mutes, anything else unmutes.
 * @param {boolean} value
 * @returns {void}
 */
export function setMuted(value) {
  muted = Boolean(value);
  // Reflect the new mute state onto music immediately (pause when muted, resume
  // when unmuted if music is still wanted). SFX read muted per-call already.
  applyMusicState();
}

// --- Background music (prompt §7) -------------------------------------------
//
// A single persistent looping HTMLAudio instance. It must only ever play after
// a user gesture (autoplay policy), honor mute, survive a restart without
// stacking tracks, and degrade gracefully when the API or file is unavailable.

/**
 * Lazily construct the single looping music element. Guarded: returns null in a
 * non-browser context or if construction fails.
 * @returns {HTMLAudioElement|null}
 */
function getMusicElement() {
  if (musicEl) return musicEl;
  if (!audioAvailable()) return null;
  try {
    const el = new window.Audio(MUSIC_PATH);
    el.loop = true;
    el.preload = 'auto';
    el.volume = MUSIC_VOLUME;
    el.addEventListener('error', () => {
      // A failed music load must never interrupt the game; drop the element so
      // we stop trying to control a broken track.
      musicEl = null;
    });
    musicEl = el;
    return el;
  } catch {
    musicEl = null;
    return null;
  }
}

/**
 * Reconcile the music element with the desired state: play the single looping
 * track iff music is wanted, audio is unlocked, and not muted; otherwise pause
 * it. Idempotent, fully guarded, and never throws (autoplay rejection and any
 * play() error are swallowed), so music can never interrupt a run.
 * @returns {void}
 */
function applyMusicState() {
  try {
    if (!audioAvailable()) return;
    const shouldPlay = musicWanted && unlocked && !muted;
    const el = shouldPlay ? getMusicElement() : musicEl;
    if (!el) return;
    if (shouldPlay) {
      const result = el.play();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } else {
      try { el.pause(); } catch { /* ignore */ }
    }
  } catch {
    // Never let music control interrupt the game.
  }
}

/**
 * Request that the looping background music play. Takes effect once audio is
 * unlocked by a user gesture and while not muted. Safe to call repeatedly; it
 * never stacks tracks because there is exactly one music element (prompt §7).
 * @returns {void}
 */
export function startMusic() {
  musicWanted = true;
  applyMusicState();
}

/**
 * Stop the background music (e.g. leaving to a screen with no music). Keeps the
 * single element so a later startMusic resumes the same track without stacking.
 * @returns {void}
 */
export function stopMusic() {
  musicWanted = false;
  applyMusicState();
}

/** @returns {boolean} whether music is currently wanted. */
export function isMusicWanted() {
  return musicWanted;
}

/**
 * @returns {boolean} the current mute preference.
 */
export function isMuted() {
  return muted;
}

/**
 * Apply a saved prefs object (as stored in SaveData.prefs). Tolerates a missing
 * or malformed prefs object without throwing.
 * @param {{ muted?: boolean }} [prefs]
 * @returns {void}
 */
export function applyPrefs(prefs) {
  if (prefs && typeof prefs === 'object') {
    setMuted(prefs.muted);
  }
}

/**
 * @returns {boolean} whether audio has been unlocked by a user gesture.
 */
export function isUnlocked() {
  return unlocked;
}

/**
 * Initialize the audio module: wire up the first-gesture unlock and optionally
 * apply saved prefs. Safe to call once at boot; a no-op outside the browser.
 * @param {{ muted?: boolean }} [prefs]
 * @returns {void}
 */
export function initAudio(prefs) {
  applyPrefs(prefs);
  attachUnlockListeners();
}

export default { playSfx, setMuted, isMuted, isUnlocked, applyPrefs, initAudio, startMusic, stopMusic, isMusicWanted };



