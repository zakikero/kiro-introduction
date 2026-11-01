// test/combat.test.js — unit + property tests for the turn-based combat engine.
//
// Exercises src/systems/combat.js (pure logic, no DOM) for the ordinary-enemy
// engine from task 2.2. Property tests use fast-check (never hand-rolled
// generators) with the project's naming/iteration conventions:
//
//   Property 14: Player acts first and lethal actions skip the enemy turn
//                — Validates: Requirements 5.6, 5.13, 5.14
//   Property 15: Percentage-reduction rounding
//                — Validates: Requirements 5.15
//   Property 16: Defend protects exactly one incoming attack
//                — Validates: Requirements 5.7
//
// Unit tests cover the concrete action mechanics (turn consumption, invalid
// actions, defeat, the Use Item integration point) that the properties then
// generalize across inputs. Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7,
// 5.8, 5.11, 5.13, 5.14, 5.15.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRunState } from "../src/state.js";
import {
  PlayerActions,
  applyPercentReduction,
  makeOrdinaryEnemy,
  startBattle,
  resolvePlayerAction,
  resolveEnemyTurn,
  usePotion,
  spiritMoveFor,
  lightningReady,
  tickPlayerCooldowns,
  grantOrdinaryVictoryRewards,
  possessionOffer,
  applyPossessionChoice,
} from "../src/systems/combat.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

// --- Helpers ---------------------------------------------------------------

function freshRun() {
  return createRunState(CONFIG, 0);
}

function freshBattle(type = "A") {
  const run = freshRun();
  const enemy = makeOrdinaryEnemy(type, CONFIG);
  return { run, battle: startBattle(run, enemy, CONFIG) };
}

// ===========================================================================
// Unit tests — concrete mechanics
// ===========================================================================

test("startBattle opens on the player phase with a full-HP enemy", () => {
  const { battle } = freshBattle("A");
  assert.equal(battle.phase, "player");
  assert.equal(battle.outcome, "ongoing");
  assert.equal(battle.round, 1);
  assert.equal(battle.resolvedPlayerTurns, 0);
  assert.equal(battle.resolvedEnemyTurns, 0);
  assert.equal(battle.defendActive, false);
  assert.equal(battle.defendPercent, CONFIG.combat.defendReduction);
  assert.equal(battle.enemy.battleHp, CONFIG.ordinaryEnemy.battleHp);
  assert.equal(battle.bossActionIndex, 0);
});

test("startBattle does not refill or reset the run's lightning cooldown (Req 5.20)", () => {
  const run = freshRun();
  run.lightningCooldown = 2;
  const enemy = makeOrdinaryEnemy("A", CONFIG);
  startBattle(run, enemy, CONFIG);
  assert.equal(run.lightningCooldown, 2); // untouched by battle creation
});

test("Attack consumes exactly one player turn and damages the enemy (Req 5.4)", () => {
  const { run, battle } = freshBattle("A");
  const { battle: next } = resolvePlayerAction(
    battle,
    PlayerActions.Attack,
    run,
    CONFIG,
  );
  assert.equal(next.resolvedPlayerTurns, 1);
  assert.equal(
    next.enemy.battleHp,
    CONFIG.ordinaryEnemy.battleHp - run.attackDamage,
  );
  assert.equal(next.phase, "enemy"); // enemy responds next
  assert.equal(next.outcome, "ongoing");
});

test("Attack to zero HP ends in victory with no counterattack (Req 5.6, 5.14)", () => {
  const { run, battle } = freshBattle("A");
  // Drive the enemy low so one attack is lethal.
  battle.enemy.battleHp = run.attackDamage;
  const { battle: afterPlayer } = resolvePlayerAction(
    battle,
    PlayerActions.Attack,
    run,
    CONFIG,
  );
  assert.equal(afterPlayer.outcome, "victory");
  assert.equal(afterPlayer.phase, "ended");
  assert.equal(afterPlayer.enemy.battleHp, 0);
  assert.equal(afterPlayer.resolvedPlayerTurns, 1);

  // The enemy turn is skipped: resolveEnemyTurn is a no-op after victory.
  const { battle: afterEnemy, runState: runAfter } = resolveEnemyTurn(
    afterPlayer,
    run,
    CONFIG,
  );
  assert.equal(afterEnemy.resolvedEnemyTurns, 0);
  assert.equal(runAfter.battleHp, run.battleHp); // no damage taken
});

