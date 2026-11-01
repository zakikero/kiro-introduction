// test/checkpoint.test.js — Property 31 (mandatory critical subset) plus the
// two example tests for task 2.8: safe checkpoint resumption and no input leak.
//
// Property 31 (design.md Testing Strategy; Requirements 9.14, 9.15, 9.16): for
// ANY resumable Run state, the checkpoint selected by the Battle/Reward/Shop-exit
// path must
//   - center Ghosty vertically in a valid Gap,
//   - leave a Hitbox that clears every nearby obstacle, the Ground, and the
//     Ceiling (Req 9.15 verification),
//   - set vy = 0 (Req 9.14),
//   - award NO Pipe_Score for any pair Ghosty has not actually passed, never
//     flipping a pair's `scored` flag (Req 9.16),
//   - and synchronize prevX/prevY with the new current position so render
//     interpolation produces no artifact or false pass (Req 9.16).
//
// We drive `resumeFromCheckpoint` (the single mutating entry point) directly on
// a fc-generated RunState so the property covers the full input space of Ghosty
// positions and pipe layouts — not just the one layout an example fixes. The
// checkpoint module is pure logic (no DOM), so it is exercised headlessly.
//
// The two example tests then pin concrete behaviour the property abstracts over:
//   1. Checkpoint example: a known Gap, resumed via the FSM's real checkpoint
//      path, asserting centering, vy = 0, Hitbox clearance, no unpassed score,
//      and prev/cur sync.
//   2. No-input-leak example: a REAL input queue (input.js) carrying a buffered
//      confirming/dismissing intent across each transition that leaves a frozen
//      screen (pause dismiss, battle/reward/shop exit, results restart); after
//      the FSM fires its transition barrier the destination scope delivers no
//      intent, so the same input cannot also flap, act, or restart (Req 9.6,
//      9.12, 10.7).

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRng } from "../src/rng.js";
import { createFSM, States } from "../src/state.js";
import {
  resumeFromCheckpoint,
  hitboxClears,
} from "../src/systems/checkpoint.js";
import { hitboxFor, groundCeilingFatal } from "../src/systems/collision.js";
import { createInputQueue, IntentType } from "../src/input.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

// Minimal SaveData stand-in: the FSM only reads prefs/high-score elsewhere and
// never mutates it on the checkpoint path, so an empty object suffices.
const SAVE = Object.freeze({ highScore: 0 });

// --- Property 31 ------------------------------------------------------------

/**
 * A Gap that always fits inside the playfield with the configured min clearance
 * from Ground and Ceiling (so centering in it genuinely clears both). The gap
 * height is fixed by config; only the center varies, constrained to the band
 * the spawner itself would produce.
 */
const gapCenterArb = fc.double({
  min: CONFIG.pipe.minClearance + CONFIG.pipe.gapHeight / 2,
  max:
    CONFIG.playfield.height -
    CONFIG.pipe.minClearance -
    CONFIG.pipe.gapHeight / 2,
  noNaN: true,
});

/**
 * A realistic pipe set: pairs are laid out left-to-right at least
 * `CONFIG.pipe.spacing` apart, exactly as the spawner produces them, so no two
 * pairs ever share a horizontal span. This matches the spawner's own invariant
 * (systems/spawner.js) — a free-floating x per pair would let two pairs with
 * DIFFERENT Gaps overlap the same Hitbox column, a layout the game can never
 * create and for which "center in one Gap" is not even well defined. We model
 * the honest input space here rather than fabricate impossible overlaps.
 *
 * Each pair gets a valid Gap center and starts UNpassed (scored = false) so the
 * property can prove repositioning never flips an unpassed pair to scored.
 */
const pipeSetArb = fc
  .record({
    // The left edge of the first pair, anywhere from off-screen-left to the
    // right edge of the playfield.
    firstX: fc.double({
      min: -CONFIG.pipe.width,
      max: CONFIG.playfield.width,
      noNaN: true,
    }),
    // Per-pair extra spacing ON TOP of the minimum, keeping pairs well separated.
    gaps: fc.array(
      fc.record({
        extra: fc.double({ min: 0, max: 300, noNaN: true }),
        gapCenter: gapCenterArb,
      }),
      { minLength: 0, maxLength: 6 },
    ),
  })
  .map(({ firstX, gaps }) => {
    let x = firstX;
    return gaps.map((g, i) => {
      if (i > 0) x += CONFIG.pipe.spacing + g.extra;
      return {
        id: i + 1,
        x,
        gapCenter: g.gapCenter,
        gapHeight: CONFIG.pipe.gapHeight,
        scored: false,
        shieldGrace: false,
      };
    });
  });

