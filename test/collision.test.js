// test/collision.test.js — property tests for swept collision and shields.
//
// Exercises src/systems/collision.js (pure logic, no DOM) with fast-check.
// This is the MANDATORY critical test subset for Milestone 1 (task 1.12):
//
//   Property 8:  Fatal unshielded pipe contact — overlapping a non-grace pair
//                with zero shields is fatal.
//   Property 9:  Shield consumption and same-pipe grace — an overlap with a
//                charge yields 'shield' on that pair; under grace that same
//                pair is non-fatal until the hitbox fully clears it, then grace
//                ends (clearedGraceId reported).
//   Property 10: Other hazards stay fatal during grace — a DIFFERENT pair stays
//                fatal while pair A is under grace, and Ground/Ceiling are fatal
//                even with a shield available.
//   Property 11: Ground and Ceiling are always fatal — fatal for ANY shield
//                count (groundCeilingFatal ignores shields entirely).
//   Property 12: Cosmetics and scale never change the Hitbox — hitboxFor returns
//                identical {x,y,w,h} regardless of hats, spirit decoration,
//                sprite margins, or display scale carried on the ghost object.
//   Property 13: No tunneling at any scroll speed — the swept check reports a
//                pair crossed within a single step, even for a step whose END
//                position is already past the pair (a naive end-only test would
//                tunnel through it).
//
// Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9, 3.10
// Design: Testing Strategy (mandatory critical subset)
//
// Coordinate reminders (see src/systems/collision.js):
//   - Ghosty x/y are CENTER coords; the Hitbox is 24×31 centered on them.
//   - A pair occupies [x, x+pipe.width] horizontally; its Gap spans
//     [gapCenter ± gapHeight/2]; solid is everything outside the gap.
//   - The Hitbox is SAFE on a pair only if it lies fully inside the gap.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import {
  hitboxFor,
  sweptHitboxVsPipes,
  groundCeilingFatal,
} from "../src/systems/collision.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

const PIPE_WIDTH = CONFIG.pipe.width; // 70
const GAP_HEIGHT = CONFIG.pipe.gapHeight; // 180
const PLAYFIELD_H = CONFIG.playfield.height; // 640
const HITBOX_W = CONFIG.ghosty.hitboxWidth; // 24
const HITBOX_H = CONFIG.ghosty.hitboxHeight; // 31
const SCROLL_MAX = CONFIG.scroll.max; // 220

// Build a hitbox {x,y,w,h} directly from a top-left corner, using the derived
// hitbox size. Keeps the geometry explicit in tests.
function boxAt(x, y) {
  return { x, y, w: HITBOX_W, h: HITBOX_H };
}

// A pair placed so that a hitbox at vertical top-left `boxTopY` hits a SOLID
// part (i.e. the hitbox is NOT inside the gap). We put the gap far from the
// hitbox's vertical band so any horizontal overlap is a solid contact.
function solidPairAt(id, leftX, gapCenter) {
  return { id, x: leftX, gapCenter, gapHeight: GAP_HEIGHT };
}

// --- Property 8: Fatal unshielded pipe contact -------------------------------

test(propertyName(8, "Fatal unshielded pipe contact"), () => {
  assertProperty(
    fc.property(
      // Hitbox center x somewhere on the screen.
      fc.double({ min: 100, max: 860, noNaN: true }),
      // Vertical band for the hitbox top-left.
      fc.double({ min: 60, max: PLAYFIELD_H - 60 - HITBOX_H, noNaN: true }),
      (centerX, boxTopY) => {
        const box = boxAt(centerX - HITBOX_W / 2, boxTopY);

        // Place the pair's left edge so the hitbox horizontally overlaps it:
        // put the pipe left edge at the hitbox center.
        const pairX = centerX;

        // Force a SOLID (non-gap) vertical overlap by putting the gap entirely
        // ABOVE the hitbox: gapCenter chosen so gapBottom < box top. If that is
        // impossible (hitbox too high), put the gap entirely BELOW instead.
        let gapCenter;
        const gapBelowCenter = box.y + box.h + GAP_HEIGHT / 2 + 1;
        const gapAboveCenter = box.y - GAP_HEIGHT / 2 - 1;
        if (gapAboveCenter - GAP_HEIGHT / 2 >= 0) {
          gapCenter = gapAboveCenter;
        } else {
          gapCenter = gapBelowCenter;
        }

        const pair = solidPairAt(1, pairX, gapCenter);

        // Static step (prev == curr), zero shields, no grace → must be fatal.
        const res = sweptHitboxVsPipes(
          box,
          box,
          [pair],
          0, // no shields
          null, // no grace
          CONFIG,
        );
        assert.equal(res.outcome, "fatal", "unshielded solid contact must be fatal");
        assert.equal(res.pipeId, 1);
        return true;
      },
    ),
  );
});

