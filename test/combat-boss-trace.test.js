// test/combat-boss-trace.test.js — deterministic EXAMPLE (unit) test that
// replays the documented optimal-play boss-win trace for the base Ghosty.
//
// This is NOT a property test: it is a single, fully determined replay of the
// exact sequence documented in requirements.md (the "Starting Battle_HP"
// validated trace in the Configurable Initial Defaults table). It proves that
// a base Ghosty (Attack 5, no spirit, no items) starting at the configured
// Battle_HP defeats the Final_Boss using ONLY Attack and Defend, landing the
// kill on the Player turn and surviving with exactly a 2 HP margin.
//
//   Validates: Requirement 5.20 (the Final_Boss is defeatable by the base
//   Ghosty at the configured starting Battle_HP using only Attack and Defend,
//   given the configured boss numbers, enemy-action sequence, special cooldown,
//   and damage rounding — no Spirit, purchased item, or consumable required).
//
// All numbers come from CONFIG; the test first asserts CONFIG matches the
// documented defaults so the trace stays anchored to the single source of
// tuning truth rather than hardcoded magic numbers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRunState } from "../src/state.js";
import {
  PlayerActions,
  makeBoss,
  startBattle,
  resolvePlayerAction,
  resolveEnemyTurn,
} from "../src/systems/combat.js";

// ---------------------------------------------------------------------------
// Guard: the trace is only meaningful against the documented defaults. If a
// balancing pass changes a combat number, this block fails loudly so the trace
// is re-validated rather than silently drifting.
// ---------------------------------------------------------------------------

test("CONFIG matches the documented defaults the boss-win trace depends on", () => {
  // Ghosty: Battle_HP 22, Attack 5, no spirit, no items.
  assert.equal(CONFIG.combat.startingBattleHp, 22);
  assert.equal(CONFIG.combat.playerBaseAttack, 5);

  // Boss: Battle_HP 30, normal 4, special 8.
  assert.equal(CONFIG.boss.battleHp, 30);
  assert.equal(CONFIG.boss.normalDamage, 4);
  assert.equal(CONFIG.boss.specialDamage, 8);

  // Defend 50% reduction, rounded down (special 8 -> 4).
  assert.equal(CONFIG.combat.defendReduction, 0.5);

  // The exact documented enemy-action sequence.
  assert.deepEqual(CONFIG.boss.actionSequence, [
    "normal",
    "telegraph",
    "special",
    "normal",
    "normal",
    "normal",
    "telegraph",
    "special",
  ]);
});

// ---------------------------------------------------------------------------
// The replay. One round = Player Attack/Defend, then (unless the boss is
// already dead) one boss enemy turn. We thread the returned { battle, runState }
// through every step; the player's Battle_HP lives on runState.battleHp and the
// boss HP on battle.enemy.battleHp.
// ---------------------------------------------------------------------------

test("base Ghosty defeats the Final_Boss with only Attack and Defend, surviving at 2 HP (Req 5.20)", () => {
  // Base Ghosty: starting Battle_HP 22, Attack 5, NO spirit, NO items.
  let runState = createRunState(CONFIG, 0);
  assert.equal(runState.equippedSpirit, "none");
  assert.equal(runState.battleHp, 22);
  assert.equal(runState.attackDamage, 5);
  assert.equal(runState.items.potion, 0);

  const boss = makeBoss(CONFIG);
  let battle = startBattle(runState, boss, CONFIG);
  assert.equal(battle.enemy.isBoss, true);
  assert.equal(battle.enemy.battleHp, 30);

  // Small helpers to run one player action / one enemy turn and rethread state.
  const player = (action) => {
    const r = resolvePlayerAction(battle, action, runState, CONFIG);
    battle = r.battle;
    runState = r.runState;
  };
  const enemy = () => {
    const r = resolveEnemyTurn(battle, runState, CONFIG);
    battle = r.battle;
    runState = r.runState;
  };

  // --- R1: Player Attack -> boss 25; enemy Normal 4 -> player HP 18 ---
  player(PlayerActions.Attack);
  assert.equal(battle.enemy.battleHp, 25, "R1 boss HP after Attack");
  enemy();
  assert.equal(runState.battleHp, 18, "R1 player HP after enemy Normal");

  // --- R2: Player Attack -> boss 20; enemy Telegraph 0 -> player HP 18 ---
  player(PlayerActions.Attack);
  assert.equal(battle.enemy.battleHp, 20, "R2 boss HP after Attack");
  enemy();
  assert.equal(runState.battleHp, 18, "R2 player HP after enemy Telegraph (no damage)");
  assert.equal(battle.bossSpecialTelegraphed, true, "R2 special is telegraphed");

  // --- R3: Player Defend; enemy Special 8 halved to 4 -> player HP 14 ---
  player(PlayerActions.Defend);
  assert.equal(battle.enemy.battleHp, 20, "R3 boss HP unchanged by Defend");
  assert.equal(battle.defendActive, true, "R3 Defend queued for the Special");
  enemy();
  assert.equal(runState.battleHp, 14, "R3 player HP after Special 8 halved to 4");

  // --- R4: Player Attack -> boss 15; enemy Normal 4 -> player HP 10 ---
  player(PlayerActions.Attack);
  assert.equal(battle.enemy.battleHp, 15, "R4 boss HP after Attack");
  enemy();
  assert.equal(runState.battleHp, 10, "R4 player HP after enemy Normal");

  // --- R5: Player Attack -> boss 10; enemy Normal 4 -> player HP 6 ---
  player(PlayerActions.Attack);
  assert.equal(battle.enemy.battleHp, 10, "R5 boss HP after Attack");
  enemy();
  assert.equal(runState.battleHp, 6, "R5 player HP after enemy Normal");

  // --- R6: Player Attack -> boss 5; enemy Normal 4 -> player HP 2 ---
  player(PlayerActions.Attack);
  assert.equal(battle.enemy.battleHp, 5, "R6 boss HP after Attack");
  enemy();
  assert.equal(runState.battleHp, 2, "R6 player HP after enemy Normal");

  // --- R7: Player Attack -> boss 0; boss defeated on the PLAYER turn ---
  const enemyTurnsBeforeKill = battle.resolvedEnemyTurns;
  player(PlayerActions.Attack);
  assert.equal(battle.enemy.battleHp, 0, "R7 boss reaches 0 HP");

  // The boss reaches 0 HP on the Player turn: outcome is victory immediately.
  assert.equal(battle.outcome, "victory", "boss defeated on the Player turn");
  assert.equal(battle.phase, "ended");

  // The boss takes NO further enemy turn after being defeated: invoking the
  // enemy turn is a guarded no-op — no extra resolved enemy turn, no damage.
  enemy();
  assert.equal(battle.outcome, "victory", "still victory after a guarded enemy turn");
  assert.equal(
    battle.resolvedEnemyTurns,
    enemyTurnsBeforeKill,
    "boss takes no further enemy turn after defeat",
  );

  // The Player survives with exactly 2 HP (margin of 2).
  assert.equal(runState.battleHp, 2, "Player survives with exactly 2 HP (margin of 2)");
});
