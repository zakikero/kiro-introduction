// test/hud-feedback.test.js — unit + property tests for the task 6.2 HUD and
// feedback presentation helpers (Req 12.2, 12.6, 12.7).
//
// These exercise ONLY the pure, DOM-free helpers:
//   - ui/feedback.js: the transient feedback buffer (push / active / age-out),
//   - ui/hud.js: resourceRows (distinct Score / Soul_Coins / Candy readouts)
//     and hoverReadiness.
// The draw functions themselves need a Canvas and are not called here; they are
// thin paints of these models (consistent with results.test.js / battle-shop-ui).

import { test } from "node:test";
import assert from "node:assert/strict";

import { fc, assertProperty } from "../test-support/helpers.js";
import { CONFIG } from "../src/config.js";
import {
  createFeedbackBuffer,
  pushFeedback,
  activeFeedback,
  FeedbackKind,
} from "../src/ui/feedback.js";
import { resourceRows, hoverReadiness } from "../src/ui/hud.js";

// --- ui/feedback.js ---------------------------------------------------------

test("pushFeedback records a cue with an icon and severity (Req 12.2, 12.7)", () => {
  const buf = createFeedbackBuffer();
  pushFeedback(buf, FeedbackKind.SCORE, "Score 3", 0);
  assert.equal(buf.events.length, 1);
  const e = buf.events[0];
  assert.equal(e.kind, FeedbackKind.SCORE);
  assert.equal(e.message, "Score 3");
  // Icon + severity give info beyond color alone (Req 12.7).
  assert.ok(typeof e.icon === "string" && e.icon.length > 0);
  assert.ok(typeof e.severity === "string" && e.severity.length > 0);
});

test("activeFeedback returns live cues newest-first and ages them out (Req 12.2)", () => {
  const buf = createFeedbackBuffer();
  pushFeedback(buf, FeedbackKind.FLAP, "Flap", 0, { ttl: 1 });
  pushFeedback(buf, FeedbackKind.SCORE, "Score 1", 0.5, { ttl: 1 });

  // At t=0.6 both are live; the newer (Score, start 0.5) comes first.
  const live = activeFeedback(buf, 0.6);
  assert.equal(live.length, 2);
  assert.equal(live[0].message, "Score 1");
  assert.equal(live[1].message, "Flap");

  // After both expire, nothing is live and the buffer is pruned.
  const none = activeFeedback(buf, 5);
  assert.equal(none.length, 0);
  assert.equal(buf.events.length, 0);
});

test("activeFeedback fade decays from 1 at birth toward 0 at expiry", () => {
  const buf = createFeedbackBuffer();
  pushFeedback(buf, FeedbackKind.REWARD, "Victory!", 0, { ttl: 2 });
  const atBirth = activeFeedback(buf, 0)[0];
  const halfway = activeFeedback(buf, 1)[0];
  assert.ok(atBirth.fade > halfway.fade);
  assert.ok(halfway.fade >= 0 && halfway.fade <= 1);
});

test("pushFeedback never throws on a garbage kind and degrades to a neutral cue", () => {
  const buf = createFeedbackBuffer();
  pushFeedback(buf, "not-a-kind", "x", 0);
  assert.equal(buf.events.length, 1);
  assert.ok(buf.events[0].icon.length > 0);
});

test("Feature: flappy-kiro, Property: the feedback buffer stays bounded under heavy pushing", () => {
  // No matter how many cues are pushed, the buffer never grows without bound
  // and activeFeedback always returns at most the requested live limit.
  assertProperty(
    fc.property(
      fc.array(
        fc.record({
          kind: fc.constantFrom(...Object.values(FeedbackKind)),
          msg: fc.string(),
          t: fc.double({ min: 0, max: 100, noNaN: true }),
        }),
        { minLength: 0, maxLength: 200 },
      ),
      (pushes) => {
        const buf = createFeedbackBuffer();
        let maxT = 0;
        for (const p of pushes) {
          pushFeedback(buf, p.kind, p.msg, p.t);
          if (p.t > maxT) maxT = p.t;
        }
        // Bounded retention.
        assert.ok(buf.events.length <= 8);
        // Live count honors the limit and never exceeds retained events.
        const live = activeFeedback(buf, maxT, 4);
        assert.ok(live.length <= 4);
        assert.ok(live.length <= buf.events.length);
        // Every live fade is a valid 0..1 fraction.
        for (const e of live) {
          assert.ok(e.fade >= 0 && e.fade <= 1);
        }
      },
    ),
  );
});

// --- ui/hud.js --------------------------------------------------------------

test("resourceRows shows Score and Soul Coins distinctly, and Candy only with a save (Req 12.6)", () => {
  const rs = { pipeScore: 7, soulCoins: 12 };

  const withoutSave = resourceRows(rs, null);
  assert.deepEqual(
    withoutSave.map((r) => r.id),
    ["score", "soulCoins"],
  );
  assert.equal(withoutSave[0].value, 7);
  assert.equal(withoutSave[1].value, 12);
  // Each row carries a distinct label, icon, and color so the three pools are
  // never conflated (info by text/icon, not color alone — Req 12.7).
  for (const row of withoutSave) {
    assert.ok(row.label.length > 0);
    assert.ok(row.icon.length > 0);
    assert.ok(row.color.length > 0);
  }

  const withSave = resourceRows(rs, { candy: 42 });
  const candyRow = withSave.find((r) => r.id === "candy");
  assert.ok(candyRow, "Candy row present when a save is supplied");
  assert.equal(candyRow.value, 42);
  // The three readouts use three distinct colors (Score vs Coins vs Candy).
  const colors = new Set(withSave.map((r) => r.color));
  assert.equal(colors.size, 3);
});

test("resourceRows degrades garbage values to 0 (never NaN/negative)", () => {
  const rows = resourceRows(
    { pipeScore: NaN, soulCoins: -5 },
    { candy: "oops" },
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.value]));
  assert.equal(byId.score, 0);
  assert.equal(byId.soulCoins, 0);
  assert.equal(byId.candy, 0);
});

test("hoverReadiness is null without a power-providing spirit and reports recharge otherwise (Req 1.7)", () => {
  assert.equal(hoverReadiness({ equippedSpirit: "none" }, CONFIG), null);

  const ready = hoverReadiness(
    { equippedSpirit: "storm_bat", hoverCooldown: 0 },
    CONFIG,
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.fraction, 1);

  const half = hoverReadiness(
    { equippedSpirit: "storm_bat", hoverCooldown: CONFIG.hover.cooldown / 2 },
    CONFIG,
  );
  assert.equal(half.ready, false);
  assert.ok(half.fraction > 0 && half.fraction < 1);
});