test("invalid/unknown action consumes no turn or item (Req 5.5)", () => {
  const { run, battle } = freshBattle("A");
  const { battle: next, runState } = resolvePlayerAction(
    battle,
    "not_a_real_action",
    run,
    CONFIG,
  );
  assert.equal(next, battle); // returned unchanged
  assert.equal(runState, run);
  assert.equal(next.resolvedPlayerTurns, 0);
});

test("Use Item with no potion hook wired is rejected as invalid (Req 5.5)", () => {
  const { run, battle } = freshBattle("A");
  const { battle: next, runState } = resolvePlayerAction(
    battle,
    PlayerActions.UseItem,
    run,
    CONFIG,
  );
  // No turn consumed, nothing changed — clean integration point for task 2.5.
  assert.equal(next.resolvedPlayerTurns, 0);
  assert.equal(next.phase, "player");
  assert.equal(runState, run);
});

test("Use Item consumes a turn only when the potion hook reports ok (Req 5.24)", () => {
  const { run, battle } = freshBattle("A");
  run.items.potion = 1;
  run.battleHp = run.maxBattleHp - CONFIG.shop.potion.effect;

  let called = 0;
  const usePotion = (rs, b, cfg) => {
    called += 1;
    return {
      ok: true,
      runState: {
        ...rs,
        battleHp: rs.battleHp + CONFIG.shop.potion.effect,
        items: { potion: 0 },
      },
      battle: b,
    };
  };

  const { battle: next, runState } = resolvePlayerAction(
    battle,
    PlayerActions.UseItem,
    run,
    CONFIG,
    { usePotion },
  );
  assert.equal(called, 1);
  assert.equal(next.resolvedPlayerTurns, 1);
  assert.equal(next.phase, "enemy");
  assert.equal(runState.battleHp, run.battleHp + CONFIG.shop.potion.effect);
  assert.equal(runState.items.potion, 0);
});

test("Use Item with a failing potion hook consumes no turn or item (Req 5.25)", () => {
  const { run, battle } = freshBattle("A");
  const usePotion = () => ({ ok: false, reason: "full" });
  const { battle: next, runState } = resolvePlayerAction(
    battle,
    PlayerActions.UseItem,
    run,
    CONFIG,
    { usePotion },
  );
  assert.equal(next.resolvedPlayerTurns, 0);
  assert.equal(next.phase, "player");
  assert.equal(runState, run);
});

// ---------------------------------------------------------------------------
// usePotion — the shared potion effect (task 2.5).
// Requirements: 5.24, 5.25, 7.13, 7.14, 7.15, 7.16.
// (Property 32 — the comprehensive potion property — is task 2.6.)
// ---------------------------------------------------------------------------

test("usePotion heals up to the configured effect and consumes one potion (Req 7.13, 7.16)", () => {
  const { run, battle } = freshBattle("A");
  run.items.potion = 2;
  run.battleHp = run.maxBattleHp - CONFIG.shop.potion.effect; // room for a full heal

  const result = usePotion(run, battle, CONFIG);
  assert.equal(result.ok, true);
  assert.equal(result.runState.battleHp, run.maxBattleHp); // healed by full effect
  assert.equal(result.runState.items.potion, 1); // exactly one consumed
  // Inputs are never mutated (pure).
  assert.equal(run.battleHp, run.maxBattleHp - CONFIG.shop.potion.effect);
  assert.equal(run.items.potion, 2);
});

test("usePotion caps healing at maxBattleHp, never overhealing (Req 7.13)", () => {
  const { run, battle } = freshBattle("A");
  run.items.potion = 1;
  run.battleHp = run.maxBattleHp - 1; // only 1 HP of room; effect is +10

  const result = usePotion(run, battle, CONFIG);
  assert.equal(result.ok, true);
  assert.equal(result.runState.battleHp, run.maxBattleHp); // capped, not maxHp+9
  assert.equal(result.runState.items.potion, 0);
});

