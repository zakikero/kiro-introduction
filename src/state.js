// state.js — the finite state machine (FSM) and the three-clock dispatch.
//
// This module centralizes two correctness-critical rules in ONE place instead
// of scattering flags across systems:
//
//   1. The three-clock model (Requirement 9.2, 9.3). Exactly one clock advances
//      per state, and NONE advances while the browser tab is hidden:
//        (a) flight simulation time — flight physics, obstacle movement and
//            spawning, flight collision checks, Active_Flight_Time accrual,
//            Hover duration and cooldown, and all Flight_Power/flight cooldowns
//            — advances ONLY in Active_Flight_State;
//        (b) the Resume countdown advances ONLY in Resume_Countdown_State while
//            the frozen flight world stays untouched;
//        (c) resolved combat turns/cooldowns advance ONLY in Battle_State, and
//            by resolved turns — never by seconds.
//      There is deliberately NO universal "everything freezes outside flight"
//      rule: Battle and the countdown keep their own clocks alive.
//
//   2. RunState creation and the started-flag semantics (Requirement 7.10,
//      7.11, 9.9): the complete RunState is built on the Ready -> first-flight
//      transition; `started` is false until the first Flap_Input begins flight,
//      and only a started Run finalizes rewards.
//
// Pure-ish: this is a primary headless test surface. It never touches the DOM
// directly. The tab-hidden check is INJECTABLE (`options.isDocumentHidden`) so
// Node tests can drive it without a `document`; in the browser the shell passes
// a predicate that reads `document.hidden`.

import { stepSpawner, currentScrollSpeed } from "./systems/spawner.js";
import { hitboxFor, groundCeilingFatal } from "./systems/collision.js";
import { resumeFromCheckpoint } from "./systems/checkpoint.js";

/**
 * The full set of game states (Requirement 9.1). Values are the canonical
 * `_State`-suffixed names used throughout the requirements and design so the
 * FSM, UI, and tests all speak the same vocabulary.
 * @readonly
 * @enum {string}
 */
export const States = Object.freeze({
  Main_Menu_State: "Main_Menu_State",
  Ready_State: "Ready_State",
  Active_Flight_State: "Active_Flight_State",
  Battle_State: "Battle_State",
  Reward_State: "Reward_State",
  Shop_State: "Shop_State",
  Pause_State: "Pause_State",
  Resume_Countdown_State: "Resume_Countdown_State",
  Results_State: "Results_State",
  Wardrobe: "Wardrobe",
});

/**
 * Allowed transitions between states. A transition not listed here is rejected
 * by {@link createFSM}'s `transition`. This mirrors the state diagram in the
 * design (State Machine, Freezing, and Resumption). Self-transitions are
 * disallowed; use the dedicated clock tick to stay in a state.
 * @type {Readonly<Record<string, string[]>>}
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  [States.Main_Menu_State]: [States.Ready_State, States.Wardrobe],
  [States.Wardrobe]: [States.Main_Menu_State],
  [States.Ready_State]: [States.Active_Flight_State],
  [States.Active_Flight_State]: [
    States.Pause_State,
    States.Battle_State,
    States.Shop_State,
    States.Results_State,
  ],
  [States.Battle_State]: [
    States.Reward_State,
    States.Results_State,
    States.Resume_Countdown_State,
  ],
  [States.Reward_State]: [States.Resume_Countdown_State],
  [States.Shop_State]: [States.Resume_Countdown_State],
  [States.Pause_State]: [States.Resume_Countdown_State, States.Results_State],
  [States.Resume_Countdown_State]: [
    States.Active_Flight_State,
    States.Pause_State,
  ],
  [States.Results_State]: [
    States.Ready_State,
    States.Main_Menu_State,
    States.Wardrobe,
  ],
});

/**
 * Build the complete initial RunState (Requirement 7.10, 7.11). Every field is
 * sourced from the central config so no tuning constant is defined here. The
 * shape matches design.md Data Models (RunState / ScheduleProgress /
 * LifecycleEntry / Ghosty) exactly.
 *
 * @param {object} config the frozen CONFIG
 * @param {number} [rngSeed] seed recorded on the Run for deterministic replay
 * @returns {object} a fresh RunState
 */
