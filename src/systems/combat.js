// systems/combat.js — the turn-based combat engine (pure logic, no DOM).
//
// Combat is the game's third clock (state.js, clock (c)): it advances by
// RESOLVED TURNS, never by seconds (Req 5.8). A round is one Player turn
// followed by one enemy turn, with the Player acting first (Req 5.13), unless
// the battle already ended on the Player turn — in which case the enemy does
// not get its turn that round (Req 5.14, 5.6).
//
// This task (2.2) implements the engine for ONE ORDINARY enemy:
//   - startBattle       — build a fresh BattleState against an enemy
//   - resolvePlayerAction — resolve the Player's chosen action (acts first)
//   - resolveEnemyTurn  — resolve the enemy's response (skipped if battle ended)
//   - applyPercentReduction — the shared percentage-reduction rounding (Req 5.15)
//
// Supported Player actions here: Attack, Defend, and Use Item. Defend applies
// the configured reduction to the NEXT incoming enemy attack only and clears
// after that attack resolves (Req 5.7). "Use Item" (the potion) is wired as a
// clean integration point: the real potion effect (healing, cap, inventory)
// lands in task 2.5 via a `usePotion` hook injected into `resolvePlayerAction`.
// Until that hook is supplied, selecting Use Item is treated as an action that
// cannot currently be performed and is rejected as invalid (no turn, no item
// consumed — Req 5.5), exactly like any other unavailable action.
//
// Boss-only behavior (the enemy-action sequence, telegraph/special, boss
// cooldown) and spirit moves are OTHER tasks. This engine keeps the
// BattleState shape from design.md exact so those tasks slot in without rework:
// `resolvedPlayerTurns`/`resolvedEnemyTurns`, `defendActive`/`defendPercent`,
// `bossActionIndex`/`bossSpecialCooldown`/`bossSpecialTelegraphed`, `outcome`,
// `phase`, `round`, and `log` are all present from the start.
//
// Purity: every function returns a NEW BattleState (and, where relevant, reads
// the owning RunState) and never mutates its inputs, so cooldown ownership on
// the Run (Req 5.20) and the frozen flight world (Req 5.22) are never touched
// here. Battle_HP carries on the RunState between encounters (Req 5.2); this
// module writes the player's Battle_HP back onto a returned RunState only when
// an enemy attack lands, leaving the caller to persist it.

import { possess, spiritBenefits } from "./spirits.js";

/**
 * The player actions this engine understands. `SpiritMove` is the single
 * action id for whichever move the equipped Spirit provides — the engine
 * dispatches it to the Storm_Bat lightning strike or the Pumpkin_Guardian
 * fortified defend based on `runState.equippedSpirit` (Req 5.3). A base Ghosty
 * (no spirit) has no spirit move, so selecting it is rejected as invalid.
 * @readonly
 * @enum {string}
 */
export const PlayerActions = Object.freeze({
  Attack: "attack",
  Defend: "defend",
  UseItem: "use_item",
  SpiritMove: "spirit",
});

/**
 * The combat move the equipped Spirit provides, or `null` for base Ghosty or an
 * unknown spirit (Req 6.6, 6.7, 6.8). Storm_Bat offers the lightning strike;
 * Pumpkin_Guardian offers the fortified defend. Pure and config-free: it only
 * names the move so `resolvePlayerAction` can dispatch and the UI can label the
 * Spirit action. The spirit move is only offered/available when this returns a
 * move (Req 5.3).
 * @param {object} runState the active RunState (reads `equippedSpirit`)
 * @returns {'lightning' | 'fortify' | null}
 */
export function spiritMoveFor(runState) {
  const spirit = runState && runState.equippedSpirit;
  if (spirit === "storm_bat") return "lightning";
  if (spirit === "pumpkin_guardian") return "fortify";
  return null;
}

/**
 * Whether the Storm_Bat lightning move is currently usable: the equipped Spirit
 * must provide it AND its cooldown (owned on `runState.lightningCooldown`, 0 =
 * ready) must have elapsed (Req 5.17, 5.20). Selecting lightning while on
 * cooldown is an invalid action — no turn, no cooldown change (Req 5.5, 5.16).
 * @param {object} runState the active RunState
 * @returns {boolean}
 */
export function lightningReady(runState) {
  return (
    spiritMoveFor(runState) === "lightning" &&
    (runState.lightningCooldown || 0) <= 0
  );
}

/**
 * Apply a fractional damage reduction and round the result DOWN to the nearest
 * whole HP, with a minimum of zero (Req 5.15). This is the single rounding rule
 * every percentage reduction in combat uses (Defend 50%, fortified 75%), so
 * outcomes stay deterministic.
 *
 * @param {number} raw the raw (pre-reduction) damage
 * @param {number} percent the fraction to remove, in [0, 1] (0.5 = 50% off)
 * @returns {number} max(0, floor(raw * (1 - percent)))
 */
