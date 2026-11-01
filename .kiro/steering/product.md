# Product

## Kiro’s Haunted Flight

A desktop-first, Halloween-themed flying RPG that runs entirely in a modern desktop web browser. No backend, no accounts, no network dependency.

The player controls **Ghosty**, a small friendly ghost, flying through a side-scrolling haunted world of pipes. The core loop:

- Fly through obstacles using a simple flap (frame-rate-independent physics).
- Choose optional enemy encounters and fight short turn-based battles.
- Earn rewards, possess defeated enemy spirits (changing both flight and combat abilities), and visit shops.
- Progress toward a final boss for a victory or defeat result.

Across runs, players earn **Candy** (a permanent cosmetic currency) and spend it on Halloween hats in a Wardrobe.

## Experience Goals

- Playful and atmospheric, not frightening: pumpkins, bats, spirits, moonlight.
- Soft illustrated Halloween art style (not pixel art).
- Fair and rule-governed: failure always feels earned; the final boss is beatable with base abilities only.
- A typical run targets 3–5 minutes.

## First-Release Scope

In scope: single Adventure mode, keyboard-and-mouse controls, two ordinary enemy types + two spirits, one final boss, a small shop, four cosmetic hats, local save with portable export/import.

Explicitly excluded (do not add): endless mode, mobile/touch, accounts or cloud sync, multiplayer, payments, runtime AI calls, anti-cheat.

## Provided vs. Missing Assets

- Provided: `assets/ghosty.png`, `assets/jump.wav`, `assets/game_over.wav`.
- Missing (produce as simple original local art; placeholder shapes are acceptable and must not block proving the core loop): enemy, boss, hat, and spirit artwork.