export function createRunState(config, rngSeed = 0) {
  const startingHp = config.combat.startingBattleHp;
  const center = config.ghosty.initialCenter;

  return {
    // --- flags / scoring / currencies ---
    started: false, // Req 9.9: false until the first Flap_Input begins flight
    pipeScore: 0,
    soulCoins: 0,
    battleHp: startingHp, // 22
    maxBattleHp: startingHp, // 22, per-Run cap for potions
    activeFlightTime: 0, // seconds; accrues ONLY in Active_Flight_State

    // --- loadout ---
    equippedSpirit: "none",
    shieldCharges: 0, // cap config.shieldCap (1)
    shieldGracePairId: null, // id of the pair currently under Shield_Grace, or null
    items: { potion: config.shop.potion.initialCount }, // { potion: 0 }
    attackUpgradePurchased: false,
    attackDamage: config.combat.playerBaseAttack, // 5

    // --- flight-power / hover cooldowns (all READY = 0) ---
    flightPowerCooldown: 0,
    hoverRemaining: 0,
    hoverCooldown: 0,

    // --- combat cooldowns owned by the Run (not refilled on battle/switch) ---
    lightningCooldown: 0,

    // --- per-run latches / counters ---
    pumpkinShieldGiftUsed: false,
    enemiesDefeated: 0,
    bossDefeated: false,
    finalized: false,

    // How this Run ended, recorded at the Run-ending edge so the Results_State
    // view can report the victory status or cause of defeat (Req 10.5). Null
    // while the Run is in progress (and for an unstarted Run cancelled from
    // pause). Codes: 'victory', 'pipe', 'ground-ceiling', 'battle', and 'ended'
    // for a started Run the player deliberately ended from the pause screen
    // (Req 9.8). Boss victory also sets `bossDefeated`.
    outcome: null,

    // --- adventure progression pointers at their starting positions ---
    progress: createScheduleProgress(),

    // --- flight world ---
    ghosty: {
      x: center.x, // 160; CENTER coordinate
      y: center.y, // 320; CENTER coordinate
      vy: config.ghosty.initialVelocityY, // 0; stationary until first flap
      prevX: center.x, // render-interpolation only
      prevY: center.y,
    },
    pipes: [],
    symbols: [], // avoidable optional Enemy/Shop symbols spawned by the scheduler
    lastGapCenter: null,
    rngSeed,

    // --- battle presentation ---
    // The separate frozen-flight-world snapshot taken on entering Battle_State
    // (Req 5.22). Null outside a Battle; set by the Active_Flight -> Battle edge.
    flightSnapshot: null,

    // The Possession offer presented in Reward_State after an ordinary victory
    // (Req 6.1, 6.2). Built by the shell on the victory edge and cleared when
    // the player answers it; null whenever no offer is pending.
    pendingOffer: null,
  };
}

/**
 * Capture a SEPARATE, structurally-cloned snapshot of the frozen flight world
 * at the moment a Battle begins (Req 5.22). This is deliberately a DEEP copy of
 * only the flight-world fields — Ghosty's exact kinematics, the obstacle set,
 * the spawn-scheduler pointers, and the RNG seed value — so that nothing the
 * battle scene does (and nothing the checkpoint path later does to `runState`)
 * can mutate the preserved world. The flight world is therefore guaranteed
 * unchanged when the Battle ends, exactly as the requirement states.
 *
 * It intentionally does NOT snapshot currencies, Battle_HP, inventory, shields,
 * cooldowns, or progress: those legitimately carry across the Battle on the live
 * RunState (Req 5.2, 9.4, 9.14) and must not be rolled back when flight resumes.
 *
 * @param {object} runState the active RunState
 * @returns {object} a deep, independent snapshot of the flight world
 */
export function snapshotFlightWorld(runState) {
  return {
    ghosty: { ...runState.ghosty },
    // Deep-clone each pair so a later `scored`/`shieldGrace` flip never leaks
    // back into the preserved world.
    pipes: Array.isArray(runState.pipes)
      ? runState.pipes.map((p) => ({ ...p }))
      : [],
    symbols: Array.isArray(runState.symbols)
      ? runState.symbols.map((s) => ({ ...s }))
      : [],
    lastGapCenter: runState.lastGapCenter,
    rngSeed: runState.rngSeed,
  };
}

/**
 * Build a fresh ScheduleProgress with every optional opportunity pending and
 * unspawned (design Data Models). The boss is required, not optional, so it has
 * a simple `bossPresented` boolean rather than a lifecycle entry.
 * @returns {object}
 */
function createScheduleProgress() {
  return {
    encounterA: createLifecycleEntry(0),
    shop1: createLifecycleEntry(1),
    encounterB: createLifecycleEntry(2),
    shop2: createLifecycleEntry(3),
    bossPresented: false,
  };
}

/**
 * Build a LifecycleEntry in its initial `pending`/unspawned state.
 * @param {number} id
 * @returns {{ id: number, state: string, spawned: boolean }}
 */
function createLifecycleEntry(id) {
  return { id, state: "pending", spawned: false };
}