export function applyPercentReduction(raw, percent) {
  return Math.max(0, Math.floor(raw * (1 - percent)));
}

/**
 * Build a fresh Enemy for an ordinary encounter from config (design Data
 * Models → Enemy). Ordinary enemies of type 'A' (Storm_Bat) and 'B'
 * (Pumpkin_Guardian) share the ordinary battle numbers; only the spirit reward
 * differs. The boss is built elsewhere.
 *
 * @param {'A' | 'B'} type the ordinary enemy type
 * @param {object} config the frozen CONFIG
 * @returns {object} an Enemy
 */
export function makeOrdinaryEnemy(type, config) {
  const hp = config.ordinaryEnemy.battleHp;
  return {
    type,
    battleHp: hp,
    maxBattleHp: hp,
    attackDamage: config.ordinaryEnemy.attackDamage,
    spiritReward: type === "A" ? "storm_bat" : "pumpkin_guardian",
    isBoss: false,
  };
}

/**
 * Build the Final_Boss Enemy from config (design Data Models → Enemy; Req 5.12,
 * Configurable Initial Defaults Final_Boss rows). The boss uses the SAME combat
 * system as ordinary enemies but is distinguished by `isBoss: true` so
 * {@link resolveEnemyTurn} drives it through the configured enemy-action
 * sequence (telegraph/special) instead of a flat attack (Req 5.18, 5.19).
 *
 * The boss carries two attack values: `attackDamage` is its NORMAL hit and
 * `specialDamage` is the telegraphed special. It grants no Spirit reward
 * (`spiritReward: null`) because defeating it ends the Run in victory rather
 * than offering Possession (Req 6.1 gates on ordinary victories).
 *
 * @param {object} config the frozen CONFIG
 * @returns {object} the Final_Boss Enemy
 */
export function makeBoss(config) {
  const hp = config.boss.battleHp;
  return {
    type: "boss",
    battleHp: hp,
    maxBattleHp: hp,
    attackDamage: config.boss.normalDamage,
    specialDamage: config.boss.specialDamage,
    spiritReward: null,
    isBoss: true,
  };
}

/**
 * Build a fresh BattleState against `enemy` (Req 5.13, design Data Models →
 * BattleState). The battle opens on the Player's turn (Player acts first) with
 * the enemy at full Battle_HP.
 *
 * Crucially this NEVER refills or resets a Player ability cooldown (Req 5.20):
 * those cooldowns are owned by `runState` (e.g. `runState.lightningCooldown`),
 * not by the BattleState, so simply creating a battle leaves them untouched.
 * `startBattle` reads from `runState` but does not mutate it. For a boss the
 * action-sequence index starts at 0; it is unused by the ordinary engine here.
 *
 * @param {object} runState the owning RunState (read-only here)
 * @param {object} enemy the Enemy to fight (see {@link makeOrdinaryEnemy})
 * @param {object} config the frozen CONFIG
 * @returns {object} a fresh BattleState
 */
export function startBattle(runState, enemy, config) {
  // Clone the enemy so the battle owns its own mutable Battle_HP; the caller's
  // enemy template is never mutated.
  const battleEnemy = { ...enemy };

  return {
    enemy: battleEnemy,
    round: 1,
    phase: "player", // Player acts first (Req 5.13)
    resolvedPlayerTurns: 0, // drives player ability cooldowns (Req 5.16)
    resolvedEnemyTurns: 0, // drives boss ability cooldowns (Req 5.16)
    defendActive: false, // no Defend queued yet (Req 5.7)
    defendPercent: config.combat.defendReduction, // 0.50 base; fortified set by spirit task
    // Boss-only fields kept present so the boss task slots in with no reshape.
    bossActionIndex: 0,
    bossSpecialCooldown: 0,
    bossSpecialTelegraphed: false,
    outcome: "ongoing", // 'ongoing' | 'victory' | 'defeat'
    log: [],
  };
}

/**
 * Whether a battle has already ended (victory or defeat). Once ended no further
 * action or enemy turn may resolve.
 * @param {object} battle
 * @returns {boolean}
 */
function isEnded(battle) {
  return battle.outcome !== "ongoing";
}

