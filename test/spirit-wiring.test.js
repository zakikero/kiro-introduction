// test/spirit-wiring.test.js — Milestone 3 wiring (task 3.6).
//
// Verifies the integration that connects the already-tested pure Spirit systems
// into the running game, driven HEADLESSLY through the REAL FSM and REAL pure
// systems (no DOM), mirroring how src/main.js routes intents. It covers the
// three wiring seams task 3.6 adds:
//
//   1. Reward_State possession offer (Req 6.1, 6.2): after an ordinary victory
//      the offer is built on the Run, and the player's replace/decline choice
//      is applied, then flight resumes via the safe checkpoint path.
//   2. Battle action selection (Req 5.3, 6.7, 6.8): a UI_SELECT intent picks
//      the Nth action from the same battleActions list the scene draws — Attack
//      / Defend / Use Item / the equipped Spirit's move — routed through
//      resolvePlayerAction with PlayerActions.SpiritMove.
//   3. Flight_Power + Hover readiness surfaced on the HUD (Req 1.7, 6.12).
//
// The routing helpers under test live in src/main.js's boot() (DOM-only), so
// this test reproduces that same mapping against the real systems — exactly as
// encounter-loop.test.js reproduces detectSymbolContact — and asserts the pure
// building blocks the wiring composes.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRng } from "../src/rng.js";
import { createFSM, States } from "../src/state.js";
import { stepFlight } from "../src/systems/flight.js";
import { stepScoring } from "../src/systems/scoring.js";
import { sweptHitboxVsPipes } from "../src/systems/collision.js";
import { stepScheduler, markSkipped } from "../src/systems/scheduler.js";
import {
  makeOrdinaryEnemy,
  startBattle,
  resolvePlayerAction,
  resolveEnemyTurn,
  usePotion,
  possessionOffer,
  applyPossessionChoice,
  PlayerActions,
} from "../src/systems/combat.js";
import { awardOrdinaryVictory } from "../src/systems/economy.js";
import { battleActions } from "../src/ui/battle.js";
import { hoverReadiness } from "../src/ui/hud.js";
import {
  createInputQueue,
  IntentType,
  spiritProvidesFlightPower,
} from "../src/input.js";

const SAVE = Object.freeze({ highScore: 0, prefs: {} });
const FIXED_DT = 1 / 120;

function buildWiredFSM(seed = 11) {
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
  return { fsm, inputQueue };
}

/**
 * Reproduce src/main.js's intentToBattleAction: a UI_SELECT picks the Nth
 * action from battleActions (gating an unavailable Spirit move); confirm/flap
 * defaults to Attack.
 */
function intentToBattleAction(intent, runState) {
  if (
    intent.type === IntentType.FLAP ||
    intent.type === IntentType.UI_CONFIRM
  ) {
    return PlayerActions.Attack;
  }
  if (intent.type === IntentType.UI_SELECT) {
    const actions = battleActions(runState);
    const chosen = actions[intent.index];
    if (!chosen) return null;
    if (chosen.id === "spirit") {
      if (chosen.available === false) return null;
      return PlayerActions.SpiritMove;
    }
    if (chosen.id === "attack") return PlayerActions.Attack;
    if (chosen.id === "defend") return PlayerActions.Defend;
    if (chosen.id === "use_item") return PlayerActions.UseItem;
  }
  return null;
}

// --- 1. Reward_State possession offer flow ----------------------------------

