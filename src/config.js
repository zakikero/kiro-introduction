// config.js — the single source of tuning truth for Kiro's Haunted Flight.
//
// CONFIG holds every value from the "Configurable Initial Defaults" table in
// .kiro/specs/flappy-kiro/requirements.md. Every other module imports tuning
// values from here; no tuning constant is defined anywhere else.
//
// Logical units are logical pixels and simulation seconds. Ghosty's x/y are
// CENTER coordinates; the sprite draw rect and the Hitbox derive from the
// logical body size, never from the PNG's natural pixel dimensions.
//
// Balancing pass (task 6.3) — verified against the spec targets; NO changes
// were needed, so every value below is retained as documented:
//   * Ordinary battle length (target 3–5 player turns, Req 5.10):
//     ordinaryEnemy.battleHp 12 / playerBaseAttack 5 = ceil(12/5) = 3 player
//     Attacks. The player acts first, so the battle ends on player turn 3 —
//     inside the 3–5 window with headroom for a Defend turn.
//   * Adventure duration (target 3–5 minutes, Req 4.1): the boss triggers at
//     triggers.boss = 120 s of Active_Flight_Time (2 min of pure flight);
//     adding the two ordinary battles, boss battle, two shops, rewards, and
//     resume countdowns (all off the flight clock) lands a typical successful
//     Run inside the 3–5 minute window. The flight schedule (15/35/60/85/120)
//     is unchanged.
//   * Boss-win math (Req 5.20): starting Battle_HP 22 vs boss HP 30 under the
//     documented enemy-action sequence leaves the base Ghosty alive at 2 HP.
//     No combat number was touched, so the validated trace is intact (the
//     base-ghost boss-win trace test still passes).

/**
 * Recursively freeze an object and all nested objects/arrays so that no tuning
 * value can be mutated at runtime.
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object" || Object.isFrozen(obj)) {
    return obj;
  }
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return Object.freeze(obj);
}

const rawConfig = {
  // --- Logical playfield (wide landscape) ---
  playfield: {
    width: 960, // logical px
    height: 640, // logical px
  },

  // --- Flight physics ---
  gravity: 1600, // logical px/s^2 (downward)
  normalFlapVelocity: -480, // logical px/s (negative = up); velocity is SET, not added
  terminalVelocity: 700, // logical px/s (max downward velocity)

  // --- Ghosty geometry (center coordinates) ---
  ghosty: {
    bodyWidth: 32, // logical px; drives the sprite draw rect and Hitbox
    bodyHeight: 39, // logical px
    initialCenter: { x: 160, y: 320 }, // logical px; x/y are CENTER coordinates
    initialVelocityY: 0, // logical px/s; stationary in Ready_State until first flap
    hitboxInset: 4, // logical px inset on each side from the logical body bounds
    // Derived Hitbox dimensions (32 - 2*4 = 24 wide, 39 - 2*4 = 31 tall).
    hitboxWidth: 24, // logical px (derived: bodyWidth - 2*hitboxInset)
    hitboxHeight: 31, // logical px (derived: bodyHeight - 2*hitboxInset)
  },

  // --- Hover (Storm_Bat Flight_Power) ---
  hover: {
    duration: 0.6, // Active_Flight simulation s of suspended gravity
    cooldown: 5, // Active_Flight simulation s; starts on activation
  },

  // --- Obstacles and difficulty ---
  pipe: {
    width: 70, // logical px
    spacing: 240, // logical px between successive pairs
    gapHeight: 180, // logical px
    minClearance: 40, // logical px from Ground/Ceiling
    maxGapCenterDelta: 120, // logical px max change in gap center between pairs
  },
  scroll: {
    base: 140, // logical px/s
    increment: 20, // logical px/s per milestone reached
    milestones: [20, 45, 75, 110], // seconds of Active_Flight_Time
    max: 220, // logical px/s
  },

  // --- Shields ---
  shieldCap: 1, // max shield charges

  // --- Combat numbers ---
  combat: {
    startingBattleHp: 22, // HP; also maxBattleHp for a Run
    playerBaseAttack: 5, // HP
    defendReduction: 0.5, // 50% reduction to next incoming enemy attack only
    // Percentage-reduction damage rounding: round down, min 0.
    percentRounding: "floor-min-0",
  },

  // --- Ordinary enemy ---
  ordinaryEnemy: {
    battleHp: 12, // HP
    attackDamage: 3, // HP
    victoryReward: 6, // Soul_Coins on ordinary victory
  },

  // --- Final boss ---
  boss: {
    battleHp: 30, // HP
    normalDamage: 4, // HP
    specialDamage: 8, // HP; telegraphed one enemy turn ahead
    // Ordered enemy actions by enemy turn. Telegraph turns deal no damage;
    // a defeated enemy takes no turn.
    actionSequence: [
      "normal",
      "telegraph",
      "special",
      "normal",
      "normal",
      "normal",
      "telegraph",
      "special",
    ],
    specialFirstTelegraphTurn: 2, // enemy turn on which the special is first telegraphed (special lands on the 3rd)
    specialCooldown: 3, // subsequent resolved enemy turns after a special before it may telegraph again
  },

  // --- Spirit combat moves ---
  spirits: {
    stormBat: {
      lightningDamage: 9, // HP
      lightningCooldown: 2, // battle turns
    },
    pumpkinGuardian: {
      fortifiedDefendReduction: 0.75, // 75% reduction to next incoming enemy attack only
    },
  },

  // --- Economy / shop ---
  shop: {
    potion: {
      effect: 10, // +10 Battle_HP, capped at maxBattleHp; disabled at full health
      price: 5, // Soul_Coins
      initialCount: 0, // items.potion per Run; reset to 0 at new-run init
    },
    shieldItem: {
      price: 8, // Soul_Coins
    },
    attackUpgrade: {
      effect: 3, // +3 Attack damage for the rest of the Run
      price: 7, // Soul_Coins
      purchaseLimit: 1, // per Run
    },
  },

  // --- Adventure schedule triggers (seconds of Active_Flight_Time) ---
  triggers: {
    firstEncounter: 15,
    firstShop: 35,
    secondEnemy: 60, // type B (Pumpkin_Guardian enemy), strictly between first-shop and boss
    secondShop: 85, // strictly between first-shop and boss
    boss: 120,
  },

  // --- Candy (permanent cosmetic currency) ---
  candy: {
    // Candy per Run = floor(Active_Flight_Time / 15).
    perRunDivisor: 15,
    bossVictoryBonus: 3, // +3 Candy
  },

  // --- Hats (cosmetic, bought with Candy) ---
  hats: {
    witchHat: 3, // Candy
    pumpkinCap: 6, // Candy
    batBonnet: 10, // Candy
    hauntedCrown: 15, // Candy
  },

  // --- Resumption ---
  resumeCountdown: 3, // seconds

  // --- Persistence ---
  saveVersion: 1, // integer save format version
};

/** The frozen central configuration. */
export const CONFIG = deepFreeze(rawConfig);

export default CONFIG;