// --- Property 9: Shield consumption and same-pipe grace ----------------------

test(propertyName(9, "Shield consumption and same-pipe grace"), () => {
  assertProperty(
    fc.property(
      fc.double({ min: 100, max: 860, noNaN: true }),
      fc.double({ min: 60, max: PLAYFIELD_H - 60 - HITBOX_H, noNaN: true }),
      (centerX, boxTopY) => {
        const box = boxAt(centerX - HITBOX_W / 2, boxTopY);
        const pairX = centerX;
        // Gap entirely above the hitbox (or below if impossible) → solid contact.
        let gapCenter = box.y - GAP_HEIGHT / 2 - 1;
        if (gapCenter - GAP_HEIGHT / 2 < 0) {
          gapCenter = box.y + box.h + GAP_HEIGHT / 2 + 1;
        }
        const pair = solidPairAt(7, pairX, gapCenter);

        // (a) Overlap WITH a shield charge, no grace yet → 'shield' on this pair.
        const consumed = sweptHitboxVsPipes(box, box, [pair], 1, null, CONFIG);
        assert.equal(consumed.outcome, "shield", "a charged overlap must be 'shield'");
        assert.equal(consumed.pipeId, 7, "shield outcome names the overlapped pair");

        // (b) Same pair now under grace, zero charges left → non-fatal ('none')
        //     while the hitbox still overlaps it.
        const underGrace = sweptHitboxVsPipes(box, box, [pair], 0, 7, CONFIG);
        assert.equal(
          underGrace.outcome,
          "none",
          "the grace pair must be non-fatal even with no charges left",
        );
        // Still overlapping → grace must NOT end yet.
        assert.equal(
          underGrace.clearedGraceId,
          null,
          "grace must not clear while the hitbox still overlaps the pair",
        );

        // (c) Move the hitbox fully past the pair horizontally (end position is
        //     entirely to the RIGHT of [x, x+width]). Grace ends this step.
        const clearedBoxX = pair.x + PIPE_WIDTH + 1; // left edge just past trailing edge
        const clearedBox = boxAt(clearedBoxX, box.y);
        const afterClear = sweptHitboxVsPipes(
          box, // start still overlapping
          clearedBox, // end fully cleared
          [pair],
          0,
          7,
          CONFIG,
        );
        assert.equal(
          afterClear.clearedGraceId,
          7,
          "grace must end once the hitbox fully clears the pair",
        );
        // The pass across the pair under grace is still non-fatal.
        assert.equal(afterClear.outcome, "none");
        return true;
      },
    ),
  );
});

// --- Property 10: Other hazards stay fatal during grace ----------------------

