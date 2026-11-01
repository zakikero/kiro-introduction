// test/battle-shop-ui.test.js — example/unit tests for the task 2.7 wiring:
// the pure presentation helpers in ui/battle.js and ui/shop.js, and the FSM's
// Battle freeze + separate flight-world snapshot (Req 5.22), checkpoint-based
// resume-to-flight (Req 9.5, 9.14), and no-input-leak barrier (Req 9.6).
//
// These exercise only the DOM-FREE logic: the view draw functions are not
// called here (they need a Canvas), but the pure helpers they rely on are.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRng } from "../src/rng.js";
import { createFSM, States, snapshotFlightWorld } from "../src/state.js";
import { makeOrdinaryEnemy, startBattle } from "../src/systems/combat.js";
import {
  describeEnemy,
  relativeDanger,
  battleActions,
  enemyIntent,
  enemyDisplayName,
  availableSpiritName,
  possessionOfferLines,
} from "../src/ui/battle.js";
import { possessionOffer } from "../src/systems/combat.js";
import { shopRows, canUsePotion, purchaseMessage } from "../src/ui/shop.js";
import { purchase } from "../src/systems/economy.js";

// --- ui/battle.js pure helpers ----------------------------------------------

test("describeEnemy surfaces identity, danger, reward, and available spirit (Req 4.6)", () => {
  const enemyA = makeOrdinaryEnemy("A", CONFIG);
  const infoA = describeEnemy(enemyA, CONFIG);
  assert.equal(infoA.name, "Storm Bat");
  assert.equal(infoA.spirit, "Storm Bat");
  assert.equal(infoA.reward, CONFIG.ordinaryEnemy.victoryReward);
  assert.ok(["Low", "Moderate", "High"].includes(infoA.danger));

  const enemyB = makeOrdinaryEnemy("B", CONFIG);
  const infoB = describeEnemy(enemyB, CONFIG);
  assert.equal(infoB.name, "Pumpkin Guardian");
  assert.equal(infoB.spirit, "Pumpkin Guardian");
});

test("relativeDanger bands the boss distinctly and a tougher foe higher", () => {
  const boss = { isBoss: true, attackDamage: 8, battleHp: 30 };
  assert.equal(relativeDanger(boss, CONFIG), "Boss");

  const ordinary = makeOrdinaryEnemy("A", CONFIG);
  assert.equal(relativeDanger(ordinary, CONFIG), "Low");

  const tough = {
    attackDamage: CONFIG.ordinaryEnemy.attackDamage * 3,
    battleHp: CONFIG.ordinaryEnemy.battleHp * 3,
  };
  assert.equal(relativeDanger(tough, CONFIG), "High");
});

test("battleActions always offers Attack/Defend/Use Item and a spirit move only when equipped (Req 5.3)", () => {
  const base = battleActions({ equippedSpirit: "none" });
  assert.deepEqual(
    base.map((a) => a.id),
    ["attack", "defend", "use_item"],
  );

  const storm = battleActions({ equippedSpirit: "storm_bat" });
  assert.equal(storm.length, 4);
  assert.equal(storm[3].id, "spirit");
  assert.equal(storm[3].label, "Lightning");

  const pumpkin = battleActions({ equippedSpirit: "pumpkin_guardian" });
  assert.equal(pumpkin[3].label, "Fortified Defend");
  assert.equal(pumpkin[3].available, true); // no cooldown
});

test("battleActions marks Lightning unavailable while its cooldown is pending (Req 5.3, 5.17)", () => {
  const ready = battleActions({
    equippedSpirit: "storm_bat",
    lightningCooldown: 0,
  });
  assert.equal(ready[3].available, true);

  const onCooldown = battleActions({
    equippedSpirit: "storm_bat",
    lightningCooldown: 2,
  });
  assert.equal(onCooldown[3].available, false);
});

test("possessionOfferLines explains both benefits and the two choices (Req 6.1, 6.2, 6.6)", () => {
  const enemy = makeOrdinaryEnemy("A", CONFIG); // Storm_Bat reward
  const offer = possessionOffer(enemy, { equippedSpirit: "none" });
  const lines = possessionOfferLines(offer);

  assert.ok(lines.title.includes("Storm Bat"));
  assert.ok(lines.flight.startsWith("Flight:"));
  assert.ok(lines.combat.startsWith("Combat:"));
  assert.ok(lines.current.includes("no Spirit"));
  assert.equal(lines.choices.length, 2); // replace + decline

  // No offer → no lines.
  assert.equal(possessionOfferLines(null), null);
});

test("enemyIntent reports a special-attack warning when the boss telegraphs (Req 5.9)", () => {
  const normal = enemyIntent({
    outcome: "ongoing",
    bossSpecialTelegraphed: false,
  });
  assert.equal(normal.warning, null);
  assert.ok(normal.text.length > 0);

  const telegraphing = enemyIntent({
    outcome: "ongoing",
    bossSpecialTelegraphed: true,
  });
  assert.ok(telegraphing.warning && telegraphing.warning.length > 0);

  const ended = enemyIntent({ outcome: "victory" });
  assert.equal(ended.text, "");
});

