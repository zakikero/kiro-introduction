# Kiro implementation prompt: wardrobe, readable menus, larger play area, and Halloween visuals

Implement this refinement in the existing **Kiro's Haunted Flight** project. The game has working gameplay systems and headless tests, but the visible interface is incomplete. In particular, selecting, buying, and equipping wardrobe items is not sufficiently interactive: some controls are only Canvas text and some actions are reachable only through debug helpers. Fix the actual interactions, not just their appearance. Integrate the supplied assets, improve the pipes, and make the desktop play area substantially larger.

Delivery order: first complete wardrobe interactions, the five Ghosty appearances, clear main/result/pause menus, the larger desktop play area, and pipe visuals. Then finish remaining asset/audio and secondary-control integration. Make each step usable before proceeding, and report any unfinished secondary work explicitly.

## 1. Inspect and extend the existing implementation

Read the current files before making changes:

- `.kiro/steering/*.md` and `.kiro/specs/flappy-kiro/{requirements,design,tasks}.md`.
- `assets/README.md`, `assets/manifest.json`, and the asset files themselves.
- `index.html`, `src/{main,state,input,render,audio,config,save}.js`.
- `src/ui/{menu,wardrobe,results,battle,shop,hud}.js` and the relevant existing tests.

Use the current vanilla JavaScript ES-module and Canvas stack. Extend the current FSM, wardrobe/economy functions, input queue, and save helpers. Some documentation still describes a pre-implementation project; reconcile it with the actual source rather than removing working code or rebuilding the application. Make a short implementation plan and proceed through implementation and verification.

Known gaps to verify and resolve:

- The title menu only draws a title/high score; the main-menu input route largely only starts the game.
- Wardrobe catalog/buy/equip logic exists, but normal selection/buy/equip controls are not wired. The wardrobe route currently exits on Enter, Space, or a generic Canvas click.
- Results actions are visually presented like a single text line rather than obvious buttons.
- Only digits 1-4 are mapped, although the wardrobe has five appearances including No Hat.
- The global keyboard handler intercepts Enter/Space, which can interfere with native HTML button activation.
- The shop advertises purchases and U for potion use without fully connected input.
- Battle draws a generic hat instead of consistently honoring the actual equipped hat.

Recheck these facts in case another task has already fixed part of them. Reuse improvements that are already present.

## 2. Complete the wardrobe as a real player-facing feature

Make Wardrobe accessible from both the main menu and Results through clear buttons, without requiring DevTools. Wardrobe remains outside active gameplay. Its Back action should clearly say where it goes; keeping the current return to Main Menu is acceptable. Opening or leaving it must not restart a run or award Candy again.

Display:

- A prominent saved Candy balance and current equipped appearance.
- Five selectable cards: No Hat, Witch Hat, Pumpkin Cap, Bat Bonnet, Haunted Crown.
- A clear thumbnail, name, configured Candy price, and textual status on each card: Unowned, Owned, or Equipped.
- A large live preview of Ghosty with the selected appearance, clearly distinguishing the previewed item from the currently equipped item.
- Obvious Back, Buy, and Equip actions where applicable.

Interaction contract:

1. Selecting a card only changes the preview. It must not buy, equip, or charge Candy.
2. An affordable unowned item shows an explicit action such as **Buy for 3 Candy**, with the actual price from `CONFIG`.
3. Buying deducts the configured price exactly once, grants ownership, persists the save, updates the balance immediately, and shows success feedback. It does not silently equip the item; the player then uses Equip.
4. An owned unequipped item shows **Equip**. Equipping is free, saves immediately, updates the Equipped label, and changes Ghosty's appearance in the game.
5. The current item shows **Equipped** as a clear non-purchasable state. Already owned items cannot be bought again.
6. No Hat is always owned, free to equip, and visibly removes the hat.
7. Unaffordable items can still be selected for preview; their Buy action is disabled with a readable reason such as **Need 2 more Candy**.
8. Repeated clicks or held keys cannot double-charge, duplicate ownership, or immediately exit the wardrobe. Failed purchases leave the save unchanged and explain the failure.

Reuse `hatCatalog`, `buyHat`, `equipHat`, `unequipHat`, and the successful-change persistence already provided by the main shell. Keep the existing prices and Candy earning formula. Cosmetics grant no gameplay benefits.

## 3. Use the new coherent Ghosty family and swap equipped sprites

These complete transparent sprites contain **the whole ghost**, not just a hat:

| Saved `equippedHat` | Normal Ghosty sprite |
|---|---|
| `none` | `assets/ghosty_base.png` |
| `witchHat` | `assets/ghosty_witch_hat.png` |
| `pumpkinCap` | `assets/ghosty_pumpkin_cap.png` |
| `batBonnet` | `assets/ghosty_bat_bonnet.png` |
| `hauntedCrown` | `assets/ghosty_haunted_crown.png` |

The new `ghosty_base.png` is the intended no-hat default: it matches the soft shading, black oval eyes, and flowing silhouette of the four equipped variants. Retain `ghosty.png` as a legacy fallback, not the preferred new appearance.

