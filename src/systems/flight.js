// systems/flight.js — Ghosty's flight physics (pure logic, no DOM).
//
// This module advances Ghosty's vertical motion for one fixed simulation step
// while the Game is in Active_Flight_State. It is a pure function of state,
// intents, dt, and config: given a RunState it returns the (mutated-in-place
// and returned) RunState with Ghosty's `prevX/prevY`, `vy`, and `y` updated.
// Only `render.js`/`input.js` touch the DOM; this file never does.
//
// Coordinate convention (see design.md "Logical Geometry and Coordinate
// Convention"): Ghosty's `x`/`y` are CENTER coordinates in logical pixels. The
// draw rect and the Hitbox derive from center ± half the configured logical
// body size — never from the PNG's natural pixel dimensions. This system only
// moves Ghosty vertically (x is driven by the world, not the flap), but it
// still mirrors `x` into `prevX` each step so render interpolation (prev→curr)
// has a consistent pair to tween (Req 1.10 relies on prevX/prevY being synced).
//
// Three-clock rule: flight simulation time advances ONLY in Active_Flight_State
// (see state.js). The FSM calls `stepFlight` only in that state; this module
// never decides when it runs, it only computes one step when asked.
//
// Requirements covered here:
//   - Req 1.2  Gravity increases downward velocity up to terminal velocity.
//   - Req 1.3  A Flap_Input SETS vy to the Normal_Flap velocity (not additive).
//   - Req 1.12 Ready_State: Ghosty is stationary at the initial center, vy 0,
//              and NO gravity. (Enforced by the FSM not calling stepFlight;
//              `readyGhosty` / `isStationary` document and support that wiring.)
//   - Req 1.13 The first Flap_Input of a Run starts flight (FSM enters
//              Active_Flight_State) and sets vy to Normal_Flap. The velocity
//              part is `applyFlap`; the state transition is the FSM's domain.
//
// Hover (the Storm_Bat Flight_Power) is the one non-trivial addition to the
// per-step integration. It is a small state machine held entirely on the
// RunState via two active-flight-seconds clocks:
//
//   - `hoverRemaining` — seconds of suspended-gravity Hover left. While > 0,
//     gravity is NOT applied this step; `vy` stays whatever it was set to on
//     activation (0). Decremented by `dt` each step until it reaches 0.
//   - `hoverCooldown`  — seconds until Hover can be activated again. Started at
//     the configured cooldown on activation and decremented by `dt` each step.
//
// Both clocks advance ONLY here, and `stepFlight` runs ONLY in
// Active_Flight_State (the FSM enforces the three-clock rule), so they freeze
// outside Active_Flight automatically — nothing else ever touches them, which
// is exactly why switching Spirits never refills `hoverCooldown` (Req 6.17).
//
// The precedence rules inside one step (Req 6.14–6.16):
//   - A same-tick Normal_Flap BEATS a Hover activation: the flap is applied and
//     Hover does NOT activate that tick (Req 6.16).
//   - A Normal_Flap while Hover is already active CANCELS Hover (clears
//     `hoverRemaining`), applies the flap velocity, and does NOT refund the
//     cooldown (Req 6.14).
//   - Natural expiry (`hoverRemaining` reaching 0 without a flap) resumes
//     gravity from the current `vy`, which is 0 because activation set it there
//     and suspended gravity kept it there (Req 6.15).

/**
 * @typedef {Object} Ghosty
 * @property {number} x      center x, logical px
 * @property {number} y      center y, logical px
 * @property {number} vy     vertical velocity, logical px/s (negative = up)
 * @property {number} prevX  previous-step center x, for render interpolation only
 * @property {number} prevY  previous-step center y, for render interpolation only
 */

/**
 * Build a fresh Ghosty positioned for Ready_State: stationary at the configured
 * initial center with zero vertical velocity. `prevX/prevY` start equal to the
 * current center so the very first interpolated frame has nothing to tween.
 *
 * Use this when starting a Run (Req 1.12). While the Game stays in Ready_State
 * the FSM must NOT call {@link stepFlight} for Ghosty, which is how "no Gravity
 * before the first flap" is enforced — see {@link isStationary}.
 *
 * @param {{ ghosty: { initialCenter: { x: number, y: number }, initialVelocityY: number } }} config
 * @returns {Ghosty}
 */
export function readyGhosty(config) {
  const { initialCenter, initialVelocityY } = config.ghosty;
  return {
    x: initialCenter.x,
    y: initialCenter.y,
    vy: initialVelocityY,
    prevX: initialCenter.x,
    prevY: initialCenter.y,
  };
}