test("enemyDisplayName / availableSpiritName cover ordinary types and the boss", () => {
  assert.equal(enemyDisplayName({ isBoss: true }), "The Final Boss");
  assert.equal(availableSpiritName({ isBoss: true }), null);
  assert.equal(availableSpiritName({ type: "A" }), "Storm Bat");
});

// --- ui/shop.js pure helpers ------------------------------------------------

/** Minimal RunState for shop-row/potion tests. */
function runStateFor({
  soulCoins = 0,
  potion = 0,
  shieldCharges = 0,
  attackUpgradePurchased = false,
  battleHp = 22,
  maxBattleHp = 22,
} = {}) {
  return {
    soulCoins,
    shieldCharges,
    attackUpgradePurchased,
    attackDamage: CONFIG.combat.playerBaseAttack,
    items: { potion },
    battleHp,
    maxBattleHp,
  };
}

test("shopRows reports affordability/at-cap exactly as purchase would allow (Req 7.5)", () => {
  // Enough for a potion (5) but not a shield (8) or attack upgrade (7).
  const rs = runStateFor({ soulCoins: 5 });
  const rows = shopRows(rs, CONFIG);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

  assert.equal(byId.potion.affordable, true);
  assert.equal(byId.potion.buyable, true);
  assert.equal(byId.shield.affordable, false);
  assert.equal(byId.shield.buyable, false);
  assert.equal(byId.attack_upgrade.affordable, false);

  // Cross-check against the real economy: only the potion purchase succeeds.
  assert.equal(
    purchase(runStateFor({ soulCoins: 5 }), "potion", CONFIG).ok,
    true,
  );
  assert.equal(
    purchase(runStateFor({ soulCoins: 5 }), "shield", CONFIG).ok,
    false,
  );
});

test("shopRows marks a capped item at-cap and not buyable (Req 7.5)", () => {
  const rs = runStateFor({
    soulCoins: 100,
    shieldCharges: CONFIG.shieldCap,
    attackUpgradePurchased: true,
  });
  const byId = Object.fromEntries(shopRows(rs, CONFIG).map((r) => [r.id, r]));

  assert.equal(byId.shield.atCap, true);
  assert.equal(byId.shield.buyable, false);
  assert.equal(byId.attack_upgrade.atCap, true);
  assert.equal(byId.attack_upgrade.buyable, false);
  // The potion is uncapped: still buyable with coins.
  assert.equal(byId.potion.atCap, false);
  assert.equal(byId.potion.buyable, true);
});

test("canUsePotion mirrors usePotion's no-op conditions (Req 7.14)", () => {
  assert.equal(
    canUsePotion(runStateFor({ potion: 0, battleHp: 10 })),
    false,
    "no potion",
  );
  assert.equal(
    canUsePotion(runStateFor({ potion: 2, battleHp: 22, maxBattleHp: 22 })),
    false,
    "full HP",
  );
  assert.equal(
    canUsePotion(runStateFor({ potion: 1, battleHp: 10, maxBattleHp: 22 })),
    true,
    "owned + below max",
  );
});

test("purchaseMessage maps rejection reasons to legible text", () => {
  assert.ok(purchaseMessage("unaffordable").length > 0);
  assert.ok(purchaseMessage("shield_at_cap").length > 0);
  assert.equal(purchaseMessage(null), "");
});

// --- FSM: Battle freeze + separate snapshot (Req 5.22) ----------------------

/** Build an FSM already in live flight with a few pipes and a known Ghosty. */
function fsmInFlight() {
  const fsm = createFSM(CONFIG, { highScore: 0 }, { rng: createRng(1) });
  fsm.startNewRun(1);
  fsm.transition(States.Active_Flight_State);
  const rs = fsm.runState;
  rs.ghosty = { x: 300, y: 250, vy: -120, prevX: 298, prevY: 252 };
  rs.pipes = [
    {
      id: 1,
      x: 500,
      gapCenter: 300,
      gapHeight: 180,
      scored: false,
      shieldGrace: false,
    },
    {
      id: 2,
      x: 740,
      gapCenter: 340,
      gapHeight: 180,
      scored: false,
      shieldGrace: false,
    },
  ];
  rs.lastGapCenter = 340;
  return { fsm, rs };
}

test("entering Battle_State stores a separate frozen-flight-world snapshot (Req 5.22)", () => {
  const { fsm, rs } = fsmInFlight();
  fsm.enterBattle();

  assert.equal(fsm.state, States.Battle_State);
  assert.ok(rs.flightSnapshot, "a snapshot must be captured on battle entry");
  // The snapshot is a deep copy — equal in value but independent in identity.
  assert.notEqual(
    rs.flightSnapshot.ghosty,
    rs.ghosty,
    "snapshot ghosty must be a distinct object",
  );
  assert.deepEqual(rs.flightSnapshot.ghosty, rs.ghosty);
  assert.equal(rs.flightSnapshot.pipes.length, 2);
  assert.notEqual(rs.flightSnapshot.pipes[0], rs.pipes[0]);
});