Implement one shared appearance resolver so wardrobe previews, main-menu previews, flight, and battle agree. Equipping a hat swaps to its corresponding complete sprite whenever no spirit is active. Do not draw the original ghost underneath a complete sprite or add a second hat on top of a precomposed equipped sprite.

Spirit possession remains independent of saved hats:

- `storm_bat` uses `assets/spirit_storm_bat.png`.
- `pumpkin_guardian` uses `assets/spirit_pumpkin_guardian.png`.
- These files also contain the whole possessed Ghosty. Use them instead of the normal body and add exactly one standalone selected hat using `hat_witch.png`, `hat_pumpkin.png`, `hat_bat.png`, or `hat_crown.png`.
- With `none`, draw no hat. Possession does not overwrite `equippedHat` or unlock hats.
- Support every combination: five hat choices with the normal body and each of the two spirits, fifteen appearances total. Do not display a generic witch hat on every battle sprite.

### Registration and collision geometry

Read `body_rect`, `body_reference_rect`, `hat_anchor`, and `attachment_point` metadata in `assets/manifest.json`. Rectangles use source pixels in `[x, y, width, height]` order. New central body reference rectangles are visual alignment estimates, not masks or collision rectangles; verify and refine them optically in the actual game.

Use a uniform scale aligning the central body reference to the logical Ghosty body and draw the entire sprite around that reference. Do not squeeze or contain-fit an entire hat-bearing image into the 32 x 39 body, because a tall crown or wide brim would shrink Ghosty. Hats and flared hems may extend around the central body as cosmetic artwork. Keep a stable body center and optical body size when changing hats; changing hat height must not make the ghost jump up or down.

Keep the logical body **32 x 39**, collision hitbox **24 x 31**, center coordinates, physics, and collision outcomes unchanged. Never derive gameplay geometry from PNG dimensions, hat extents, or decorative hems. If an equipped sprite fails to load, fall back to the new base plus its standalone hat, then the legacy base/labeled placeholder as needed, while keeping the saved selection.

## 4. Make all menu choices obvious and usable

Prefer real, state-scoped HTML buttons in an overlay attached to the game wrapper, with Canvas retained for the world and artwork. This is a small vanilla DOM layer, not a new framework. Do not leave important actions as decorative text that looks clickable but does nothing.

- Main menu: prominent **Start Adventure**, **Wardrobe**, and **How to Play**. Show high score, Candy, and the equipped Ghosty. Keep existing Mute and Reduced Motion controls clearly labeled.
- Results: separate **Restart**, **Main Menu**, and **Wardrobe** buttons with clear spacing.
- Pause: obvious **Resume** and **End Run** buttons. End Run uses the existing one-time finalization/results path.
- Wardrobe: clearly separate card selection, purchase, equip, and Back controls as described above.
- Battle, possession offers, and shop: use the same visible action style. Wire every displayed action to the real action; show prices, resources, cooldowns, and disabled reasons where relevant. In particular, connect shop purchases and potion use, or correct any advertised shortcut that is not implemented.
- Connect secondary save export/import controls using the existing helpers, placed in a clearly labeled Progress section. Import uses a file picker, validates first, previews what will be replaced, and requires explicit confirmation before replacement. Cancelling or invalid files leave progress unchanged.

Use a sufficiently opaque dark plum panel, readable light text, orange/teal accents, clear button boundaries, generous spacing, and a visually distinct primary action. Give interactive controls a minimum 44 CSS-pixel height and legible text. Make hover, keyboard focus, pressed, selected, owned, and equipped states visibly different, with text or icons in addition to color. Disabled controls need an adjacent explanation.

Support mouse and keyboard equally: Tab/Shift+Tab move through controls, Enter/Space activate the focused action, and Escape closes a secondary screen or returns Back where appropriate. Optional number shortcuts must match visible numbered labels; if five wardrobe shortcuts are displayed, support all five, including Numpad equivalents. Numbers select a wardrobe card only; they do not silently purchase it.

Fix input scoping rather than layering new handlers over the existing unconditional Enter/Space behavior:

- A button activation must never also flap, attack, start, restart, buy twice, or close the wardrobe.
- Do not intercept native keyboard activation on focused buttons, checkboxes, inputs, or dialogs with the global flight handler.
- Only the playfield in the appropriate flight states produces flap input. Overlay clicks do not bubble into it; clicking empty menu space does not activate a default action.
- Focus the appropriate first control on entry, restore focus sensibly on Back, and hide/disable inactive controls. A held/queued input must not leak into the next state.

## 5. Enlarge the desktop playable area

The playable screen currently feels too small. Increase its actual displayed size, not just the surrounding page container.