test(propertyName(10, "Other hazards stay fatal during grace"), () => {
  assertProperty(
    fc.property(
      fc.double({ min: 150, max: 820, noNaN: true }),
      fc.double({ min: 60, max: PLAYFIELD_H - 60 - HITBOX_H, noNaN: true }),
      (centerX, boxTopY) => {
        const box = boxAt(centerX - HITBOX_W / 2, boxTopY);

        // Gap above the hitbox → solid contact for any overlapped pair.
        let gapCenter = box.y - GAP_HEIGHT / 2 - 1;
        if (gapCenter - GAP_HEIGHT / 2 < 0) {
          gapCenter = box.y + box.h + GAP_HEIGHT / 2 + 1;
        }

        // Pair A is the grace pair; pair B is a DIFFERENT pair at the same spot
        // the hitbox overlaps. B must stay fatal despite A's grace.
        const pairA = solidPairAt(1, centerX, gapCenter);
        const pairB = solidPairAt(2, centerX, gapCenter);

        // graceId = A (id 1); zero shields; the hitbox overlaps B (id 2) solidly.
        const res = sweptHitboxVsPipes(
          box,
          box,
          [pairB], // only B present in the step (A's grace must not excuse B)
          0,
          1, // grace is on pair A's id
          CONFIG,
        );
        assert.equal(
          res.outcome,
          "fatal",
          "a different pair stays fatal while another pair is under grace",
        );
        assert.equal(res.pipeId, 2);

        // Ground and Ceiling remain fatal even WITH a shield available.
        const ceilingBox = boxAt(centerX - HITBOX_W / 2, -1); // over the ceiling
        const groundBox = boxAt(
          centerX - HITBOX_W / 2,
          PLAYFIELD_H - HITBOX_H + 1,
        ); // over the ground
        assert.equal(
          groundCeilingFatal(ceilingBox, CONFIG),
          true,
          "ceiling is fatal even during grace / with a shield",
        );
        assert.equal(
          groundCeilingFatal(groundBox, CONFIG),
          true,
          "ground is fatal even during grace / with a shield",
        );
        return true;
      },
    ),
  );
});

// --- Property 11: Ground and Ceiling are always fatal ------------------------

test(propertyName(11, "Ground and Ceiling are always fatal"), () => {
  assertProperty(
    fc.property(
      // ANY shield count, including large values.
      fc.integer({ min: 0, max: 1000 }),
      fc.double({ min: 0, max: 960, noNaN: true }),
      (shieldCount, boxX) => {
        // A box poking over the ceiling (top-left y < 0) is fatal.
        const ceilingBox = boxAt(boxX, -0.5);
        // A box reaching the ground (y + h >= height) is fatal.
        const groundBox = boxAt(boxX, PLAYFIELD_H - HITBOX_H + 0.5);
        // Exactly touching the ceiling (y = 0) and ground (y+h = height) counts.
        const touchCeiling = boxAt(boxX, 0);
        const touchGround = boxAt(boxX, PLAYFIELD_H - HITBOX_H);

        // groundCeilingFatal ignores shields entirely; shieldCount is unused by
        // it, which is exactly the invariant: no shield count makes it safe.
        void shieldCount;
        assert.equal(groundCeilingFatal(ceilingBox, CONFIG), true);
        assert.equal(groundCeilingFatal(groundBox, CONFIG), true);
        assert.equal(groundCeilingFatal(touchCeiling, CONFIG), true);
        assert.equal(groundCeilingFatal(touchGround, CONFIG), true);

        // A box well within bounds is NOT fatal (sanity: the check isn't trivially true).
        const safe = boxAt(boxX, PLAYFIELD_H / 2 - HITBOX_H / 2);
        assert.equal(groundCeilingFatal(safe, CONFIG), false);
        return true;
      },
    ),
  );
});

// --- Property 12: Cosmetics and scale never change the Hitbox ----------------

test(propertyName(12, "Cosmetics and scale never change the Hitbox"), () => {
  assertProperty(
    fc.property(
      fc.double({ min: -500, max: 1500, noNaN: true }),
      fc.double({ min: -500, max: 1500, noNaN: true }),
      // Arbitrary cosmetic/scale fields that must NOT affect the hitbox.
      fc.record({
        hat: fc.constantFrom("witchHat", "pumpkinCap", "batBonnet", null),
        spiritDecoration: fc.constantFrom("storm_bat", "pumpkin_guardian", null),
        displayScale: fc.double({ min: 0.1, max: 8, noNaN: true }),
        spriteMarginX: fc.double({ min: 0, max: 200, noNaN: true }),
        spriteMarginY: fc.double({ min: 0, max: 200, noNaN: true }),
        naturalPngWidth: fc.integer({ min: 1, max: 4096 }),
        naturalPngHeight: fc.integer({ min: 1, max: 4096 }),
        particles: fc.integer({ min: 0, max: 500 }),
      }),
      (x, y, extras) => {
        // Baseline: only center coords.
        const baseline = hitboxFor({ x, y }, CONFIG);

        // Same center, but carrying every cosmetic/scale field imaginable.
        const decorated = hitboxFor({ x, y, ...extras }, CONFIG);

        assert.deepEqual(
          decorated,
          baseline,
          "cosmetics / scale / sprite margins must not change the hitbox",
        );
        // And the dimensions are exactly the derived 24×31, never the PNG size.
        assert.equal(decorated.w, HITBOX_W);
        assert.equal(decorated.h, HITBOX_H);
        return true;
      },
    ),
  );
});