test("usePotion is a no-op at full Battle_HP — nothing consumed (Req 5.25, 7.14)", () => {
  const { run, battle } = freshBattle("A");
  run.items.potion = 3;
  run.battleHp = run.maxBattleHp; // already full

  const result = usePotion(run, battle, CONFIG);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "full");
  assert.equal(result.runState, run); // same reference, unchanged
  assert.equal(result.runState.items.potion, 3); // no potion spent
  assert.equal(result.runState.battleHp, run.maxBattleHp);
});

test("usePotion is a no-op with zero potions — Battle_HP unchanged (Req 5.25, 7.14)", () => {
  const { run, battle } = freshBattle("A");
  run.items.potion = 0;
  run.battleHp = 5; // well below max

  const result = usePotion(run, battle, CONFIG);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_potion");
  assert.equal(result.runState, run); // unchanged reference
  assert.equal(result.runState.battleHp, 5);
});

test("usePotion in Shop_State (battle=null) heals without any combat turn (Req 7.13)", () => {
  const run = freshRun();
  run.items.potion = 1;
  run.battleHp = 1;

  const result = usePotion(run, null, CONFIG);
  assert.equal(result.ok, true);
  assert.equal(result.battle, null); // no battle, no combat turn
  assert.equal(result.runState.items.potion, 0);
  assert.equal(
    result.runState.battleHp,
    Math.min(run.maxBattleHp, 1 + CONFIG.shop.potion.effect),
  );
});

test("usePotion as the Battle_State hook consumes exactly one player turn (Req 5.24)", () => {
  const { run, battle } = freshBattle("A");
  run.items.potion = 1;
  run.battleHp = run.maxBattleHp - CONFIG.shop.potion.effect;

  const { battle: next, runState } = resolvePlayerAction(
    battle,
    PlayerActions.UseItem,
    run,
    CONFIG,
    { usePotion },
  );
  assert.equal(next.resolvedPlayerTurns, 1); // one player turn consumed
  assert.equal(next.phase, "enemy"); // enemy responds next
  assert.equal(runState.items.potion, 0); // exactly one potion spent
  assert.equal(runState.battleHp, run.maxBattleHp);
});

test("usePotion as the Battle_State hook at full HP consumes no turn or item (Req 5.25)", () => {
  const { run, battle } = freshBattle("A");
  run.items.potion = 2;
  run.battleHp = run.maxBattleHp; // full → disabled

  const { battle: next, runState } = resolvePlayerAction(
    battle,
    PlayerActions.UseItem,
    run,
    CONFIG,
    { usePotion },
  );
  assert.equal(next.resolvedPlayerTurns, 0); // no turn consumed
  assert.equal(next.phase, "player");
  assert.equal(runState.items.potion, 2); // no potion spent
  assert.equal(runState.battleHp, run.maxBattleHp);
});

test("enemy turn reduces Battle_HP and advances the round (Req 5.2, 5.8)", () => {
  const { run, battle } = freshBattle("A");
  const { battle: afterPlayer } = resolvePlayerAction(
    battle,
    PlayerActions.Attack,
    run,
    CONFIG,
  );
  const { battle: afterEnemy, runState } = resolveEnemyTurn(
    afterPlayer,
    run,
    CONFIG,
  );
  assert.equal(
    runState.battleHp,
    run.battleHp - CONFIG.ordinaryEnemy.attackDamage,
  );
  assert.equal(afterEnemy.resolvedEnemyTurns, 1);
  assert.equal(afterEnemy.phase, "player");
  assert.equal(afterEnemy.round, 2);
});

test("Battle_HP reaching zero ends the run in defeat (Req 5.11)", () => {
  const { run, battle } = freshBattle("A");
  run.battleHp = CONFIG.ordinaryEnemy.attackDamage; // one hit is lethal
  const { battle: afterPlayer } = resolvePlayerAction(
    battle,
    PlayerActions.Defend, // defending still lets a turn pass; but use attack-less path
    run,
    CONFIG,
  );
  // Clear the queued Defend so the full hit lands.
  afterPlayer.defendActive = false;
  const { battle: afterEnemy, runState } = resolveEnemyTurn(
    afterPlayer,
    run,
    CONFIG,
  );
  assert.equal(runState.battleHp, 0);
  assert.equal(afterEnemy.outcome, "defeat");
  assert.equal(afterEnemy.phase, "ended");
});