- Keep the simulation's **960 x 640 logical playfield** and 3:2 aspect ratio.
- Remove the old 960px desktop display cap. Fit the largest 3:2 play area available within the viewport, with a desktop maximum around **1600 CSS pixels wide** and modest outer margins.
- Account for the compact toolbar so the playfield and essential controls fit vertically without page scrolling during play. On smaller windows, scale down proportionally.
- At a normal 1920 x 1080 desktop viewport, the displayed canvas should be substantially wider than 960px when available height allows it. At 1366 x 768, keep the whole playfield and essential controls reachable.
- Add a clearly visible **Fullscreen / Exit Fullscreen** button using a user gesture and the Fullscreen API. Fullscreen includes the game wrapper, HUD, and interactive overlays, not only the Canvas. Handle unsupported/rejected fullscreen requests gracefully and leave Escape usable.
- Keep drawing crisp on high-DPI screens. Separate CSS display size, backing-store pixels, and logical coordinates; map pointer input back through the actual Canvas bounding rectangle correctly after resize or fullscreen changes.
- Keep menu text, buttons, and the wardrobe usable at each size. Menus may scroll within their own panel when necessary, but active-flight controls must not be pushed offscreen.

Resizing or entering fullscreen must not change gravity, scroll speed, gaps, spawn timing, collision geometry, scoring, or the visible logical world. Do not enlarge the logical world to achieve this display-size improvement.

## 6. Give the pipes richer Halloween detail

The pipes currently read as plain rounded brown rectangles. Upgrade them into soft illustrated **haunted wooden pillars** that match the purple/orange/teal asset palette.

Add layered wood shading, restrained vertical grain/cracks, inset bands, small carved moon/rune/pumpkin details, and occasional ivy/moss. Give gap-facing ends clear cap details and strong readable edges. Top and bottom pillars should look like one consistent obstacle family. Keep the safe opening visually obvious over the detailed background.

Procedural Canvas art or cached offscreen textures are appropriate; no external pipe texture asset is required for this pass. Use stable variation based on a pipe's id or a separate visual hash. Do not consume the gameplay RNG or change spawner determinism merely to vary wood grain.

Fairness rules:

- Keep all solid-looking art and cap width within the existing pipe collision rectangles. Do not let caps, vines, spikes, or ornaments protrude into the safe gap or create misleading apparent collisions.
- Clip texture/details to the pillar bounds and avoid glows or shadows that obscure the safe path.
- Keep the geometry, spacing, gap-height rules, speed progression, scoring, and collision behavior from `CONFIG` and the existing systems. This is a visual refinement, not a difficulty rebalance.
- Pipe contact remains fatal unless a shield absorbs it. Preserve one-charge consumption and grace only for that same pipe pair. Ground and ceiling remain fatal even with a shield.
- Respect Reduced Motion; pipe detail does not need animated flashing. Cache repetitive decoration rather than generating heavy textures every frame.

## 7. Integrate the rest of the supplied art and audio

Use the exact paths and ids in `assets/manifest.json` for enemies, boss, shop, backgrounds, and sound effects. Match the new Ghosty family to the existing illustrated Halloween style. Fit enemy/shop art with preserved aspect ratio, and use a larger boss draw rectangle. The background is 1536 x 1024, exactly the logical playfield aspect ratio; scale it to fit and do not assume seamless horizontal tiling or draw a duplicate moon over it.

Use one shared cached image loader with loading/error states and graceful existing placeholders. Do not construct/decode images on every render. A missing optional asset must not stop gameplay.

Register the new WAV cues AND trigger them once at their actual events: scored pipe, consumed shield, battle hit, successful purchase, accepted possession, and boss victory. Music needs a separate persistent looping instance unlocked by the first user gesture, quiet default volume, mute support, sensible pause/background-tab handling, and no stacked tracks after restart. Handle autoplay rejection without breaking the game.

## 8. Verify visible behavior and update the docs

Run the existing `npm test` suite and add focused regression coverage for the new action routing, appearance selection, persistence, and coordinate conversion where meaningful. Preserve existing invariants: separate flight/countdown/combat clocks, safe encounter checkpoint returns, ordinary pause preserving exact state, one-time Candy finalization, and no input leakage.

Manually verify in a browser; passing headless tests alone is not sufficient:

1. Mouse-only and keyboard-only paths from Main Menu to Wardrobe, preview, Buy, Equip, Back, and Start Adventure.
2. No Hat and all four equipped variants in preview, flight, and battle; both spirits retain the selected hat. Check stable optical body size/alignment and no double hats.
3. Unaffordable purchase, already owned item, repeated/held activation, reload persistence, and import/export cancel/error paths.
4. Buying does not auto-equip; selecting does not buy; equipping spends no Candy; no UI action flaps, restarts, or closes an unrelated screen.
5. Main Menu, Results, Pause, battle, possession, and shop choices are readable and actually clickable.
6. Desktop sizes around 1366 x 768 and 1920 x 1080, a high-DPI display, resize, and fullscreen enter/exit. Check pointer alignment and button visibility.
7. Detailed pipes still clearly show the safe gap. Shield/ground/ceiling behavior is unchanged, and the art remains readable over the new background.
8. Missing-image fallback, mute, Reduced Motion, and repeated restarts do not cause crashes, duplicate music, or stale overlays.

Update the relevant requirements/design/task entries to reflect this refinement without rewriting unrelated gameplay rules. Update README with actual run commands, controls, and the wardrobe/fullscreen behavior. Mark tasks complete only when their visible interactions work. Report changed files, automated test results, browser checks performed, and any remaining gaps honestly.
