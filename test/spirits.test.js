// test/spirits.test.js — possession property and example tests.
//
// Task 3.2 — Properties 19 and 20 for src/systems/spirits.js possess().
//
// Property 19 (Req 3.14, 6.11): switching spirits NEVER refills resources.
//   Battle_HP, consumables (items.potion), Shield charges, and every cooldown
//   (hoverCooldown, lightningCooldown, flightPowerCooldown) are left untouched
//   by a possess() call — the ONLY exception is the one-time Pumpkin_Guardian
//   Shield gift, which may add a single charge on its first grant. Existing
//   Shield charges are always retained (never reset).
//
// Property 20 (Req 6.10): the Pumpkin_Guardian Shield gift is once per Run and
//   capped. Across ANY sequence of possess / re-equip / re-acquire calls the
//   gift is granted at most once (the pumpkinShieldGiftUsed latch, once set,
//   stays set) and shieldCharges never exceeds config.shieldCap.
//
// See design.md "Testing Strategy", systems/spirits.js, and state.js
// (createRunState shape).

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { possess, spiritBenefits, SpiritId } from "../src/systems/spirits.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

// Every spirit id possess() accepts, including the 'none' sentinel.
const SPIRIT_IDS = [
  SpiritId.NONE,
  SpiritId.STORM_BAT,
  SpiritId.PUMPKIN_GUARDIAN,
];

// Fields unrelated to possession that must survive every possess() call
// untouched (Property 19). shieldCharges is handled separately because the
// Pumpkin_Guardian gift may legitimately raise it by one.
const RESOURCE_FIELDS = [
  "battleHp",
  "hoverCooldown",
  "lightningCooldown",
  "flightPowerCooldown",
];

/**
 * fast-check generator for an arbitrary-but-plausible RunState loadout: random
 * resource pools, cooldowns, consumables, existing shield charges, latch state,
 * and currently equipped spirit. Only the fields possess() reads or could touch
 * are modelled; that is enough to prove it leaves everything else alone.
 */
const runStateArb = fc.record({
  equippedSpirit: fc.constantFrom(...SPIRIT_IDS),
  shieldCharges: fc.integer({ min: 0, max: CONFIG.shieldCap }),
  pumpkinShieldGiftUsed: fc.boolean(),
  battleHp: fc.integer({ min: 0, max: 99 }),
  hoverCooldown: fc.double({ min: 0, max: 10, noNaN: true }),
  lightningCooldown: fc.integer({ min: 0, max: 10 }),
  flightPowerCooldown: fc.double({ min: 0, max: 10, noNaN: true }),
  items: fc.record({ potion: fc.integer({ min: 0, max: 9 }) }),
});

// --- Unit/example tests ------------------------------------------------------

test("possess does not refill resources when switching between spirits", () => {
  const rs = {
    equippedSpirit: SpiritId.STORM_BAT,
    shieldCharges: 1,
    pumpkinShieldGiftUsed: true,
    battleHp: 7,
    hoverCooldown: 2.5,
    lightningCooldown: 3,
    flightPowerCooldown: 1.25,
    items: { potion: 2 },
  };
  possess(rs, SpiritId.NONE, CONFIG);
  assert.equal(rs.equippedSpirit, SpiritId.NONE);
  assert.equal(rs.battleHp, 7);
  assert.equal(rs.hoverCooldown, 2.5);
  assert.equal(rs.lightningCooldown, 3);
  assert.equal(rs.flightPowerCooldown, 1.25);
  assert.equal(rs.items.potion, 2);
  assert.equal(rs.shieldCharges, 1); // retained, not reset
});

test("Pumpkin_Guardian gift grants exactly one charge the first time and never again", () => {
  const rs = {
    equippedSpirit: SpiritId.NONE,
    shieldCharges: 0,
    pumpkinShieldGiftUsed: false,
    battleHp: 10,
    hoverCooldown: 0,
    lightningCooldown: 0,
    flightPowerCooldown: 0,
    items: { potion: 0 },
  };
  possess(rs, SpiritId.PUMPKIN_GUARDIAN, CONFIG);
  assert.equal(rs.shieldCharges, 1);
  assert.equal(rs.pumpkinShieldGiftUsed, true);

  // Switch away and back: the gift must not re-trigger.
  possess(rs, SpiritId.STORM_BAT, CONFIG);
  possess(rs, SpiritId.PUMPKIN_GUARDIAN, CONFIG);
  assert.equal(rs.shieldCharges, 1);
  assert.ok(rs.shieldCharges <= CONFIG.shieldCap);
});