test("Defend reduces the next incoming attack then clears (Req 5.7)", () => {
  const run = freshRun();
  // Use an enemy with a larger hit so the reduction is visible after floor.
  const enemy = makeOrdinaryEnemy("A", CONFIG);
  enemy.attackDamage = 8;
  const battle = startBattle(run, enemy, CONFIG);

  const { battle: afterDefend } = resolvePlayerAction(
    battle,
    PlayerActions.Defend,
    run,
    CONFIG,
  );
  assert.equal(afterDefend.defendActive, true);
  assert.equal(afterDefend.resolvedPlayerTurns, 1);

  const { battle: afterEnemy, runState } = resolveEnemyTurn(
    afterDefend,
    run,
    CONFIG,
  );
  const expectedDealt = applyPercentReduction(8, CONFIG.combat.defendReduction);
  assert.equal(runState.battleHp, run.battleHp - expectedDealt);
  assert.equal(afterEnemy.defendActive, false); // cleared after resolving
});

// ===========================================================================
// Property 15: Percentage-reduction rounding
// ===========================================================================

test(propertyName(15, "Percentage-reduction rounding"), () => {
  assertProperty(
    fc.property(
      fc.double({ min: 0, max: 1000, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      (raw, percent) => {
        const result = applyPercentReduction(raw, percent);
        const expected = Math.max(0, Math.floor(raw * (1 - percent)));
        return result === expected && result >= 0 && Number.isInteger(result);
      },
    ),
  );
});

// ===========================================================================
// Property 14: Player acts first and lethal actions skip the enemy turn
// ===========================================================================

test(
  propertyName(14, "Player acts first and lethal actions skip the enemy turn"),
  () => {
    assertProperty(
      fc.property(
        // Enemy HP and player attack across a range so some attacks are lethal
        // and some are not.
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 15 }),
        (enemyHp, playerAttack, enemyAttack) => {
          const run = freshRun();
          run.attackDamage = playerAttack;
          const startHp = run.battleHp;

          const enemy = makeOrdinaryEnemy("A", CONFIG);
          enemy.battleHp = enemyHp;
          enemy.maxBattleHp = enemyHp;
          enemy.attackDamage = enemyAttack;

          const battle = startBattle(run, enemy, CONFIG);

          // Player ALWAYS resolves first: before any player action the phase is
          // 'player' and the enemy has taken no turn.
          if (battle.phase !== "player") return false;
          if (battle.resolvedEnemyTurns !== 0) return false;

          const { battle: afterPlayer } = resolvePlayerAction(
            battle,
            PlayerActions.Attack,
            run,
            CONFIG,
          );

          const lethal = playerAttack >= enemyHp;

          // Attempt the enemy turn unconditionally; it must be skipped iff the
          // player's action ended the battle (Req 5.14).
          const { battle: afterEnemy, runState: runAfter } = resolveEnemyTurn(
            afterPlayer,
            run,
            CONFIG,
          );

          if (lethal) {
            // Victory, enemy dealt nothing, took no turn (Req 5.6, 5.14).
            if (afterPlayer.outcome !== "victory") return false;
            if (afterPlayer.phase !== "ended") return false;
            if (afterEnemy.resolvedEnemyTurns !== 0) return false;
            if (runAfter.battleHp !== startHp) return false;
          } else {
            // Enemy survived: the enemy took its turn and may have dealt damage.
            if (afterPlayer.outcome !== "ongoing") return false;
            if (afterEnemy.resolvedEnemyTurns !== 1) return false;
            if (runAfter.battleHp > startHp) return false;
          }

          return true;
        },
      ),
    );
  },
);

// ===========================================================================
// Property 16: Defend protects exactly one incoming attack
// ===========================================================================

