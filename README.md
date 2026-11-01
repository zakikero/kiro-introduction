# Kiro’s Haunted Flight

A Halloween flying adventure that combines Flappy-style obstacle navigation with turn-based battles, enemy possession, shops, and collectible ghost hats.

You play as **Ghosty**, a friendly ghost trying to survive a haunted flight and defeat the final boss. Each run offers temporary powers and upgrades; Candy earned at the end carries over toward permanent cosmetic unlocks.

Built with Kiro through a requirements → design → tasks workflow. The game runs locally in a desktop browser with plain JavaScript and HTML5 Canvas. No backend, account, AWS deployment, or runtime AI API is needed.

<img src="assets/ghosty_base.png" alt="Ghosty character artwork: a floating white ghost with black oval eyes" width="160">

*Prepared character artwork. See [current implementation status](#current-implementation-status) for what is connected in the game.*

## Run locally

You need a modern desktop browser and a static HTTP server. The commands below use Python 3. Node.js and npm are needed to install and run the automated tests, but the game itself has no build step.

From the repository root:

```sh
npm install
npm test
python -m http.server 8177 --bind 127.0.0.1
```

Open **[http://127.0.0.1:8177/](http://127.0.0.1:8177/)**. Keep the server terminal open; **Ctrl+C** stops it.

On Windows PowerShell, use `npm.cmd install` and `npm.cmd test` if execution policy blocks `npm.ps1`. On macOS/Linux, your Python command may be `python3`.

Serve the project over HTTP rather than opening `index.html` directly: browsers can block ES modules loaded through `file://`. The only npm script currently defined is `test`; there is no `npm start`, `npm run dev`, or build command.

## How the adventure works

1. **Fly through the gaps.** Press Space or click the playfield to rise; gravity pulls Ghosty down between flaps. Each passed pipe pair adds to the run’s Pipe Score.
2. **Choose encounters.** Fly into an enemy symbol to enter a short turn-based battle, or avoid it and continue flying. Ordinary victories award Soul Coins and offer the defeated enemy’s spirit.
3. **Possess a spirit.** Accept the offer to gain that spirit’s flight benefit and combat move. Only one spirit can be equipped at a time; accepting another replaces the current one.
4. **Visit shops.** Shop entrances lead to potions, shields, and an attack upgrade bought with the run’s Soul Coins. Purchase logic exists; the player-facing controls are still part of the UI refinement.
5. **Face the boss.** The mandatory final boss arrives after 120 seconds of active flight. Defeat it to win the adventure; running out of Battle HP or suffering a fatal flight collision ends the run.
6. **Earn Candy.** A completed run awards permanent Candy based on flight time, with a bonus for boss victory. The wardrobe uses Candy to unlock hats.

The adventure schedule uses **active flight time**, not time spent in menus or battles:

| Active flight time | Event |
|---|---|
| 15 seconds | Storm Bat encounter offered |
| 35 seconds | First shop offered |
| 60 seconds | Pumpkin Guardian encounter offered |
| 85 seconds | Second shop offered |
| 120 seconds | Mandatory final boss |

Ordinary encounter and shop symbols scroll into the world; reaching their scheduled time does not automatically enter the scene. Battle, shop, reward, and pause screens stop the flight clock. Combat cooldowns advance by resolved turns.

### Survival rules

- **Pipes are fatal without a shield.** Battle HP does not protect against flight collisions.
- A shield absorbs one pipe collision. Its grace applies only to that same pipe pair until Ghosty clears it; other pipes remain dangerous. Only one shield charge can be held.
- **Ground and ceiling are always fatal**, even with a shield.
- Difficulty increases in bounded speed steps. Every gap must remain passable with ordinary flapping, without a purchased item or spirit.
- Returning from a battle or shop uses a safe checkpoint and a three-second countdown. Ordinary pause resumes the exact frozen flight state after its countdown.
- Hats are cosmetic: they never change the hitbox, physics, damage, rewards, or powers.

## Controls

These are the controls currently routed by the application. Number keys also support the numeric keypad.

| Screen | Controls |
|---|---|
| Title | **Space**, **Enter**, or a playfield click starts the run and applies the first flap |
| Flight | **Space** or playfield click flaps; **E** or the Flight Power button activates an available power |
| Pause | **P / Escape** pauses flight; **Enter / Space / click** resumes; **Q** while paused ends the run |
| Battle | **1** Attack, **2** Defend, **3** Use Item, **4** equipped spirit move; Enter/Space/click defaults to Attack |
| Battle outcome | **Enter / Space / click** continues after victory or defeat |
| Possession offer | **1** accepts/replaces the spirit; **2** declines; Enter/Space/click accepts |
| Shop | **Enter / Space / click** leaves; purchase and potion-use controls still need UI wiring |
| Results | **1** Restart, **2** Main Menu, **3** Wardrobe; Enter/Space/click defaults to Restart |
| Wardrobe | **Escape / Enter / Space / click** returns to Main Menu; selection, Buy, and Equip controls are pending |

Mute and Reduced Motion checkboxes are available below the playfield. Losing browser focus pauses active flight.

## Combat, spirits, and shop items

Battles are turn-based: Ghosty acts first, then the enemy responds unless defeated. Ghosty starts a run with **22 Battle HP** and **5 attack damage**. Defend reduces the next incoming attack; potions restore HP rather than providing flight protection. Battle HP persists between battles in the same run.

| Spirit | Flight benefit | Combat benefit |
|---|---|---|
| Storm Bat | Hover for 0.6 seconds, with a five-second active-flight cooldown | Lightning strike with a two-turn cooldown |
| Pumpkin Guardian | One shield gift on its first possession in a run | Fortified Defend reduces the next incoming attack by 75% |

Spirit powers belong to the current run. Switching spirits does not refill HP, consumables, or cooldowns, and repeatedly acquiring Pumpkin Guardian does not repeat its shield gift.

| Shop item | Soul Coin price | Effect |
|---|---:|---|
| Potion | 5 | Restores 10 Battle HP, capped at maximum HP |
| Shield | 8 | Grants one shield charge, respecting the one-charge cap |
| Attack upgrade | 7 | Adds 3 attack damage for the rest of the run; purchasable once per run |

These are the current values in [src/config.js](src/config.js), which is the source of truth for balancing.

## Scores, currencies, and saves

| Value | Earned through | Lifetime |
|---|---|---|
| Pipe Score | Passing pipe pairs | Current run; the best score is saved |
| Soul Coins | Ordinary battle victories, currently 6 per win | Current run |
| Candy | Finalizing a run | Saved between runs; spent on hats |

Candy is awarded once per completed run:

```text
Candy = floor(active flight seconds / 15) + 3 if the boss was defeated
```

A run ending before 15 seconds earns no time-based Candy. Defeat and deliberately ending a started run still award the Candy earned so far.

The wardrobe catalog contains **No Hat** for free, **Witch Hat** for 3 Candy, **Pumpkin Cap** for 6, **Bat Bonnet** for 10, and **Haunted Crown** for 15. Ownership, equipped hat, and Candy persist; buying/equipping through normal visible controls is still being connected.

Progress is stored in browser `localStorage`:

- High score, Candy, owned/equipped hats, and mute/reduced-motion preferences are saved.
- An unfinished run is not saved or resumed.
- Browser profiles, hostnames, and ports have separate storage. Use the same address to keep seeing the same progress.
- Portable JSON export/import helpers exist, but their visible controls are pending. Imports validate a replacement save rather than merging two players’ progress.

The internal save key is `flappy-kiro:save` and the export filename is `flappy-kiro-save.json`. These legacy identifiers are intentional compatibility names; the displayed game title is **Kiro’s Haunted Flight**.

## Current implementation status

The core flight, encounters, combat, possession, boss, economy, and save logic are implemented. **Some player-facing features remain incomplete even where their underlying logic is tested.**

| Area | Current status |
|---|---|
| Core adventure | Implemented, with automated coverage for its systems |
| Wardrobe | Catalog, validation, persistence, and Results access exist; interactive selection/Buy/Equip controls are pending |
| Shop | Economy and purchase helpers exist; normal purchase/potion controls are pending |
| Asset pack | Complete local image/audio bundle is available; full runtime integration is in progress |
| New Ghosty appearances | Matching no-hat and four hat-equipped sprites are prepared; runtime swapping is being integrated |
| Menus and display | Clear action buttons, larger desktop display, fullscreen, and detailed pipes are specified in the refinement prompt |
| Portable saves | Validation and export/import helpers exist; player-facing file controls are pending |

The browser shell currently loads the original ghost sprite and flap/game-over sounds. New asset and appearance modules are being added, but the presence of an asset file or helper function alone does not mean its visible flow is complete.

The next implementation handoff is [the wardrobe and visual polish prompt](docs/KIRO_WARDROBE_AND_VISUAL_POLISH_PROMPT.md). The milestone checklist records implementation work; use actual browser verification to confirm player-facing completion.

## Code guide

The application separates gameplay rules from browser input, drawing, audio, and persistence.

| Files | Responsibility |
|---|---|
| [index.html](index.html), [src/main.js](src/main.js) | Browser entry point and orchestration: initialize the game, route actions, connect encounters, finalize runs, and save progress |
| [src/state.js](src/state.js) | Finite state machine, transitions, current-run data, pause/resume, and the separate clocks |
| [src/config.js](src/config.js) | Frozen configuration for physics, geometry, difficulty, combat, prices, timers, and rewards |
| [src/loop.js](src/loop.js), [src/input.js](src/input.js), [src/rng.js](src/rng.js) | Fixed-step timing, state-scoped input intents, and seeded randomness |
| [src/render.js](src/render.js), [src/audio.js](src/audio.js) | Canvas rendering and guarded browser audio |
| [src/assets.js](src/assets.js), [src/appearance.js](src/appearance.js) | Shared cached image loading and Ghosty appearance/registration selection for the asset-integration work |
| [src/systems/](src/systems) | Gameplay rules: `flight`, `spawner`, `collision`, `scoring`, `checkpoint`, `scheduler`, `combat`, `economy`, `spirits`, and `candy` |
| [src/ui/](src/ui) | Screen presentation and view helpers: `menu`, `hud`, `battle`, `shop`, `results`, `wardrobe`, and `feedback` |
| [src/save.js](src/save.js) | Save defaults, local storage, validation, export, and import |
| [test/](test), [test-support/](test-support) | Unit/property tests and shared generators/assertion helpers |
| [assets/](assets), [img/](img) | Game media and metadata; workshop reference imagery |

### Architecture rules

- Simulation advances at **120 fixed steps per second**. Long frames are clamped to 0.1 seconds; interpolation affects drawing only.
- The world uses a **960 × 640 logical playfield**. Display scaling must not change gameplay coordinates or difficulty.
- Ghosty’s position uses center coordinates. Its logical body is **32 × 39**, with a **24 × 31** collision hitbox independent of PNG size, hats, or spirit decorations.
- Gameplay systems operate on plain state and are tested independently of browser rendering.
- Flight time, resume countdown, and turn-based combat use separate clocks.
- Safe encounter returns and ordinary pause intentionally use different resume behavior.
- Menu actions must not leak into flaps or other actions after a state transition.
- Seeded gameplay randomness must remain deterministic; decorative variation should not consume the gameplay RNG.

For a gameplay change, start with `src/config.js` or the relevant system. For a visible-control change, inspect `src/main.js`, `src/input.js`, the relevant `ui` module, and `index.html` together.

## Tests

```sh
# Entire suite
npm test

# One focused suite
node --test test/flight.test.js
```

Tests use Node’s built-in `node:test` runner, `node:assert/strict`, and `fast-check`. Property tests run at least 100 generated cases and use the feature tag `flappy-kiro`.

Coverage includes physics, obstacle generation, collision/shield behavior, safe checkpoints, pause, combat and the boss action sequence, spirit cooldowns, economy, Candy finalization, save validation/round trips, and presentation helpers. These are headless tests; passing them does not replace mouse/keyboard, audio, resize, or visual checks in a browser.

## Assets and Kiro documents

The local media bundle contains **18 PNGs, 11 WAVs, and one MP3**, including Ghosty’s five normal appearances, two spirit forms, enemies, boss, standalone hats, shop, backgrounds, and sound effects.

- [Asset preview](assets/preview.html) — view it locally at [http://127.0.0.1:8177/assets/preview.html](http://127.0.0.1:8177/assets/preview.html).
- [Asset integration notes](assets/README.md) — whole-sprite versus overlay rules and audio lifecycle.
- [Asset manifest](assets/manifest.json) — filename/id mappings, source dimensions, approximate body/hat anchors, and checksums.
- [Generation prompts](assets/generation_prompts.json) and [earlier pack prompts](assets/source_generation_prompts.json) — artwork provenance.
- [Requirements](.kiro/specs/flappy-kiro/requirements.md) — what the game should do.
- [Design](.kiro/specs/flappy-kiro/design.md) — architecture, contracts, and test properties.
- [Tasks](.kiro/specs/flappy-kiro/tasks.md) — six milestones: flight core, encounter loop, possession, final boss, progression/saves, and presentation.
- [Steering](.kiro/steering) — product scope, stack, structure, gameplay invariants, and visual/audio direction.
- [Wardrobe and visual polish prompt](docs/KIRO_WARDROBE_AND_VISUAL_POLISH_PROMPT.md) — detailed implementation requirements for the next refinement.

Adventure mode and desktop keyboard/mouse play are the current scope. Endless mode, mobile-first controls, cloud accounts/sync, multiplayer, and runtime AI calls are outside the first release.

## Troubleshooting

- **Blank page or module errors:** run the HTTP server from the repository root and check the browser console; avoid `file://`.
- **No sound:** interact with the game first to unlock browser audio, then check the Mute setting. Blocked or missing audio should not interrupt gameplay.
- **A menu choice or new asset does not respond/appear:** check the implementation-status section; prepared art and tested helpers still need their UI/event connections.
- **Progress appears missing:** confirm the same browser profile, hostname, and port. `localhost` and `127.0.0.1` are different origins.
- **Port 8177 is busy:** use another port, remembering that it will have separate browser-local progress.

## License

See [LICENCE.md](LICENCE.md) for the repository’s **MIT No Attribution (MIT-0)** license.
