// systems/spirits.js — Possession: equipping and switching the single Spirit a
// Run may carry.
//
// Pure logic (no DOM): `possess` takes the plain-object RunState plus the frozen
// CONFIG and returns the same RunState, mutated in place (matching the other
// systems — scoring, flight, economy — that update the committed state they are
// handed). All tuning flows in from config.js; no balance constant lives here.
//
// The possession rules this module enforces (Requirement 6):
//   - At most ONE Spirit is equipped at a time (Req 6.3). `possess` REPLACES the
//     equipped spirit outright; there is no party and no permanent collection.
//   - Equipping affects only the current Run (Req 6.4). RunState is per-Run, so
//     a fresh Run starts at `equippedSpirit: 'none'` and nothing here persists.
//   - Base Ghosty with no spirit stays fully playable (Req 6.5): equipping
//     'none' is a valid request that simply clears the spirit.
//   - Pumpkin_Guardian grants a ONE-TIME Shield gift on its first possession in
//     the Run (Req 6.8), latched by `pumpkinShieldGiftUsed` so replacing,
//     re-equipping, or re-acquiring it never refreshes the gift (Req 6.10), and
//     the gift respects the single-charge Shield cap (config.shieldCap).
//   - Switching Spirits NEVER refills resources (Req 6.11, 6.17): Battle_HP,
//     consumables (items), Shield charges, and every cooldown — including
//     `hoverCooldown` and `lightningCooldown` — are left untouched, and existing
//     Shield charges are retained across the switch (Req 3.14). Switching grants
//     no collision immunity (Req 3.7); that is the Shield's sole domain and this
//     module never touches `shieldGracePairId`.
//
// The ONLY field `possess` may change besides `equippedSpirit` is the Shield
// gift's `shieldCharges` + `pumpkinShieldGiftUsed` latch, and only on the first
// Pumpkin_Guardian possession of the Run.

/**
 * The set of valid spirit ids a Run may equip (design Data Models → Spirit),
 * plus the sentinel `'none'` for base Ghosty. Kept frozen so callers can switch
 * on these without magic strings and tests can assert against them.
 * @readonly
 * @enum {string}
 */
export const SpiritId = Object.freeze({
  NONE: "none",
  STORM_BAT: "storm_bat",
  PUMPKIN_GUARDIAN: "pumpkin_guardian",
});

/**
 * Whether `spiritId` is a value `possess` accepts: one of the two Spirits or
 * the `'none'` sentinel that clears the equipped Spirit (Req 6.5).
 * @param {string} spiritId
 * @returns {boolean}
 */
export function isValidSpirit(spiritId) {
  return (
    spiritId === SpiritId.NONE ||
    spiritId === SpiritId.STORM_BAT ||
    spiritId === SpiritId.PUMPKIN_GUARDIAN
  );
}

/**
 * The EXACTLY ONE Flight benefit and ONE combat benefit a Spirit provides
 * (Req 6.6, 6.7, 6.8), as a plain descriptor the Possession offer explains
 * before the Player chooses (Req 6.1, 6.6). Pure and DOM-free so both the
 * Reward UI and tests share one source of truth; the actual numbers (lightning
 * damage/cooldown, fortified reduction, Hover duration/cooldown) live in the
 * BENEFIT text only as labels — the engine reads the real values from config.
 *
 * Storm_Bat: Hover (flight) + a lightning strike (combat) — Req 6.7.
 * Pumpkin_Guardian: a one-time Shield gift on first possession (flight-side
 * protection) + a fortified defend (combat) — Req 6.8.
 *
 * Returns `null` for `'none'`/unknown ids (base Ghosty offers no possession).
 *
 * @param {string} spiritId one of 'storm_bat' | 'pumpkin_guardian'
 * @returns {{ id: string, name: string, flight: string, combat: string } | null}
 */
export function spiritBenefits(spiritId) {
  if (spiritId === SpiritId.STORM_BAT) {
    return {
      id: SpiritId.STORM_BAT,
      name: "Storm Bat",
      flight: "Hover — briefly suspend gravity in flight.",
      combat: "Lightning — a strong strike on a short cooldown.",
    };
  }
  if (spiritId === SpiritId.PUMPKIN_GUARDIAN) {
    return {
      id: SpiritId.PUMPKIN_GUARDIAN,
      name: "Pumpkin Guardian",
      flight: "Shield gift — a one-time Shield charge on first possession.",
      combat: "Fortified Defend — greatly reduce the next incoming attack.",
    };
  }
  return null;
}

/**
 * Replace the Run's equipped Spirit with `spiritId` (Req 6.2, 6.3), applying
 * the Pumpkin_Guardian first-possession Shield gift when it is due.
 *
 * Switching NEVER refills Battle_HP, consumables, Shield charges, or any
 * cooldown, and existing Shield charges are retained across the switch — the
 * only resource this function may change is the Shield gift described below
 * (Req 3.14, 6.11, 6.17). An unknown `spiritId` is rejected: the RunState is
 * returned unchanged so a bad id can never corrupt the loadout.
 *
 * The Pumpkin_Guardian gift (Req 6.8, 6.10): the FIRST time Pumpkin_Guardian is
 * possessed in a Run — and only then — one Shield charge is granted, clamped to
 * `config.shieldCap`, and the per-Run `pumpkinShieldGiftUsed` latch is set so
 * replacing, re-equipping, or re-acquiring Pumpkin_Guardian never grants it
 * again. If the latch is already set, or Shield charges are already at the cap,
 * the gift adds nothing (the latch is still set so intent is recorded once).
 *
 * The RunState is mutated in place and also returned, matching the other pure
 * systems.
 *
 * @param {object} runState the active RunState
 * @param {string} spiritId one of 'none' | 'storm_bat' | 'pumpkin_guardian'
 * @param {object} config the frozen CONFIG
 * @returns {object} the same runState, for chaining
 */
export function possess(runState, spiritId, config) {
  // Reject unknown ids: leave the loadout exactly as it was so a stray value
  // can never clear or corrupt the equipped Spirit.
  if (!isValidSpirit(spiritId)) {
    return runState;
  }

  // Replace the single equipped Spirit outright (Req 6.3). No party/collection
  // is kept; the previous spirit is simply discarded. This is the only field
  // changed for Storm_Bat or 'none' — no resource is refilled (Req 6.11).
  runState.equippedSpirit = spiritId;

  // Pumpkin_Guardian's one-time Shield gift (Req 6.8, 6.10). Latched per Run:
  // granted only on the first possession and never refreshed by re-equipping.
  if (
    spiritId === SpiritId.PUMPKIN_GUARDIAN &&
    !runState.pumpkinShieldGiftUsed
  ) {
    // Latch first so the gift is recorded as spent for the Run even when the
    // charge itself is suppressed by the cap below — one gift per Run, period.
    runState.pumpkinShieldGiftUsed = true;
    // Respect the single-charge cap: clamp so existing charges are retained and
    // the total never exceeds config.shieldCap (Req 3.14, 6.10).
    runState.shieldCharges = Math.min(
      config.shieldCap,
      runState.shieldCharges + 1,
    );
  }

  return runState;
}

export default { possess, isValidSpirit, spiritBenefits, SpiritId };
