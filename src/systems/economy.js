// systems/economy.js — the in-run shop inventory, purchase validation, and the
// ordinary-victory Soul_Coin reward.
//
// Pure logic (no DOM): every function takes plain-object state plus the frozen
// CONFIG and returns new/updated state. All tuning (prices, effects, limits)
// flows in from config.js — no balance constant is defined here.
//
// The three items every Shop stocks (Req 7.3):
//   - 'potion'         — restores Battle_HP; no per-Run cap, it STACKS in
//                        RunState.items.potion (Req 7.12).
//   - 'shield'         — one Shield charge; respects the single-charge cap
//                        (config.shieldCap) so a second buy while already
//                        holding a charge is rejected.
//   - 'attack_upgrade' — +config.shop.attackUpgrade.effect Attack damage for
//                        the rest of the Run; limited to
//                        config.shop.attackUpgrade.purchaseLimit (1) per Run
//                        (Req 7.8).
//
// `purchase` is the single validated entry point (Req 7.6–7.8, 7.12). It is the
// economy's safety barrier:
//   - unaffordable purchases are rejected with Soul_Coins AND inventory left
//     exactly unchanged (Req 7.6);
//   - Soul_Coins can never go negative (Req 7.7) — affordability is checked
//     before any deduction;
//   - one confirmed action yields at most one purchase, so the UI calling
//     purchase once per confirmed click is all that's needed to honor the
//     "duplicate/repeated input counts as one purchase" rule (Req 7.7, 7.12);
//   - the attack upgrade can never exceed its per-Run limit (Req 7.8).
//
// It returns `{ runState, ok, reason }`: `ok` is whether the purchase applied,
// `reason` is a stable machine-readable code (null on success) the UI can map
// to a message. On rejection `runState` is returned with no economy field
// changed.

/**
 * Stable rejection reason codes returned by {@link purchase} when `ok` is
 * false. Kept as a frozen map so callers can switch on them without magic
 * strings and tests can assert against them.
 * @readonly
 * @enum {string}
 */
export const PurchaseReason = Object.freeze({
  UNKNOWN_ITEM: 'unknown_item',
  UNAFFORDABLE: 'unaffordable',
  SHIELD_AT_CAP: 'shield_at_cap',
  ATTACK_LIMIT_REACHED: 'attack_limit_reached',
});

/**
 * Build the Shop inventory for the current config (Req 7.3, 7.5). Returns a
 * fresh array of ShopItem descriptors (design Data Models: ShopItem) every
 * call — the UI reads `effectText`, `price`, `maxQuantity`, and derives
 * affordability/remaining from the live RunState.
 *
 * `maxQuantity` is the per-Run purchase cap: `null` means uncapped (the potion
 * stacks in `items.potion`), `1` caps the shield (one-charge cap) and the
 * attack upgrade (per-Run limit). `purchasedThisRun` is initialized to 0 here;
 * callers that want live remaining counts can recompute it from RunState via
 * {@link purchasedCount}.
 *
 * @param {object} config the frozen CONFIG
 * @returns {Array<{id: string, effectText: string, price: number, maxQuantity: (number|null), purchasedThisRun: number}>}
 */
export function shopInventory(config) {
  const { potion, shieldItem, attackUpgrade } = config.shop;

  return [
    {
      id: 'potion',
      effectText: `Restore ${potion.effect} Battle HP`,
      price: potion.price,
      maxQuantity: null, // uncapped: stacks in items.potion (Req 7.12)
      purchasedThisRun: 0,
    },
    {
      id: 'shield',
      effectText: 'Gain 1 Shield charge',
      price: shieldItem.price,
      maxQuantity: config.shieldCap, // one-charge cap (Req 3.x / 7.3)
      purchasedThisRun: 0,
    },
    {
      id: 'attack_upgrade',
      effectText: `+${attackUpgrade.effect} Attack damage for this Run`,
      price: attackUpgrade.price,
      maxQuantity: attackUpgrade.purchaseLimit, // 1 per Run (Req 7.8)
      purchasedThisRun: 0,
    },
  ];
}

/**
 * How many of `itemId` the given RunState has already bought this Run. Derived
 * from RunState rather than stored on the ShopItem so it always reflects live
 * state: the shield reads `shieldCharges` (capped at one), the attack upgrade
 * reads the `attackUpgradePurchased` latch, and the potion reads
 * `items.potion`. Used both for display (remaining) and by {@link purchase}'s
 * cap checks.
 *
 * @param {object} runState the active RunState
 * @param {string} itemId one of 'potion' | 'shield' | 'attack_upgrade'
 * @returns {number} count purchased this Run (0 if none / unknown)
 */
export function purchasedCount(runState, itemId) {
  switch (itemId) {
    case 'potion':
      return runState.items ? runState.items.potion : 0;
    case 'shield':
      return runState.shieldCharges;
    case 'attack_upgrade':
      return runState.attackUpgradePurchased ? 1 : 0;
    default:
      return 0;
  }
}

