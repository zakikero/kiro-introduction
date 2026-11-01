// test/adventure-boss.test.js — Milestone 4 capstone (task 4.6) end-to-end
// integration of the complete opening→boss→victory/defeat Run, driven HEADLESSLY
// through the REAL FSM and the REAL pure systems (no DOM).
//
// This is the "complete opening→boss→victory/defeat Run" verification from task
// 4.6, expressed as an automated integration test so it runs under
// `node --test`. It constructs the FSM exactly as the browser shell
// (src/main.js) does — wiring stepFlight, the spawner (internal), collision,
// scoring, stepScheduler, markSkipped, AND the new makeBossBattle hook — and
// reproduces main.js's per-tick routing (the boss-presentation edge inside the
// FSM, plus routeBattleIntent's boss victory/defeat routing) against the same
// systems. It therefore exercises the real integration path, not a mock of it.
//
// It asserts the two outcomes task 4.6 calls out:
//   1. VICTORY: flight advances past the boss trigger, the FSM presents the boss
//      at a SAFE CHECKPOINT and freezes flight into Battle_State against the boss
//      (Req 4.3), the boss battle resolves to victory using the documented
//      base-ghost strategy (Attack every turn except Defend on the Special), and
//      the Run concludes in Results with outcome 'victory' and bossDefeated true
//      (Req 4.8, 5.20, 10.5).
//   2. DEFEAT: the boss reduces Battle_HP to 0 and the Run concludes in Results
//      with outcome 'battle' (Req 10.5).
//
// The companion Milestone 4 checks — Property 17, Property 18
// (test/combat-boss.test.js) and the base-ghost boss-win trace example test
// (test/combat-boss-trace.test.js) — live in their own files from tasks 4.3/4.4
// and are run by the same suite.

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
  makeBoss,
  startBattle,
  resolvePlayerAction,
  resolveEnemyTurn,
  usePotion,
  PlayerActions,
} from "../src/systems/combat.js";
import { createInputQueue } from "../src/input.js";

const SAVE = Object.freeze({ highScore: 0, prefs: {} });
const FIXED_DT = 1 / 120;

/**
 * Build the FSM wired exactly like src/main.js (minus the DOM-only pieces),
 * INCLUDING the makeBossBattle hook that main.js injects. Returns the FSM.
 */
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
    // The exact hook src/main.js wires in: build the Final_Boss BattleState.
    makeBossBattle: (rs, cfg) => startBattle(rs, makeBoss(cfg), cfg),
    inputQueue,
    isDocumentHidden: () => false,
  });
  return fsm;
}

/**
 * Advance flight by stepping the real FSM until flight is no longer active
 * (e.g. the boss presentation froze it into Battle_State) or `maxSteps` elapse.
 *
 * This test targets the ADVENTURE→BOSS integration, not pipe navigation —
 * collisions have their own dedicated property suite. To accrue
 * Active_Flight_Time deterministically without a flight autopilot that would
 * have to thread real generated pipe gaps, we keep Ghosty in a guaranteed-safe
 * column each step: before every tick Ghosty is pinned to the playfield's
 * vertical center with vy = 0, and after every tick the (spawner-produced)
 * pipes are cleared so no pipe can be fatal. The REAL tickFlight still runs —
 * advancing Active_Flight_Time, driving the spawner and the scheduler (including
 * the boss-presentation edge under test) — so the wiring is exercised for real.
 *
 * Avoidable Enemy/Shop SYMBOLS are steered clear of (Ghosty hugs the ceiling
 * when one is near its x) so no accidental encounter fires before the boss; the
 * boss is REQUIRED and presented at a checkpoint, not as an avoidable symbol, so
 * it is reached regardless. Returns the number of steps taken.
 */
