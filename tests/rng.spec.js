// Pure tests: no browser, no network, no DOM. decree.js takes its randomness as
// an argument rather than reaching for Math.random, so an entire run's decree
// sequence can be generated and compared straight from node.

import { test, expect } from '@playwright/test';
import { GUESSES } from '../data/guesses.js';
import { genConstraint, describeConstraint, matchesConstraint } from '../js/decree.js';
import { mulberry32, hashSeed, dailyKey, dailyNumber } from '../js/rng.js';

// Play out a whole run's worth of decrees, consuming words as a real game would
// so `used` diverges exactly the way it does in play.
function runSequence(seed, stages = 12) {
  const rng = mulberry32(hashSeed(seed));
  const used = new Set();
  const out = [];
  let prev = null;
  for (let stage = 1; stage <= stages; stage++) {
    const c = genConstraint(stage, used, 'ramp', 5, prev, rng);
    out.push(describeConstraint(c));
    prev = c;
    let taken = 0;
    for (const w of GUESSES) {
      if (taken >= 5) break;
      if (!used.has(w) && matchesConstraint(w, c)) { used.add(w); taken += 1; }
    }
  }
  return out;
}

test.describe('seeded runs', () => {
  test('the same seed deals the same tower, every time', () => {
    const a = runSequence('2026-07-25');
    const b = runSequence('2026-07-25');
    expect(a).toEqual(b);
    expect(a).toHaveLength(12);
    // and it is a real sequence, not one rule repeated
    expect(new Set(a).size).toBeGreaterThan(5);
  });

  test('different seeds deal different towers', () => {
    const a = runSequence('2026-07-25');
    const b = runSequence('2026-07-26');
    expect(a).not.toEqual(b);
  });

  test('an unseeded generator still works and still varies', () => {
    // CLASSIC passes no rng at all - the default must remain Math.random
    const used = new Set();
    const seen = new Set();
    for (let i = 0; i < 40; i++) seen.add(describeConstraint(genConstraint(4, used)));
    expect(seen.size).toBeGreaterThan(3);
  });

  test('mulberry32 is a well-behaved generator', () => {
    const r = mulberry32(12345);
    const vals = Array.from({ length: 500 }, r);
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...vals)).toBeLessThan(1);
    expect(new Set(vals).size).toBeGreaterThan(490); // no short cycle
    // identical seeds, identical streams
    expect(Array.from({ length: 20 }, mulberry32(999)))
      .toEqual(Array.from({ length: 20 }, mulberry32(999)));
  });

  test('the daily key is UTC, so a room split across midnight agrees', () => {
    // 23:30 in UTC-5 is already the next UTC day; both players must get it
    const late = new Date(Date.UTC(2026, 6, 25, 4, 30));  // 00:30 EDT / 04:30 UTC
    const early = new Date(Date.UTC(2026, 6, 25, 23, 30));
    expect(dailyKey(late)).toBe('2026-07-25');
    expect(dailyKey(early)).toBe('2026-07-25');
    expect(dailyKey(new Date(Date.UTC(2026, 6, 26, 0, 1)))).toBe('2026-07-26');
    // run numbers are stable and increment by one a day
    expect(dailyNumber(new Date(Date.UTC(2026, 0, 1)))).toBe(1);
    expect(dailyNumber(new Date(Date.UTC(2026, 6, 26))) - dailyNumber(new Date(Date.UTC(2026, 6, 25)))).toBe(1);
  });

  test('a seeded run is still a FAIR run: every decree clears the same floors', () => {
    // seeding must not smuggle past the survivability and recognizability
    // gates that keep generated decrees humane
    const rng = mulberry32(hashSeed(dailyKey(new Date(Date.UTC(2026, 6, 25)))));
    const used = new Set();
    let prev = null;
    for (let stage = 1; stage <= 30; stage++) {
      const c = genConstraint(stage, used, 'ramp', 5, prev, rng);
      let n = 0;
      for (const w of GUESSES) if (!used.has(w) && matchesConstraint(w, c)) n++;
      expect(n).toBeGreaterThanOrEqual(5);
      prev = c;
      let taken = 0;
      for (const w of GUESSES) {
        if (taken >= 5) break;
        if (!used.has(w) && matchesConstraint(w, c)) { used.add(w); taken += 1; }
      }
    }
  });
});
