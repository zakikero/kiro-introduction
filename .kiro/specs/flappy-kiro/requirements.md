# Requirements Document

## Introduction

Flappy Kiro is a desktop-first, Halloween-themed flying RPG starring Ghosty, a small friendly ghost. Ghosty flies through a haunted, side-scrolling world of pipes under a purple-and-orange moonlit sky. The core gameplay loop is: fly through obstacles, choose optional enemy encounters, fight short turn-based battles, earn rewards and possess defeated enemies, visit shops, and continue toward a final boss. Possessing an enemy spirit changes both how Ghosty flies and what Ghosty can do in battle.

The first release ships a single Adventure mode that ends in a final boss and a victory or defeat result. Across runs, players earn a permanent cosmetic currency called Candy and spend it on Halloween hats in a Wardrobe. The experience is playful and atmospheric rather than frightening: haunted scenery, pumpkins, bats, spirits, and moonlight, rendered as readable Halloween art in the supplied soft illustrated style.

The Game presents a wide landscape desktop layout. Ghosty matches the supplied ghost's soft illustrated appearance, and all produced artwork follows that same soft illustrated Halloween style rather than a mandatory pixel-art grid.

The Game runs entirely in a modern desktop web browser with no backend, account, or network dependency. Progress is saved to browser-local storage, and players can export and import a portable save file to move progress between computers. Supplied assets are the Ghosty sprite (`assets/ghosty.png`), a flap sound (`assets/jump.wav`), and a game-over sound (`assets/game_over.wav`). Artwork for enemies, the final boss, hats, and spirits does not currently exist and must be produced as simple original local art.

This document is a complete rewrite that supersedes the earlier basic Flappy Bird clone specification. It preserves the useful flight, scoring, and collision mechanics but recasts them into the Halloween RPG structure and resolves all prior contradictions.

## Resolved Contradictions

This specification explicitly resolves the following contradictions from the earlier version. The losing side is removed and MUST NOT reappear in later documents.

- **Per-frame movement is replaced by time-based simulation.** All motion, cooldowns, and timers use elapsed simulation time; difficulty is independent of frame rate.
- **Constant scroll speed is replaced by bounded progressive difficulty.** Scroll speed increases at defined Active Flight milestones and stays constant between them, up to a maximum.
- **Endless-only wording is replaced by Adventure mode.** Endless mode is deferred.
- **Always-fatal pipe contact is qualified by Shield protection.** A Shield absorbs one pipe collision; ground and ceiling contact remain fatal even while shielded.
- **Flight-only states are replaced by a full state machine** that includes Battle, Shop, Reward, Wardrobe, Pause, Resume Countdown, and Results states.
- **Mandatory touch support is replaced by desktop-first keyboard-and-mouse support.** Mobile and touch are deferred.
- **Universal freeze outside flight is replaced by three separate clocks.** Earlier wording that every non-flight state advances nothing time-based (and that battle cooldowns freeze outside flight) is corrected: flight simulation time advances only in Active_Flight_State, the Resume countdown advances in Resume_Countdown_State, and combat cooldowns advance by resolved combat turns in Battle_State. The universal-freeze wording MUST NOT reappear.
- **Forced shops are replaced by optional, avoidable Shop entrances.** Earlier wording that presenting a Shop freezes flight is corrected: a scheduled threshold spawns an avoidable Shop entrance, and only contact or explicit interaction enters Shop_State and freezes flight. The forced-shop wording MUST NOT reappear.
- **Storm_Bat's upward burst is replaced by Hover.** Earlier wording that Storm_Bat grants a stronger upward flight burst is corrected: Storm_Bat's flight benefit is Hover. The upward-burst wording MUST NOT reappear.
- **Portrait layout is replaced by a wide landscape layout.** Earlier wording that the Logical_Playfield is 480 wide is corrected to a landscape 960-wide playfield. The portrait-only (480 wide) wording MUST NOT reappear.
- **Pause teleport/recenter is replaced by exact frozen-state resumption.** Earlier wording that resumption repositions Ghosty after an ordinary pause is corrected: ordinary pauses resume from the exact frozen state without teleporting or recentering Ghosty. Only the encounter/shop-exit checkpoint case repositions Ghosty. The pause-teleport wording MUST NOT reappear.
- **Mandatory pixel-art presentation is replaced by the soft illustrated Halloween style.** Earlier wording implying retro pixel art is softened to readable Halloween art in the supplied soft illustrated style.

## Glossary

- **Game**: The complete Flappy Kiro application running in a desktop web browser.
- **Player**: The human user interacting with the Game.
- **Ghosty**: The player-controlled ghost character, rendered from `assets/ghosty.png` by default.
- **Logical_Playfield**: The fixed logical coordinate space (in logical pixels) in which all physics and collisions are computed, independent of on-screen display size. Initial size: 960 wide by 640 tall (a wide landscape layout), configurable.
- **Flap_Input**: A Player action that commands a normal flap: the Space key or a mouse click inside the flight area.
- **Gravity**: The constant downward acceleration applied to Ghosty, expressed in logical px/s².
- **Normal_Flap**: A flap that immediately sets Ghosty's vertical velocity to a fixed configured upward value (not additive).
- **Flight_Power**: An active spirit ability triggered by a dedicated key and a visible on-screen button while a Spirit providing one is equipped.
- **Hover**: Storm_Bat's Flight benefit, activated by the E key or a dedicated on-screen button, that sets Ghosty's vertical velocity to zero and suspends Gravity for a fixed duration while pipes keep moving, Active_Flight_Time keeps accruing, and all collision rules stay active. Hover has a duration and a cooldown measured in Active_Flight time; both freeze outside Active_Flight.
- **Pipe_Pair**: A top pipe and a bottom pipe separated by a vertical Gap, scrolling right to left.
- **Gap**: The vertical opening within a Pipe_Pair through which Ghosty passes.
- **Ground**: The bottom boundary of the Logical_Playfield.
- **Ceiling**: The top boundary of the Logical_Playfield.
- **Hitbox**: The slightly-forgiving collision rectangle used for Ghosty, smaller than the full rendered sprite.
- **Shield**: A consumable protection that absorbs exactly one pipe collision. Capped at one charge in the first release. Does not protect against Ground or Ceiling contact.
- **Shield_Grace**: The clearance window during which the specific Pipe_Pair that consumed a Shield charge cannot end the Run, lasting until Ghosty's Hitbox has fully cleared that Pipe_Pair horizontally.
- **Active_Flight**: The state in which Ghosty is flying, obstacles move and spawn, flight collisions are checked, and Active Flight time accrues.
- **Active_Flight_Time**: Accumulated simulation time spent in Active_Flight only; excludes battles, shops, rewards, menus, pause, countdowns, hidden-tab time, and results.
- **Adventure**: The first-release game mode: a single structured run ending at a Final Boss, producing a victory or defeat Result.
- **Run**: A single play-through of Adventure, from the start of flight to a finalized Result.
- **Encounter**: An optional meeting with an ordinary Enemy that, on contact, starts a Battle.
- **Enemy**: An ordinary hostile creature encountered during flight. Two ordinary types ship initially.
- **Final_Boss**: The required, distinctive enemy that must be defeated to conclude an Adventure with victory.
- **Battle**: A turn-based combat episode that freezes flight.
- **Battle_HP**: The Player's combat survival pool, separate from flight collision protection; carries between encounters within a Run.
- **Spirit**: A possessable creature essence that provides exactly one Flight benefit and one combat benefit. Two ship initially: Storm_Bat and Pumpkin_Guardian.
- **Storm_Bat**: A Spirit granting Hover as its Flight benefit and a lightning combat move.
- **Pumpkin_Guardian**: A Spirit granting a one-time Shield gift on first possession in a Run and a fortified defensive combat move.
- **Possession**: The act of replacing the currently equipped Spirit with a defeated Enemy's Spirit after a victory.
- **Pipe_Score**: The performance count of Pipe_Pairs fully passed this Run.
- **Soul_Coins**: The in-Run spendable currency earned from victories; resets each Run.
- **Candy**: The permanent cosmetic currency earned across Runs; persists between Runs.
- **Shop**: An in-Run store sold at a Shop entrance. A scheduled threshold spawns an avoidable Shop entrance during flight; only contact or explicit interaction enters Shop_State, which freezes flight and sells consumables and a temporary upgrade. A Shop entrance is optional and avoidable.
- **Potion_Inventory**: The per-Run count of owned potions, stored as `items { potion }`, initialized to zero each Run; each potion purchase increments the count by exactly one and each successful use consumes exactly one.
- **Hat**: A cosmetic item purchased with Candy and worn by Ghosty; has no gameplay effect.
- **Wardrobe**: The out-of-gameplay screen for buying, equipping, and unequipping Hats.
- **Main_Menu_State**: The state shown on load, offering start, Wardrobe, and save import/export.
- **Ready_State**: The pre-flight state waiting for the Player to begin a Run.
- **Active_Flight_State**: The state of live flight (equivalent to Active_Flight).
- **Battle_State**: The turn-based combat state.
- **Reward_State**: The post-victory state showing rewards and the Possession choice.
- **Shop_State**: The in-Run shopping state.
- **Pause_State**: The state in which the Run is suspended and resumption is deliberate.
- **Resume_Countdown_State**: The visible countdown shown before returning to Active_Flight.
- **Results_State**: The end-of-Run state showing victory or defeat and all earned values.
- **Save_Data**: The versioned, browser-local persistent record of high score, Candy, owned Hats, equipped Hat, and audio/motion preferences.

