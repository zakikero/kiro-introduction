# Kiro's Haunted Flight assets

All project images and audio are present in this folder. Preparing the assets has not changed the game runtime. Open [preview.html](preview.html) through a local server to review everything. [manifest.json](manifest.json) supplies exact ids, dimensions, registration estimates, and media checksums.

## Complete swappable Ghosty sprites

| Saved hat id | Whole normal Ghosty sprite |
|---|---|
| `none` | `ghosty_base.png` |
| `witchHat` | `ghosty_witch_hat.png` |
| `pumpkinCap` | `ghosty_pumpkin_cap.png` |
| `batBonnet` | `ghosty_bat_bonnet.png` |
| `hauntedCrown` | `ghosty_haunted_crown.png` |

The no-hat base and four equipped sprites share a soft illustrated Halloween style. These are whole ghosts, not overlays. Swap the corresponding whole sprite when a hat is equipped. Do not draw a second body or second hat on them. `ghosty_base.png` is the preferred new no-hat default; `ghosty.png` remains a legacy fallback.

New `body_reference_rect` entries are central body registration estimates, not exact masks or collision rectangles. Arrays use [x,y,width,height] in source pixels. Uniform-scale the reference to the logical32x39 body, drawing the whole image around it; do not contain-fit the entire hat-bearing PNG into32x39 or tall hats will shrink Ghosty. Check optical body size/center in the browser and refine anchors as needed. Collision remains24x31.

## Spirits and standalone hats

`spirit_storm_bat.png` and `spirit_pumpkin_guardian.png` include the WHOLE possessed ghost. Replace the normal sprite with the spirit image, then add exactly one selected standalone hat: `hat_witch.png`, `hat_pumpkin.png`, `hat_bat.png`, or `hat_crown.png`. With `none` draw no hat.

Use the existing spirit `body_rect` and `hat_anchor` plus each hat's `attachment_point` from the manifest. Standalone hats are approximately1.15 times Ghosty's body width. Saved hats and temporary possession are independent: support all15 combinations. Cosmetics never change gameplay dimensions, stats, timers, or powers.

## Other images

- `enemy_storm_bat.png` and `enemy_pumpkin_guardian.png` (new flying version).
- `boss_final.png`, drawn larger than ordinary enemies.
- `shop.png`, a floating shop entrance.
- `background.png` and optional `background_battle.png`, both1536x1024, the same3:2 ratio as960x640. Scale to fit; do not assume seamless tiling or draw a duplicate moon.

## Audio

- Original supplied cues: `jump.wav`, `game_over.wav`.
- Main new cues: `score.wav`, `shield_break.wav`, `battle_hit.wav`, `purchase.wav`, `possession.wav`, `victory.wav`.
- Extra cues: `battle_hurt.wav`, `heal.wav`, `hover.wav`.
- `music.mp3`: original40-second instrumental,96BPM, D harmonic minor; procedurally composed and synthesized, not an existing song. Suggested HTMLAudio volume0.18.

Register cues AND trigger them once at the relevant actual events. Music needs a separate persistent looping instance, user-gesture unlock, mute and pause/background handling, graceful autoplay rejection, and no track stacking on restart.

## Loading and fallback

Use a shared cached loader with ready/error states. Preserve labeled placeholders on failure; missing art/audio must never stop a run. Preserve aspect ratio and separate drawing from physics.

## Complete Kiro implementation prompt

Read [the complete prompt](../docs/KIRO_WARDROBE_AND_VISUAL_POLISH_PROMPT.md). It covers interactive wardrobe selection/Buy/Equip, clearer clickable menus, all five coherent Ghosty appearances, a larger desktop play area/fullscreen, detailed Halloween pipes, asset/audio integration, and browser verification.

## Provenance

`generation_prompts.json` contains exact prompts for the new built-in image_gen Pumpkin Guardian, shop, and five Ghosty appearances. `source_generation_prompts.json` retains prompts for the earlier Desktop pack. The original supplied ghost/audio remain available.