test(propertyName(16, "Defend protects exactly one incoming attack"), () => {
  assertProperty(
    fc.property(
      fc.integer({ min: 1, max: 20 }), // enemy attack damage
      (enemyAttack) => {
        const run = freshRun();
        // Give the player plenty of HP and a huge attack-less survivability so
        // the run does not end before we observe two enemy turns.
        run.battleHp = 10_000;
        run.attackDamage = 1;

        const enemy = makeOrdinaryEnemy("A", CONFIG);
        enemy.battleHp = 10_000; // never dies during this trace
        enemy.maxBattleHp = 10_000;
        enemy.attackDamage = enemyAttack;

        let battle = startBattle(run, enemy, CONFIG);
        let rs = run;

        // Round 1: Player defends; the incoming attack must be reduced.
        ({ battle, runState: rs } = resolvePlayerAction(
          battle,
          PlayerActions.Defend,
          rs,
          CONFIG,
        ));
        if (battle.defendActive !== true) return false;

        const hpBeforeAttack1 = rs.battleHp;
        ({ battle, runState: rs } = resolveEnemyTurn(battle, rs, CONFIG));
        const dealt1 = hpBeforeAttack1 - rs.battleHp;
        const reduced = applyPercentReduction(
          enemyAttack,
          CONFIG.combat.defendReduction,
        );
        if (dealt1 !== reduced) return false;
        // Defend cleared after exactly one attack resolved (Req 5.7).
        if (battle.defendActive !== false) return false;

        // Round 2: Player does NOT defend; the next attack is at full damage,
        // proving the protection covered exactly one incoming attack.
        ({ battle, runState: rs } = resolvePlayerAction(
          battle,
          PlayerActions.Attack,
          rs,
          CONFIG,
        ));
        const hpBeforeAttack2 = rs.battleHp;
        ({ battle, runState: rs } = resolveEnemyTurn(battle, rs, CONFIG));
        const dealt2 = hpBeforeAttack2 - rs.battleHp;
        if (dealt2 !== enemyAttack) return false;

        return true;
      },
    ),
  );
});

// ===========================================================================
// Property 32: Potion use heals within bounds and costs the right turn
// Validates: Requirements 5.24, 5.25, 7.13, 7.14, 7.15, 7.16
//
// For any Run state and a confirmed potion use:
//   - owning >= 1 potion AND Battle_HP below max  => consume exactly one
//     potion and heal up to the configured effect capped at maxBattleHp;
//     in Battle_State (via resolvePlayerAction Use Item) it costs exactly one
//     player turn; in Shop_State (battle = null) there is no combat turn and no
//     Candy time (activeFlightTime) accrues;
//   - owning no potion OR already at max Battle_HP => consume nothing and leave
//     Battle_HP unchanged (strict no-op), no turn consumed in Battle_State;
//   - one confirmed use counts as exactly one use (one call == one confirmed
//     action; a duplicate confirmed use is a second call and consumes a second
//     potion only when still eligible, confirming each confirmed use is 1:1).
// Never usable in Active_Flight_State is the caller's responsibility (the
// flight code never calls usePotion); the engine exposes no flight-state path,
// which this property checks structurally via the Shop/Battle-only callers.
// ===========================================================================

