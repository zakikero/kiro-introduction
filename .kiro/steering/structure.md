# Project Structure

## Current Layout

```
.
├── .kiro/
│   ├── specs/flappy-kiro/   # requirements.md, design.md, tasks.md (source of truth)
│   └── steering/            # these steering docs
├── assets/                  # provided game audio and sprite
│   ├── ghosty.png
│   ├── jump.wav
│   └── game_over.wav
├── img/                     # screenshots and reference images
├── README.md
└── LICENCE.md
```

The game source does not exist yet. It is built during implementation per `.kiro/specs/flappy-kiro/tasks.md`.

## Target Source Layout (created during implementation)

```
index.html                   # single entry; loads ES modules from /src/
src/
├── config.js                # frozen CONFIG — single source of tuning truth
├── rng.js                   # seeded deterministic RNG
├── loop.js                  # fixed-timestep accumulator + rAF driver
├── state.js                 # finite state machine (FSM): tick, transition, RunState
├── input.js                 # keyboard + mouse → state-scoped intents
├── render.js                # Canvas layers; interpolation-only
├── audio.js                 # sfx with graceful degradation
├── save.js                  # localStorage + export/import
├── systems/                 # pure logic (no DOM) — primary test surface
│   ├── flight.js            # physics + Hover
│   ├── spawner.js           # obstacles + bounded difficulty
│   ├── collision.js         # swept hitbox + shield grace
│   ├── combat.js            # turn-based engine
│   ├── scheduler.js         # adventure progression + encounter lifecycle
│   ├── economy.js           # shop + currencies
│   ├── spirits.js           # possession
│   ├── candy.js             # wardrobe currency + run finalize
│   └── checkpoint.js        # safe resume positioning
└── ui/                      # DOM-touching views: hud, menu, shop, battle, wardrobe
```

## Organizing Principles

- **FSM-centered.** `state.js` owns all state transitions and the three-clock rule; keep per-state logic from leaking into systems. Flight sim time advances only in `Active_Flight_State`, the resume countdown only in `Resume_Countdown_State`, and combat cooldowns (by resolved turns) only in `Battle_State`. No universal freeze.
- **Pure core, thin shell.** New gameplay logic belongs in `systems/*` as pure functions on plain-object state. Keep `render`/`input`/`audio`/`ui` thin and side-effect-only.
- **Config flows inward.** Every system imports tuning from `config.js`; never hardcode balance constants in a system.
- **Coordinates.** Ghosty's `x`/`y` are CENTER coordinates. Draw rect and hitbox derive from center ± half the configured logical body size — never from the PNG's natural pixel dimensions.
- **Spec is the source of truth.** Requirements, design, and tasks under `.kiro/specs/flappy-kiro/` govern behavior; resolved contradictions in `requirements.md` must not be reintroduced.
