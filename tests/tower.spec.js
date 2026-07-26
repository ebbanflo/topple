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
import { RELICS } from '../js/relics.js';
import { BOSSES } from '../js/bosses.js';

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
    expect(t.lives[hostId]).toBe(2); // two marks, and two is also the ceiling
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

    // mistakes cost a mark each, and there are only two. A third kind of
    // mistake is proven separately below rather than by taking a third mark.
    await miss(host, 'zzzzz');          // not a word
    await miss(host, w1);               // already in the tower
    // both marks gone -> solo player buried -> nobody left standing -> it falls
    await host.waitForFunction(() => window.__topple.state().over, null, { polling: 100 });
    const over = (await state(host)).gameover;
    expect(over.reason).toBe('the tower fell');
    expect(over.height).toBe(2);
    // the collapse plays before the podium
    await expect(host.locator('#tower-scene')).toHaveClass(/collapsing/);
    await host.waitForSelector('#scr-over:not(.hidden)');
    await expect(host.locator('#over-title')).toContainText('HEIGHT 2');
  });

  test('co-op: a buried teammate digs themselves out, and hunger bleeds everyone', async ({ context }) => {
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
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    // A flames out: three bad words -> buried, NOT out
    await miss(pA, 'zzzzz');
    await miss(pA, 'qqqqq');
    await pA.waitForFunction(() => !!window.__topple.state().tower.buried[window.__topple.selfId],
      null, { polling: 100 });
    await expect(host.locator(`[data-testid="lives-${aId}"]`)).toHaveText('0/3');
    // a buried player is still a player: input stays live
    expect(await pA.evaluate(() => window.__topple.state().inputLocked)).toBe(false);
    // ...and the run is NOT over, because someone is still standing
    expect((await state(pA)).over).toBe(false);

    // the host climbs while A digs - both are playing at once
    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 10);
    await climb(host, words[0]);
    const scoreBefore = (await state(pA)).players.find((p) => p.id === aId).score;
    const heightBefore = (await towerState(pA)).height;

    // three decree-obeying words dig A out with exactly one life
    for (let i = 1; i <= 3; i++) {
      await pA.evaluate((w) => window.__topple.guess(w), words[i]);
      await pA.waitForFunction((n) => {
        const t = window.__topple.state().tower;
        const d = t.buried[window.__topple.selfId];
        return d ? d.cleared === n : n === 3;
      }, i, { polling: 50 });
    }
    await pA.waitForFunction(() => window.__topple.state().tower.lives[window.__topple.selfId] === 1,
      null, { polling: 100 });
    expect((await towerState(pA)).buried[aId]).toBeUndefined();
    // digging is not building: no floors, no points
    expect((await towerState(pA)).height).toBe(heightBefore);
    expect((await state(pA)).players.find((p) => p.id === aId).score).toBe(scoreBefore);

    // the dug-out player climbs for real again
    await climb(pA, words[4]);
    expect((await towerState(pA)).height).toBe(heightBefore + 1);

    // the timer: silence costs every standing player a mark
    await host.evaluate(() => { window.__topple.engine.tower.hungerMs = 900; });
    await climb(host, words[5]); // re-arms the clock at 900ms
    await host.waitForFunction(([h, a]) => {
      const lv = window.__topple.state().tower.lives;
      return lv[h] === 1 && lv[a] === 0; // host 2->1, the dug-out player 1->0
    }, [hostId, aId], { polling: 50 });
    // stop the clock, so the ending below is driven by the mistake and not by
    // a second strike landing underneath it
    await host.evaluate(() => { window.__topple.engine.tower.hungerMs = 600000; });

    // the host spends their last mark -> nobody standing -> the tower falls.
    // Submitted rather than miss()'d: if the clock did get one more strike in,
    // the run is already over and miss() would wait forever for a mark to drop.
    await host.evaluate(() => window.__topple.guess('zzzzz'));
    await host.waitForFunction(() => window.__topple.state().over, null, { polling: 100 });
    expect((await state(host)).gameover.reason).toBe('the tower fell');
  });

  test('bonus marks: every 10th floor lifts a buried teammate out, and is a no-op at full marks', async ({ context }) => {
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

    // A flames out completely while the tower keeps climbing
    await miss(pA, 'zzzzz');
    await miss(pA, 'qqqqq');
    await pA.waitForFunction(() => !!window.__topple.state().tower.buried[window.__topple.selfId],
      null, { polling: 100 });
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
    // the milestone lifted the buried teammate out...
    await pA.waitForFunction((id) => window.__topple.state().tower.lives[id] === 1, aId, { polling: 100 });
    // ...and did NOTHING for the host, who was already at full marks. That is
    // the point of capping at the starting count: a bonus is a heal, not a
    // stockpile, so it only pays when somebody has actually taken a hit.
    const hostId = await host.evaluate(() => window.__topple.selfId);
    let t = await towerState(host);
    expect(t.lives[hostId]).toBe(2); // unchanged - already full
    expect(t.lives[aId]).toBe(1);    // 0 -> lifted out to 1

    // grind to height 50 (5 milestones) to prove the ceiling really holds
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
    expect(t.lives[hostId]).toBe(2); // five milestones later, still two
  });

  test('the T-O-W-E-R easter egg gives a mark back', async ({ context }) => {
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

    // spend a mark first: at full marks the bonus is deliberately a no-op, so
    // there would be nothing to observe
    await miss(host, 'zzzzz');
    for (const w of towerWords.slice(0, 4)) await climb(host, w);
    let t = await towerState(host);
    const before = t.lives[hostId];
    expect(before).toBe(1);
    expect(t.height).toBe(4); // not a height-10 milestone - isolates the easter egg

    await climb(host, towerWords[4]);
    await host.waitForFunction((b) => window.__topple.state().tower.lives[window.__topple.selfId] === b + 1, before, { polling: 100 });
    t = await towerState(host);
    expect(t.height).toBe(5);
    expect(t.lives[hostId]).toBe(before + 1);
    await expect(host.locator('#toast')).toContainText('T-O-W-E-R');
  });

  test('rope: a standing teammate buys away one of a buried player\'s dig words', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    const code = await hostGame(host, 'MONK', { ...FAST, rampWords: 999, hungerMs: 600000 });
    const pA = await openPage(context); // will be buried
    await joinGame(pA, code, 'CASTER');
    await host.waitForFunction(() => window.__topple.state().players.length === 2);
    const hostId = await host.evaluate(() => window.__topple.selfId);
    const aId = await pA.evaluate(() => window.__topple.selfId);
    await startGame(host, [host, pA]);
    await waitTower(host); await waitTower(pA);
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    await miss(pA, 'zzzzz'); await miss(pA, 'qqqqq'); // two marks is all it takes
    await pA.waitForFunction(() => !!window.__topple.state().tower.buried[window.__topple.selfId],
      null, { polling: 100 });

    // the shop only unlocks once somebody is actually buried and you can afford it
    await setScore(host, hostId, 50000);
    await host.waitForFunction(() => !document.querySelector('[data-testid="shop-rope"]').disabled,
      null, { polling: 100 });
    await host.click('[data-testid="shop-rope"]');
    await host.click(`[data-testid="pick-${aId}"]`);
    await host.click('#btn-picker-go');

    // one marker cleared, and the buyer paid for it
    await pA.waitForFunction(() => window.__topple.state().tower.buried[window.__topple.selfId]?.cleared === 1,
      null, { polling: 100 });
    expect((await state(host)).players.find((p) => p.id === hostId).score).toBe(48000);

    // A finishes the last two themselves and is back with one life
    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 4);
    for (const w of words.slice(0, 2)) {
      await pA.evaluate((x) => window.__topple.guess(x), w);
      await pA.waitForTimeout(120);
    }
    await pA.waitForFunction(() => window.__topple.state().tower.lives[window.__topple.selfId] === 1,
      null, { polling: 100 });
  });

  test('a bonus heart lifts a buried player straight out', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    const code = await hostGame(host, 'PRIEST', { ...FAST, rampWords: 999, hungerMs: 600000 });
    const pA = await openPage(context);
    await joinGame(pA, code, 'BURIED');
    await host.waitForFunction(() => window.__topple.state().players.length === 2);
    const aId = await pA.evaluate(() => window.__topple.selfId);
    await startGame(host, [host, pA]);
    await waitTower(host); await waitTower(pA);
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    await miss(pA, 'zzzzz'); await miss(pA, 'qqqqq'); // two marks is all it takes
    await pA.waitForFunction(() => !!window.__topple.state().tower.buried[window.__topple.selfId],
      null, { polling: 100 });

    // host climbs to the 10-floor milestone; the team heart un-buries A for free
    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 12);
    let placed = 0;
    for (const w of words) {
      if (placed >= 10) break;
      const used = new Set(await usedWords(host));
      if (used.has(w)) continue;
      await climb(host, w);
      placed += 1;
    }
    await pA.waitForFunction((id) => window.__topple.state().tower.lives[id] === 1, aId, { polling: 100 });
    expect((await towerState(pA)).buried[aId]).toBeUndefined();
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

  test('decree draft: three distinct decrees, any player picks, first tap wins', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    // a long draft window so the test drives the choice rather than the timeout
    const code = await hostGame(host, 'ARCHITECT', {
      ...FAST, rampWords: 1, hungerMs: 600000, draftMs: 20000,
    });
    const guest = await openPage(context);
    await joinGame(guest, code, 'MASON');
    await host.waitForFunction(() => window.__topple.state().players.length === 2);
    const guestId = await guest.evaluate(() => window.__topple.selfId);
    await startGame(host, [host, guest]);
    await waitTower(host); await waitTower(guest);

    const before = await towerState(host);
    const [w] = findWords(before.constraint, [], 1);
    await climb(host, w); // rampWords=1, so this triggers the draft

    // the offer reaches EVERY player, not just the host
    for (const page of [host, guest]) {
      await page.waitForFunction(() => !!window.__topple.state().tower.offer, null, { polling: 50 });
    }
    const offer = (await towerState(guest)).offer;
    expect(offer.options).toHaveLength(3);
    // three genuinely different rules, and none of them the outgoing one
    const descs = offer.options.map(describeConstraint);
    expect(new Set(descs).size).toBe(3);
    expect(descs).not.toContain(describeConstraint(before.constraint));
    await expect(guest.locator('#ovl-draft')).toBeVisible();
    await expect(guest.locator('.draft-opt')).toHaveCount(3);

    // the GUEST picks - drafting is not a host privilege
    const chosen = describeConstraint(offer.options[2]);
    await guest.click('[data-testid="draft-2"]');
    await host.waitForFunction((d) => {
      const t = window.__topple.state().tower;
      return !t.offer && t.stage === 2;
    }, null, { polling: 50 });
    expect(describeConstraint((await towerState(host)).constraint)).toBe(chosen);
    // and everyone's overlay closes, including the player who didn't pick
    await expect(host.locator('#ovl-draft')).toBeHidden();
    await expect(guest.locator('#ovl-draft')).toBeHidden();

    // a late second pick finds no offer and changes nothing
    await host.evaluate(() => window.__topple.net.emit('pick', { index: 0 }));
    await host.waitForTimeout(300);
    expect(describeConstraint((await towerState(host)).constraint)).toBe(chosen);

    // the decree that was picked is the one actually enforced
    const t2 = await towerState(host);
    const breaker = findNonMatching(t2.constraint, [w]);
    await miss(host, breaker);
  });

  test('decree draft: nobody picks in time, so the tower picks', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    await hostGame(host, 'SLOWPOKE', { ...FAST, rampWords: 1, hungerMs: 600000, draftMs: 600 });
    await host.click('#btn-start');
    await waitTower(host);

    const before = await towerState(host);
    const [w] = findWords(before.constraint, [], 1);
    await climb(host, w);
    await host.waitForFunction(() => !!window.__topple.state().tower.offer, null, { polling: 40 });
    const first = describeConstraint((await towerState(host)).offer.options[0]);

    // let the window lapse untouched
    await host.waitForFunction(() => !window.__topple.state().tower.offer, null, { polling: 50, timeout: 10000 });
    const t = await towerState(host);
    expect(t.stage).toBe(2);
    expect(describeConstraint(t.constraint)).toBe(first); // the tower takes option one
    await expect(host.locator('#ovl-draft')).toBeHidden();
  });

  test('lobby: every settings button actually lands its value, with the right TYPE', async ({ context }) => {
    // The lobby click path had no coverage at all: every other test reaches
    // ASCENT/DAILY through window.__topple.setSettings(), which bypasses the
    // UI's value coercion entirely. That is how a whole phase shipped on top of
    // a mode nobody could select - Number('ascent') is NaN, the engine's
    // MODE_CHOICES guard quietly reset it to 'classic', and the button looked
    // dead. This test drives the real DOM.
    const host = await openPage(context);
    await hostGame(host, 'CLICKER');
    const setting = async () => (await state(host)).settings;

    // ---- string-valued rows must arrive as strings ----
    for (const mode of ['ascent', 'daily', 'classic']) {
      await host.click(`[data-setting="mode"] [data-val="${mode}"]`);
      await host.waitForFunction((m) => window.__topple.state().settings.mode === m,
        mode, { polling: 50 });
      expect((await setting()).mode).toBe(mode);
      // the highlight must agree with the state, so they can never disagree silently
      await expect(host.locator(`[data-setting="mode"] [data-val="${mode}"]`))
        .toHaveClass(/\bon\b/);
    }

    await host.click('[data-setting="difficulty"] [data-val="hard"]');
    await host.waitForFunction(() => window.__topple.state().settings.difficulty === 'hard',
      null, { polling: 50 });
    expect((await setting()).difficulty).toBe('hard');

    // ---- numeric rows must still arrive as NUMBERS ----
    // this is what pins the coercion in both directions: a fix that made
    // everything a string would pass the assertions above and fail here
    await host.click('[data-setting="rampWords"] [data-val="3"]');
    await host.waitForFunction(() => window.__topple.state().settings.rampWords === 3,
      null, { polling: 50 });
    const s = await setting();
    expect(s.rampWords).toBe(3);
    expect(typeof s.rampWords).toBe('number');
  });

  test('lobby: picking DAILY by hand locks the other rows, and CLASSIC frees them', async ({ context }) => {
    const host = await openPage(context);
    await hostGame(host, 'DIALLER');

    await host.click('[data-setting="mode"] [data-val="daily"]');
    await host.waitForFunction(() => window.__topple.state().settings.mode === 'daily',
      null, { polling: 50 });
    await expect(host.locator('[data-setting="difficulty"] [data-val="hard"]')).toBeDisabled();
    await expect(host.locator('[data-setting="rampWords"] [data-val="3"]')).toBeDisabled();
    await expect(host.locator('#mode-blurb')).toContainText('TOWER #');
    // the MODE row itself must stay live, or DAILY would be a one-way door
    await expect(host.locator('[data-setting="mode"] [data-val="classic"]')).toBeEnabled();

    await host.click('[data-setting="mode"] [data-val="classic"]');
    await host.waitForFunction(() => window.__topple.state().settings.mode === 'classic',
      null, { polling: 50 });
    await expect(host.locator('[data-setting="difficulty"] [data-val="hard"]')).toBeEnabled();
    await expect(host.locator('[data-setting="rampWords"] [data-val="3"]')).toBeEnabled();
  });

  test('DAILY: two independent rooms get the same tower, and the knobs are locked', async ({ context }) => {
    test.setTimeout(60000);
    // Two entirely separate rooms, hosted by different players, on the same day.
    const runs = [];
    for (const name of ['ALPHA', 'BETA']) {
      const page = await openPage(context);
      await hostGame(page, name, { ...FAST, rampWords: 1, draftMs: 20000 });
      await page.evaluate(() => window.__topple.setSettings({ mode: 'daily' }));

      // DAILY owns its own settings: every other control is disabled and the
      // values are overridden regardless of what the host had chosen
      await expect(page.locator('[data-setting="mode"] [data-val="daily"]')).toHaveClass(/\bon\b/);
      await expect(page.locator('[data-setting="difficulty"] [data-val="hard"]')).toBeDisabled();
      await expect(page.locator('[data-setting="rampWords"] [data-val="3"]')).toBeDisabled();
      const st = (await state(page)).settings;
      expect(st.difficulty).toBe('ramp');
      expect(st.rampWords).toBe(5); // the rampWords:1 above was overridden
      await expect(page.locator('#mode-blurb')).toContainText('TOWER #');

      await page.click('#btn-start');
      await waitTower(page);
      const t = await towerState(page);
      // climb into a draft so we compare the dealt OPTIONS too, not just the opener
      const [w] = findWords(t.constraint, [], 1);
      for (let i = 0; i < 5; i++) {
        const used = await usedWords(page);
        const [next] = findWords((await towerState(page)).constraint, used, 1);
        await climb(page, next);
      }
      await page.waitForFunction(() => !!window.__topple.state().tower.offer, null, { polling: 50 });
      runs.push({
        opener: describeConstraint(t.constraint),
        offer: (await towerState(page)).offer.options.map(describeConstraint),
        page,
      });
      expect(w).toBeTruthy();
    }

    // the whole dealt sequence matches across rooms that never spoke to each other
    expect(runs[0].opener).toBe(runs[1].opener);
    expect(runs[0].offer).toEqual(runs[1].offer);
    // and the run is labelled so people can compare
    await expect(runs[0].page.locator('#hdr-status')).toContainText('TOWER #');
  });

  test('CLASSIC does not deal the same tower twice', async ({ context }) => {
    const openers = [];
    for (const name of ['ONE', 'TWO', 'THREE']) {
      const page = await openPage(context);
      await hostGame(page, name, { ...FAST, rampWords: 99, difficulty: 'medium' });
      await page.click('#btn-start');
      await waitTower(page);
      openers.push(describeConstraint((await towerState(page)).constraint));
    }
    // unseeded rooms are independent; three identical openers would mean the
    // default generator had been seeded by accident
    expect(new Set(openers).size).toBeGreaterThan(1);
  });

  test('ASCENT: a level quota opens an intermission, and the next level demands more', async ({ context }) => {
    test.setTimeout(90000);
    const host = await openPage(context);
    const code = await hostGame(host, 'FOREMAN', { ...FAST, rampWords: 999, hungerMs: 600000 });
    // reached by clicking, not through the debug handle, so at least one full
    // ASCENT run is driven the way a player drives it
    await host.click('[data-setting="mode"] [data-val="ascent"]');
    await host.waitForFunction(() => window.__topple.state().settings.mode === 'ascent',
      null, { polling: 50 });
    const guest = await openPage(context);
    await joinGame(guest, code, 'HOD');
    await host.waitForFunction(() => window.__topple.state().players.length === 2);
    const aId = await guest.evaluate(() => window.__topple.selfId);
    await startGame(host, [host, guest]);
    await waitTower(host); await waitTower(guest);
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    const run0 = (await towerState(host)).run;
    expect(run0.level).toBe(1);
    expect(run0.levels).toBe(8);
    expect(run0.quota).toBeGreaterThan(0);
    expect(run0.levelScore).toBe(0);
    await expect(host.locator('#tower-height')).toContainText('LEVEL 1/8');

    // the guest spends a mark first, so we can prove the intermission hands it back
    await miss(guest, 'zzzzz');
    expect((await towerState(host)).lives[aId]).toBe(1);

    // climb until the quota falls
    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 40);
    for (const w of words) {
      const r = (await towerState(host)).run;
      if (r.phase !== 'climb') break;
      if ((await usedWords(host)).includes(w)) continue;
      await climb(host, w);
    }
    await host.waitForFunction(() => window.__topple.state().tower.run.phase === 'intermission',
      null, { polling: 100 });

    // the intermission reaches EVERY player, not just the host
    for (const page of [host, guest]) {
      await page.waitForSelector('#scr-inter:not(.hidden)');
    }
    const inter = (await state(host)).intermission;
    expect(inter.level).toBe(1);
    expect(inter.levelScore).toBeGreaterThanOrEqual(inter.quota);
    expect(inter.earned).toBeGreaterThan(0);
    expect(inter.coins).toBe(inter.earned);
    await expect(host.locator('#inter-title')).toContainText('LEVEL 1 CLEARED');
    // clearing a level hands a mark back, up to the ceiling
    expect((await towerState(host)).lives[aId]).toBe(2);
    // and the tower is genuinely stopped: words do not land
    const heightAtStop = (await towerState(host)).height;
    await host.evaluate(() => window.__topple.guess('crane'));
    await host.waitForTimeout(250);
    expect((await towerState(host)).height).toBe(heightAtStop);
    expect(await host.evaluate(() => window.__topple.state().inputLocked)).toBe(true);

    // only the host calls time
    await expect(guest.locator('#btn-next-level')).toBeHidden();
    await expect(guest.locator('#inter-wait')).toBeVisible();
    await guest.evaluate(() => window.__topple.ready()); // ignored
    await host.waitForTimeout(200);
    expect((await towerState(host)).run.phase).toBe('intermission');

    await host.click('#btn-next-level');
    for (const page of [host, guest]) {
      await page.waitForFunction(() => window.__topple.state().tower.run.phase === 'climb',
        null, { polling: 100 });
      await page.waitForSelector('#scr-game:not(.hidden)');
    }
    const run1 = (await towerState(host)).run;
    expect(run1.level).toBe(2);
    expect(run1.quota).toBeGreaterThan(run0.quota); // level two asks for more
    expect(run1.levelScore).toBe(0);
  });

  test('ASCENT: clearing the last level wins instead of dropping the tower', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    await hostGame(host, 'CAPSTONE', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.evaluate(() => window.__topple.setSettings({ mode: 'ascent' }));
    await host.click('#btn-start');
    await waitTower(host);
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    // jump to the final level and shrink its quota — this test is about the
    // crown, not the curve (which is a playtest question)
    await host.evaluate(() => {
      window.__topple.setLevel(8);
      window.__topple.engine.tower.run.quota = 1000;
    });
    expect((await towerState(host)).run.level).toBe(8);

    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 8);
    for (const w of words) {
      if ((await state(host)).over) break;
      if ((await towerState(host)).run.phase !== 'climb') break;
      await climb(host, w);
    }
    await host.waitForFunction(() => window.__topple.state().over, null, { polling: 100, timeout: 20000 });

    const over = (await state(host)).gameover;
    expect(over.won).toBe(true);
    expect(over.reason).toBe('the tower stands');
    expect(over.level).toBe(8);
    await host.waitForSelector('#scr-over:not(.hidden)');
    await expect(host.locator('#over-title')).toContainText('YOU WIN');
    // a winning tower is NOT demolished on the way to the podium
    await expect(host.locator('#tower-scene')).not.toHaveClass(/collapsing/);
  });

  test('CLASSIC has no levels at all', async ({ context }) => {
    const host = await openPage(context);
    await hostGame(host, 'ENDLESS', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.click('#btn-start');
    await waitTower(host);
    expect((await towerState(host)).run).toBeNull();
    await expect(host.locator('#tower-height')).toContainText('HEIGHT');
  });

  test('ASCENT shop: buying a relic costs coins and measurably changes scoring', async ({ context }) => {
    test.setTimeout(90000);
    const host = await openPage(context);
    await hostGame(host, 'PATRON', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.evaluate(() => window.__topple.setSettings({ mode: 'ascent' }));
    await host.click('#btn-start');
    await waitTower(host);
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    // clear level one to reach the table
    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 40);
    for (const w of words) {
      if ((await towerState(host)).run.phase !== 'climb') break;
      if ((await usedWords(host)).includes(w)) continue;
      await climb(host, w);
    }
    await host.waitForSelector('#scr-inter:not(.hidden)');
    await expect(host.locator('#shop-box')).toBeVisible();
    await expect(host.locator('.relic-opt')).toHaveCount(3);

    // force a known, affordable relic into the offer so the assertion is exact
    await host.evaluate(() => {
      const r = window.__topple.engine.tower.run;
      r.coins = 40;
      r.offers[window.__topple.selfId] = ['vowel_tithe', 'greed', 'keystone'];
      window.__topple.engine.broadcastRelics();
    });
    await host.waitForFunction(() => window.__topple.state().tower.run.coins === 40, null, { polling: 50 });

    await host.click('[data-testid="relic-vowel_tithe"]');
    await host.waitForFunction(() => window.__topple.state().tower.run
      .relics[window.__topple.selfId].includes('vowel_tithe'), null, { polling: 50 });
    // the price came out of the shared pool, and it left the shelf
    expect((await towerState(host)).run.coins).toBe(40 - RELICS.vowel_tithe.price);
    await expect(host.locator('[data-testid="relic-vowel_tithe"]')).toHaveCount(0);
    // buying it twice is impossible
    await host.evaluate(() => window.__topple.mirror.pickRelic('vowel_tithe'));
    await host.waitForTimeout(200);
    expect((await towerState(host)).run.relics[await host.evaluate(() => window.__topple.selfId)])
      .toEqual(['vowel_tithe']);

    // a reroll costs, and redeals
    const before = (await towerState(host)).run.coins;
    await host.click('#btn-reroll');
    await host.waitForFunction((n) => window.__topple.state().tower.run.coins === n - 2,
      before, { polling: 50 });

    // back to the tower - and the relic is doing arithmetic
    await host.click('#btn-next-level');
    await host.waitForFunction(() => window.__topple.state().tower.run.phase === 'climb',
      null, { polling: 50 });
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });
    await expect(host.locator('#status-line')).toContainText('VOWEL TITHE');

    const t = await towerState(host);
    const fresh = words.find((w) => !t.rows.map((r) => r.word).includes(w) && /[aeiou]/.test(w));
    await climb(host, fresh);
    const placed = (await towerState(host)).rows.slice(-1)[0];
    const vowels = [...fresh].filter((c) => 'aeiou'.includes(c)).length;
    // VOWEL TITHE is +40 stone a vowel, and stone is multiplied by mult
    expect(placed.points).toBeGreaterThan(wordPoints(fresh, t.stage, t.combo + 1));
    expect(vowels).toBeGreaterThan(0);
  });

  test('ASCENT relics override rules: SCAFFOLD eats a miss, KEYSTONE reuses a word', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    await hostGame(host, 'RIGGER', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.evaluate(() => window.__topple.setSettings({ mode: 'ascent' }));
    await host.click('#btn-start');
    await waitTower(host);
    const hostId = await host.evaluate(() => window.__topple.selfId);
    await host.evaluate(() => {
      window.__topple.engine.tower.constraint = {};
      window.__topple.engine.tower.run.relics[window.__topple.selfId] = ['scaffold', 'keystone'];
      window.__topple.engine.broadcastTower();
    });

    // SCAFFOLD: the first miss of the level costs nothing...
    const lives0 = (await towerState(host)).lives[hostId];
    await host.evaluate(() => window.__topple.guess('zzzzz'));
    await host.waitForTimeout(300);
    expect((await towerState(host)).lives[hostId]).toBe(lives0);
    // ...and only the first
    await miss(host, 'qqqqq');
    expect((await towerState(host)).lives[hostId]).toBe(lives0 - 1);

    // KEYSTONE: a word still standing can be played again
    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 3);
    await climb(host, words[0]);
    const h = (await towerState(host)).height;
    await climb(host, words[0]); // same word, still on screen
    expect((await towerState(host)).height).toBe(h + 1);
    expect((await towerState(host)).lives[hostId]).toBe(lives0 - 1); // no penalty
  });

  test('boss levels: THE CENSOR enforces on top of the drafted decree', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    await hostGame(host, 'CENSORED', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.evaluate(() => window.__topple.setSettings({ mode: 'ascent' }));
    await host.click('#btn-start');
    await waitTower(host);
    const hostId = await host.evaluate(() => window.__topple.selfId);

    // pin the boss so the test isn't at the mercy of the deal
    await host.evaluate(() => {
      const e = window.__topple.engine;
      e.tower.constraint = { req: ['t'] };
      e.tower.run.boss = 'censor';
      e.broadcastTower();
    });
    await host.waitForFunction(() => window.__topple.state().tower.run.boss === 'censor',
      null, { polling: 50 });
    await expect(host.locator('#decree')).toContainText('NO E');
    await expect(host.locator('#decree')).toHaveClass(/boss/);
    await expect(host.locator('#hdr-status')).toContainText('THE CENSOR');

    // a word obeying the DECREE but breaking the BOSS is refused, and says so
    const decreeOnly = GUESSES.find((w) => w.includes('t') && w.includes('e'));
    await miss(host, decreeOnly);
    await expect(host.locator('#toast')).toContainText('THE CENSOR');

    // a word obeying both stands
    const both = GUESSES.find((w) => w.includes('t') && !w.includes('e'));
    const lives = (await towerState(host)).lives[hostId];
    await climb(host, both);
    expect((await towerState(host)).lives[hostId]).toBe(lives);

    // ...and the drafted decree is still live underneath
    const bossOnly = GUESSES.find((w) => !w.includes('t') && !w.includes('e'));
    await miss(host, bossOnly);
  });

  test('boss levels: THE TAX builds the word and takes a life for it', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    await hostGame(host, 'TAXMAN', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.evaluate(() => window.__topple.setSettings({ mode: 'ascent' }));
    await host.click('#btn-start');
    await waitTower(host);
    const hostId = await host.evaluate(() => window.__topple.selfId);
    await host.evaluate(() => {
      const e = window.__topple.engine;
      e.tower.constraint = {};
      e.tower.run.boss = 'tax';
      e.broadcastTower();
    });

    // a cheap word: it STILL becomes a floor, but it bleeds
    const cheap = GUESSES.find((w) => BOSSES.tax.toll(w));
    const lives0 = (await towerState(host)).lives[hostId];
    const h0 = (await towerState(host)).height;
    await climb(host, cheap);
    await host.waitForFunction((n) => window.__topple.state().tower.lives[window.__topple.selfId] === n - 1,
      lives0, { polling: 50 });
    expect((await towerState(host)).height).toBe(h0 + 1); // built anyway

    // an expensive word costs nothing
    const dear = GUESSES.find((w) => !BOSSES.tax.toll(w) && w !== cheap);
    const lives1 = (await towerState(host)).lives[hostId];
    await climb(host, dear);
    await host.waitForTimeout(200);
    expect((await towerState(host)).lives[hostId]).toBe(lives1);
  });

  test('boss levels: THE SILENCE refuses out-of-turn words without punishing them', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    const code = await hostGame(host, 'VOICE', { ...FAST, rampWords: 999, hungerMs: 600000 });
    await host.evaluate(() => window.__topple.setSettings({ mode: 'ascent' }));
    const guest = await openPage(context);
    await joinGame(guest, code, 'ECHO');
    await host.waitForFunction(() => window.__topple.state().players.length === 2);
    const [hostId, guestId] = await host.evaluate(() =>
      window.__topple.state().players.map((p) => p.id));
    await startGame(host, [host, guest]);
    await waitTower(host); await waitTower(guest);
    await host.evaluate((id) => {
      const e = window.__topple.engine;
      e.tower.constraint = {};
      e.tower.run.boss = 'silence';
      e.tower.run.voice = id;
      e.broadcastTower();
    }, hostId);
    await guest.waitForFunction(() => window.__topple.state().tower.run.voice, null, { polling: 50 });
    await expect(guest.locator('#status-line')).toContainText('THE SILENCE');

    const words = GUESSES.filter((w) => /^[a-z]{5}$/.test(w)).slice(0, 4);
    // the guest speaks out of turn: refused, but NOT a miss
    const guestLives = (await towerState(guest)).lives[guestId];
    const h0 = (await towerState(guest)).height;
    await guest.evaluate((w) => window.__topple.guess(w), words[0]);
    await guest.waitForTimeout(300);
    expect((await towerState(guest)).height).toBe(h0);
    expect((await towerState(guest)).lives[guestId]).toBe(guestLives); // no penalty

    // the host places, and the voice passes to the guest
    await climb(host, words[0]);
    await guest.waitForFunction((id) => window.__topple.state().tower.run.voice === id,
      guestId, { polling: 50 });
    await climb(guest, words[1]);
    expect((await towerState(guest)).height).toBe(h0 + 2);
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

  test('the tower stays on screen while a teammate is buried, and the keyboard never moves', async ({ context }) => {
    test.setTimeout(60000);
    const host = await openPage(context);
    const code = await hostGame(host, 'MEDIC', { ...FAST, rampWords: 999, hungerMs: 600000 });
    const pA = await openPage(context); // will be buried
    await joinGame(pA, code, 'FALLEN');
    const pB = await openPage(context); // bystander: keeps climbing throughout
    await joinGame(pB, code, 'ROGUE');
    await host.waitForFunction(() => window.__topple.state().players.length === 3);
    const aId = await pA.evaluate(() => window.__topple.selfId);
    await startGame(host, [host, pA, pB]);
    await Promise.all([host, pA, pB].map(waitTower));
    await host.evaluate(() => { window.__topple.engine.tower.constraint = {}; });

    const keyboardY = (page) => page.locator('#keyboard').evaluate((el) => el.offsetTop);
    const yBefore = await keyboardY(host);

    await miss(pA, 'zzzzz'); await miss(pA, 'qqqqq'); // two marks is all it takes
    await Promise.all([host, pA, pB].map((p) => p.waitForFunction((id) =>
      !!window.__topple.state().tower.buried[id], aId, { polling: 100 })));

    // burial swaps nothing out: the tower is never replaced by another panel,
    // and the status line only changes visibility, never height
    for (const page of [host, pA, pB]) {
      await expect(page.locator('#tower-scene')).toBeVisible();
      await expect(page.locator('#tower-input')).toBeVisible();
    }
    await expect(host.locator('#status-line')).toBeVisible();
    expect(await keyboardY(host)).toBe(yBefore);

    // everyone still standing keeps climbing normally
    const t = await towerState(pB);
    const [wB] = findWords(t.constraint, [], 1);
    await climb(pB, wB);
    expect((await towerState(pB)).height).toBe(1);

    // and the buried player's own screen is unshifted too
    expect(await keyboardY(pA)).toBe(await keyboardY(pB));
  });

});