test("the flight-world snapshot is unchanged when the checkpoint path mutates the live world (Req 5.22)", () => {
  const { fsm, rs } = fsmInFlight();
  fsm.enterBattle();
  const snap = rs.flightSnapshot;
  const snapGhostyBefore = { ...snap.ghosty };

  // Leaving the battle repositions Ghosty on the LIVE run via the checkpoint.
  fsm.resumeToFlight();

  // The live Ghosty moved to a checkpoint (vy zeroed); the snapshot did not.
  assert.equal(rs.ghosty.vy, 0, "checkpoint zeroes live vy");
  assert.deepEqual(
    snap.ghosty,
    snapGhostyBefore,
    "snapshot must stay byte-for-byte intact",
  );
});

test("snapshotFlightWorld captures only flight-world fields, not currencies/HP", () => {
  const { rs } = fsmInFlight();
  rs.soulCoins = 9;
  rs.battleHp = 7;
  const snap = snapshotFlightWorld(rs);
  assert.deepEqual(
    Object.keys(snap).sort(),
    ["ghosty", "lastGapCenter", "pipes", "rngSeed", "symbols"].sort(),
  );
  assert.equal("soulCoins" in snap, false);
  assert.equal("battleHp" in snap, false);
});

// --- FSM: checkpoint resume + resume countdown (Req 9.5, 9.14) ---------------

test("resumeToFlight repositions via checkpoint and enters the Resume countdown (Req 9.5, 9.14)", () => {
  const { fsm, rs } = fsmInFlight();
  fsm.enterBattle();

  // Pretend the battle ended and we move to Reward first, then resume.
  fsm.transition(States.Reward_State);
  const movedFrom = { x: rs.ghosty.x, y: rs.ghosty.y };
  const ok = fsm.resumeToFlight();

  assert.equal(ok, true);
  assert.equal(
    fsm.state,
    States.Resume_Countdown_State,
    "must enter the visible countdown before flight",
  );
  assert.equal(fsm.countdownRemaining, CONFIG.resumeCountdown);
  assert.equal(rs.ghosty.vy, 0, "checkpoint sets vy = 0 (Req 9.14)");
  // prev positions are synced to the new position (no false pass, Req 9.16).
  assert.equal(rs.ghosty.prevX, rs.ghosty.x);
  assert.equal(rs.ghosty.prevY, rs.ghosty.y);
  assert.ok(movedFrom);
});

test("resumeToFlight preserves run progress, inventory, shields, and cooldowns (Req 9.14)", () => {
  const { fsm, rs } = fsmInFlight();
  rs.soulCoins = 12;
  rs.shieldCharges = 1;
  rs.items = { potion: 2 };
  rs.hoverCooldown = 3.2;
  rs.attackDamage = 8;
  fsm.enterShop();

  fsm.resumeToFlight();

  assert.equal(rs.soulCoins, 12);
  assert.equal(rs.shieldCharges, 1);
  assert.equal(rs.items.potion, 2);
  assert.equal(rs.hoverCooldown, 3.2);
  assert.equal(rs.attackDamage, 8);
});

test("resumeToFlight only runs from Battle/Reward/Shop", () => {
  const { fsm } = fsmInFlight();
  assert.equal(
    fsm.resumeToFlight(),
    false,
    "not valid from Active_Flight_State",
  );
});

// --- FSM: no input leak across Battle/Shop → countdown → flight (Req 9.6) ----

test("no input leaks across Battle/Shop/Reward transitions — the input queue is flushed (Req 9.6)", () => {
  // A spy input queue records transition() calls (the single-consumption
  // barrier the FSM fires on every state change).
  const scopes = [];
  const spyQueue = { transition: (scope) => scopes.push(scope) };
  const fsm = createFSM(
    CONFIG,
    { highScore: 0 },
    { rng: createRng(2), inputQueue: spyQueue },
  );
  fsm.startNewRun(2);
  fsm.transition(States.Active_Flight_State);

  scopes.length = 0; // reset after setup
  fsm.enterShop();
  fsm.resumeToFlight();

  // Entering the shop flushes the queue; leaving the shop flushes again before
  // the countdown; so the confirming/leaving input cannot reach flight.
  assert.deepEqual(scopes, [States.Shop_State, States.Resume_Countdown_State]);
});

test("entering a battle fires the barrier so the contact input cannot act in battle (Req 9.6)", () => {
  const scopes = [];
  const spyQueue = { transition: (scope) => scopes.push(scope) };
  const fsm = createFSM(
    CONFIG,
    { highScore: 0 },
    { rng: createRng(3), inputQueue: spyQueue },
  );
  fsm.startNewRun(3);
  fsm.transition(States.Active_Flight_State);
  fsm.runState.activeBattle = startBattle(
    fsm.runState,
    makeOrdinaryEnemy("A", CONFIG),
    CONFIG,
  );

  scopes.length = 0;
  fsm.enterBattle();
  assert.deepEqual(scopes, [States.Battle_State]);
});
