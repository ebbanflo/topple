// Shared E2E helpers. Every test runs the real site over LocalTransport
// (?t=local) with the debug handle (?debug=1). All pages share ONE browser
// context so BroadcastChannel connects them like tabs of one machine.

export const BASE = '/index.html?t=local&debug=1';

export async function openPage(context) {
  const page = await context.newPage();
  await page.goto(BASE);
  await page.waitForSelector('#scr-menu:not(.hidden)');
  return page;
}

// Fast settings used by most runs (humans get slower beats; tests don't).
export const FAST = { revealMs: 350, countdownMs: 120 };

export async function hostGame(page, name, settings) {
  await page.fill('#inp-name', name);
  await page.click('#btn-host');
  await page.waitForSelector('#scr-lobby:not(.hidden)');
  const code = (await page.textContent('#room-code')).trim();
  if (settings) await setSettings(page, settings);
  return code;
}

export async function joinGame(page, code, name) {
  await page.fill('#inp-name', name);
  await page.fill('#inp-code', code);
  await page.click('#btn-join');
  await page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 15000 });
}

export async function joinViaLink(context, code, name) {
  const page = await context.newPage();
  await page.addInitScript((n) => localStorage.setItem('toword-name', n), name);
  await page.goto(`/index.html?t=local&debug=1&join=${code}`);
  await page.waitForSelector('#scr-lobby:not(.hidden)', { timeout: 15000 });
  return page;
}

export const state = (page) => page.evaluate(() => window.__toword.state());
export const engineState = (page) => page.evaluate(() => window.__toword.engineState());
export const setSettings = (page, s) => page.evaluate((x) => window.__toword.setSettings(x), s);
export const setScore = (page, pid, n) => page.evaluate(([p, v]) => window.__toword.setScore(p, v), [pid, n]);
export const selfId = (page) => page.evaluate(() => window.__toword.selfId);
export const buy = (page, item, target) =>
  page.evaluate(([i, t]) => window.__toword.buy(i, t), [item, target]);

export async function startGame(hostPage, pages) {
  await hostPage.click('#btn-start');
  for (const p of pages) {
    await p.waitForFunction(() => window.__toword.state().started);
  }
}

const POLL = { polling: 100 }; // background pages throttle rAF; poll by clock

export const towerState = (page) => page.evaluate(() => window.__toword.state().tower);
export const usedWords = (page) =>
  page.evaluate(() => window.__toword.state().tower.rows.map((r) => r.word));

export const waitTower = (page) =>
  page.waitForFunction(() => !!window.__toword.state().tower, null, POLL);

export const waitGameOver = (page) =>
  page.waitForFunction(() => window.__toword.state().over, null, POLL);

// Place a word and wait for the host's TOWER_WORD to land back in this page.
export async function climb(page, word) {
  const before = (await towerState(page)).height;
  await page.evaluate((w) => window.__toword.guess(w), word);
  await page.waitForFunction((h) => window.__toword.state().tower?.height === h + 1, before, { polling: 50 });
}

// Submit a word the host will reject, and wait for the life to come off.
export async function miss(page, word) {
  const lives = await page.evaluate(() => window.__toword.state().tower.lives[window.__toword.selfId]);
  await page.evaluate((w) => window.__toword.guess(w), word);
  await page.waitForFunction((n) => {
    const st = window.__toword.state();
    return st.tower?.lives[st.selfId] === n - 1;
  }, lives, { polling: 50 });
}

export const wireLog = (page) => page.evaluate(() => window.__wireLog.slice());
