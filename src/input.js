// input.js — raw keyboard/mouse events → state-scoped, per-tick game intents.
//
// This module is deliberately split in two:
//
//   1. A PURE CORE (`createInputQueue`) that holds the intent queue, the
//      held-key debounce table, the current state scope, and the transition
//      barrier. It touches NO DOM, so it can be imported and exercised
//      headlessly by the no-browser test harness (task 1.16 drives the
//      held-key debounce property against this core). It is where all the
//      debounce, tick-assignment, and single-consumption logic lives.
//
//   2. A THIN DOM SHELL (`attachInput`) that wires `keydown`/`keyup`/
//      `mousedown` listeners on a target (window + canvas) and forwards them
//      into the pure core. All browser access is confined here and guarded so
//      that merely importing this module never requires a `window`/`document`.
//
// Determinism (Req 1.1, Property 1): every raw event is timestamped and turned
// into an intent the moment it arrives, but intents are *consumed* per fixed
// simulation tick. `loop.js` calls `consumeInputIntents()` exactly once per
// fixed step; that call hands the simulation every intent accumulated since the
// previous step and clears the queue, so each input is consumed by exactly one
// tick. Two sessions that feed identical events and run identical ticks
// therefore see identical intents on identical ticks.
//
// No input leak across transitions (Req 9.6, 10.7): the FSM calls
// `transition()` on the queue at every state change. That drops any intent not
// yet consumed (the barrier/flush), so the input that dismissed a pause,
// confirmed a result, bought an item, chose Possession, or caused death cannot
// also act — or restart a Run — in the destination state. Intents also carry
// the state scope they were created in; `consumeInputIntents()` only returns
// intents created in the current scope, a second guard against leakage.

/**
 * Game intent kinds. Flight intents drive the simulation; UI intents drive
 * menus/buttons/confirmations and MUST NEVER be treated as a Flap_Input
 * (Req 1.6).
 * @enum {string}
 */
export const IntentType = Object.freeze({
  // Flight intents (consumed by the flight simulation in Active_Flight_State).
  FLAP: "FLAP", // Normal_Flap — one per discrete press (Req 1.3, 1.5)
  FLIGHT_POWER: "FLIGHT_POWER", // Hover / Flight_Power activation (Req 1.7)

  // UI intents (consumed by menus/HUD; never a flap — Req 1.6).
  UI_CONFIRM: "UI_CONFIRM", // confirm/dismiss (result, pause dismiss)
  UI_PAUSE: "UI_PAUSE", // request pause
  UI_RESUME: "UI_RESUME", // deliberate resume from pause/countdown
  UI_END_RUN: "UI_END_RUN", // End Run from pause: finalize + go to Results (Req 9.8)
  UI_MENU: "UI_MENU", // generic menu navigation action
  UI_BUTTON: "UI_BUTTON", // generic on-screen button activation
  UI_SELECT: "UI_SELECT", // pick option N (carries a 0-based `index`): battle
  //                          action / possession choice / shop row selection
});

/**
 * The set of equipped-Spirit ids that provide a Flight_Power (Req 6.7, 6.12).
 * Storm_Bat's Flight benefit is Hover; Pumpkin_Guardian's Flight benefit is the
 * one-time Shield gift (not an on-demand power), and base Ghosty has none. The
 * Flight_Power key and on-screen button therefore only fire while a
 * power-providing Spirit is equipped (Req 1.7); otherwise the request is
 * ignored and Ghosty's velocity and cooldown are left unchanged (Req 1.8).
 * @type {ReadonlySet<string>}
 */
const POWER_SPIRITS = new Set(["storm_bat"]);

/**
 * Whether the equipped Spirit provides an on-demand Flight_Power (Req 1.7,
 * 6.7). Pure — the shell/input layer calls this to decide whether a
 * Flight_Power activation request should be routed to the flight sim at all. A
 * missing/absent value or `'none'` returns false so base Ghosty never fires a
 * power.
 * @param {string|null|undefined} equippedSpirit the RunState `equippedSpirit`
 * @returns {boolean}
 */
export function spiritProvidesFlightPower(equippedSpirit) {
  return (
    typeof equippedSpirit === "string" && POWER_SPIRITS.has(equippedSpirit)
  );
}

/** The set of intent kinds that are UI (non-flight) intents. */
const UI_INTENTS = new Set([
  IntentType.UI_CONFIRM,
  IntentType.UI_PAUSE,
  IntentType.UI_RESUME,
  IntentType.UI_END_RUN,
  IntentType.UI_MENU,
  IntentType.UI_BUTTON,
  IntentType.UI_SELECT,
]);

