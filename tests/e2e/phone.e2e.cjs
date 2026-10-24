// Phones and tablets: the management screens keep their actions on screen. Sign and Sell (and
// the price) stay visible in the transfer tables, the open tab is never cut off in the tab bar,
// tapping a player on Training brings his attributes into view, the result dialog shows the
// rewards before the stats, and management controls are at least 44 px tall on touch.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, startRanked } = require('./lib/helpers.cjs');

const PHONE = { width: 390, height: 844 };

/** How many pixels of `el` show inside its scroll box, and how wide it is. */
const visibleIn = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    const box = el.closest('.table-scroll').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { shown: Math.round(Math.min(r.right, box.right) - Math.max(r.left, box.left)), width: Math.round(r.width) };
  }, sel);

for (const size of [PHONE, { width: 768, height: 1024 }]) {
  test(`phone: at ${size.width}px Sign, Sell and the ladder's Elo are fully on screen`, async (t) => {
    const page = await openApp(t, size);
    await goTab(page, 'transfers');
    const sign = await visibleIn(page, `${SEL.buy}`);
    expect(sign.shown, `Sign button visible (${JSON.stringify(sign)})`).toBe(sign.width);
    const sell = await visibleIn(page, SEL.sellAny);
    expect(sell.shown, `Sell button visible (${JSON.stringify(sell)})`).toBe(sell.width);
    await goTab(page, 'ladder');
    const elo = await visibleIn(page, '.ladder tbody tr td:last-child');
    expect(elo.shown, `Elo column visible (${JSON.stringify(elo)})`).toBe(elo.width);
  });
}

test('phone: the open tab stays in view in the scrolled tab bar', async (t) => {
  const page = await openApp(t, PHONE);
  for (const screen of ['training', 'competitions', 'club', 'squad']) {
    await goTab(page, screen);
    const fits = await page.evaluate(() => {
      const bar = document.querySelector('.tabs').getBoundingClientRect();
      const tab = document.querySelector('.tab.on').getBoundingClientRect();
      return tab.left >= bar.left && tab.right <= bar.right;
    });
    expect(fits, `${screen} tab fully visible`).toBe(true);
  }
});

test('phone: tapping a player on Training brings his attributes into view', async (t) => {
  const page = await openApp(t, PHONE);
  await goTab(page, 'training');
  await page.locator('.roster-btn').nth(6).click();
  await page.waitForFunction(() => {
    const r = document.querySelector('.panel.trainee').getBoundingClientRect();
    return r.top >= -2 && r.top < innerHeight / 2;
  }, null, { timeout: 5000 });
});

test('phone: the result dialog shows the rewards before the stats, with the Elo chip on screen', async (t) => {
  const page = await openApp(t, { ...PHONE, prefs: { halfSeconds: 3 } });
  await startRanked(page);
  await page.locator(SEL.modalClose).waitFor({ timeout: 60_000 });
  const pos = await page.evaluate(() => {
    const view = document.querySelector('.modal .rs-scroll').getBoundingClientRect();
    const elo = document.querySelector('.modal .rs-elo').getBoundingClientRect();
    const stats = document.querySelector('.modal .rs-stats-panel').getBoundingClientRect();
    return { eloBottom: elo.bottom, viewBottom: view.bottom, rewardsFirst: elo.top < stats.top };
  });
  expect(pos.rewardsFirst, 'rewards above the stats').toBe(true);
  expect(pos.eloBottom <= pos.viewBottom, `Elo chip visible without scrolling (${JSON.stringify(pos)})`).toBe(true);
  expect(await page.locator('.modal .rs-scroll').getAttribute('tabindex'), 'the scrolling part is a keyboard stop').toBe('0');
});

test('phone: management controls are at least 44 px tall on touch', async (t) => {
  const page = await openApp(t, { ...PHONE, hasTouch: true });
  for (const screen of ['home', 'squad', 'transfers', 'training', 'club']) {
    await goTab(page, screen);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('main button, main select, main input[type="text"], .tabs .tab')]
        .filter((e) => e.getClientRects().length)
        .map((e) => ({ what: `${e.tagName.toLowerCase()} ${(e.textContent || e.id || '').trim().slice(0, 24)}`, h: Math.round(e.getBoundingClientRect().height) }))
        .filter((x) => x.h < 44),
    );
    expect(small.length, `${screen}: small targets ${JSON.stringify(small)}`).toBe(0);
  }
});
