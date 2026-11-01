// test/appearance.test.js — regression coverage for the shared Ghosty
// appearance resolver (prompt §3) and the cached asset loader's headless
// fallback behavior (prompt §7). All pure/headless: no DOM, no real images.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fc, assertProperty } from "../test-support/helpers.js";
import { CONFIG } from "../src/config.js";
import {
  resolveAppearance,
  spriteDrawRect,
  standaloneHatRect,
  APPEARANCE_GEOMETRY,
  PLAYER_SPRITES,
  SPIRIT_SPRITES,
  STANDALONE_HATS,
  LEGACY_SPRITE,
} from "../src/appearance.js";
import { imageReady, firstReady, _resetAssets } from "../src/assets.js";

const HATS = ["none", "witchHat", "pumpkinCap", "batBonnet", "hauntedCrown"];
const SPIRITS = [null, "storm_bat", "pumpkin_guardian"];

// --- resolveAppearance: unpossessed -----------------------------------------

test("unpossessed resolves to the ONE whole swappable sprite for the hat (no layered hat)", () => {
  for (const hat of HATS) {
    const plan = resolveAppearance(hat, null);
    assert.equal(plan.possessed, false);
    assert.equal(plan.spirit, null);
    assert.equal(plan.bodyFile, PLAYER_SPRITES[hat]);
    // Exactly one layer (the whole body) — the hat is baked into the sprite.
    assert.equal(plan.layers.length, 1);
    assert.equal(plan.layers[0].role, "body");
    assert.equal(plan.standaloneHatFile, null);
    // Fallback chain always ends at the legacy sprite.
    assert.equal(plan.bodyFallbacks[plan.bodyFallbacks.length - 1], LEGACY_SPRITE);
  }
});

// --- resolveAppearance: possessed, all 15 combinations ----------------------

test("possessed resolves to the whole spirit body + exactly one standalone hat (none => no hat)", () => {
  for (const spirit of ["storm_bat", "pumpkin_guardian"]) {
    for (const hat of HATS) {
      const plan = resolveAppearance(hat, spirit);
      assert.equal(plan.possessed, true);
      assert.equal(plan.spirit, spirit);
      assert.equal(plan.bodyFile, SPIRIT_SPRITES[spirit]);
      if (hat === "none") {
        assert.equal(plan.standaloneHatFile, null);
        assert.equal(plan.layers.length, 1, "no hat layer for 'none'");
      } else {
        assert.equal(plan.standaloneHatFile, STANDALONE_HATS[hat]);
        assert.equal(plan.layers.length, 2, "body + exactly one hat layer");
        assert.equal(plan.layers[1].role, "hat");
      }
    }
  }
});

test("all 15 hat×(base+2 spirits) combinations produce a distinct, valid plan", () => {
  const seen = new Set();
  for (const spirit of SPIRITS) {
    for (const hat of HATS) {
      const plan = resolveAppearance(hat, spirit);
      const key = `${plan.possessed ? plan.spirit : "base"}|${plan.bodyFile}|${plan.standaloneHatFile || "-"}`;
      seen.add(key);
      assert.ok(plan.bodyFile, "every combination has a body sprite");
    }
  }
  // 5 base + 5 storm + 5 pumpkin = 15 distinct appearance keys.
  assert.equal(seen.size, 15);
});

test("unknown hat/spirit ids degrade to base Ghosty without throwing", () => {
  const plan = resolveAppearance("not-a-hat", "not-a-spirit");
  assert.equal(plan.possessed, false);
  assert.equal(plan.bodyFile, PLAYER_SPRITES.none);
});

// --- Geometry: body reference alignment keeps a stable optical body ---------

test("spriteDrawRect maps the body reference center onto the logical body center", () => {
  const bw = CONFIG.ghosty.bodyWidth;
  const bh = CONFIG.ghosty.bodyHeight;
  const cx = 300;
  const cy = 250;
  for (const file of Object.keys(APPEARANCE_GEOMETRY.bodyReference)) {
    const rect = spriteDrawRect(file, cx, cy, bw, bh);
    assert.ok(rect, `rect for ${file}`);
    const meta = APPEARANCE_GEOMETRY.bodyReference[file];
    const scale = bw / meta.rect[2];
    // The reference rect's center must land on (cx, cy).
    const refCx = rect.dx + (meta.rect[0] + meta.rect[2] / 2) * scale;
    const refCy = rect.dy + (meta.rect[1] + meta.rect[3] / 2) * scale;
    assert.ok(Math.abs(refCx - cx) < 1e-6, `${file} x centered`);
    assert.ok(Math.abs(refCy - cy) < 1e-6, `${file} y centered`);
    // The drawn body WIDTH (reference width * scale) equals the logical body.
    assert.ok(Math.abs(meta.rect[2] * scale - bw) < 1e-6, `${file} body width == 32`);
  }
});

test("Feature: flappy-kiro, Property: changing the hat never changes the optical body size/center", () => {
  // For a fixed center, every unpossessed sprite's body reference maps to the
  // SAME logical body box — so swapping hats never makes Ghosty jump or resize.
  assertProperty(
    fc.property(
      fc.constantFrom(...HATS),
      fc.double({ min: 0, max: 960, noNaN: true }),
      fc.double({ min: 0, max: 640, noNaN: true }),
      (hat, cx, cy) => {
        const bw = CONFIG.ghosty.bodyWidth;
        const bh = CONFIG.ghosty.bodyHeight;
        const plan = resolveAppearance(hat, null);
        const rect = spriteDrawRect(plan.bodyFile, cx, cy, bw, bh);
        if (!rect) return false;
        const meta = APPEARANCE_GEOMETRY.bodyReference[plan.bodyFile];
        const scale = bw / meta.rect[2];
        const refCx = rect.dx + (meta.rect[0] + meta.rect[2] / 2) * scale;
        const refCy = rect.dy + (meta.rect[1] + meta.rect[3] / 2) * scale;
        // Body reference always centers on (cx, cy) and is exactly bw wide.
        return (
          Math.abs(refCx - cx) < 1e-6 &&
          Math.abs(refCy - cy) < 1e-6 &&
          Math.abs(meta.rect[2] * scale - bw) < 1e-6
        );
      },
    ),
  );
});

test("standaloneHatRect positions the hat relative to the spirit draw rect", () => {
  const bw = CONFIG.ghosty.bodyWidth;
  const spiritFile = "spirit_storm_bat.png";
  const meta = APPEARANCE_GEOMETRY.bodyReference[spiritFile];
  const spiritRect = spriteDrawRect(spiritFile, 300, 250, bw, bw * (39 / 32));
  const hatRect = standaloneHatRect("hat_witch.png", spiritFile, spiritRect, meta, bw);
  assert.ok(hatRect, "a hat rect is produced");
  assert.ok(hatRect.dw > 0 && hatRect.dh > 0, "hat has positive size");
});

// --- Asset loader: headless fallback behavior -------------------------------

test("imageReady is false in a headless context, so callers take the placeholder path", () => {
  _resetAssets();
  // No Image API under node => nothing is ever ready.
  assert.equal(imageReady("ghosty_base.png"), false);
  assert.equal(firstReady(["ghosty_witch_hat.png", "ghosty_base.png", LEGACY_SPRITE]), null);
});

test("firstReady tolerates a non-array and an empty chain", () => {
  _resetAssets();
  assert.equal(firstReady(null), null);
  assert.equal(firstReady([]), null);
});