/**
 * Is this intent kind a UI (non-flight) intent? UI intents are always routed
 * away from the flight simulation so a button or menu action can never be
 * mistaken for a Flap_Input (Req 1.6).
 * @param {string} type an {@link IntentType} value
 * @returns {boolean}
 */
export function isUiIntent(type) {
  return UI_INTENTS.has(type);
}

/**
 * Default keyboard mapping from physical keys (KeyboardEvent.code) to the game
 * intent they produce. Space flaps (Req 1.3–1.5); E activates the Flight_Power
 * (Req 1.7); Escape/P request a pause; Enter confirms. The DOM shell uses this,
 * but the pure core is mapping-agnostic — callers pass intent kinds directly.
 * @type {Readonly<Record<string, string>>}
 */
export const DEFAULT_KEY_MAP = Object.freeze({
  Space: IntentType.FLAP,
  KeyE: IntentType.FLIGHT_POWER,
  Escape: IntentType.UI_PAUSE,
  KeyP: IntentType.UI_PAUSE,
  Enter: IntentType.UI_CONFIRM,
  // Q ends the current Run from the Pause_State (Req 9.8): finalize + Results.
  // It is a UI intent (never a flap, Req 1.6) and is only acted on in pause.
  KeyQ: IntentType.UI_END_RUN,
  // Number keys select the Nth option in the current UI (battle action,
  // possession choice, shop row). They are UI intents carrying a 0-based
  // `index`, never flaps (Req 1.6). Both the digit row and the numpad map.
  Digit1: { type: IntentType.UI_SELECT, index: 0 },
  Digit2: { type: IntentType.UI_SELECT, index: 1 },
  Digit3: { type: IntentType.UI_SELECT, index: 2 },
  Digit4: { type: IntentType.UI_SELECT, index: 3 },
  Numpad1: { type: IntentType.UI_SELECT, index: 0 },
  Numpad2: { type: IntentType.UI_SELECT, index: 1 },
  Numpad3: { type: IntentType.UI_SELECT, index: 2 },
  Numpad4: { type: IntentType.UI_SELECT, index: 3 },
});

/**
 * @typedef {Object} Intent
 * @property {string} type   the {@link IntentType} kind
 * @property {number} t      raw-event timestamp (ms) used only for ordering
 * @property {string} scope  the state scope this intent was created in
 * @property {number} seq    monotonic creation order (stable tiebreaker)
 * @property {number} [index] 0-based option index for a UI_SELECT intent
 */

/**
 * Create the pure, DOM-free input queue: the debounce table, the timestamped
 * intent queue, the state scope, and the transition barrier. Every method is a
 * plain state mutation on this object; nothing here reads a browser global, so
 * the queue can be constructed and driven entirely in Node for testing.
 *
 * Typical wiring: the DOM shell calls `registerKeyDown`/`registerKeyUp`/
 * `registerClick`/`registerUiAction` as events arrive; the FSM calls
 * `setState`/`transition` on state changes; `loop.js` calls
 * `consumeInputIntents()` once per fixed step.
 *
 * @param {object} [options]
 * @param {string} [options.initialScope] the starting state scope label
 *   (e.g. 'Main_Menu_State'); intents are tagged with the scope active when
 *   they are created and only delivered while that scope is current.
 * @returns {{
 *   registerKeyDown: (type: string, t?: number) => boolean,
 *   registerKeyUp: (type: string) => void,
 *   registerClick: (opts?: { inFlightArea?: boolean, type?: string, t?: number }) => boolean,
 *   registerUiAction: (type: string, t?: number) => boolean,
 *   consumeInputIntents: () => Intent[],
 *   setState: (scope: string) => void,
 *   transition: (scope: string) => void,
 *   flush: () => void,
 *   getScope: () => string,
 *   pendingCount: () => number,
 * }}
 */
