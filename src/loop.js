// loop.js — the fixed-timestep simulation loop (accumulator pattern).
//
// Physics and collisions MUST be frame-rate independent (Requirement 1.1) and
// MUST never be changed by visual interpolation (Requirement 1.10). This module
// implements the standard accumulator loop from the design: wall-clock frame
// time feeds an accumulator, the simulation advances in whole `FIXED_DT` steps,
// and any leftover time becomes a render-only interpolation factor `alpha`.
//
// Determinism rules this file guarantees:
//   - The simulation only ever advances in whole FIXED_DT steps, so identical
//     input sequences produce identical collision outcomes regardless of the
//     display refresh rate (Requirement 1.1).
//   - A frame longer than MAX_FRAME_TIME is clamped so the simulation never
//     does a large catch-up jump (Requirement 1.9).
//   - `alpha` is used for drawing only; collision checks always read committed
//     simulation state, never the interpolated value (Requirement 1.10).
//
// The stepping math is factored into a pure helper (`computeFixedSteps`) that
// needs no browser or requestAnimationFrame, so the frame-rate-independence and
// max-step-clamp properties (task 1.4) can be exercised headlessly.

/** Fixed simulation step in seconds (1/120 s). */
export const FIXED_DT = 1 / 120;

/**
 * Maximum wall-clock time (seconds) a single frame may contribute to the
 * simulation. Frames longer than this (background tab, stall) are clamped so
 * the simulation never does a large catch-up jump (Requirement 1.9).
 */
export const MAX_FRAME_TIME = 0.1;

/**
 * Pure stepping helper: given the current accumulator and a raw frame time,
 * compute how many whole fixed steps to run, the accumulator left afterward,
 * the render interpolation factor, and the clamped frame time actually accepted.
 *
 * This contains all of the loop's timing math with no side effects and no DOM,
 * so it is directly unit- and property-testable (task 1.4). The driver in
 * {@link startLoop} calls `fsm.tick` exactly `steps` times, then renders with
 * the returned `alpha`.
 *
 * @param {number} accumulator leftover simulation time from the previous frame (seconds, >= 0)
 * @param {number} frameTime raw elapsed wall-clock time since the last frame (seconds)
 * @param {number} [fixedDt] fixed step size (defaults to {@link FIXED_DT})
 * @param {number} [maxFrameTime] per-frame clamp (defaults to {@link MAX_FRAME_TIME})
 * @returns {{ steps: number, accumulator: number, alpha: number, acceptedFrameTime: number }}
 *   `steps`: number of whole fixed steps to simulate this frame.
 *   `accumulator`: remaining simulation time carried to the next frame, in [0, fixedDt).
 *   `alpha`: render interpolation factor accumulator/fixedDt, in [0, 1) (drawing only).
 *   `acceptedFrameTime`: the frame time after the MAX_FRAME_TIME clamp.
 */
export function computeFixedSteps(
  accumulator,
  frameTime,
  fixedDt = FIXED_DT,
  maxFrameTime = MAX_FRAME_TIME
) {
  // Guard against negative or non-finite frame times (e.g. a clock that went
  // backwards): treat them as zero elapsed so the simulation never rewinds.
  let accepted = Number.isFinite(frameTime) && frameTime > 0 ? frameTime : 0;

  // Req 1.9 clamp: never accept more than MAX_FRAME_TIME per frame.
  if (accepted > maxFrameTime) {
    accepted = maxFrameTime;
  }

  let acc = accumulator + accepted;

  // Advance the simulation in whole fixed steps only (Requirement 1.1).
  let steps = 0;
  while (acc >= fixedDt) {
    acc -= fixedDt;
    steps += 1;
  }

  // Render interpolation factor for drawing only (Requirement 1.10).
  const alpha = acc / fixedDt;

  return { steps, accumulator: acc, alpha, acceptedFrameTime: accepted };
}

/**
 * Install the requestAnimationFrame driver described in the design and start
 * the loop. Each frame it clamps the elapsed time, advances the FSM in whole
 * fixed steps (handing each step exactly the input intents assigned to it), and
 * performs one interpolated render.
 *
 * @param {{ tick: (dt: number, intents: any) => void, state?: any }} fsm
 *   the finite state machine; `tick(dt, intents)` runs one deterministic sim step.
 * @param {(state: any, alpha: number) => void} render
 *   draws the given state with the render-only interpolation factor.
 * @param {{ consumeInputIntents: () => any }} input
 *   source of per-tick input intents; `consumeInputIntents()` returns the
 *   intents for the tick about to run.
 * @param {object} [options]
 * @param {(cb: FrameRequestCallback) => number} [options.requestFrame]
 *   injectable requestAnimationFrame (defaults to the global one); useful for tests.
 * @param {() => number} [options.now] injectable high-resolution clock in ms
 *   (defaults to performance.now / Date.now); useful for tests.
 * @returns {() => void} a stop function that cancels the loop.
 */
export function startLoop(fsm, render, input, options = {}) {
  const requestFrame =
    options.requestFrame ||
    (typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : null);

  if (typeof requestFrame !== 'function') {
    throw new Error(
      'startLoop requires requestAnimationFrame (or options.requestFrame).'
    );
  }

  const now =
    options.now ||
    (typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now());

  let accumulator = 0;
  let lastTime = now();
  let running = true;
  let frameHandle = 0;

  /**
   * @param {number} currentTime timestamp in milliseconds supplied by the driver
   */
  function frame(currentTime) {
    if (!running) return;

    // requestAnimationFrame passes a DOMHighResTimeStamp; fall back to the
    // injected clock if the driver omitted it.
    const t = typeof currentTime === 'number' ? currentTime : now();
    const frameTime = (t - lastTime) / 1000; // seconds
    lastTime = t;

    const { steps, accumulator: nextAcc, alpha } = computeFixedSteps(
      accumulator,
      frameTime
    );

    for (let i = 0; i < steps; i += 1) {
      // One deterministic sim step; each step gets exactly its assigned intents.
      fsm.tick(FIXED_DT, input.consumeInputIntents());
    }
    accumulator = nextAcc;

    // Visual only (Requirement 1.10): collisions already read committed state.
    render(fsm.state, alpha);

    frameHandle = requestFrame(frame);
  }

  frameHandle = requestFrame(frame);

  return function stop() {
    running = false;
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(frameHandle);
    }
  };
}

export default startLoop;