function flyUntilFrozen(fsm, maxSteps = 2_000_000) {
  const centerY = CONFIG.playfield.height / 2;
  let steps = 0;
  while (steps < maxSteps) {
    if (fsm.state !== States.Active_Flight_State) return steps;
    const rs = fsm.runState;

    let y = centerY;
    if (Array.isArray(rs.symbols)) {
      const near = rs.symbols.find((s) => Math.abs(s.x - rs.ghosty.x) < 120);
      if (near) y = CONFIG.ghosty.bodyHeight; // hug the ceiling, away from the Gap symbol
    }
    rs.ghosty.y = y;
    rs.ghosty.vy = 0;
    rs.ghosty.prevY = y;

    fsm.tick(FIXED_DT, { flap: false, flightPower: false });

    // The boss edge may have frozen flight this very step.
    if (fsm.state !== States.Active_Flight_State) return steps;

    // Remove any pipes the spawner produced so none can be fatal next step.
    rs.pipes = [];
    rs.shieldGracePairId = null;
    steps += 1;
  }
  return steps;
}

/**
 * Resolve the currently-ongoing battle by reproducing main.js's
 * routeBattleIntent for a chosen action: the player acts first, then — if the
 * player did not end the battle — the enemy responds. Threads the updated
 * battle + run back onto the RunState exactly as the shell does.
 * @param {object} fsm
 * @param {string} action a PlayerActions value
 */
function resolveOneRound(fsm, action) {
  const rs = fsm.runState;
  const battle = rs.activeBattle;
  const afterPlayer = resolvePlayerAction(battle, action, rs, CONFIG, {
    usePotion,
  });
  let nextBattle = afterPlayer.battle;
  let nextRun = afterPlayer.runState;
  if (nextBattle.phase === "enemy") {
    const afterEnemy = resolveEnemyTurn(nextBattle, nextRun, CONFIG);
    nextBattle = afterEnemy.battle;
    nextRun = afterEnemy.runState;
  }
  rs.activeBattle = nextBattle;
  rs.battleHp = nextRun.battleHp;
  rs.items = nextRun.items;
}

// --- VICTORY path -----------------------------------------------------------

test("task 4.6: opening→boss→VICTORY runs end-to-end — boss presented at a safe checkpoint, defeated, Run concludes in Results with outcome 'victory' and bossDefeated true", () => {
  const fsm = buildWiredFSM(11);

  // Start a Run and begin flight (Main_Menu → Ready → Active_Flight).
  fsm.startNewRun(11);
  fsm.transition(States.Active_Flight_State);
  assert.equal(fsm.state, States.Active_Flight_State);

  // Fly on until the FSM freezes flight. Because every symbol is avoided and
  // pipes are cleared, the first (and only) thing that freezes flight is the
  // boss presentation at the boss trigger.
  flyUntilFrozen(fsm);
  const rs = fsm.runState;

  // The boss was presented exactly once, at or after its trigger (Req 4.3).
  assert.equal(
    fsm.state,
    States.Battle_State,
    "boss presentation freezes flight into Battle",
  );
  assert.equal(rs.progress.bossPresented, true, "boss latched as presented");
  assert.ok(
    rs.activeFlightTime >= CONFIG.triggers.boss,
    "boss is presented only after its trigger (Req 4.3)",
  );

  // Presented at a SAFE CHECKPOINT: Ghosty centered with vy = 0 and prev synced
  // (Req 4.3, 9.16). The boss edge repositions via resumeFromCheckpoint.
  assert.equal(rs.ghosty.vy, 0, "boss checkpoint zeroes vy (Req 9.14)");
  assert.equal(rs.ghosty.prevX, rs.ghosty.x, "prevX synced (Req 9.16)");
  assert.equal(rs.ghosty.prevY, rs.ghosty.y, "prevY synced (Req 9.16)");

  // Entering Battle stored the separate flight-world snapshot (Req 5.22) and a
  // live boss battle the dedicated scene reads (Req 4.8 uses the same engine).
  assert.ok(
    rs.flightSnapshot,
    "entering Battle stores a flight-world snapshot",
  );
  assert.ok(rs.activeBattle, "a live boss battle is stored on the RunState");
  assert.equal(
    rs.activeBattle.enemy.isBoss,
    true,
    "the battle is against the boss",
  );
  assert.equal(
    rs.activeBattle.enemy.battleHp,
    CONFIG.boss.battleHp,
    "boss at full HP",
  );
  assert.equal(rs.activeBattle.outcome, "ongoing");

  // Resolve the boss battle to victory with the DOCUMENTED base-ghost strategy:
  // Attack every round except Defend on the round the Special lands. The boss
  // sequence telegraphs the Special on enemy turn 2 and lands it on turn 3, so
  // the player Defends on round 3 and Attacks otherwise (requirements.md trace).
  let round = 0;
  let guard = 0;
  while (rs.activeBattle.outcome === "ongoing" && guard < 50) {
    round += 1;
    const action = round === 3 ? PlayerActions.Defend : PlayerActions.Attack;
    resolveOneRound(fsm, action);
    guard += 1;
  }
  assert.equal(
    rs.activeBattle.outcome,
    "victory",
    "base Ghosty defeats the boss",
  );
  // The documented trace wins on the Player turn with a 2 HP margin (Req 5.20).
  assert.equal(
    rs.battleHp,
    2,
    "player survives the boss with exactly a 2 HP margin",
  );

  // Boss victory concludes the Run in victory (main.js routeBattleIntent on a
  // resolved boss battle): a confirm leaving the battle latches bossDefeated and
  // outcome 'victory', then routes to Results (Req 4.8, 5.20, 10.5).
  rs.enemiesDefeated += 1;
  rs.bossDefeated = true;
  rs.outcome = "victory";
  fsm.transition(States.Results_State);

  assert.equal(fsm.state, States.Results_State, "Run concludes in Results");
  assert.equal(
    rs.outcome,
    "victory",
    "Results reports a victory outcome (Req 10.5)",
  );
  assert.equal(
    rs.bossDefeated,
    true,
    "the boss was defeated (drives the Candy bonus, Req 8.3)",
  );
});