/**
 * Create the finite state machine.
 *
 * @param {object} config the frozen CONFIG
 * @param {object} save the loaded SaveData (used for high score / prefs; the
 *   FSM never mutates it directly here — finalize handles persistence later)
 * @param {object} [options]
 * @param {() => boolean} [options.isDocumentHidden] predicate reporting whether
 *   the browser tab is hidden. Injectable so Node tests run headlessly; the
 *   browser shell passes `() => document.hidden`. Defaults to always-visible.
 * @param {object} [options.rng] seeded RNG instance (see rng.js) driving the
 *   spawner. Defaults to a no-op source if absent so the FSM still ticks.
 * @param {(runState: object, intents: any, dt: number, config: object) => object} [options.stepFlight]
 *   flight stepping fn (systems/flight.js, task 1.7). Wired in defensively so
 *   this task does not depend on 1.7 landing first.
 * @param {(prevBox:object, currBox:object, pipes:object[], runState:object, config:object) => object} [options.sweptHitboxVsPipes]
 *   swept collision check (systems/collision.js, task 1.11). Optional.
 * @param {(runState:object, config:object) => void} [options.stepScoring]
 *   scoring step (task 1.13). Optional.
 * @param {(progress:object, runState:object, activeFlightTime:number, config:object) => any} [options.stepScheduler]
 *   adventure scheduler (systems/scheduler.js, Milestone 2). Optional.
 * @param {(progress:object, entranceId:string, runState:object) => boolean} [options.markSkipped]
 *   scheduler lifecycle hook (systems/scheduler.js). Called when Ghosty passes
 *   an offered symbol without interacting, so it is marked `skipped` and never
 *   retriggers (Req 4.17). Optional.
 * @param {(runState:object, config:object) => object} [options.makeBossBattle]
 *   boss BattleState factory (systems/combat.js `makeBoss` + `startBattle`,
 *   Milestone 4). Injected defensively — like every other system hook — so the
 *   FSM has no hard dependency on combat.js and the headless three-clock tests
 *   (which wire no combat) still tick. When supplied, the FSM calls it on the
 *   boss-presentation edge to build the boss battle and stores the result on
 *   `runState.activeBattle` before freezing flight into Battle_State (Req 4.3,
 *   4.8). When absent, boss presentation is skipped (no-op), exactly as the
 *   other hooks degrade. Optional.
 * @param {(runState: object, save: object, config: object) => { save: object, finalized: boolean }} [options.finalizeRun]
 *   the Run-finalize path (systems/candy.js `finalizeRun`, task 5.1). Injected
 *   defensively like every other hook so the FSM never hard-depends on
 *   candy.js/save.js and the headless three-clock tests (which wire no finalize)
 *   still tick. When supplied, {@link endRun} calls it on the End Run edge out
 *   of Pause_State (Req 9.8) to award this Run's Candy and update the high score
 *   exactly once. It already awards NOTHING for an unstarted Run (`started ===
 *   false`, Req 9.9, 8.5), so the started/unstarted distinction lives in the
 *   pure layer, not the shell. Optional.
 * @param {{ transition: (scope: string) => void }} [options.inputQueue] the
 *   pure input queue (see input.js). When supplied, the FSM calls its
 *   `transition(toState)` on EVERY state change so the input that triggered the
 *   change is dropped at the boundary and cannot leak as a Flap_Input or any
 *   other action in the destination state (Req 9.6, 9.12, 10.7). The barrier is
 *   therefore automatic — the shell (main.js, task 1.22) only has to pass the
 *   queue in here. Any object exposing a `transition(scope)` method works, so
 *   tests can inject a spy.
 * @returns {object} the FSM
 */