export function createInputQueue(options = {}) {
  let scope = options.initialScope ?? "Main_Menu_State";

  /** @type {Intent[]} intents created this scope and not yet consumed. */
  let queue = [];

  /**
   * Debounce table: for each key-mapped intent kind that behaves like a held
   * key, whether it is currently held down. A key must be released (false)
   * before it can register another press (Req 1.5).
   * @type {Map<string, boolean>}
   */
  const held = new Map();

  // Monotonic creation counter — a stable tiebreaker so intents created in the
  // same millisecond keep their arrival order deterministically.
  let seq = 0;

  /**
   * Resolve a timestamp for an event: use the supplied value when finite,
   * otherwise fall back to the creation sequence so ordering stays total and
   * deterministic even without a clock (as in headless tests).
   * @param {number|undefined} t
   * @returns {number}
   */
  function stamp(t) {
    return Number.isFinite(t) ? /** @type {number} */ (t) : seq;
  }

  /**
   * Append an intent to the queue, tagged with the current scope and a
   * monotonic sequence number. An optional `extra` object is merged onto the
   * intent (used to carry the `index` of a UI_SELECT option).
   * @param {string} type
   * @param {number|undefined} t
   * @param {object} [extra] extra fields merged onto the intent (e.g. { index })
   */
  function enqueue(type, t, extra) {
    const intent = { type, t: stamp(t), scope, seq: seq++ };
    if (extra && typeof extra.index === "number") intent.index = extra.index;
    queue.push(intent);
  }

  return {
    /**
     * Register a key-down for a mapped intent. Held-key debounce (Req 1.5):
     * the first down for a key enqueues exactly one intent and latches the key
     * as held; further downs while still held (auto-repeat) are ignored until a
     * matching `registerKeyUp`. Returns whether an intent was actually enqueued.
     *
     * UI key intents (confirm/pause/etc.) are debounced the same way so a held
     * confirm key does not fire repeatedly, and they are never flaps (Req 1.6).
     *
     * Debounce is keyed by `extra.key` when supplied, otherwise by `type`. The
     * DOM shell passes the physical key code so that two different keys mapping
     * to the SAME intent kind (e.g. Digit1/Digit2 both producing UI_SELECT)
     * debounce independently — pressing "2" right after "1" still registers.
     * Flight intents keep the default (type) debounce, so the held-flap
     * property (Req 1.5) is unchanged.
     *
     * @param {string} type an {@link IntentType} value
     * @param {number} [t] raw-event timestamp (ms)
     * @param {{ index?: number, key?: string }} [extra] optional payload: a
     *   UI_SELECT `index`, and/or a `key` to debounce on instead of `type`
     * @returns {boolean} true if a new intent was enqueued
     */
    registerKeyDown(type, t, extra) {
      const debounceKey = (extra && extra.key) || type;
      if (held.get(debounceKey)) return false; // still held — ignore auto-repeat
      held.set(debounceKey, true);
      enqueue(type, t, extra);
      return true;
    },

    /**
     * Register a key-up for a mapped intent, clearing its held latch so the
     * next discrete press can register again (Req 1.5). The latch is keyed by
     * `debounceKey` when supplied (matching {@link registerKeyDown}'s key),
     * otherwise by `type`.
     * @param {string} type an {@link IntentType} value
     * @param {string} [debounceKey] the latch key used at key-down
     */
    registerKeyUp(type, debounceKey) {
      held.set(debounceKey || type, false);
    },

    /**
     * Register a mouse click. A click inside the flight area is one Normal_Flap
     * per click (Req 1.4) — clicks are inherently discrete, so no debounce
     * latch is needed. A click outside the flight area (on a UI button) is
     * NEVER a flap (Req 1.6); pass the UI intent it activates via `type`.
     *
     * @param {object} [opts]
     * @param {boolean} [opts.inFlightArea] whether the click landed in the
     *   flight area (the canvas playfield). Defaults to true.
     * @param {string} [opts.type] the UI intent to enqueue when the click is
     *   NOT in the flight area (defaults to {@link IntentType.UI_BUTTON}).
     * @param {number} [opts.t] raw-event timestamp (ms)
     * @returns {boolean} true if an intent was enqueued
     */
    registerClick(opts = {}) {
      const inFlightArea = opts.inFlightArea ?? true;
      if (inFlightArea) {
        enqueue(IntentType.FLAP, opts.t);
      } else {
        enqueue(opts.type ?? IntentType.UI_BUTTON, opts.t);
      }
      return true;
    },

    /**
     * Register a UI action triggered by something other than a mapped key or a
     * raw click position — e.g. an on-screen button handler. Always routed as a
     * UI intent and never a flap (Req 1.6). Guards against a flight intent kind
     * being passed in by mistake. An optional 0-based `index` is carried for a
     * UI_SELECT action (e.g. an on-screen battle-action button).
     * @param {string} type a UI {@link IntentType} value
     * @param {number} [t] raw-event timestamp (ms)
     * @param {{ index?: number }} [extra] optional payload (e.g. { index })
     * @returns {boolean} true if an intent was enqueued
     */
    registerUiAction(type, t, extra) {
      if (!isUiIntent(type)) return false; // never let a UI path emit a flap
      enqueue(type, t, extra);
      return true;
    },

    /**
     * Hand the tick about to run every intent accumulated since the previous
     * tick, then clear the queue so each input is consumed exactly once
     * (Req 1.1 / Property 1). Only intents created in the CURRENT scope are
     * returned; any stragglers from a prior scope are dropped as a second guard
     * against cross-transition leakage (Req 9.6, 10.7). Intents come back in
     * deterministic (timestamp, then creation-order) order.
     * @returns {Intent[]} intents for this tick, in resolution order
     */
    consumeInputIntents() {
      const forThisTick = queue.filter((i) => i.scope === scope);
      queue = [];
      forThisTick.sort((a, b) => a.t - b.t || a.seq - b.seq);
      return forThisTick;
    },

    /**
     * Set the current state scope WITHOUT flushing — used to initialize scope.
     * Prefer {@link transition} at real state changes so the triggering input
     * is dropped.
     * @param {string} nextScope
     */
    setState(nextScope) {
      scope = nextScope;
    },

    /**
     * Transition boundary (Req 9.6, 10.7): drop every not-yet-consumed intent
     * and switch scope. The input that caused the transition has, by
     * definition, not been consumed by the destination state, so clearing the
     * queue here guarantees it cannot also flap, act, or restart after the
     * change. Held-key latches are intentionally preserved so a key still held
     * across a transition does not spuriously re-fire until it is released.
     * @param {string} nextScope the destination state label
     */
    transition(nextScope) {
      queue = [];
      scope = nextScope;
    },

    /**
     * Drop all pending intents without changing scope. A manual barrier the FSM
     * can use to flush buffered input at any point (e.g. on auto-pause).
     */
    flush() {
      queue = [];
    },

    /** @returns {string} the current state scope. */
    getScope() {
      return scope;
    },

    /** @returns {number} count of pending intents (test/debug visibility). */
    pendingCount() {
      return queue.length;
    },
  };
}

