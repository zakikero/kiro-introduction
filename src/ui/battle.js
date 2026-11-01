// ui/battle.js — the dedicated battle scene view (thin DOM/IO module).
//
// This is a UI view module in the same spirit as ui/hud.js and ui/menu.js: it
// only draws to a Canvas 2D context handed to it and holds no gameplay state.
// All combat LOGIC lives in systems/combat.js (pure); this module presents the
// BattleState and the owning RunState, and never mutates either.
//
// What the dedicated battle scene shows (Req 5.21, 12.11):
//   - Ghosty with the equipped Hat and Spirit appearance,
//   - the enemy or Final_Boss (labeled placeholder art in the soft illustrated
//     Halloween style — missing enemy/boss art must never block the loop),
//   - BOTH Battle_HP displays (player and enemy),
//   - the enemy intent and any special-attack warning (telegraph),
//   - the Attack / Defend / Use Item actions plus any applicable Spirit action,
//   - readable feedback for each resolved action (the battle log tail).
//
// The scene is drawn SEPARATELY from the flight world (Req 5.22): render.js
// routes Battle_State here instead of drawing pipes/Ghosty-in-flight, and the
// frozen flight world is retained untouched on the RunState so it restores
// exactly when the battle ends. This module never reads or writes the flight
// `pipes`/`ghosty` fields — it only reads combat state.
//
// Pre-contact enemy info (Req 4.6) is also presented here via
// {@link describeEnemy}, so the HUD/flight overlay can show the enemy's
// identity, relative danger, and the expected reward/available Spirit BEFORE
// contact. That helper is pure (returns plain strings/numbers) so it is unit-
// testable with no DOM and can be reused by the flight overlay.
//
// Headless-safe: importing this module in a non-browser context never throws.
// Every draw is guarded with `typeof` checks so an absent/partial context is a
// silent no-op rather than a crash (graceful degradation, consistent with
// tech.md). The pure describe/label helpers are exported for tests.

/**
 * The player-facing label for an enemy by type. Ordinary enemy 'A' is the
 * Storm_Bat, 'B' is the Pumpkin_Guardian; the boss is the Final_Boss. Kept here
 * (presentation) rather than in the pure combat engine so combat stays about
 * numbers, not names.
 * @param {{ type?: string, isBoss?: boolean }} enemy
 * @returns {string}
 */
export function enemyDisplayName(enemy) {
  if (!enemy) return "Enemy";
  if (enemy.isBoss) return "The Final Boss";
  if (enemy.type === "A") return "Storm Bat";
  if (enemy.type === "B") return "Pumpkin Guardian";
  return "Enemy";
}

/**
 * The Spirit a given ordinary enemy offers on Possession after an ordinary
 * victory (Req 4.6 "available Spirit"). The boss offers none. Mirrors the
 * spirit-reward mapping in combat.js's `makeOrdinaryEnemy` so the pre-contact
 * promise matches what possession later grants.
 * @param {{ type?: string, isBoss?: boolean, spiritReward?: string }} enemy
 * @returns {string|null} a display name for the available Spirit, or null
 */
export function availableSpiritName(enemy) {
  if (!enemy || enemy.isBoss) return null;
  const id =
    enemy.spiritReward ||
    (enemy.type === "A" ? "storm_bat" : "pumpkin_guardian");
  if (id === "storm_bat") return "Storm Bat";
  if (id === "pumpkin_guardian") return "Pumpkin Guardian";
  return null;
}

/**
 * Describe an enemy's RELATIVE danger as a coarse, legible band (Req 4.6). This
 * is deliberately qualitative, not a raw number, so the pre-contact readout
 * communicates "how risky" at a glance. Danger is derived from the enemy's
 * attack damage and Battle_HP relative to the player's capability drawn from
 * config, so it stays truthful as tuning changes.
 *
 * @param {{ attackDamage?: number, battleHp?: number, isBoss?: boolean }} enemy
 * @param {object} config the frozen CONFIG
 * @returns {'Low'|'Moderate'|'High'|'Boss'} the danger band
 */
