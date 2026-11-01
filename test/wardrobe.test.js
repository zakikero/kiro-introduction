// test/wardrobe.test.js — tests for the Wardrobe hat logic (src/ui/wardrobe.js).
//
// Pure logic, no DOM: only the buy/equip/unequip/catalog helpers are exercised;
// drawWardrobe needs a Canvas and is not called here.
//
// Covers:
//   - The catalog offers the four Hats at configured Candy prices plus the free
//     no-hat default (Req 8.8).
//   - Buying a duplicate is rejected with Candy unchanged (Req 8.10).
//   - Buying without enough Candy is rejected with Candy AND ownership
//     unchanged, and Candy never goes negative (Req 8.12).
//   - A successful buy deducts exactly the configured price and adds ownership.
//   - Equipping/unequipping owned Hats is free; equipping an unowned Hat is
//     rejected (Req 8.11).
//   - A buy/equip safety property across arbitrary action sequences.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG } from "../src/config.js";
import { defaultSave, NONE_HAT } from "../src/save.js";
import {
  hatCatalog,
  buyHat,
  equipHat,
  unequipHat,
  HatReason,
} from "../src/ui/wardrobe.js";
import { fc, assertProperty } from "../test-support/helpers.js";

const HAT_IDS = Object.keys(CONFIG.hats); // witchHat, pumpkinCap, batBonnet, hauntedCrown

// --- Unit tests -------------------------------------------------------------

test("hatCatalog offers the four Hats at config prices plus the free default (Req 8.8)", () => {
  const save = defaultSave(CONFIG);
  const rows = hatCatalog(save, CONFIG);

  // Free default first, then the four Hats.
  assert.equal(rows.length, HAT_IDS.length + 1);
  assert.equal(rows[0].id, NONE_HAT);
  assert.equal(rows[0].free, true);
  assert.equal(rows[0].price, 0);

  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const id of HAT_IDS) {
    assert.ok(byId[id], `catalog should contain ${id}`);
    assert.equal(byId[id].price, CONFIG.hats[id]);
    assert.equal(byId[id].free, false);
  }

  // The four expected display names are present.
  const names = rows.map((r) => r.name);
  for (const expected of [
    "Witch Hat",
    "Pumpkin Cap",
    "Bat Bonnet",
    "Haunted Crown",
  ]) {
    assert.ok(names.includes(expected), `missing name ${expected}`);
  }
});

test("buying a hat deducts exactly the price and adds ownership (Req 8.8)", () => {
  const save = defaultSave(CONFIG);
  save.candy = CONFIG.hats.witchHat + 2;

  const res = buyHat(save, "witchHat", CONFIG);
  assert.equal(res.ok, true);
  assert.equal(res.reason, null);
  assert.equal(save.candy, 2);
  assert.ok(save.ownedHats.includes("witchHat"));
  // Buying does not auto-equip.
  assert.equal(save.equippedHat, NONE_HAT);
});

test("buying a duplicate is rejected, Candy and ownership unchanged (Req 8.10)", () => {
  const save = defaultSave(CONFIG);
  save.candy = 100;
  buyHat(save, "pumpkinCap", CONFIG);
  const candyAfterFirst = save.candy;
  const ownedAfterFirst = [...save.ownedHats];

  const res = buyHat(save, "pumpkinCap", CONFIG);
  assert.equal(res.ok, false);
  assert.equal(res.reason, HatReason.ALREADY_OWNED);
  assert.equal(save.candy, candyAfterFirst);
  assert.deepEqual(save.ownedHats, ownedAfterFirst);
});

test("buying without enough Candy is rejected, Candy and ownership unchanged (Req 8.12)", () => {
  const save = defaultSave(CONFIG);
  save.candy = CONFIG.hats.hauntedCrown - 1;

  const res = buyHat(save, "hauntedCrown", CONFIG);
  assert.equal(res.ok, false);
  assert.equal(res.reason, HatReason.UNAFFORDABLE);
  assert.equal(save.candy, CONFIG.hats.hauntedCrown - 1);
  assert.ok(!save.ownedHats.includes("hauntedCrown"));
  assert.ok(save.candy >= 0);
});

test("the free no-hat default cannot be bought (Req 8.8)", () => {
  const save = defaultSave(CONFIG);
  save.candy = 100;
  const res = buyHat(save, NONE_HAT, CONFIG);
  assert.equal(res.ok, false);
  assert.equal(res.reason, HatReason.UNKNOWN_HAT);
  assert.equal(save.candy, 100);
});