/**
 * Resolve the Player's chosen action. The Player acts FIRST in a round (Req
 * 5.13). A valid action consumes exactly one Player turn (Req 5.4); an invalid
 * or cancelled action consumes neither a turn nor an item and leaves state
 * otherwise unchanged (Req 5.5). If the action reduces the enemy to zero
 * Battle_HP the battle ends in victory with no enemy counterattack (Req 5.6).
 *
 * Returns a NEW BattleState (and, for Use Item, a possibly-updated RunState via
 * the injected `usePotion` hook — task 2.5). Nothing is mutated in place.
 *
 * Supported actions:
 *   - Attack: deal the Player's current Attack damage to the enemy.
 *   - Defend: queue the configured reduction against the NEXT incoming enemy
 *     attack only; it clears after that attack resolves (Req 5.7). Defending
 *     still consumes the Player's turn so the enemy responds afterward.
 *   - Use Item: delegated to `options.usePotion` (task 2.5). Without that hook,
 *     or when it reports the potion could not be used, the selection is treated
 *     as invalid — no turn, no item (Req 5.5, matching the disabled-potion rule
 *     Req 5.25).
 *
 * The turn counter (`resolvedPlayerTurns`) increments ONLY when a turn is
 * actually consumed, so later cooldown work can count per-owner resolved turns
 * (Req 5.16). After a consumed, non-victorious player turn the phase advances to
 * 'enemy' so {@link resolveEnemyTurn} can respond.
 *
 * @param {object} battle the current BattleState
 * @param {string} action a {@link PlayerActions} value
 * @param {object} runState the owning RunState (Battle_HP, attackDamage, items)
 * @param {object} config the frozen CONFIG
 * @param {object} [options]
 * @param {(runState: object, battle: object, config: object) => { runState: object, battle: object, ok: boolean, reason?: string }} [options.usePotion]
 *   the potion hook (task 2.5). When present it performs the heal/inventory
 *   work and reports whether a turn should be consumed via `ok`.
 * @returns {{ battle: object, runState: object }} the next BattleState and
 *   (possibly updated) RunState. On an invalid/cancelled action both are
 *   returned unchanged.
 */
export function resolvePlayerAction(
  battle,
  action,
  runState,
  config,
  options = {},
) {
  // Reject anything once the battle is over, or when it is not the Player's
  // turn, or for an unknown action — no turn, no item (Req 5.5).
  if (isEnded(battle) || battle.phase !== "player") {
    return { battle, runState };
  }

  if (action === PlayerActions.Attack) {
    const damage = runState.attackDamage;
    const enemyHp = Math.max(0, battle.enemy.battleHp - damage);
    const nextEnemy = { ...battle.enemy, battleHp: enemyHp };
    // This resolved player turn advances the lightning cooldown (Req 5.16): the
    // decrement happens on subsequent turns, never the one that starts it.
    const cooledRun = tickPlayerCooldowns(runState);

    if (enemyHp === 0) {
      // Victory ends the battle immediately — the enemy takes NO counterattack
      // (Req 5.6). The turn is still a resolved Player turn.
      return {
        battle: {
          ...battle,
          enemy: nextEnemy,
          phase: "ended",
          outcome: "victory",
          resolvedPlayerTurns: battle.resolvedPlayerTurns + 1,
          log: [...battle.log, `Player attacks for ${damage}. Enemy defeated.`],
        },
        runState: cooledRun,
      };
    }

    // Enemy survived: a full round continues into the enemy turn.
    return {
      battle: {
        ...battle,
        enemy: nextEnemy,
        phase: "enemy",
        resolvedPlayerTurns: battle.resolvedPlayerTurns + 1,
        log: [...battle.log, `Player attacks for ${damage}.`],
      },
      runState: cooledRun,
    };
  }

  if (action === PlayerActions.Defend) {
    // Queue the configured Defend reduction against the next incoming attack
    // (Req 5.7). Still a consumed turn, so the enemy responds afterward and the
    // lightning cooldown advances by this resolved turn (Req 5.16).
    return {
      battle: {
        ...battle,
        defendActive: true,
        defendPercent: config.combat.defendReduction,
        phase: "enemy",
        resolvedPlayerTurns: battle.resolvedPlayerTurns + 1,
        log: [...battle.log, "Player defends."],
      },
      runState: tickPlayerCooldowns(runState),
    };
  }

  if (action === PlayerActions.SpiritMove) {
    return resolveSpiritMove(battle, runState, config);
  }

  if (action === PlayerActions.UseItem) {
    // Potion effect is owned by task 2.5's usePotion. Wire it defensively so
    // this engine does not depend on 2.5 landing first.
    const usePotion =
      typeof options.usePotion === "function" ? options.usePotion : null;

    if (!usePotion) {
      // No potion system wired in yet: treat as an unavailable action — no
      // turn, no item (Req 5.5).
      return { battle, runState };
    }

    const result = usePotion(runState, battle, config);

    // A failed/disabled potion use consumes neither a turn nor an item
    // (Req 5.25): return everything unchanged.
    if (!result || !result.ok) {
      return { battle, runState };
    }

    // A successful potion use consumes exactly one Player turn so the enemy
    // responds normally on the following enemy turn (Req 5.24). That resolved
    // turn also advances the lightning cooldown (Req 5.16).
    const healedRun = tickPlayerCooldowns(result.runState || runState);
    const basis = result.battle || battle;
    return {
      battle: {
        ...basis,
        phase: "enemy",
        resolvedPlayerTurns: basis.resolvedPlayerTurns + 1,
        log: [...basis.log, "Player uses a potion."],
      },
      runState: healedRun,
    };
  }

  // Unknown/cancelled action: consume nothing (Req 5.5).
  return { battle, runState };
}

