# Tech Stack

## Stack

Deliberately minimal vanilla web stack: **no framework, no build step, no backend, no network**.

- **Language:** plain modular JavaScript (ES modules loaded directly by the browser).
- **Entry:** a single `index.html` that loads ES modules from `/src/`.
- **Rendering:** one HTML5 Canvas.
- **Persistence:** browser `localStorage`, with portable JSON save export/import.
- **Target:** modern desktop web browser; runs by opening `index.html`, or behind a trivial static server if the browser restricts `file://` module loading.

## Testing

- **Property-based testing with `fast-check`** — do not hand-roll generators.
- A lightweight no-browser test runner exercises pure logic (`systems/*`, `save.js`, FSM tick) with no DOM.
- Property-test tag convention: `Feature: flappy-kiro, Property {n}: {property text}`, minimum 100 iterations per property.
- Tests run once (no watch mode).

## Common Commands

> This repo currently holds specs and assets only; source and `package.json` are created during implementation (Milestone 1, task 1.2). Use the npm scripts once they exist.

```bash
# Run all tests once (no watch mode)
npm test

# Run the game: open index.html in a desktop browser, or serve statically:
npx http-server .      # or: python -m http.server
```

On Windows PowerShell, chain commands with `;` rather than `&&`.

## Core Technical Rules

- **Fixed-timestep simulation decoupled from rendering.** `FIXED_DT = 1/120 s`; clamp any frame longer than `MAX_FRAME_TIME = 0.100 s`. All physics and collisions are frame-rate independent.
- **Interpolation is render-only.** Collisions always read committed simulation state, never the interpolated value.
- **Single central config.** `src/config.js` exports a frozen `CONFIG` holding every tuning value from the spec's Configurable Initial Defaults table. No tuning constant is defined anywhere else.
- **Pure logic vs. IO separation.** `systems/*`, `save.js`, and parts of `state.js` are pure (state + config + inputs → new state, no DOM) and are where tests live. Only `render.js`, `input.js`, `audio.js`, and `ui/*` touch the DOM; keep them thin.
- **Determinism.** Use the seeded RNG in `src/rng.js` for all spawner randomness and tests.
- **Graceful degradation.** Missing/blocked audio and missing art must never interrupt a run; render labeled placeholder shapes for absent sprites.