/**
 * Thin DOM shell: wire keyboard and mouse events on a target into a pure input
 * queue. This is the ONLY part of the module that touches the DOM, and it is
 * guarded so importing the module never requires a browser — if no usable
 * target/window exists, it returns a no-op detacher.
 *
 * Flap routing (Req 1.4, 1.6): a `mousedown` is a flap only when it lands
 * inside the canvas (the flight area); the `isInFlightArea` predicate decides,
 * defaulting to "any click on the canvas element is in the flight area." UI
 * buttons live outside the canvas and are expected to attach their own handlers
 * that call `queue.registerUiAction(...)`, so they never reach this flap path.
 *
 * @param {ReturnType<typeof createInputQueue>} queue the pure core to feed
 * @param {object} [options]
 * @param {EventTarget|null} [options.keyTarget] where to listen for key events
 *   (defaults to the global `window` when present).
 * @param {HTMLCanvasElement|null} [options.canvas] the flight-area canvas to
 *   listen on for `mousedown`.
 * @param {Readonly<Record<string,string>>} [options.keyMap] key→intent map
 *   (defaults to {@link DEFAULT_KEY_MAP}).
 * @param {(ev: MouseEvent, canvas: HTMLCanvasElement) => boolean} [options.isInFlightArea]
 *   predicate deciding whether a canvas click counts as a flap. Defaults to
 *   true for any click on the canvas.
 * @param {() => number} [options.now] injectable clock (ms) for timestamps.
 * @returns {() => void} a detach function that removes every listener added.
 */
export function attachInput(queue, options = {}) {
  const keyTarget =
    options.keyTarget ??
    (typeof window !== "undefined"
      ? /** @type {EventTarget} */ (window)
      : null);
  const canvas = options.canvas ?? null;
  const keyMap = options.keyMap ?? DEFAULT_KEY_MAP;
  const isInFlightArea = options.isInFlightArea ?? (() => true);
  const now =
    options.now ??
    (typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now());

  // Nothing to attach to (headless import): return a no-op detacher so callers
  // can always call the result safely.
  if (!keyTarget && !canvas) {
    return () => {};
  }

  /** @param {KeyboardEvent} ev */
  function onKeyDown(ev) {
    const mapping = keyMap[ev.code];
    if (!mapping) return;
    // A mapping is either a plain intent-kind string, or an object carrying the
    // kind plus a payload (e.g. UI_SELECT with an `index`).
    const type = typeof mapping === "string" ? mapping : mapping.type;
    const index = typeof mapping === "object" ? mapping.index : undefined;
    // Prevent the browser's default (Space scrolling the page) for mapped keys.
    if (typeof ev.preventDefault === "function") ev.preventDefault();
    // Debounce on the physical key code so keys sharing an intent kind (digits
    // → UI_SELECT) latch independently.
    queue.registerKeyDown(type, now(), { index, key: ev.code });
  }

  /** @param {KeyboardEvent} ev */
  function onKeyUp(ev) {
    const mapping = keyMap[ev.code];
    if (!mapping) return;
    const type = typeof mapping === "string" ? mapping : mapping.type;
    queue.registerKeyUp(type, ev.code);
  }

  /** @param {MouseEvent} ev */
  function onMouseDown(ev) {
    if (!canvas) return;
    queue.registerClick({
      inFlightArea: isInFlightArea(ev, canvas),
      t: now(),
    });
  }

  if (keyTarget) {
    keyTarget.addEventListener(
      "keydown",
      /** @type {EventListener} */ (onKeyDown),
    );
    keyTarget.addEventListener("keyup", /** @type {EventListener} */ (onKeyUp));
  }
  if (canvas) {
    canvas.addEventListener(
      "mousedown",
      /** @type {EventListener} */ (onMouseDown),
    );
  }

  return function detach() {
    if (keyTarget) {
      keyTarget.removeEventListener(
        "keydown",
        /** @type {EventListener} */ (onKeyDown),
      );
      keyTarget.removeEventListener(
        "keyup",
        /** @type {EventListener} */ (onKeyUp),
      );
    }
    if (canvas) {
      canvas.removeEventListener(
        "mousedown",
        /** @type {EventListener} */ (onMouseDown),
      );
    }
  };
}