## First-Release Scope and Exclusions

### Confirmed In Scope

- Adventure mode with a Final Boss and a victory or defeat Result.
- Desktop keyboard-and-mouse controls.
- Two ordinary Enemy types and two corresponding possessable Spirits.
- One Final Boss.
- A small Shop inventory (battle-HP potion, one Shield charge, a run-limited attack upgrade).
- Four purchasable cosmetic Hats.
- Local progress saving and portable save export/import.
- A forgiving opening followed by bounded increasing difficulty.

### Explicit Exclusions (do not add)

- Endless mode (deferred).
- Mobile and touch support (deferred).
- Accounts, backend, automatic cloud sync, or online leaderboards.
- Multiplayer.
- Payments or monetization.
- Runtime AI calls.
- Encryption, anti-cheat, and save merging.
- Restoring unfinished Runs after reload.

### Optional Polish (not required to ship)

- Additional enemies, elaborate art, background music, complex particles, trails, and screen shake.

### Missing Art (must be produced as simple original local art)

- Ordinary Enemy artwork (two types) — does not exist.
- Final Boss artwork — does not exist.
- Hat artwork (four Hats) — does not exist.
- Spirit / possessed-appearance artwork (two Spirits) — does not exist.

Art production MUST NOT block proving the core loop; placeholder shapes are acceptable initially.

## Configurable Initial Defaults

All values below are defaults chosen for the first release and MUST be centrally configurable. Logical units are logical pixels and simulation seconds.