/** The pairs Ghosty is still APPROACHING — those at/ahead of his center x. */
function upcomingPairs(ghostyX, pipes) {
  return pipes.filter((p) => p.x >= ghostyX);
}

test(
  propertyName(31, "Checkpoint resumption is safe and scores nothing unpassed"),
  () => {
    assertProperty(
      fc.property(
        // Ghosty's CENTER coordinates and a non-zero vy (checkpoint must zero it).
        fc.double({ min: 0, max: CONFIG.playfield.width, noNaN: true }),
        fc.double({ min: 0, max: CONFIG.playfield.height, noNaN: true }),
        fc.double({
          min: -CONFIG.terminalVelocity,
          max: CONFIG.terminalVelocity,
          noNaN: true,
        }),
        // A realistic, non-overlapping pipe set (0..6 pairs) with valid Gaps.
        pipeSetArb,
        // A starting Pipe_Score to prove the checkpoint never changes it.
        fc.integer({ min: 0, max: 50 }),
        (gx, gy, vy, pipes, startingScore) => {
          const runState = {
            pipeScore: startingScore,
            ghosty: {
              x: gx,
              y: gy,
              vy,
              // Stale prev positions far from the current spot: the checkpoint
              // must overwrite these so no phantom sweep remains.
              prevX: gx - 123,
              prevY: gy + 77,
            },
            pipes,
          };

          // A record of each pair's scored flag BEFORE repositioning so we can
          // prove no UNpassed pair was flipped to scored.
          const scoredBefore = pipes.map((p) => !!p.scored);

          const cp = resumeFromCheckpoint(runState, CONFIG);

          // (a) vy = 0 (Req 9.14).
          assert.equal(runState.ghosty.vy, 0, "checkpoint must zero vy");
          assert.equal(cp.vy, 0, "returned checkpoint carries vy = 0");

          // (b) Ghosty moved to the returned checkpoint exactly.
          assert.equal(runState.ghosty.x, cp.x);
          assert.equal(runState.ghosty.y, cp.y);

          // (c) prev render positions synced to current (Req 9.16): no artifact.
          assert.equal(runState.ghosty.prevX, runState.ghosty.x);
          assert.equal(runState.ghosty.prevY, runState.ghosty.y);

          // (d) The resulting Hitbox clears Ground, Ceiling, and every nearby
          //     pair's solid parts (Req 9.15). Verify directly on the committed
          //     Hitbox, independent of the module's own helper...
          const box = hitboxFor({ x: cp.x, y: cp.y }, CONFIG);
          assert.equal(
            groundCeilingFatal(box, CONFIG),
            false,
            "checkpoint Hitbox must clear Ground and Ceiling",
          );
          // ...and cross-check the module's verification predicate agrees.
          assert.equal(
            hitboxClears(cp, runState.pipes, CONFIG),
            true,
            "hitboxClears must confirm the checkpoint is safe",
          );

          // (e) Centered vertically in a valid Gap. When Ghosty was placed in
          //     front of / inside a pair, the checkpoint y equals that pair's
          //     gapCenter (clamped only if the Gap sat against a boundary, which
          //     our generators avoid). At minimum, if any pair horizontally
          //     overlaps the Hitbox, the Hitbox must lie fully inside its Gap —
          //     already implied by hitboxClears, asserted again for intent.
          const pipeWidth = CONFIG.pipe.width;
          for (const pair of runState.pipes) {
            const overlapsH =
              box.x <= pair.x + pipeWidth && box.x + box.w >= pair.x;
            if (!overlapsH) continue;
            const half = pair.gapHeight / 2;
            assert.ok(
              box.y >= pair.gapCenter - half &&
                box.y + box.h <= pair.gapCenter + half,
              "Hitbox must sit inside the Gap of any pair it overlaps",
            );
          }

          // (f) No Pipe_Score awarded for unpassed pairs (Req 9.16): the total
          //     score is unchanged and no previously-unpassed pair was flipped.
          assert.equal(
            runState.pipeScore,
            startingScore,
            "checkpoint must not change Pipe_Score",
          );
          runState.pipes.forEach((p, i) => {
            if (!scoredBefore[i]) {
              assert.equal(
                !!p.scored,
                false,
                "an unpassed pair must not be marked scored by repositioning",
              );
            }
          });

          // (g) Sanity: every pair Ghosty is still approaching remains unpassed,
          //     so none of them could have been legitimately scored here.
          for (const p of upcomingPairs(gx, pipes)) {
            assert.equal(!!p.scored, false);
          }

          return true;
        },
      ),
    );
  },
);