/**
 * Advance the Player's per-ability cooldowns owned on the RunState by ONE
 * resolved Player turn (Req 5.16, 5.20). Returns a NEW RunState with each
 * cooldown decremented toward zero (floored at 0); the input is never mutated.
 *
 * This is called from every branch of {@link resolvePlayerAction} that CONSUMES
 * a player turn EXCEPT the branch that STARTS a cooldown (the lightning move):
 * a cooldown must not decrement on the very turn that starts it, nor on an
 * invalid/cancelled action (Req 5.16). Counting here — on each subsequent
 * resolved turn — makes the 2-turn lightning move block exactly the next two
 * resolved player turns and become available again on the turn after (Req 5.17).
 *
 * Only `lightningCooldown` exists today; adding another per-ability player
 * cooldown later means decrementing it here too.
 *
 * @param {object} runState the active RunState
 * @returns {object} a new RunState with player cooldowns advanced by one turn
 */
export function tickPlayerCooldowns(runState) {
  const lightningCooldown = Math.max(0, (runState.lightningCooldown || 0) - 1);
  // Nothing to change (already ready): return the same reference to avoid
  // needless allocation and keep "no-op" observable by identity in tests.
  if (lightningCooldown === (runState.lightningCooldown || 0)) {
    return runState;
  }
  return { ...runState, lightningCooldown };
}

/**
 * Resolve the equipped Spirit's combat move as the Player's turn (Req 5.3, 6.6,
 * 6.7, 6.8). Dispatches on {@link spiritMoveFor}:
 *
 *   - Storm_Bat → lightning strike: deals the configured lightning damage to
 *     the enemy and starts the configured lightning cooldown on the RunState
 *     (`lightningCooldown`, Req 5.17). The cooldown is NOT decremented on this
 *     starting turn (Req 5.16) — only subsequent resolved turns tick it down
 *     via {@link tickPlayerCooldowns}. Lightning is unavailable (invalid, no
 *     turn, no cooldown change — Req 5.5) while on cooldown (see
 *     {@link lightningReady}). Like Attack, a lethal strike ends the battle in
 *     victory with no enemy counterattack (Req 5.6).
 *   - Pumpkin_Guardian → fortified defend: queues the configured 75% reduction
 *     against the NEXT incoming enemy attack only, cleared after it resolves,
 *     reusing the existing Defend mechanism (`defendActive`/`defendPercent`) and
 *     {@link applyPercentReduction} (Req 5.7, 6.8). It still consumes the turn,
 *     so the enemy responds afterward, and this resolved turn ticks the
 *     lightning cooldown (harmless when no Storm_Bat cooldown is pending).
 *   - base Ghosty / no spirit move → invalid: consume nothing (Req 5.5).
 *
 * Returns a NEW BattleState and a (possibly updated) RunState; nothing is
 * mutated in place.
 *
 * @param {object} battle the current BattleState (player phase)
 * @param {object} runState the owning RunState (reads loadout, writes cooldown)
 * @param {object} config the frozen CONFIG
 * @returns {{ battle: object, runState: object }}
 */
