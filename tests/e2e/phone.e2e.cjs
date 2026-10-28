// Phones and tablets: the management screens keep their actions on screen. Sign and Sell (and
// the price) stay visible in the transfer tables, the open tab is never cut off in the tab bar,
// tapping a player on Training brings his attributes into view, the result dialog shows the
// rewards before the stats, and management controls are at least 44 px tall on touch.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, startRanked, totalXpForLevel } = require('./lib/helpers.cjs');

const PHONE = { width: 390, height: 844 };

/** How many pixels of `el` show inside its scroll box, and how wide it is. */
const visibleIn = (page, sel) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    const box = el.closest('.table-scroll').getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { shown: Math.round(Math.min(r.right, box.right) - Math.max(r.left, box.left)), width: Math.round(r.width) };
  }, sel);

/** Each transfer table: does it fit its box, and are the money cell and the button of the first row fully shown? */
const tableFit = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.table-scroll')].map((box) => {
      const b = box.getBoundingClientRect();
      const row = box.querySelector('tbody tr');
      const cells = [...row.children].filter((c) => c.getClientRects().length);
      const inside = (el) => { const r = el.getBoundingClientRect(); return r.left >= b.left - 0.5 && r.right <= b.right + 0.5; };
      const money = cells[cells.length - 2];
      return { scroll: box.scrollWidth, client: box.clientWidth, money: money.textContent.trim(), moneyShown: inside(money), buttonShown: inside(cells[cells.length - 1].querySelector('button')) };
    }),
  );

for (const size of [{ width: 320, height: 640 }, { width: 360, height: 740 }, PHONE, { width: 768, height: 1024 }]) {
  test(`phone: at ${size.width}px the transfer tables fit, with the price and the Sign/Sell button fully on screen`, async (t) => {
    const page = await openApp(t, size);
    await goTab(page, 'transfers');
    const fit = await tableFit(page);
    expect(fit.length, 'market and sell tables').toBe(2);
    for (const [i, f] of fit.entries()) {
      const what = `${i ? 'sell' : 'market'} table ${JSON.stringify(f)}`;
      expect(f.scroll, `${what}: no sideways scroll`).toBe(f.client);
      expect(f.money.startsWith('ƒ') && f.moneyShown, `${what}: price/offer visible`).toBe(true);
      expect(f.buttonShown, `${what}: button visible`).toBe(true);
    }
    // Confirm sale fits too.
    await page.locator(SEL.sellAny).first().click();
    const confirm = await tableFit(page);
    expect(confirm[1].scroll, `sell table with Confirm ${JSON.stringify(confirm[1])}`).toBe(confirm[1].client);
    await goTab(page, 'ladder');
    const elo = await visibleIn(page, '.ladder tbody tr td:last-child');
    expect(elo.shown, `Elo column visible (${JSON.stringify(elo)})`).toBe(elo.width);
  });
}

test('tablet: at 768px the Squad table keeps its attribute columns (it scrolls instead)', async (t) => {
  const page = await openApp(t, { width: 768, height: 1024 });
  await goTab(page, 'squad');
  const shown = await page.evaluate(() => [...document.querySelectorAll('.tbl thead th')].filter((th) => th.getClientRects().length).map((th) => th.textContent.trim()));
  for (const col of ['Nation', 'Age', 'POT', 'PAC', 'GK']) expect(shown.includes(col), `${col} column shown (${shown.join(' ')})`).toBe(true);
});

test('200% zoom (640x400): the result dialog scrolls with the keyboard straight away', async (t) => {
  const page = await openApp(t, { width: 640, height: 400, prefs: { halfSeconds: 3 }, fast: true });
  await startRanked(page);
  await page.locator(SEL.modalClose).waitFor({ timeout: 60_000 });
  const scroller = page.locator('.modal .rs-scroll');
  const before = await scroller.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  expect(before.max > 0, `the result needs scrolling at this size (${JSON.stringify(before)})`).toBe(true);
  await page.keyboard.press('PageDown');
  // Chromium animates Page Down; wait for it rather than a fixed time.
  await page.waitForFunction((from) => document.querySelector('.modal .rs-scroll').scrollTop > from, before.top, { timeout: 5000 }).catch(() => {});
  const after = await scroller.evaluate((el) => el.scrollTop);
  expect(after > before.top, `Page Down scrolled the result (${before.top} -> ${after})`).toBe(true);
  const foot = await page.locator('.modal .rs-foot').boundingBox();
  expect(foot.height <= 120, `compact footer at 400 px tall (${Math.round(foot.height)} px)`).toBe(true);
});