/**
 * Whether a Ghosty is in the Ready_State resting configuration: at the
 * configured initial center with zero vertical velocity. This is a pure
 * predicate the FSM/tests can use to assert the Ready_State invariant (Req
 * 1.12); gravity is "not applied" simply because stepFlight is not called in
 * Ready_State, so a Ghosty that has never flapped stays exactly here.
 *
 * @param {Ghosty} ghosty
 * @param {{ ghosty: { initialCenter: { x: number, y: number }, initialVelocityY: number } }} config
 * @returns {boolean}
 */
export function isStationary(ghosty, config) {
  const { initialCenter, initialVelocityY } = config.ghosty;
  return (
    ghosty.x === initialCenter.x &&
    ghosty.y === initialCenter.y &&
    ghosty.vy === initialVelocityY
  );
}

/**
 * Apply a Normal_Flap to Ghosty: SET (do not add to) the vertical velocity to
 * the configured Normal_Flap velocity, regardless of the current velocity (Req
 * 1.3). This is the velocity half of both an in-flight flap and the first flap
 * that starts a Run (Req 1.13); the FSM owns the Ready_State → Active_Flight
 * transition that wraps the first flap.
 *
 * Mutates and returns `ghosty`. Does not touch position or `prevX/prevY` — the
 * per-step bookkeeping in {@link stepFlight} does that.
 *
 * @param {Ghosty} ghosty
 * @param {{ normalFlapVelocity: number }} config
 * @returns {Ghosty} the same ghosty, with `vy` set to the flap velocity
 */
export function applyFlap(ghosty, config) {
  ghosty.vy = config.normalFlapVelocity;
  return ghosty;
}

/**
 * Activate Hover — the Storm_Bat Flight_Power activation path (Req 1.7, 1.8,
 * 6.12). Activation succeeds ONLY when the Hover cooldown has elapsed
 * (`hoverCooldown <= 0`). On success it:
 *   - sets Ghosty's vertical velocity to zero (Req 6.12),
 *   - suspends Gravity for the configured Hover duration by arming
 *     `hoverRemaining` from `config.hover.duration` (Req 6.12), and
 *   - starts the configured Hover cooldown from the moment of activation by
 *     setting `hoverCooldown` to `config.hover.cooldown` (Req 6.12).
 *
 * When the cooldown has NOT elapsed the request is ignored: `vy`,
 * `hoverRemaining`, and `hoverCooldown` are all left unchanged (Req 1.8). This
 * mirrors the generic Flight_Power contract — the caller (input/shell) is
 * responsible for only routing the request when a power-providing Spirit is
 * equipped; this function enforces the cooldown gate.
 *
 * Pure with respect to the DOM; mutates and returns `runState`. This is the
 * low-level activation primitive. In the normal per-step flow, {@link stepFlight}
 * calls this itself when a Flight_Power intent is present (and no same-tick flap
 * beats it); callers may also invoke it directly (e.g. an on-screen button path
 * that activates immediately for the current tick).
 *
 * @param {{ ghosty: Ghosty, hoverRemaining: number, hoverCooldown: number }} runState
 * @param {{ hover: { duration: number, cooldown: number } }} config
 * @returns {{ ghosty: Ghosty, hoverRemaining: number, hoverCooldown: number }} the same runState
 */
export function activateHover(runState, config) {
  // Cooldown gate (Req 1.7, 1.8): ignore the request and change nothing while
  // the cooldown has not elapsed.
  if (runState.hoverCooldown > 0) {
    return runState;
  }

  // Activate: zero the velocity, suspend gravity for the Hover duration, and
  // start the cooldown from this moment (Req 6.12).
  runState.ghosty.vy = 0;
  runState.hoverRemaining = config.hover.duration;
  runState.hoverCooldown = config.hover.cooldown;

  return runState;
}

