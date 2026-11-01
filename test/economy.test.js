// test/economy.test.js — tests for the in-run shop economy (systems/economy.js).
//
// Pure logic, no DOM. Covers:
//   - Property 21: Purchases are safe — across any sequence of purchase
//     attempts against any Run state, Soul_Coins never goes negative, an
//     unaffordable purchase is rejected leaving Soul_Coins and inventory
//     unchanged, at most one purchase per confirmed action (one purchase() call
//     == one confirmed action), a confirmed affordable potion purchase deducts
//     the potion price and increments items.potion by exactly one, and the
//     attack upgrade never exceeds its per-Run limit.
//     Validates: Requirements 7.6, 7.7, 7.8, 7.12
//   - Unit tests for shopInventory shape (Req 7.3), the shield one-charge cap,
//     the ordinary-victory reward (Req 7.2), and first-shop affordability
//     (Req 7.9).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { createRunState } from '../src/state.js';
import {
  shopInventory,
  purchase,
  awardOrdinaryVictory,
  firstShopAffordable,
  PurchaseReason,
} from '../src/systems/economy.js';
import { fc, assertProperty, propertyName } from '../test-support/helpers.js';

const ITEM_IDS = ['potion', 'shield', 'attack_upgrade'];

// --- Unit tests -------------------------------------------------------------

test('shopInventory stocks potion, shield, and attack upgrade with config prices (Req 7.3)', () => {
  const items = shopInventory(CONFIG);
  assert.equal(items.length, 3);

  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.ok(byId.potion && byId.shield && byId.attack_upgrade);

  assert.equal(byId.potion.price, CONFIG.shop.potion.price);
  assert.equal(byId.potion.maxQuantity, null); // uncapped, stacks
  assert.equal(byId.shield.price, CONFIG.shop.shieldItem.price);
  assert.equal(byId.shield.maxQuantity, CONFIG.shieldCap);
  assert.equal(byId.attack_upgrade.price, CONFIG.shop.attackUpgrade.price);
  assert.equal(byId.attack_upgrade.maxQuantity, CONFIG.shop.attackUpgrade.purchaseLimit);

  // Every item exposes the ShopItem data-model fields.
  for (const i of items) {
    assert.equal(typeof i.id, 'string');
    assert.equal(typeof i.effectText, 'string');
    assert.equal(typeof i.price, 'number');
    assert.equal(typeof i.purchasedThisRun, 'number');
  }
});

test('new-run init leaves items.potion at 0 (Req 7.10)', () => {
  const rs = createRunState(CONFIG);
  assert.equal(rs.items.potion, 0);
});

test('buying a potion deducts the price and adds exactly one (Req 7.12)', () => {
  const rs = createRunState(CONFIG);
  rs.soulCoins = CONFIG.shop.potion.price + 3;

  const res = purchase(rs, 'potion', CONFIG);
  assert.equal(res.ok, true);
  assert.equal(res.reason, null);
  assert.equal(rs.items.potion, 1);
  assert.equal(rs.soulCoins, 3);
});

test('unaffordable purchase is rejected, Soul_Coins and inventory unchanged (Req 7.6)', () => {
  const rs = createRunState(CONFIG);
  rs.soulCoins = CONFIG.shop.potion.price - 1;

  const res = purchase(rs, 'potion', CONFIG);
  assert.equal(res.ok, false);
  assert.equal(res.reason, PurchaseReason.UNAFFORDABLE);
  assert.equal(rs.items.potion, 0);
  assert.equal(rs.soulCoins, CONFIG.shop.potion.price - 1);
});

test('shield respects the one-charge cap (Req 7.3)', () => {
  const rs = createRunState(CONFIG);
  rs.soulCoins = CONFIG.shop.shieldItem.price * 3;

  const first = purchase(rs, 'shield', CONFIG);
  assert.equal(first.ok, true);
  assert.equal(rs.shieldCharges, CONFIG.shieldCap);

  const coinsAfterFirst = rs.soulCoins;
  const second = purchase(rs, 'shield', CONFIG);
  assert.equal(second.ok, false);
  assert.equal(second.reason, PurchaseReason.SHIELD_AT_CAP);
  assert.equal(rs.shieldCharges, CONFIG.shieldCap); // still capped
  assert.equal(rs.soulCoins, coinsAfterFirst); // no deduction on reject
});