export function relativeDanger(enemy, config) {
  if (!enemy) return "Low";
  if (enemy.isBoss) return "Boss";

  // Compare the enemy to the ordinary baseline from config. An enemy that hits
  // harder or soaks more damage than the ordinary baseline reads as riskier.
  const baseAtk = config.ordinaryEnemy.attackDamage;
  const baseHp = config.ordinaryEnemy.battleHp;
  const atk =
    typeof enemy.attackDamage === "number" ? enemy.attackDamage : baseAtk;
  const hp = typeof enemy.battleHp === "number" ? enemy.battleHp : baseHp;

  // Ratio of "threat" vs the ordinary baseline (1.0 == a standard ordinary foe).
  const ratio = (atk / baseAtk) * 0.6 + (hp / baseHp) * 0.4;
  if (ratio <= 1.05) return "Low";
  if (ratio <= 1.5) return "Moderate";
  return "High";
}

/**
 * Build the pre-contact enemy readout (Req 4.6): identity, relative danger, and
 * the expected reward or available Spirit. Pure — returns a plain descriptor the
 * flight overlay (or a test) can render however it likes. Shown BEFORE contact,
 * so it reads from the enemy template (type/isBoss), never from a live battle.
 *
 * @param {{ type?: string, isBoss?: boolean, spiritReward?: string, attackDamage?: number, battleHp?: number }} enemy
 * @param {object} config the frozen CONFIG
 * @returns {{ name: string, danger: string, reward: number, spirit: (string|null) }}
 */
export function describeEnemy(enemy, config) {
  return {
    name: enemyDisplayName(enemy),
    danger: relativeDanger(enemy, config),
    // Ordinary victory grants the configured Soul_Coin reward; the boss grants
    // the run's conclusion rather than coins, so report 0 there.
    reward: enemy && enemy.isBoss ? 0 : config.ordinaryEnemy.victoryReward,
    spirit: availableSpiritName(enemy),
  };
}

/**
 * The player's currently-available battle actions (Req 5.3). Always Attack,
 * Defend, and Use Item; a Spirit move is appended WHERE the equipped Spirit
 * provides one. Pure and DOM-free so the scene draw and tests share one source
 * of truth for which buttons appear. The Spirit-move availability only reflects
 * whether the Spirit HAS a move — per-turn cooldown gating is combat.js's job
 * and is surfaced as a disabled/enabled flag by later tasks.
 *
 * @param {object} runState the active RunState (reads `equippedSpirit`)
 * @returns {Array<{ id: string, label: string }>}
 */
export function battleActions(runState) {
  const actions = [
    { id: "attack", label: "Attack" },
    { id: "defend", label: "Defend" },
    { id: "use_item", label: "Use Item" },
  ];

  const spirit = runState && runState.equippedSpirit;
  if (spirit === "storm_bat") {
    // Lightning is gated by its cooldown (owned on the Run); surface that as a
    // disabled/enabled flag so the scene can grey it out when not ready. The
    // authoritative gate is combat.js's lightningReady; this mirrors it for
    // presentation only.
    const ready =
      runState && runState.lightningCooldown
        ? runState.lightningCooldown <= 0
        : true;
    actions.push({ id: "spirit", label: "Lightning", available: ready });
  } else if (spirit === "pumpkin_guardian") {
    // Fortified Defend has no cooldown — always available when equipped.
    actions.push({ id: "spirit", label: "Fortified Defend", available: true });
  }
  return actions;
}