test("task 3.6: replacing in Reward possesses the defeated enemy's Spirit, then resumes via checkpoint (Req 6.1, 6.2)", () => {
  const { fsm } = buildWiredFSM();
  fsm.startNewRun(11);
  fsm.transition(States.Active_Flight_State);
  const rs = fsm.runState;
  assert.equal(rs.equippedSpirit, "none", "base Ghosty starts with no spirit");

  // Enter a battle against a type-B enemy (Pumpkin_Guardian reward) and win.
  rs.activeBattle = startBattle(rs, makeOrdinaryEnemy("B", CONFIG), CONFIG);
  fsm.enterBattle();
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
  assert.equal(rs.activeBattle.outcome, "victory");

  // Victory edge (main.js routeBattleIntent): award rewards, build the offer.
  awardOrdinaryVictory(rs, CONFIG);
  rs.pendingOffer = possessionOffer(rs.activeBattle.enemy, rs);
  fsm.transition(States.Reward_State);
  assert.ok(rs.pendingOffer, "an ordinary victory presents a possession offer");
  assert.equal(rs.pendingOffer.offeredSpirit, "pumpkin_guardian");

  // Player chooses REPLACE. Apply the choice and leave (main.js routeRewardIntent).
  const offer = rs.pendingOffer;
  rs.pendingOffer = null;
  applyPossessionChoice(rs, offer, "replace", CONFIG);
  fsm.resumeToFlight();

  assert.equal(
    rs.equippedSpirit,
    "pumpkin_guardian",
    "replace equips the spirit",
  );
  assert.equal(
    rs.shieldCharges,
    1,
    "first Pumpkin_Guardian possession grants its one-time Shield gift (Req 6.8)",
  );
  assert.equal(rs.pendingOffer, null, "offer cleared after the choice");
  assert.equal(
    fsm.state,
    States.Resume_Countdown_State,
    "leaves via checkpoint",
  );
});

test("task 3.6: declining in Reward keeps the current Spirit unchanged (Req 6.2)", () => {
  const { fsm } = buildWiredFSM();
  fsm.startNewRun(11);
  fsm.transition(States.Active_Flight_State);
  const rs = fsm.runState;
  // Already carrying Storm_Bat.
  rs.equippedSpirit = "storm_bat";

  const enemy = makeOrdinaryEnemy("B", CONFIG);
  awardOrdinaryVictory(rs, CONFIG);
  rs.pendingOffer = possessionOffer(enemy, rs);
  fsm._setStateForTest(States.Reward_State, rs);

  const offer = rs.pendingOffer;
  const before = { spirit: rs.equippedSpirit, shields: rs.shieldCharges };
  rs.pendingOffer = null;
  applyPossessionChoice(rs, offer, "decline", CONFIG);

  assert.equal(rs.equippedSpirit, before.spirit, "decline keeps the spirit");
  assert.equal(rs.shieldCharges, before.shields, "decline grants no shield");
});

test("task 3.6: a boss / no-spirit-reward victory presents no offer (Req 6.1)", () => {
  const rs = createFSM(CONFIG, SAVE).createRunState(1);
  assert.equal(possessionOffer({ isBoss: true }, rs), null);
});

// --- 2. Battle action selection via UI_SELECT -------------------------------

test("task 3.6: UI_SELECT picks the Nth battle action, routing the Spirit move (Req 5.3, 6.7)", () => {
  const run = createFSM(CONFIG, SAVE).createRunState(1);
  run.equippedSpirit = "storm_bat"; // actions: Attack, Defend, Use Item, Lightning

  assert.equal(
    intentToBattleAction({ type: IntentType.UI_SELECT, index: 0 }, run),
    PlayerActions.Attack,
  );
  assert.equal(
    intentToBattleAction({ type: IntentType.UI_SELECT, index: 1 }, run),
    PlayerActions.Defend,
  );
  assert.equal(
    intentToBattleAction({ type: IntentType.UI_SELECT, index: 2 }, run),
    PlayerActions.UseItem,
  );
  assert.equal(
    intentToBattleAction({ type: IntentType.UI_SELECT, index: 3 }, run),
    PlayerActions.SpiritMove,
    "the 4th action is the equipped Spirit's move",
  );
  // Confirm defaults to Attack so the battle is always resolvable.
  assert.equal(
    intentToBattleAction({ type: IntentType.UI_CONFIRM }, run),
    PlayerActions.Attack,
  );
});

test("task 3.6: the Storm_Bat Lightning move routed via UI_SELECT deals its configured damage (Req 6.7)", () => {
  const run = createFSM(CONFIG, SAVE).createRunState(1);
  run.equippedSpirit = "storm_bat";
  run.lightningCooldown = 0;
  const battle = startBattle(run, makeOrdinaryEnemy("A", CONFIG), CONFIG);
  const hpBefore = battle.enemy.battleHp;

  const action = intentToBattleAction(
    { type: IntentType.UI_SELECT, index: 3 },
    run,
  );
  const { battle: next, runState: afterRun } = resolvePlayerAction(
    battle,
    action,
    run,
    CONFIG,
  );

  assert.equal(
    next.enemy.battleHp,
    hpBefore - CONFIG.spirits.stormBat.lightningDamage,
    "lightning deals its configured damage",
  );
  assert.equal(
    afterRun.lightningCooldown,
    CONFIG.spirits.stormBat.lightningCooldown,
    "lightning starts its cooldown on the Run",
  );
});