test('toasts sit at the top, clear of the result dialog\'s button', async (t) => {
  const page = await openApp(t, { prefs: { halfSeconds: 3 }, fast: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await startRanked(page);
  await page.locator(SEL.modalClose).waitFor({ timeout: 60_000 });
  await page.locator('.modal [data-replay="copy"]').click();
  await page.locator(SEL.toast).waitFor();
  const [toast, btn] = await Promise.all([page.locator(SEL.toast).boundingBox(), page.locator(SEL.modalClose).boundingBox()]);
  expect(toast.y + toast.height <= btn.y || toast.y >= btn.y + btn.height, 'toast does not overlap Back to the club').toBe(true);
  expect(await page.locator(SEL.toast).innerText(), 'no code size in the toast').toBe('Replay code copied.');
});

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
  const page = await openApp(t, { ...PHONE, prefs: { halfSeconds: 3 }, fast: true });
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

test('phone: at 320px a long surname ends in an ellipsis, never breaks mid-word', async (t) => {
  const page = await openApp(t, { width: 320, height: 640, mutateSave: (s) => { s.squad.forEach((p, i) => { if (i % 3 === 0) p.last = 'Falkelbrandsteiner'; }); } });
  await goTab(page, 'transfers');
  const cells = await page.evaluate(() =>
    [...document.querySelectorAll('.table-scroll')[1].querySelectorAll('.name-text')]
      .filter((el) => el.textContent.includes('Falkelbrandsteiner'))
      .map((el) => {
        const node = el.firstChild;
        const at = node.textContent.indexOf('Falkelbrandsteiner');
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + 'Falkelbrandsteiner'.length);
        const cs = getComputedStyle(el);
        return { lines: new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size, ellipsis: cs.textOverflow, wrap: cs.overflowWrap };
      }),
  );
  expect(cells.length > 0, 'long surnames in the Sell table').toBe(true);
  for (const c of cells) {
    expect(c.lines, `the surname stays on one line (${JSON.stringify(c)})`).toBe(1);
    expect(c.ellipsis, 'ellipsis when it does not fit').toBe('ellipsis');
    expect(c.wrap, 'no mid-word breaking').toBe('normal');
  }
  const fit = await tableFit(page);
  for (const f of fit) expect(f.scroll, `table still fits ${JSON.stringify(f)}`).toBe(f.client);
});

test('phone: a toast sits below the club header, not over the wordmark and club name', async (t) => {
  // Signing moves focus to the new player's Sell button, so the page scrolls; scroll back up while the toast shows.
  const page = await openApp(t, PHONE);
  await goTab(page, 'transfers');
  await page.locator(`${SEL.buy}:not([aria-disabled])`).first().click();
  await page.locator(SEL.toast).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400); // the slide-in
  const pos = await page.evaluate(() => ({ toast: document.querySelector('.toast').getBoundingClientRect().top, header: document.querySelector('.topbar').getBoundingClientRect().bottom }));
  expect(pos.toast >= pos.header, `toast below the header (${JSON.stringify(pos)})`).toBe(true);
});

test('phone: at 320x568 the XP card and its Level up are on screen when the result opens', async (t) => {
  const page = await openApp(t, { width: 320, height: 568, prefs: { halfSeconds: 3 }, fast: true, xp: totalXpForLevel(31) - 40 });
  await startRanked(page);
  await page.locator(SEL.modalClose).waitFor({ timeout: 60_000 });
  const box = await page.evaluate(() => {
    const view = document.querySelector('.modal .rs-scroll').getBoundingClientRect();
    const card = document.querySelector('.modal .xp-card').getBoundingClientRect();
    return { cardTop: card.top, cardBottom: card.bottom, viewTop: view.top, viewBottom: view.bottom, levelUp: !!document.querySelector('.modal .xp-level') };
  });
  expect(box.levelUp, 'this result levels up').toBe(true);
  expect(box.cardTop >= box.viewTop && box.cardBottom <= box.viewBottom, `XP card fully visible (${JSON.stringify(box)})`).toBe(true);
});
