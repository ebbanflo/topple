// Pure tests for the boss registry and constraint merging. No browser.

import { test, expect } from '@playwright/test';
import { GUESSES } from '../data/guesses.js';
import { BOSSES, BOSS_IDS, isBossStorey, pickBoss, mergeConstraints } from '../js/bosses.js';
import { matchesConstraint, describeConstraint } from '../js/decree.js';
import { mulberry32 } from '../js/rng.js';
import { ASCENT } from '../js/config.js';

test.describe('boss decrees', () => {
  test('every boss is well formed and actually does something', () => {
    for (const [id, b] of Object.entries(BOSSES)) {
      expect(b.name, id).toBeTruthy();
      expect(b.short, id).toBeTruthy();
      expect(b.desc, id).toBeTruthy();
      const bites = !!(b.constraint || b.check || b.toll || b.solo || b.hungerMul);
      expect(bites, `${id} does nothing`).toBe(true);
    }
    expect(BOSS_IDS.length).toBeGreaterThanOrEqual(5);
  });

  test('boss storeys are every third, plus the finale', () => {
    const hit = [];
    for (let n = 1; n <= ASCENT.storeys; n++) if (isBossStorey(n, ASCENT.storeys)) hit.push(n);
    expect(hit).toEqual([3, 6, 8]);
    expect(isBossStorey(1, 8)).toBe(false);
  });

  test('a run works through fresh bosses before repeating one', () => {
    const rng = mulberry32(3);
    const seen = [];
    for (let i = 0; i < BOSS_IDS.length; i++) {
      const id = pickBoss(seen, rng);
      expect(seen).not.toContain(id);
      seen.push(id);
    }
    expect(new Set(seen).size).toBe(BOSS_IDS.length);
    // once they're exhausted it recycles rather than returning nothing
    expect(BOSS_IDS).toContain(pickBoss(seen, rng));
  });

  test('a boss constraint ANDs with the drafted decree, it does not replace it', () => {
    const drafted = { req: ['t'], vmin: 1 };
    const merged = mergeConstraints(drafted, BOSSES.censor.constraint);
    // both rules survive
    expect(merged.req).toEqual(['t']);
    expect(merged.ban).toEqual(['e']);
    expect(matchesConstraint('total', merged)).toBe(true);
    expect(matchesConstraint('theme', merged)).toBe(false); // has an E
    expect(matchesConstraint('audio', merged)).toBe(false); // no T

    // arrays union rather than overwrite, and vowel bounds take the tighter
    expect(mergeConstraints({ ban: ['a'] }, { ban: ['e'] }).ban).toEqual(['a', 'e']);
    expect(mergeConstraints({ vmin: 1 }, { vmin: 3 }).vmin).toBe(3);
    expect(mergeConstraints({ vmax: 2 }, { vmax: 1 }).vmax).toBe(1);
    // and it survives a null on either side
    expect(mergeConstraints(null, { ban: ['e'] }).ban).toEqual(['e']);
    expect(mergeConstraints({ ban: ['e'] }, null).ban).toEqual(['e']);
  });

  test('THE CENSOR still leaves a real vocabulary to build with', () => {
    // a boss that nobody can satisfy is a crash, not a challenge
    const merged = mergeConstraints({ vmin: 2 }, BOSSES.censor.constraint);
    const n = GUESSES.filter((w) => matchesConstraint(w, merged)).length;
    expect(n).toBeGreaterThan(200);
    expect(describeConstraint(merged)).toContain('FORBIDDEN: E');
  });

  test('THE TWIN counts DISTINCT shared letters, and spares the first floor', () => {
    expect(BOSSES.twin.check('crane', { below: null })).toBeNull(); // nothing to echo yet
    // trace/crane share c,r,a,e = 4
    expect(BOSSES.twin.check('crane', { below: 'trace' })).toMatch(/shares 4/);
    // stalk/crane share a = 1
    expect(BOSSES.twin.check('crane', { below: 'stalk' })).toMatch(/shares 1/);
    // a word sharing exactly two passes
    const below = 'crane';
    const ok = GUESSES.find((w) => BOSSES.twin.check(w, { below }) === null);
    expect(ok).toBeTruthy();
    // repeated letters must not be double-counted: puppy vs pupil shares p,u = 2
    expect(BOSSES.twin.check('puppy', { below: 'pupil' })).toBeNull();
  });

  test('THE TAX bites cheap words and spares expensive ones', () => {
    expect(BOSSES.tax.toll('aeiou')).toBe(true);   // five 1-point letters
    expect(BOSSES.tax.toll('jazzy')).toBe(false);  // j+z+z is plenty
    expect(BOSSES.tax.toll('quilt')).toBe(false);
  });

  test('THE GLUTTON halves the clock and THE SILENCE takes turns', () => {
    expect(BOSSES.glutton.hungerMul).toBe(0.5);
    expect(BOSSES.silence.solo).toBe(true);
    // the two stateful bosses are the reason bosses are not plain constraints
    expect(BOSSES.twin.constraint).toBeUndefined();
    expect(BOSSES.silence.constraint).toBeUndefined();
  });
});
