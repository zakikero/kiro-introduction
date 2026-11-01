// ui/results.js — the Results_State view and its pure content model.
//
// Split in two, matching the repo's "pure core, thin shell" rule (tech.md):
//
//   • `resultsSummary(runState, save, config)` is PURE. Given the ended Run and
//     the loaded SaveData it returns a plain-object data model describing
//     everything the Results screen must show (Req 10.5): the victory status or
//     cause of defeat, the final Pipe_Score, the Active_Flight_Time, the number
//     of Enemies defeated, the Candy calculation breakdown, the Candy earned,
//     and the updated total Candy balance. It touches no DOM and mutates
//     nothing, so it is unit- and property-testable headlessly.
//
//   • `drawResults(ctx, summary, config)` is the thin DOM/IO view (like
//     ui/menu.js): it only paints the summary and the three actions onto a
//     Canvas 2D context, holds no state, and is a silent no-op when the context
//     is absent (graceful degradation, headless-safe at import time).
//
// Candy tuning (divisor, boss bonus) flows inward from CONFIG — never hardcoded
// here. The Candy calculation mirrors systems/candy.js's `candyForRun`
// (floor(Active_Flight_Time / divisor) + boss-victory bonus); that module owns
// the authoritative accrual + idempotent finalize (task 5.1). This view reads a
// clean seam: it computes the DISPLAYABLE breakdown from the Run + CONFIG, and
// takes the "updated total" as whatever is already reflected on SaveData so the
// number shown stays consistent with finalize once wired.

/**
 * The three Results actions (Req 10.6). Stable ids so input routing / tests can
 * refer to them without matching on label text.
 * @readonly
 */
export const ResultsAction = Object.freeze({
  Restart: "restart",
  MainMenu: "mainMenu",
  Wardrobe: "wardrobe",
});

/**
 * Human-readable cause-of-defeat labels keyed by the RunState `outcome` code
 * recorded at the Run-ending edge (state.js / main.js). Unknown/missing codes
 * degrade to a generic defeat label so the screen always reads sensibly.
 * @readonly
 */
const DEFEAT_CAUSE_LABELS = Object.freeze({
  pipe: "Fatal pipe collision",
  "ground-ceiling": "Hit the ground or ceiling",
  battle: "Defeated in battle",
});

/** The three action buttons, in display order, with stable ids and labels. */
const RESULTS_ACTIONS = Object.freeze([
  { id: ResultsAction.Restart, label: "Restart" },
  { id: ResultsAction.MainMenu, label: "Main Menu" },
  { id: ResultsAction.Wardrobe, label: "Wardrobe" },
]);

/**
 * Read a finite, non-negative number defensively, flooring to an integer.
 * A missing/corrupt/non-numeric value degrades to 0 so the summary never
 * surfaces NaN or a negative count.
 * @param {*} value
 * @returns {number}
 */
