// test/combat-boss.test.js — property tests for combat cooldown ownership and
// the Final_Boss enemy-action sequence (task 4.3).
//
// Exercises the already-implemented src/systems/combat.js (makeBoss,
// startBattle, resolvePlayerAction, resolveEnemyTurn, tickPlayerCooldowns,
// lightningReady, PlayerActions) plus possession from src/systems/spirits.js.
//
// Properties (fast-check, never hand-rolled generators; min 100 iterations):
//
//   Property 17: Cooldowns advance only by resolved turns, by owner
//                — Validates: Requirements 5.8, 5.16, 5.17, 5.20
//   Property 18: Boss follows the explicit enemy-action sequence
//                — Validates: Requirements 5.8, 5.16, 5.17, 5.18, 5.19, 5.20
//
// These are pure-logic tests (no DOM) following the project's naming/iteration
// conventions via propertyName / assertProperty from test-support/helpers.js.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { createRunState } from "../src/state.js";
import {
  PlayerActions,
  makeBoss,
  makeOrdinaryEnemy,
  startBattle,
  resolvePlayerAction,
  resolveEnemyTurn,
  tickPlayerCooldowns,
  lightningReady,
} from "../src/systems/combat.js";
import { possess } from "../src/systems/spirits.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

// --- Helpers ---------------------------------------------------------------

function freshRun() {
  return createRunState(CONFIG, 0);
}

// Drive one full round: the player takes `action`, then — if the battle is
// still ongoing — the enemy responds. Returns the resulting battle + runState.
function playRound(battle, action, runState) {
  let { battle: b, runState: rs } = resolvePlayerAction(
    battle,
    action,
    runState,
    CONFIG,
  );
  if (b.outcome === "ongoing" && b.phase === "enemy") {
    ({ battle: b, runState: rs } = resolveEnemyTurn(b, rs, CONFIG));
  }
  return { battle: b, runState: rs };
}

// ===========================================================================
// Property 17: Cooldowns advance only by resolved turns, by owner
// Validates: Requirements 5.8, 5.16, 5.17, 5.20
//
// A player cooldown drops by one per SUBSEQUENT resolved player turn; a boss
// cooldown drops by one per SUBSEQUENT resolved enemy turn. Cooldowns never
// decrement on the turn that starts them, nor on an invalid/cancelled action,
// nor from real time. The 2-turn lightning move blocks exactly the next two
// resolved player turns (ready again on the turn after). Creating a BattleState
// or switching Spirits never refills or resets a player cooldown.
// ===========================================================================

test(
  propertyName(
    17,
    "Cooldowns advance only by resolved turns, by owner",
  ),
  () => {
    const CD = CONFIG.spirits.stormBat.lightningCooldown; // 2

    assertProperty(
      fc.property(
        // How many ordinary (non-lightning) player turns to take AFTER the
        // lightning move — enough to observe the cooldown drain to zero and
        // stay there.
        fc.integer({ min: 0, max: 6 }),
        // How many "invalid action" attempts to interleave; these must NEVER
        // move a cooldown.
        fc.integer({ min: 0, max: 4 }),
        // Whether we switch spirits mid-cooldown to prove switching never
        // refills or resets the player cooldown (Req 5.20).
        fc.boolean(),
        (subsequentTurns, invalidTries, switchSpirit) => {
          const run = freshRun();
          run.equippedSpirit = "storm_bat";

          // A beefy, harmless enemy so the battle never ends during the trace:
          // we want to observe many resolved turns cleanly.
          const enemy = makeOrdinaryEnemy("A", CONFIG);
          enemy.battleHp = 100000;
          enemy.maxBattleHp = 100000;
          enemy.attackDamage = 0;
          run.battleHp = 100000;

          // Creating the BattleState must not refill/reset the cooldown (5.20):
          // the Run begins with lightning ready (cooldown 0).
          let battle = startBattle(run, enemy, CONFIG);
          let rs = run;
          if (rs.lightningCooldown !== 0) return false;
          if (lightningReady(rs) !== true) return false;

          // --- Invalid actions before using lightning never move a cooldown.
          for (let i = 0; i < invalidTries; i++) {
            const before = rs.lightningCooldown;
            const res = resolvePlayerAction(
              battle,
              "not_a_real_action",
              rs,
              CONFIG,
            );
            // Unchanged references + no cooldown change (Req 5.5, 5.16).
            if (res.battle !== battle) return false;
            if (res.runState !== rs) return false;
            if (res.runState.lightningCooldown !== before) return false;
            battle = res.battle;
            rs = res.runState;
          }

          // --- Use the lightning move. The cooldown is SET to CD and is NOT
          //     decremented on the starting turn (Req 5.16, 5.17).
          ({ battle, runState: rs } = resolvePlayerAction(
            battle,
            PlayerActions.SpiritMove,
            rs,
            CONFIG,
          ));
          if (rs.lightningCooldown !== CD) return false; // starting turn: no tick
          if (lightningReady(rs) !== false) return false;
          // Finish the enemy half of this round (not a player turn → no tick).
          ({ battle, runState: rs } = resolveEnemyTurn(battle, rs, CONFIG));
          if (rs.lightningCooldown !== CD) return false; // enemy turn: no player tick

          // Optionally switch spirits here: switching must NOT refill/reset the
          // player cooldown (Req 5.20). Replace storm_bat then switch back so a
          // subsequent lightning test still makes sense.
          if (switchSpirit) {
            const cdBefore = rs.lightningCooldown;
            possess(rs, "pumpkin_guardian", CONFIG);
            if (rs.lightningCooldown !== cdBefore) return false;
            possess(rs, "storm_bat", CONFIG);
            if (rs.lightningCooldown !== cdBefore) return false;
          }

          // --- Each SUBSEQUENT resolved player turn drops the cooldown by one,
          //     floored at zero, and lightning becomes available again exactly
          //     on the turn after the two cooldown turns (Req 5.16, 5.17).
          for (let t = 1; t <= subsequentTurns; t++) {
            const before = rs.lightningCooldown;

            // Interleave invalid attempts — they must not move the cooldown.
            for (let i = 0; i < invalidTries; i++) {
              const res = resolvePlayerAction(battle, "bogus", rs, CONFIG);
              if (res.runState.lightningCooldown !== before) return false;
              if (res.battle !== battle || res.runState !== rs) return false;
            }

            ({ battle, runState: rs } = playRound(
              battle,
              PlayerActions.Attack,
              rs,
            ));

            const expected = Math.max(0, before - 1);
            if (rs.lightningCooldown !== expected) return false;

            // Ready again iff the cooldown has reached zero. With CD=2, that is
            // on the 2nd subsequent player turn and every turn after.
            if (lightningReady(rs) !== (expected <= 0)) return false;
            if (t === CD && rs.lightningCooldown !== 0) return false;
            if (t < CD && rs.lightningCooldown !== CD - t) return false;
          }

          return true;
        },
      ),
    );
  },
);