test('attack upgrade is limited to the configured per-run limit (Req 7.8)', () => {
  const rs = createRunState(CONFIG);
  rs.soulCoins = CONFIG.shop.attackUpgrade.price * 3;
  const baseAttack = rs.attackDamage;

  const first = purchase(rs, 'attack_upgrade', CONFIG);
  assert.equal(first.ok, true);
  assert.equal(rs.attackUpgradePurchased, true);
  assert.equal(rs.attackDamage, baseAttack + CONFIG.shop.attackUpgrade.effect);

  const coinsAfterFirst = rs.soulCoins;
  const second = purchase(rs, 'attack_upgrade', CONFIG);
  assert.equal(second.ok, false);
  assert.equal(second.reason, PurchaseReason.ATTACK_LIMIT_REACHED);
  assert.equal(rs.attackDamage, baseAttack + CONFIG.shop.attackUpgrade.effect); // no double bonus
  assert.equal(rs.soulCoins, coinsAfterFirst);
});

test('ordinary victory awards the configured Soul_Coin reward (Req 7.2)', () => {
  const rs = createRunState(CONFIG);
  awardOrdinaryVictory(rs, CONFIG);
  assert.equal(rs.soulCoins, CONFIG.ordinaryEnemy.victoryReward);
});

test('at least one useful first-shop item is affordable from an ordinary victory (Req 7.9)', () => {
  assert.equal(firstShopAffordable(CONFIG), true);

  // Concretely: after one ordinary victory, at least one item can be bought.
  const rs = createRunState(CONFIG);
  awardOrdinaryVictory(rs, CONFIG);
  const affordable = shopInventory(CONFIG).filter((i) => i.price <= rs.soulCoins);
  assert.ok(affordable.length >= 1);
});

// --- Property 21: Purchases are safe ----------------------------------------

test(propertyName(21, 'Purchases are safe'), () => {
  assertProperty(
    fc.property(
      // A starting Soul_Coins balance.
      fc.integer({ min: 0, max: 200 }),
      // Starting shield charges (0 or already at cap) and attack-upgrade latch.
      fc.integer({ min: 0, max: CONFIG.shieldCap }),
      fc.boolean(),
      fc.integer({ min: 0, max: 10 }), // starting potion count
      // A sequence of purchase attempts (each entry is one confirmed action).
      fc.array(fc.constantFrom(...ITEM_IDS, 'bogus'), { minLength: 0, maxLength: 60 }),
      (startCoins, startShield, startAttack, startPotion, attempts) => {
        const rs = createRunState(CONFIG);
        rs.soulCoins = startCoins;
        rs.shieldCharges = startShield;
        rs.attackUpgradePurchased = startAttack;
        rs.items.potion = startPotion;

        let attackPurchases = startAttack ? 1 : 0;

        for (const itemId of attempts) {
          const before = {
            coins: rs.soulCoins,
            potion: rs.items.potion,
            shield: rs.shieldCharges,
            attackPurchased: rs.attackUpgradePurchased,
            attackDamage: rs.attackDamage,
          };

          const res = purchase(rs, itemId, CONFIG);

          // (a) Soul_Coins never goes negative.
          if (rs.soulCoins < 0) return false;

          if (res.ok) {
            const item = shopInventory(CONFIG).find((i) => i.id === itemId);
            // A successful purchase deducts exactly the item price.
            if (rs.soulCoins !== before.coins - item.price) return false;

            if (itemId === 'potion') {
              // Exactly +1 potion, nothing else moved.
              if (rs.items.potion !== before.potion + 1) return false;
              if (rs.shieldCharges !== before.shield) return false;
            } else if (itemId === 'shield') {
              // +1 charge but never above the cap.
              if (rs.shieldCharges !== before.shield + 1) return false;
              if (rs.shieldCharges > CONFIG.shieldCap) return false;
              if (rs.items.potion !== before.potion) return false;
            } else if (itemId === 'attack_upgrade') {
              attackPurchases += 1;
              if (rs.attackUpgradePurchased !== true) return false;
              if (rs.attackDamage !== before.attackDamage + CONFIG.shop.attackUpgrade.effect) {
                return false;
              }
            }
          } else {
            // (b) A rejected purchase leaves Soul_Coins AND inventory unchanged.
            if (rs.soulCoins !== before.coins) return false;
            if (rs.items.potion !== before.potion) return false;
            if (rs.shieldCharges !== before.shield) return false;
            if (rs.attackUpgradePurchased !== before.attackPurchased) return false;
            if (rs.attackDamage !== before.attackDamage) return false;
          }

          // (c) Attack upgrade never exceeds its per-Run limit.
          if (attackPurchases > CONFIG.shop.attackUpgrade.purchaseLimit) return false;
          // Shield never exceeds its cap at any point.
          if (rs.shieldCharges > CONFIG.shieldCap) return false;
        }

        return true;
      },
    ),
  );
});
