// main.js — the single browser entry module for Kiro's Haunted Flight.
//
// This is the thin shell that wires the pure core into a running game:
//
//   index.html
//     └─ main.js (this file; the ONLY browser-entry module — assumes a DOM)
//          ├─ loop.js            fixed-timestep rAF driver
//          ├─ state.js           FSM + three-clock dispatch
//          │     ├─ systems/flight.js      physics + flap (stepFlight)
//          │     ├─ systems/spawner.js     obstacles (called inside the FSM)
//          │     ├─ systems/collision.js   swept hitbox vs pipes (stepped by FSM)
//          │     └─ systems/scoring.js     Pipe_Score (stepScoring)
//          ├─ input.js           keyboard/mouse → state-scoped intents
//          ├─ render.js          Canvas layers (interpolation-only)
//          └─ audio.js           sfx with graceful degradation
//
// Everything with gameplay meaning lives in systems/* and the FSM. The shell's
// only real responsibility beyond construction is ROUTING per-tick intents to
// the right place for the current state: flight intents feed the flight sim via
// the FSM tick; UI intents (start, pause, resume, confirm/restart) drive the
// FSM's control methods. The single-consumption barrier the FSM already calls
// on every transition (inputQueue.transition) guarantees no input leaks across
// a state change (Req 9.6, 9.12, 10.7) — the shell never has to re-implement it.
//
// Node note: this module assumes a DOM. It must still pass `node --check`, so
// all top-level work is deferred into `boot()`, which only runs under a real
// `document`. Importing it headlessly constructs nothing.

import { CONFIG } from "./config.js";
import { createRng } from "./rng.js";
import { createFSM, States } from "./state.js";
import { stepFlight } from "./systems/flight.js";
import { stepScoring } from "./systems/scoring.js";
import { sweptHitboxVsPipes } from "./systems/collision.js";
import {
  stepScheduler,
  markEntered,
  markSkipped,
} from "./systems/scheduler.js";
import {
  makeOrdinaryEnemy,
  makeBoss,
  startBattle,
  resolvePlayerAction,
  resolveEnemyTurn,
  usePotion,
  PlayerActions,
  possessionOffer,
  applyPossessionChoice,
} from "./systems/combat.js";
import { battleActions } from "./ui/battle.js";
import { ResultsAction } from "./ui/results.js";
import { purchase, awardOrdinaryVictory } from "./systems/economy.js";
import { finalizeRun } from "./systems/candy.js";
import { loadSave, writeSave, exportSave, parseImport } from "./save.js";
import { buyHat, equipHat, unequipHat } from "./ui/wardrobe.js";
import { hitboxFor } from "./systems/collision.js";
import {
  createInputQueue,
  attachInput,
  attachFlightPowerButton,
  spiritProvidesFlightPower,
  IntentType,
} from "./input.js";
import { createRenderer } from "./render.js";
import { startLoop } from "./loop.js";
import { playSfx, initAudio, setMuted } from "./audio.js";
import {
  createFeedbackBuffer,
  pushFeedback,
  FeedbackKind,
} from "./ui/feedback.js";

/**
 * Size the canvas backing store to the logical playfield. The renderer applies
 * a draw-time letterbox transform (render.js), so the backing store just needs
 * the logical dimensions; CSS in index.html scales the element to the viewport.
 * @param {HTMLCanvasElement} canvas
 */
function sizeCanvas(canvas) {
  canvas.width = CONFIG.playfield.width;
  canvas.height = CONFIG.playfield.height;
}

/**
 * Pick a fresh per-Run seed. Deterministic replay (tests) uses a fixed seed;
 * the live game varies it so successive Runs differ.
 * @returns {number}
 */
function freshSeed() {
  return Math.floor(Math.random() * 0x7fffffff) >>> 0 || 1;
}

/**
 * Boot the game: construct the FSM + systems + IO, wire control flow, and start
 * the fixed-timestep loop. Only called under a real DOM.
 */