// Direct check of the per-turn tick helper used by the engine: it never moves
// a cooldown on an idle (already-ready) state and never goes below zero — the
// "subsequent resolved turn" semantics in isolation (Req 5.16).
test(
  propertyName(
    17,
    "tickPlayerCooldowns decrements by one per turn, floored at zero",
  ),
  () => {
    assertProperty(
      fc.property(fc.integer({ min: 0, max: 10 }), (cd) => {
        const next = tickPlayerCooldowns({ lightningCooldown: cd });
        if (cd <= 0) {
          // Already ready: no change, returned by reference (no-op).
          return next.lightningCooldown === 0;
        }
        return next.lightningCooldown === cd - 1 && next.lightningCooldown >= 0;
      }),
    );
  },
);

// ===========================================================================
// Property 18: Boss follows the explicit enemy-action sequence
// Validates: Requirements 5.8, 5.16, 5.17, 5.18, 5.19, 5.20
//
// Enemy actions follow Normal → Telegraph → Special → Normal → Normal →
// Normal → Telegraph → Special. The special is telegraphed the enemy turn
// before it lands (bossSpecialTelegraphed set on the Telegraph turn). A
// Telegraph turn deals NO damage (Battle_HP unchanged that turn). The special
// cooldown requires three subsequent resolved enemy turns before re-telegraph.
// A defeated boss takes no further turn and does not advance the sequence
// (bossActionIndex unchanged once the battle has ended).
// ===========================================================================