function resolveSpiritMove(battle, runState, config) {
  const move = spiritMoveFor(runState);

  if (move === "lightning") {
    // On cooldown or not provided: invalid action, consume nothing (Req 5.5).
    if (!lightningReady(runState)) {
      return { battle, runState };
    }

    const damage = config.spirits.stormBat.lightningDamage;
    const enemyHp = Math.max(0, battle.enemy.battleHp - damage);
    const nextEnemy = { ...battle.enemy, battleHp: enemyHp };

    // Start the cooldown on the RunState (Req 5.20). This turn does NOT tick the
    // cooldown (Req 5.16): subsequent resolved turns decrement it.
    const nextRun = {
      ...runState,
      lightningCooldown: config.spirits.stormBat.lightningCooldown,
    };

    if (enemyHp === 0) {
      // Lethal strike ends the battle in victory, no counterattack (Req 5.6).
      return {
        battle: {
          ...battle,
          enemy: nextEnemy,
          phase: "ended",
          outcome: "victory",
          resolvedPlayerTurns: battle.resolvedPlayerTurns + 1,
          log: [
            ...battle.log,
            `Player calls down lightning for ${damage}. Enemy defeated.`,
          ],
        },
        runState: nextRun,
      };
    }

    return {
      battle: {
        ...battle,
        enemy: nextEnemy,
        phase: "enemy",
        resolvedPlayerTurns: battle.resolvedPlayerTurns + 1,
        log: [...battle.log, `Player calls down lightning for ${damage}.`],
      },
      runState: nextRun,
    };
  }

  if (move === "fortify") {
    // Fortified defend: 75% reduction to the next incoming attack only, cleared
    // after it resolves (Req 5.7, 6.8). Reuses the Defend mechanism with the
    // fortified percent so resolveEnemyTurn applies and clears it unchanged.
    return {
      battle: {
        ...battle,
        defendActive: true,
        defendPercent: config.spirits.pumpkinGuardian.fortifiedDefendReduction,
        phase: "enemy",
        resolvedPlayerTurns: battle.resolvedPlayerTurns + 1,
        log: [...battle.log, "Player raises a fortified guard."],
      },
      // Fortify is not Storm_Bat's turn-starting move, so this resolved turn
      // advances any pending lightning cooldown like any other ordinary turn.
      runState: tickPlayerCooldowns(runState),
    };
  }

  // No spirit move available (base Ghosty or unknown spirit): invalid (Req 5.5).
  return { battle, runState };
}

/**
 * Use one potion (Req 5.24, 5.25, 7.13, 7.14, 7.15, 7.16). This is the single
 * potion-effect implementation, shared by two callers:
 *
 *   - Battle_State: {@link resolvePlayerAction} invokes this as the Use Item
 *     hook. Here `battle` is the current BattleState. This function performs
 *     only the heal and the inventory decrement and reports success via `ok`;
 *     the TURN consumption (advancing to the enemy phase and incrementing
 *     `resolvedPlayerTurns`) is owned by `resolvePlayerAction`, so the enemy
 *     responds normally on the following enemy turn (Req 5.24). This keeps turn
 *     bookkeeping in one place and `usePotion` free of phase logic.
 *   - Shop_State: the caller passes `battle = null`. No combat turn is involved
 *     (Req 7.13); flight stays frozen and no Candy time accrues because this
 *     function never touches flight state or `activeFlightTime`.
 *
 * The potion heals up to the configured effect (`config.shop.potion.effect`,
 * +10) and is capped at the Run maximum Battle_HP (`maxBattleHp`), so it never
 * overheals. Exactly one potion is consumed per successful use (Req 7.16); a
 * single confirmed use is one consume regardless of duplicate/repeated input,
 * since each call corresponds to one confirmed action.
 *
 * It is a strict NO-OP — consuming nothing, Battle_HP unchanged — when the
 * Player owns zero potions OR is already at full Battle_HP (Req 5.25, 7.14). In
 * that case it returns `ok: false` with a `reason`, the SAME `runState` and
 * `battle` references unchanged, and the caller (combat or shop) must consume
 * neither a potion nor a turn. Never usable in Active_Flight_State: that is the
 * caller's responsibility (Req 7.15) — the flight code simply never calls this.
 *
 * Purity: on success a NEW RunState is returned with the healed Battle_HP and a
 * decremented `items.potion`; the input `runState` and `battle` are never
 * mutated. On a no-op the inputs are returned by reference, unchanged.
 *
 * @param {object} runState the owning RunState (reads/writes Battle_HP + items)
 * @param {object | null} battle the current BattleState in Battle_State, or
 *   `null` in Shop_State (no combat turn)
 * @param {object} config the frozen CONFIG
 * @returns {{ runState: object, battle: object | null, ok: boolean, reason?: string }}
 *   `ok: true` with the healed RunState (and the `battle` passed through
 *   unchanged) on a successful use; `ok: false` with a `reason` and the inputs
 *   unchanged when the potion cannot be used.
 */