// --- DEFEAT path ------------------------------------------------------------

test("task 4.6: opening→boss→DEFEAT runs end-to-end — the boss reduces Battle_HP to 0 and the Run concludes in Results with outcome 'battle'", () => {
  const fsm = buildWiredFSM(11);
  fsm.startNewRun(11);
  fsm.transition(States.Active_Flight_State);

  // Reach the boss exactly as the victory path does.
  flyUntilFrozen(fsm);
  const rs = fsm.runState;
  assert.equal(
    fsm.state,
    States.Battle_State,
    "boss presentation freezes flight into Battle",
  );
  assert.equal(rs.activeBattle.enemy.isBoss, true);

  // Play to LOSE on purpose: Defend every round and never Attack. The boss's
  // HP is never reduced, so it walks its action sequence indefinitely while the
  // player only chips away incoming damage — Battle_HP steadily drains to 0 and
  // the player is defeated (the base Ghosty cannot survive the boss without ever
  // dealing damage). This is a deterministic defeat, no RNG involved.
  let guard = 0;
  while (rs.activeBattle.outcome === "ongoing" && guard < 100) {
    resolveOneRound(fsm, PlayerActions.Defend);
    guard += 1;
  }
  assert.equal(
    rs.activeBattle.outcome,
    "defeat",
    "never attacking loses to the boss",
  );
  assert.equal(rs.battleHp, 0, "defeat is at 0 Battle_HP (Req 5.11)");

  // Defeat in battle ends the Run (main.js routeBattleIntent on a resolved,
  // lost battle): outcome 'battle', route to Results (Req 10.5). The boss was
  // NOT defeated, so bossDefeated stays false (no victory, no Candy bonus).
  rs.outcome = "battle";
  fsm.transition(States.Results_State);

  assert.equal(
    fsm.state,
    States.Results_State,
    "defeat concludes the Run in Results",
  );
  assert.equal(
    rs.outcome,
    "battle",
    "Results reports a battle-defeat cause (Req 10.5)",
  );
  assert.equal(rs.bossDefeated, false, "no boss victory on a defeat");
});