/**
 * Thin DOM shell: wire a VISIBLE on-screen Flight_Power button to the input
 * queue (Req 1.7). This is the on-screen counterpart to the E key — a click on
 * the button enqueues a {@link IntentType.FLIGHT_POWER} intent, exactly as the
 * key does, so the same downstream path (shell routing + activateHover's
 * cooldown gate) decides whether Hover actually activates.
 *
 * The button is a UI control OUTSIDE the flight area, so its click must never
 * be treated as a Normal_Flap (Req 1.6) — it is routed as a FLIGHT_POWER
 * intent, never through the canvas flap path.
 *
 * Only-fires-when-powered (Req 1.7, 1.8): activation only makes sense while a
 * power-providing Spirit is equipped. The button suppresses the intent at the
 * source when the injected `isPowerAvailable` predicate reports no power
 * (typically `() => spiritProvidesFlightPower(runState.equippedSpirit)`), and
 * the shell reflects readiness visually by toggling the button's `disabled`
 * state. When no power is available the click is ignored and nothing is
 * enqueued, so velocity and cooldown are left unchanged downstream (Req 1.8).
 *
 * Guarded for headless use: if no usable button is supplied (e.g. `node
 * --check` or the no-browser harness) it returns a no-op detacher and touches
 * no DOM, so merely importing/constructing never requires a `document`.
 *
 * @param {ReturnType<typeof createInputQueue>} queue the pure core to feed
 * @param {object} [options]
 * @param {EventTarget|null} [options.button] the on-screen button element to
 *   listen on for `click` (keyboard-activatable, so the accessible `click`
 *   event drives it rather than a raw `mousedown`).
 * @param {() => boolean} [options.isPowerAvailable] predicate gating the
 *   button: return true only while a power-providing Spirit is equipped (and,
 *   if desired, its cooldown has elapsed — the cooldown is ALSO enforced
 *   downstream, so this predicate may safely gate on equipped-Spirit alone).
 *   Defaults to always-available.
 * @param {() => number} [options.now] injectable clock (ms) for timestamps.
 * @returns {() => void} a detach function that removes the listener added.
 */
export function attachFlightPowerButton(queue, options = {}) {
  const button = options.button ?? null;
  const isPowerAvailable = options.isPowerAvailable ?? (() => true);
  const now =
    options.now ??
    (typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now());

  // Nothing to attach to (headless import): return a no-op detacher.
  if (!button || typeof button.addEventListener !== "function") {
    return () => {};
  }

  /** @param {MouseEvent} ev */
  function onClick(ev) {
    // A disabled/powerless button fires nothing (Req 1.7, 1.8). Downstream the
    // Hover cooldown gate in activateHover still guards the cooldown case.
    if (!isPowerAvailable()) return;
    if (typeof ev.preventDefault === "function") ev.preventDefault();
    queue.registerKeyDown(IntentType.FLIGHT_POWER, now());
    // A click is a discrete press; release the held latch immediately so the
    // next click can register again (the key path relies on keyup, the button
    // has no keyup event).
    queue.registerKeyUp(IntentType.FLIGHT_POWER);
  }

  button.addEventListener("click", /** @type {EventListener} */ (onClick));

  return function detach() {
    button.removeEventListener("click", /** @type {EventListener} */ (onClick));
  };
}

export default createInputQueue;