export function usePotion(runState, battle, config) {
  const owned = runState.items ? runState.items.potion : 0;

  // No potion to spend: strict no-op (Req 5.25, 7.14).
  if (!owned || owned <= 0) {
    return { runState, battle, ok: false, reason: "no_potion" };
  }

  // Already at the Run maximum: the potion is disabled, nothing is consumed
  // (Req 5.25, 7.14). Healing would be zero, so there is no reason to spend it.
  if (runState.battleHp >= runState.maxBattleHp) {
    return { runState, battle, ok: false, reason: "full" };
  }

  // Heal up to the configured effect, capped at the Run maximum (Req 7.13).
  const effect = config.shop.potion.effect;
  const healedHp = Math.min(runState.maxBattleHp, runState.battleHp + effect);

  // Consume exactly one potion (Req 7.16) and write back the healed HP on a new
  // RunState; inputs stay untouched.
  const nextRun = {
    ...runState,
    battleHp: healedHp,
    items: { ...runState.items, potion: owned - 1 },
  };

  // In Shop_State `battle` is null and is simply passed back as null (no combat
  // turn, Req 7.13). In Battle_State the battle is returned unchanged here; the
  // caller consumes the player turn (Req 5.24).
  return { runState: nextRun, battle, ok: true };
}

/**
 * Resolve the enemy's turn (the second half of a round). This is SKIPPED if the
 * battle already ended on the Player turn (Req 5.14) — callers may invoke it
 * unconditionally and rely on this guard. On an ordinary enemy it deals the
 * enemy's attack damage, reduced by a queued Defend (Req 5.7), to the Player's
 * Battle_HP on the RunState. If that drops Battle_HP to zero the Run ends in
 * defeat (Req 5.11). Otherwise the round advances and the phase returns to the
 * Player for the next round.
 *
 * Defend is single-use: a queued Defend reduces exactly this one incoming
 * attack and is cleared after it resolves (Req 5.7), whether or not it fully
 * absorbed the hit.
 *
 * `resolvedEnemyTurns` increments whenever the enemy actually takes a turn, so
 * boss cooldown work (a later task) can count per-owner resolved turns
 * (Req 5.16). Battle_HP is written back onto a NEW RunState (carried between
 * encounters via the Run — Req 5.2); nothing is mutated in place.
 *
 * For the Final_Boss (`enemy.isBoss`) the attack is driven instead by the
 * configured enemy-action sequence (Req 5.18, 5.19) via
 * {@link resolveBossEnemyTurn}: a Telegraph turn deals no damage, a Special
 * turn deals the boss special damage, and Normal turns deal the boss normal
 * damage — all still reduced by a queued Defend and using the SAME turn/round
 * bookkeeping. A defeated boss takes no further turn and does not advance the
 * sequence (guarded here by the shared ended/phase check).
 *
 * @param {object} battle the current BattleState (expected phase 'enemy')
 * @param {object} runState the owning RunState (its Battle_HP is reduced)
 * @param {object} config the frozen CONFIG
 * @returns {{ battle: object, runState: object }} the next BattleState and the
 *   RunState with the Player's Battle_HP updated.
 */
export function resolveEnemyTurn(battle, runState, config) {
  // Battle ended on the Player turn (or earlier): the enemy takes no turn
  // (Req 5.14, 5.6, 5.19). A defeated boss therefore never takes a further
  // enemy turn and never advances `bossActionIndex`. Return unchanged.
  if (isEnded(battle) || battle.phase !== "enemy") {
    return { battle, runState };
  }

  // The Final_Boss follows the configured enemy-action sequence; ordinary
  // enemies use the flat attack below.
  if (battle.enemy.isBoss) {
    return resolveBossEnemyTurn(battle, runState, config);
  }

  const rawDamage = battle.enemy.attackDamage;

  // Apply a queued Defend to THIS attack only, then clear it (Req 5.7).
  const dealt = battle.defendActive
    ? applyPercentReduction(rawDamage, battle.defendPercent)
    : rawDamage;

  const nextHp = Math.max(0, runState.battleHp - dealt);
  const nextRun = { ...runState, battleHp: nextHp };

  const logEntry = battle.defendActive
    ? `Enemy attacks for ${rawDamage}, reduced to ${dealt} by Defend.`
    : `Enemy attacks for ${dealt}.`;

  if (nextHp === 0) {
    // Battle_HP reached zero: the Run ends in defeat (Req 5.11).
    return {
      battle: {
        ...battle,
        defendActive: false,
        phase: "ended",
        outcome: "defeat",
        resolvedEnemyTurns: battle.resolvedEnemyTurns + 1,
        log: [...battle.log, logEntry, "Player defeated."],
      },
      runState: nextRun,
    };
  }

  // Round complete: back to the Player for the next round.
  return {
    battle: {
      ...battle,
      defendActive: false,
      phase: "player",
      round: battle.round + 1,
      resolvedEnemyTurns: battle.resolvedEnemyTurns + 1,
      log: [...battle.log, logEntry],
    },
    runState: nextRun,
  };
}