test(
  propertyName(32, "Potion use heals within bounds and costs the right turn"),
  () => {
    const EFFECT = CONFIG.shop.potion.effect;

    assertProperty(
      fc.property(
        // Potions owned (include 0 to exercise the no-potion no-op).
        fc.integer({ min: 0, max: 8 }),
        // Current Battle_HP from 0..max (include max for the full-HP no-op).
        fc.integer({ min: 0, max: CONFIG.combat.startingBattleHp }),
        // Context: run the use in Battle_State or Shop_State.
        fc.constantFrom("battle", "shop"),
        (owned, hp, context) => {
          const run = freshRun();
          run.items.potion = owned;
          run.battleHp = hp;
          const maxHp = run.maxBattleHp;

          const eligible = owned >= 1 && hp < maxHp;
          const expectedHealed = eligible ? Math.min(maxHp, hp + EFFECT) : hp;
          const expectedPotionAfter = eligible ? owned - 1 : owned;

          if (context === "shop") {
            // Shop_State: battle = null. No combat turn, no Candy time.
            const flightBefore = run.activeFlightTime;
            const result = usePotion(run, null, CONFIG);

            if (result.ok !== eligible) return false;
            if (result.battle !== null) return false; // never a combat turn

            // Inputs are never mutated (purity).
            if (run.items.potion !== owned) return false;
            if (run.battleHp !== hp) return false;
            if (run.activeFlightTime !== flightBefore) return false;

            if (eligible) {
              // Healed within bounds, capped, exactly one potion consumed.
              if (result.runState.battleHp !== expectedHealed) return false;
              if (result.runState.battleHp > maxHp) return false;
              if (result.runState.items.potion !== expectedPotionAfter) {
                return false;
              }
              // No Candy time accrues from a potion use.
              if (result.runState.activeFlightTime !== flightBefore) {
                return false;
              }
            } else {
              // Strict no-op: same reference, nothing consumed, HP unchanged.
              if (result.runState !== run) return false;
              if (result.runState.items.potion !== owned) return false;
              if (result.runState.battleHp !== hp) return false;
            }
            return true;
          }

          // Battle_State: the Use Item hook routes through resolvePlayerAction.
          const enemy = makeOrdinaryEnemy("A", CONFIG);
          // Keep the enemy alive so the battle stays ongoing and we observe the
          // turn bookkeeping cleanly.
          enemy.battleHp = 1_000;
          enemy.maxBattleHp = 1_000;
          const battle = startBattle(run, enemy, CONFIG);

          const { battle: next, runState } = resolvePlayerAction(
            battle,
            PlayerActions.UseItem,
            run,
            CONFIG,
            { usePotion },
          );

          if (eligible) {
            // Exactly one player turn consumed; enemy responds next.
            if (next.resolvedPlayerTurns !== 1) return false;
            if (next.phase !== "enemy") return false;
            // Exactly one potion consumed; healed within the cap.
            if (runState.items.potion !== expectedPotionAfter) return false;
            if (runState.battleHp !== expectedHealed) return false;
            if (runState.battleHp > maxHp) return false;
          } else {
            // Disabled potion: no turn, no item, nothing changed (Req 5.25).
            if (next.resolvedPlayerTurns !== 0) return false;
            if (next.phase !== "player") return false;
            if (runState !== run) return false;
            if (runState.items.potion !== owned) return false;
            if (runState.battleHp !== hp) return false;
          }
          return true;
        },
      ),
    );
  },
);

// One confirmed use counts as exactly one use: calling the hook twice (two
// confirmed actions) consumes two potions when still eligible, and a single
// confirmed use never consumes more than one — proving the 1:1 mapping of
// confirmed action to consume (Req 7.16).
test(propertyName(32, "One confirmed use consumes exactly one potion"), () => {
  assertProperty(
    fc.property(fc.integer({ min: 2, max: 8 }), (owned) => {
      const run = freshRun();
      run.items.potion = owned;
      run.battleHp = 1; // well below max so every use is eligible

      // First confirmed use.
      const first = usePotion(run, null, CONFIG);
      if (!first.ok) return false;
      if (first.runState.items.potion !== owned - 1) return false;

      // Second confirmed use on the resulting state consumes exactly one more.
      const second = usePotion(first.runState, null, CONFIG);
      if (!second.ok) return false;
      if (second.runState.items.potion !== owned - 2) return false;

      return true;
    }),
  );
});

// ===========================================================================
// Task 3.5 — Spirit combat moves and the possession offer flow.
// Requirements: 5.3, 5.16, 5.17, 6.1, 6.2, 6.6, 6.7, 6.8.
// (Property 17 — cooldowns advance only by resolved turns — is task 4.3.)
// ===========================================================================

function runWithSpirit(spirit) {
  const run = freshRun();
  run.equippedSpirit = spirit;
  return run;
}

test("spiritMoveFor maps each spirit to its one combat move (Req 6.6, 6.7, 6.8)", () => {
  assert.equal(spiritMoveFor({ equippedSpirit: "storm_bat" }), "lightning");
  assert.equal(
    spiritMoveFor({ equippedSpirit: "pumpkin_guardian" }),
    "fortify",
  );
  assert.equal(spiritMoveFor({ equippedSpirit: "none" }), null);
  assert.equal(spiritMoveFor({ equippedSpirit: "unknown" }), null);
});