/**
 * Attempt to buy one unit of `itemId` for the given RunState (Req 7.6, 7.7,
 * 7.8, 7.12). This is the economy's only mutation path and its safety barrier.
 *
 * Validation order (all checks happen BEFORE any state change so a rejected
 * purchase leaves Soul_Coins and inventory exactly as they were, Req 7.6):
 *   1. unknown item id      → reject (UNKNOWN_ITEM)
 *   2. per-item cap reached  → reject (SHIELD_AT_CAP / ATTACK_LIMIT_REACHED)
 *   3. can't afford the price → reject (UNAFFORDABLE); never deducts, so
 *      Soul_Coins can never go negative (Req 7.7)
 * Only once all pass does it deduct the price and apply the effect, exactly
 * once (Req 7.12) — the caller invoking this once per confirmed action is what
 * makes "duplicate/repeated input counts as one purchase" hold.
 *
 * The RunState is mutated in place and also returned, matching the other pure
 * systems (scoring, flight) that mutate the committed state they're handed.
 *
 * @param {object} runState the active RunState
 * @param {string} itemId one of 'potion' | 'shield' | 'attack_upgrade'
 * @param {object} config the frozen CONFIG
 * @returns {{ runState: object, ok: boolean, reason: (string|null) }}
 */
export function purchase(runState, itemId, config) {
  const item = shopInventory(config).find((i) => i.id === itemId);

  // 1. Unknown item — nothing to do, nothing changed.
  if (!item) {
    return { runState, ok: false, reason: PurchaseReason.UNKNOWN_ITEM };
  }

  // 2. Per-item per-Run cap (Req 7.8 attack upgrade; one-charge shield cap).
  //    The potion is uncapped (maxQuantity === null) so it is skipped here.
  if (item.maxQuantity != null && purchasedCount(runState, itemId) >= item.maxQuantity) {
    const reason =
      itemId === 'shield'
        ? PurchaseReason.SHIELD_AT_CAP
        : PurchaseReason.ATTACK_LIMIT_REACHED;
    return { runState, ok: false, reason };
  }

  // 3. Affordability (Req 7.6, 7.7). Checked before any deduction so a
  //    rejected purchase leaves Soul_Coins unchanged and the balance never
  //    goes negative.
  if (runState.soulCoins < item.price) {
    return { runState, ok: false, reason: PurchaseReason.UNAFFORDABLE };
  }

  // --- All validations passed: apply exactly one purchase. ---
  runState.soulCoins -= item.price;

  switch (itemId) {
    case 'potion':
      // Stack by exactly one (Req 7.12). Guard against a missing items bag.
      if (!runState.items) runState.items = { potion: 0 };
      runState.items.potion += 1;
      break;
    case 'shield':
      // Respect the single-charge cap; the cap check above already guarantees
      // we're below it, but clamp defensively so we can never exceed it.
      runState.shieldCharges = Math.min(config.shieldCap, runState.shieldCharges + 1);
      break;
    case 'attack_upgrade':
      // Latch the per-Run upgrade and apply its one-time Attack bonus.
      runState.attackUpgradePurchased = true;
      runState.attackDamage += config.shop.attackUpgrade.effect;
      break;
    default:
      break;
  }

  return { runState, ok: true, reason: null };
}

/**
 * Award the configured Soul_Coin reward for winning an ordinary Battle
 * (Req 7.2). Adds `config.ordinaryEnemy.victoryReward` to the Run's Soul_Coins
 * in place. Separate from combat resolution so the reward amount lives with the
 * rest of the economy. Keeps the four currencies independent (Req 7.1): it only
 * touches Soul_Coins, never Candy / Battle_HP / Pipe_Score.
 *
 * The reward (6) is deliberately at least the first useful Shop item's price
 * (the potion, 5) so that at least one useful first-Shop item is affordable
 * from the preceding ordinary Battle (Req 7.9); {@link firstShopAffordable}
 * expresses that guarantee for tests.
 *
 * @param {object} runState the active RunState
 * @param {object} config the frozen CONFIG
 * @returns {object} the same runState, for chaining
 */
export function awardOrdinaryVictory(runState, config) {
  runState.soulCoins += config.ordinaryEnemy.victoryReward;
  return runState;
}

/**
 * Whether at least one useful Shop item is affordable using only the Soul_Coins
 * earned from a single preceding ordinary Battle victory (Req 7.9). "Useful"
 * excludes nothing in the base shop — all three items are useful — but the
 * guarantee only needs ONE to be affordable from one victory reward. Returns
 * true iff the ordinary victory reward covers the cheapest item's price.
 *
 * This is a pure predicate over config (no RunState needed) so the balance
 * guarantee can be asserted directly in tests and is stable across runs.
 *
 * @param {object} config the frozen CONFIG
 * @returns {boolean}
 */
export function firstShopAffordable(config) {
  const reward = config.ordinaryEnemy.victoryReward;
  const cheapest = Math.min(...shopInventory(config).map((i) => i.price));
  return reward >= cheapest;
}

export default { shopInventory, purchase, awardOrdinaryVictory, firstShopAffordable, purchasedCount, PurchaseReason };