test("equipping an owned hat is free and updates equippedHat (Req 8.11)", () => {
  const save = defaultSave(CONFIG);
  save.candy = 100;
  buyHat(save, "batBonnet", CONFIG);
  const candyBefore = save.candy;

  const res = equipHat(save, "batBonnet", CONFIG);
  assert.equal(res.ok, true);
  assert.equal(save.equippedHat, "batBonnet");
  assert.equal(save.candy, candyBefore); // no cost
});

test("equipping an unowned hat is rejected, equippedHat unchanged (Req 8.11)", () => {
  const save = defaultSave(CONFIG);
  const res = equipHat(save, "witchHat", CONFIG);
  assert.equal(res.ok, false);
  assert.equal(res.reason, HatReason.NOT_OWNED);
  assert.equal(save.equippedHat, NONE_HAT);
});

test("unequipping returns to the free default at no cost (Req 8.11)", () => {
  const save = defaultSave(CONFIG);
  save.candy = 100;
  buyHat(save, "witchHat", CONFIG);
  equipHat(save, "witchHat", CONFIG);
  assert.equal(save.equippedHat, "witchHat");

  const candyBefore = save.candy;
  const res = unequipHat(save, CONFIG);
  assert.equal(res.ok, true);
  assert.equal(save.equippedHat, NONE_HAT);
  assert.equal(save.candy, candyBefore);
});

test("the free default is always equippable even when nothing is owned (Req 8.11)", () => {
  const save = defaultSave(CONFIG);
  const res = equipHat(save, NONE_HAT, CONFIG);
  assert.equal(res.ok, true);
  assert.equal(save.equippedHat, NONE_HAT);
});

// --- Safety property: buy/equip never corrupt Candy or ownership ------------
//
// Across any sequence of buy/equip/unequip attempts against any Candy balance,
// Candy never goes negative, a rejected buy leaves Candy and ownership
// unchanged, a successful buy deducts exactly the price and adds exactly that
// Hat, every owned Hat is a known Hat (no phantom ownership), and the equipped
// Hat is always owned (or the free default).
//
// Validates: Requirements 8.8, 8.10, 8.11, 8.12

test("buy/equip is safe across arbitrary action sequences (Req 8.8, 8.10, 8.11, 8.12)", () => {
  const actions = [
    ...HAT_IDS.map((id) => ({ kind: "buy", id })),
    ...HAT_IDS.map((id) => ({ kind: "equip", id })),
    { kind: "equip", id: NONE_HAT },
    { kind: "buy", id: NONE_HAT }, // unbuyable
    { kind: "buy", id: "bogus" }, // unknown
    { kind: "equip", id: "bogus" }, // unknown
  ];

  assertProperty(
    fc.property(
      fc.integer({ min: 0, max: 100 }),
      fc.array(fc.constantFrom(...actions), { minLength: 0, maxLength: 60 }),
      (startCandy, sequence) => {
        const save = defaultSave(CONFIG);
        save.candy = startCandy;

        for (const action of sequence) {
          const before = {
            candy: save.candy,
            owned: [...save.ownedHats],
            equipped: save.equippedHat,
          };

          const res =
            action.kind === "buy"
              ? buyHat(save, action.id, CONFIG)
              : equipHat(save, action.id, CONFIG);

          // Candy never goes negative.
          if (save.candy < 0) return false;

          if (action.kind === "buy") {
            if (res.ok) {
              // Deducts exactly the price and adds exactly that hat.
              const price = CONFIG.hats[action.id];
              if (save.candy !== before.candy - price) return false;
              if (!save.ownedHats.includes(action.id)) return false;
              if (save.ownedHats.length !== before.owned.length + 1)
                return false;
              // Buying never changes what is equipped.
              if (save.equippedHat !== before.equipped) return false;
            } else {
              // Rejected buy leaves Candy and ownership unchanged.
              if (save.candy !== before.candy) return false;
              if (save.ownedHats.length !== before.owned.length) return false;
              if (save.equippedHat !== before.equipped) return false;
            }
          } else {
            // equip never costs Candy.
            if (save.candy !== before.candy) return false;
            if (res.ok) {
              if (save.equippedHat !== action.id) return false;
            } else {
              if (save.equippedHat !== before.equipped) return false;
            }
          }

          // Invariants that must always hold after any action:
          // every owned hat is a known hat (no phantom ownership).
          const known = new Set([NONE_HAT, ...HAT_IDS]);
          for (const id of save.ownedHats) {
            if (!known.has(id)) return false;
          }
          // the equipped hat is always owned (or the free default).
          if (
            save.equippedHat !== NONE_HAT &&
            !save.ownedHats.includes(save.equippedHat)
          ) {
            return false;
          }
        }

        return true;
      },
    ),
  );
});
