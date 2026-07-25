import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GUESSES } from '../data/guesses.js';
import {
  matchesConstraint, genConstraint, countPossible, countRecognizable, describeConstraint, wordPoints,
} from '../js/decree.js';
import {
  openPage, hostGame, joinGame, startGame, state, setScore, FAST,
  towerState, usedWords, waitTower, climb, miss,
} from './helpers.js';

const STYLE_CSS_PATH = fileURLToPath(new URL('../css/style.css', import.meta.url));

// find dictionary words satisfying a decree, skipping anything already used
function findWords(constraint, used, n) {
  const out = [];
  const usedSet = new Set(used);
  for (const w of GUESSES) {
    if (!usedSet.has(w) && matchesConstraint(w, constraint)) {
      out.push(w);
      if (out.length === n) break;
    }
  }
  return out;
}
function findNonMatching(constraint, used) {
  const usedSet = new Set(used);
  return GUESSES.find((w) => !usedSet.has(w) && !matchesConstraint(w, constraint));
}

test.describe('topple', () => {
  test('decree generator: every stage is survivable and matching is sound', () => {
    expect(matchesConstraint('crane', { req: ['c', 'e'] })).toBe(true);
    expect(matchesConstraint('crane', { req: ['z'] })).toBe(false);
    expect(matchesConstraint('crane', { reqAt: [{ i: 1, ch: 'r' }] })).toBe(true);
    expect(matchesConstraint('crane', { reqAt: [{ i: 0, ch: 'r' }] })).toBe(false);
    expect(matchesConstraint('crane', { ban: ['z', 'q'] })).toBe(true);
    expect(matchesConstraint('crane', { ban: ['a'] })).toBe(false);
    expect(matchesConstraint('nymph', { ban: ['a', 'e', 'i', 'o', 'u'] })).toBe(true);
    expect(matchesConstraint('level', { bookend: true })).toBe(true);
    expect(matchesConstraint('crane', { bookend: true })).toBe(false);
    expect(matchesConstraint('puppy', { rep: true })).toBe(true);
    expect(matchesConstraint('crane', { rep: true })).toBe(false);
    expect(matchesConstraint('crane', { uniq: true })).toBe(true);
    expect(matchesConstraint('puppy', { uniq: true })).toBe(false);
    expect(matchesConstraint('crane', { vmin: 2 })).toBe(true);
    expect(matchesConstraint('nymph', { vmin: 1 })).toBe(false);
    expect(matchesConstraint('crane', { vmin: 1, vmax: 1 })).toBe(false);
    expect(matchesConstraint('quiet', { dvowel: true })).toBe(true);
    expect(matchesConstraint('crane', { dvowel: true })).toBe(false);

    const used = new Set();
    for (let stage = 1; stage <= 12; stage++) {
      for (let k = 0; k < 5; k++) {
        const c = genConstraint(stage, used);
        expect(countPossible(c, used)).toBeGreaterThanOrEqual(4);
      }
    }
    // RPG numbers scale with stage and combo
    expect(wordPoints('crane', 2, 1)).toBeGreaterThan(wordPoints('crane', 1, 1));
    expect(wordPoints('crane', 1, 5)).toBeGreaterThan(wordPoints('crane', 1, 1));
  });

  test('solo climb: decree, stage ramp, misses cost lives, the tower falls', async ({ context }) => {
    test.setTimeout(90000);
    const host = await openPage(context);
    await hostGame(host, 'MASON', { ...FAST, rampWords: 2, hungerMs: 600000 });
    // solo is a legitimate run
    await expect(host.locator('#btn-start')).toBeEnabled();
    await host.click('#btn-start');
    await waitTower(host);

    let t = await towerState(host);
    expect(t.stage).toBe(1);
    expect(t.height).toBe(0);
    const hostId = await host.evaluate(() => window.__topple.selfId);
    expect(t.lives[hostId]).toBe(3);
    await expect(host.locator('#tower-scene')).toBeVisible();
    await expect(host.locator('#decree')).not.toHaveText('');

    // word 1 through the real keyboard
    const [w1] = findWords(t.constraint, [], 1);
    for (const ch of w1) await host.click(`[data-testid="key-${ch}"]`);
    await expect(host.locator('[data-testid="twr-in-0"]')).toHaveText(w1[0].toUpperCase());
    await host.click('[data-testid="key-enter"]');
    await host.waitForFunction(() => window.__topple.state().tower.height === 1, null, { polling: 100 });
    t = await towerState(host);
    expect(t.rows[0].word).toBe(w1);
    expect(t.rows[0].points).toBe(wordPoints(w1, 1, 1));
    expect((await state(host)).players.find((p) => p.id === hostId).score).toBe(wordPoints(w1, 1, 1));
    await expect(host.locator('#team-score')).toContainText(wordPoints(w1, 1, 1).toLocaleString('en-US'));
    // the floor is a real 3D slab carrying the real letters
    await expect(host.locator('.t3d-floor')).toHaveCount(1);
    expect((await host.locator('.t3d-floor').first().locator('.t3d-glyph').allTextContents())
      .join('').toLowerCase()).toBe(w1);

    // word 2 -> rampWords=2 reached -> stage 2, decree changes
    const [w2] = findWords(t.constraint, [w1], 1);
    await climb(host, w2);
    await host.waitForFunction(() => window.__topple.state().tower.stage === 2, null, { polling: 100 });

    // misses: not-a-word, duplicate, decree-breaker - one life each
    await miss(host, 'zzzzz');
    await miss(host, w1); // already in the tower
    t = await towerState(host);
    const breaker = findNonMatching(t.constraint, [w1, w2]);
    await miss(host, breaker); // life 3 gone -> solo team downed -> the tower falls
    await host.waitForFunction(() => window.__topple.state().over, null, { polling: 100 });
    const over = (await state(host)).gameover;
    expect(over.reason).toBe('the tower fell');
    expect(over.height).toBe(2);
    // the collapse plays before the podium
    await expect(host.locator('#tower-scene')).toHaveClass(/collapsing/);
    await host.waitForSelector('#scr-over:not(.hidden)');
    await expect(host.locator('#over-title')).toContainText('HEIGHT 2');
  });

  test('co-op: downed teammate, revive wordle, hunger bleeds everyone', async ({ context }) => {
    test.setTimeout(90000);
    const host = await openPage(context);
    const code = await hostGame(host, 'CLERIC', { ...FAST, rampWords: 50, hungerMs: 600000 });
    const pA = await openPage(context);
    await joinGame(pA, code, 'FALLEN');
    await host.waitForFunction(() => window.__topple.state().players.length === 2);
    const [hostId, aId] = await host.evaluate(() =>
      window.__topple.state().players.map((p) => p.id));
    await startGame(host, [host, pA]);
    await waitTower(host);
    await waitTower(pA);

    // A flames out: three bad words
    await miss(pA, 'zzzzz');
    await miss(pA, 'qqqqq');
    await miss(pA, 'jjjjj');
    await pA.waitForFunction(() => window.__topple.state().inputLocked, null, { polling: 100 });
    await expect(host.locator(`[data-testid="lives-${aId}"]`)).toHaveText('—');
    expect(await pA.evaluate(() => window.__topple.guess('crane'))).toBe(false);

    // host keeps climbing (solo now), then buys a revive through the UI
    let t = await towerState(host);
    const [w1] = findWords(t.constraint, [], 1);
    await climb(host, w1);
    await setScore(host, hostId, 50000);
    await host.click('[data-testid="shop-revive"]');
    await host.click(`[data-testid="pick-${aId}"]`);
    await host.click('#btn-picker-go');
    await host.waitForFunction(() => !!window.__topple.state().tower.revives[window.__topple.selfId], null, { polling: 100 });
    expect((await state(host)).players.find((p) => p.id === hostId).score).toBe(45000);

    // the rescue wordle: one wrong guess (visible to the fallen teammate), then the solve
    const secret = await host.evaluate((pid) => window.__topple.reviveSecret(pid), hostId);
    expect(secret).toMatch(/^[a-z]{5}$/);
    const wrong = ['crane', 'slimy', 'pouty'].find((w) => w !== secret);
    await host.evaluate((w) => window.__topple.guess(w), wrong);
    await pA.waitForFunction((h) => {
      const rev = window.__topple.state().tower.revives[h];
      return rev && rev.rows.length === 1;
    }, hostId, { polling: 100 });
    await expect(pA.locator('[data-testid="rev-0-0"]')).toHaveText(wrong[0].toUpperCase());
    await host.evaluate((w) => window.__topple.guess(w), secret);
    await pA.waitForFunction((a) => window.__topple.state().tower.lives[a] === 2, aId, { polling: 100 });
    await pA.waitForFunction(() => !window.__topple.state().inputLocked, null, { polling: 100 });

    // the revived player can climb again
    t = await towerState(pA);
    const [w2] = findWords(t.constraint, await usedWords(pA), 1);
    await climb(pA, w2);

    // hunger: silence bleeds every living player
    await host.evaluate(() => { window.__topple.engine.tower.hungerMs = 900; });
    t = await towerState(host);
    const [w3] = findWords(t.constraint, await usedWords(host), 1);
    await climb(host, w3); // re-arms the hunger clock at 900ms
    await host.waitForFunction(([h, a]) => {
      const lv = window.__topple.state().tower.lives;
      return lv[h] === 2 && lv[a] === 1;
    }, [hostId, aId], { polling: 100 });

    // everyone falls -> game over with the final height
    await miss(host, 'zzzzz');
    await miss(host, 'qqqqq'); // host down
    await miss(pA, 'zzzzz');   // A down -> all down
    await pA.waitForFunction(() => window.__topple.state().over, null, { polling: 100 });
    const over = (await state(pA)).gameover;
    expect(over.reason).toBe('the tower fell');
    expect(over.height).toBe(3);
  });

  test('bonus hearts: every 10th floor revives a downed teammate; capped at max', async ({ context }) => {
    test.setTimeout(120000);
    const host = await openPage(context);
    const code = await hostGame(host, 'PRIEST', { ...FAST, rampWords: 999, hungerMs: 600000 });
    const pA = await openPage(context);
    await joinGame(pA, code, 'DOWNED');
    await host.waitForFunction(() => window.__topple.state().players.length === 2);
    const aId = await pA.evaluate(() => window.__topple.selfId);
    await startGame(host, [host, pA]);
    await waitTower(host);
    await waitTower(pA);

    // no decree noise: any distinct dictionary word is acceptable
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    // A flames out completely (3 misses) while the tower keeps climbing
    await miss(pA, 'zzzzz');
    await miss(pA, 'qqqqq');
    await miss(pA, 'jjjjj');
    await pA.waitForFunction(() => window.__topple.state().inputLocked, null, { polling: 100 });
    expect((await towerState(host)).lives[aId]).toBe(0);

    // host climbs 10 distinct words alone -> height-10 milestone fires
    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 30);
    let placed = 0;
    for (const w of words) {
      if (placed >= 10) break;
      const used = new Set(await usedWords(host));
      if (used.has(w)) continue;
      await climb(host, w);
      placed += 1;
    }
    expect(placed).toBe(10);

    await host.waitForFunction(() => window.__topple.state().tower.height === 10, null, { polling: 100 });
    // the milestone revived the downed teammate...
    await pA.waitForFunction((id) => window.__topple.state().tower.lives[id] === 1, aId, { polling: 100 });
    await pA.waitForFunction(() => !window.__topple.state().inputLocked, null, { polling: 100 });
    // ...and the host (who never lost a life) gained one too, capped by maxLives
    const hostId = await host.evaluate(() => window.__topple.selfId);
    let t = await towerState(host);
    expect(t.lives[hostId]).toBe(4); // 3 start + 1 milestone
    expect(t.lives[aId]).toBe(1);    // 0 -> revived to 1

    // grind to height 50 (5 milestones) to prove the cap holds
    const usedSoFar = new Set(await usedWords(host));
    const more = GUESSES.filter((w) => /^[a-z]{5}$/.test(w) && !usedSoFar.has(w)).slice(0, 60);
    let extra = 0;
    for (const w of more) {
      if ((await towerState(host)).height >= 50) break;
      const used = new Set(await usedWords(host));
      if (used.has(w)) continue;
      await climb(host, w);
      extra += 1;
      if (extra > 45) break; // safety valve
    }
    t = await towerState(host);
    expect(t.height).toBeGreaterThanOrEqual(50);
    expect(t.lives[hostId]).toBe(5); // capped at maxLives, not 8
  });

  test('the tower blessing: spelling TOWER down a column grants a bonus heart', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    await hostGame(host, 'BARD', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.click('#btn-start');
    await waitTower(host);
    const hostId = await host.evaluate(() => window.__topple.selfId);

    // clear the decree so any word starting with the target letter qualifies
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    // five real words whose FIRST letters spell T-O-W-E-R down the column
    const wordStartingWith = (ch) => GUESSES.find((w) => /^[a-z]{5}$/.test(w) && w[0] === ch);
    const towerWords = ['t', 'o', 'w', 'e', 'r'].map(wordStartingWith);
    expect(towerWords.every(Boolean)).toBe(true);
    expect(new Set(towerWords).size).toBe(5);

    for (const w of towerWords.slice(0, 4)) await climb(host, w);
    let t = await towerState(host);
    const before = t.lives[hostId];
    expect(t.height).toBe(4); // not a height-10 milestone - isolates the easter egg

    await climb(host, towerWords[4]);
    await host.waitForFunction((b) => window.__topple.state().tower.lives[window.__topple.selfId] === b + 1, before, { polling: 100 });
    t = await towerState(host);
    expect(t.height).toBe(5);
    expect(t.lives[hostId]).toBe(before + 1);
    await expect(host.locator('#toast')).toContainText('T-O-W-E-R');
  });

  test('revive pauses the shared hunger clock; a bystander can keep climbing; resumes fresh after', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    const code = await hostGame(host, 'MONK', { ...FAST, rampWords: 999, hungerMs: 900 });
    const pA = await openPage(context); // will go down, gets revived
    await joinGame(pA, code, 'CASTER');
    const pB = await openPage(context); // bystander: neither reviving nor downed
    await joinGame(pB, code, 'ROGUE');
    await host.waitForFunction(() => window.__topple.state().players.length === 3);
    const hostId = await host.evaluate(() => window.__topple.selfId);
    const aId = await pA.evaluate(() => window.__topple.selfId);
    await startGame(host, [host, pA, pB]);
    await waitTower(host); await waitTower(pA); await waitTower(pB);
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    // A goes down; host and B stay up
    await miss(pA, 'zzzzz');
    await miss(pA, 'qqqqq');
    await miss(pA, 'jjjjj');
    await pA.waitForFunction(() => window.__topple.state().inputLocked, null, { polling: 100 });

    await setScore(host, hostId, 50000);
    await host.click('[data-testid="shop-revive"]');
    await host.click(`[data-testid="pick-${aId}"]`);
    await host.click('#btn-picker-go');
    await host.waitForFunction(() => !!window.__topple.state().tower.revives[window.__topple.selfId], null, { polling: 100 });
    expect((await towerState(host)).hungerPaused).toBe(true);
    await expect(host.locator('#hunger-label')).toBeVisible();
    await pB.waitForFunction(() => window.__topple.state().tower.hungerPaused, null, { polling: 100 });

    // sit well past hungerMs (900ms) WITHOUT finishing the revive - nobody bleeds
    const livesBefore = (await towerState(host)).lives;
    await host.waitForTimeout(1800);
    expect((await towerState(host)).lives).toEqual(livesBefore);

    // a completely uninvolved bystander can still climb normally mid-pause
    const bystanderWord = GUESSES.find((w) => /^[a-z]{5}$/.test(w) && !w.startsWith('a'));
    await climb(pB, bystanderWord);
    expect((await towerState(pB)).height).toBe(1);

    // now solve the revive
    const secret = await host.evaluate((pid) => window.__topple.reviveSecret(pid), hostId);
    await host.evaluate((w) => window.__topple.guess(w), secret);
    await pA.waitForFunction((id) => window.__topple.state().tower.lives[id] === 2, aId, { polling: 100 });
    await host.waitForFunction(() => !window.__topple.state().tower.hungerPaused, null, { polling: 100 });
    await expect(host.locator('#hunger-label')).toBeHidden();

    // the clock resumed fresh: waiting past hungerMs again now DOES bleed
    await host.waitForFunction(([h, a, b]) => {
      const lv = window.__topple.state().tower.lives;
      return lv[h] < 3 || lv[a] < 2 || lv[b] < 3;
    }, [hostId, aId, await pB.evaluate(() => window.__topple.selfId)], { polling: 100, timeout: 15000 });
  });

  test('lobby LEVEL + DECREE: four levels (no STD), 3/5/10 words per decree, live-sync and real pacing', async ({ context }) => {
    const host = await openPage(context);
    const code = await hostGame(host, 'DEALER', FAST);
    const guest = await openPage(context);
    await joinGame(guest, code, 'WATCH');
    await host.waitForFunction(() => window.__topple.state().players.length === 2);

    // LEVEL has exactly the four decree bands and defaults to RAMP
    await expect(host.locator('#set-diff')).toBeVisible();
    await expect(host.locator('[data-setting="difficulty"] .seg-btn')).toHaveCount(4);
    await expect(host.locator('[data-setting="difficulty"] [data-val="ramp"]')).toHaveClass(/\bon\b/);
    await expect(host.locator('#set-ramp')).toBeVisible();
    await expect(host.locator('[data-setting="rampWords"] [data-val="5"]')).toHaveClass(/\bon\b/); // TOWER.defaultRampWords

    // guest cannot change either (not host) - reflected as disabled
    await expect(guest.locator('[data-setting="difficulty"] [data-val="hard"]')).toBeDisabled();
    await expect(guest.locator('[data-setting="rampWords"] [data-val="3"]')).toBeDisabled();

    // host picks HARD + DECREE 3 - live-syncs to the guest
    await host.click('[data-setting="difficulty"] [data-val="hard"]');
    await host.click('[data-setting="rampWords"] [data-val="3"]');
    await guest.waitForFunction(() => window.__topple.state().settings?.rampWords === 3
      && window.__topple.state().settings?.difficulty === 'hard', null, { polling: 100 });
    await expect(guest.locator('[data-setting="difficulty"] [data-val="hard"]')).toHaveClass(/\bon\b/);
    await expect(guest.locator('[data-setting="rampWords"] [data-val="3"]')).toHaveClass(/\bon\b/);

    // and it actually drives pacing: stage 2 arrives after just 3 words, on the hard pool
    await startGame(host, [host, guest]);
    await waitTower(host);
    const towerNow = await host.evaluate(() => window.__topple.engineState().tower);
    expect(towerNow.rampWords).toBe(3);
    expect(towerNow.difficulty).toBe('hard');
    let t = await towerState(host);
    for (let i = 0; i < 2; i++) {
      const [w] = findWords(t.constraint, await usedWords(host), 1);
      await climb(host, w);
      t = await towerState(host);
    }
    expect(t.stage).toBe(1);
    const [wLast] = findWords(t.constraint, await usedWords(host), 1);
    await climb(host, wLast);
    await host.waitForFunction(() => window.__topple.state().tower.stage === 2, null, { polling: 100 });
  });

  test('decree difficulty pools: all survivable over a long game, and every decree is clearable with RECOGNIZABLE words', () => {
    for (const difficulty of ['easy', 'medium', 'hard', 'ramp']) {
      const used = new Set();
      const seen = new Set();
      for (let stage = 1; stage <= 60; stage++) {
        const c = genConstraint(stage, used, difficulty, 10);
        // every decree this deep in a long game can still supply the full
        // 10-word requirement - nobody gets mathematically stranded
        expect(countPossible(c, used)).toBeGreaterThanOrEqual(10);
        // ...and it's satisfiable by real, recognizable answer words, not just
        // technically-possible obscure ones (lymph / pshaw / raser).
        expect(countRecognizable(c)).toBeGreaterThanOrEqual(
          20,
          `${difficulty} decree "${describeConstraint(c)}" has too few recognizable answers`,
        );
        seen.add(JSON.stringify(c));
        let taken = 0;
        for (const w of GUESSES) {
          if (taken >= 10) break;
          if (!used.has(w) && matchesConstraint(w, c)) { used.add(w); taken += 1; }
        }
      }
      expect(seen.size).toBeGreaterThan(5); // real variety, not one repeated decree
    }
    // hard must not be exclusively vowel-banning
    let noVowelHard = 0;
    let total = 0;
    const seenHard = new Set();
    const used = new Set();
    for (let stage = 6; stage <= 120; stage++) {
      const c = genConstraint(stage, used, 'hard', 5);
      total += 1;
      if (c.ban && ['a', 'e', 'i', 'o', 'u'].every((v) => c.ban.includes(v))) noVowelHard += 1;
      seenHard.add(describeConstraint(c));
      let taken = 0;
      for (const w of GUESSES) {
        if (taken >= 5) break;
        if (!used.has(w) && matchesConstraint(w, c)) { used.add(w); taken += 1; }
      }
    }
    expect(noVowelHard).toBeLessThan(total * 0.2);
    expect(seenHard.size).toBeGreaterThan(15);

    expect(countRecognizable({ req: ['e'] }, 20)).toBe(20); // capped by early-exit
    expect(countRecognizable({ ban: ['a', 'e', 'i', 'o', 'u'], uniq: true })).toBeLessThan(30);
  });

  test('a decree never repeats back-to-back (no getting stuck on the same rule)', () => {
    for (const difficulty of ['easy', 'medium', 'hard', 'ramp']) {
      const used = new Set();
      let prev = null;
      let prevDesc = null;
      for (let stage = 1; stage <= 150; stage++) {
        const c = genConstraint(stage, used, difficulty, 5, prev);
        const desc = describeConstraint(c);
        expect(desc).not.toBe(prevDesc); // <- the whole point
        prev = c;
        prevDesc = desc;
        let taken = 0;
        for (const w of GUESSES) {
          if (taken >= 5) break;
          if (!used.has(w) && matchesConstraint(w, c)) { used.add(w); taken += 1; }
        }
      }
    }
    const noVowels = { ban: ['a', 'e', 'i', 'o', 'u'] };
    for (let i = 0; i < 30; i++) {
      const c = genConstraint(9, new Set(), 'hard', 5, noVowels);
      expect(describeConstraint(c)).not.toBe('NO VOWELS');
    }
  });

  test('describeConstraint reads naturally: starts-with / ends-in / vowel counts', () => {
    expect(describeConstraint({ reqAt: [{ i: 0, ch: 's' }] })).toBe('STARTS WITH S');
    expect(describeConstraint({ reqAt: [{ i: 4, ch: 't' }] })).toBe('ENDS IN T');
    expect(describeConstraint({ reqAt: [{ i: 2, ch: 'a' }] })).toBe('A IN SLOT 3');
    expect(describeConstraint({ vmin: 1, vmax: 1 })).toBe('EXACTLY 1 VOWEL');
    expect(describeConstraint({ vmin: 3 })).toBe('3+ VOWELS');
    expect(describeConstraint({ bookend: true })).toBe('FIRST + LAST LETTER MATCH');
    expect(describeConstraint({ ban: ['e'] })).toBe('FORBIDDEN: E');
    expect(describeConstraint({})).toBe('ANY WORD');
  });

  test('the mounted stack caps at 10 floors and the keyboard never shifts', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    await hostGame(host, 'ANCHOR', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.click('#btn-start');
    await waitTower(host);
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    // offsetTop, not boundingBox: layout position only, immune to the screen's
    // entry transform (and to the tower's own 3D transforms)
    const keyboardY = () => host.locator('#keyboard').evaluate((el) => el.offsetTop);
    const yEmpty = await keyboardY();

    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 20);
    for (let i = 0; i < 6; i++) await climb(host, words[i]);
    expect(await keyboardY()).toBe(yEmpty); // fixed footprint from the first word on

    for (let i = 6; i < 14; i++) await climb(host, words[i]);
    expect(await keyboardY()).toBe(yEmpty); // still identical well past the cap

    // exactly 10 slabs mounted, and they're the 10 MOST RECENT (5..14, not 1..10)
    const rows = host.locator('.t3d-floor:not(.sinking)');
    await expect(rows).toHaveCount(10);
    const wordOf = (loc) => loc.getAttribute('data-word');
    expect(await wordOf(rows.last())).toBe(words[13]);   // newest is the top slab
    expect(await wordOf(rows.first())).toBe(words[4]);   // oldest still mounted
    const mounted = await rows.evaluateAll((els) => els.map((e) => e.dataset.word));
    expect(mounted).not.toContain(words[0]);             // scrolled out of the window
    // but it's still real height/score, just not mounted
    expect((await towerState(host)).height).toBe(14);
  });

  test('duplicate rule is on-screen only: a word that scrolled off can be replayed, one still visible cannot', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    await hostGame(host, 'REPLAY', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.click('#btn-start');
    await waitTower(host);
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 30);
    const first = words[0];
    await climb(host, first);           // floor 1 = `first`, now on screen

    // a word still on screen can't be replayed
    await miss(host, first);
    expect((await towerState(host)).height).toBe(1); // rejected, no growth

    // climb 10 MORE distinct words - `first` scrolls out of the 10-row window
    for (let i = 1; i <= 10; i++) await climb(host, words[i]);
    let t = await towerState(host);
    expect(t.height).toBe(11);
    const onScreen = t.rows.slice(-10).map((r) => r.word);
    expect(onScreen).not.toContain(first);
    expect(await host.evaluate((w) => window.__topple.engine.towerOnScreen(w), first)).toBe(false);

    // so `first` is accepted again - the tower grows, no life lost
    const hostId = await host.evaluate(() => window.__topple.selfId);
    const livesBefore = (await towerState(host)).lives[hostId];
    await climb(host, first);
    t = await towerState(host);
    expect(t.height).toBe(12);
    expect(t.rows[t.rows.length - 1].word).toBe(first); // it's the newest floor
    expect(t.lives[hostId]).toBe(livesBefore);          // no penalty

    // and now that it's back on screen, it's a duplicate again
    await miss(host, first);
    expect((await towerState(host)).height).toBe(12);
  });

  test('phone: a full stack fits inside the tower band, and typing cannot zoom the page', async ({ context }) => {
    test.setTimeout(60000);
    // Reported from a real iPhone: the top of the tower was cut off, and fast
    // taps on the keyboard triggered Safari's double-tap-to-zoom.
    const cssText = readFileSync(STYLE_CSS_PATH, 'utf8');
    // double-tap zoom (and its 300ms click delay) is off for the whole document
    expect(cssText).toMatch(/body\s*\{[^}]*touch-action:\s*manipulation/s);
    // ...and the viewport must NOT try to fix it by banning pinch-zoom, which
    // iOS ignores anyway and which breaks zoom for anyone who needs it
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    const viewport = html.match(/<meta name="viewport" content="([^"]+)"/)[1];
    expect(viewport).toContain('viewport-fit=cover'); // makes safe-area insets real
    expect(viewport).not.toContain('user-scalable=no');
    expect(viewport).not.toContain('maximum-scale');

    const host = await openPage(context);
    await host.setViewportSize({ width: 390, height: 664 }); // iPhone minus browser chrome
    await hostGame(host, 'POCKET', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.click('#btn-start');
    await waitTower(host);
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    // overfill the window so all 10 mounted floors are present
    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 12);
    for (const w of words) await climb(host, w);
    await host.waitForTimeout(600); // let the landing + camera transitions settle

    const floors = host.locator('.t3d-floor:not(.sinking)');
    await expect(floors).toHaveCount(10);

    // every mounted floor is fully inside the scene — nothing sheared off the top
    const scene = await host.locator('#tower-scene').boundingBox();
    const boxes = await floors.evaluateAll((els) => els.map((e) => {
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    }));
    expect(boxes).toHaveLength(10);
    for (const box of boxes) {
      expect(box.top).toBeGreaterThanOrEqual(scene.y - 1);
      expect(box.bottom).toBeLessThanOrEqual(scene.y + scene.height + 1);
    }

    // and the tower still owns a meaningful share of the screen, rather than
    // being squeezed to nothing by the HUD
    expect(scene.height).toBeGreaterThan(150);
  });

  test('pause works mid-climb (regression: the app shell needs top safe-area padding)', async ({ context }) => {
    // apple-mobile-web-app-capable makes standalone iOS render edge-to-edge, so
    // the shell must reserve the top inset or the header buttons sit under the
    // notch and become untappable. Headless Chromium resolves
    // env(safe-area-inset-top) to 0, so this locks in the rule's existence and
    // proves the full pause/resume/still-playable cycle.
    const cssText = readFileSync(STYLE_CSS_PATH, 'utf8');
    expect(cssText).toMatch(/#app\s*\{[^}]*env\(safe-area-inset-top\)/);

    const host = await openPage(context);
    await hostGame(host, 'PAUSER', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.click('#btn-start');
    await waitTower(host);

    await host.click('#btn-pause');
    await expect(host.locator('#ovl-pause')).toBeVisible();
    expect(await host.evaluate(() => window.__topple.ui.paused)).toBe(true);

    await host.click('#btn-resume');
    await expect(host.locator('#ovl-pause')).toBeHidden();
    expect(await host.evaluate(() => window.__topple.state().inputLocked)).toBe(false);

    // still fully playable after a pause/resume cycle
    const t = await towerState(host);
    const [w1] = findWords(t.constraint, [], 1);
    await climb(host, w1);
    expect((await towerState(host)).height).toBe(1);
  });

  test('revive replaces the tower (fixed height, keyboard never moves) and bystanders keep climbing', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context); // will be the reviver
    const code = await hostGame(host, 'MEDIC', { ...FAST, rampWords: 999, hungerMs: 600000 });
    const pA = await openPage(context); // will be downed / revived
    await joinGame(pA, code, 'FALLEN');
    const pB = await openPage(context); // bystander: keeps climbing throughout
    await joinGame(pB, code, 'ROGUE');
    await host.waitForFunction(() => window.__topple.state().players.length === 3);
    const hostId = await host.evaluate(() => window.__topple.selfId);
    const aId = await pA.evaluate(() => window.__topple.selfId);
    await startGame(host, [host, pA, pB]);
    await Promise.all([host, pA, pB].map(waitTower));
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    const keyboardY = (page) => page.locator('#keyboard').evaluate((el) => el.offsetTop);
    const yBefore = await keyboardY(host);
    await expect(host.locator('#tower-scene')).toBeVisible();
    await expect(host.locator('#revive-box')).toBeHidden();

    // A goes down
    await miss(pA, 'zzzzz'); await miss(pA, 'qqqqq'); await miss(pA, 'jjjjj');
    await pA.waitForFunction(() => window.__topple.state().inputLocked, null, { polling: 100 });

    await setScore(host, hostId, 50000);
    await host.click('[data-testid="shop-revive"]');
    await host.click(`[data-testid="pick-${aId}"]`);
    await host.click('#btn-picker-go');
    await host.waitForFunction(() => !!window.__topple.state().tower.revives[window.__topple.selfId], null, { polling: 100 });
    await pA.waitForFunction(() => Object.keys(window.__topple.state().tower.revives).length > 0, null, { polling: 100 });
    await pB.waitForFunction(() => Object.keys(window.__topple.state().tower.revives).length > 0, null, { polling: 100 });

    // the swap: tower hidden, rescue grid visible, on EVERY screen
    for (const page of [host, pA, pB]) {
      await expect(page.locator('#tower-scene')).toBeHidden();
      await expect(page.locator('#revive-box')).toBeVisible();
    }
    // #tower-input itself is NEVER hidden - hiding it would shrink the column
    // and shift the keyboard. The reviver's copy just renders blank; the
    // bystander's stays fully visible AND usable.
    await expect(host.locator('#tower-input')).toBeVisible();
    await expect(host.locator('[data-testid="twr-in-0"]')).toHaveText('');
    await expect(pB.locator('#tower-input')).toBeVisible();

    // the keyboard has not moved a single pixel despite the swap
    expect(await keyboardY(host)).toBe(yBefore);

    // the bystander can still climb the (hidden) tower normally mid-revive
    const t = await towerState(pB);
    const [wB] = findWords(t.constraint, [], 1);
    await climb(pB, wB);
    expect((await towerState(pB)).height).toBe(1);

    // solve the revive - the tower comes back for everyone, keyboard still stable
    const secret = await host.evaluate((pid) => window.__topple.reviveSecret(pid), hostId);
    await host.evaluate((w) => window.__topple.guess(w), secret);
    await pA.waitForFunction((id) => window.__topple.state().tower.lives[id] === 2, aId, { polling: 100 });

    for (const page of [host, pA, pB]) {
      await expect(page.locator('#tower-scene')).toBeVisible();
      await expect(page.locator('#revive-box')).toBeHidden();
    }
    await expect(host.locator('#tower-input')).toBeVisible();
    expect(await keyboardY(host)).toBe(yBefore);
  });
});
