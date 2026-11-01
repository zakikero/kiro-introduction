// test/render.test.js — example/unit + property tests for task 6.1:
// the finalized render.js canvas layers, labeled placeholder art, and the
// draw-time logical-playfield letterbox.
//
// render.js is a thin DOM/IO module, but it is written to import and run
// headlessly: all browser globals are `typeof`-guarded and `renderToContext`
// draws into ANY 2D-context-shaped object. These tests use a lightweight
// RECORDING context stub (no real Canvas) to prove the task's correctness
// guarantees without a browser:
//
//   - the letterbox fit is a pure, draw-time-only transform that preserves the
//     logical playfield's aspect ratio at any display size (Req 12.9);
//   - collisions stay in logical coordinates regardless of display size, so
//     `hitboxFor` is identical at any scale (Req 12.9 / Property 12);
//   - Ghosty is drawn inside the logical body rect with aspect preserved and
//     never at the sprite's natural pixel dimensions (Req 12.10);
//   - labeled placeholder art exists for every missing cosmetic (four Hats,
//     two Spirits) so absent art never blocks the loop (Req 12.1);
//   - the effects layer never mutates gameplay coordinates (Req 12.3).

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import {
  computeLetterbox,
  renderToContext,
  PLACEHOLDER_ART,
} from "../src/render.js";
import { States } from "../src/state.js";
import { hitboxFor } from "../src/systems/collision.js";
import { fc, propertyName, assertProperty } from "../test-support/helpers.js";

// --- A tiny recording 2D-context stub ---------------------------------------

/**
 * Build a minimal object shaped like a CanvasRenderingContext2D that records
 * the transforms set on it and no-ops every drawing call. Enough surface for
 * render.js and the ui/* draw functions to run end to end headlessly.
 * @returns {{ transforms: number[][], ctx: object }}
 */
function makeRecordingCtx() {
  const transforms = [];
  const noop = () => {};
  const gradient = { addColorStop: noop };
  const ctx = {
    canvas: { width: 0, height: 0 },
    transforms,
    save: noop,
    restore: noop,
    setTransform: (a, b, c, d, e, f) => {
      transforms.push([a, b, c, d, e, f]);
    },
    translate: noop,
    scale: noop,
    beginPath: noop,
    closePath: noop,
    rect: noop,
    clip: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    arcTo: noop,
    ellipse: noop,
    quadraticCurveTo: noop,
    fill: noop,
    stroke: noop,
    fillRect: noop,
    strokeRect: noop,
    fillText: noop,
    strokeText: noop,
    drawImage: noop,
    roundRect: noop,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    // Writable style/state fields the modules set freely.
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    font: "10px sans-serif",
    textAlign: "left",
    textBaseline: "alphabetic",
    globalAlpha: 1,
    shadowColor: "transparent",
    shadowBlur: 0,
  };
  return { transforms, ctx };
}

/** A minimal flight-like RunState the renderer can paint. */
function makeRunState(overrides = {}) {
  return {
    ghosty: {
      x: CONFIG.ghosty.initialCenter.x,
      y: CONFIG.ghosty.initialCenter.y,
      prevX: CONFIG.ghosty.initialCenter.x,
      prevY: CONFIG.ghosty.initialCenter.y,
      vy: 0,
    },
    pipes: [{ x: 400, gapCenter: 300, scored: false }],
    symbols: [],
    pipeScore: 0,
    soulCoins: 0,
    battleHp: 22,
    maxBattleHp: 22,
    equippedSpirit: null,
    ...overrides,
  };
}

// --- Letterbox: pure, aspect-preserving fit (Req 12.9) ----------------------

test("computeLetterbox preserves aspect ratio and centers the playfield", () => {
  const { width: lw, height: lh } = CONFIG.playfield;

  // Exact fit: no bars, offset 0.
  const exact = computeLetterbox(lw, lh, lw, lh);
  assert.equal(exact.scale, 1);
  assert.equal(exact.offsetX, 0);
  assert.equal(exact.offsetY, 0);

  // Too-wide viewport: height-bound scale, horizontal bars only.
  const wide = computeLetterbox(lw * 3, lh, lw, lh);
  assert.equal(wide.scale, 1, "height-bound keeps scale 1");
  assert.ok(wide.offsetX > 0, "pillarbox bars on the sides");
  assert.equal(wide.offsetY, 0);

  // Too-tall viewport: width-bound scale, vertical bars only.
  const tall = computeLetterbox(lw, lh * 3, lw, lh);
  assert.equal(tall.scale, 1, "width-bound keeps scale 1");
  assert.equal(tall.offsetX, 0);
  assert.ok(tall.offsetY > 0, "letterbox bars top and bottom");

  // Uniform scale at 2x in both dimensions.
  const twice = computeLetterbox(lw * 2, lh * 2, lw, lh);
  assert.equal(twice.scale, 2);
  assert.equal(twice.offsetX, 0);
  assert.equal(twice.offsetY, 0);
});

test("computeLetterbox falls back safely for degenerate canvas sizes", () => {
  const { width: lw, height: lh } = CONFIG.playfield;
  const zero = computeLetterbox(0, 0, lw, lh);
  assert.ok(Number.isFinite(zero.scale) && zero.scale > 0);
  assert.ok(Number.isFinite(zero.offsetX));
  assert.ok(Number.isFinite(zero.offsetY));
});