// --- Example test: checkpoint resumption with a known Gap -------------------

/** Build an FSM in live flight with a deterministic Ghosty and known pipes. */
function fsmInFlight(seed = 7) {
  const fsm = createFSM(CONFIG, SAVE, { rng: createRng(seed) });
  fsm.startNewRun(seed);
  fsm.transition(States.Active_Flight_State);
  return fsm;
}

test("checkpoint example: resume centers Ghosty in a known Gap, zeroes vy, clears obstacles, scores nothing unpassed, syncs prev (Req 9.14, 9.15, 9.16)", () => {
  const fsm = fsmInFlight();
  const rs = fsm.runState;

  // A known layout: Ghosty approaching a pair whose Gap is centered at 260.
  // Ghosty is BEFORE the pair (x = 300, pair left edge = 520), so the checkpoint
  // falls into the "nearest upcoming pair" branch: center in that Gap, placed
  // with full clearance ahead of the pair.
  const knownGapCenter = 260;
  rs.ghosty = { x: 300, y: 120, vy: -240, prevX: 285, prevY: 150 };
  rs.pipes = [
    {
      id: 1,
      x: 520,
      gapCenter: knownGapCenter,
      gapHeight: CONFIG.pipe.gapHeight,
      scored: false,
      shieldGrace: false,
    },
    {
      id: 2,
      x: 760,
      gapCenter: 300,
      gapHeight: CONFIG.pipe.gapHeight,
      scored: false,
      shieldGrace: false,
    },
  ];
  rs.pipeScore = 4; // pre-existing score that must be preserved exactly
  rs.lastGapCenter = 300;

  // Go through the real exit path: Active_Flight → Battle → resume (checkpoint).
  fsm.enterBattle();
  const ok = fsm.resumeToFlight();
  assert.equal(ok, true);
  assert.equal(
    fsm.state,
    States.Resume_Countdown_State,
    "resume runs the visible countdown first (Req 9.5)",
  );

  // vy zeroed (Req 9.14).
  assert.equal(rs.ghosty.vy, 0);

  // Centered vertically in the known upcoming Gap (Req 9.15).
  assert.equal(
    rs.ghosty.y,
    knownGapCenter,
    "Ghosty centered in the upcoming Gap",
  );

  // Placed with clearance BEFORE the pair so the Hitbox is left of its left edge.
  const box = hitboxFor(rs.ghosty, CONFIG);
  assert.ok(
    box.x + box.w <= rs.pipes[0].x,
    "Hitbox sits fully before the upcoming pair",
  );

  // Hitbox clears Ground, Ceiling, and every nearby obstacle (Req 9.15).
  assert.equal(groundCeilingFatal(box, CONFIG), false, "clears Ground/Ceiling");
  assert.equal(
    hitboxClears({ x: rs.ghosty.x, y: rs.ghosty.y }, rs.pipes, CONFIG),
    true,
    "clears all nearby obstacles",
  );

  // No Pipe_Score awarded for unpassed pairs; score unchanged (Req 9.16).
  assert.equal(rs.pipeScore, 4, "unchanged Pipe_Score");
  assert.equal(rs.pipes[0].scored, false);
  assert.equal(rs.pipes[1].scored, false);

  // prev/cur render positions synced so no false pass / interpolation artifact.
  assert.equal(rs.ghosty.prevX, rs.ghosty.x);
  assert.equal(rs.ghosty.prevY, rs.ghosty.y);
});

test("checkpoint example: when inside a pair's span, Ghosty is centered in THAT pair's Gap at the current x (Req 9.15)", () => {
  const fsm = fsmInFlight(11);
  const rs = fsm.runState;

  // Ghosty's center x (420) lies within pair #1's horizontal span [400, 470].
  const gapCenter = 330;
  rs.ghosty = { x: 420, y: 90, vy: 300, prevX: 405, prevY: 60 };
  rs.pipes = [
    {
      id: 1,
      x: 400,
      gapCenter,
      gapHeight: CONFIG.pipe.gapHeight,
      scored: false,
      shieldGrace: false,
    },
  ];

  fsm.enterShop();
  fsm.resumeToFlight();

  // Case 1 of the algorithm: keep current x, center vertically in THIS Gap.
  assert.equal(rs.ghosty.x, 420, "x preserved when inside a pair's span");
  assert.equal(rs.ghosty.y, gapCenter, "centered in the containing pair's Gap");
  assert.equal(rs.ghosty.vy, 0);
  assert.equal(
    hitboxClears({ x: rs.ghosty.x, y: rs.ghosty.y }, rs.pipes, CONFIG),
    true,
  );
});