function safeNonNegInt(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Read a finite, non-negative seconds value defensively (NOT floored — seconds
 * are a continuous quantity we format for display).
 * @param {*} value
 * @returns {number}
 */
function safeNonNegSeconds(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Compute the Candy calculation breakdown for an ended Run, mirroring
 * systems/candy.js `candyForRun`: a time component of
 * floor(Active_Flight_Time / divisor) plus the configured boss-victory bonus
 * when the Final_Boss was defeated (Req 8.1, 8.2). Pure; reads tuning from
 * CONFIG only.
 *
 * @param {object} runState the ended RunState
 * @param {object} config the frozen CONFIG
 * @returns {{ activeFlightTime:number, divisor:number, timeComponent:number,
 *   bossDefeated:boolean, bossBonus:number, earned:number }}
 */
export function candyBreakdown(runState, config) {
  const rs = runState || {};
  const candyCfg = (config && config.candy) || {};
  const divisor =
    typeof candyCfg.perRunDivisor === "number" && candyCfg.perRunDivisor > 0
      ? candyCfg.perRunDivisor
      : 15;
  const bonusCfg =
    typeof candyCfg.bossVictoryBonus === "number" &&
    candyCfg.bossVictoryBonus >= 0
      ? Math.floor(candyCfg.bossVictoryBonus)
      : 0;

  const activeFlightTime = safeNonNegSeconds(rs.activeFlightTime);
  const timeComponent = Math.floor(activeFlightTime / divisor);
  const bossDefeated = Boolean(rs.bossDefeated);
  const bossBonus = bossDefeated ? bonusCfg : 0;

  return {
    activeFlightTime,
    divisor,
    timeComponent,
    bossDefeated,
    bossBonus,
    earned: timeComponent + bossBonus,
  };
}

/**
 * Determine the outcome display for an ended Run.
 *
 * Victory is defined by the Run reaching a win: the Final_Boss was defeated
 * (`bossDefeated`), or the RunState explicitly recorded `outcome === 'victory'`.
 * Otherwise the Run is a defeat, and the cause is taken from the recorded
 * `outcome` code (see {@link DEFEAT_CAUSE_LABELS}); an unknown/missing code
 * degrades to a generic defeat label.
 *
 * @param {object} runState the ended RunState
 * @returns {{ victory:boolean, status:string, cause:(string|null) }}
 */
export function runOutcome(runState) {
  const rs = runState || {};
  const code = typeof rs.outcome === "string" ? rs.outcome : null;
  const victory = Boolean(rs.bossDefeated) || code === "victory";

  if (victory) {
    return { victory: true, status: "Victory", cause: null };
  }

  const cause =
    (code && DEFEAT_CAUSE_LABELS[code]) || "Run ended";
  return { victory: false, status: "Defeat", cause };
}

/**
 * Format a seconds duration as `M:SS` for legible display (Active_Flight_Time
 * is simulation seconds, Req 10.5). Falsy/short runs render `0:00`.
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(safeNonNegSeconds(seconds)));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Build the complete Results_State content model (Req 10.5, 10.6). PURE: no DOM,
 * no mutation of `runState` or `save`.
 *
 * The "updated total Candy balance" is read from SaveData (`save.candy`), which
 * is where the idempotent finalize (systems/candy.js, task 5.1) deposits the
 * earned Candy before this screen is shown; reading it keeps the displayed total
 * consistent with the authoritative balance rather than re-deriving it here.
 *
 * @param {object} runState the ended RunState
 * @param {object|null|undefined} save the loaded SaveData (or null)
 * @param {object} config the frozen CONFIG
 * @returns {{
 *   victory: boolean,
 *   status: string,
 *   cause: (string|null),
 *   pipeScore: number,
 *   activeFlightTime: number,
 *   activeFlightTimeLabel: string,
 *   enemiesDefeated: number,
 *   candy: { activeFlightTime:number, divisor:number, timeComponent:number,
 *            bossDefeated:boolean, bossBonus:number, earned:number },
 *   candyEarned: number,
 *   totalCandy: number,
 *   actions: Array<{ id:string, label:string }>,
 * }}
 */
export function resultsSummary(runState, save, config) {
  const rs = runState || {};
  const outcome = runOutcome(rs);
  const candy = candyBreakdown(rs, config);
  const totalCandy = safeNonNegInt(save && save.candy);

  return {
    victory: outcome.victory,
    status: outcome.status,
    cause: outcome.cause,
    pipeScore: safeNonNegInt(rs.pipeScore),
    activeFlightTime: candy.activeFlightTime,
    activeFlightTimeLabel: formatDuration(candy.activeFlightTime),
    enemiesDefeated: safeNonNegInt(rs.enemiesDefeated),
    candy,
    candyEarned: candy.earned,
    totalCandy,
    actions: RESULTS_ACTIONS.map((a) => ({ ...a })),
  };
}

/**
 * Draw the Results screen (Req 10.5, 10.6) in the soft illustrated Halloween
 * style (Req 12.1, not pixel art). Thin view: it only paints the data model
 * from {@link resultsSummary}; it computes nothing gameplay-relevant.
 *
 * Fully guarded — a no-op (never throws) when the context is absent or not a
 * usable 2D context, matching ui/menu.js so headless imports/tests stay safe.
 *
 * @param {CanvasRenderingContext2D|null|undefined} ctx
 * @param {object} summary the model from {@link resultsSummary}
 * @param {object} config the frozen CONFIG (for playfield dimensions)
 * @returns {void}
 */
export function drawResults(ctx, summary, config) {
  if (!ctx || typeof ctx.fillText !== "function" || !summary) return;

  const width =
    (config && config.playfield && config.playfield.width) ||
    (ctx.canvas && ctx.canvas.width) ||
    960;
  const height =
    (config && config.playfield && config.playfield.height) ||
    (ctx.canvas && ctx.canvas.height) ||
    640;

  const centerX = width / 2;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Soft dark halo for readability over the moonlit sky (matches ui/menu.js).
  ctx.shadowColor = "rgba(20, 8, 40, 0.85)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 3;

  // --- Outcome heading: victory (moonlit lavender) or defeat (pumpkin). ---
  ctx.fillStyle = summary.victory ? "#e8d8ff" : "#ffb347";
  ctx.font = "700 44px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(summary.status, centerX, height * 0.14);

  if (!summary.victory && summary.cause) {
    ctx.fillStyle = "#f0c9b0";
    ctx.font = "500 22px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText(summary.cause, centerX, height * 0.21);
  }

  // --- Run stats block (Req 10.5). ---
  const lines = [
    `Pipe Score: ${summary.pipeScore}`,
    `Flight Time: ${summary.activeFlightTimeLabel}`,
    `Enemies Defeated: ${summary.enemiesDefeated}`,
  ];
  ctx.fillStyle = "#e8d8ff";
  ctx.font = "500 24px 'Segoe UI', system-ui, sans-serif";
  let y = height * 0.33;
  for (const line of lines) {
    ctx.fillText(line, centerX, y);
    y += 36;
  }

  // --- Candy calculation shown explicitly (Req 10.5). ---
  const c = summary.candy;
  const bossPart = c.bossDefeated ? ` + ${c.bossBonus} boss bonus` : "";
  ctx.fillStyle = "#ffd27f";
  ctx.font = "500 22px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(
    `Candy: floor(${Math.floor(c.activeFlightTime)}s / ${c.divisor})` +
      ` = ${c.timeComponent}${bossPart}`,
    centerX,
    y + 10,
  );
  y += 44;

  ctx.fillStyle = "#ffb347";
  ctx.font = "700 26px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(`Candy Earned: ${summary.candyEarned}`, centerX, y + 10);
  y += 38;

  ctx.fillStyle = "#e8d8ff";
  ctx.font = "500 22px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(`Total Candy: ${summary.totalCandy}`, centerX, y + 6);

  // --- Actions (Req 10.6): restart, Main Menu, Wardrobe. ---
  const labels = summary.actions.map((a) => a.label).join("      ");
  ctx.fillStyle = "#cbb8e8";
  ctx.font = "600 22px 'Segoe UI', system-ui, sans-serif";
  ctx.fillText(labels, centerX, height * 0.9);

  ctx.restore();
}

export default { resultsSummary, candyBreakdown, runOutcome, formatDuration, drawResults, ResultsAction };
