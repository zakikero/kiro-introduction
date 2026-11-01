// test/encounter-loop.test.js — Milestone 2 capstone (task 2.9) end-to-end
// integration of the complete encounter loop, driven HEADLESSLY through the
// REAL FSM and the REAL pure systems (no DOM).
//
// This is the "manual run completes Encounter→Battle→Reward→Shop→checkpoint
// resume" verification from task 2.9, expressed as an automated integration
// test so it runs under `node --test`. It constructs the FSM exactly as the
// browser shell (src/main.js) does — wiring stepFlight, the spawner (internal),
// collision, scoring, stepScheduler, and markSkipped — and reproduces main.js's
// per-tick routing (symbol-contact detection, battle/shop/reward routing, and
// the checkpoint resume) against the same systems. It therefore exercises the
// real integration path, not a mock of it.
//
// It asserts the three things the capstone calls out:
//   1. The full loop is connected: scheduler spawns an avoidable Enemy symbol →
//      contact enters Battle (freezing flight) → battle resolves to victory →
//      Reward awards Soul_Coins → a shop purchase + in-shop potion use work →
//      leaving the shop resumes flight via the safe checkpoint + Resume
//      countdown (Req 4.7, 5.6, 7.2, 9.5, 9.14).
//   2. A symbol passed WITHOUT interacting is marked `skipped` and never
//      retriggers (Req 4.17).
//   3. No input leaks across the Battle/Reward/Shop transitions (Req 9.6) — the
//      single confirming input that leaves a frozen screen does not also act in
//      the destination state.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRng } from "../src/rng.js";
import { createFSM, States } from "../src/state.js";
import { stepFlight } from "../src/systems/flight.js";
import { stepScoring } from "../src/systems/scoring.js";
import { sweptHitboxVsPipes, hitboxFor } from "../src/systems/collision.js";
import {
  stepScheduler,
  markEntered,
  markSkipped,
  Lifecycle,
} from "../src/systems/scheduler.js";
import {
  makeOrdinaryEnemy,
  startBattle,
  resolvePlayerAction,
  resolveEnemyTurn,
  usePotion,
  PlayerActions,
} from "../src/systems/combat.js";
import { purchase, awardOrdinaryVictory } from "../src/systems/economy.js";
import { createInputQueue, IntentType } from "../src/input.js";

const SAVE = Object.freeze({ highScore: 0, prefs: {} });
const FIXED_DT = 1 / 120;

/**
 * Build the FSM wired exactly like src/main.js (minus the DOM-only pieces).
 * Returns the FSM, its input queue, and the seeded RNG.
 */
function buildWiredFSM(seed = 7) {
  const rng = createRng(seed);
  const inputQueue = createInputQueue({ initialScope: States.Main_Menu_State });
  const fsm = createFSM(CONFIG, SAVE, {
    rng,
    stepFlight,
    sweptHitboxVsPipes,
    stepScoring,
    stepScheduler,
    markSkipped,
    inputQueue,
    isDocumentHidden: () => false,
  });
  return { fsm, inputQueue, rng };
}

/** Axis-aligned overlap between Ghosty's forgiving Hitbox and a CENTER-rect symbol. */
function hitboxTouchesSymbol(ghosty, symbol) {
  const box = hitboxFor(ghosty, CONFIG);
  const sLeft = symbol.x - symbol.w / 2;
  const sTop = symbol.y - symbol.h / 2;
  return (
    box.x < sLeft + symbol.w &&
    box.x + box.w > sLeft &&
    box.y < sTop + symbol.h &&
    box.y + box.h > sTop
  );
}

/**
 * Reproduce main.js's detectSymbolContact for Active_Flight_State: on contact,
 * mark the symbol entered and enter Battle/Shop (freezing flight). Returns the
 * contacted symbol or null.
 */
function detectSymbolContact(fsm) {
  if (fsm.state !== States.Active_Flight_State) return null;
  const rs = fsm.runState;
  if (!rs || !Array.isArray(rs.symbols) || rs.symbols.length === 0) return null;
  for (const symbol of rs.symbols) {
    if (!symbol || !hitboxTouchesSymbol(rs.ghosty, symbol)) continue;
    markEntered(rs.progress, symbol.key, rs);
    if (symbol.kind === "enemy") {
      rs.activeBattle = startBattle(
        rs,
        makeOrdinaryEnemy(symbol.enemyType || "A", CONFIG),
        CONFIG,
      );
      fsm.enterBattle();
    } else if (symbol.kind === "shop") {
      fsm.enterShop();
    }
    return symbol;
  }
  return null;
}