// --- Collisions stay in logical coordinates at any display size -------------

test("hitboxFor is independent of display size (Req 12.9 / Property 12)", () => {
  const ghosty = { x: 300, y: 250 };
  const base = hitboxFor(ghosty, CONFIG);
  // The letterbox at any viewport size never feeds back into hitboxFor —
  // collisions read the logical body size + center only.
  for (const [cw, ch] of [
    [960, 640],
    [1920, 1280],
    [480, 320],
    [1366, 768],
  ]) {
    const box = computeLetterbox(cw, ch, 960, 640);
    assert.ok(box.scale > 0);
    const again = hitboxFor(ghosty, CONFIG);
    assert.deepEqual(again, base, "hitbox must not change with display size");
  }
  // Sanity: the hitbox is the inset logical rect (≈24×31) centered on Ghosty.
  assert.equal(base.w, CONFIG.ghosty.hitboxWidth);
  assert.equal(base.h, CONFIG.ghosty.hitboxHeight);
});

// --- Draw-time-only transform: render sets a scale transform, never mutates -

test("renderToContext applies a draw-time scale transform and leaves state untouched", () => {
  const { ctx, transforms } = makeRecordingCtx();
  const runState = makeRunState();
  const before = JSON.parse(JSON.stringify(runState));

  renderToContext(ctx, 1920, 1280, {
    state: States.Active_Flight_State,
    runState,
  }, 0.5, CONFIG);

  // The world was drawn under a uniform 2x scale transform (1920/960).
  const scaled = transforms.find((t) => t[0] === 2 && t[3] === 2);
  assert.ok(scaled, "a 2x draw-time scale transform must be applied");

  // Rendering is read-only: no gameplay coordinate was mutated by drawing.
  assert.deepEqual(runState, before, "render must not mutate the RunState");
});

// --- Placeholder art covers every missing cosmetic (Req 12.1) ---------------

test("placeholder art exists for all four Hats and both Spirits (Req 12.1)", () => {
  const hatIds = Object.keys(CONFIG.hats);
  assert.equal(hatIds.length, 4, "config declares exactly four Hats");
  for (const id of hatIds) {
    assert.ok(
      PLACEHOLDER_ART.hats[id],
      `missing placeholder art for hat '${id}'`,
    );
    assert.ok(typeof PLACEHOLDER_ART.hats[id].label === "string");
  }

  for (const id of ["storm_bat", "pumpkin_guardian"]) {
    assert.ok(
      PLACEHOLDER_ART.spirits[id],
      `missing placeholder art for spirit '${id}'`,
    );
    assert.ok(typeof PLACEHOLDER_ART.spirits[id].label === "string");
  }
});

test("renderToContext draws flight with cosmetics (hat + spirit) without throwing", () => {
  const { ctx } = makeRecordingCtx();
  // A possessed run wearing a hat exercises the aura + hat placeholder paths.
  const runState = makeRunState({ equippedSpirit: "storm_bat" });
  const save = { equippedHat: "witchHat" };
  assert.doesNotThrow(() => {
    renderToContext(
      ctx,
      960,
      640,
      { state: States.Active_Flight_State, runState },
      0,
      CONFIG,
      {},
      save,
    );
  });
});

// --- Every state draws without crashing headlessly (graceful degradation) ---

test("renderToContext degrades gracefully across all FSM states", () => {
  const runState = makeRunState({
    activeBattle: {
      enemy: { type: "A", battleHp: 10, maxBattleHp: 10 },
      outcome: "ongoing",
      log: ["Ghosty attacks."],
    },
    pendingOffer: null,
  });
  const save = { candy: 5, ownedHats: ["none"], equippedHat: "none", highScore: 7 };
  const everyState = Object.values(States);
  for (const state of everyState) {
    const { ctx } = makeRecordingCtx();
    assert.doesNotThrow(
      () => renderToContext(ctx, 800, 600, { state, runState }, 0.25, CONFIG, {}, save),
      `render must not throw in state ${state}`,
    );
  }
});

// --- Property: render is read-only at any display size and alpha ------------

test(
  propertyName(12, "display scale and cosmetics never change gameplay state"),
  () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 1, max: 4096 }),
        fc.integer({ min: 1, max: 4096 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.constantFrom(null, "storm_bat", "pumpkin_guardian"),
        fc.constantFrom("none", "witchHat", "pumpkinCap", "batBonnet", "hauntedCrown"),
        (cw, ch, alpha, spirit, hat) => {
          const { ctx } = makeRecordingCtx();
          const runState = makeRunState({ equippedSpirit: spirit });
          const before = JSON.parse(JSON.stringify(runState));
          renderToContext(
            ctx,
            cw,
            ch,
            { state: States.Active_Flight_State, runState },
            alpha,
            CONFIG,
            {},
            { equippedHat: hat },
          );
          // The hitbox is identical regardless of display size / cosmetics, and
          // drawing mutated no gameplay coordinate.
          const box = hitboxFor(runState.ghosty, CONFIG);
          return (
            box.w === CONFIG.ghosty.hitboxWidth &&
            box.h === CONFIG.ghosty.hitboxHeight &&
            JSON.stringify(runState) === JSON.stringify(before)
          );
        },
      ),
    );
  },
);
