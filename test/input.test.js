// test/input.test.js â€” held-key debounce (task 1.16, Property 3).
//
// Exercises the PURE core of `src/input.js` (`createInputQueue`) with no DOM.
// Property 3 (Req 1.5): a held Flap_Input key registers at most ONE Normal_Flap
// per discrete key press and requires a key release before another flap can
// register. So the number of registered FLAP intents must equal the number of
// DISCRETE presses â€” i.e. the number of rising edges (upâ†’down, plus the first
// down) in the physical key-state timeline, regardless of how many auto-repeat
// key-downs the browser emits while the key stays held.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createInputQueue, attachInput, isUiIntent, IntentType, DEFAULT_KEY_MAP } from "../src/input.js";
import { fc, assertProperty, propertyName } from "../test-support/helpers.js";

// A physical-key timeline: each sample is the key's state (true = down) at that
// moment. The DOM shell would emit a `keydown` on every sample where the key is
// down (the first press plus every OS auto-repeat), and a single `keyup` when
// it goes back up. `drainHere` samples mark ticks where the simulation drains
// intents mid-sequence, to prove interleaved consumption changes nothing.
const timeline = fc.array(
  fc.record({ down: fc.boolean(), drainHere: fc.boolean() }),
  { minLength: 0, maxLength: 60 },
);

/** Count discrete presses in a boolean down/up timeline: every upâ†’down edge,
 *  plus a leading down (first sample down with no prior state). */
function countDiscretePresses(samples) {
  let presses = 0;
  let prevDown = false;
  for (const s of samples) {
    if (s.down && !prevDown) presses += 1;
    prevDown = s.down;
  }
  return presses;
}

// --- Unit/example tests ------------------------------------------------------

test("input: a steadily held key flaps once until released", () => {
  const q = createInputQueue({ initialScope: "Active_Flight_State" });
  // First down registers; auto-repeat downs do not.
  assert.equal(q.registerKeyDown(IntentType.FLAP), true);
  assert.equal(q.registerKeyDown(IntentType.FLAP), false);
  assert.equal(q.registerKeyDown(IntentType.FLAP), false);
  // Release, then a fresh press registers again.
  q.registerKeyUp(IntentType.FLAP);
  assert.equal(q.registerKeyDown(IntentType.FLAP), true);

  const intents = q.consumeInputIntents();
  const flaps = intents.filter((i) => i.type === IntentType.FLAP);
  assert.equal(flaps.length, 2, "two discrete presses => two flaps");
});

test("input: no key-up means at most one flap no matter how long held", () => {
  const q = createInputQueue({ initialScope: "Active_Flight_State" });
  let enqueued = 0;
  for (let i = 0; i < 50; i += 1) {
    if (q.registerKeyDown(IntentType.FLAP)) enqueued += 1;
  }
  assert.equal(enqueued, 1);
  assert.equal(q.consumeInputIntents().length, 1);
});

test("input: each mouse click in the flight area is one discrete flap", () => {
  const q = createInputQueue({ initialScope: "Active_Flight_State" });
  // Clicks are inherently discrete â€” no debounce latch, one flap per click.
  q.registerClick({ inFlightArea: true });
  q.registerClick({ inFlightArea: true });
  q.registerClick({ inFlightArea: true });
  const flaps = q
    .consumeInputIntents()
    .filter((i) => i.type === IntentType.FLAP);
  assert.equal(flaps.length, 3);
});

// --- Property test -----------------------------------------------------------

test(propertyName(3, "Held-key debounce"), () => {
  assertProperty(
    // Property 3 (Req 1.5): registered Normal_Flaps == number of discrete key
    // presses, for any sequence of physical key down/up transitions (including
    // auto-repeat), and independent of when intents are drained.
    fc.property(timeline, (samples) => {
      const q = createInputQueue({ initialScope: "Active_Flight_State" });
      // Running total of FLAP intents actually delivered to the simulation,
      // accumulated across every (possibly interleaved) drain.
      let consumedFlaps = 0;
      let prevDown = false;

      for (const s of samples) {
        if (s.down) {
          // Every sample the key is down produces a key-down event, exactly as
          // the OS auto-repeat would. The queue must debounce all but the first
          // of a held run.
          q.registerKeyDown(IntentType.FLAP);
        } else if (prevDown) {
          // A downâ†’up transition is a single key release.
          q.registerKeyUp(IntentType.FLAP);
        }
        prevDown = s.down;

        // Interleaved drain mid-stream: whatever is drained now counts toward
        // the total, proving consumption timing does not change the flap count.
        if (s.drainHere) {
          consumedFlaps += q
            .consumeInputIntents()
            .filter((i) => i.type === IntentType.FLAP).length;
        }
      }

      // Drain whatever remains.
      consumedFlaps += q
        .consumeInputIntents()
        .filter((i) => i.type === IntentType.FLAP).length;

      // The debounced core must deliver exactly one flap per discrete press.
      return consumedFlaps === countDiscretePresses(samples);
    }),
  );
});


