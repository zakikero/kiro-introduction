// ui/feedback.js — the transient player-feedback event buffer (pure core).
//
// Req 12.2 asks for CLEAR feedback on the key moments of a Run: flapping,
// scoring, a Shield breaking, Battle actions and damage, rewards and purchases,
// Possession, a fatal collision, and the Final_Boss victory. The game already
// plays sound on several of these (audio.js) and shows battle feedback in the
// battle log (ui/battle.js); this module adds the VISUAL, on-HUD half so the
// feedback is legible even when audio is muted/blocked (graceful degradation,
// tech.md) and so every listed moment has a visible cue.
//
// Design, to match the repo's "pure core, thin shell" rule (tech.md):
//
//   • This module is PURE and DOM-free. It owns a small ordered buffer of
//     feedback events, each with a kind, a human-readable message, an icon
//     glyph (so information is conveyed by TEXT + ICON, not color alone,
//     Req 12.7), a severity, and a lifetime. `pushFeedback`/`activeFeedback`/
//     `createFeedbackBuffer` are all pure functions over plain data, so they
//     are unit-testable with no browser.
//
//   • ui/hud.js (the thin view) reads `activeFeedback(...)` once per frame and
//     paints the live events. It mutates nothing here.
//
//   • The shell (main.js) calls `pushFeedback(...)` at the existing event sites
//     (the same places that already call playSfx), so no gameplay logic moves
//     into the view layer.
//
// Timekeeping is caller-supplied (a monotonic timestamp in seconds) so the
// buffer never reads a clock itself — keeping it pure and deterministic for
// tests. The HUD passes the wall-clock render time; it does NOT use any of the
// three simulation clocks, so feedback aging is purely a display concern and
// never affects physics, collisions, or the three-clock rule.

/**
 * The kinds of feedback the HUD can surface (Req 12.2). Stable string ids so
 * the shell and tests refer to them without matching on message text.
 * @readonly
 * @enum {string}
 */
export const FeedbackKind = Object.freeze({
  FLAP: "flap",
  SCORE: "score",
  SHIELD_BREAK: "shield_break",
  BATTLE_ACTION: "battle_action",
  REWARD: "reward",
  PURCHASE: "purchase",
  POSSESSION: "possession",
  FATAL: "fatal",
  BOSS_VICTORY: "boss_victory",
});

/**
 * Per-kind presentation defaults: an icon glyph (text/icon in addition to
 * color, Req 12.7), a severity band the HUD maps to a color, and a default
 * lifetime in seconds. Kept here so every feedback cue reads consistently and
 * no caller has to remember a glyph. Glyphs are plain Unicode so they render
 * with the HUD's system font and need no art asset.
 * @readonly
 */
const KIND_DEFAULTS = Object.freeze({
  [FeedbackKind.FLAP]: { icon: "↑", severity: "info", ttl: 0.35 },
  [FeedbackKind.SCORE]: { icon: "★", severity: "good", ttl: 1.2 },
  [FeedbackKind.SHIELD_BREAK]: { icon: "⛊", severity: "warn", ttl: 1.6 },
  [FeedbackKind.BATTLE_ACTION]: { icon: "⚔", severity: "info", ttl: 1.6 },
  [FeedbackKind.REWARD]: { icon: "◉", severity: "good", ttl: 1.8 },
  [FeedbackKind.PURCHASE]: { icon: "🛒", severity: "good", ttl: 1.8 },
  [FeedbackKind.POSSESSION]: { icon: "✦", severity: "good", ttl: 2.0 },
  [FeedbackKind.FATAL]: { icon: "✖", severity: "bad", ttl: 2.5 },
  [FeedbackKind.BOSS_VICTORY]: { icon: "♛", severity: "good", ttl: 3.0 },
});

/** The most events the buffer retains, oldest trimmed first, so it never grows unbounded. */
const MAX_EVENTS = 8;

/**
 * Create an empty feedback buffer. A buffer is just a plain object holding an
 * ordered list of events and a monotonic sequence counter (a stable tiebreaker
 * for events pushed at the same timestamp). Kept as plain data so the whole
 * thing clones/serializes trivially and stays testable.
 * @returns {{ events: Array<object>, seq: number }}
 */