/**
 * Advance Ghosty's flight by one fixed simulation step. Pure with respect to
 * the DOM; mutates and returns `runState`. Call this ONLY in
 * Active_Flight_State (the FSM enforces the three-clock rule).
 *
 * Order of operations each step:
 *   1. Sync `prevX/prevY` ← current `x/y` BEFORE moving, so render
 *      interpolation tweens from the previous committed position to the new one
 *      (Req 1.10 relies on this; collisions always read committed state, never
 *      the interpolated value).
 *   2. Resolve a Normal_Flap and Hover for this tick in the right precedence
 *      (Req 6.14–6.16): a same-tick flap BEATS a Hover activation (flap wins,
 *      Hover does not activate this tick); a flap while Hover is already active
 *      CANCELS Hover without refunding the cooldown; otherwise an uncontested
 *      Flight_Power request activates Hover (subject to its cooldown). A flap
 *      SETS `vy` to the Normal_Flap velocity regardless of the current velocity
 *      (Req 1.3 — set, not add).
 *   3. Advance the Hover clocks in active-flight seconds (Req 6.17): decrement
 *      `hoverCooldown` toward 0, and — if Hover is active — decrement
 *      `hoverRemaining`, detecting NATURAL expiry this step. Both only ever move
 *      here, so they freeze outside Active_Flight_State automatically.
 *   4. Apply Gravity: `vy += gravity * dt`, then clamp the DOWNWARD velocity to
 *      the configured terminal velocity (Req 1.2). Upward velocity is left
 *      uncapped. Gravity is SUSPENDED while Hover is active (Req 6.12, 6.13) —
 *      pipes still move, time still accrues, collisions still apply (handled by
 *      the FSM), only this gravity application is skipped. On natural expiry
 *      gravity resumes from `vy = 0` (Req 6.15); activation already set `vy` to
 *      0 and suspended gravity preserved it, so no extra reset is needed.
 *   5. Integrate the center position: `y += vy * dt`.
 *
 * @param {{ ghosty: Ghosty, hoverRemaining: number, hoverCooldown: number }} runState the current Run state (mutated in place)
 * @param {{ flap?: boolean, flightPower?: boolean }} intents per-tick input intents; `flap` true means a Flap_Input occurred this tick, `flightPower` true means a Flight_Power (Hover) activation was requested this tick
 * @param {number} dt fixed simulation step in seconds
 * @param {{ gravity: number, normalFlapVelocity: number, terminalVelocity: number, hover: { duration: number, cooldown: number } }} config
 * @returns {{ ghosty: Ghosty }} the same runState with Ghosty advanced
 */
export function stepFlight(runState, intents, dt, config) {
  const ghosty = runState.ghosty;

  // 1. Record the previous committed center for render-only interpolation. Done
  //    first so interpolation reads prev→current (Req 1.10); collisions read
  //    committed state, never the tweened value.
  ghosty.prevX = ghosty.x;
  ghosty.prevY = ghosty.y;

  // 2. Resolve the flap/Hover precedence for this tick (Req 6.14–6.16).
  const flapped = Boolean(intents && intents.flap);
  const powerRequested = Boolean(intents && intents.flightPower);

  if (flapped) {
    // A Normal_Flap SETS the velocity (Req 1.3) and wins over Hover this tick:
    //   - a same-tick Hover request does NOT activate (Req 6.16), and
    //   - an already-active Hover is CANCELLED without refunding the cooldown
    //     (Req 6.14) — we clear only `hoverRemaining`, never `hoverCooldown`.
    applyFlap(ghosty, config);
    runState.hoverRemaining = 0;
  } else if (powerRequested) {
    // Uncontested Flight_Power request: activate Hover subject to its cooldown
    // gate (Req 1.7, 1.8, 6.12). activateHover changes nothing if on cooldown.
    activateHover(runState, config);
  }

  // Whether Hover is currently suspending gravity for this step (Req 6.12,
  // 6.13). Captured AFTER resolving activation/cancellation above so an
  // activation this tick suspends gravity immediately, and a flap-cancel this
  // tick restores gravity immediately.
  const hoverActive = runState.hoverRemaining > 0;

  // 3. Advance the Hover clocks, in active-flight seconds (Req 6.17). These are
  //    the ONLY writes to these clocks, so they freeze outside flight.
  if (runState.hoverCooldown > 0) {
    runState.hoverCooldown = Math.max(0, runState.hoverCooldown - dt);
  }
  if (hoverActive) {
    runState.hoverRemaining = Math.max(0, runState.hoverRemaining - dt);
  }

  // 4. Apply gravity up to terminal downward velocity (Req 1.2) UNLESS Hover is
  //    suspending it this step (Req 6.12, 6.13). On the step where Hover expires
  //    naturally, `hoverActive` was true so gravity stays suspended this step;
  //    gravity resumes next step from `vy = 0` (Req 6.15).
  if (!hoverActive) {
    ghosty.vy += config.gravity * dt;
    if (ghosty.vy > config.terminalVelocity) {
      ghosty.vy = config.terminalVelocity;
    }
  }

  // 5. Integrate the center position from the (possibly flap-set, gravity-
  //    adjusted) velocity. While Hover is active vy is 0, so Ghosty holds its
  //    vertical position while pipes keep scrolling (handled by the FSM).
  ghosty.y += ghosty.vy * dt;

  return runState;
}

export default stepFlight;