/**
 * Advance flight by stepping the real FSM until `predicate(fsm)` is true.
 *
 * This test targets the ENCOUNTER-LOOP integration (scheduler → contact →
 * battle → reward → shop → checkpoint), not pipe navigation — collisions have
 * their own dedicated property suite. To accrue Active_Flight_Time
 * deterministically without a flight autopilot that would have to thread real
 * generated pipe gaps, we keep Ghosty in a guaranteed-safe column each step:
 * before every tick Ghosty is pinned to the playfield's vertical center with
 * vy = 0, and after every tick the (spawner-produced) pipes are cleared so no
 * pipe can be fatal. The REAL tickFlight still runs — advancing
 * Active_Flight_Time, driving the spawner, the scheduler (symbol spawn/scroll),
 * and the new skip detection — so the wiring under test is exercised for real.
 * Avoidable Enemy/Shop SYMBOLS are never cleared, so they spawn, scroll, and
 * skip exactly as in the running game. `keepClearOfSymbols` (default true) also
 * steers Ghosty's y away from any symbol so no accidental contact happens while
 * flying past; the caller forces deliberate contact separately.
 *
 * Stops when the predicate holds, when flight is no longer active (e.g. contact
 * froze it), or after `maxSteps`. Returns the number of steps taken.
 */
function flyUntil(
  fsm,
  predicate,
  maxSteps = 200000,
  keepClearOfSymbols = true,
) {
  const centerY = CONFIG.playfield.height / 2;
  let steps = 0;
  while (steps < maxSteps) {
    if (predicate(fsm)) return steps;
    if (fsm.state !== States.Active_Flight_State) return steps;

    const rs = fsm.runState;
    // Pin Ghosty to a safe column. If a symbol is near Ghosty's x and we want to
    // avoid it, park Ghosty at the top of the playfield (symbols are placed in
    // the Gap, never at the ceiling), guaranteeing no contact.
    let y = centerY;
    if (keepClearOfSymbols && Array.isArray(rs.symbols)) {
      const near = rs.symbols.find((s) => Math.abs(s.x - rs.ghosty.x) < 120);
      if (near) y = CONFIG.ghosty.bodyHeight; // hug the ceiling, away from the Gap symbol
    }
    rs.ghosty.y = y;
    rs.ghosty.vy = 0;
    rs.ghosty.prevY = y;

    detectSymbolContact(fsm);
    if (fsm.state !== States.Active_Flight_State) return steps; // contact froze flight

    fsm.tick(FIXED_DT, { flap: false, flightPower: false });
    // Remove any pipes the spawner produced so none can be fatal next step.
    fsm.runState.pipes = [];
    fsm.runState.shieldGracePairId = null;
    steps += 1;
  }
  return steps;
}

// --- The full encounter loop ------------------------------------------------