test(
  propertyName(18, "Boss follows the explicit enemy-action sequence"),
  () => {
    const SEQ = CONFIG.boss.actionSequence;
    const SPECIAL_CD = CONFIG.boss.specialCooldown; // 3
    const NORMAL = CONFIG.boss.normalDamage;
    const SPECIAL = CONFIG.boss.specialDamage;

    assertProperty(
      fc.property(
        // Number of enemy turns to walk through the sequence (cover the whole
        // listed sequence and a little beyond into its repeat).
        fc.integer({ min: 1, max: SEQ.length + 2 }),
        (enemyTurnsToWalk) => {
          const run = freshRun();
          // Huge Battle_HP so the boss never defeats the player mid-trace: we
          // are observing the full action sequence, telegraph/special timing,
          // and cooldown counting — not a defeat.
          run.battleHp = 100000;
          run.maxBattleHp = 100000;

          const boss = makeBoss(CONFIG);
          // Keep the boss alive through the whole trace: the player only pokes
          // it with 0 damage so the sequence is never cut short by victory.
          boss.battleHp = 100000;
          boss.maxBattleHp = 100000;
          run.attackDamage = 0;

          let battle = startBattle(run, boss, CONFIG);
          let rs = run;

          // Creating the BattleState starts the sequence at index 0 and arms no
          // telegraph/cooldown (Req 5.20).
          if (battle.bossActionIndex !== 0) return false;
          if (battle.bossSpecialTelegraphed !== false) return false;
          if (battle.bossSpecialCooldown !== 0) return false;

          let lastSpecialEnemyTurn = -1; // resolved-enemy-turn index of last Special

          for (let n = 0; n < enemyTurnsToWalk; n++) {
            const action = SEQ[battle.bossActionIndex % SEQ.length];
            const indexBefore = battle.bossActionIndex;
            const telegraphedBefore = battle.bossSpecialTelegraphed;

            // Player turn: a harmless attack so the enemy half runs.
            ({ battle, runState: rs } = resolvePlayerAction(
              battle,
              PlayerActions.Attack,
              rs,
              CONFIG,
            ));
            if (battle.phase !== "enemy") return false;

            const hpBeforeEnemy = rs.battleHp;
            ({ battle, runState: rs } = resolveEnemyTurn(battle, rs, CONFIG));

            // The index advanced by exactly one for an actually-taken turn.
            if (battle.bossActionIndex !== indexBefore + 1) return false;
            // resolvedEnemyTurns counts this turn (1-based now).
            const enemyTurn = battle.resolvedEnemyTurns;

            const dealt = hpBeforeEnemy - rs.battleHp;

            if (action === "telegraph") {
              // Telegraph: NO damage, and the special is announced for the next
              // enemy turn (Req 5.18, 5.19).
              if (dealt !== 0) return false;
              if (battle.bossSpecialTelegraphed !== true) return false;
            } else if (action === "special") {
              // The special lands the enemy turn AFTER the telegraph set the
              // flag (Req 5.18): it must have been telegraphed going in.
              if (telegraphedBefore !== true) return false;
              if (dealt !== SPECIAL) return false;
              // Telegraph consumed; special cooldown armed to SPECIAL_CD and NOT
              // decremented on the turn that started it (Req 5.16, 5.18).
              if (battle.bossSpecialTelegraphed !== false) return false;
              if (battle.bossSpecialCooldown !== SPECIAL_CD) return false;

              // Three subsequent resolved enemy turns must pass before the next
              // telegraph: the gap from this Special to the next Telegraph is
              // strictly more than the cooldown span.
              if (lastSpecialEnemyTurn >= 0) {
                const gap = enemyTurn - lastSpecialEnemyTurn;
                // In the configured sequence the Special→Special gap is 5 enemy
                // turns, comfortably beyond the 3-turn cooldown.
                if (gap <= SPECIAL_CD) return false;
              }
              lastSpecialEnemyTurn = enemyTurn;
            } else {
              // Normal: deals the boss normal damage, no telegraph pending.
              if (dealt !== NORMAL) return false;
              if (battle.bossSpecialTelegraphed !== false) return false;
            }
          }

          return true;
        },
      ),
    );
  },
);

// The special is telegraphed exactly one enemy turn before it lands, every time
// a Special appears in the configured sequence — a focused structural check of
// Req 5.18/5.19 across the whole listed sequence.
test(
  propertyName(
    18,
    "each Special is preceded by a Telegraph and the cooldown re-arms",
  ),
  () => {
    const SEQ = CONFIG.boss.actionSequence;
    for (let i = 0; i < SEQ.length; i++) {
      if (SEQ[i] === "special") {
        // Every Special in the sequence is immediately preceded by a Telegraph.
        assert.equal(
          SEQ[i - 1],
          "telegraph",
          `Special at index ${i} must be telegraphed on the prior enemy turn`,
        );
      }
    }
    // The configured cooldown is the three subsequent resolved enemy turns the
    // requirement names (Req 5.18).
    assert.equal(CONFIG.boss.specialCooldown, 3);
  },
);

// A defeated boss takes no further enemy turn and does not advance the sequence
// (Req 5.19): once the battle has ended, bossActionIndex stays put.
test(
  propertyName(
    18,
    "a defeated boss takes no further turn and does not advance the sequence",
  ),
  () => {
    assertProperty(
      fc.property(
        // Player attack large enough to one-shot the boss from full HP.
        fc.integer({ min: CONFIG.boss.battleHp, max: CONFIG.boss.battleHp + 50 }),
        (lethalAttack) => {
          const run = freshRun();
          run.attackDamage = lethalAttack;
          const boss = makeBoss(CONFIG);
          let battle = startBattle(run, boss, CONFIG);
          let rs = run;

          const indexBefore = battle.bossActionIndex;

          // Player's attack ends the battle in victory with no enemy turn.
          ({ battle, runState: rs } = resolvePlayerAction(
            battle,
            PlayerActions.Attack,
            rs,
            CONFIG,
          ));
          if (battle.outcome !== "victory") return false;
          if (battle.phase !== "ended") return false;
          // The enemy turn was skipped — sequence index unchanged (Req 5.14/5.19).
          if (battle.bossActionIndex !== indexBefore) return false;
          if (battle.resolvedEnemyTurns !== 0) return false;

          // Invoking the enemy turn anyway is a no-op: no damage, no index move.
          const hpBefore = rs.battleHp;
          const res = resolveEnemyTurn(battle, rs, CONFIG);
          if (res.battle.bossActionIndex !== indexBefore) return false;
          if (res.battle.resolvedEnemyTurns !== 0) return false;
          if (res.runState.battleHp !== hpBefore) return false;

          return true;
        },
      ),
    );
  },
);
