// test/audio.test.js — headless graceful-degradation checks for audio.js
// (prompt §7). No Web Audio / HTMLAudio exists under node, so every entry
// point must be a safe no-op that NEVER throws and never blocks the game.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  playSfx,
  setMuted,
  isMuted,
  startMusic,
  stopMusic,
  isMusicWanted,
  initAudio,
} from "../src/audio.js";

test("playSfx never throws for known or unknown cues (headless)", () => {
  assert.doesNotThrow(() => playSfx("jump"));
  assert.doesNotThrow(() => playSfx("score"));
  assert.doesNotThrow(() => playSfx("shield_break"));
  assert.doesNotThrow(() => playSfx("battle_hit"));
  assert.doesNotThrow(() => playSfx("victory"));
  assert.doesNotThrow(() => playSfx("not-a-real-cue"));
  assert.doesNotThrow(() => playSfx(undefined));
});

test("setMuted reflects the mute state and reconciling music never throws", () => {
  setMuted(true);
  assert.equal(isMuted(), true);
  setMuted(false);
  assert.equal(isMuted(), false);
});

test("startMusic / stopMusic set the wanted flag and never throw headlessly", () => {
  stopMusic();
  assert.equal(isMusicWanted(), false);
  startMusic();
  assert.equal(isMusicWanted(), true, "music is wanted after startMusic");
  // Muting while wanted must not throw and keeps the wanted flag.
  assert.doesNotThrow(() => setMuted(true));
  assert.equal(isMusicWanted(), true);
  setMuted(false);
  stopMusic();
  assert.equal(isMusicWanted(), false);
});

test("initAudio tolerates missing/garbage prefs without throwing", () => {
  assert.doesNotThrow(() => initAudio(undefined));
  assert.doesNotThrow(() => initAudio({ muted: true }));
  assert.doesNotThrow(() => initAudio(null));
  setMuted(false); // reset shared state for other suites
});