/**
 * Resolve ONE Final_Boss enemy turn by walking the configured enemy-action
 * sequence (Req 5.18, 5.19). The current action is read from
 * `config.boss.actionSequence[battle.bossActionIndex]`; the index advances by
 * exactly one here because the boss is actually taking a turn (a defeated boss
 * never reaches this function — see the guard in {@link resolveEnemyTurn} — so
 * the index is never advanced for a skipped turn).
 *
 * Action handling:
 *   - 'telegraph' — deals NO attack damage and sets `bossSpecialTelegraphed`
 *     so the Player knows the Special lands on the next enemy turn (Req 5.18,
 *     5.19). The Player's Battle_HP is untouched this turn.
 *   - 'special'   — deals the boss special damage, reduced by a queued Defend
 *     (Req 5.7), clears `bossSpecialTelegraphed`, and starts the special
 *     cooldown (`bossSpecialCooldown = config.boss.specialCooldown`) counting
 *     the subsequent resolved enemy turns before the special may telegraph
 *     again (Req 5.18).
 *   - 'normal'    — deals the boss normal damage, reduced by a queued Defend.
 *
 * Boss ability cooldowns count SUBSEQUENT resolved enemy turns (Req 5.16): the
 * cooldown is NOT decremented on the Special turn that STARTS it, only on each
 * later enemy turn, floored at zero. This matches the explicit sequence — a
 * Special on enemy turn 3 leaves cooldown 3, decrements over enemy turns 4–6,
 * reaching 0 so the Telegraph on enemy turn 7 is consistent (Req 5.18).
 *
 * Turn/round bookkeeping, Defend reduction/clearing, and the defeat check are
 * identical to the ordinary path so the boss uses the SAME combat system.
 *
 * @param {object} battle the current BattleState (boss enemy, phase 'enemy')
 * @param {object} runState the owning RunState (its Battle_HP is reduced)
 * @param {object} config the frozen CONFIG
 * @returns {{ battle: object, runState: object }}
 */
function resolveBossEnemyTurn(battle, runState, config) {
  const sequence = config.boss.actionSequence;
  // Wrap defensively so the sequence can repeat past its listed length without
  // reading undefined; the configured sequence is authoritative for order.
  const action = sequence[battle.bossActionIndex % sequence.length];
  const nextIndex = battle.bossActionIndex + 1;

  // Advance the special cooldown by this SUBSEQUENT resolved enemy turn
  // (Req 5.16): never on the turn that starts it, which is handled on the
  // 'special' branch below by setting the fresh cooldown AFTER this decrement.
  const cooledDown = Math.max(0, (battle.bossSpecialCooldown || 0) - 1);

  // Common bookkeeping applied to every boss turn.
  const base = {
    ...battle,
    defendActive: false, // a queued Defend covers exactly this one attack
    bossActionIndex: nextIndex,
    bossSpecialCooldown: cooledDown,
    resolvedEnemyTurns: battle.resolvedEnemyTurns + 1,
  };

  if (action === "telegraph") {
    // Telegraph: no damage this turn; announce that the Special lands next
    // enemy turn (Req 5.18, 5.19). Battle_HP and the Run are unchanged.
    return {
      battle: {
        ...base,
        bossSpecialTelegraphed: true,
        phase: "player",
        round: battle.round + 1,
        log: [...battle.log, "Boss telegraphs its special attack."],
      },
      runState,
    };
  }

  // 'special' or 'normal' deal damage; everything else falls back to normal.
  const isSpecial = action === "special";
  const rawDamage = isSpecial
    ? battle.enemy.specialDamage
    : battle.enemy.attackDamage;

  const dealt = battle.defendActive
    ? applyPercentReduction(rawDamage, battle.defendPercent)
    : rawDamage;

  const nextHp = Math.max(0, runState.battleHp - dealt);
  const nextRun = { ...runState, battleHp: nextHp };

  const kind = isSpecial ? "special" : "normal";
  const logEntry = battle.defendActive
    ? `Boss uses its ${kind} attack for ${rawDamage}, reduced to ${dealt} by Defend.`
    : `Boss uses its ${kind} attack for ${dealt}.`;

  // On a Special turn the telegraph is consumed and the special cooldown starts
  // fresh (Req 5.18). Setting it AFTER `cooledDown` means it is NOT decremented
  // on the turn that starts it (Req 5.16).
  const specialFields = isSpecial
    ? {
        bossSpecialTelegraphed: false,
        bossSpecialCooldown: config.boss.specialCooldown,
      }
    : {};

  if (nextHp === 0) {
    // Battle_HP reached zero: the Run ends in defeat (Req 5.11).
    return {
      battle: {
        ...base,
        ...specialFields,
        phase: "ended",
        outcome: "defeat",
        log: [...battle.log, logEntry, "Player defeated."],
      },
      runState: nextRun,
    };
  }

  // Round complete: back to the Player for the next round.
  return {
    battle: {
      ...base,
      ...specialFields,
      phase: "player",
      round: battle.round + 1,
      log: [...battle.log, logEntry],
    },
    runState: nextRun,
  };
}