export function createFSM(config, save, options = {}) {
  const isDocumentHidden =
    typeof options.isDocumentHidden === "function"
      ? options.isDocumentHidden
      : () => false;

  let rng = options.rng || null;

  // Optional pure input queue. When present its transition(scope) is invoked on
  // every FSM state change so the triggering input is dropped at the boundary
  // (the single-consumption barrier, Req 9.6, 9.12, 10.7). Guarded so the FSM
  // works headlessly with no queue wired in (as in the three-clock tests).
  const inputQueue =
    options.inputQueue && typeof options.inputQueue.transition === "function"
      ? options.inputQueue
      : null;

  // Optional system hooks. Each is wired defensively (task note): later tasks
  // slot their real implementation in via these options with no rework here.
  const stepFlight =
    typeof options.stepFlight === "function" ? options.stepFlight : null;
  const sweptHitboxVsPipes =
    typeof options.sweptHitboxVsPipes === "function"
      ? options.sweptHitboxVsPipes
      : null;
  const stepScoring =
    typeof options.stepScoring === "function" ? options.stepScoring : null;
  const stepScheduler =
    typeof options.stepScheduler === "function" ? options.stepScheduler : null;
  // Optional scheduler lifecycle hook: marks an offered opportunity `skipped`
  // once Ghosty passes its symbol without interacting (Req 4.17). Injected the
  // same defensive way as stepScheduler so the headless three-clock tests, which
  // wire no scheduler, still tick. When absent, skip detection no-ops.
  const markSkipped =
    typeof options.markSkipped === "function" ? options.markSkipped : null;
  // Optional boss BattleState factory (combat.js). Injected defensively like
  // every other hook so the FSM never hard-depends on combat.js and headless
  // tests that wire no combat still tick; when absent the boss-presentation
  // edge simply does not build a battle.
  const makeBossBattle =
    typeof options.makeBossBattle === "function"
      ? options.makeBossBattle
      : null;
  // Optional Run-finalize hook (systems/candy.js `finalizeRun`). Injected the
  // same defensive way as every other system hook so the FSM never hard-depends
  // on candy.js/save.js and the headless three-clock tests (which wire no
  // finalize) still tick. When supplied, `endRun()` calls it on the End Run edge
  // out of Pause_State to award this Run's Candy and update the high score
  // EXACTLY once (Req 9.8). It is idempotent on its own (the one-shot
  // `finalized` latch) and already awards NOTHING for an unstarted Run
  // (`started === false`, Req 9.9, 8.5), so the started/unstarted distinction is
  // handled entirely in the pure layer. When absent, End Run still transitions
  // to Results_State but performs no award.
  const finalizeRun =
    typeof options.finalizeRun === "function" ? options.finalizeRun : null;

  /** @type {string} current GameState enum value */
  let state = States.Main_Menu_State;
  /** @type {object|null} the active RunState, or null outside a Run */
  let runState = null;
  /** Resume countdown remaining in seconds (only meaningful in Resume_Countdown_State). */
  let countdownRemaining = 0;
  /** The state to enter when the countdown reaches zero. */
  let resumeTarget = States.Active_Flight_State;

  /**
   * Advance the flight-simulation clock by one step (clock (a)). This is the
   * ONLY place the flight world moves. Each sub-step is guarded so a system not
   * yet implemented (collision 1.11, scoring 1.13, scheduler) simply no-ops
   * rather than throwing.
   * @param {number} dt
   * @param {any} intents
   */
  function tickFlight(dt, intents) {
    if (!runState) return;

    // Capture the pre-step committed Hitbox for a swept collision check
    // (collision reads committed state only; interpolation never feeds it).
    const prevBox = hitboxFor(runState.ghosty, config);

    // 1. Flight physics + Hover + Normal_Flap (systems/flight.js, task 1.7).
    if (stepFlight) {
      runState = stepFlight(runState, intents, dt, config) || runState;
    }

    // 2. Obstacle movement / spawning (systems/spawner.js). The spawner is pure
    //    and already available; drive it from the Run's seeded RNG. Record how
    //    far the pipes scrolled LEFT this step so the swept collision check can
    //    reconstruct each pair's start-of-step x and never tunnel (Req 3.10).
    let scrollDistance = 0;
    if (rng) {
      const scrollSpeed = currentScrollSpeed(runState.activeFlightTime, config);
      scrollDistance = scrollSpeed * dt;
      const { pipes, lastGapCenter } = stepSpawner(
        runState.pipes,
        scrollSpeed,
        dt,
        rng,
        runState.lastGapCenter,
        config,
      );
      runState.pipes = pipes;
      runState.lastGapCenter = lastGapCenter;

      // 2b. Scroll the avoidable optional Enemy/Shop symbols LEFT with the
      //     world by the same distance as the pipes, so Ghosty can reach a
      //     spawned opportunity (it enters from the right edge) and so an
      //     untouched symbol eventually passes Ghosty. Symbols use CENTER x.
      if (Array.isArray(runState.symbols) && runState.symbols.length > 0) {
        for (const s of runState.symbols) {
          if (s && typeof s.x === "number") s.x -= scrollDistance;
        }
      }
    }

    // 3. Flight collision checks (systems/collision.js, task 1.11). A fatal
    //    outcome stops the flight clock and ends the Run before any scoring or
    //    encounter triggering (fatal-collision ordering, Req 3.11, 3.12, 3.13).
    //
    //    collision.js's real signature is
    //      sweptHitboxVsPipes(prevBox, currBox, pipes, shield, graceId, config, motion)
    //    and it is PURE: it reports the outcome plus which pipe to act on but
    //    never mutates shield counts or grace flags. The FSM owns those state
    //    deltas — consume exactly one charge + start Shield_Grace on a 'shield'
    //    outcome, end grace on `clearedGraceId`, and transition to Results on a
    //    'fatal' outcome. Ground and Ceiling are ALWAYS fatal (even shielded),
    //    checked separately on the committed end-of-step Hitbox (Req 3.5–3.7).
    const currBox = hitboxFor(runState.ghosty, config);

    // Ground/Ceiling is always fatal and the Shield never excuses it.
    if (groundCeilingFatal(currBox, config)) {
      runState.outcome = "ground-ceiling";
      transition(States.Results_State);
      return;
    }

    if (sweptHitboxVsPipes) {
      const result = sweptHitboxVsPipes(
        prevBox,
        currBox,
        runState.pipes,
        runState.shieldCharges,
        runState.shieldGracePairId,
        config,
        { scrollDistance },
      );

      if (result) {
        // End Shield_Grace once the hitbox has fully cleared the grace pair
        // (Req 3.3). Clear both the authoritative pointer and the pair flag.
        if (
          result.clearedGraceId != null &&
          runState.shieldGracePairId === result.clearedGraceId
        ) {
          const cleared = runState.pipes.find(
            (p) => p.id === result.clearedGraceId,
          );
          if (cleared) cleared.shieldGrace = false;
          runState.shieldGracePairId = null;
        }

        if (result.outcome === "fatal") {
          // Stop movement, scoring, and encounter triggering, then end the Run.
          runState.outcome = "pipe";
          transition(States.Results_State);
          return;
        }

        if (result.outcome === "shield") {
          // Consume exactly one charge and start Shield_Grace for that pair
          // (Req 3.1, 3.2) — capped at the single charge the shield ever holds.
          runState.shieldCharges = Math.max(0, runState.shieldCharges - 1);
          runState.shieldGracePairId = result.pipeId;
          const graced = runState.pipes.find((p) => p.id === result.pipeId);
          if (graced) graced.shieldGrace = true;
        }
      }
    }

    // 4. Active_Flight_Time accrual — the flight-sim clock itself (clock (a)).
    runState.activeFlightTime += dt;

    // 5. Scoring (task 1.13): award Pipe_Score for fully-passed pairs.
    if (stepScoring) stepScoring(runState, config);

    // 6. Adventure scheduler (Milestone 2 + 4): spawn avoidable encounters/shops
    //    as Active_Flight_Time crosses thresholds (does NOT freeze flight on
    //    spawn), and PRESENT the Final_Boss at the configured boss trigger
    //    (Req 4.3, 4.8). The scheduler only reports the boss presentation and
    //    the safe checkpoint it chose; the FSM owns the actual repositioning and
    //    the freeze into Battle_State so the three-clock model and the flight
    //    snapshot (taken on the Battle edge) stay authoritative.
    if (stepScheduler) {
      const sched = stepScheduler(
        runState.progress,
        runState,
        runState.activeFlightTime,
        config,
      );

      // Boss presentation edge (fires exactly once; the scheduler latches
      // `progress.bossPresented`). Build the boss battle and freeze flight into
      // Battle_State AT THE SAFE CHECKPOINT. We reposition via the same
      // `resumeFromCheckpoint` path every Battle/Reward/Shop exit uses — it
      // recomputes the identical safe checkpoint `selectCheckpoint` gave the
      // scheduler, centers Ghosty in a valid Gap with vy = 0, and syncs
      // prev/cur render positions so no interpolation artifact or false pass
      // occurs (Req 4.3, 9.16). A fatal collision earlier in this same step has
      // already returned, so a collision still wins over a same-step boss
      // presentation (fatal-collision ordering, Req 3.12).
      if (sched && sched.bossPresented && makeBossBattle) {
        resumeFromCheckpoint(runState, config);
        runState.activeBattle = makeBossBattle(runState, config);
        transition(States.Battle_State);
        return;
      }
    }

    // 7. Skip detection (Req 4.17). Any offered symbol whose body has fully
    //    scrolled PAST Ghosty's forgiving Hitbox (its right edge is left of the
    //    hitbox's left edge) was passed without interacting: mark it `skipped`
    //    so it never retriggers. markSkipped removes the symbol from the world,
    //    so we snapshot the list first and iterate the snapshot. Contact (which
    //    enters Battle/Shop) is handled by the shell before this step and marks
    //    the symbol `entered`, so a touched symbol is already gone from here.
    if (
      markSkipped &&
      Array.isArray(runState.symbols) &&
      runState.symbols.length > 0
    ) {
      const box = hitboxFor(runState.ghosty, config);
      const passed = runState.symbols.filter(
        (s) => s && typeof s.x === "number" && s.x + s.w / 2 < box.x,
      );
      for (const s of passed) {
        markSkipped(runState.progress, s.key, runState);
      }
    }
  }

  /**
   * Advance the Resume countdown clock by one step (clock (b)). This is the
   * ONLY place the countdown moves; the frozen flight world is untouched here.
   * @param {number} dt
   */
  function tickCountdown(dt) {
    countdownRemaining -= dt;
    if (countdownRemaining <= 0) {
      countdownRemaining = 0;
      transition(resumeTarget);
    }
  }

  /**
   * Handle a tab visibility / window focus loss EVENT (Req 9.7, 9.13). The
   * browser shell (main.js, task 1.22) wires this to `visibilitychange` (when
   * hidden) and `blur`. It is event-driven on purpose, separate from the steady
   * `isDocumentHidden()` poll in `tick`: a merely-throttled hidden tick only
   * stalls the clocks (Req 9.3), whereas the discrete loss-of-visibility event
   * forces a state change here.
   *
   *   - In Active_Flight_State it auto-pauses into Pause_State (Req 9.7); a
   *     deliberate resumption with a countdown is then required to continue.
   *   - In Resume_Countdown_State it SUSPENDS resumption (Req 9.13): the FSM
   *     returns to Pause_State so the countdown does NOT silently resume from
   *     where it left off — a deliberate resumption input (see
   *     {@link requestResume}) is required to re-enter Resume_Countdown_State,
   *     which re-arms the countdown from config. The remembered resume target
   *     carries over so the next countdown returns to the same destination.
   *
   * In any other state it is a no-op. The input barrier in `transition` drops
   * any pending intent so nothing leaks across the auto-pause/suspension.
   * @returns {boolean} true if a pause/suspension transition was applied
   */
  function onVisibilityLost() {
    if (state === States.Active_Flight_State) {
      transition(States.Pause_State); // Req 9.7 auto-pause
      return true;
    }
    if (state === States.Resume_Countdown_State) {
      // Req 9.13: preserve the intended resume target, drop to Pause_State, and
      // discard the partial countdown so a fresh resume re-arms it in full.
      const target = resumeTarget;
      transition(States.Pause_State);
      resumeTarget = target;
      countdownRemaining = 0;
      return true;
    }
    return false;
  }

  /**
   * Advance the combat clock (clock (c)). Combat advances by RESOLVED TURNS,
   * never by seconds, so `dt` is intentionally ignored; the combat engine
   * (systems/combat.js, Milestone 2) resolves turns from action intents. Left
   * as a clearly-marked wiring point so later tasks slot it in without rework.
   * @param {any} _intents
   */
  function tickBattle(_intents) {
    // Intentionally seconds-free. resolveCombatTurns(battle, intents, runState,
    // config) is wired here by the combat milestone. No clock advances by dt.
  }

  /**
   * The three-clock dispatch (Requirement 9.2, 9.3). Advances exactly one clock
   * for the current state, and NOTHING while the tab is hidden. No universal
   * freeze: states other than the three clock-bearing ones advance nothing.
   * @param {number} dt simulation seconds for this step
   * @param {any} [intents] input intents assigned to this tick
   * @returns {void}
   */
  function tick(dt, intents) {
    // Req 9.3: a hidden tab advances none of the three clocks. This is a steady
    // poll — it only STALLS the clocks; it never transitions. The suspension
    // required by Req 9.13 (dropping the countdown back to Pause_State) is
    // driven by the discrete visibility/blur EVENT via onVisibilityLost(), not
    // inferred here, so a merely-throttled hidden tick does not consume the
    // countdown. This keeps tick side-effect-light and matches the auto-pause
    // design (a visibilitychange/blur listener forces the state change).
    if (isDocumentHidden()) return;

    switch (state) {
      case States.Active_Flight_State:
        tickFlight(dt, intents); // clock (a): flight simulation time
        break;
      case States.Resume_Countdown_State:
        tickCountdown(dt); // clock (b): the Resume countdown
        break;
      case States.Battle_State:
        tickBattle(intents); // clock (c): resolved combat turns (not seconds)
        break;
      default:
        // Ready, Pause, Reward, Shop, Results, Main_Menu, Wardrobe: no clock
        // advances. Flight stays exactly frozen (Shield_Grace, cooldowns,
        // Active_Flight_Time, RNG state all preserved).
        break;
    }
  }

  /**
   * Validated state change. Rejects a transition not in ALLOWED_TRANSITIONS.
   * On Ready_State -> Active_Flight_State it begins a Run's flight: it marks the
   * Run started (Req 9.9) because that edge is driven by the first Flap_Input.
   * On entering Resume_Countdown_State it arms the countdown from config.
   *
   * @param {string} toState a {@link States} value
   * @param {object} [opts]
   * @param {string} [opts.resumeTo] the state to enter when the countdown ends
   *   (defaults to Active_Flight_State). Used when arming Resume_Countdown_State.
   * @returns {boolean} true if the transition was applied
   */
  function transition(toState, opts = {}) {
    const allowed = ALLOWED_TRANSITIONS[state] || [];
    if (!allowed.includes(toState)) {
      throw new Error(`Illegal FSM transition: ${state} -> ${toState}`);
    }

    const from = state;

    // Ready -> Active_Flight begins flight on the first Flap_Input (Req 1.13,
    // 9.9): the Run is now started and only a started Run finalizes rewards.
    if (
      from === States.Ready_State &&
      toState === States.Active_Flight_State &&
      runState
    ) {
      runState.started = true;
    }

    // Arm the Resume countdown when entering it (clock (b) source value).
    if (toState === States.Resume_Countdown_State) {
      countdownRemaining = config.resumeCountdown;
      resumeTarget = opts.resumeTo || States.Active_Flight_State;
    }

    // Req 5.22: entering Battle_State stores the frozen flight world as a
    // SEPARATE snapshot so the flight world is unchanged when the Battle ends.
    // The battle scene is drawn from the battle/run state, never from this
    // snapshot; the snapshot exists purely so an exact-restore path (and the
    // checkpoint path, which repositions Ghosty inside the restored world)
    // always has the untouched flight world to work from. Taken on the EDGE
    // into Battle_State so it captures the exact committed flight state at the
    // moment of contact. Shop_State does not need its own snapshot here: it is
    // entered from flight and left via the checkpoint path, and the three-clock
    // model already freezes the flight world while shopping.
    if (
      toState === States.Battle_State &&
      from === States.Active_Flight_State &&
      runState
    ) {
      runState.flightSnapshot = snapshotFlightWorld(runState);
    }

    state = toState;

    // Single-consumption barrier (Req 9.6, 9.12, 10.7): drop every intent not
    // yet consumed and move the input scope to the new state. The input that
    // caused THIS transition — dismissing a pause, confirming a result,
    // requesting a resume, restarting — has, by definition, not been consumed
    // by the destination state, so flushing here guarantees it cannot also
    // flap, act, or restart after the change. Scoping intents to `toState` is a
    // second guard: any straggler from `from` is ignored by the destination.
    if (inputQueue) inputQueue.transition(toState);

    return true;
  }

  /**
   * Enter Ready_State from the menu and build the complete initial RunState
   * (Req 7.10, 7.11). The Run is NOT started yet (`started = false`); the first
   * Flap_Input that transitions Ready -> Active_Flight sets it true.
   * @param {number} [rngSeed]
   * @returns {object} the fresh RunState
   */
  function startNewRun(rngSeed = 0) {
    transition(States.Ready_State);
    runState = createRunState(config, rngSeed);
    return runState;
  }

  /**
   * Ordinary pause (Req 9.7, 9.10): suspend live flight into Pause_State. This
   * is the ORDINARY-pause path, distinct from the checkpoint path — it does NOT
   * reposition Ghosty or touch any flight field. Because the three-clock model
   * already freezes every flight clock outside Active_Flight_State (nothing in
   * `tick` advances flight in Pause_State), the EXACT frozen flight state is
   * preserved just by not mutating it: Ghosty's exact position and velocity, the
   * exact `pipes` set, `hoverRemaining`, every cooldown, each pair's Shield_Grace
   * flag, `pipeScore`, the spawn scheduler pointers, and the RNG state all stay
   * byte-for-byte intact (Req 9.10). The RNG only advances inside `tickFlight`,
   * so it does not move while paused. Triggered by a UI_PAUSE intent; the input
   * barrier in `transition` drops that intent so it cannot leak.
   * @returns {boolean} true if the pause was applied
   */
  function pause() {
    if (state !== States.Active_Flight_State) return false;
    transition(States.Pause_State);
    return true;
  }

  /**
   * Deliberate resumption from an ordinary pause (Req 9.11, 9.12, 9.13): leave
   * Pause_State for Resume_Countdown_State, which arms the countdown from
   * config. When the countdown reaches zero the FSM returns to
   * Active_Flight_State and flight continues from the EXACT preserved state with
   * NO recenter and NO velocity reset — this path never calls
   * resumeFromCheckpoint (that is only for Battle/Reward/Shop exits). The
   * resumption input is dropped at the transition boundary so it cannot register
   * as a Flap_Input or other flight action (Req 9.12). After a countdown was
   * suspended by tab-hidden/blur (Req 9.13), a fresh call here is exactly the
   * "deliberate resumption input" that re-arms the countdown.
   * @returns {boolean} true if resumption began
   */
  function requestResume() {
    if (state !== States.Pause_State) return false;
    transition(States.Resume_Countdown_State, {
      resumeTo: States.Active_Flight_State,
    });
    return true;
  }

  /**
   * End Run from the Pause_State (Req 9.8, 9.9). This is the deliberate "give
   * up this Run" action the pause screen offers, distinct from resuming: it
   * FINALIZES the current Run and drops to Results_State so the player sees the
   * outcome and the Candy earned.
   *
   * The started/unstarted distinction (Req 9.9) is decided entirely in the pure
   * layer, not here: `finalizeRun` (candy.js) awards this Run's Candy and bumps
   * the high score EXACTLY once for a STARTED Run, and awards NOTHING — no
   * Candy, no high-score change — for an UNSTARTED Run (`started === false`),
   * because such a Run never began flight (Req 8.5). So "End Run" on a Run in
   * progress finalizes rewards, while cancelling a Run that never started
   * finalizes none. The `finalized` latch inside finalizeRun keeps the award
   * idempotent across the repeated Results views that follow.
   *
   * The finalize hook is optional (injected defensively like every other system
   * hook); when it is absent End Run still transitions to Results_State but
   * performs no award, so headless FSM tests that wire no finalize still work.
   *
   * The Run's outcome is recorded as 'ended' so the Results view can report that
   * the player ended this Run themselves rather than dying or winning. An
   * UNSTARTED Run that is cancelled records no outcome: nothing of note happened
   * (no flight, no rewards), and leaving `outcome` null keeps that distinct from
   * a deliberately-ended in-progress Run.
   *
   * The input barrier in `transition` drops the End Run input so it cannot also
   * act or restart in Results_State (Req 9.6, 10.7).
   *
   * @returns {{ ended: boolean, finalized: boolean }} `ended` is whether the End
   *   Run transition was applied (only from Pause_State); `finalized` is whether
   *   THIS call actually AWARDED rewards — true only for a STARTED Run finalized
   *   for the first time, and false for an unstarted-Run cancel (Req 9.9), an
   *   already-finalized Run, or when no finalize hook is wired. The unstarted
   *   Run is still latched internally so its Results view stays stable; it just
   *   reports `finalized = false` because nothing was granted.
   */
  function endRun() {
    if (state !== States.Pause_State) {
      return { ended: false, finalized: false };
    }

    let finalized = false;
    if (runState) {
      const wasStarted = Boolean(runState.started);
      // Distinguish a deliberate End Run of an in-progress Run from cancelling
      // an unstarted one. Only a started Run records the 'ended' outcome; an
      // unstarted cancel leaves `outcome` null (nothing happened) so Results can
      // tell the two apart.
      if (wasStarted) runState.outcome = "ended";

      // Run finalizeRun regardless so the one-shot `finalized` latch is set for
      // BOTH cases (an unstarted result must still be stable across repeated
      // views). But only REPORT `finalized = true` when rewards were actually
      // awarded — i.e. the Run was STARTED and this call performed the latch.
      // finalizeRun returns `finalized: true` for an unstarted Run too (it
      // latched), yet it awards no Candy and changes no high score for one
      // (Req 9.9, 8.5); folding in `wasStarted` here gives the shell a single
      // truthful signal for "rewards were granted, persist the save".
      if (finalizeRun && save) {
        const result = finalizeRun(runState, save, config);
        finalized = wasStarted && Boolean(result && result.finalized);
      }
    }

    transition(States.Results_State);
    return { ended: true, finalized };
  }

  /**
   * Enter a Battle from live flight on contact with an Enemy symbol (Req 4.7,
   * 9.2). Freezes flight by leaving Active_Flight_State for Battle_State; the
   * three-clock model then advances no flight clock while in Battle_State. The
   * transition itself takes the SEPARATE flight-world snapshot (Req 5.22). The
   * input that triggered the encounter is dropped at the boundary by the input
   * barrier so it cannot leak as a flight action (Req 9.6).
   * @returns {boolean} true if the Battle was entered
   */
  function enterBattle() {
    if (state !== States.Active_Flight_State) return false;
    transition(States.Battle_State);
    return true;
  }

  /**
   * Enter a Shop from live flight on contact with a Shop entrance (Req 7.4,
   * 9.2). Freezes flight by leaving Active_Flight_State for Shop_State. No input
   * leaks across the boundary (Req 9.6). Shop_State keeps the flight world
   * frozen (three-clock model) and is left via the checkpoint path.
   * @returns {boolean} true if the Shop was entered
   */
  function enterShop() {
    if (state !== States.Active_Flight_State) return false;
    transition(States.Shop_State);
    return true;
  }

  /**
   * Return to flight from Battle_State, Reward_State, or Shop_State via the SAFE
   * CHECKPOINT path (Req 9.5, 9.14, 9.15, 9.16). This is the ONLY resumption
   * path that repositions Ghosty: it applies `resumeFromCheckpoint` to the live
   * RunState (centering Ghosty in a valid Gap with vy = 0, syncing prev/cur
   * render positions, awarding no unpassed Pipe_Score) and then transitions to
   * Resume_Countdown_State so flight only resumes after the visible countdown
   * (Req 9.5). The transition barrier drops the confirming/leaving input so it
   * cannot also flap, act, or restart in the destination (Req 9.6).
   *
   * Run progress, inventory, Shield charges, the Hover remainder, and all
   * cooldowns are preserved because the checkpoint only touches Ghosty's
   * kinematics and render positions — never those fields (Req 9.14).
   * @returns {boolean} true if resumption began
   */
  function resumeToFlight() {
    if (
      state !== States.Battle_State &&
      state !== States.Reward_State &&
      state !== States.Shop_State
    ) {
      return false;
    }
    if (runState) {
      // The ONLY path that repositions Ghosty (Req 9.14). Prepares the safe
      // checkpoint on the live, carried-over RunState; the separate flight
      // snapshot taken on battle entry stays untouched (Req 5.22).
      resumeFromCheckpoint(runState, config);
    }
    transition(States.Resume_Countdown_State, {
      resumeTo: States.Active_Flight_State,
    });
    return true;
  }

  /**
   * Restart from the Results_State into a fresh Run (Req 10.4, 10.6, 10.7).
   * Goes Results → Ready and builds a brand-new RunState; the first Flap_Input
   * then begins flight. The restart action must NOT be the same input that
   * caused death or confirmed the result: the input barrier in `transition`
   * drops the triggering intent as the FSM leaves Results_State, so the death /
   * confirm input cannot immediately restart (Req 10.7). The Run is NOT started
   * yet (`started = false`) until the first Flap_Input.
   * @param {number} [rngSeed] seed for the new Run
   * @returns {object|null} the fresh RunState, or null if not in Results_State
   */
  function restart(rngSeed = 0) {
    if (state !== States.Results_State) return null;
    transition(States.Ready_State);
    runState = createRunState(config, rngSeed);
    return runState;
  }

  /**
   * Leave the Results_State to the Main_Menu (Req 10.6). The input barrier in
   * `transition` drops the confirming intent so it cannot leak into the menu
   * (Req 10.7). The ended Run is left behind (no new RunState is built here);
   * starting a fresh Run happens from the menu via {@link startNewRun}.
   * @returns {boolean} true if the transition was applied (only from Results)
   */
  function toMainMenu() {
    if (state !== States.Results_State) return false;
    return transition(States.Main_Menu_State);
  }

  /**
   * Open the Wardrobe from the Results_State OR the Main_Menu_State (Req 10.6,
   * 8.8). The Wardrobe is the cosmetic hat shop (ui/wardrobe.js, task 5.7); it
   * reads the persistent SaveData only and never touches a Run, so it is only
   * ever reachable from these two no-Run states (never from inside an active
   * Run). The input barrier drops the confirming intent so it cannot leak into
   * the Wardrobe (Req 10.7).
   * @returns {boolean} true if the transition was applied (only from Results or
   *   Main Menu)
   */
  function openWardrobe() {
    if (state !== States.Results_State && state !== States.Main_Menu_State) {
      return false;
    }
    return transition(States.Wardrobe);
  }

  /**
   * Leave the Wardrobe back to the Main_Menu_State (Req 8.8, 10.6). The only
   * exit from the Wardrobe, matching ALLOWED_TRANSITIONS. The input barrier in
   * `transition` drops the confirming/dismissing intent so it cannot leak into
   * the menu (Req 10.7).
   * @returns {boolean} true if the transition was applied (only from Wardrobe)
   */
  function leaveWardrobe() {
    if (state !== States.Wardrobe) return false;
    return transition(States.Main_Menu_State);
  }

  return {
    States,
    tick,
    transition,
    startNewRun,
    pause,
    requestResume,
    endRun,
    restart,
    toMainMenu,
    openWardrobe,
    leaveWardrobe,
    enterBattle,
    enterShop,
    resumeToFlight,
    onVisibilityLost,
    createRunState: (seed) => createRunState(config, seed),

    /**
     * Rebind the seeded RNG the flight spawner draws from. The browser shell
     * (main.js) recreates the RNG on each new Run so spawning replays from that
     * Run's own seed; this swaps the FSM's internal reference to match. Not used
     * by the headless tests, which inject a single RNG at construction.
     * @param {object} nextRng a seeded RNG instance (see rng.js)
     */
    _rebindRng(nextRng) {
      rng = nextRng || rng;
    },

    /** @returns {string} the current GameState enum value */
    get state() {
      return state;
    },
    /** @returns {object|null} the active RunState (or null outside a Run) */
    get runState() {
      return runState;
    },
    /** @returns {number} Resume countdown remaining (seconds) */
    get countdownRemaining() {
      return countdownRemaining;
    },
    /**
     * Test/shell hook: force the FSM into a specific state with a given
     * RunState. Bypasses transition validation deliberately so tests can set up
     * arbitrary scenarios (e.g. ticking Battle_State directly). Not used by the
     * running game's normal flow.
     * @param {string} toState
     * @param {object|null} [withRunState]
     */
    _setStateForTest(toState, withRunState) {
      state = toState;
      if (withRunState !== undefined) runState = withRunState;
    },
  };
}

export default createFSM;