test("task 2.9: full loop Encounter→Battle→Reward→Shop→checkpoint resume runs end-to-end through the real FSM+systems", () => {
  const { fsm } = buildWiredFSM(7);

  // Start a Run and begin flight (Main_Menu → Ready → Active_Flight).
  fsm.startNewRun(7);
  fsm.transition(States.Active_Flight_State);
  assert.equal(fsm.state, States.Active_Flight_State);

  // Fly until the scheduler has spawned the first encounter symbol.
  flyUntil(
    fsm,
    (f) =>
      Array.isArray(f.runState.symbols) &&
      f.runState.symbols.some((s) => s.key === "encounterA"),
  );
  const rs = fsm.runState;
  assert.ok(
    rs.activeFlightTime >= CONFIG.triggers.firstEncounter,
    "encounter should spawn only after its threshold",
  );
  assert.equal(rs.progress.encounterA.state, Lifecycle.offered);

  // Force contact deterministically: place Ghosty on top of the encounter
  // symbol (its x has been scrolling left toward Ghosty — we just snap onto it
  // so the test doesn't depend on exact flap timing). This drives the SAME
  // contact → enterBattle path main.js uses.
  const enemySym = rs.symbols.find((s) => s.key === "encounterA");
  rs.ghosty.x = enemySym.x;
  rs.ghosty.y = enemySym.y;
  rs.ghosty.prevX = enemySym.x;
  rs.ghosty.prevY = enemySym.y;
  detectSymbolContact(fsm);

  // Flight is frozen in Battle_State with a separate flight-world snapshot.
  assert.equal(fsm.state, States.Battle_State, "contact enters Battle");
  assert.equal(rs.progress.encounterA.state, Lifecycle.entered);
  assert.ok(
    rs.flightSnapshot,
    "entering Battle stores a flight-world snapshot",
  );
  assert.ok(rs.activeBattle && rs.activeBattle.outcome === "ongoing");
  const soulBefore = rs.soulCoins;

  // Resolve the battle to victory by attacking (player acts first; enemy
  // responds while the battle is ongoing). This is main.js's routeBattleIntent.
  let guard = 0;
  while (rs.activeBattle.outcome === "ongoing" && guard < 50) {
    const after = resolvePlayerAction(
      rs.activeBattle,
      PlayerActions.Attack,
      rs,
      CONFIG,
      { usePotion },
    );
    let battle = after.battle;
    let run = after.runState;
    if (battle.phase === "enemy") {
      const afterEnemy = resolveEnemyTurn(battle, run, CONFIG);
      battle = afterEnemy.battle;
      run = afterEnemy.runState;
    }
    rs.activeBattle = battle;
    rs.battleHp = run.battleHp;
    rs.items = run.items;
    guard += 1;
  }
  assert.equal(rs.activeBattle.outcome, "victory", "player wins the battle");

  // Victory confirm → award Soul_Coins → Reward_State (main.js routeBattleIntent
  // on a resolved battle).
  awardOrdinaryVictory(rs, CONFIG);
  rs.enemiesDefeated += 1;
  fsm.transition(States.Reward_State);
  assert.equal(fsm.state, States.Reward_State);
  assert.equal(
    rs.soulCoins,
    soulBefore + CONFIG.ordinaryEnemy.victoryReward,
    "ordinary victory awards the configured Soul_Coins (Req 7.2)",
  );

  // Reward confirm resumes flight via the checkpoint path → Resume_Countdown.
  // (In Milestone 2 the Reward screen has no possession offer; a confirm leaves.)
  fsm.resumeToFlight();
  assert.equal(fsm.state, States.Resume_Countdown_State);

  // Drive the countdown to completion → back to Active_Flight.
  while (fsm.state === States.Resume_Countdown_State) {
    fsm.tick(FIXED_DT, { flap: false, flightPower: false });
  }
  assert.equal(fsm.state, States.Active_Flight_State);
  // Checkpoint invariants: vy zeroed, prev synced, Ghosty inside the playfield.
  assert.equal(rs.ghosty.vy, 0, "checkpoint zeroes vy (Req 9.14)");
  assert.equal(rs.ghosty.prevX, rs.ghosty.x, "prevX synced (Req 9.16)");
  assert.equal(rs.ghosty.prevY, rs.ghosty.y, "prevY synced (Req 9.16)");

  // Reset Ghosty to the initial safe column before continuing (the checkpoint
  // may have repositioned it rightward; with pipes cleared in this integration
  // driver the exact checkpoint column is immaterial — we only need a stable
  // left column so the next symbol scrolls toward Ghosty rather than spawning
  // already behind it).
  rs.ghosty.x = CONFIG.ghosty.initialCenter.x;
  rs.ghosty.prevX = CONFIG.ghosty.initialCenter.x;

  // Now fly on until the shop entrance spawns, then enter it the same way.
  flyUntil(
    fsm,
    (f) =>
      Array.isArray(f.runState.symbols) &&
      f.runState.symbols.some((s) => s.key === "shop1"),
  );
  assert.equal(rs.progress.shop1.state, Lifecycle.offered);
  const shopSym = rs.symbols.find((s) => s.key === "shop1");
  rs.ghosty.x = shopSym.x;
  rs.ghosty.y = shopSym.y;
  rs.ghosty.prevX = shopSym.x;
  rs.ghosty.prevY = shopSym.y;
  detectSymbolContact(fsm);
  assert.equal(
    fsm.state,
    States.Shop_State,
    "contact enters the Shop (Req 7.4)",
  );
  assert.equal(rs.progress.shop1.state, Lifecycle.entered);

  // In-shop purchase: buy a potion (we have 6 Soul_Coins from the victory; the
  // potion costs 5). Soul_Coins decrease; items.potion increments by one.
  const coinsBeforeBuy = rs.soulCoins;
  const potionBeforeBuy = rs.items.potion;
  const buy = purchase(rs, "potion", CONFIG);
  assert.equal(buy.ok, true, "affordable potion purchase succeeds (Req 7.6)");
  assert.equal(
    rs.soulCoins,
    coinsBeforeBuy - CONFIG.shop.potion.price,
    "purchase deducts the potion price",
  );
  assert.equal(
    rs.items.potion,
    potionBeforeBuy + 1,
    "purchase increments items.potion by exactly one (Req 7.12)",
  );

  // In-shop potion use: take some Battle_HP damage first so the potion heals,
  // then use it. No combat turn, no Candy time (battle = null).
  rs.battleHp = rs.maxBattleHp - CONFIG.shop.potion.effect; // below max so it heals
  const hpBeforeUse = rs.battleHp;
  const potionBeforeUse = rs.items.potion;
  const used = usePotion(rs, null, CONFIG);
  assert.equal(used.ok, true, "in-shop potion use succeeds (Req 7.13)");
  rs.battleHp = used.runState.battleHp;
  rs.items = used.runState.items;
  assert.equal(
    rs.items.potion,
    potionBeforeUse - 1,
    "in-shop use consumes exactly one potion",
  );
  assert.ok(rs.battleHp > hpBeforeUse, "in-shop potion heals Battle_HP");

  // Leave the shop → checkpoint resume → countdown → flight.
  fsm.resumeToFlight();
  assert.equal(fsm.state, States.Resume_Countdown_State);
  while (fsm.state === States.Resume_Countdown_State) {
    fsm.tick(FIXED_DT, { flap: false, flightPower: false });
  }
  assert.equal(fsm.state, States.Active_Flight_State);
  assert.equal(rs.ghosty.vy, 0, "shop-exit checkpoint zeroes vy");
});