/**
 * The player-facing description of the enemy's intent for the upcoming enemy
 * turn, and any special-attack warning (Req 5.9, 5.21). For an ordinary enemy
 * the intent is a plain attack. For the boss, a telegraphed special turn shows
 * a clear warning so the Player can respond on the following turn (Req 5.12).
 *
 * Pure: reads the BattleState's telegraph flag and the enemy. The boss
 * action-sequence logic itself lives in combat.js (a later task); this only
 * presents whatever the BattleState currently reports.
 *
 * @param {object} battle the current BattleState (or null)
 * @returns {{ text: string, warning: (string|null) }}
 */
export function enemyIntent(battle) {
  if (!battle || battle.outcome !== "ongoing") {
    return { text: "", warning: null };
  }
  if (battle.bossSpecialTelegraphed) {
    return {
      text: "The enemy is charging a special attack!",
      warning: "Special attack incoming next turn — Defend to reduce it.",
    };
  }
  return { text: "The enemy is preparing to attack.", warning: null };
}

// --- Palette (shared feel with render.js / menu.js) -------------------------

const SCENE = {
  skyTop: "#241042",
  skyBottom: "#4a1f5e",
  moon: "#ffe9b3",
  panel: "rgba(16, 7, 32, 0.72)",
  panelEdge: "rgba(167, 97, 59, 0.8)",
  text: "#efe6ff",
  textDim: "#d8c6ff",
  hpBack: "rgba(20, 8, 40, 0.65)",
  hpPlayer: "#8ad17f", // soft green
  hpEnemy: "#e06a6a", // soft red
  warning: "#ffb347", // pumpkin orange
  ghostBody: "#efe6ff",
  ghostEdge: "#b9a9e6",
  enemyBody: "#c98adf",
  enemyEdge: "#7a3f98",
  hat: "#2a0f4a",
};

/**
 * Draw a labeled Battle_HP bar (both bars use this). Text-plus-bar so the value
 * is legible without relying on color alone (accessibility, Req 12.7).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x left
 * @param {number} y top
 * @param {number} w bar width
 * @param {string} label
 * @param {number} hp current Battle_HP
 * @param {number} maxHp max Battle_HP
 * @param {string} fill the fill color
 */
function drawHpBar(ctx, x, y, w, label, hp, maxHp, fill) {
  const h = 18;
  const safeMax = maxHp > 0 ? maxHp : 1;
  const frac = Math.max(0, Math.min(1, hp / safeMax));

  ctx.save();
  ctx.font = "600 16px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillStyle = SCENE.textDim;
  ctx.fillText(
    `${label}: ${Math.max(0, Math.round(hp))}/${Math.round(maxHp)}`,
    x,
    y - 4,
  );

  // Track.
  ctx.fillStyle = SCENE.hpBack;
  ctx.fillRect(x, y, w, h);
  // Fill.
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w * frac, h);
  // Edge.
  ctx.strokeStyle = SCENE.panelEdge;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}

/**
 * Draw a soft illustrated placeholder for a battle character (Ghosty or the
 * enemy) centered at (cx, cy). Missing character art must never block the loop
 * (Req 12.1 / 12.23), so a clean labeled silhouette stands in. A Hat is drawn
 * ON TOP when `withHat` is set, so the Hat stays visible in battle too — hats
 * are cosmetic and never clipped by a possessed look (steering: hats stay
 * visible across every spirit appearance).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx center x
 * @param {number} cy center y
 * @param {number} r body radius
 * @param {object} opts
 * @param {string} opts.body body fill
 * @param {string} opts.edge body edge
 * @param {boolean} [opts.withHat] draw a cosmetic hat on top
 * @param {string} [opts.spiritTint] optional spirit-decoration tint
 */
