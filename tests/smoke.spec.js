import { test, expect } from '@playwright/test';
import { openPage, hostGame, joinGame, state } from './helpers.js';

test.describe('shell', () => {
  test('menu loads, theme inverts and persists, help opens', async ({ context }) => {
    const page = await openPage(context);
    await expect(page.locator('.big-title')).toContainText('TO-WORD');
    // black on white by default
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
    await page.click('#btn-theme');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
    await page.reload();
    await page.waitForSelector('#scr-menu:not(.hidden)');
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

    await page.click('#btn-help-menu');
    await expect(page.locator('#ovl-help')).toBeVisible();
    await page.click('#btn-help-close');
    await expect(page.locator('#ovl-help')).toBeHidden();
  });

  test('host makes a room, a guest joins by code, roster syncs both ways', async ({ context }) => {
    const host = await openPage(context);
    const code = await hostGame(host, 'HOST');
    expect(code).toMatch(/^[A-Z0-9]{4}$/);

    const guest = await openPage(context);
    await joinGame(guest, code, 'GUEST');
    await host.waitForFunction(() => window.__toword.state().players.length === 2);
    await guest.waitForFunction(() => window.__toword.state().players.length === 2);

    const names = (await state(host)).players.map((p) => p.name);
    expect(names).toEqual(['HOST', 'GUEST']);
    // only the host drives settings
    expect((await state(guest)).hostId).toBe((await state(host)).selfId);
    await expect(guest.locator('#btn-start')).toBeHidden();
  });

  test('a bad room code fails cleanly instead of hanging', async ({ context }) => {
    test.setTimeout(45000);
    const page = await openPage(context);
    await page.fill('#inp-name', 'LOST');
    await page.fill('#inp-code', 'ZZZZ');
    await page.click('#btn-join');
    await page.waitForSelector('#scr-dead:not(.hidden)', { timeout: 20000 });
    await expect(page.locator('#dead-msg')).toContainText('ZZZZ');
  });
});