test("Pumpkin_Guardian gift is capped and does not exceed an existing charge", () => {
  const rs = {
    equippedSpirit: SpiritId.NONE,
    shieldCharges: CONFIG.shieldCap, // already at cap
    pumpkinShieldGiftUsed: false,
    battleHp: 10,
    hoverCooldown: 0,
    lightningCooldown: 0,
    flightPowerCooldown: 0,
    items: { potion: 0 },
  };
  possess(rs, SpiritId.PUMPKIN_GUARDIAN, CONFIG);
  assert.equal(rs.shieldCharges, CONFIG.shieldCap);
  assert.equal(rs.pumpkinShieldGiftUsed, true); // latched even when suppressed
});

test("spiritBenefits names exactly one flight and one combat benefit per Spirit (Req 6.6, 6.7, 6.8)", () => {
  const storm = spiritBenefits(SpiritId.STORM_BAT);
  assert.equal(storm.id, SpiritId.STORM_BAT);
  assert.equal(storm.name, "Storm Bat");
  assert.ok(storm.flight.length > 0); // Hover
  assert.ok(storm.combat.length > 0); // Lightning

  const pumpkin = spiritBenefits(SpiritId.PUMPKIN_GUARDIAN);
  assert.equal(pumpkin.id, SpiritId.PUMPKIN_GUARDIAN);
  assert.equal(pumpkin.name, "Pumpkin Guardian");
  assert.ok(pumpkin.flight.length > 0); // Shield gift
  assert.ok(pumpkin.combat.length > 0); // Fortified Defend

  // Base Ghosty / unknown offer no possession benefits.
  assert.equal(spiritBenefits(SpiritId.NONE), null);
  assert.equal(spiritBenefits("unknown"), null);
});

// --- Property tests ----------------------------------------------------------

// **Validates: Requirements 3.14, 6.11**
test(propertyName(19, "Possession never refills resources"), () => {
  assertProperty(
    fc.property(runStateArb, fc.constantFrom(...SPIRIT_IDS), (rs, spiritId) => {
      // Snapshot the resource pools / cooldowns / consumables before the call.
      const before = {
        battleHp: rs.battleHp,
        hoverCooldown: rs.hoverCooldown,
        lightningCooldown: rs.lightningCooldown,
        flightPowerCooldown: rs.flightPowerCooldown,
        potion: rs.items.potion,
        shieldCharges: rs.shieldCharges,
        giftUsed: rs.pumpkinShieldGiftUsed,
      };

      possess(rs, spiritId, CONFIG);

      // The equipped spirit is replaced outright.
      if (rs.equippedSpirit !== spiritId) return false;

      // No resource pool, cooldown, or consumable is refilled or changed.
      for (const field of RESOURCE_FIELDS) {
        if (rs[field] !== before[field]) return false;
      }
      if (rs.items.potion !== before.potion) return false;

      // Shield charges: the ONLY permitted change is the first Pumpkin_Guardian
      // gift adding at most one charge (and only when the latch was unset and
      // charges were below the cap). Otherwise charges are retained exactly.
      const giftFires =
        spiritId === SpiritId.PUMPKIN_GUARDIAN && !before.giftUsed;
      if (giftFires) {
        const expected = Math.min(CONFIG.shieldCap, before.shieldCharges + 1);
        if (rs.shieldCharges !== expected) return false;
      } else {
        if (rs.shieldCharges !== before.shieldCharges) return false;
      }

      return true;
    }),
  );
});

// **Validates: Requirements 6.10**
test(
  propertyName(20, "Pumpkin_Guardian gift is once per Run and capped"),
  () => {
    assertProperty(
      fc.property(
        runStateArb,
        // An arbitrary sequence of possess calls (switching / re-equipping /
        // re-acquiring spirits in any order).
        fc.array(fc.constantFrom(...SPIRIT_IDS), {
          minLength: 1,
          maxLength: 20,
        }),
        (rs, sequence) => {
          let giftGrants = 0;

          for (const spiritId of sequence) {
            const latchBefore = rs.pumpkinShieldGiftUsed;
            const chargesBefore = rs.shieldCharges;

            possess(rs, spiritId, CONFIG);

            // Count the call as a gift grant whenever it set the latch from
            // false→true (the single moment the gift can ever fire).
            if (!latchBefore && rs.pumpkinShieldGiftUsed) {
              giftGrants += 1;
            }

            // The latch is monotonic: once set it never clears.
            if (latchBefore && !rs.pumpkinShieldGiftUsed) return false;

            // The gift adds at most one charge and never overshoots the cap.
            if (rs.shieldCharges - chargesBefore > 1) return false;
            if (rs.shieldCharges > CONFIG.shieldCap) return false;
          }

          // Across the whole sequence the gift was granted at most once.
          return giftGrants <= 1;
        },
      ),
    );
  },
);