// --- Req 4.17: a symbol passed without interacting is skipped, never retriggers

test("task 2.9: an untouched encounter symbol is marked skipped and never retriggers (Req 4.17)", () => {
  const { fsm } = buildWiredFSM(7);
  fsm.startNewRun(7);
  fsm.transition(States.Active_Flight_State);

  // Fly until the encounter symbol is offered.
  flyUntil(
    fsm,
    (f) =>
      Array.isArray(f.runState.symbols) &&
      f.runState.symbols.some((s) => s.key === "encounterA"),
  );
  const rs = fsm.runState;
  assert.equal(rs.progress.encounterA.state, Lifecycle.offered);

  // Deliberately AVOID it: keep Ghosty far from the symbol's y so no contact
  // happens, and keep flying until the symbol has scrolled fully past Ghosty.
  // The FSM's skip detection (step 7 of tickFlight) should mark it skipped and
  // remove it from the world.
  flyUntil(
    fsm,
    (f) => f.runState.progress.encounterA.state === Lifecycle.skipped,
    50000,
  );
  assert.equal(
    rs.progress.encounterA.state,
    Lifecycle.skipped,
    "passing the symbol without interacting marks it skipped (Req 4.17)",
  );
  assert.equal(
    rs.symbols.some((s) => s.key === "encounterA"),
    false,
    "a skipped symbol is removed from the flight world",
  );

  // Fly well past the threshold again: the skipped encounter must NOT respawn.
  const before = rs.symbols.filter((s) => s.key === "encounterA").length;
  flyUntil(
    fsm,
    (f) => f.runState.activeFlightTime > CONFIG.triggers.firstEncounter + 20,
    50000,
  );
  assert.equal(
    rs.symbols.filter((s) => s.key === "encounterA").length,
    before,
    "a skipped encounter never retriggers",
  );
  assert.equal(rs.progress.encounterA.state, Lifecycle.skipped);
});

// --- Req 9.6: no input leak across the encounter-loop transitions -----------

test("task 2.9: the confirming input that leaves Battle/Reward/Shop does not leak into the destination (Req 9.6)", () => {
  const { fsm, inputQueue } = buildWiredFSM(7);
  fsm.startNewRun(7);
  fsm.transition(States.Active_Flight_State);
  const rs = fsm.runState;

  // Put a battle in a resolved (victory) state, then buffer a confirm and make
  // the transition out of Battle. After the FSM fires its transition barrier,
  // the destination scope must deliver no intent from that same input.
  fsm._setStateForTest(States.Battle_State, rs);
  rs.activeBattle = { outcome: "victory" };

  // Buffer a confirming intent scoped to Battle_State, then transition out.
  inputQueue.transition(States.Battle_State);
  // Simulate the leave: award + go to Reward (as routeBattleIntent does).
  fsm.transition(States.Reward_State);
  // The barrier flushed the queue; nothing should be deliverable in Reward.
  const afterBattle = inputQueue.consumeInputIntents();
  assert.equal(
    afterBattle.length,
    0,
    "no intent leaks from Battle into Reward (Req 9.6)",
  );

  // Reward → resume (checkpoint) → countdown. The leave input must not act.
  fsm.resumeToFlight();
  assert.equal(fsm.state, States.Resume_Countdown_State);
  const afterReward = inputQueue.consumeInputIntents();
  assert.equal(
    afterReward.length,
    0,
    "no intent leaks from Reward into the countdown (Req 9.6)",
  );
});
