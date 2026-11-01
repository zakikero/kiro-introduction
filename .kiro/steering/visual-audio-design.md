# Visual and Audio Design

Guidance for keeping the game coherent, readable, and accessible. For specific requirements, defer to `.kiro/specs/flappy-kiro/requirements.md` and `design.md`.

## Art style

- Match Ghosty's **soft illustrated** appearance and the Halloween palette (purple-and-orange moonlit sky, pumpkins, bats, spirits, moonlight). This is not pixel art.
- All produced artwork follows that same soft illustrated style. Missing art renders as **labeled placeholder shapes** in the same style and must never block proving the core loop.
- Preserve the Ghosty PNG's aspect ratio when drawing inside the logical body rect; never use its natural pixel dimensions as gameplay dimensions.

## Spirits and hats

- Give each spirit (Storm_Bat, Pumpkin_Guardian) a **recognizable appearance in both flight and battle**, so possession reads clearly in either context.
- **Hats stay visible across every spirit appearance** — cosmetics must not be hidden or clipped by a possessed look. Hats are cosmetic only and never affect the hitbox.

## Readability and feedback

Make game state understandable at a glance:

- Shield breaks have clear shield-break feedback.
- Hover readiness (available vs. on cooldown) is visible.
- Enemy intentions and the boss special-attack telegraph are communicated before they resolve.
- Pre-contact enemy info (identity, relative danger, expected reward/available spirit) is shown.
- Rewards are legible.
- **Obstacles remain readable beneath any effects** — particles, trails, or shake must never obscure pipes or the safe route.

## Accessibility

- Respect the saved **reduced-motion** and **audio** preferences; honor them wherever motion or sound is produced.
- Audio degrades gracefully: missing or blocked sound never interrupts a run (see `tech.md`).
- Viewport scaling is display-only (letterboxed fit of the logical playfield) and never changes physics, collisions, or readability of the hitbox-relevant geometry.