// --- Example test: no input leak across transitions (Req 9.6, 9.12, 10.7) ---

test("no-input-leak example: a buffered confirming input does not flap/act/restart in the destination state (Req 9.6, 9.12, 10.7)", () => {
  // A REAL input queue so we exercise the actual transition barrier, not a spy.
  const queue = createInputQueue({ initialScope: States.Main_Menu_State });
  const fsm = createFSM(CONFIG, SAVE, { rng: createRng(5), inputQueue: queue });

  fsm.startNewRun(5);
  queue.setState(States.Ready_State);
  fsm.transition(States.Active_Flight_State);
  queue.setState(States.Active_Flight_State);

  // 1) PAUSE-DISMISS leak (Req 9.12). Pause, then buffer the UI_RESUME intent
  //    that dismisses the pause, then resume. The FSM's barrier must drop that
  //    intent so the destination (Resume_Countdown_State) sees nothing — the
  //    dismiss cannot also register as a flap or flight action.
  fsm.pause();
  queue.setState(States.Pause_State);
  // The player's confirming/dismiss press lands while still in Pause_State.
  queue.registerUiAction(IntentType.UI_RESUME);
  assert.equal(
    queue.pendingCount(),
    1,
    "the dismiss intent is buffered pre-transition",
  );

  fsm.requestResume(); // Pause → Resume_Countdown: fires the barrier
  assert.equal(fsm.state, States.Resume_Countdown_State);
  assert.deepEqual(
    queue.consumeInputIntents(),
    [],
    "pause-dismiss input must not leak into the countdown as a flap/action",
  );

  // 2) BATTLE/SHOP-EXIT leak (Req 9.6). Finish the countdown back to flight,
  //    enter a shop, buffer the confirming "leave shop" input, then resume.
  //    The barrier must again drop it before flight.
  // Drive the countdown to completion.
  let safety = 0;
  while (fsm.state !== States.Active_Flight_State && safety < 1000) {
    fsm.tick(0.1, {});
    safety += 1;
  }
  assert.equal(
    fsm.state,
    States.Active_Flight_State,
    "returned to flight after the countdown",
  );
  queue.setState(States.Active_Flight_State);

  fsm.enterShop();
  queue.setState(States.Shop_State);
  // The confirming input that buys/leaves the shop is pressed in Shop_State.
  queue.registerUiAction(IntentType.UI_CONFIRM);
  assert.equal(queue.pendingCount(), 1);

  fsm.resumeToFlight(); // Shop → Resume_Countdown: barrier flushes
  assert.equal(fsm.state, States.Resume_Countdown_State);
  assert.deepEqual(
    queue.consumeInputIntents(),
    [],
    "shop-exit input must not leak into the destination state",
  );

  // 3) RESULTS-RESTART leak (Req 10.7). The input that caused death / confirmed
  //    the result must not immediately restart. Put the FSM into Results, buffer
  //    a confirming intent, then restart; the barrier drops it so no stray
  //    intent is live in the fresh Ready_State to re-trigger anything.
  fsm._setStateForTest(States.Results_State, fsm.runState);
  queue.setState(States.Results_State);
  queue.registerUiAction(IntentType.UI_CONFIRM); // the "confirm result" press
  assert.equal(queue.pendingCount(), 1);

  fsm.restart(5); // Results → Ready: barrier flushes
  assert.equal(fsm.state, States.Ready_State);
  assert.deepEqual(
    queue.consumeInputIntents(),
    [],
    "death/confirm input must not leak into Ready_State and restart flight",
  );
});

test("no-input-leak example: scoping also drops a straggler intent created in the previous state (Req 9.6)", () => {
  // Even without the explicit flush, an intent tagged with a prior scope is not
  // delivered once the scope moves on — the second guard described in input.js.
  const queue = createInputQueue({ initialScope: States.Shop_State });
  // A confirming input created while in the Shop.
  queue.registerUiAction(IntentType.UI_CONFIRM);
  // Move the scope WITHOUT flushing (setState) to simulate a straggler.
  queue.setState(States.Resume_Countdown_State);
  assert.deepEqual(
    queue.consumeInputIntents(),
    [],
    "an intent from a prior scope is not delivered after the scope changes",
  );
});
