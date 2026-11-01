# Gameplay Invariants

Rules that every future change must preserve. These are the game's correctness and fairness guarantees — treat them as non-negotiable. For exact behavior, defer to `.kiro/specs/flappy-kiro/requirements.md` and `design.md`; for numbers, defer to the central `CONFIG` in `src/config.js`. Do not copy tuning constants into this document.

## Three separate clocks (no universal freeze)

- Flight simulation time (physics, obstacle movement/spawn, flight collisions, `activeFlightTime`, Hover duration/cooldown, flight cooldowns) advances **only** in `Active_Flight_State`.
- The resume countdown advances **only** in `Resume_Countdown_State`.
- Combat cooldowns and turns advance **only** in `Battle_State`, and by **resolved turns**, never by seconds.
- No clock advances while the browser tab is hidden. Never reintroduce a universal "everything freezes outside flight" rule.

## Pause and resumption

- **Ordinary pause preserves the EXACT frozen flight state** — Ghosty's exact position and velocity, the obstacle set, Hover remainder, all cooldowns, Shield_Grace, Pipe_Score, the spawn scheduler state, and the RNG state. Resume after the countdown with no recenter and no velocity reset.
- **Battle/Reward/Shop exits use a safe checkpoint** (the only path that repositions Ghosty): center Ghosty in a valid Gap with `vy = 0`, verify the hitbox clears nearby obstacles, Ground, and Ceiling, award no Pipe_Score for unpassed pairs, and sync `prevX`/`prevY` so no interpolation artifact or false pass occurs.
- No input leaks across a transition: a confirming/dismissing input must not also flap, act, or restart in the destination state.

## Collisions and shields

- A Shield absorbs exactly one pipe collision, grants Shield_Grace for **that specific Pipe_Pair** until the hitbox fully clears it horizontally, and is capped at one charge.
- All other pipe pairs stay fatal during grace. Ground and Ceiling are **always fatal**, even with a shield.
- The Shield is the only source of flight collision immunity. A Normal_Flap, Flight_Power, Hover, or switching spirits never grants immunity.
- **Hover grants no collision immunity** — pipes keep moving and all collision rules stay active throughout.
- The hitbox is the forgiving inset rect derived from Ghosty's logical body size. Hats, spirit decorations, sprite margins, particles, animation, and display scaling never change it.
- On a fatal collision, stop movement, scoring, and encounter triggering before any animation; a collision wins over a same-step encounter.

## Possession

- At most one spirit equipped at a time (no party/collection); it lasts only the current Run; base Ghosty is fully playable with no spirit.
- **Switching spirits never refills resources** — not Battle_HP, consumables, shields, or cooldowns (including `hoverCooldown`). Existing shield charges are retained.
- The one-time Pumpkin_Guardian shield gift is granted at most once per Run (latched) and never exceeds the shield cap.

## Separate currencies and pools

Keep these four strictly independent — never convert or cross-contaminate them:

- **Soul_Coins** — in-run spendable currency; resets each Run; never negative.
- **Candy** — permanent cosmetic currency; persists across Runs.
- **Battle_HP** — combat survival pool, separate from flight collision protection; carries between encounters within a Run.
- **Pipe_Score** — pipes fully passed this Run; exactly one point per pair, only after a full pass, never double-awarded.

## Cosmetics

- **Hats are purely cosmetic** — bought with Candy, worn by Ghosty, with no gameplay effect and no effect on the hitbox.