test("a spirit move is only usable when the equipped Spirit provides one (Req 5.3)", () => {
  // Base Ghosty: selecting the Spirit move is invalid — no turn, no change.
  const run = freshRun();
  const enemy = makeOrdinaryEnemy("A", CONFIG);
  const battle = startBattle(run, enemy, CONFIG);
  const { battle: next, runState } = resolvePlayerAction(
    battle,
    PlayerActions.SpiritMove,
    run,
    CONFIG,
  );
  assert.equal(next, battle);
  assert.equal(runState, run);
  assert.equal(next.resolvedPlayerTurns, 0);
});

test("lightning deals the configured damage and starts the 2-turn cooldown (Req 5.17)", () => {
  const run = runWithSpirit("storm_bat");
  const enemy = makeOrdinaryEnemy("A", CONFIG);
  const battle = startBattle(run, enemy, CONFIG);
  assert.equal(lightningReady(run), true);

  const { battle: next, runState } = resolvePlayerAction(
    battle,
    PlayerActions.SpiritMove,
    run,
    CONFIG,
  );
  assert.equal(
    next.enemy.battleHp,
    CONFIG.ordinaryEnemy.battleHp - CONFIG.spirits.stormBat.lightningDamage,
  );
  assert.equal(next.resolvedPlayerTurns, 1);
  assert.equal(next.phase, "enemy");
  // The cooldown is NOT decremented on the turn that starts it (Req 5.16).
  assert.equal(
    runState.lightningCooldown,
    CONFIG.spirits.stormBat.lightningCooldown,
  );
  assert.equal(lightningReady(runState), false);
});

test("lightning on cooldown is an invalid action — no turn, no cooldown change (Req 5.5, 5.16)", () => {
  const run = runWithSpirit("storm_bat");
  run.lightningCooldown = 2;
  const enemy = makeOrdinaryEnemy("A", CONFIG);
  const battle = startBattle(run, enemy, CONFIG);

  const { battle: next, runState } = resolvePlayerAction(
    battle,
    PlayerActions.SpiritMove,
    run,
    CONFIG,
  );
  assert.equal(next, battle); // unchanged
  assert.equal(runState, run);
  assert.equal(runState.lightningCooldown, 2); // not touched
});

test("lightning blocks exactly the next two resolved player turns (Req 5.17)", () => {
  const run = runWithSpirit("storm_bat");
  const enemy = makeOrdinaryEnemy("A", CONFIG);
  enemy.battleHp = 1000; // keep the battle going
  enemy.maxBattleHp = 1000;
  enemy.attackDamage = 0; // never ends the run in defeat
  run.battleHp = 1000;
  let battle = startBattle(run, enemy, CONFIG);
  let rs = run;

  // Turn 1: lightning → cooldown = 2, not decremented this turn.
  ({ battle, runState: rs } = resolvePlayerAction(
    battle,
    PlayerActions.SpiritMove,
    rs,
    CONFIG,
  ));
  assert.equal(rs.lightningCooldown, 2);
  ({ battle, runState: rs } = resolveEnemyTurn(battle, rs, CONFIG));

  // Turn 2 (first subsequent): Attack decrements 2 → 1. Still blocked.
  ({ battle, runState: rs } = resolvePlayerAction(
    battle,
    PlayerActions.Attack,
    rs,
    CONFIG,
  ));
  assert.equal(rs.lightningCooldown, 1);
  assert.equal(lightningReady(rs), false);
  ({ battle, runState: rs } = resolveEnemyTurn(battle, rs, CONFIG));

  // Turn 3 (second subsequent): Attack decrements 1 → 0. Now ready again.
  ({ battle, runState: rs } = resolvePlayerAction(
    battle,
    PlayerActions.Attack,
    rs,
    CONFIG,
  ));
  assert.equal(rs.lightningCooldown, 0);
  assert.equal(lightningReady(rs), true);
});