function boot() {
  const canvas = /** @type {HTMLCanvasElement|null} */ (
    document.getElementById("game-canvas")
  );
  if (!canvas) return;
  sizeCanvas(canvas);

  const save = loadSave();

  // Audio unlocks on the first user gesture and honors the saved mute pref.
  initAudio(save.prefs);

  // One seeded RNG per Run drives the spawner deterministically. It is recreated
  // on each new Run so a Run replays from its own seed.
  let rng = createRng(freshSeed());

  // The pure input queue. The FSM gets a reference so its transition() can flush
  // the queue at every state change (the no-input-leak barrier). Start scoped to
  // the menu; the game opens on the title/ready screen.
  const inputQueue = createInputQueue({ initialScope: States.Main_Menu_State });

  // Build the FSM with every Milestone 1 system hook wired in. The spawner is
  // called internally by the FSM from the RNG; collision/scoring/flight are
  // injected here so the FSM's flight tick runs the real logic.
  const fsm = createFSM(CONFIG, save, {
    rng,
    stepFlight,
    sweptHitboxVsPipes,
    stepScoring,
    stepScheduler,
    markSkipped,
    // The boss BattleState factory (Milestone 4). The FSM calls this on the
    // boss-presentation edge the scheduler reports (Active_Flight_Time crossing
    // the boss trigger) to build the Final_Boss battle; it is then stored on
    // runState.activeBattle so the SAME dedicated battle scene an ordinary
    // encounter uses draws it, and routeBattleIntent resolves it (boss victory →
    // Results with outcome 'victory', Req 4.8, 5.20). Kept thin: just makeBoss +
    // startBattle, matching the ordinary beginEncounter path.
    makeBossBattle: (rs, cfg) => startBattle(rs, makeBoss(cfg), cfg),
    // The Run-finalize path (Req 8.4, 9.8). The FSM's endRun() calls this on the
    // End Run edge out of Pause_State to award this Run's Candy and bump the high
    // score exactly once, awarding nothing for an unstarted Run (Req 9.9, 8.5).
    // It mutates `save` in place; the shell persists it after End Run.
    finalizeRun,
    inputQueue,
    isDocumentHidden: () =>
      typeof document !== "undefined" && Boolean(document.hidden),
  });

  // DOM input: Space/click → flap, E → flight power, P/Esc → pause, Enter →
  // confirm. attachInput maps physical keys via DEFAULT_KEY_MAP and treats any
  // click on the canvas as a flight-area flap (UI buttons attach their own
  // handlers and never reach the flap path).
  attachInput(inputQueue, { canvas });

  // The visible on-screen Flight_Power button (Req 1.7). It enqueues a
  // FLIGHT_POWER intent exactly like the E key, but only while a power-providing
  // Spirit is equipped; the same downstream gate (routeIntents + stepFlight's
  // cooldown check) then decides whether Hover actually activates. Guarded for
  // headless/missing-element use.
  const flightPowerButton = /** @type {HTMLButtonElement|null} */ (
    document.getElementById("flight-power-button")
  );
  attachFlightPowerButton(inputQueue, {
    button: flightPowerButton,
    isPowerAvailable: () =>
      Boolean(fsm.runState) &&
      spiritProvidesFlightPower(fsm.runState.equippedSpirit),
  });

  // Accessibility settings (Req 12.7, 12.8): the audio mute and reduced-motion
  // toggles. Both are keyboard-operable checkboxes with a visible focus ring
  // (index.html). They read from and write to the SAME saved prefs (save.prefs)
  // that audio.js and the renderer already honor, and persist on every change
  // so the preference survives a reload. Guarded for headless/missing elements.
  const muteToggle = /** @type {HTMLInputElement|null} */ (
    document.getElementById("mute-toggle")
  );
  const reducedMotionToggle = /** @type {HTMLInputElement|null} */ (
    document.getElementById("reduced-motion-toggle")
  );

  if (muteToggle) {
    // Reflect the loaded pref into the control, then keep them in sync.
    muteToggle.checked = Boolean(save.prefs && save.prefs.muted);
    muteToggle.addEventListener("change", () => {
      const muted = Boolean(muteToggle.checked);
      save.prefs.muted = muted;
      setMuted(muted); // audio.js honors it immediately (Req 12.4, 12.7)
      persistSave();
    });
  }

  if (reducedMotionToggle) {
    reducedMotionToggle.checked = Boolean(
      save.prefs && save.prefs.reducedMotion,
    );
    reducedMotionToggle.addEventListener("change", () => {
      // The renderer reads save.prefs.reducedMotion each frame via its getter,
      // so flipping this immediately tones down motion-heavy effects (Req 12.8).
      save.prefs.reducedMotion = Boolean(reducedMotionToggle.checked);
      persistSave();
    });
  }

  // The transient player-feedback buffer (Req 12.2). The shell pushes cues at
  // the event sites below (the same places that already call playSfx); the HUD
  // reads the live events each frame via ui/feedback.js. It ages on wall-clock
  // seconds only, so it never touches a simulation clock.
  const feedback = createFeedbackBuffer();

  /** @returns {number} monotonic wall-clock seconds for feedback timestamps. */
  const nowSeconds = () =>
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now() / 1000
      : Date.now() / 1000;

  /**
   * Push a player-feedback cue (Req 12.2). A thin wrapper over pushFeedback that
   * supplies the wall-clock timestamp, so callers at the event sites stay terse.
   * @param {string} kind a FeedbackKind value
   * @param {string} message the cue text
   * @param {object} [opts] overrides forwarded to pushFeedback
   */
  const emit = (kind, message, opts) =>
    pushFeedback(feedback, kind, message, nowSeconds(), opts);

  // The renderer is bound to the canvas and reads the saved presentation prefs.
  const renderer = createRenderer(canvas, {
    config: CONFIG,
    prefs: () => save.prefs,
    // The HUD reads the live feedback cues each frame (Req 12.2).
    feedback: () => feedback,
    // The Results screen shows the updated total Candy balance (Req 10.5),
    // which lives on SaveData. Full Candy accrual + persistence is Milestone 5
    // (candy.js / save.js); until then the minimal save exposes no `candy`
    // field, so resultsSummary safely degrades the total to 0.
    save: () => save,
  });

  // --- Control-flow routing ---------------------------------------------------
  //
  // The loop calls `consumeInputIntents()` once per fixed step and hands the
  // result straight to `fsm.tick(dt, intents)`. We interpose here: read the raw
  // per-tick intents, drive the FSM's control methods for UI intents in the
  // current state, and return a plain flight-intents object `{ flap, flightPower }`
  // for the flight sim. Because the FSM flushes the queue on every transition,
  // an input that (say) starts the Run or dismisses a pause is dropped at the
  // boundary and cannot also flap in the destination state (Req 9.6, 9.12, 10.7).

  /**
   * @param {{ type: string }} intent
   * @returns {boolean} true if this intent is a Flap_Input
   */
  const isFlap = (intent) => intent.type === IntentType.FLAP;

  /**
   * Translate this tick's raw intents into flight intents, performing any UI
   * control-flow transitions as a side effect. Returns the object the flight
   * sim consumes; UI intents never appear in it (Req 1.6).
   * @returns {{ flap: boolean, flightPower: boolean }}
   */
  function routeIntents() {
    // Symbol contact is checked from committed flight state at the top of each
    // step (Req 4.7, 7.4). On contact Ghosty's symbol is marked `entered`, the
    // matching combat/shop state is prepared, and the FSM freezes flight by
    // transitioning out of Active_Flight_State. Done before consuming intents so
    // the freeze takes effect this step and no flight intent is applied after it.
    detectSymbolContact();

    const intents = inputQueue.consumeInputIntents();
    const flight = { flap: false, flightPower: false };

    for (const intent of intents) {
      switch (fsm.state) {
        case States.Main_Menu_State: {
          // From the menu a flap/confirm builds a fresh Run (Main_Menu → Ready)
          // and immediately takes the first-flap edge (Ready → Active_Flight) so
          // flight begins on the starting gesture.
          if (isFlap(intent) || intent.type === IntentType.UI_CONFIRM) {
            startRun();
            // The starting gesture is itself the first Flap_Input (Req 1.13):
            // flight begins AND this tick's flight step applies the flap
            // velocity, so Ghosty rises on the opening flap rather than falling.
            flight.flap = true;
          }
          break;
        }

        case States.Ready_State: {
          // A Run already exists (e.g. after a restart left us in Ready). The
          // first flap begins flight (Ready → Active_Flight) without rebuilding,
          // and applies the flap velocity on the same tick (Req 1.13).
          if (isFlap(intent) || intent.type === IntentType.UI_CONFIRM) {
            fsm.transition(States.Active_Flight_State);
            flight.flap = true;
            playSfx("jump");
          }
          break;
        }

        case States.Active_Flight_State: {
          if (isFlap(intent)) {
            flight.flap = true;
            playSfx("jump");
            emit(FeedbackKind.FLAP, "Flap"); // brief visual cue (Req 12.2)
          } else if (intent.type === IntentType.FLIGHT_POWER) {
            // Flight_Power (Storm_Bat Hover) only fires while a power-providing
            // Spirit is equipped (Req 1.7). Otherwise the request is ignored and
            // velocity/cooldown are left unchanged (Req 1.8). The Hover cooldown
            // gate itself is enforced downstream in stepFlight/activateHover.
            const rs = fsm.runState;
            if (rs && spiritProvidesFlightPower(rs.equippedSpirit)) {
              flight.flightPower = true;
            }
          } else if (intent.type === IntentType.UI_PAUSE) {
            fsm.pause(); // Active → Pause; barrier drops this intent
          }
          break;
        }

        case States.Battle_State: {
          // In-battle actions. The player acts first; after a non-victorious
          // player turn the enemy responds. A confirm after the battle ends
          // advances out of the battle (to Reward on victory, Results on
          // defeat, or back to flight). Number keys / confirm map to actions.
          routeBattleIntent(intent);
          break;
        }

        case States.Shop_State: {
          // Purchases, in-shop potion use, and leaving the shop. Leaving
          // resumes flight via the checkpoint path + countdown (no input leak).
          routeShopIntent(intent);
          break;
        }

        case States.Reward_State: {
          // Possession offer (Req 6.1, 6.2): after the ordinary rewards were
          // granted on the battle-victory edge, present the offer and apply the
          // player's choice. Replace possesses the defeated enemy's Spirit;
          // decline keeps the current one. Either choice then resumes flight via
          // the checkpoint path. With no offer (boss / no spirit reward) any
          // confirm simply leaves.
          routeRewardIntent(intent);
          break;
        }

        case States.Pause_State: {
          // End Run (Req 9.8): the player deliberately gives up this Run. The
          // FSM finalizes it (awarding this Run's Candy + high score exactly
          // once for a STARTED Run, nothing for an unstarted one — Req 9.9) and
          // drops to Results_State. Persist the finalized save here so the
          // awarded Candy/high score survive a reload. Checked BEFORE resume so
          // the two pause actions never collide.
          if (intent.type === IntentType.UI_END_RUN) {
            const { finalized } = fsm.endRun();
            if (finalized) persistSave();
            break;
          }
          // Any resume/confirm/flap deliberately resumes; the countdown then
          // returns to flight from the exact frozen state (no recenter).
          if (
            intent.type === IntentType.UI_RESUME ||
            intent.type === IntentType.UI_CONFIRM ||
            isFlap(intent)
          ) {
            fsm.requestResume();
          }
          break;
        }

        case States.Results_State: {
          // Present three actions (Req 10.6): restart, Main Menu, Wardrobe.
          // A number-key pick (UI_SELECT) chooses by index in the same order
          // the Results view lists them (0 restart, 1 Main Menu, 2 Wardrobe);
          // a plain confirm/flap defaults to Restart so the screen is always
          // actionable. The barrier in each transition drops the death/confirm
          // input so it cannot immediately flap the fresh Run or leak into the
          // destination (Req 10.7).
          routeResultsIntent(intent);
          break;
        }

        case States.Wardrobe: {
          // The Wardrobe is reachable only OUTSIDE a Run (from Results, Req
          // 10.6). Esc/pause returns to the Main Menu; buy/equip happen through
          // the on-screen controls (wired below) which call the pure
          // wardrobe.js functions and persist on every change.
          routeWardrobeIntent(intent);
          break;
        }

        default:
          // Resume_Countdown and other states consume no shell-routed input;
          // the countdown advances on its own clock in the FSM tick.
          break;
      }
    }

    return flight;
  }

  /**
   * Axis-aligned overlap test between Ghosty's committed forgiving Hitbox and a
   * flight-world symbol's body rect (CENTER x/y, w/h — the scheduler's
   * convention). Uses `hitboxFor` so contact reads the SAME forgiving rect as
   * collisions, never an enlarged bound.
   * @param {object} ghosty the committed Ghosty sub-state
   * @param {{ x:number, y:number, w:number, h:number }} symbol
   * @returns {boolean}
   */
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
   * Detect contact with an avoidable Enemy/Shop symbol during live flight and,
   * on contact, enter the matching state (freezing flight). Only runs in
   * Active_Flight_State. The first contacted symbol wins the step. Marking the
   * symbol `entered` (scheduler) removes it from the flight world so it never
   * retriggers; the FSM transition then freezes flight (Req 4.7, 7.4).
   */
  function detectSymbolContact() {
    if (fsm.state !== States.Active_Flight_State) return;
    const rs = fsm.runState;
    if (!rs || !Array.isArray(rs.symbols) || rs.symbols.length === 0) return;

    for (const symbol of rs.symbols) {
      if (!symbol) continue;
      if (!hitboxTouchesSymbol(rs.ghosty, symbol)) continue;

      // Promote the opportunity to `entered` (removes its symbol), then freeze
      // flight into the right state.
      markEntered(rs.progress, symbol.key, rs);
      if (symbol.kind === "enemy") {
        beginEncounter(rs, symbol.enemyType || "A");
      } else if (symbol.kind === "shop") {
        fsm.enterShop();
      }
      return; // one opportunity per step
    }
  }

  /**
   * Prepare and enter a Battle from flight contact (Req 4.7). Builds the enemy
   * and the fresh BattleState, stores the live battle on the RunState so the
   * dedicated battle scene (render.js → ui/battle.js) can draw it, then freezes
   * flight via the FSM (which also takes the separate flight-world snapshot,
   * Req 5.22).
   * @param {object} rs the active RunState
   * @param {'A'|'B'} enemyType
   */
  function beginEncounter(rs, enemyType) {
    const enemy = makeOrdinaryEnemy(enemyType, CONFIG);
    rs.activeBattle = startBattle(rs, enemy, CONFIG);
    fsm.enterBattle();
  }

  /**
   * Resolve one in-battle input (Req 5.3–5.7, 5.24). While the battle is
   * ongoing, map the player's chosen action, resolve it (player acts first),
   * and — if a turn was consumed and the battle is still going — resolve the
   * enemy's response. When the battle has ended, a confirm advances out of it:
   * victory → award Soul_Coins then Reward_State; defeat → Results_State.
   * Battle_HP and the enemy HP live on the RunState / battle so both HP displays
   * stay truthful.
   * @param {{ type: string }} intent
   */
  function routeBattleIntent(intent) {
    const rs = fsm.runState;
    const battle = rs && rs.activeBattle;
    if (!rs || !battle) return;

    // Battle already resolved: a confirm leaves the battle scene.
    if (battle.outcome !== "ongoing") {
      if (isFlap(intent) || intent.type === IntentType.UI_CONFIRM) {
        if (battle.outcome === "victory") {
          const isBoss = Boolean(battle.enemy && battle.enemy.isBoss);
          rs.enemiesDefeated += 1;
          if (isBoss) {
            // Boss victory concludes the Run in victory (Req 5.20, 10.5): latch
            // the win so the Results screen reports Victory and the Candy
            // boss-bonus applies. No Possession offer / Reward for the boss.
            rs.bossDefeated = true;
            rs.outcome = "victory";
            emit(FeedbackKind.BOSS_VICTORY, "The Final Boss is defeated!");
            fsm.transition(States.Results_State);
          } else {
            // Grant the ordinary rewards FIRST (Req 6.1), then prepare the
            // Possession offer on the Run so the Reward screen can present it.
            const coinsBefore = rs.soulCoins;
            awardOrdinaryVictory(rs, CONFIG);
            const gained = rs.soulCoins - coinsBefore;
            emit(
              FeedbackKind.REWARD,
              gained > 0 ? `Victory! +${gained} Soul Coins` : "Victory!",
            );
            // Build the offer from the defeated enemy (null for no spirit
            // reward); the Reward handler applies the player's choice.
            rs.pendingOffer = possessionOffer(battle.enemy, rs);
            fsm.transition(States.Reward_State);
          }
        } else {
          // Defeat in battle ends the Run (Req 10.5 cause-of-defeat).
          rs.outcome = "battle";
          emit(FeedbackKind.FATAL, "Defeated in battle");
          fsm.transition(States.Results_State);
        }
      }
      return;
    }

    // Map the input to a player action: number keys (UI_SELECT) pick the Nth
    // action (Attack/Defend/Use Item/Spirit move); confirm/flap defaults to
    // Attack so the battle is always resolvable without the picker.
    const action = intentToBattleAction(intent, rs);
    if (!action) return;

    // Snapshot HP so the resolved action can be narrated as readable feedback
    // (Req 12.2: "Battle actions and damage"). The enemy HP lives on the battle.
    const enemyHpBefore =
      battle.enemy && typeof battle.enemy.battleHp === "number"
        ? battle.enemy.battleHp
        : 0;
    const playerHpBefore = typeof rs.battleHp === "number" ? rs.battleHp : 0;

    const afterPlayer = resolvePlayerAction(battle, action, rs, CONFIG, {
      usePotion,
    });
    let nextBattle = afterPlayer.battle;
    let nextRun = afterPlayer.runState;

    // If the player consumed a turn and the battle is still ongoing, the enemy
    // responds (resolveEnemyTurn is a no-op if the battle ended on the player
    // turn, so calling it unconditionally is safe — Req 5.14).
    if (nextBattle.phase === "enemy") {
      const afterEnemy = resolveEnemyTurn(nextBattle, nextRun, CONFIG);
      nextBattle = afterEnemy.battle;
      nextRun = afterEnemy.runState;
    }

    // Persist updated battle + run (Battle_HP carries on the Run, Req 5.2).
    rs.activeBattle = nextBattle;
    rs.battleHp = nextRun.battleHp;
    rs.items = nextRun.items;

    // Readable action/damage feedback (Req 12.2). Report damage dealt to the
    // enemy and damage taken this exchange; a heal (potion) reads as a gain.
    const enemyHpAfter =
      nextBattle.enemy && typeof nextBattle.enemy.battleHp === "number"
        ? nextBattle.enemy.battleHp
        : enemyHpBefore;
    const playerHpAfter =
      typeof nextRun.battleHp === "number" ? nextRun.battleHp : playerHpBefore;
    const dealt = Math.max(0, Math.round(enemyHpBefore - enemyHpAfter));
    const taken = Math.max(0, Math.round(playerHpBefore - playerHpAfter));
    const healed = Math.max(0, Math.round(playerHpAfter - playerHpBefore));
    if (dealt > 0) {
      emit(FeedbackKind.BATTLE_ACTION, `Dealt ${dealt} damage`);
    } else if (healed > 0) {
      emit(FeedbackKind.REWARD, `Healed ${healed} Battle HP`);
    }
    if (taken > 0) {
      emit(FeedbackKind.BATTLE_ACTION, `Took ${taken} damage`, {
        severity: "bad",
      });
    }
  }

  /**
   * Translate an input intent into a battle action (Req 5.3). A UI_SELECT intent
   * picks the Nth action from the same {@link battleActions} list the battle
   * scene draws, so what the player sees numbered is exactly what a number key
   * selects — including the equipped Spirit's move (Storm_Bat Lightning /
   * Pumpkin_Guardian Fortified Defend), routed as {@link PlayerActions.SpiritMove}.
   * A plain confirm/flap defaults to Attack so the battle is always resolvable.
   *
   * Picking a Spirit move the Spirit cannot currently use (Lightning on
   * cooldown) returns null so no turn is consumed; combat.js also rejects it
   * defensively (Req 5.5), but gating here keeps a cooled-down pick from being
   * silently treated as something else.
   *
   * @param {{ type: string, index?: number }} intent
   * @param {object} runState the active RunState (reads loadout for the picker)
   * @returns {string|null} a {@link PlayerActions} value, or null for no-op
   */
  function intentToBattleAction(intent, runState) {
    if (isFlap(intent) || intent.type === IntentType.UI_CONFIRM) {
      return PlayerActions.Attack;
    }
    if (intent.type === IntentType.UI_SELECT) {
      const actions = battleActions(runState);
      const chosen = actions[intent.index];
      if (!chosen) return null;
      // The Spirit move is only selectable while actually available
      // (Lightning off cooldown; Fortified Defend always). Otherwise no-op.
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

  /**
   * Resolve one in-Results input (Req 10.6, 10.7). The Results screen offers
   * three actions in a fixed order matching the Results view:
   *
   *   0 → Restart    (Results → Ready; the first flap begins the fresh Run)
   *   1 → Main Menu  (Results → Main_Menu)
   *   2 → Wardrobe   (Results → Wardrobe)
   *
   * A number-key pick (UI_SELECT) chooses by index; a plain confirm/flap
   * defaults to Restart so the screen is always actionable. Each FSM method
   * transitions, and the single-consumption barrier in `transition` drops the
   * confirming input so it cannot leak into the destination (Req 10.7).
   * @param {{ type: string, index?: number }} intent
   */
  function routeResultsIntent(intent) {
    // Explicit action selection by index (0 restart, 1 Main Menu, 2 Wardrobe).
    if (intent.type === IntentType.UI_SELECT) {
      const ordered = [
        ResultsAction.Restart,
        ResultsAction.MainMenu,
        ResultsAction.Wardrobe,
      ];
      const chosen = ordered[intent.index];
      if (chosen === ResultsAction.Restart) fsm.restart(freshSeed());
      else if (chosen === ResultsAction.MainMenu) fsm.toMainMenu();
      else if (chosen === ResultsAction.Wardrobe) fsm.openWardrobe();
      return;
    }
    // Default: a deliberate confirm/flap restarts the Run.
    if (isFlap(intent) || intent.type === IntentType.UI_CONFIRM) {
      fsm.restart(freshSeed());
    }
  }

  /**
   * Resolve one in-Wardrobe input (Req 8.8, 10.6). The Wardrobe is a no-Run
   * cosmetic screen; the only keyboard navigation it needs is "go back": Esc
   * (UI_PAUSE) or a confirm/flap returns to the Main Menu. Buying and equipping
   * Hats happen through the on-screen controls (bound below), which call the
   * pure wardrobe.js functions. Hat ids are chosen by the on-screen rows rather
   * than number keys here, so a stray UI_SELECT does nothing destructive.
   * @param {{ type: string }} intent
   */
  function routeWardrobeIntent(intent) {
    if (
      intent.type === IntentType.UI_PAUSE ||
      intent.type === IntentType.UI_CONFIRM ||
      isFlap(intent)
    ) {
      fsm.leaveWardrobe(); // Wardrobe → Main Menu; barrier drops the intent
    }
  }

  /**
   * Resolve one in-Reward input (Req 6.1, 6.2). The ordinary rewards were
   * already granted on the battle-victory edge; here the player answers the
   * Possession offer stored on `rs.pendingOffer`:
   *
   *   - option 1 / UI_CONFIRM / flap → REPLACE: possess the defeated enemy's
   *     Spirit (which enforces the single-equipped rule, the one-time
   *     Pumpkin_Guardian Shield gift, and never refills resources).
   *   - option 2 → DECLINE: keep the current Spirit, change nothing.
   *
   * Either choice clears the offer and resumes flight via the checkpoint path
   * (so the confirming input cannot leak into flight, Req 9.6). When there is
   * no offer (boss / no spirit reward) any confirm simply leaves.
   *
   * `applyPossessionChoice` matches `combat.js`: 'replace' / 'decline' map to
   * the offer's two choices, in order, as the battle scene numbers them.
   * @param {{ type: string, index?: number }} intent
   */
  function routeRewardIntent(intent) {
    const rs = fsm.runState;
    if (!rs) return;
    const offer = rs.pendingOffer || null;

    // No offer to answer: a confirm/flap just leaves (Req 6.1 — boss or an
    // enemy with no spirit reward offers no possession).
    if (!offer) {
      if (isFlap(intent) || intent.type === IntentType.UI_CONFIRM) {
        leaveReward(rs);
      }
      return;
    }

    // Map the input to a choice. A numbered pick selects the Nth offer choice
    // (replace / decline, in order); confirm/flap takes the first (replace).
    let choice = null;
    if (intent.type === IntentType.UI_SELECT) {
      const picked = offer.choices && offer.choices[intent.index];
      if (picked) choice = picked.id; // 'replace' | 'decline'
    } else if (isFlap(intent) || intent.type === IntentType.UI_CONFIRM) {
      choice = "replace";
    }
    if (!choice) return;

    // Apply the choice on the live Run, then leave. possess mutates in place
    // and returns the same Run; re-assign defensively in case that changes.
    fsm.runState.pendingOffer = null;
    applyPossessionChoice(rs, offer, choice, CONFIG);
    if (choice === "replace") {
      const spiritName =
        offer.offered && offer.offered.name ? offer.offered.name : "a Spirit";
      emit(FeedbackKind.POSSESSION, `Possessed ${spiritName}`);
    }
    leaveReward(rs);
  }

  /**
   * Leave Reward_State back to flight via the safe checkpoint path, clearing
   * any pending offer first so it never lingers into the next encounter.
   * @param {object} rs the active RunState
   */
  function leaveReward(rs) {
    rs.pendingOffer = null;
    fsm.resumeToFlight();
  }

  /**
   * Resolve one in-shop input (Req 7.5, 7.13). A confirm leaves the shop and
   * resumes flight via the checkpoint path + countdown. Purchases and in-shop
   * potion use are driven by dedicated UI affordances (buttons/keys) that call
   * `purchase`/`usePotion`; the keyboard confirm here handles leaving.
   * @param {{ type: string }} intent
   */
  function routeShopIntent(intent) {
    const rs = fsm.runState;
    if (!rs) return;
    if (intent.type === IntentType.UI_CONFIRM || isFlap(intent)) {
      fsm.resumeToFlight(); // Shop → checkpoint → Resume_Countdown → flight
    }
  }

  /**
   * Buy one unit of a shop item (invoked by an on-screen shop button / key).
   * Thin wrapper over the pure economy `purchase`; the economy enforces
   * affordability, caps, and single-purchase-per-action (Req 7.6–7.8, 7.12).
   * @param {string} itemId
   * @returns {boolean} whether the purchase applied
   */
  function buyShopItem(itemId) {
    const rs = fsm.runState;
    if (!rs || fsm.state !== States.Shop_State) return false;
    const { ok } = purchase(rs, itemId, CONFIG);
    if (ok) emit(FeedbackKind.PURCHASE, "Purchased"); // Req 12.2 purchase cue
    return ok;
  }

  /**
   * Use one potion in the shop (invoked by an on-screen button / the U key).
   * No combat turn, no Candy time (Req 7.13) — guaranteed by passing battle =
   * null to the pure `usePotion`.
   * @returns {boolean} whether a potion was consumed
   */
  function useShopPotion() {
    const rs = fsm.runState;
    if (!rs || fsm.state !== States.Shop_State) return false;
    const result = usePotion(rs, null, CONFIG);
    if (result.ok) {
      rs.battleHp = result.runState.battleHp;
      rs.items = result.runState.items;
      emit(FeedbackKind.REWARD, "Used a Potion");
    }
    return result.ok;
  }

  // --- Meta-progression: Wardrobe + portable save (outside-a-Run only) --------
  //
  // Every affordance below is gated to the no-Run states (Main_Menu, Results,
  // Wardrobe). The Wardrobe and Export/Import are deliberately NOT reachable
  // mid-Run: progress only moves at Run boundaries, and an unfinished Run is
  // never restored on reload (the persisted SaveData carries no Run state, Req
  // 11.12). Each write goes through save.js `writeSave` so a storage failure is
  // non-blocking (Req 11.5).

  /** States in which meta-progression (Wardrobe / Export / Import) is allowed. */
  const META_STATES = new Set([
    States.Main_Menu_State,
    States.Results_State,
    States.Wardrobe,
  ]);

  /**
   * Whether meta-progression affordances are currently permitted: true only
   * when the Game is OUTSIDE an active Run. Guards buy/equip/export/import so
   * none of them can fire mid-flight, mid-battle, or mid-shop.
   * @returns {boolean}
   */
  function metaAllowed() {
    return META_STATES.has(fsm.state);
  }

  /**
   * Buy a Hat in the Wardrobe with Candy (Req 8.8, 8.10, 8.12). Thin wrapper
   * over the pure `buyHat`, which enforces unknown/owned/affordable before any
   * Candy is spent. On a successful buy the full SaveData is persisted
   * immediately so the spend + ownership survive a reload. No-op outside the
   * Wardrobe.
   * @param {string} hatId
   * @returns {boolean} whether the buy applied
   */
  function buyWardrobeHat(hatId) {
    if (fsm.state !== States.Wardrobe) return false;
    const { ok } = buyHat(save, hatId, CONFIG);
    if (ok) persistSave();
    return ok;
  }

  /**
   * Equip an owned Hat in the Wardrobe at no Candy cost (Req 8.11). Thin wrapper
   * over the pure `equipHat`; equipping an unowned Hat is rejected. Persists on
   * success so the equipped Hat is restored across reloads. No-op outside the
   * Wardrobe.
   * @param {string} hatId the hat id to equip ('none' unequips)
   * @returns {boolean} whether the equip applied
   */
  function equipWardrobeHat(hatId) {
    if (fsm.state !== States.Wardrobe) return false;
    const { ok } = equipHat(save, hatId, CONFIG);
    if (ok) persistSave();
    return ok;
  }

  /**
   * Unequip any worn Hat, returning Ghosty to the free no-hat default (Req
   * 8.11). Always succeeds and costs no Candy; persists the change. No-op
   * outside the Wardrobe.
   * @returns {boolean} whether the unequip applied
   */
  function unequipWardrobeHat() {
    if (fsm.state !== States.Wardrobe) return false;
    const { ok } = unequipHat(save, CONFIG);
    if (ok) persistSave();
    return ok;
  }

  /**
   * Export the current SaveData as a portable JSON payload (Req 11.6, 11.7),
   * then trigger a browser download when a DOM is present. Allowed only outside
   * an active Run. The payload is canonical (sanitized) and carries only
   * persistent progress + prefs — never any unfinished-Run state (Req 11.12).
   * @returns {{ text: string, filename: string } | null} the payload, or null
   *   when not permitted
   */
  function exportProgress() {
    if (!metaAllowed()) return null;
    const { text, filename, blob } = exportSave(save, CONFIG);
    // Best-effort download via a transient anchor; a missing DOM / blocked
    // download degrades to simply returning the text so nothing throws.
    try {
      if (
        blob &&
        typeof URL !== "undefined" &&
        typeof document !== "undefined"
      ) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
      }
    } catch {
      // A download failure never interrupts the Game; the text is still returned.
    }
    return { text, filename };
  }

  /**
   * Import a portable save file, following the validate → preview → confirm →
   * replace → save-immediately flow (Req 11.8–11.11). Allowed only outside an
   * active Run. The STRICT `parseImport` validates the WHOLE file up front; a
   * rejected import changes nothing (Req 11.9). On accept, the validated
   * SaveData REPLACES (never merges) the in-memory save and is written
   * immediately so the imported progress survives a reload.
   *
   * The `confirm` step is left to the caller via the `onPreview` predicate:
   * when supplied it is handed the validated preview and must return truthy to
   * proceed; omitting it imports immediately (used by a UI that already
   * confirmed).
   *
   * @param {string} text the raw file contents
   * @param {(preview: object) => boolean} [onPreview] optional confirm gate
   * @returns {{ ok: true } | { ok: false, error: string }} the outcome; on
   *   rejection the current progress is untouched
   */
  function importProgress(text, onPreview) {
    if (!metaAllowed()) {
      return { ok: false, error: "Import is only available outside a run." };
    }
    const parsed = parseImport(text, CONFIG);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    // preview → confirm: let the caller inspect the validated save and veto.
    if (typeof onPreview === "function" && !onPreview(parsed.save)) {
      return { ok: false, error: "Import cancelled." };
    }

    // replace (not merge) every field of the in-memory save, then persist
    // immediately so the imported progress is durable (Req 11.11).
    for (const key of Object.keys(save)) delete save[key];
    Object.assign(save, parsed.save);
    persistSave();
    return { ok: true };
  }

  /**
   * Begin a Run: recreate the per-Run RNG so spawning replays from the Run's
   * own seed, start a new Run (Main_Menu → Ready), then take the first flap edge
   * (Ready → Active_Flight) so flight begins immediately on the starting gesture.
   */
  function startRun() {
    const seed = freshSeed();
    rng = createRng(seed);
    fsm._rebindRng(rng);
    fsm.startNewRun(seed);
    fsm.transition(States.Active_Flight_State);
    playSfx("jump");
  }

  // Detect a freshly-ended Run so game_over plays exactly once on entering
  // Results, and so the Run is finalized + persisted on that edge.
  let wasResults = false;

  // Per-tick feedback observers for events that happen INSIDE the FSM flight
  // tick (not at a shell-routed input site): a pipe scored, a Shield breaking,
  // and a fatal flight collision (Req 12.2). We compare committed RunState
  // across ticks so these cues fire exactly on the edge without moving any
  // gameplay logic out of the pure systems.
  let prevPipeScore = 0;
  let prevShieldCharges = 0;
  let prevOutcome = null;

  /**
   * Observe committed flight state after a tick and emit the in-flight feedback
   * cues (Req 12.2): one SCORE cue per pipe newly passed, a SHIELD_BREAK cue
   * when a charge is consumed, and a FATAL cue on the flight-death edge
   * (ground/ceiling/pipe). Display-only: reads the RunState, never mutates it.
   */
  function observeFlightFeedback() {
    const rs = fsm.runState;
    if (!rs) return;

    const score = typeof rs.pipeScore === "number" ? rs.pipeScore : 0;
    if (score > prevPipeScore) {
      emit(FeedbackKind.SCORE, `Score ${score}`);
    }
    prevPipeScore = score;

    const shields = typeof rs.shieldCharges === "number" ? rs.shieldCharges : 0;
    if (shields < prevShieldCharges) {
      // A charge was consumed absorbing a pipe hit — the Shield broke (Req 3.x,
      // 12.2). Clear shield-break feedback so the save is read as earned.
      emit(FeedbackKind.SHIELD_BREAK, "Shield broke!");
    }
    prevShieldCharges = shields;

    // Fatal flight collision edge (ground/ceiling/pipe). The battle-defeat and
    // boss-victory cues are emitted at their own routed sites above.
    const outcome = rs.outcome || null;
    if (
      outcome !== prevOutcome &&
      (outcome === "pipe" || outcome === "ground-ceiling")
    ) {
      emit(
        FeedbackKind.FATAL,
        outcome === "pipe" ? "Crashed into a pipe" : "Hit the ground",
      );
    }
    prevOutcome = outcome;
  }

  /**
   * Per-tick input source for the loop. Also observes the edge INTO
   * Results_State to (a) fire the game-over sfx once and (b) finalize the Run
   * on EVERY Run-ending edge — a flight death (ground/ceiling/pipe), a battle
   * defeat, or a boss victory — not just the explicit End Run from pause.
   *
   * finalizeRun (candy.js) is the single idempotent award path: it adds this
   * Run's Candy and bumps the saved high score EXACTLY once, guarded by the
   * one-shot `runState.finalized` latch (Req 8.4, 8.6, 11.13, 11.14). End Run
   * from pause already called it via `fsm.endRun()`, so when we reach Results
   * that way the latch is set and this call is a no-op — the award never
   * doubles. Whenever this edge actually performs the award we persist the full
   * SaveData so the earned Candy and high score survive a reload.
   * @returns {{ flap: boolean, flightPower: boolean }}
   */
  function consumeInputIntents() {
    const flight = routeIntents();
    observeFlightFeedback();
    const nowResults = fsm.state === States.Results_State;
    if (nowResults && !wasResults) {
      playSfx("game_over");
      finalizeAndPersist();
    }
    wasResults = nowResults;
    return flight;
  }

  /**
   * Finalize the just-ended Run on the Results edge and persist the full
   * SaveData if the award actually landed (first finalize of a STARTED Run).
   * Idempotent: a Run already finalized (e.g. End Run from pause) returns
   * `finalized: false` and we skip the redundant write. An unstarted Run awards
   * nothing (candy.js returns finalized but adds no Candy) — we still persist
   * nothing extra because its finalize happens through endRun(), not here.
   * Persistence failures are swallowed by writeSave and never interrupt play.
   */
  function finalizeAndPersist() {
    const rs = fsm.runState;
    if (!rs) return;
    // Only a STARTED Run accrues Candy/high score (Req 8.5); candyForRun is 0
    // for an unstarted one anyway. finalizeRun latches and returns whether THIS
    // call performed the award.
    const wasStarted = Boolean(rs.started);
    const { finalized } = finalizeRun(rs, save, CONFIG);
    if (finalized && wasStarted) persistSave();
  }

  /**
   * Persist the whole in-memory SaveData (high score, Candy, owned/equipped
   * Hats, prefs) to browser-local storage via save.js `writeSave` (Req 11.1,
   * 11.4). writeSave never throws — a storage failure is reported as
   * `{ ok: false }` and swallowed here so a persistence problem never
   * interrupts the Game (Req 11.5).
   * @returns {boolean} whether the write succeeded
   */
  function persistSave() {
    const { ok } = writeSave(save);
    return ok;
  }

  // Visibility / focus loss: auto-pause live flight and suspend a running
  // countdown (Req 9.7, 9.13). The FSM's onVisibilityLost handles the state
  // change; the input barrier drops any pending intent across it.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) fsm.onVisibilityLost();
    });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("blur", () => fsm.onVisibilityLost());
  }

  // The game opens in Main_Menu_State (the FSM's initial state); the renderer
  // draws the title/high-score screen until the first gesture starts a Run.

  /**
   * Surface Hover readiness on the on-screen button each frame (Req 1.7): it is
   * enabled only while a power-providing Spirit is equipped AND the Hover
   * cooldown has elapsed, dimmed otherwise. This is display-only — it never
   * changes physics; the authoritative cooldown gate lives in stepFlight.
   */
  function updateFlightPowerButton() {
    if (!flightPowerButton) return;
    const rs = fsm.runState;
    const ready =
      Boolean(rs) &&
      spiritProvidesFlightPower(rs.equippedSpirit) &&
      (rs.hoverCooldown ?? 0) <= 0;
    flightPowerButton.disabled = !ready;
  }

  // Start the fixed-timestep loop. The FSM advances in whole FIXED_DT steps;
  // the renderer draws once per frame with the render-only interpolation alpha.
  startLoop(
    fsm,
    (stateName, alpha) => {
      updateFlightPowerButton();
      renderer(fsm, alpha);
    },
    {
      consumeInputIntents,
    },
  );

  // A tiny handle for manual inspection and the shop/battle action affordances
  // (bound to on-screen controls by later presentation tasks). Nothing in the
  // core loop reads it; it exists so purchases and in-shop potion use are
  // reachable without a richer UI yet.
  /** @type {any} */ (window).__KIRO__ = {
    CONFIG,
    fsm,
    save,
    buyShopItem,
    useShopPotion,
    // Meta-progression affordances (outside-a-Run only). Bound to on-screen
    // controls by the presentation milestone; exposed here so the Wardrobe and
    // portable save are reachable without a richer UI yet.
    openWardrobe: () => fsm.openWardrobe(),
    leaveWardrobe: () => fsm.leaveWardrobe(),
    buyWardrobeHat,
    equipWardrobeHat,
    unequipWardrobeHat,
    exportProgress,
    importProgress,
  };
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
}