function drawCharacter(ctx, cx, cy, r, opts) {
  ctx.save();

  // Optional spirit decoration: a soft aura ring behind the body so possession
  // reads clearly in battle without touching the hitbox (cosmetic only).
  if (opts.spiritTint) {
    ctx.fillStyle = opts.spiritTint;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  ctx.fillStyle = opts.body;
  ctx.strokeStyle = opts.edge;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0, false);
  ctx.lineTo(cx + r, cy + r);
  const scallops = 3;
  const step = (2 * r) / scallops;
  for (let i = 0; i < scallops; i += 1) {
    const sx = cx + r - i * step;
    ctx.quadraticCurveTo(sx - step / 2, cy + r + 6, sx - step, cy + r);
  }
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Eyes.
  ctx.fillStyle = "#3a2a55";
  const eyeR = Math.max(2, r * 0.12);
  ctx.beginPath();
  ctx.arc(cx - r * 0.3, cy - r * 0.1, eyeR, 0, Math.PI * 2);
  ctx.arc(cx + r * 0.3, cy - r * 0.1, eyeR, 0, Math.PI * 2);
  ctx.fill();

  // Cosmetic hat drawn ON TOP so it is never hidden by the possessed look.
  if (opts.withHat) {
    ctx.fillStyle = SCENE.hat;
    ctx.strokeStyle = SCENE.panelEdge;
    ctx.lineWidth = 1.5;
    const brimW = r * 1.6;
    const brimY = cy - r + 2;
    ctx.beginPath();
    ctx.ellipse(cx, brimY, brimW / 2, r * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Cone.
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.5, brimY);
    ctx.lineTo(cx, brimY - r * 0.9);
    ctx.lineTo(cx + r * 0.5, brimY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * The spirit-aura tint for the equipped spirit, or null for base Ghosty.
 * @param {string|undefined} spirit
 * @returns {string|null}
 */
function spiritTintFor(spirit) {
  if (spirit === "storm_bat") return "#9ad0ff"; // airy blue
  if (spirit === "pumpkin_guardian") return "#ffb347"; // pumpkin orange
  return null;
}

/**
 * Draw the dedicated battle scene (Req 5.21, 12.11). Fully guarded: a no-op when
 * the context is absent or not a usable 2D context, or when there is no battle.
 *
 * Draws, in the soft illustrated Halloween style:
 *   - a moonlit backdrop distinct from the flight world,
 *   - Ghosty (with equipped Hat + Spirit aura) facing the enemy/boss,
 *   - both Battle_HP bars (player and enemy),
 *   - the enemy intent + any special-attack warning,
 *   - the action list (Attack/Defend/Use Item + any Spirit move),
 *   - the tail of the battle log as readable per-action feedback.
 *
 * @param {CanvasRenderingContext2D|null|undefined} ctx the 2D context
 * @param {object|null|undefined} runState the active RunState (player HP, loadout)
 * @param {object|null|undefined} battle the current BattleState (from combat.js)
 * @param {object} config the frozen CONFIG (playfield dimensions)
 * @returns {void}
 */
export function drawBattle(ctx, runState, battle, config) {
  if (!ctx || typeof ctx.fillRect !== "function") return;
  if (!battle) return;

  const width =
    (config && config.playfield && config.playfield.width) ||
    (ctx.canvas && ctx.canvas.width) ||
    960;
  const height =
    (config && config.playfield && config.playfield.height) ||
    (ctx.canvas && ctx.canvas.height) ||
    640;

  const enemy = battle.enemy || {};
  const spirit = runState && runState.equippedSpirit;

  ctx.save();

  // 1. Backdrop — a dedicated battle sky, clearly not the flight world.
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, SCENE.skyTop);
  sky.addColorStop(1, SCENE.skyBottom);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // Moon.
  ctx.fillStyle = SCENE.moon;
  ctx.beginPath();
  ctx.arc(width * 0.5, height * 0.18, 34, 0, Math.PI * 2);
  ctx.fill();

  // 2. Combatants — Ghosty on the left, enemy/boss on the right.
  const groundY = height * 0.58;
  drawCharacter(ctx, width * 0.28, groundY, 46, {
    body: SCENE.ghostBody,
    edge: SCENE.ghostEdge,
    withHat: true, // hats are cosmetic and always visible in battle
    spiritTint: spiritTintFor(spirit),
  });
  // The boss reads larger so its distinctive presence is obvious (Req 5.12).
  const enemyR = enemy.isBoss ? 64 : 46;
  drawCharacter(ctx, width * 0.72, groundY, enemyR, {
    body: SCENE.enemyBody,
    edge: SCENE.enemyEdge,
    withHat: false,
  });

  // Enemy name label (identity readable in-scene too).
  ctx.font = "600 18px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = SCENE.text;
  ctx.fillText(enemyDisplayName(enemy), width * 0.72, groundY - enemyR - 14);

  // 3. Both Battle_HP displays.
  const barW = width * 0.3;
  drawHpBar(
    ctx,
    width * 0.08,
    height * 0.12,
    barW,
    "Ghosty HP",
    runState ? runState.battleHp : 0,
    runState ? runState.maxBattleHp : 1,
    SCENE.hpPlayer,
  );
  drawHpBar(
    ctx,
    width * 0.62,
    height * 0.12,
    barW,
    `${enemyDisplayName(enemy)} HP`,
    typeof enemy.battleHp === "number" ? enemy.battleHp : 0,
    typeof enemy.maxBattleHp === "number" ? enemy.maxBattleHp : 1,
    SCENE.hpEnemy,
  );

  // 4. Enemy intent + special-attack warning (Req 5.9, 5.21).
  const intent = enemyIntent(battle);
  ctx.textAlign = "center";
  ctx.font = "500 16px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = SCENE.textDim;
  if (intent.text) ctx.fillText(intent.text, width * 0.5, height * 0.3);
  if (intent.warning) {
    ctx.fillStyle = SCENE.warning;
    ctx.font = "700 17px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(intent.warning, width * 0.5, height * 0.34);
  }

  // 5. Action list — a readable panel of the available actions (Req 5.3).
  const actions = battleActions(runState);
  const panelY = height * 0.72;
  const panelH = height * 0.24;
  ctx.fillStyle = SCENE.panel;
  ctx.fillRect(width * 0.06, panelY, width * 0.88, panelH);
  ctx.strokeStyle = SCENE.panelEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(width * 0.06, panelY, width * 0.88, panelH);

  ctx.textBaseline = "middle";
  ctx.font = "600 18px 'Segoe UI', system-ui, sans-serif";
  const colW = (width * 0.88) / actions.length;
  actions.forEach((action, i) => {
    const cx = width * 0.06 + colW * i + colW / 2;
    ctx.textAlign = "center";
    // An unavailable action (e.g. Lightning on cooldown) is dimmed AND labeled
    // "(cooldown)" so its state reads by text, not color alone (Req 12.7).
    const unavailable = action.available === false;
    ctx.fillStyle = unavailable ? SCENE.textDim : SCENE.text;
    ctx.globalAlpha = unavailable ? 0.5 : 1;
    const suffix = unavailable ? " (cooldown)" : "";
    ctx.fillText(`${i + 1}. ${action.label}${suffix}`, cx, panelY + 26);
    ctx.globalAlpha = 1;
  });

  // 6. Readable per-action feedback — the tail of the battle log (Req 5.9).
  ctx.textAlign = "left";
  ctx.font = "500 15px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = SCENE.textDim;
  const log = Array.isArray(battle.log) ? battle.log.slice(-3) : [];
  log.forEach((line, i) => {
    ctx.fillText(line, width * 0.09, panelY + 58 + i * 20);
  });

  // 7. Outcome banner when the battle has ended.
  if (battle.outcome === "victory" || battle.outcome === "defeat") {
    ctx.textAlign = "center";
    ctx.font = "700 34px 'Segoe UI', system-ui, sans-serif";
    ctx.fillStyle =
      battle.outcome === "victory" ? SCENE.hpPlayer : SCENE.hpEnemy;
    ctx.fillText(
      battle.outcome === "victory" ? "Victory!" : "Defeated",
      width * 0.5,
      height * 0.46,
    );
  }

  ctx.restore();
}

/**
 * Turn a Possession offer (from combat.js's `possessionOffer`) into readable
 * lines for the Reward_State screen (Req 6.1, 6.2, 6.6). Pure — returns plain
 * strings so the draw function and tests share one source of truth. The lines
 * spell out the offered Spirit's name, BOTH its one Flight benefit and one
 * combat benefit (so the choice is informed, Req 6.6), the current Spirit being
 * kept-or-replaced, and the two choices (replace / decline, Req 6.2).
 *
 * @param {object|null} offer the descriptor from combat.js's possessionOffer
 * @returns {{ title: string, flight: string, combat: string, current: string, choices: string[] }|null}
 */
export function possessionOfferLines(offer) {
  if (!offer || !offer.offered) return null;
  const currentName =
    offer.currentSpirit === "storm_bat"
      ? "Storm Bat"
      : offer.currentSpirit === "pumpkin_guardian"
        ? "Pumpkin Guardian"
        : "no Spirit";
  return {
    title: `Possess the ${offer.offered.name}?`,
    flight: `Flight: ${offer.offered.flight}`,
    combat: `Combat: ${offer.offered.combat}`,
    current: `You currently carry ${currentName}. Replacing swaps it for this Run.`,
    choices: (offer.choices || []).map((c, i) => `${i + 1}. ${c.label}`),
  };
}

/**
 * Draw the Possession offer presented in Reward_State after an ordinary victory
 * (Req 6.1, 6.2, 6.6). Fully guarded: a no-op when the context is absent/not a
 * usable 2D context, or when there is no offer. Draws a soft-illustrated panel
 * explaining the offered Spirit's one Flight benefit and one combat benefit and
 * the replace/decline choices, so the Player decides with both benefits in view
 * BEFORE possessing. Presentation only — the choice is applied by combat.js's
 * `applyPossessionChoice` via the FSM.
 *
 * @param {CanvasRenderingContext2D|null|undefined} ctx the 2D context
 * @param {object|null|undefined} offer the descriptor from combat.js
 * @param {object} config the frozen CONFIG (playfield dimensions)
 * @returns {void}
 */
export function drawPossessionOffer(ctx, offer, config) {
  if (!ctx || typeof ctx.fillRect !== "function") return;
  const lines = possessionOfferLines(offer);
  if (!lines) return;

  const width =
    (config && config.playfield && config.playfield.width) ||
    (ctx.canvas && ctx.canvas.width) ||
    960;
  const height =
    (config && config.playfield && config.playfield.height) ||
    (ctx.canvas && ctx.canvas.height) ||
    640;

  ctx.save();

  // Panel.
  const px = width * 0.2;
  const py = height * 0.28;
  const pw = width * 0.6;
  const ph = height * 0.44;
  ctx.fillStyle = SCENE.panel;
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = SCENE.panelEdge;
  ctx.lineWidth = 2;
  ctx.strokeRect(px, py, pw, ph);

  ctx.textAlign = "center";
  ctx.fillStyle = SCENE.text;
  ctx.font = "700 24px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(lines.title, width * 0.5, py + 40);

  ctx.textAlign = "left";
  ctx.font = "500 16px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = SCENE.textDim;
  ctx.fillText(lines.flight, px + 28, py + 84);
  ctx.fillText(lines.combat, px + 28, py + 112);
  ctx.fillText(lines.current, px + 28, py + 150);

  ctx.font = "600 18px 'Segoe UI', system-ui, sans-serif";
  ctx.fillStyle = SCENE.text;
  lines.choices.forEach((line, i) => {
    ctx.fillText(line, px + 28, py + 196 + i * 30);
  });

  ctx.restore();
}

export default {
  drawBattle,
  describeEnemy,
  enemyDisplayName,
  availableSpiritName,
  relativeDanger,
  battleActions,
  enemyIntent,
  possessionOfferLines,
  drawPossessionOffer,
};