// --- Key map: five wardrobe selections (prompt §4) --------------------------

test("DEFAULT_KEY_MAP maps Digit1..Digit5 and Numpad1..Numpad5 to UI_SELECT 0..4", () => {
  for (let i = 1; i <= 5; i += 1) {
    const digit = DEFAULT_KEY_MAP[`Digit${i}`];
    const numpad = DEFAULT_KEY_MAP[`Numpad${i}`];
    assert.ok(digit && digit.type === IntentType.UI_SELECT, `Digit${i} is UI_SELECT`);
    assert.equal(digit.index, i - 1, `Digit${i} -> index ${i - 1}`);
    assert.ok(numpad && numpad.type === IntentType.UI_SELECT, `Numpad${i} is UI_SELECT`);
    assert.equal(numpad.index, i - 1, `Numpad${i} -> index ${i - 1}`);
  }
});


// Native DOM controls retain their own keyboard activation while game shortcuts
// remain usable outside editable fields.
function keyboardTarget() {
  const handlers = new Map();
  return {
    addEventListener(type, listener) { handlers.set(type, listener); },
    removeEventListener(type) { handlers.delete(type); },
    fire(type, code, target = { tagName: "DIV" }) {
      const event = { code, target, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; } };
      handlers.get(type)?.(event);
      return event;
    },
  };
}

test("native buttons and editable fields do not enqueue game actions", () => {
  const q = createInputQueue({ initialScope: "Wardrobe" });
  const keys = keyboardTarget();
  const detach = attachInput(q, { keyTarget: keys, now: () => 0 });
  for (const tagName of ["BUTTON", "A", "SUMMARY", "INPUT", "TEXTAREA", "SELECT"]) {
    for (const code of ["Enter", "Space"]) {
      const event = keys.fire("keydown", code, { tagName });
      assert.equal(event.defaultPrevented, false, tagName + " retains native activation");
    }
  }
  for (const target of [{ tagName: "INPUT" }, { tagName: "DIV", isContentEditable: true }]) {
    for (const code of ["Digit1", "KeyU", "KeyP"]) {
      assert.equal(keys.fire("keydown", code, target).defaultPrevented, false);
    }
  }
  assert.deepEqual(q.consumeInputIntents(), []);
  detach();
});

test("shop potion shortcut is a debounced UI action and number shortcuts work on cards", () => {
  const q = createInputQueue({ initialScope: "Shop_State" });
  const keys = keyboardTarget();
  const detach = attachInput(q, { keyTarget: keys, now: () => 0 });
  assert.equal(DEFAULT_KEY_MAP.KeyU, IntentType.UI_USE_POTION);
  assert.equal(isUiIntent(IntentType.UI_USE_POTION), true);
  keys.fire("keydown", "KeyU", { tagName: "BUTTON" });
  keys.fire("keydown", "KeyU", { tagName: "BUTTON" });
  keys.fire("keyup", "KeyU", { tagName: "BUTTON" });
  keys.fire("keydown", "KeyU", { tagName: "BUTTON" });
  keys.fire("keydown", "Digit3", { tagName: "BUTTON" });
  const intents = q.consumeInputIntents();
  assert.equal(intents.filter(i => i.type === IntentType.UI_USE_POTION).length, 2);
  assert.equal(intents.find(i => i.type === IntentType.UI_SELECT).index, 2);
  assert.equal(intents.some(i => i.type === IntentType.FLAP), false);
  detach();
});

test("releasing a gameplay key after focus moves to a button clears its held latch", () => {
  const q = createInputQueue({ initialScope: "Active_Flight_State" });
  const keys = keyboardTarget();
  const detach = attachInput(q, { keyTarget: keys, now: () => 0 });
  keys.fire("keydown", "Space");
  keys.fire("keyup", "Space", { tagName: "BUTTON" });
  keys.fire("keydown", "Space");
  assert.equal(q.consumeInputIntents().filter(i => i.type === IntentType.FLAP).length, 2);
  detach();
});