// --- Property 13: No tunneling at any scroll speed ---------------------------

test(propertyName(13, "No tunneling at any scroll speed"), () => {
  assertProperty(
    fc.property(
      // Vertical band kept clear of ground/ceiling so only the pipe matters.
      fc.double({ min: 80, max: PLAYFIELD_H - 80 - HITBOX_H, noNaN: true }),
      // How far the relative motion carries across the step, up to a generous
      // multiple of the max scroll speed's per-step travel (well past a pipe).
      fc.double({ min: PIPE_WIDTH + HITBOX_W + 2, max: 2000, noNaN: true }),
      // Shield availability drives whether the reported outcome is shield/fatal.
      fc.boolean(),
      // Split the relative motion between Ghosty's own dx and pipe scroll.
      fc.double({ min: 0, max: 1, noNaN: true }),
      (boxTopY, travel, hasShield, scrollFraction) => {
        // Gap placed above the hitbox band → a solid contact whenever overlapped.
        let gapCenter = boxTopY - GAP_HEIGHT / 2 - 1;
        if (gapCenter - GAP_HEIGHT / 2 < 0) {
          gapCenter = boxTopY + HITBOX_H + GAP_HEIGHT / 2 + 1;
        }

        // Pair ends the step at committed left edge = pairEndX.
        const pairEndX = 300;
        const pair = solidPairAt(42, pairEndX, gapCenter);

        // The pipe scrolls LEFT by `scrollDistance` during the step, and Ghosty
        // moves RIGHT by `dxBox`. Their relative closing distance is `travel`.
        // Cap scroll travel at a realistic max-speed-per-step scale but allow
        // Ghosty's own dx to make up the rest for large synthetic steps.
        const maxScrollTravel = SCROLL_MAX * 0.1; // ~ max speed × a long 100ms step
        const scrollDistance = Math.min(travel * scrollFraction, maxScrollTravel);
        const dxBox = travel - scrollDistance;

        // Construct prev/curr so the hitbox STARTS left of the pair's start-of-
        // step position and ENDS right of the pair's end-of-step position — a
        // full crossing that a naive end-only overlap test would miss.
        // Pair start-of-step left edge = pairEndX + scrollDistance.
        const pairStartX = pairEndX + scrollDistance;
        // Start the hitbox fully left of the pair's start span.
        const prevBoxX = pairStartX - HITBOX_W - 1;
        const currBoxX = prevBoxX + dxBox;
        const prevBox = boxAt(prevBoxX, boxTopY);
        const currBox = boxAt(currBoxX, boxTopY);

        // Sanity for the test construction: the END must be fully past the pair,
        // so a naive end-only check genuinely would NOT detect it.
        const endOverlapsEnd =
          currBox.x <= pair.x + PIPE_WIDTH && currBox.x + currBox.w >= pair.x;

        const res = sweptHitboxVsPipes(
          prevBox,
          currBox,
          [pair],
          hasShield ? 1 : 0,
          null,
          CONFIG,
          { scrollDistance },
        );

        // The swept check must detect the crossing regardless of end position.
        const expected = hasShield ? "shield" : "fatal";
        assert.equal(
          res.outcome,
          expected,
          `no tunneling: expected ${expected} (endOverlapsEnd=${endOverlapsEnd}, ` +
            `dx=${dxBox}, scroll=${scrollDistance})`,
        );
        assert.equal(res.pipeId, 42);
        return true;
      },
    ),
  );
});