/**
 * Grant the rewards for an ordinary Battle just won (Req 6.1, 7.2). Awards the
 * configured Soul_Coin victory reward and increments the enemies-defeated
 * counter on a NEW RunState; inputs are never mutated. Battle_HP carries on the
 * Run unchanged (Req 5.2) — nothing here restores it.
 *
 * This is the "grant the normal rewards" step that MUST happen BEFORE the
 * Possession offer (Req 6.1); the FSM calls this on the ordinary-victory edge
 * into Reward_State, then presents {@link possessionOffer}. The boss grants no
 * Soul_Coins (it ends the Run), so this is for ordinary victories only — the
 * caller gates on `enemy.isBoss === false`.
 *
 * @param {object} runState the active RunState
 * @param {object} config the frozen CONFIG
 * @returns {object} a new RunState with the ordinary victory rewards applied
 */
export function grantOrdinaryVictoryRewards(runState, config) {
  return {
    ...runState,
    soulCoins: runState.soulCoins + config.ordinaryEnemy.victoryReward,
    enemiesDefeated: (runState.enemiesDefeated || 0) + 1,
  };
}

/**
 * Build the Possession offer presented in Reward_State after an ordinary
 * victory (Req 6.1, 6.2, 6.6). The offer names the defeated Enemy's Spirit and
 * explains BOTH its one Flight benefit and one combat benefit so the Player can
 * make an informed choice BEFORE possessing (Req 6.6), and states the two
 * choices: REPLACE the currently-equipped Spirit with the defeated Enemy's
 * Spirit, or DECLINE and keep the current Spirit (Req 6.2).
 *
 * Pure: returns a plain descriptor (no DOM); the Reward UI renders it and the
 * FSM applies the chosen action via {@link applyPossessionChoice}. Returns
 * `null` when there is no spirit to offer — a boss (no spirit reward) or an
 * enemy without a mapped reward — so the caller simply shows no offer.
 *
 * @param {{ spiritReward?: string, isBoss?: boolean }} enemy the defeated Enemy
 * @param {object} runState the active RunState (reads the current spirit)
 * @returns {{
 *   offeredSpirit: string,
 *   offered: { id: string, name: string, flight: string, combat: string },
 *   currentSpirit: string,
 *   choices: Array<{ id: 'replace'|'decline', label: string }>
 * } | null}
 */
export function possessionOffer(enemy, runState) {
  if (!enemy || enemy.isBoss) return null;
  const offeredSpirit = enemy.spiritReward;
  const benefits = spiritBenefits(offeredSpirit);
  if (!benefits) return null;

  return {
    offeredSpirit,
    // Both benefits are spelled out so the choice is informed (Req 6.6).
    offered: benefits,
    currentSpirit: (runState && runState.equippedSpirit) || "none",
    choices: [
      { id: "replace", label: `Possess ${benefits.name}` },
      { id: "decline", label: "Decline" },
    ],
  };
}

/**
 * Apply the Player's Possession choice from the Reward_State offer (Req 6.2).
 * On `'replace'`, equips the defeated Enemy's Spirit via {@link possess} (which
 * enforces the single-equipped-spirit rule, the one-time Pumpkin_Guardian
 * Shield gift, and never refills resources — Req 6.3, 6.8, 6.10, 6.11). On
 * `'decline'` (or any non-replace choice) the loadout is left exactly as it was
 * so the current Spirit is kept (Req 6.2).
 *
 * `possess` mutates-and-returns the RunState in place, matching the other pure
 * systems; declining returns the same RunState untouched.
 *
 * @param {object} runState the active RunState
 * @param {object} offer the descriptor from {@link possessionOffer}
 * @param {'replace'|'decline'} choice the Player's selection
 * @param {object} config the frozen CONFIG
 * @returns {object} the RunState after the choice
 */
export function applyPossessionChoice(runState, offer, choice, config) {
  if (choice === "replace" && offer && offer.offeredSpirit) {
    return possess(runState, offer.offeredSpirit, config);
  }
  // Decline / cancel: keep the current Spirit, change nothing (Req 6.2).
  return runState;
}

export default {
  PlayerActions,
  applyPercentReduction,
  makeOrdinaryEnemy,
  makeBoss,
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
};