test("task 3.6: selecting Lightning while on cooldown is a no-op (no turn consumed) (Req 5.5)", () => {
  const run = createFSM(CONFIG, SAVE).createRunState(1);
  run.equippedSpirit = "storm_bat";
  run.lightningCooldown = 2; // on cooldown → battleActions marks it unavailable
  const action = intentToBattleAction(
    { type: IntentType.UI_SELECT, index: 3 },
    run,
  );
  assert.equal(action, null, "an unavailable Spirit move maps to no action");
});

test("task 3.6: the Pumpkin_Guardian Fortified Defend is routed and reduces the next hit 75% (Req 6.8)", () => {
  const run = createFSM(CONFIG, SAVE).createRunState(1);
  run.equippedSpirit = "pumpkin_guardian";
  const battle = startBattle(run, makeOrdinaryEnemy("A", CONFIG), CONFIG);

  const action = intentToBattleAction(
    { type: IntentType.UI_SELECT, index: 3 },
    run,
  );
  assert.equal(action, PlayerActions.SpiritMove);
  const { battle: fortified } = resolvePlayerAction(
    battle,
    action,
    run,
    CONFIG,
  );
  assert.equal(fortified.defendActive, true);
  assert.equal(
    fortified.defendPercent,
    CONFIG.spirits.pumpkinGuardian.fortifiedDefendReduction,
  );
});

// --- 3. Flight_Power + Hover readiness on the HUD ---------------------------

test("task 3.6: Flight_Power only fires while a power-providing Spirit is equipped (Req 1.7)", () => {
  assert.equal(spiritProvidesFlightPower("storm_bat"), true);
  assert.equal(spiritProvidesFlightPower("pumpkin_guardian"), false);
  assert.equal(spiritProvidesFlightPower("none"), false);
});

test("task 3.6: hoverReadiness surfaces Hover state only for a Hover Spirit (Req 1.7, 6.12)", () => {
  // No spirit / non-Hover spirit → nothing to show.
  assert.equal(hoverReadiness({ equippedSpirit: "none" }, CONFIG), null);
  assert.equal(
    hoverReadiness({ equippedSpirit: "pumpkin_guardian" }, CONFIG),
    null,
  );

  // Storm_Bat, cooldown elapsed → ready, full recharge fraction.
  const ready = hoverReadiness(
    { equippedSpirit: "storm_bat", hoverCooldown: 0 },
    CONFIG,
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.fraction, 1);

  // Mid-cooldown → not ready, partial fraction.
  const half = hoverReadiness(
    { equippedSpirit: "storm_bat", hoverCooldown: CONFIG.hover.cooldown / 2 },
    CONFIG,
  );
  assert.equal(half.ready, false);
  assert.ok(half.fraction > 0 && half.fraction < 1);
});

// --- Flight_Power routes to Hover through the real FSM flight tick ----------

test("task 3.6: a Flight_Power intent activates Hover in flight (vy=0, gravity suspended) (Req 6.12)", () => {
  const { fsm } = buildWiredFSM();
  fsm.startNewRun(11);
  fsm.transition(States.Active_Flight_State);
  const rs = fsm.runState;
  rs.equippedSpirit = "storm_bat";
  rs.hoverCooldown = 0;

  // Step with a Flight_Power intent: Hover activates, vy zeroed, cooldown armed.
  fsm.tick(FIXED_DT, { flap: false, flightPower: true });
  assert.equal(rs.ghosty.vy, 0, "Hover sets vy to 0 (Req 6.12)");
  assert.ok(rs.hoverRemaining > 0, "Hover duration armed");
  assert.ok(rs.hoverCooldown > 0, "Hover cooldown started on activation");
});
