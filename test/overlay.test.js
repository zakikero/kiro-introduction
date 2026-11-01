import { test } from "node:test";
import assert from "node:assert/strict";
import { createOverlay } from "../src/ui/overlay.js";
import { States } from "../src/state.js";
import { CONFIG } from "../src/config.js";
import { defaultSave } from "../src/save.js";
import { buyHat, equipHat } from "../src/ui/wardrobe.js";
import { purchase } from "../src/systems/economy.js";
import { usePotion } from "../src/systems/combat.js";
import { createTestDocument, isVisible } from "../test-support/dom.js";

function fixture(t, state = States.Wardrobe, candy = 20) {
  const previous = globalThis.document;
  const document = createTestDocument();
  globalThis.document = document;
  const root = document.createElement("div");
  document.body.appendChild(root);
  const save = defaultSave(CONFIG);
  save.candy = candy;
  const fsm = {
    state,
    runState: {
      soulCoins: 20,
      battleHp: 10,
      maxBattleHp: CONFIG.combat.startingBattleHp,
      attackDamage: CONFIG.combat.playerBaseAttack,
      shieldCharges: 0,
      attackUpgradePurchased: false,
      items: { potion: 0 },
    },
  };
  const calls = { bought: [], equipped: [], purchased: [], usedPotion: 0 };
  const actions = {
    startRun: () => { fsm.state = States.Active_Flight_State; },
    openWardrobe: () => { fsm.state = States.Wardrobe; },
    leaveWardrobe: () => { fsm.state = States.Main_Menu_State; },
    buyHat: (id) => { calls.bought.push(id); return buyHat(save, id, CONFIG).ok; },
    equipHat: (id) => { calls.equipped.push(id); return equipHat(save, id, CONFIG).ok; },
    buyItem: (id) => { calls.purchased.push(id); return purchase(fsm.runState, id, CONFIG).ok; },
    usePotion: () => {
      calls.usedPotion += 1;
      const result = usePotion(fsm.runState, null, CONFIG);
      if (result.ok) fsm.runState = result.runState;
      return result.ok;
    },
    leaveShop: () => { fsm.state = States.Resume_Countdown_State; },
    resume() {}, endRun() {}, restart() {}, toMainMenu() {},
    exportProgress() {}, importProgress() {}, setMuted() {}, setReducedMotion() {}, toggleFullscreen() {},
  };
  const overlay = createOverlay({ root, fsm, config: CONFIG, getSave: () => save, actions });
  t.after(() => {
    overlay.destroy();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  overlay.sync();
  return { document, root, save, fsm, calls, overlay };
}

function button(root, name) {
  const found = root.querySelectorAll("button").find((node) => isVisible(node) && (typeof name === "string" ? node.textContent === name : name.test(node.textContent)));
  assert.ok(found, "Visible button not found: " + name);
  return found;
}

test("overlay: repeated frame sync preserves wardrobe pointer targets and keyboard focus", (t) => {
  const { root, document, save, calls, overlay } = fixture(t);
  const card = root.querySelector('[data-hat="witchHat"]');
  card.focus();
  card.dispatchEvent({ type: "pointerdown", bubbles: true });
  for (let frame = 0; frame < 12; frame++) overlay.sync();
  assert.equal(root.querySelector('[data-hat="witchHat"]'), card, "a frame must not replace the node between pointerdown and click");
  assert.equal(document.activeElement, card, "frame updates must not discard keyboard focus");
  card.dispatchEvent({ type: "pointerup", bubbles: true });
  card.click();
  assert.equal(overlay.getWardrobeSelection(), "witchHat");
  const buy = button(root, /^Buy/);
  buy.focus();
  buy.dispatchEvent({ type: "pointerdown", bubbles: true });
  for (let frame = 0; frame < 12; frame++) overlay.sync();
  assert.equal(button(root, /^Buy/), buy);
  assert.equal(document.activeElement, buy);
  buy.dispatchEvent({ type: "pointerup", bubbles: true });
  buy.click();
  assert.deepEqual(calls.bought, ["witchHat"], "the retained pointer target completes one real purchase");
  assert.equal(save.candy, 20 - CONFIG.hats.witchHat);
});

test("overlay: preview, purchase, and equip are separate actions and a hat cannot charge twice", (t) => {
  const { root, save, calls, overlay } = fixture(t);
  root.querySelector('[data-hat="witchHat"]').click();
  assert.equal(overlay.getWardrobeSelection(), "witchHat");
  assert.equal(save.candy, 20);
  assert.equal(save.equippedHat, "none");
  assert.deepEqual(calls.bought, []);
  button(root, /^Buy/).click();
  overlay.sync();
  assert.equal(save.candy, 20 - CONFIG.hats.witchHat);
  assert.ok(save.ownedHats.includes("witchHat"));
  assert.equal(save.equippedHat, "none", "buying does not silently equip");
  assert.deepEqual(calls.bought, ["witchHat"]);
  button(root, /^Equip/).click();
  overlay.sync();
  assert.equal(save.equippedHat, "witchHat");
  assert.equal(save.candy, 20 - CONFIG.hats.witchHat);
  assert.deepEqual(calls.equipped, ["witchHat"]);
  assert.equal(root.querySelectorAll("button").some((node) => isVisible(node) && /^Buy/.test(node.textContent)), false);
});

test("overlay: unaffordable hats remain previewable but cannot spend Candy", (t) => {
  const { root, document, save, calls, overlay } = fixture(t, States.Wardrobe, 0);
  overlay.selectByIndex(4);
  assert.equal(overlay.getWardrobeSelection(), "hauntedCrown");
  assert.equal(document.activeElement, root.querySelector('[data-hat="hauntedCrown"]'), "number selection focuses the previewed card");
  assert.equal(save.candy, 0, "number selection never spends Candy");
  assert.equal(save.equippedHat, "none", "number selection never equips the previewed hat");
  assert.deepEqual(save.ownedHats, ["none"], "number selection never grants ownership");
  const buy = button(root, /^Buy/);
  assert.equal(buy.disabled, true);
  buy.click();
  assert.equal(save.candy, 0);
  assert.deepEqual(calls.bought, []);
  assert.match(root.querySelector(".kiro-wardrobe").textContent, /Need 15 more Candy/i);
});

test("overlay: How to Play and settings stay inside the menu and disappear on start", (t) => {
  const { root, overlay, fsm } = fixture(t, States.Main_Menu_State);
  const menu = root.querySelector(".kiro-menu");
  const howTo = root.querySelector(".kiro-howto");
  assert.ok(menu.contains(howTo), "instructions must not be reparented into the overlay root");
  assert.ok(menu.contains(root.querySelector("#kiro-mute")), "settings remain in their labeled menu section");
  assert.ok(menu.contains(root.querySelector("#kiro-motion")));
  button(root, "How to Play").click();
  assert.equal(isVisible(howTo), true);
  button(root, "Start Adventure").click();
  overlay.sync();
  assert.equal(fsm.state, States.Active_Flight_State);
  assert.equal(isVisible(menu), false);
  assert.equal(isVisible(howTo), false);
  assert.equal(overlay.isActive(), false);
  fsm.state = States.Main_Menu_State;
  overlay.sync();
  assert.equal(howTo.hidden, true, "instructions do not unexpectedly reopen when returning");
});

test("overlay: the shop is visible, keeps targets stable, and routes real purchase/potion/leave actions", (t) => {
  const { root, document, fsm, calls, overlay } = fixture(t, States.Shop_State);
  const shop = root.querySelector(".kiro-shop");
  assert.equal(isVisible(shop), true);
  assert.equal(overlay.isActive(), true);
  const potionCard = root.querySelector('[data-item="potion"]');
  potionCard.click();
  potionCard.focus();
  for (let i = 0; i < 10; i++) overlay.sync();
  assert.equal(root.querySelector('[data-item="potion"]'), potionCard);
  assert.equal(document.activeElement, potionCard);
  const buy = button(root, /^Buy/);
  buy.focus();
  buy.dispatchEvent({ type: "pointerdown", bubbles: true });
  for (let i = 0; i < 10; i++) overlay.sync();
  assert.equal(button(root, /^Buy/), buy);
  assert.equal(document.activeElement, buy);
  buy.dispatchEvent({ type: "pointerup", bubbles: true });
  buy.click();
  overlay.sync();
  assert.deepEqual(calls.purchased, ["potion"]);
  assert.equal(fsm.runState.soulCoins, 20 - CONFIG.shop.potion.price);
  assert.equal(fsm.runState.items.potion, 1);
  assert.equal(button(root, /^Use Potion/i).disabled, false);
  button(root, /^Use Potion/i).click();
  overlay.sync();
  assert.equal(calls.usedPotion, 1);
  assert.equal(fsm.runState.items.potion, 0);
  assert.equal(fsm.runState.battleHp, 20);
  const coinsBeforeSelection = fsm.runState.soulCoins;
  overlay.selectShopByIndex(1);
  assert.equal(document.activeElement, root.querySelector('[data-item="shield"]'), "number selection focuses the selected shop card");
  assert.equal(fsm.runState.soulCoins, coinsBeforeSelection, "number selection never spends Soul Coins");
  assert.equal(fsm.runState.shieldCharges, 0, "selecting the shield does not equip or grant it");
  assert.deepEqual(calls.purchased, ["potion"], "selection does not invoke the purchase callback");
  button(root, /^Buy/).click();
  overlay.sync();
  assert.equal(fsm.runState.shieldCharges, 1);
  assert.equal(button(root, /^Buy/).disabled, true, "shield cap is reflected by the same action control");
  button(root, /^Leave Shop/i).click();
  overlay.sync();
  assert.equal(fsm.state, States.Resume_Countdown_State);
  assert.equal(isVisible(shop), false);
});

test("overlay: wardrobe preview and selection controls occupy separate side-by-side layout regions", (t) => {
  const { root } = fixture(t);
  const layout = root.querySelector(".kiro-wardrobe-layout");
  const preview = root.querySelector("#kiro-wardrobe-preview");
  const options = root.querySelector(".kiro-wardrobe-options");
  assert.ok(layout && preview && options);
  assert.ok(layout.contains(preview));
  assert.ok(layout.contains(options));
  assert.equal(options.contains(preview), false, "the ghost preview is not underneath the selectable cards");
  assert.ok(options.querySelector('[data-hat="none"]'));
});
