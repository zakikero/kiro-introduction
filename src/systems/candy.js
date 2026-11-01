// systems/candy.js — the permanent Candy award and the one-shot Run finalize.
//
// Pure logic (no DOM): every function takes plain-object state plus the frozen
// CONFIG and returns new/updated state. All tuning (the Candy divisor, the
// boss-victory bonus) flows in from config.js — no balance constant is defined
// here.
//
// Candy is the permanent cosmetic currency earned across Runs (Req 8). It is
// kept strictly independent of the three in-Run pools (Soul_Coins, Battle_HP,
// Pipe_Score): finalize touches only `save.candy` and `save.highScore`, never a
// RunState currency, so the four quantities never cross-contaminate (Req 7.1).
//
// Two functions:
//   - `candyForRun` is the pure formula (Req 8.1, 8.2): Candy depends ONLY on
//     Active_Flight_Time and the boss-defeated flag, on no other time (Req 8.3).
//   - `finalizeRun` is the single idempotent award path (Req 8.4, 8.5, 8.6,
//     11.13, 11.14). It adds the Run's Candy and updates the saved high score
//     EXACTLY once, guarded by the one-shot `runState.finalized` latch so
//     repeated result clicks, reopening results, restarting, or reloading after
//     a saved result never duplicate the award.

/**
 * The Candy earned for a Run (Req 8.1, 8.2). Pure formula: the floor of
 * Active_Flight_Time divided by the configured divisor (15 s per Candy), plus
 * the configured boss-victory bonus when the Final_Boss was defeated this Run.
 * It reads ONLY `activeFlightTime` and `bossDefeated`, so it depends on no other
 * time — time in battles, rewards, shops, menus, pause, countdowns, hidden-tab
 * periods, and results is excluded by construction (Req 8.3), because the FSM
 * accrues `activeFlightTime` only in Active_Flight_State.
 *
 * @param {number} activeFlightTime seconds of Active_Flight_Time this Run
 * @param {boolean} bossDefeated whether the Final_Boss was defeated this Run
 * @param {object} config the frozen CONFIG
 * @returns {number} Candy earned (a non-negative integer)
 */
export function candyForRun(activeFlightTime, bossDefeated, config) {
  // Clamp a negative/invalid time to zero defensively so the award is never
  // negative; Active_Flight_Time only ever accrues upward from zero.
  const seconds = activeFlightTime > 0 ? activeFlightTime : 0;
  const base = Math.floor(seconds / config.candy.perRunDivisor);
  const bonus = bossDefeated ? config.candy.bossVictoryBonus : 0;
  return base + bonus;
}

/**
 * Finalize a Run's rewards (Req 8.4, 8.5, 8.6, 11.13, 11.14). This is the single
 * idempotent award path, invoked whenever a Run ends (flight death, combat
 * defeat, Final_Boss victory, or explicit End Run) and potentially again on
 * every subsequent Results view, restart, or reload-after-save.
 *
 * Idempotence is enforced by the one-shot `runState.finalized` latch (design
 * Data Models: RunState.finalized):
 *   - The FIRST call on a started Run adds `candyForRun(...)` to `save.candy`
 *     and, IF the final Pipe_Score exceeds the stored high score, updates
 *     `save.highScore` to that Pipe_Score (Req 11.13); it then latches
 *     `finalized = true`.
 *   - EVERY later call sees the latch set and returns the save unchanged, so
 *     the Candy award lands exactly once and the high score is updated at most
 *     once (Req 8.6, 11.14).
 *
 * An unstarted Run (`started === false`) finalizes nothing and awards no Candy
 * (Req 8.5): cancelling a Run that never began leaves the save untouched. It is
 * still latched so the unstarted result is stable across repeated views.
 *
 * Persistence (the "prompt-save" write to localStorage, Req 11.13) is the
 * caller's responsibility — this pure function only computes the updated save
 * so it stays testable headlessly. The caller writes the returned `save`.
 *
 * The passed `save` is mutated in place and also returned, matching the other
 * pure systems (economy, scoring, flight) that update the committed state they
 * are handed.
 *
 * @param {object} runState the RunState being finalized
 * @param {object} save the SaveData to award into
 * @param {object} config the frozen CONFIG
 * @returns {{ save: object, finalized: boolean }} the (possibly) updated save
 *   and whether THIS call performed the finalize (false if already finalized)
 */
export function finalizeRun(runState, save, config) {
  // Already finalized: idempotent no-op. Report finalized=false so a caller can
  // tell a repeat view from the one awarding call (Req 8.6, 11.14).
  if (runState.finalized) {
    return { save, finalized: false };
  }

  // Latch immediately so any re-entrant/repeat call is a no-op regardless of
  // which branch below runs.
  runState.finalized = true;

  // Unstarted Run: finalize nothing, award no Candy, leave the save untouched
  // (Req 8.5). The latch above still makes the unstarted result stable.
  if (!runState.started) {
    return { save, finalized: true };
  }

  // Award this Run's Candy exactly once (Req 8.4). Candy is permanent and kept
  // independent of the in-Run pools — only save.candy is touched.
  save.candy += candyForRun(runState.activeFlightTime, runState.bossDefeated, config);

  // Update the saved high score only when the final Pipe_Score beats it, and
  // leave it unchanged otherwise (Req 11.13). The latch guarantees this happens
  // at most once across repeated finalize calls (Req 11.14).
  if (runState.pipeScore > save.highScore) {
    save.highScore = runState.pipeScore;
  }

  return { save, finalized: true };
}

export default { candyForRun, finalizeRun };
