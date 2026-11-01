# Implementation Plan: Flappy Kiro

## Overview

This plan implements the design exactly using the vanilla web stack it specifies: a single `index.html` loading ES modules, one HTML5 Canvas, plain modular JavaScript, no framework, and no build step. Work is organized around the six milestones from the requirements and the design's Design-to-Milestone Mapping, and each milestone ends in a playable checkpoint that runs that milestone's verification checks.

The pure-logic modules (`config.js`, `rng.js`, `loop.js`, `state.js`, `systems/*`, `save.js`) are front-loaded so they can be unit- and property-tested with `fast-check` under a minimal no-browser test runner before any UI or rendering is wired. Each task builds on the previous ones and ends by wiring new logic into the running game, so no code is left orphaned. Missing art is rendered as labeled placeholder shapes in the soft illustrated Halloween style per the design.

## Tasks

- [ ] 1. Milestone 1 — Playable Flight Core

  - [ ] 1.1 Create project shell and central config
    - Create `index.html` with a Canvas and control instructions, and an ES-module entry point under `/src/`
    - Create `src/config.js` exporting a frozen `CONFIG` object holding every value from the Configurable Initial Defaults table: the 960×640 wide landscape Logical_Playfield, gravity, Normal_Flap velocity (set not added), terminal velocity, the Ghosty logical body size (≈32×39), Ghosty initial center (160, 320) and initial vertical velocity 0, Hover duration (0.6 active-flight s) and Hover cooldown (5 active-flight s), scroll base/increment/milestones/max, hitbox inset (4 → derived ≈24×31 Hitbox), pipe width/spacing, gap height, clearances, shield cap, combat numbers, the boss enemy-action sequence (Normal → Telegraph → Special → Normal → Normal → Normal → Telegraph → Special) and special cooldown, prices, triggers, potion inventory initial count 0, candy constants, resume countdown, and save version
    - Create `src/rng.js` with a small seeded RNG for deterministic spawner and tests
    - _Requirements: 1.1, 2.2, 12.1_
    - _Design: config.js, rng.js, index.html, File and Module Structure, Logical Geometry and Coordinate Convention_

  - [ ] 1.2 Set up a minimal no-browser test runner with fast-check
    - Add a lightweight pure-function test runner that runs `systems/*`, `save.js`, and the FSM tick with no DOM, and wire in `fast-check` as the property-test library (do not hand-roll generators)
    - Add an npm script (or equivalent plain-node entry) to run all tests once (no watch mode)
    - Establish the property-test tag convention `Feature: flappy-kiro, Property {n}: {property text}`, minimum 100 iterations per property
    - _Requirements: 1.1_
    - _Design: Testing Strategy_

  - [ ] 1.3 Implement the fixed-timestep loop
    - Create `src/loop.js` implementing the accumulator pattern with `FIXED_DT` = 1/120 s and `MAX_FRAME_TIME` = 0.100 s clamp, advancing the simulation in whole fixed steps and computing a render interpolation `alpha` used for drawing only
    - Expose `startLoop(fsm, render, input)` installing the requestAnimationFrame driver
    - _Requirements: 1.1, 1.9, 1.10_
    - _Design: Fixed-Timestep Simulation Loop, loop.js_

  - [ ]* 1.4 Property tests for the loop
    - **Property 1: Frame-rate independence** — for identical initial state, identical RNG seed, and inputs assigned to identical simulation ticks, two partitions of the same total accepted simulation time into frames yield equivalent committed state and collision outcomes (equivalence defined over equal accepted simulation time, not equal wall-clock time)
    - **Property 4: Max-step clamp** — the simulation advances at most 100 ms of simulation time per frame (tested separately from Property 1)
    - **Validates: Requirements 1.1, 1.10, 1.9**
    - _Design: Testing Strategy_

  - [ ] 1.5 Implement the FSM skeleton, three-clock dispatch, and RunState initialization
    - Create `src/state.js` with `createFSM(config, save)`, the full state enum (Main_Menu, Ready, Active_Flight, Battle, Reward, Shop, Pause, Resume_Countdown, Results, Wardrobe), validated `transition(toState)`, and a `tick(dt, intents)` that dispatches exactly one clock per state: flight simulation (physics, obstacle movement/spawn, flight collisions, Active_Flight_Time accrual, Hover duration/cooldown, Flight_Power and flight cooldowns) advances ONLY in Active_Flight_State; the Resume countdown advances ONLY in Resume_Countdown_State while flight stays frozen; resolved combat turns/cooldowns advance ONLY in Battle_State (never by seconds); no clock advances in any other state; and no clock advances while the browser tab is hidden (do NOT implement a universal freeze)
    - Initialize the complete `RunState` on Ready → first flight per the data model: Pipe_Score 0, Soul_Coins 0, Battle_HP 22, maxBattleHp 22, Active_Flight_Time 0, equipped spirit none, shields 0, `items { potion: 0 }`, attack upgrade not purchased, all Flight_Power/Hover and Battle cooldowns ready, progress pointers at start, enemies-defeated 0, and `started`/`finalized`/`pumpkinShieldGiftUsed` false
    - Implement `started`-flag semantics: `started = false` before flight begins; `started = true` on the first Flap_Input that starts flight; only a started Run finalizes rewards
    - _Requirements: 7.10, 7.11, 9.1, 9.2, 9.3, 9.9_
    - _Design: state.js, FSM tick dispatch, Data Models (RunState)_

  - [ ]* 1.6 Property test for the three-clock model
    - **Property 28: Non-flight states freeze flight simulation while the other two clocks advance only in their own state** — ticking any non-Active_Flight state advances no flight physics, no obstacle movement/spawn, no Active_Flight_Time, no Hover duration/cooldown, and no Flight_Power/flight cooldown, and preserves Shield_Grace; the Resume countdown progresses only in Resume_Countdown_State while flight stays frozen; resolved combat cooldowns/turns advance only in Battle_State; and a hidden tab advances none of the three clocks
    - **Validates: Requirements 9.2, 9.3**
    - _Design: Testing Strategy, FSM tick dispatch_

  - [ ] 1.7 Implement flight physics with center-coordinate geometry
    - Create `src/systems/flight.js` with `stepFlight(runState, intents, dt, config)` integrating gravity up to terminal velocity, applying Normal_Flap by setting (not adding) vertical velocity, using Ghosty's center coordinates (x/y are CENTER), and tracking `prevX`/`prevY` for interpolation
    - Hold Ghosty stationary at the configured initial center (160, 320) with zero vertical velocity in Ready_State (no gravity); start flight on the first Flap_Input by entering Active_Flight_State and setting velocity to the Normal_Flap value
    - _Requirements: 1.2, 1.3, 1.12, 1.13_
    - _Design: systems/flight.js, Data Models (Ghosty), Logical Geometry and Coordinate Convention_

  - [ ]* 1.8 Property test for flap velocity
    - **Property 2: Normal_Flap sets velocity** — a Flap_Input sets vertical velocity to exactly the configured Normal_Flap value regardless of current velocity
    - **Validates: Requirements 1.3**
    - _Design: Testing Strategy_

  - [ ] 1.9 Implement the obstacle spawner and difficulty curve
    - Create `src/systems/spawner.js` with `stepSpawner(...)` moving pipes left at the current scroll speed, spawning pairs at fixed horizontal spacing, and removing off-screen pairs
    - Implement `currentScrollSpeed(activeFlightTime, config)` (base + increments per milestone reached, capped) and `placeGap(prevCenter, rng, config)` honoring min clearance and max gap-center delta, generating only Normal_Flap-navigable pairs
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.9, 2.10_
    - _Design: systems/spawner.js, Data Models (PipePair)_

  - [ ]* 1.10 Property tests for the spawner
    - **Property 5: Scroll speed schedule** — scroll speed equals base + increments reached, is non-decreasing, never exceeds max
    - **Property 6: Every generated pipe pair is valid** — gap keeps min clearance from Ground/Ceiling and gap-center delta within max
    - **Property 7: Off-screen pipes are bounded** — no pair past the left edge remains in the list
    - **Validates: Requirements 2.2, 2.3, 2.5, 2.6, 2.9**
    - _Design: Testing Strategy_

  - [ ] 1.11 Implement swept collision, hitbox, and shields
    - Create `src/systems/collision.js` with `hitboxFor(ghosty, config)` deriving the Hitbox from Ghosty's center ± half the logical body size then inset by the configured amount (≈24×31), never enlarged by hats/spirit decorations/sprite margins/particles/scale; `sweptHitboxVsPipes(...)` returning `none`/`shield`/`fatal` with shield consumption and per-pair Shield_Grace until horizontal clearance; and `groundCeilingFatal(box, config)` (always fatal even shielded)
    - Enforce fatal-collision ordering: stop flight movement, scoring, and encounter triggering before any animation; collision wins over a same-step encounter
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13_
    - _Design: systems/collision.js, Error Handling_

  - [ ] 1.12 Property tests for collisions and shields
    - **Property 8: Fatal unshielded pipe contact** — overlap with a non-grace pipe and zero shields is fatal
    - **Property 9: Shield consumption and same-pipe grace** — consumes one charge, marks grace, non-fatal on that pair until cleared, then ends grace
    - **Property 10: Other hazards stay fatal during grace** — different pair, Ground, Ceiling remain fatal
    - **Property 11: Ground and Ceiling are always fatal** — fatal for any shield count
    - **Property 12: Cosmetics and scale never change the Hitbox** — hitbox/physics fields identical under hats, spirit decoration, display scale
    - **Property 13: No tunneling at any scroll speed** — swept check reports any pipe crossed within a step up to max speed
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.9, 3.10**
    - _Design: Testing Strategy (mandatory critical subset)_

  - [ ] 1.13 Implement scoring
    - Add Pipe_Score logic that awards exactly one point once Ghosty's hitbox fully passes a pair's trailing edge and never double-awards the same pair
    - _Requirements: 10.1, 10.2_
    - _Design: Data Models (PipePair.scored)_

  - [ ]* 1.14 Property test for scoring
    - **Property 24: One point per fully-passed pipe** — each pair increases score by exactly one, only after full pass, never twice
    - **Validates: Requirements 10.1, 10.2**
    - _Design: Testing Strategy_

  - [ ] 1.15 Implement input handling with debounce, barriers, and tick assignment
    - Create `src/input.js` with `pollInput()` translating Space/mouse-in-flight-area into exactly one Normal_Flap per discrete press (key-up required between flaps), routing menu/button clicks as UI intents (never flaps), and scoping intents to the current state so a transition drops the triggering input
    - Implement input-to-tick assignment: timestamp raw events and assign each to the simulation tick in which it is consumed, with `consumeInputIntents()` handing each tick exactly the intents assigned to it so identical inputs on identical ticks are deterministic (supports Property 1); ensure single consumption of each input across transitions
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 9.6, 10.7_
    - _Design: Input Handling, input.js_

  - [ ]* 1.16 Property test for held-key debounce
    - **Property 3: Held-key debounce** — registered Normal_Flaps equal the number of discrete key presses
    - **Validates: Requirements 1.5**
    - _Design: Testing Strategy_

  - [ ] 1.17 Implement audio with graceful degradation
    - Create `src/audio.js` with guarded `playSfx(name)` that unlocks on first user gesture, plays `jump.wav` at most once per flap and `game_over.wav` on fatal collision, and no-ops when audio is missing or blocked
    - _Requirements: 1.4, 1.11, 12.4, 12.5_
    - _Design: audio.js, Error Handling_

  - [ ] 1.18 Implement flight rendering and HUD with center-coordinate Ghosty drawing
    - Create `src/render.js` drawing Canvas layers (background, pipes, Ghosty with interpolation, effects, HUD overlay) with labeled placeholder shapes for missing art in the soft illustrated Halloween style, and `src/ui/hud.js` showing current Pipe_Score
    - Draw Ghosty inside the logical body rect (≈32×39) derived from its center ± half-size, preserving the PNG's aspect ratio and never using the PNG's natural pixel dimensions as gameplay dimensions
    - Fit the 960×640 wide landscape Logical_Playfield to the viewport via a draw-time transform only (letterboxed), keeping collisions in logical coordinates
    - _Requirements: 10.3, 12.1, 12.9, 12.10_
    - _Design: Rendering and Presentation, render.js, ui/hud.js, Logical Geometry and Coordinate Convention_

  - [ ] 1.19 Implement systems/checkpoint.js safe checkpoint selection
    - Create `src/systems/checkpoint.js` with `selectCheckpoint(runState, config)` implementing the between-pipes algorithm: if Ghosty's Hitbox is within a Pipe_Pair's horizontal span, center Ghosty vertically in that pair's Gap at the current x; otherwise center it in the nearest upcoming pair's Gap at an x with full clearance before that pair; set `vy = 0`; verify the resulting Hitbox clears every nearby obstacle, the Ground, and the Ceiling before resuming
    - Add `resumeFromCheckpoint(runState, config)` that applies the checkpoint, sets `vy = 0`, awards no Pipe_Score for unpassed pairs, and synchronizes `prevX`/`prevY` with the new position so no interpolation artifact or false pass occurs (used on Battle/Reward/Shop exit, not on ordinary pause)
    - _Requirements: 9.14, 9.15, 9.16_
    - _Design: systems/checkpoint.js, Battle/Reward/Shop-exit resumption (checkpoint)_

  - [ ] 1.20 Implement ordinary-pause exact-state resumption, resume countdown, restart, and high-score display
    - Wire Pause_State and Resume_Countdown_State for the ordinary-pause path: entering an ordinary pause preserves the EXACT frozen flight state (Ghosty's exact position and velocity, the exact obstacle set, the Hover remainder, all cooldowns, the Shield_Grace state, Pipe_Score, the spawn scheduler state, and the RNG state); resume after the configured 3 s countdown from that exact state with NO recenter and NO velocity reset
    - Drop the pause-dismiss input at the transition boundary so it cannot leak as a Flap_Input or other flight action; if the tab loses visibility or focus during the countdown, suspend resumption and require a deliberate resumption input before counting down again
    - Add restart that does not trigger from the death/confirm input, and Main_Menu high-score display
    - _Requirements: 9.4, 9.5, 9.6, 9.10, 9.11, 9.12, 9.13, 10.4, 10.7_
    - _Design: Ordinary-pause resumption (exact-state), Input Handling, state.js, ui/menu.js_

  - [ ] 1.21 Property test for ordinary-pause preservation
    - **Property 30: Ordinary pause preserves exact flight state** — resuming after the countdown restores Ghosty's exact position and velocity, the exact obstacle set, the Hover remainder, all cooldowns, the Shield_Grace state, Pipe_Score, the spawn scheduler state, and the RNG state, with no recenter and no velocity reset
    - **Validates: Requirements 9.10, 9.11**
    - _Design: Testing Strategy (mandatory critical subset)_

  - [ ] 1.22 Wire the playable flight core and verify Milestone 1
    - Wire `index.html` → `loop.js` → FSM (three-clock dispatch) → flight/spawner/collision/scoring → render/input/audio/HUD into a running Ready→Flight→Pause→Resume→Results→Restart loop in the 960-wide playfield
    - Run the Milestone 1 checks: Property 1 (frame-rate independence over equal accepted simulation time) and Property 28 (three-clock freeze) pass, plus core flight/collision/scoring Properties (2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 24) and Property 30 (ordinary-pause exact resumption) with no input leak; ensure all tests pass, ask the user if questions arise
    - _Requirements: 1.1, 2.2, 3.1, 9.2, 9.11, 10.1_
    - _Design: Design-to-Milestone Mapping (Milestone 1)_

- [ ] 2. Milestone 2 — One Complete Encounter Loop

  - [ ] 2.1 Implement the adventure scheduler with optional-entrance lifecycle (first encounter and first shop)
    - Create `src/systems/scheduler.js` with `stepScheduler(progress, runState, activeFlightTime, config)` that, when Active_Flight_Time crosses the first-Encounter and first-Shop thresholds, SPAWNS an avoidable optional Enemy symbol (`encounterA`) and an avoidable Shop entrance (`shop1`) into the flight world WITHOUT freezing flight on spawn, keeping at least one safe route through the current Gap unobstructed
    - Track each entrance/symbol through the `offered → entered → completed → skipped` lifecycle in `ScheduleProgress`/`LifecycleEntry`; only contact or explicit interaction marks it `entered` and transitions to Shop_State/Battle_State (freezing flight then); passing it without interacting marks it `skipped` and never retriggers; add `markSkipped`/`markEntered` helpers
    - _Requirements: 4.2, 4.5, 4.10, 4.14, 4.15, 4.16, 4.17, 4.18, 7.4_
    - _Design: systems/scheduler.js, Data Models (ScheduleProgress, LifecycleEntry)_

  - [ ] 2.2 Implement the turn-based combat engine for one ordinary enemy
    - Create `src/systems/combat.js` with `startBattle`, `resolvePlayerAction` (player acts first), `resolveEnemyTurn` (skipped if the battle ended on the player turn), and `applyPercentReduction(raw, percent) = max(0, floor(raw*(1-percent)))`
    - Support Attack, Defend (50% reduction to the next incoming attack only, cleared after it resolves), and Use Item; carry Battle_HP between encounters; invalid/cancelled actions consume no turn or item; defeat at 0 Battle_HP; victory ends the battle with no counterattack
    - Track `resolvedPlayerTurns` and `resolvedEnemyTurns` so later cooldown work can count per-owner resolved turns
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.13, 5.14, 5.15_
    - _Design: systems/combat.js, Data Models (BattleState, Enemy)_

  - [ ]* 2.3 Property tests for combat core
    - **Property 14: Player acts first and lethal actions skip the enemy turn** — player resolves first; a lethal player action gives the enemy no turn and no damage
    - **Property 15: Percentage-reduction rounding** — reduced damage equals max(0, floor(raw*(1-percent)))
    - **Property 16: Defend protects exactly one incoming attack** — reduction applies to exactly the next enemy attack then clears
    - **Validates: Requirements 5.6, 5.7, 5.13, 5.14, 5.15**
    - _Design: Testing Strategy (mandatory critical subset)_

  - [ ] 2.4 Implement the economy, potion inventory, and shop
    - Create `src/systems/economy.js` with `shopInventory(config)` (potion, one shield charge, run-limited attack upgrade with prices/effects/quantities) and `purchase(runState, itemId, config)` validating affordability and the attack-upgrade per-run limit, preventing duplicate purchases from one confirmed action, and never allowing a negative balance
    - Implement potion inventory: buying a potion deducts the potion price and increments `RunState.items.potion` by exactly one (one purchase per confirmed action); the shield charge respects the one-charge cap; new-run init leaves `items.potion` at 0
    - Award the configured Soul_Coin reward on ordinary victory and ensure at least one useful first-shop item is affordable from the preceding battle
    - _Requirements: 7.1, 7.2, 7.3, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.12_
    - _Design: systems/economy.js, Data Models (ShopItem)_

  - [ ] 2.5 Implement potion use (battle and shop)
    - Add `usePotion(runState, battle | null, config)` to `src/systems/combat.js`: consume exactly one owned potion and heal up to the configured potion effect (+10) capped at `maxBattleHp`; a no-op (consuming nothing, Battle_HP unchanged) at full HP or with zero potions
    - In Battle_State it consumes exactly one player turn so the enemy responds; in Shop_State it consumes no combat turn, keeps flight frozen, and accrues no Candy time; never usable in Active_Flight_State; count one consume per confirmed action (duplicate/repeated input is one use)
    - _Requirements: 5.24, 5.25, 7.13, 7.14, 7.15, 7.16_
    - _Design: systems/combat.js (usePotion), Data Models (ShopItem)_

  - [ ] 2.6 Property tests for purchases and potion use
    - **Property 21: Purchases are safe** — Soul_Coins never negative, unaffordable purchase rejected with no change, at most one purchase per confirmed action, a confirmed affordable potion purchase deducts the price and increments `items.potion` by exactly one, attack upgrade within its per-run limit
    - **Property 32: Potion use heals within bounds and costs the right turn** — a confirmed use with a potion owned and Battle_HP below max consumes exactly one potion and heals up to the capped effect, costing one player turn in Battle_State and no turn/no Candy time in Shop_State; owning no potion or being at max HP consumes nothing and leaves Battle_HP unchanged; never usable in Active_Flight_State; duplicate input for one confirmed use counts once
    - **Validates: Requirements 5.24, 5.25, 7.6, 7.7, 7.8, 7.12, 7.13, 7.14, 7.15, 7.16**
    - _Design: Testing Strategy (mandatory critical subset)_

  - [ ] 2.7 Implement the dedicated battle scene and shop UI with freeze and safe resumption
    - Create `src/ui/battle.js` presenting a dedicated battle scene (separate from the stored frozen flight world) that shows Ghosty with the equipped Hat and Spirit appearance, the enemy/Final_Boss, both Battle_HP displays, the enemy intent and any special-attack warning, the Attack/Defend/Use Item actions plus any applicable Spirit action, and readable feedback for each resolved action; draw characters and scenery with Canvas and local art in the soft illustrated Halloween style (no pixel-art mandate) and MAY use lightweight HTML controls for keyboard navigation and focus
    - On entering Battle_State, store the frozen flight world as a separate snapshot so the flight world is unchanged when the Battle ends; create `src/ui/shop.js` showing each item's effect, price, quantity, and affordability plus in-shop potion use
    - Show pre-contact enemy info (identity, relative danger, expected reward/available Spirit); start a Battle and freeze flight on contact; return to flight via `resumeFromCheckpoint` and the resume countdown with no input leak
    - _Requirements: 4.6, 4.7, 5.21, 5.22, 5.23, 7.4, 7.5, 9.2, 9.3, 9.5, 9.6, 12.11_
    - _Design: ui/battle.js, ui/shop.js, Rendering and Presentation (Dedicated battle scene), Input Handling_

  - [ ] 2.8 Property test and example tests for checkpoint resumption and no input leak
    - **Property 31: Checkpoint resumption is safe and scores nothing unpassed** — the selected checkpoint centers Ghosty in a valid Gap with a Hitbox clearing every nearby obstacle, the Ground, and the Ceiling, sets vy = 0, awards no Pipe_Score for unpassed pairs, and syncs `prevX`/`prevY` so no interpolation artifact or false pass occurs
    - Checkpoint example test: set up a run with a known Gap, resume via the checkpoint path, assert Ghosty is centered in a valid Gap with vy = 0, the Hitbox clears nearby obstacles/Ground/Ceiling, no unpassed pipe is scored, and `prevX/prevY` are synced
    - No-input-leak example test: feed a confirming input at a transition (including the pause-dismiss input) and assert the destination state does not also flap/act/restart from that same input
    - **Validates: Requirements 9.6, 9.12, 9.14, 9.15, 9.16, 10.7**
    - _Design: Testing Strategy (mandatory critical subset: checkpoint; Example/unit tests: no input leak)_

  - [ ] 2.9 Wire the encounter loop and verify Milestone 2
    - Wire scheduler (optional-entrance lifecycle) → encounter contact → Battle (dedicated scene) → Reward (Soul_Coins) → Shop (purchase + in-shop potion use) → checkpoint resume-to-flight into the running game, confirming optional Shop/Enemy entrances can be skipped without retriggering
    - Run the Milestone 2 checks: Properties 21 (safe purchases incl. potion increment), 31 (safe checkpoint), 32 (potion use), and 14 (no counterattack) pass, plus the checkpoint and no-input-leak example tests, and a manual run completes Encounter→Battle→Reward→Shop→checkpoint resume; ensure all tests pass, ask the user if questions arise
    - _Requirements: 4.7, 4.17, 5.6, 7.2, 9.5, 9.14_
    - _Design: Design-to-Milestone Mapping (Milestone 2)_

- [ ] 3. Milestone 3 — Spirits and Possession

  - [ ] 3.1 Implement possession and spirit tracking
    - Create `src/systems/spirits.js` with `possess(runState, spiritId, config)` replacing the single equipped spirit, keeping at most one equipped (no party/collection), lasting only the current Run, and leaving the base Ghosty fully playable with no spirit
    - Grant the one-time Pumpkin_Guardian Shield gift respecting the per-run latch and the one-charge cap; retain existing shield charges on switch; never refill Battle_HP, consumables, shields, or cooldowns on switch (including never refilling `hoverCooldown`)
    - _Requirements: 3.14, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8, 6.10, 6.11, 6.17_
    - _Design: systems/spirits.js, Data Models (Spirit)_

  - [ ]* 3.2 Property tests for possession
    - **Property 19: Possession never refills resources** — switching leaves Battle_HP, consumables, shields, cooldowns unchanged (except the one Pumpkin gift) and retains existing shields
    - **Property 20: Pumpkin_Guardian gift is once per Run and capped** — gift granted at most once across possess/re-equip/re-acquire; shields never exceed the cap
    - **Validates: Requirements 3.14, 6.10, 6.11**
    - _Design: Testing Strategy_

  - [ ] 3.3 Implement Hover (Storm_Bat Flight_Power) and Flight_Power input
    - Add the Hover state machine to `src/systems/flight.js` via `activateHover(runState, config)` and Hover handling in `stepFlight`: activation (only if `hoverCooldown <= 0`) sets `vy = 0` and suspends gravity for the configured Hover duration (0.6 active-flight s) while pipes keep moving, Active_Flight_Time keeps accruing, and all collision rules stay active; start the 5 s cooldown from activation; a Normal_Flap during Hover cancels Hover, applies the flap velocity, and does NOT refund the cooldown; a same-tick Normal_Flap beats Hover activation (flap wins, Hover does not activate that tick); natural expiry resumes gravity from `vy = 0`; `hoverRemaining` and `hoverCooldown` advance only in Active_Flight_State and freeze outside it; switching Spirits never refills `hoverCooldown`
    - Add Flight_Power activation in `src/input.js` (the E key plus a visible on-screen button) that fires only when a power-providing Spirit is equipped and its cooldown has elapsed; otherwise ignore and leave velocity and cooldown unchanged
    - _Requirements: 1.7, 1.8, 6.7, 6.9, 6.12, 6.13, 6.14, 6.15, 6.16, 6.17_
    - _Design: systems/flight.js (activateHover), Input Handling, ui/hud.js_

  - [ ] 3.4 Property test for Hover
    - **Property 29: Hover suspends gravity for its duration while the world keeps moving** — activating Hover sets vy = 0 and suspends gravity for exactly the configured duration of Active_Flight time while pipes keep moving, Active_Flight_Time keeps accruing, and collision rules stay active; a Normal_Flap during Hover cancels it, applies the flap velocity, and does not refund the cooldown; a same-tick flap wins so Hover does not activate that tick; natural expiry resumes gravity from vy = 0; and the duration/cooldown advance only in Active_Flight and are never refilled by switching Spirits
    - **Validates: Requirements 6.9, 6.12, 6.13, 6.14, 6.15, 6.16, 6.17**
    - _Design: Testing Strategy (mandatory critical subset)_

  - [ ] 3.5 Implement spirit combat moves and the possession offer flow
    - Add the Storm_Bat lightning move (configured damage and 2-turn cooldown, owned on `RunState.lightningCooldown`) and the Pumpkin_Guardian fortified defend (75% reduction to the next incoming attack) to `src/systems/combat.js`, offered as a spirit move when the Spirit provides one
    - After an ordinary victory, grant rewards then offer Possession in Reward_State: replace the current Spirit or decline; explain both the one flight and one combat benefit before the choice
    - _Requirements: 5.3, 6.1, 6.2, 6.6, 6.7, 6.8_
    - _Design: systems/combat.js, systems/spirits.js, ui/battle.js_

  - [ ] 3.6 Wire spirits into the running game and verify Milestone 3
    - Wire possession, Hover/Flight_Power, and spirit combat moves into Reward_State, flight, and battle so both Spirits show distinct flight and combat effects
    - Run the Milestone 3 checks: Properties 19, 20, and 29 pass (no switch-refill, Pumpkin gift once and capped, Hover suspends gravity with flap-cancel and no cooldown refill); ensure all tests pass, ask the user if questions arise
    - _Requirements: 6.1, 6.7, 6.8, 6.11, 6.12_
    - _Design: Design-to-Milestone Mapping (Milestone 3)_

- [ ] 4. Milestone 4 — Adventure and Final Boss

  - [ ] 4.1 Implement the full adventure schedule
    - Extend `scheduler.js` to spawn `encounterA` (15s), `shop1` (35s), `encounterB` (60s, the other ordinary enemy type), `shop2` (85s), and present the `boss` (120s), keeping second-enemy and second-shop strictly between first-shop and boss, each optional with a viable route and an unobstructed safe Gap route, and all optional entrances tracked through the offered→entered→completed→skipped lifecycle
    - Present the Final_Boss at a safe checkpoint when the boss trigger is reached
    - _Requirements: 4.1, 4.3, 4.4, 4.8, 4.9, 4.11, 4.12, 4.13, 4.14_
    - _Design: systems/scheduler.js_

  - [ ] 4.2 Implement precise per-owner cooldowns and the Final_Boss action sequence
    - Update `src/systems/combat.js` for per-owner resolved-turn cooldowns: player ability cooldowns count subsequent resolved player turns and boss ability cooldowns count subsequent resolved enemy turns, with NO decrement on the turn that starts the cooldown nor on an invalid/cancelled action; the 2-turn lightning move blocks the next two resolved player turns; cooldown ownership lives on the run/per-ability state so `startBattle`/BattleState creation and spirit switch never refill or reset a player cooldown
    - Add the boss behavior: walk the explicit enemy-action sequence Normal → Telegraph → Special → Normal → Normal → Normal → Telegraph → Special via `bossActionIndex` (advanced only when the enemy actually takes a turn); telegraph the special one enemy turn before it lands; deal no attack damage on a Telegraph turn; require three subsequent resolved enemy turns after a Special before re-telegraphing; a defeated boss takes no further turn and does not advance the index; use the same combat system as ordinary battles; a Run concludes in victory only after the boss is defeated
    - _Requirements: 4.8, 5.12, 5.16, 5.17, 5.18, 5.19, 5.20_
    - _Design: systems/combat.js, Data Models (BattleState)_

  - [ ] 4.3 Property tests for cooldowns and boss sequence
    - **Property 17: Cooldowns advance only by resolved turns, by owner** — a player cooldown drops one per subsequent resolved player turn and a boss cooldown one per subsequent resolved enemy turn, never on the starting/invalid turn and never from real time; the 2-turn lightning move blocks the next two resolved player turns; creating a BattleState or switching Spirits never refills or resets a player cooldown
    - **Property 18: Boss follows the explicit enemy-action sequence** — enemy actions follow Normal → Telegraph → Special → Normal → Normal → Normal → Telegraph → Special, the special is telegraphed the enemy turn before it lands, a Telegraph turn deals no damage, the special cooldown requires three subsequent resolved enemy turns before re-telegraph, and a defeated boss takes no further turn and does not advance the sequence
    - **Validates: Requirements 5.8, 5.16, 5.17, 5.18, 5.19, 5.20**
    - _Design: Testing Strategy (mandatory critical subset)_

  - [ ] 4.4 Example test for the base-ghost boss-win trace
    - Replay the exact documented optimal-play sequence vs the Final_Boss (Ghosty HP 22, Attack 5; Boss HP 30, normal 4, special 8, Defend 50% rounded down) under the enemy-action sequence Normal → Telegraph → Special → Normal → Normal → Normal → Telegraph → Special, attacking every turn except Defending on the turn the Special lands, using only Attack and Defend with no spirit/item
    - Assert the boss reaches 0 HP on the Player turn, takes no further enemy turn, and the Player survives with exactly a 2 HP margin
    - **Validates: Requirements 5.20**
    - _Design: Testing Strategy (Example/unit tests), Configurable Initial Defaults (validated trace)_

  - [ ] 4.5 Implement the results screen content and actions
    - Build Results_State content: victory status or cause of defeat, final Pipe_Score, Active_Flight_Time, enemies defeated, the Candy calculation, Candy earned, and updated total; actions to restart, return to Main_Menu, and open Wardrobe
    - _Requirements: 10.5, 10.6_
    - _Design: Rendering and Presentation, ui/menu.js_

  - [ ] 4.6 Wire the full adventure and verify Milestone 4
    - Wire the full schedule, boss battle, and Results content into a complete opening→boss→victory/defeat Run
    - Run the Milestone 4 checks: Properties 17 and 18 pass and the base-ghost boss-win trace example test (win at a 2 HP margin) passes; ensure all tests pass, ask the user if questions arise
    - _Requirements: 4.3, 4.8, 5.12, 5.20, 10.5_
    - _Design: Design-to-Milestone Mapping (Milestone 4)_

- [ ] 5. Milestone 5 — Meta-Progression and Saves

  - [ ] 5.1 Implement candy accrual and idempotent finalize
    - Create `src/systems/candy.js` with `candyForRun(activeFlightTime, bossDefeated, config) = floor(activeFlightTime/15) + (bossDefeated ? bonus : 0)` and `finalizeRun(runState, save, config)` that awards Candy and updates the high score exactly once (one-shot guard), counting only Active_Flight_Time; award nothing for an unstarted Run (started = false)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 11.13, 11.14_
    - _Design: systems/candy.js, Data Models (RunState.finalized)_

  - [ ] 5.2 Property tests for candy and finalize
    - **Property 22: Candy formula** — Candy equals floor(time/15) plus boss bonus when defeated, depending on no other time
    - **Property 23: Finalize awards exactly once** — any number of finalizes adds Candy once and updates high score at most once (only when final Pipe_Score exceeds stored)
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.6, 11.14**
    - _Design: Testing Strategy (mandatory critical subset)_

  - [ ] 5.3 Implement local save load/write with validation
    - Create `src/save.js` with `loadSave(config)` (reads localStorage, validates against the schema, falls back to safe defaults on missing/corrupt, never throws) and `writeSave(save)` (persists promptly, catches storage exceptions, returns `{ok:false}` without crashing)
    - Persist high score, Candy, owned Hats, equipped Hat, and audio/motion prefs; save promptly after a purchase or finalized reward
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
    - _Design: save.js, Data Models (SaveData), Error Handling_

  - [ ] 5.4 Property test for load tolerance
    - **Property 25: Load tolerates any stored value** — any stored string (including missing/corrupt) yields schema-valid SaveData with safe defaults and never throws
    - **Validates: Requirements 11.2, 11.3**
    - _Design: Testing Strategy (mandatory critical subset)_

  - [ ] 5.5 Implement save export/import with validate→preview→confirm→replace
    - Add `exportSave(save)` producing a named JSON blob with game id, version, progress, and prefs, excluding any unfinished Run; add `parseImport(text, config)` validating the whole file (game id, supported version, numeric values, known Hat ids, equipped Hat owned) before any change
    - Reject malformed/unsupported imports with a useful message leaving progress unchanged; on valid import, preview incoming progress, require explicit confirmation, then replace (not merge) and save immediately; expose Export/Import only outside an active Run; do not restore an unfinished Run on reload
    - _Requirements: 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 11.12_
    - _Design: save.js, Data Models (Save schema)_

  - [ ] 5.6 Property tests for export/import
    - **Property 26: Export/import round-trip** — exporting then importing yields SaveData equal to the original (replace, not merge)
    - **Property 27: Invalid imports leave progress unchanged** — wrong game id, unsupported version, non-numeric values, unknown Hat id, or unowned equipped Hat is rejected with progress untouched
    - **Validates: Requirements 11.7, 11.8, 11.9, 11.11**
    - _Design: Testing Strategy (mandatory critical subset)_

  - [ ] 5.7 Implement the Wardrobe and hats
    - Create `src/ui/wardrobe.js` offering the four Hats (Witch Hat, Pumpkin Cap, Bat Bonnet, Haunted Crown) at configured Candy prices plus the free no-hat default; buying rejects duplicates and insufficient Candy leaving Candy/ownership unchanged
    - Allow equipping/unequipping owned Hats at no cost, forbid equipping unowned Hats, and treat Hats as cosmetic only (no stats/physics/hitbox/score effect)
    - _Requirements: 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13_
    - _Design: ui/wardrobe.js, Data Models (SaveData)_

  - [ ] 5.8 Implement auto-pause, End Run, and unstarted-run handling
    - Add a `visibilitychange`/`blur` listener forcing Pause_State during flight with deliberate countdown resumption; add a Pause End Run action that finalizes the current Run; distinguish End Run from cancelling an unstarted Run (started = false) so cancelling finalizes no rewards
    - _Requirements: 9.7, 9.8, 9.9_
    - _Design: Input Handling, Error Handling_

  - [ ] 5.9 Wire meta-progression and verify Milestone 5
    - Wire candy finalize, save load/write, export/import, and Wardrobe into Results/Main_Menu so earned Candy persists and hats equip across reloads
    - Run the Milestone 5 checks: Properties 22, 23, 25, 26, 27 pass; ensure all tests pass, ask the user if questions arise
    - _Requirements: 8.1, 8.8, 11.1, 11.7, 11.8_
    - _Design: Design-to-Milestone Mapping (Milestone 5)_

- [ ] 6. Milestone 6 — Presentation and Final Verification

  - [ ] 6.1 Complete canvas layers, placeholder art, and logical-playfield scaling
    - Finalize `render.js` back-to-front layers (background, obstacles, entities, effects, HUD/UI) with labeled colored placeholder shapes in the soft illustrated Halloween style for all missing art (enemies ×2, boss, hats ×4, spirits ×2), ensuring effects never affect coordinates
    - Confirm the draw-time viewport fit/letterbox for the 960×640 wide landscape keeps `hitboxFor` and collisions in logical coordinates at any display size, and that Ghosty is drawn inside its logical body rect with aspect ratio preserved
    - _Requirements: 12.1, 12.3, 12.9, 12.10_
    - _Design: Rendering and Presentation_

  - [ ] 6.2 Complete HUD, battle-scene presentation, feedback, and accessibility
    - Finalize the soft illustrated Halloween HUD showing Pipe_Score, Soul_Coins, Candy distinctly, Battle_HP, prices, effects, and cooldowns; present the dedicated battle scene readably (enemy intent, special-attack warnings, both Battle_HP displays); add clear feedback for flap, score, shield break, battle actions/damage, rewards/purchases, possession, fatal collision, and boss victory
    - Add keyboard-operable menus with visible focus, text/icon info in addition to color, audio controls, and a reduced-motion option limiting shake/heavy animation
    - _Requirements: 12.2, 12.6, 12.7, 12.8, 12.11_
    - _Design: Rendering and Presentation, ui/hud.js, ui/battle.js_

  - [ ] 6.3 Balancing pass against targets
    - Tune `config.js` values only against the target Adventure duration (3–5 min) and ordinary battle length (3–5 turns), keeping the validated boss-win math intact; re-run the boss-win trace test after any combat-number change
    - _Requirements: 4.1, 5.10, 5.20_
    - _Design: config.js, Error Handling_

  - [ ]* 6.4 Optional additional randomized coverage and presentation polish
    - Optional-only: broader randomized property runs beyond the mandatory critical subset (additional generators, higher iteration counts, extra edge-case fuzzing); background music, elaborate particles/trails/screen shake, and richer art beyond placeholders, all gated by the reduced-motion/audio prefs and never affecting coordinates or collisions
    - _Requirements: 12.3, 12.8_
    - _Design: Testing Strategy (additional coverage), Rendering and Presentation (Optional Polish)_

  - [ ] 6.5 Final full verification
    - Run the complete property suite (Properties 1–32) plus all example tests (boss-win trace, checkpoint resumption, no input leak) and confirm green
    - Run the Milestone 6 check: Property 12 (scale/cosmetic invariance) passes and a manual accessibility/readability pass confirms color-plus-text info, reduced motion, audio activation, viewport-resize fairness in the wide landscape, and the readable battle scene; ensure all tests pass, ask the user if questions arise
    - _Requirements: 1.1, 12.7, 12.8, 12.9, 12.11_
    - _Design: Design-to-Milestone Mapping (Milestone 6)_

## Notes

- A MANDATORY CRITICAL subset of tests is NON-OPTIONAL and is never marked with `*`, because the checkpoint/resume, combat, economy, and save guarantees depend on them: collision and Shield behavior (Properties 8–13); ordinary-pause and checkpoint resumption (Properties 30, 31) plus the checkpoint example test; Hover (Property 29); combat including per-owner cooldowns and the boss enemy-action sequence and the base-ghost boss-win trace (Properties 15–18 and the trace example); potion inventory and potion-use semantics (Properties 21, 32); Candy finalization (Properties 22, 23); and save load/round-trip/invalid-import (Properties 25–27). These must pass regardless of deadline pressure.
- Tasks marked with `*` are ADDITIONAL randomized coverage and genuinely optional presentation polish only — broader fuzzing beyond the critical subset, and optional art/music/particles. They strengthen confidence but are not ship blockers, and core implementation tasks are never marked optional. This replaces any earlier impression that the whole test suite was optional while checkpoints demanded it: the critical subset above is required.
- Each task references the specific requirement clauses it satisfies and the relevant design component(s) for traceability.
- Property tests use `fast-check`, run a minimum of 100 iterations, and are tagged `Feature: flappy-kiro, Property {n}: {property text}`. Each property is its own sub-task placed close to the implementation it checks.
- Each milestone ends with a verification/checkpoint task that runs that milestone's checks from the Design-to-Milestone Mapping table.
- Placeholder shapes in the soft illustrated Halloween style stand in for all missing art so gameplay logic can be proven before art exists; real art drops in later with no logic changes.
- This workflow produces design and planning artifacts only; implementation happens when tasks are executed.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.9"] },
    { "id": 2, "tasks": ["1.4", "1.5", "1.7", "1.10"] },
    { "id": 3, "tasks": ["1.6", "1.8", "1.11", "1.15", "1.17"] },
    { "id": 4, "tasks": ["1.12", "1.13", "1.16", "1.18", "1.19"] },
    { "id": 5, "tasks": ["1.14", "1.20"] },
    { "id": 6, "tasks": ["1.21", "1.22", "2.1", "2.2", "2.4"] },
    { "id": 7, "tasks": ["2.3", "2.5"] },
    { "id": 8, "tasks": ["2.6", "2.7"] },
    { "id": 9, "tasks": ["2.8", "2.9", "3.1", "3.3"] },
    { "id": 10, "tasks": ["3.2", "3.4", "3.5"] },
    { "id": 11, "tasks": ["3.6", "4.1", "4.2"] },
    { "id": 12, "tasks": ["4.3", "4.4", "4.5"] },
    { "id": 13, "tasks": ["4.6", "5.1", "5.3"] },
    { "id": 14, "tasks": ["5.2", "5.4", "5.5", "5.7", "5.8"] },
    { "id": 15, "tasks": ["5.6", "5.9", "6.1", "6.2"] },
    { "id": 16, "tasks": ["6.3", "6.4", "6.5"] }
  ]
}
```