export function createFeedbackBuffer() {
  return { events: [], seq: 0 };
}

/**
 * Push a feedback event onto the buffer (Req 12.2). PURE in spirit: it mutates
 * the passed buffer in place (like economy.js's `purchase` mutates RunState)
 * and also returns it, so the shell can chain and tests can assert on the
 * result. A missing/unknown kind degrades to a neutral info cue rather than
 * throwing, so a feedback call can never interrupt a Run.
 *
 * @param {{ events: Array<object>, seq: number }} buffer the buffer to append to
 * @param {string} kind a {@link FeedbackKind} value
 * @param {string} message the human-readable cue text
 * @param {number} now the current monotonic time in seconds (caller-supplied)
 * @param {object} [opts]
 * @param {string} [opts.icon] override the default glyph
 * @param {number} [opts.ttl] override the default lifetime in seconds
 * @param {string} [opts.severity] override the default severity band
 * @returns {{ events: Array<object>, seq: number }} the same buffer
 */
export function pushFeedback(buffer, kind, message, now, opts = {}) {
  if (!buffer || !Array.isArray(buffer.events)) return buffer;

  const defaults = KIND_DEFAULTS[kind] || {
    icon: "•",
    severity: "info",
    ttl: 1.2,
  };
  const start = Number.isFinite(now) ? now : 0;
  const ttl =
    Number.isFinite(opts.ttl) && opts.ttl > 0 ? opts.ttl : defaults.ttl;

  buffer.events.push({
    kind: typeof kind === "string" ? kind : FeedbackKind.FLAP,
    message: typeof message === "string" ? message : "",
    icon: typeof opts.icon === "string" ? opts.icon : defaults.icon,
    severity:
      typeof opts.severity === "string" ? opts.severity : defaults.severity,
    start,
    expires: start + ttl,
    seq: buffer.seq,
  });
  buffer.seq += 1;

  // Trim the oldest so the buffer stays bounded.
  if (buffer.events.length > MAX_EVENTS) {
    buffer.events.splice(0, buffer.events.length - MAX_EVENTS);
  }

  return buffer;
}

/**
 * The currently-live feedback events at time `now`, newest first, with a 0..1
 * `fade` the HUD uses for opacity (1 at birth → 0 at expiry). PURE: it returns
 * a fresh array of plain descriptors and, as a convenience, prunes expired
 * events from the buffer in place so it does not grow across a long Run. The
 * HUD reads these; `fade` lets it dim an aging cue without any animation state.
 *
 * Under reduced motion the caller should treat `fade` as a static 1 (the HUD
 * does this), so an expiring cue simply vanishes rather than visibly fading —
 * no motion-heavy pulsing (Req 12.8). The information itself is unchanged.
 *
 * @param {{ events: Array<object>, seq: number }} buffer
 * @param {number} now the current monotonic time in seconds
 * @param {number} [limit] the maximum number of live events to return (default 4)
 * @returns {Array<{ kind: string, message: string, icon: string, severity: string, fade: number }>}
 */
export function activeFeedback(buffer, now, limit = 4) {
  if (!buffer || !Array.isArray(buffer.events)) return [];
  const t = Number.isFinite(now) ? now : 0;

  // Prune expired events so the buffer stays bounded over a long Run.
  buffer.events = buffer.events.filter((e) => e.expires > t);

  // Newest first by start time, with the sequence as a stable tiebreaker.
  const live = buffer.events
    .slice()
    .sort((a, b) => b.start - a.start || b.seq - a.seq)
    .slice(0, Math.max(0, limit));

  return live.map((e) => {
    const span = e.expires - e.start;
    const remaining = e.expires - t;
    const fade = span > 0 ? Math.max(0, Math.min(1, remaining / span)) : 1;
    return {
      kind: e.kind,
      message: e.message,
      icon: e.icon,
      severity: e.severity,
      fade,
    };
  });
}

export default {
  FeedbackKind,
  createFeedbackBuffer,
  pushFeedback,
  activeFeedback,
};
