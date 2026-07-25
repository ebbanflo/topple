// Pure tests for the relic registry and relic-aware scoring. No browser.
// A relic that silently scores wrong is invisible in play and obvious here,
// which is the whole reason both modules are pure functions.

import { test, expect } from '@playwright/test';
import { scoreBreakdown, scoreWord, wordPoints } from '../js/decree.js';
import {
  RELICS, RELIC_IDS, MAX_RELICS, dealRelics, grants, hungerFor, heldRelics,
} from '../js/relics.js';
import { mulberry32 } from '../js/rng.js';
import { TOWER } from '../js/config.js';

test.describe('relics', () => {
  test('with no relics held, scoring is EXACTLY the classic formula', () => {
    // The regression that motivated merging the two implementations: an
    // independent relic-aware copy of this formula disagreed with wordPoints by
    // ten points at stage 3 combo 9, purely because floating-point
    // multiplication is not associative.
    for (const w of ['crane', 'puppy', 'jazzy', 'xylem', 'abaci', 'quilt']) {
      for (let stage = 1; stage <= 8; stage++) {
        for (let combo = 0; combo <= 25; combo++) {
          expect(scoreWord(w, { stage, combo })).toBe(wordPoints(w, stage, combo));
        }
      }
    }
  });

  test('every relic in the registry is well formed', () => {
    for (const [id, r] of Object.entries(RELICS)) {
      expect(r.name, id).toBeTruthy();
      expect(r.desc, id).toBeTruthy();
      expect(['common', 'uncommon', 'rare'], id).toContain(r.rarity);
      expect(r.price, id).toBeGreaterThan(0);
      // it must actually DO something: score, or override a rule
      const doesSomething = !!(r.stone || r.stoneMul || r.mult || r.xmult
        || r.freeMiss || r.allowDuplicate || r.forcePlace || r.insures || r.hungerDelta);
      expect(doesSomething, `${id} does nothing`).toBe(true);
      // rarer costs more, roughly
      if (r.rarity === 'rare') expect(r.price, id).toBeGreaterThanOrEqual(8);
    }
    expect(RELIC_IDS.length).toBeGreaterThanOrEqual(12);
  });

  test('stone relics add to the word, mult relics multiply the run', () => {
    const base = scoreBreakdown('crane', { stage: 1, combo: 1 });
    // CRANE has two vowels
    const tithe = scoreBreakdown('crane', { stage: 1, combo: 1, relics: ['vowel_tithe'] });
    expect(tithe.stone).toBe(base.stone + 80);
    expect(tithe.mult).toBe(base.mult); // stone relics must not touch mult

    // PUPPY has a repeated letter, CRANE does not
    const helixOn = scoreBreakdown('puppy', { stage: 2, combo: 0, relics: ['double_helix'] });
    const helixOff = scoreBreakdown('crane', { stage: 2, combo: 0, relics: ['double_helix'] });
    expect(helixOn.mult).toBeCloseTo(3, 5);   // 2 x 1.5
    expect(helixOff.mult).toBeCloseTo(2, 5);  // unchanged
  });

  test('conditional relics only fire when their condition holds', () => {
    const fast = scoreBreakdown('crane', { stage: 1, combo: 0, relics: ['metronome'], sinceLastMs: 1200 });
    const slow = scoreBreakdown('crane', { stage: 1, combo: 0, relics: ['metronome'], sinceLastMs: 9000 });
    expect(fast.points).toBeGreaterThan(slow.points);
    expect(slow.points).toBe(scoreWord('crane', { stage: 1, combo: 0 }));

    // CHORUS needs more than one living player AND all of them to have placed
    const solo = scoreBreakdown('crane', { stage: 1, combo: 0, relics: ['chorus'], livingCount: 1, placedCount: 1 });
    const partial = scoreBreakdown('crane', { stage: 1, combo: 0, relics: ['chorus'], livingCount: 3, placedCount: 2 });
    const full = scoreBreakdown('crane', { stage: 1, combo: 0, relics: ['chorus'], livingCount: 3, placedCount: 3 });
    expect(solo.points).toBe(partial.points);
    expect(full.points).toBe(partial.points * 2);
  });

  test('relics stack, and the tradeoffs really do trade', () => {
    const plain = scoreBreakdown('puppy', { stage: 2, combo: 5 });
    const greedy = scoreBreakdown('puppy', { stage: 2, combo: 5, relics: ['greed', 'double_helix'] });
    expect(greedy.points).toBeGreaterThan(plain.points * 2); // 1.5 x 1.5

    // PATIENCE pays for its extra time in stone
    const patient = scoreBreakdown('crane', { stage: 1, combo: 0, relics: ['patience'] });
    expect(patient.stone).toBe(Math.round(scoreBreakdown('crane', { stage: 1, combo: 0 }).stone * 0.8));
  });

  test('the hunger clock bends to EVERY player\'s relics, and has a floor', () => {
    const base = TOWER.hungerMs;
    expect(hungerFor(base, { a: [], b: [] })).toBe(base);
    expect(hungerFor(base, { a: ['greed'] })).toBe(base - 10000);
    expect(hungerFor(base, { a: ['patience'] })).toBe(base + 12000);
    // one player's GREED starves everyone, including the teammate holding PATIENCE
    expect(hungerFor(base, { a: ['greed'], b: ['patience'] })).toBe(base + 2000);
    // a stack of GREED can never reach zero
    expect(hungerFor(base, { a: ['greed'], b: ['greed'], c: ['greed'], d: ['greed'] }))
      .toBeGreaterThanOrEqual(6000);
  });

  test('rule-override flags are readable off a held list', () => {
    expect(grants(['keystone'], 'allowDuplicate')).toBe(true);
    expect(grants(['greed'], 'allowDuplicate')).toBe(false);
    expect(grants(['scaffold', 'greed'], 'freeMiss')).toBe(true);
    expect(grants([], 'insures')).toBe(false);
    // an unknown id from a stale client is dropped, never thrown on
    expect(() => grants(['no_such_relic'], 'insures')).not.toThrow();
    expect(heldRelics(['no_such_relic', 'greed'])).toHaveLength(1);
    expect(scoreWord('crane', { stage: 1, combo: 1, relics: ['no_such_relic'] }))
      .toBe(wordPoints('crane', 1, 1));
  });

  test('the shop never offers you something you already hold', () => {
    const rng = mulberry32(42);
    const owned = ['greed', 'keystone', 'patience'];
    for (let i = 0; i < 50; i++) {
      const deal = dealRelics(owned, 3, rng);
      expect(deal).toHaveLength(3);
      expect(new Set(deal).size).toBe(3);       // no duplicates within a deal
      for (const id of deal) expect(owned).not.toContain(id);
    }
    // and it degrades gracefully rather than looping forever when nearly empty
    const nearlyAll = RELIC_IDS.slice(0, RELIC_IDS.length - 1);
    expect(dealRelics(nearlyAll, 3, rng)).toHaveLength(1);
    expect(dealRelics(RELIC_IDS, 3, rng)).toHaveLength(0);
  });

  test('a seeded shop deals the same relics to everyone', () => {
    const a = dealRelics([], 3, mulberry32(7));
    const b = dealRelics([], 3, mulberry32(7));
    const c = dealRelics([], 3, mulberry32(8));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  test('MAX_RELICS is small enough that a build is a choice', () => {
    expect(MAX_RELICS).toBeLessThan(RELIC_IDS.length);
  });
});