test("fortified defend reduces the next attack by 75% then clears (Req 5.7, 6.8)", () => {
  const run = runWithSpirit("pumpkin_guardian");
  const enemy = makeOrdinaryEnemy("A", CONFIG);
  enemy.attackDamage = 8; // reduction visible after floor
  const battle = startBattle(run, enemy, CONFIG);

  const { battle: afterFortify } = resolvePlayerAction(
    battle,
    PlayerActions.SpiritMove,
    run,
    CONFIG,
  );
  assert.equal(afterFortify.defendActive, true);
  assert.equal(
    afterFortify.defendPercent,
    CONFIG.spirits.pumpkinGuardian.fortifiedDefendReduction,
  );
  assert.equal(afterFortify.resolvedPlayerTurns, 1);

  const { battle: afterEnemy, runState } = resolveEnemyTurn(
    afterFortify,
    run,
    CONFIG,
  );
  const expected = applyPercentReduction(
    8,
    CONFIG.spirits.pumpkinGuardian.fortifiedDefendReduction,
  );
  assert.equal(runState.battleHp, run.battleHp - expected);
  assert.equal(afterEnemy.defendActive, false); // cleared after resolving
});

test("tickPlayerCooldowns decrements lightning only on subsequent turns, never below zero", () => {
  assert.equal(
    tickPlayerCooldowns({ lightningCooldown: 2 }).lightningCooldown,
    1,
  );
  assert.equal(
    tickPlayerCooldowns({ lightningCooldown: 1 }).lightningCooldown,
    0,
  );
  // Already ready: returns the same reference (no-op).
  const ready = { lightningCooldown: 0 };
  assert.equal(tickPlayerCooldowns(ready), ready);
});

test("grantOrdinaryVictoryRewards awards Soul_Coins and counts the defeat (Req 6.1, 7.2)", () => {
  const run = freshRun();
  const next = grantOrdinaryVictoryRewards(run, CONFIG);
  assert.equal(
    next.soulCoins,
    run.soulCoins + CONFIG.ordinaryEnemy.victoryReward,
  );
  assert.equal(next.enemiesDefeated, (run.enemiesDefeated || 0) + 1);
  // Pure: the input is not mutated.
  assert.equal(run.soulCoins, 0);
});

test("possessionOffer explains both benefits and the replace/decline choice (Req 6.2, 6.6)", () => {
  const run = freshRun();
  const enemy = makeOrdinaryEnemy("A", CONFIG); // Storm_Bat reward
  const offer = possessionOffer(enemy, run);

  assert.equal(offer.offeredSpirit, "storm_bat");
  assert.ok(offer.offered.flight.length > 0);
  assert.ok(offer.offered.combat.length > 0);
  assert.equal(offer.currentSpirit, "none");
  assert.deepEqual(
    offer.choices.map((c) => c.id),
    ["replace", "decline"],
  );
});

test("possessionOffer returns null for the boss (no spirit to offer) (Req 6.1)", () => {
  const run = freshRun();
  assert.equal(possessionOffer({ isBoss: true }, run), null);
  assert.equal(possessionOffer({ spiritReward: undefined }, run), null);
});

test("applyPossessionChoice replace equips the offered spirit via possess (Req 6.2)", () => {
  const run = freshRun();
  const enemy = makeOrdinaryEnemy("B", CONFIG); // Pumpkin_Guardian reward
  const offer = possessionOffer(enemy, run);
  const after = applyPossessionChoice(run, offer, "replace", CONFIG);
  assert.equal(after.equippedSpirit, "pumpkin_guardian");
  // The one-time Pumpkin_Guardian shield gift is applied by possess().
  assert.equal(after.shieldCharges, 1);
  assert.equal(after.pumpkinShieldGiftUsed, true);
});

test("applyPossessionChoice decline keeps the current spirit unchanged (Req 6.2)", () => {
  const run = runWithSpirit("storm_bat");
  const enemy = makeOrdinaryEnemy("B", CONFIG);
  const offer = possessionOffer(enemy, run);
  const after = applyPossessionChoice(run, offer, "decline", CONFIG);
  assert.equal(after.equippedSpirit, "storm_bat"); // kept
  assert.equal(after, run); // same reference, nothing changed
});