| Parameter | Default | Unit / Notes |
| --- | --- | --- |
| Logical_Playfield width | 960 | logical px (wide landscape layout) |
| Logical_Playfield height | 640 | logical px |
| Gravity | 1600 | logical px/s² (downward) |
| Normal_Flap velocity | -480 | logical px/s (negative = up); velocity is set, not added |
| Terminal downward velocity | 700 | logical px/s |
| Ghosty logical body size | ≈32 × 39 | logical px (width × height); drives the sprite draw rect and the Hitbox, independent of the PNG's natural pixel dimensions |
| Ghosty initial center | (160, 320) | logical px; x/y are CENTER coordinates |
| Ghosty initial vertical velocity | 0 | logical px/s; Ghosty is stationary in Ready_State until the first Flap_Input |
| Hover duration | 0.6 | Active_Flight simulation s |
| Hover cooldown | 5 | Active_Flight simulation s; starts on activation |
| Ghosty Hitbox inset | 4 | logical px inset on each side from the logical body bounds |
| Ghosty Hitbox dimensions | ≈24 × 31 | logical px (derived: 32 − 2×4 = 24 wide, 39 − 2×4 = 31 tall) |
| Obstacle (pipe) width | 70 | logical px |
| Pipe_Pair horizontal spacing | 240 | logical px between successive pairs |
| Gap height | 180 | logical px |
| Minimum clearance from Ground/Ceiling | 40 | logical px |
| Max gap-center change between successive pairs | 120 | logical px |
| Base scroll speed | 140 | logical px/s |
| Scroll speed increment per milestone | 20 | logical px/s |
| Scroll speed milestones | at 20, 45, 75, 110 | seconds of Active_Flight_Time |
| Max scroll speed | 220 | logical px/s |
| Shield charge cap | 1 | charges |
| Starting Battle_HP | 22 | HP; raised from 20 by the minimal +2 so the base Ghosty (Attack 5) defeats the Final_Boss using only Attack and Defend. Validated optimal-play trace vs Final_Boss (HP 30, normal 4, special 8, Defend 50% rounded down) under the explicit enemy-action sequence Normal → Telegraph → Special → Normal → Normal → Normal → Telegraph → Special, with the Player attacking every turn except Defending on the turn the Special lands: R1 Player Attack→boss 25, enemy Normal 4 (HP 18); R2 Player Attack→boss 20, enemy Telegraph 0 (HP 18); R3 Player Defend, enemy Special 8 halved to 4 (HP 14); R4 Player Attack→boss 15, enemy Normal 4 (HP 10); R5 Player Attack→boss 10, enemy Normal 4 (HP 6); R6 Player Attack→boss 5, enemy Normal 4 (HP 2); R7 Player Attack→boss 0, boss defeated on the Player turn and takes no enemy turn. Player survives with 2 HP (margin of 2, which meets the ≥2 target, so no further adjustment is required) |
| Player base Attack damage | 5 | HP |
| Player Defend damage reduction | 50% | applies to next incoming enemy attack only |
| Ordinary Enemy Battle_HP | 12 | HP |
| Ordinary Enemy attack damage | 3 | HP |
| Final_Boss Battle_HP | 30 | HP; requires ceil(30/5)=6 Attack actions from the base Ghosty. Final_Boss Battle_HP is left at 30 to keep the boss challenging; the combat math is closed by the starting Battle_HP of 22 (see that row's validated trace) |
| Final_Boss normal attack damage | 4 | HP |
| Final_Boss special attack damage | 8 | HP; telegraphed one enemy turn ahead |
| Final_Boss enemy-action sequence | Normal → Telegraph → Special → Normal → Normal → Normal → Telegraph → Special | the ordered enemy actions by enemy turn; Telegraph turns deal no damage; a defeated enemy takes no turn |
| Final_Boss special first-telegraph turn | 2nd | enemy turn on which the special is first telegraphed (the Special lands on the 3rd enemy turn) |
| Final_Boss special cooldown | 3 | subsequent resolved enemy turns after a special resolves before the Final_Boss may telegraph the special again (consistent with the enemy-action sequence: Special on enemy turn 3, then 3 subsequent enemy turns 4–6, telegraph again on enemy turn 7) |
| Percentage-reduction damage rounding | round down, min 0 | fractional HP from percentage reductions (Defend 50%, fortified 75%) rounds down to whole HP, minimum 0 |
| Storm_Bat lightning move damage | 9 | HP |
| Storm_Bat lightning move cooldown | 2 | battle turns |
| Pumpkin_Guardian fortified defend reduction | 75% | applies to next incoming enemy attack only |
| Potion effect | +10 | Battle_HP, capped at maxBattleHp for the Run; disabled at full health |
| Potion price | 5 | Soul_Coins |
| Potion inventory initial count | 0 | items.potion per Run; reset to 0 at new-run init |
| Shield charge item price | 8 | Soul_Coins |
| Attack upgrade effect | +3 | Attack damage for the rest of the Run |
| Attack upgrade price | 7 | Soul_Coins |
| Attack upgrade purchase limit | 1 | per Run |
| Ordinary victory Soul_Coin reward | 6 | Soul_Coins |
| First Encounter trigger | 15 | seconds of Active_Flight_Time |
| First Enemy type | type A (Storm_Bat Enemy) | which ordinary Enemy type appears at the first Encounter |
| First Shop trigger | 35 | seconds of Active_Flight_Time |
| Second Enemy (type B) trigger | 60 | seconds of Active_Flight_Time; type B is the Pumpkin_Guardian Enemy, strictly between first-Shop and Final_Boss |
| Second Shop trigger | 85 | seconds of Active_Flight_Time; strictly between first-Shop and Final_Boss |
| Final_Boss trigger | 120 | seconds of Active_Flight_Time |
| Target Adventure duration | 3–5 | minutes (balancing target only) |
| Target ordinary battle length | 3–5 | player turns (target only) |
| Candy formula | floor(Active_Flight_Time / 15) | Candy per Run |
| Candy boss-victory bonus | +3 | Candy |
| Witch Hat price | 3 | Candy |
| Pumpkin Cap price | 6 | Candy |
| Bat Bonnet price | 10 | Candy |
| Haunted Crown price | 15 | Candy |
| Resume countdown duration | 3 | seconds |
| Save format version | 1 | integer |

### Logical Geometry and Coordinate Convention

- Ghosty's `x` and `y` are CENTER coordinates consistently. Both the sprite draw rect and the collision rect are derived from the center ± half of the configured logical body size; neither is derived from the PNG's natural pixel dimensions.
- The supplied PNG's natural dimensions are NEVER used as gameplay dimensions. The PNG's aspect ratio is preserved only when drawing the sprite inside the logical body rect.
- The Hitbox is the logical body rect inset by the configured Hitbox inset on each side (≈24 × 31 logical px). Hats and spirit decorations never affect the Hitbox.
- Viewport scaling is separate from the simulation: the Logical_Playfield is fit to the viewport for display only, and scaling never changes physics or collision outcomes (see Requirements 1.10 and 12.9).

## Requirements

### Requirement 1: Flight Physics and Controls

**User Story:** As a Player, I want responsive, frame-rate-independent flight with a simple flap and an optional spirit power, so that I can navigate obstacles fairly and consistently.

#### Acceptance Criteria

1. WHILE the Game is in the Active_Flight_State, THE Game SHALL advance Ghosty's position, velocity, cooldowns, and timers using elapsed simulation time so that two sessions with identical initial state, identical RNG seed, and identical inputs assigned to identical simulation ticks produce equivalent collision outcomes over equal accepted simulation time, regardless of frame rate; equivalence is defined over equal accepted simulation time rather than over arbitrary equal wall-clock intervals, because clamping (see criterion 9) discards differing amounts of real time and is tested separately.
2. WHILE the Game is in the Active_Flight_State, THE Game SHALL apply Gravity to increase Ghosty's downward velocity up to the configured terminal downward velocity.
3. WHILE the Game is in the Active_Flight_State, WHEN the Player performs a Flap_Input, THE Game SHALL set Ghosty's vertical velocity to the configured Normal_Flap velocity rather than adding to the current velocity.
4. WHILE the Game is in the Active_Flight_State, WHEN the Player performs a Flap_Input, THE Game SHALL play `assets/jump.wav` at most once per Flap_Input.
5. IF a Flap_Input key is held down, THEN THE Game SHALL register at most one Normal_Flap per discrete key press and SHALL require a key release before registering another.
6. IF the Player activates a menu action or an on-screen button, THEN THE Game SHALL NOT register that activation as a Flap_Input.
7. WHERE a Spirit providing a Flight_Power is equipped, WHEN the Player presses the dedicated Flight_Power key or clicks the visible Flight_Power button, THE Game SHALL activate the Flight_Power only if the Flight_Power cooldown has elapsed in Active_Flight simulation time, and SHALL otherwise ignore the activation request.
8. IF the Flight_Power cooldown of an equipped Spirit has not elapsed, THEN THE Game SHALL ignore the activation request and SHALL leave Ghosty's velocity and the Flight_Power cooldown unchanged.
9. WHILE the Game is in the Active_Flight_State, IF the elapsed real time since the previous simulated frame exceeds 100 milliseconds, THEN THE Game SHALL clamp the simulated step to at most 100 milliseconds of simulation time to prevent large catch-up movement.
10. THE Game SHALL use any visual interpolation for rendering only and SHALL compute all collisions from the simulation state so that interpolation never changes collision outcomes.
11. IF `assets/jump.wav` fails to load or play, THEN THE Game SHALL continue the Run without interruption.
12. WHILE the Game is in the Ready_State, THE Game SHALL hold Ghosty stationary at the configured initial center with zero vertical velocity and SHALL NOT apply Gravity.
13. WHEN the first Flap_Input of a Run occurs in the Ready_State, THE Game SHALL start flight by entering the Active_Flight_State and SHALL set Ghosty's vertical velocity to the configured Normal_Flap velocity.

### Requirement 2: Obstacles and Bounded Difficulty

**User Story:** As a Player, I want obstacles that get harder in controlled steps while always staying passable with base flight, so that difficulty feels fair and never impossible.

#### Acceptance Criteria

1. WHILE the Game is in the Active_Flight_State, THE Game SHALL move each Pipe_Pair from right to left at the current configured scroll speed expressed in logical px/s.
2. WHILE the Game is in the Active_Flight_State, THE Game SHALL set the scroll speed to the base scroll speed plus the configured increment for each Active_Flight_Time milestone reached, not exceeding the configured maximum scroll speed.
3. WHILE between two scroll-speed milestones, THE Game SHALL keep the scroll speed constant.
4. WHEN the scroll speed changes, THE Game SHALL preserve the configured horizontal spacing between successive Pipe_Pairs.
5. WHEN a new Pipe_Pair is generated, THE Game SHALL place the Gap so that the full Gap remains at least the configured minimum clearance from both the Ground and the Ceiling.
6. WHEN a new Pipe_Pair is generated, THE Game SHALL limit the change in Gap center from the previous Pipe_Pair to at most the configured maximum gap-center change.
7. THE Game SHALL generate every Pipe_Pair so that it is navigable using only Normal_Flap movement and SHALL NOT require a Spirit, Flight_Power, Shield, or purchased item to pass.
8. WHEN an Enemy symbol or a Shop entrance is displayed during flight, THE Game SHALL position it so that at least one safe route through the current Gap remains unobstructed.
9. WHEN a Pipe_Pair's trailing edge passes the left edge of the Logical_Playfield, THE Game SHALL remove that Pipe_Pair so that off-screen obstacles do not accumulate without bound.
10. WHEN a timed effect or temporary obstacle expires, THE Game SHALL remove it so that expired effects do not accumulate without bound.

### Requirement 3: Collisions and Shields

**User Story:** As a Player, I want collisions to be fair and clearly rule-governed, with a shield that saves me once, so that failure always feels earned.

#### Acceptance Criteria

1. WHILE the Game is in the Active_Flight_State, IF Ghosty's Hitbox overlaps a pipe of a Pipe_Pair AND no Shield charge is available AND that Pipe_Pair is not the Pipe_Pair currently under Shield_Grace, THEN THE Game SHALL immediately stop gameplay and end the Run.
2. WHILE the Game is in the Active_Flight_State, IF Ghosty's Hitbox overlaps a pipe of a Pipe_Pair AND at least one Shield charge is available, THEN THE Game SHALL consume exactly one Shield charge, SHALL start Shield_Grace for that Pipe_Pair, and SHALL play clear shield-break feedback.
3. WHILE Shield_Grace applies to a Pipe_Pair, THE Game SHALL prevent repeated contact with that same Pipe_Pair from ending the Run even when zero Shield charges remain, and SHALL end Shield_Grace for that Pipe_Pair when Ghosty's Hitbox has fully cleared that Pipe_Pair horizontally.
4. WHILE Shield_Grace applies to one Pipe_Pair, THE Game SHALL keep all other Pipe_Pairs, the Ground, and the Ceiling under normal collision rules.
5. WHILE the Game is in the Active_Flight_State, IF Ghosty's Hitbox reaches or crosses the Ground, THEN THE Game SHALL immediately stop gameplay and end the Run even if a Shield charge is available.
6. WHILE the Game is in the Active_Flight_State, IF Ghosty's Hitbox reaches or crosses the Ceiling, THEN THE Game SHALL immediately stop gameplay and end the Run even if a Shield charge is available.
7. THE Game SHALL treat the Shield as the only source of flight collision immunity, and SHALL NOT grant invulnerability from a Normal_Flap, a Flight_Power, or switching Spirits.
8. THE Game SHALL compute Ghosty's collisions from the configured forgiving Hitbox and SHALL NOT enlarge the Hitbox due to Hats, Spirit decorations, transparent sprite margins, particles, animations, or screen shake.
9. THE Game SHALL keep the Hitbox and collision results identical regardless of on-screen display scaling.
10. THE Game SHALL perform collision checks so that a Pipe_Pair cannot be tunneled through within a single simulation step at any scroll speed up to the maximum.
11. WHEN a fatal collision occurs, THE Game SHALL stop all flight movement, scoring, and Encounter triggering before any collision animation plays.
12. WHILE a post-collision animation is playing after gameplay has stopped, THE Game SHALL NOT award points, trigger Encounters, apply damage, or grant rewards.
13. IF a fatal collision and an Encounter trigger would occur in the same simulation step, THEN THE Game SHALL resolve the fatal collision first and SHALL NOT start the Encounter.
14. THE Game SHALL retain existing Shield charges when the equipped Spirit is replaced.

### Requirement 4: Adventure Structure and Encounters

**User Story:** As a Player, I want a guided opening that teaches the loop and a clear path to a final boss, so that I can discover battles and shopping and reach a satisfying conclusion.

#### Acceptance Criteria

1. THE Game SHALL structure Adventure so that a typical successful Run targets 3 to 5 minutes as a balancing goal and not as a decision timer.
2. WHEN a Run begins, THE Game SHALL present the first optional Encounter within the configured first-Encounter Active_Flight_Time and the first Shop within the configured first-Shop Active_Flight_Time.
3. WHEN Active_Flight_Time reaches the configured Final_Boss trigger, THE Game SHALL present the Final_Boss at a safe checkpoint.
4. THE Game SHALL make the opening predictable enough to demonstrate the full loop and SHALL apply controlled randomness only after the opening.
5. WHEN an ordinary Enemy symbol is shown, THE Game SHALL make it approachable and SHALL keep a viable route around it so that engaging the Encounter is optional.
6. BEFORE contact with an Enemy, THE Game SHALL communicate the Enemy's identity, relative danger, and the expected reward or available Spirit.
7. WHEN Ghosty contacts an Enemy symbol, THE Game SHALL start a Battle and SHALL freeze flight.
8. THE Game SHALL allow a Run to conclude with victory only after the Final_Boss is defeated.
9. THE Game SHALL ensure the Final_Boss is defeatable without any particular optional Spirit or purchased item.
10. WHEN a Run begins, THE Game SHALL present the first ordinary Encounter as the configured first Enemy type at the configured first-Encounter Active_Flight_Time.
11. WHEN Active_Flight_Time reaches the configured second-Enemy trigger, THE Game SHALL present an optional Encounter with the ordinary Enemy type that is not the first Enemy type, so that at least one opportunity to encounter each of the two ordinary Enemy types is presented before the Final_Boss.
12. WHEN Active_Flight_Time reaches the configured second-Shop trigger, THE Game SHALL present a second Shop opportunity after the first Battle-and-Shop loop and before the Final_Boss.
13. THE Game SHALL schedule the configured second-Enemy trigger and second-Shop trigger strictly after the first-Shop trigger and strictly before the Final_Boss trigger.
14. THE Game SHALL keep each presented mid-Adventure Encounter and Shop optional with a viable route around it, and SHALL keep at least one safe route through the current Gap unobstructed so that no opportunity blocks the only safe path.
15. WHEN Active_Flight_Time reaches a scheduled Shop trigger, THE Game SHALL spawn an avoidable Shop entrance during flight and SHALL NOT freeze flight on spawn, so that the Shop entrance is optional.
16. WHEN Ghosty contacts a Shop entrance or the Player performs an explicit interaction with a Shop entrance, THE Game SHALL enter the Shop_State and SHALL freeze flight.
17. THE Game SHALL track each Shop entrance through the lifecycle states offered, entered, completed, and skipped, and IF Ghosty passes a Shop entrance without entering it, THEN THE Game SHALL mark that entrance skipped and SHALL NOT retrigger that same entrance.
18. THE Game SHALL track each optional Enemy symbol through the lifecycle states offered, entered, completed or defeated, and skipped, and IF Ghosty passes an Enemy symbol without starting its Encounter, THEN THE Game SHALL mark that symbol skipped and SHALL NOT retrigger that same symbol.

### Requirement 5: Turn-Based Combat

**User Story:** As a Player, I want short, clear turn-based battles with meaningful choices, so that combat is engaging without dragging on.

#### Acceptance Criteria

1. THE Game SHALL keep Battle_HP separate from flight collision protection.
2. THE Game SHALL carry the Player's remaining Battle_HP between Encounters within the same Run and SHALL restore Battle_HP only through defined items or abilities.
3. WHILE the Game is in the Battle_State, THE Game SHALL offer Attack, Defend, and Use Item actions, and SHALL additionally offer a spirit move WHERE the equipped Spirit provides one.
4. WHEN the Player selects a valid action, THE Game SHALL consume exactly one of the Player's turns.
5. IF the Player cancels a selection or selects an invalid action, THEN THE Game SHALL consume neither a turn nor an item.
6. WHEN the Player's action reduces an Enemy's Battle_HP to zero, THE Game SHALL end the Battle in victory and SHALL NOT allow that Enemy to counterattack.
7. WHEN the Player selects Defend, THE Game SHALL reduce the damage of the next incoming enemy attack by the configured Defend reduction and SHALL end that protection after the next enemy attack resolves.
8. THE Game SHALL advance Battle cooldowns by resolved combat turns and SHALL NOT advance them by real-world waiting or by elapsed seconds.
9. THE Game SHALL display the result of each action and SHALL communicate significant enemy intentions before they resolve.
10. THE Game SHALL present ordinary Battles targeting 3 to 5 Player turns as a balancing goal and SHALL NOT impose a real-time move-selection timer.
11. IF the Player's Battle_HP reaches zero, THEN THE Game SHALL end the Run in defeat.
12. THE Game SHALL use the same combat system for the Final_Boss, give the Final_Boss a distinctive appearance, and give the Final_Boss at least one telegraphed special attack the Player can respond to on the following turn.

#### Acceptance Criteria — Boss Combat Rules

13. WHILE the Game is in the Battle_State, THE Game SHALL resolve combat in rounds where the Player acts first and the enemy acts second, and SHALL define a round as one Player turn followed by one enemy turn unless the Battle has already ended on the Player turn.
14. WHEN the Player's action ends a Battle on the Player turn, THE Game SHALL NOT take the enemy turn for that round.
15. WHEN computing damage reduced by a percentage reduction, THE Game SHALL round the resulting damage down to the nearest whole HP with a minimum of zero HP so that outcomes are deterministic.
16. WHILE the Game is in the Battle_State, THE Game SHALL advance a Player ability cooldown by counting subsequent resolved Player turns, and SHALL advance a boss ability cooldown by counting subsequent resolved enemy turns, and SHALL NOT decrement any cooldown on the turn that starts the cooldown nor on an invalid or cancelled action, decrementing instead only after the relevant subsequent turn resolves.
17. WHERE the Storm_Bat lightning move has a 2-turn cooldown, WHEN the Player uses the lightning move, THE Game SHALL block the lightning move for the next two resolved Player turns and SHALL make the lightning move available again on the Player turn after those two turns.
18. WHEN the Final_Boss is active, THE Game SHALL execute enemy actions in the configured Final_Boss enemy-action sequence Normal → Telegraph → Special → Normal → Normal → Normal → Telegraph → Special, SHALL telegraph the special one enemy turn before it lands, SHALL deal no damage on a Telegraph turn, and SHALL require three subsequent resolved enemy turns after a Special resolves before the Final_Boss may telegraph the special again.
19. WHILE the Final_Boss is telegraphing its special on a given enemy turn, THE Game SHALL NOT also deal attack damage on that telegraph turn, and WHEN the Final_Boss is defeated, THE Game SHALL NOT take a further enemy turn.
20. THE Game SHALL own each ability cooldown as per-ability Battle_State data so that creating a BattleState or switching Spirits does not refill or reset a Player ability cooldown, and SHALL ensure the Final_Boss is defeatable by the base Ghosty starting at the configured starting Battle_HP using only the Attack and Defend actions, given the configured Final_Boss Battle_HP, attack damage, enemy-action sequence, special cooldown, and damage rounding, without requiring any Spirit, purchased item, or consumable.

#### Acceptance Criteria — Battle Presentation

21. WHEN the Game enters the Battle_State, THE Game SHALL present a dedicated battle scene that displays Ghosty with the equipped Hat and Spirit appearance, the enemy or Final_Boss, both Battle_HP displays, the enemy intent and any special-attack warning, the Attack, Defend, and Use Item actions plus any applicable Spirit action, and readable feedback for each resolved action.
22. WHEN the Game enters the Battle_State, THE Game SHALL store the frozen flight world separately from the battle scene so that the flight world is unchanged when the Battle ends.
23. THE Game SHALL render the battle characters and scenery with Canvas and local artwork in the soft illustrated Halloween style, and MAY use lightweight HTML controls for keyboard navigation and focus.

#### Acceptance Criteria — Potions in Battle

24. WHEN the Player selects Use Item to use a potion in the Battle_State, IF the Player owns at least one potion AND the Player's Battle_HP is below the Run maximum, THEN THE Game SHALL consume exactly one potion, SHALL heal up to the configured potion effect capped at the Run maximum Battle_HP, SHALL consume exactly one Player turn, and SHALL let the enemy respond normally on the following enemy turn.
25. IF the Player attempts to use a potion in the Battle_State while owning no potion OR while at the Run maximum Battle_HP, THEN THE Game SHALL disable the potion action, SHALL consume neither a potion nor a turn, and SHALL leave Battle_HP unchanged.

### Requirement 6: Possession and Spirits

**User Story:** As a Player, I want to possess defeated enemies to change how I fly and fight, so that my choices shape each run.

#### Acceptance Criteria

1. WHEN the Player wins an ordinary Battle, THE Game SHALL grant the normal rewards and THEN offer Possession of the defeated Enemy's Spirit.
2. WHEN Possession is offered, THE Game SHALL allow the Player either to replace the currently equipped Spirit with the defeated Enemy's Spirit or to decline and keep the current Spirit.
3. THE Game SHALL keep at most one Spirit equipped at a time and SHALL NOT maintain a multi-creature party or a permanent Spirit collection.
4. THE Game SHALL make equipped Spirits last only for the current Run.
5. THE Game SHALL keep the base Ghosty fully playable without any Spirit equipped.
6. THE Game SHALL provide exactly one Flight benefit and one combat benefit per Spirit and SHALL explain both before the Player chooses Possession.
7. THE Game SHALL implement Storm_Bat with Hover as its Flight benefit and a lightning combat move, using the configured values and cooldowns.
8. THE Game SHALL implement Pumpkin_Guardian with a one-time Shield gift on first Possession during the Run and a fortified defensive combat move, using the configured values.
9. WHILE Hover is active, THE Game SHALL still apply normal collision rules so that Ghosty can collide with pipes, the Ground, or the Ceiling during Hover.
10. THE Game SHALL grant Pumpkin_Guardian's Shield gift at most once across an entire Run, SHALL respect the one-charge Shield cap, and SHALL NOT refresh the gift by replacing, re-equipping, or re-acquiring Pumpkin_Guardian.
11. WHEN the Player switches Spirits, THE Game SHALL NOT refill Battle_HP, consumables, Shields, or cooldowns, except for the documented first-time Pumpkin_Guardian Shield gift.
12. WHERE Storm_Bat is equipped, WHEN the Player presses the E key or clicks the dedicated Hover button AND the Hover cooldown has elapsed, THE Game SHALL activate Hover, SHALL set Ghosty's vertical velocity to zero, SHALL suspend Gravity for the configured Hover duration, and SHALL start the configured Hover cooldown from the moment of activation.
13. WHILE Hover is active, THE Game SHALL keep pipes moving, keep Active_Flight_Time accruing, and keep all collision rules active.
14. WHEN the Player performs a Normal_Flap while Hover is active, THE Game SHALL cancel Hover, SHALL set Ghosty's vertical velocity to the configured Normal_Flap velocity, and SHALL NOT refund the Hover cooldown.
15. WHEN the Hover duration expires naturally, THE Game SHALL resume Gravity from a vertical velocity of zero.
16. IF a Flap_Input and a Hover activation occur in the same simulation tick, THEN THE Game SHALL apply the Normal_Flap and SHALL NOT activate Hover on that tick.
17. WHILE the Game is not in the Active_Flight_State, THE Game SHALL freeze the Hover duration and the Hover cooldown, and WHEN the Player switches Spirits, THE Game SHALL NOT refill the Hover cooldown.

### Requirement 7: Run Economy and Shops

**User Story:** As a Player, I want clear in-run currency and a small shop, so that my battle rewards let me prepare for what comes next.

#### Acceptance Criteria

1. THE Game SHALL keep Pipe_Score, Soul_Coins, Battle_HP, and Candy as four distinct quantities.
2. WHEN the Player wins an ordinary Battle, THE Game SHALL award the configured Soul_Coin reward.
3. THE Game SHALL stock each Shop with a potion that restores Battle_HP, one Shield charge, and a run-limited attack upgrade, using the configured prices, effects, and quantities.
4. WHEN Active_Flight_Time reaches a scheduled Shop threshold, THE Game SHALL spawn an avoidable Shop entrance at a safe point during flight without freezing flight, and THE Game SHALL freeze flight and enter the Shop_State only when Ghosty contacts that Shop entrance or the Player explicitly interacts with it.
5. WHILE the Game is in the Shop_State, THE Game SHALL display each item's effect, price, available quantity, and affordability.
6. IF the Player attempts a purchase they cannot afford, THEN THE Game SHALL reject the purchase and SHALL leave Soul_Coins and inventory unchanged.
7. THE Game SHALL prevent repeated or duplicate input from causing more than one purchase per confirmed action and SHALL never allow a negative Soul_Coins balance.
8. THE Game SHALL enforce the configured attack-upgrade purchase limit per Run.
9. THE Game SHALL ensure at least one useful Shop item in the first Shop is affordable using the Soul_Coins earned from the preceding ordinary Battle.
10. WHEN a new Run begins at the transition from Ready_State to first flight, THE Game SHALL initialize the complete run state by setting Pipe_Score to zero, Soul_Coins to zero, Battle_HP to the configured starting Battle_HP, Active_Flight_Time to zero, the equipped Spirit to none so that the base Ghosty is active, Shield charges to zero, the consumable inventory to `items { potion: 0 }`, the attack upgrade to not purchased so that the base Attack damage applies, all Flight_Power and Hover cooldowns and all Battle cooldowns to ready, the enemies-defeated count to zero, the Pumpkin_Guardian Shield-gift-used flag to false, and the encounter, Shop, and Final_Boss progression pointers to their starting positions.
11. WHEN a new Run begins, THE Game SHALL leave the equipped Hat and the persistent Candy balance unchanged, because the equipped Hat and Candy are persistent Save_Data rather than per-Run state.
12. WHEN the Player confirms a potion purchase in the Shop_State AND the Player can afford the configured potion price, THE Game SHALL increment `items.potion` by exactly one, SHALL deduct the configured potion price from Soul_Coins, and SHALL count duplicate or repeated input as a single purchase per confirmed action.
13. WHEN the Player uses a potion inside the Shop_State, IF the Player owns at least one potion AND the Player's Battle_HP is below the Run maximum, THEN THE Game SHALL consume exactly one potion, SHALL heal up to the configured potion effect capped at the Run maximum Battle_HP, SHALL NOT consume a combat turn, SHALL keep flight frozen, and SHALL accrue no Candy time.
14. IF the Player attempts to use a potion inside the Shop_State while owning no potion OR while at the Run maximum Battle_HP, THEN THE Game SHALL disable the potion action and SHALL consume neither a potion nor any resource.
15. THE Game SHALL NOT allow a potion to be used during the Active_Flight_State.
16. THE Game SHALL count each confirmed potion use as exactly one potion consumed and SHALL treat duplicate or repeated input for a single confirmed use as one use.

### Requirement 8: Candy and Cosmetic Hats

**User Story:** As a Player, I want to earn permanent Candy and spend it on Halloween hats, so that I have a reason to keep playing across runs.

#### Acceptance Criteria

1. THE Game SHALL compute Candy earned for a Run as floor(Active_Flight_Time in seconds divided by 15).
2. WHEN the Player defeats the Final_Boss in a Run, THE Game SHALL add the configured boss-victory Candy bonus to that Run's Candy.
3. THE Game SHALL count only Active_Flight_Time toward Candy and SHALL exclude time spent in battles, rewards, shops, menus, pause, countdowns, hidden-tab periods, and results.
4. WHEN a started Run ends via flight death, combat defeat, Final_Boss victory, or explicit End Run, THE Game SHALL finalize that Run's Candy award.
5. THE Game SHALL treat a Run as started (started = true) only once flight has begun from the first Flap_Input (see Requirements 1.13 and 9.9), SHALL keep started = false before flight begins, and IF a Run was never started, THEN THE Game SHALL finalize no rewards and SHALL award no Candy.
6. THE Game SHALL finalize each Run's Candy award exactly once so that repeated result clicks, reopening results, restarting, or reloading after a saved result do not duplicate the award.
7. WHEN a Run's results are shown, THE Game SHALL display the Candy calculation, the Candy earned, and the updated total Candy balance.
8. THE Game SHALL offer four Hats — Witch Hat, Pumpkin Cap, Bat Bonnet, and Haunted Crown — at the configured Candy prices, in addition to a free default no-hat appearance.
9. THE Game SHALL treat Hats as cosmetic only and SHALL NOT let a Hat change stats, powers, physics, Hitbox, scores, or rewards.
10. IF the Player attempts to buy a Hat they already own, THEN THE Game SHALL reject the purchase and SHALL leave Candy unchanged.
11. THE Game SHALL allow equipping and unequipping owned Hats at no Candy cost and SHALL NOT allow equipping an unowned Hat.
12. IF the Player attempts to buy a Hat without sufficient Candy, THEN THE Game SHALL reject the purchase and SHALL leave Candy and ownership unchanged.
13. THE Game SHALL keep Ghosty recognizable and each Hat readable whether or not a Spirit appearance is active.

### Requirement 9: States, Pause, and Safe Resumption

**User Story:** As a Player, I want consistent game states with safe pausing and resumption, so that I never lose progress or die unfairly when returning to flight.

#### Acceptance Criteria

1. THE Game SHALL implement the states Main_Menu_State, Ready_State, Active_Flight_State, Battle_State, Reward_State, Shop_State, Pause_State, Resume_Countdown_State, Results_State, and Wardrobe.
2. THE Game SHALL maintain three separate clocks and advance each only in its own state: (a) flight simulation time — Ghosty's flight physics, obstacle movement and spawning, flight collision checks, Active_Flight_Time accrual, Hover duration and cooldown, and all Flight_Power and flight cooldowns — advances ONLY in the Active_Flight_State; (b) countdown time — the Resume countdown — advances in the Resume_Countdown_State while flight stays frozen; and (c) combat time — Battle cooldowns and turns — advances by resolved combat turns in the Battle_State. WHILE the Game is not in the Active_Flight_State, THE Game SHALL freeze all flight simulation time in group (a), BUT SHALL still allow the Resume countdown to progress in the Resume_Countdown_State and combat cooldowns and turns to advance by resolved turns in the Battle_State.
3. WHILE the browser tab is hidden, THE Game SHALL advance none of the three clocks.
4. THE Game SHALL preserve all Run data across Battles, Shops, Reward selection, and pauses.
5. WHEN the Game is about to return to the Active_Flight_State, THE Game SHALL show the configured visible Resume countdown before flight resumes.
6. THE Game SHALL ensure that the input which closes a screen, buys an item, selects Possession, or confirms a result does not also trigger an action in the next state.
7. WHEN the browser tab loses visibility or focus during the Active_Flight_State, THE Game SHALL automatically enter the Pause_State and SHALL require deliberate resumption with a countdown before flight continues.
8. WHILE the Game is in the Pause_State, THE Game SHALL provide an End Run action that finalizes the current Run.
9. THE Game SHALL distinguish End Run from cancelling an unstarted Run so that cancelling a Run that never started finalizes no rewards, and SHALL set the started flag to true only when flight begins from the first Flap_Input (see Requirements 1.13 and 8.5) so that only a started Run finalizes rewards.

#### Acceptance Criteria — Ordinary Pause Resumption

10. WHEN the Game enters the Pause_State from the Active_Flight_State as an ordinary pause, THE Game SHALL preserve Ghosty's exact position and velocity, the exact obstacle set, the Hover remainder, all cooldowns, the Shield_Grace state, Pipe_Score, the spawn scheduler state, and the RNG state.
11. WHEN the Game resumes from an ordinary pause, THE Game SHALL resume flight after the configured Resume countdown from the exact preserved state, SHALL NOT recenter Ghosty, and SHALL NOT reset Ghosty's velocity.
12. WHEN resuming from an ordinary pause, THE Game SHALL prevent the confirmation input that dismisses the pause from registering as a Flap_Input or any other flight action.
13. IF the browser tab loses visibility or focus during the Resume_Countdown_State, THEN THE Game SHALL suspend resumption and SHALL require a deliberate resumption input before counting down again.

#### Acceptance Criteria — Battle, Reward, and Shop Exit Resumption

14. WHEN the Game returns to the Active_Flight_State after leaving the Battle_State, Reward_State, or Shop_State, THE Game SHALL prepare a safe flight checkpoint, SHALL set Ghosty's vertical velocity to zero, SHALL preserve Run progress, the consumable inventory, Shield charges, the Hover remainder, and all cooldowns, SHALL resume only after the Resume countdown, and SHALL grant no free invulnerability and no resource refill.
15. WHEN preparing a safe flight checkpoint, THE Game SHALL select the checkpoint by this algorithm: if Ghosty's Hitbox is within a Pipe_Pair's horizontal span, THE Game SHALL place Ghosty vertically centered in that Pipe_Pair's Gap at Ghosty's current horizontal position; otherwise THE Game SHALL place Ghosty vertically centered in the Gap of the nearest upcoming Pipe_Pair at a horizontal position that leaves full clearance before that Pipe_Pair; and in both cases THE Game SHALL verify the resulting Hitbox clears every nearby obstacle, the Ground, and the Ceiling before resuming.
16. WHEN repositioning Ghosty at a checkpoint, THE Game SHALL NOT award Pipe_Score for any Pipe_Pair that Ghosty has not actually passed, and THE Game SHALL synchronize Ghosty's previous and current render positions so that no interpolation artifact or false pass is produced after repositioning.

### Requirement 10: Score and Results

**User Story:** As a Player, I want accurate scoring and a clear results screen, so that I understand my performance and what I earned.

#### Acceptance Criteria

1. WHEN Ghosty's Hitbox fully passes the trailing edge of a Pipe_Pair, THE Game SHALL increase Pipe_Score by exactly one.
2. IF Ghosty has already been awarded a point for a given Pipe_Pair, THEN THE Game SHALL NOT award another point for that same Pipe_Pair.
3. WHILE the Game is in the Active_Flight_State, THE Game SHALL display the current Pipe_Score.
4. WHILE the Game is in the Main_Menu_State, THE Game SHALL display the saved high score.
5. WHEN a Run ends, THE Game SHALL show in the Results_State the victory status or cause of defeat, the final Pipe_Score, the Active_Flight_Time, the number of Enemies defeated, the Candy calculation, the Candy earned, and the updated total Candy balance.
6. WHILE the Game is in the Results_State, THE Game SHALL present clear actions to restart, return to the Main_Menu_State, and open the Wardrobe.
7. THE Game SHALL prevent the input that caused death or confirmed a prior action from immediately restarting a Run.

### Requirement 11: Local Saving and Portable Save Files

**User Story:** As a Player, I want my progress saved locally and portable between computers, so that I keep my Candy and hats and can move them safely.

#### Acceptance Criteria

1. THE Game SHALL persist high score, Candy, owned Hats, equipped Hat, and audio and motion preferences in browser-local Save_Data without any backend or account.
2. THE Game SHALL store Save_Data in a versioned format and SHALL validate stored values on load.
3. IF stored Save_Data is missing or corrupt, THEN THE Game SHALL start with safe default values and SHALL NOT crash.
4. WHEN the Player completes a purchase or a Run reward is finalized, THE Game SHALL save the updated Save_Data promptly.
5. IF saving fails, THEN THE Game SHALL keep the Game playable and SHALL communicate the save failure to the Player.
6. WHILE the Game is not in an active Run, THE Game SHALL provide Export Save and Import Save actions.
7. WHEN the Player exports a save, THE Game SHALL download a clearly named JSON file that includes a game identifier, the save format version, the persistent progress, and the preferences, and that excludes any unfinished Run.
8. WHEN the Player imports a save, THE Game SHALL validate the entire file — game identifier, supported version, valid numeric values, known Hat ids, and that the equipped Hat is owned — before changing any progress.
9. IF an imported file is malformed or unsupported, THEN THE Game SHALL reject it with a useful message and SHALL leave current progress unchanged.
10. WHEN a valid import is available, THE Game SHALL preview the incoming progress and SHALL require explicit confirmation before replacing current progress.
11. WHEN the Player confirms an import, THE Game SHALL replace rather than merge current progress and SHALL save the imported progress locally immediately.
12. IF the Player reloads during an unfinished Run, THEN THE Game SHALL NOT restore the unfinished Run and SHALL NOT create a completed-Run reward.
13. WHEN a Run is finalized, IF the final Pipe_Score exceeds the high score saved in Save_Data, THEN THE Game SHALL update the high score in Save_Data to the final Pipe_Score and SHALL persist it using the same prompt-save behavior defined for other Save_Data, and SHALL otherwise leave the saved high score unchanged.
14. THE Game SHALL update and persist the high score from a finalized Run exactly once so that repeated result views, reopening the Results_State, or reloading after a saved result do not re-apply the high-score update.

### Requirement 12: Presentation, Audio, and Usability

**User Story:** As a Player, I want clear feedback, readable Halloween visuals, and accessible controls, so that the game is understandable and comfortable to play on desktop.

#### Acceptance Criteria

1. THE Game SHALL reuse the supplied Ghosty sprite and sound assets where appropriate and SHALL produce simple original local art for missing Enemy, Final_Boss, Hat, and Spirit artwork in readable Halloween art matching the supplied soft illustrated style, without requiring a pixel-art grid.
2. THE Game SHALL provide clear feedback for flapping, scoring, Shield breaking, Battle actions and damage, rewards and purchases, Possession, fatal collision, and Final_Boss victory.
3. THE Game SHALL render visual effects such as particles, trails, and screen shake so that they do not obscure hazards and do not affect gameplay coordinates or collisions.
4. IF a sound is missing or blocked by the browser, THEN THE Game SHALL continue play without interruption.
5. THE Game SHALL respect browser audio-activation requirements before playing sound.
6. THE Game SHALL provide clear desktop control instructions, keyboard-operable menus with visible focus, and readable health, currency, prices, effects, and cooldowns.
7. THE Game SHALL provide audio controls and SHALL convey important information through text or icons in addition to color.
8. WHERE screen shake or substantial animation is used, THE Game SHALL provide a reduced-motion option that limits such motion.
9. WHEN the browser viewport is resized, THE Game SHALL fit the wide landscape Logical_Playfield to the viewport and SHALL NOT change physics or collision fairness.
10. THE Game SHALL draw the supplied Ghosty sprite with its aspect ratio preserved inside the logical body rect and SHALL NOT use the sprite's natural pixel dimensions as gameplay dimensions.
11. THE Game SHALL present the dedicated battle scene (see Requirement 5, criteria 21–23) in the soft illustrated Halloween style, with readable action feedback, enemy intent, special-attack warnings, and both Battle_HP displays.

## Milestones

Each milestone ends in a playable checkpoint. Requirements are grouped by the capability they primarily exercise.

### Milestone 1: Playable Flight Core
Playable flight, collisions, Shields, scoring, restart, and pause.
- Requirement 1 (Flight Physics and Controls)
- Requirement 2 (Obstacles and Bounded Difficulty)
- Requirement 3 (Collisions and Shields)
- Requirement 10, criteria 1–4, 7 (Score, current and high score, restart safety)
- Requirement 9, criteria 1–7 and 10–13 (core state machine, three-clock freeze, resume countdown, no input leakage, ordinary-pause exact resumption) as applicable to flight and pause
- Requirement 1, criteria 12–13 (Ready_State stationary, first Flap_Input starts flight)
Checkpoint: Ghosty flies, scores, dies fairly, a Shield saves one hit, and the Player can pause and resume from the exact frozen state.

### Milestone 2: One Complete Encounter Loop
One full Encounter → Battle → Reward → Shop → return-to-flight loop.
- Requirement 4, criteria 5–7 and 15–18 (approachable Enemy, pre-contact info, Battle start and flight freeze, optional Shop/Enemy entrance lifecycle)
- Requirement 5 (Turn-Based Combat) for one ordinary Enemy, including the Battle Presentation criteria 21–23 and the Potions-in-Battle criteria 24–25
- Requirement 7, criteria 1–16 (Soul_Coins reward, Shop contents and purchase rules, optional Shop entrance, potion purchase and in-shop use)
- Requirement 9, criteria 2–7 and 14–16 (three-clock freeze and checkpoint resumption around Battle and Shop)
Checkpoint: The Player engages one Enemy, fights in the dedicated battle scene, earns Soul_Coins, shops, and safely resumes flight from a checkpoint.

### Milestone 3: Spirits and Possession
Both Spirits and their flight and combat benefits.
- Requirement 6 (Possession and Spirits), including the Storm_Bat Hover criteria 12–17
- Requirement 1, criteria 7–8 (Flight_Power activation and cooldown)
- Requirement 3, criterion 14 and Requirement 6, criteria 9–11 and 17 (Shield retention and no switch-refill or Hover-refill exploit)
Checkpoint: The Player can possess either Spirit and feel distinct flight and combat effects, including Hover, with correct limits.

### Milestone 4: Adventure and Final Boss
Adventure progression, Final_Boss, and victory results.
- Requirement 4 (full Adventure structure and timing)
- Requirement 5, criteria 12–20 (Final_Boss combat, telegraphed special, enemy-action sequence, precise cooldowns, win guarantee)
- Requirement 10, criteria 5–6 (full Results content and actions)
Checkpoint: A full Adventure runs from opening through Final_Boss to a victory or defeat Result.

### Milestone 5: Meta-Progression and Saves
Candy, Wardrobe, Hats, local saving, and save export/import.
- Requirement 8 (Candy and Cosmetic Hats), including the started-flag semantics in criterion 5
- Requirement 11 (Local Saving and Portable Save Files)
- Requirement 9, criteria 7–9 (auto-pause, End Run, unstarted-Run and started-flag handling) as they affect reward finalization
Checkpoint: Players earn Candy, buy and wear Hats, and move progress safely between browsers.

### Milestone 6: Presentation and Final Verification
Presentation, balancing, and final verification.
- Requirement 12 (Presentation, Audio, and Usability)
- Balancing of all configurable defaults against the target Adventure and battle lengths
- End-to-end verification of frame-rate independence, scoring, collisions, economy, Candy, and save round trips
Checkpoint: The complete experience is readable, accessible, balanced, and verified.
