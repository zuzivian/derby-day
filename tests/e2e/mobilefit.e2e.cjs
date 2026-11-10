// Phone layout fixes from the mobile audit: landscape Home and the welcome card fit with no sideways pan or scroll, the
// portrait status strip shows every chip, the first-match actions stay on screen, the landscape pause menu fits, and
// the open tab is never half-clipped in the tab bar.

const { test, expect } = require('./lib/harness.cjs');
const { APP_URL, SEL, PREFS_KEY, openApp, goTab, pageWidths } = require('./lib/helpers.cjs');

const LAND = { width: 750, height: 342 }; // iPhone 13 landscape, minus Safari's bars
const PORT = { width: 390, height: 844 };

const rect = (page, sel) =>
  page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  }, sel);

test('mobilefit: landscape Home at 750x342 has no horizontal overflow and its status strip needs no scrolling', async (t) => {
  const page = await openApp(t, LAND);
  const w = await pageWidths(page);
  expect(w.scrollWidth, `page width ${JSON.stringify(w)}`).toBeLessThanOrEqual(w.innerWidth);
  const strip = await page.locator(SEL.statusStrip).evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(strip.sw, `status strip scrolls: ${JSON.stringify(strip)}`).toBeLessThanOrEqual(strip.cw + 1);
});

test('mobilefit: landscape welcome loads at the top with the heading and Kick off both on screen', async (t) => {
  const page = await t.newPage({ viewport: LAND, hasTouch: true });
  await page.goto(APP_URL);
  await page.waitForSelector('#ob-kickoff');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY), 'page is not scrolled by autofocus').toBe(0);
  const title = await rect(page, '#ob-title');
  const kick = await rect(page, '#ob-kickoff');
  const skip = await rect(page, '[data-action="skip-onboarding"]');
  expect(title.top, 'heading below the top edge').toBeGreaterThanOrEqual(0);
  expect(skip.top, "I've played before is on screen").toBeGreaterThanOrEqual(0);
  expect(kick.bottom, `Kick off inside the viewport ${JSON.stringify(kick)}`).toBeLessThanOrEqual(LAND.height);
});

test('mobilefit: portrait phone status strip wraps and shows every chip, no scroller', async (t) => {
  const page = await openApp(t, PORT);
  const info = await page.locator(SEL.statusStrip).evaluate((el) => {
    const box = el.getBoundingClientRect();
    return {
      sw: el.scrollWidth, cw: el.clientWidth, mask: getComputedStyle(el).maskImage,
      chips: [...el.children].filter((c) => c.getClientRects().length).map((c) => { const r = c.getBoundingClientRect(); return { l: Math.round(r.left - box.left), r: Math.round(r.right - box.left), w: Math.round(box.width) }; }),
    };
  });
  expect(info.sw, `no sideways scroll ${JSON.stringify(info)}`).toBeLessThanOrEqual(info.cw + 1);
  expect(info.mask === 'none' || info.mask === '', `no fade mask (${info.mask})`).toBe(true);
  expect(info.chips.length, 'chips').toBeGreaterThanOrEqual(4);
  for (const c of info.chips) expect(c.r <= c.w + 1 && c.l >= -1, `chip inside the strip ${JSON.stringify(c)}`).toBe(true);
  // The XP figures show whole: "Level N · " is left to the badge (and screen readers), so nothing ellipsizes.
  const xp = await page.locator('.status-strip .xp-text').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, name: el.textContent }));
  expect(xp.sw, `XP text fits ${JSON.stringify(xp)}`).toBeLessThanOrEqual(xp.cw + 1);
  expect(xp.name, 'the accessible text still names the level').toMatch(/^Level \d+ · /);
});

test('mobilefit: portrait coach tip stays clear of the camera and zoom buttons, which have names', async (t) => {
  const page = await t.newPage({ viewport: PORT, hasTouch: true, isMobile: true });
  await page.addInitScript(() => { window.__e2e = true; });
  await page.goto(APP_URL);
  await page.waitForSelector('#ob-kickoff');
  await page.click('#ob-kickoff');
  await page.waitForSelector('.coach-tip:not([hidden])', { timeout: 30_000 });
  await page.waitForTimeout(600);
  const tip = await rect(page, '.coach-tip');
  for (const sel of ['[data-zoom="1"]', '[data-zoom="-1"]', '.pitch-cam', '.hud-menu']) {
    const r = await rect(page, sel);
    expect(tip.top - r.bottom, `tip (${JSON.stringify(tip)}) clear of ${sel} ${JSON.stringify(r)}`).toBeGreaterThanOrEqual(12);
  }
  expect(await page.locator('[data-zoom="1"]').getAttribute('aria-label'), 'zoom out name').toMatch(/^Zoom out/);
  expect(await page.locator('[data-zoom="-1"]').getAttribute('aria-label'), 'zoom in name').toMatch(/^Zoom in/);
});

for (const [name, vp, touch] of [['portrait', PORT, { isMobile: true }], ['landscape', LAND, {}]]) {
  test(`mobilefit: first-match celebration keeps Go to Home on screen (${name} phone)`, async (t) => {
    const page = await t.newPage({ viewport: vp, hasTouch: true, ...touch });
    await page.addInitScript((key) => { window.__e2e = true; window.__e2eSpeed = 8; localStorage.setItem(key, JSON.stringify({ halfSeconds: 20 })); }, PREFS_KEY);
    await page.goto(APP_URL);
    await page.waitForSelector('#ob-kickoff');
    await page.click('#ob-kickoff');
    await page.waitForSelector('.ob-celebrate', { timeout: 120_000 });
    await page.waitForTimeout(800);
    const btn = await rect(page, '[data-ob="skip"]');
    expect(btn.bottom, `Go to Home inside the viewport ${JSON.stringify(btn)}`).toBeLessThanOrEqual(vp.height);
    expect(btn.top, 'and below the top').toBeGreaterThanOrEqual(0);
    if (name === 'portrait') expect(btn.right - btn.left, 'full width primary').toBeGreaterThan(vp.width - 80);
    const w = await pageWidths(page);
    expect(w.scrollWidth, 'no sideways scroll').toBeLessThanOrEqual(w.innerWidth);
  });
}

test('mobilefit: landscape pause menu shows Controls and help inside the card at 750x342', async (t) => {
  const page = await t.newPage({ viewport: LAND, hasTouch: true, isMobile: true });
  await page.addInitScript(() => { window.__e2e = true; });
  await page.goto(APP_URL);
  await page.waitForSelector('#ob-kickoff');
  await page.click('#ob-kickoff');
  await page.waitForSelector('#pitch');
  await page.waitForTimeout(1500);
  await page.locator('.hud-menu').click();
  await page.waitForSelector('.pause-card');
  await page.waitForTimeout(400);
  const card = await rect(page, '.pause-card');
  const sum = await rect(page, '.pause-card .help-controls summary');
  expect(sum.bottom, `summary ${JSON.stringify(sum)} inside card ${JSON.stringify(card)}`).toBeLessThanOrEqual(card.bottom);
  expect(sum.bottom, 'and inside the viewport').toBeLessThanOrEqual(LAND.height);
});

test('mobilefit: after a tab change the open tab is fully inside the scrolling tab bar', async (t) => {
  const page = await openApp(t, PORT);
  for (const screen of ['competitions', 'club', 'training']) {
    await goTab(page, screen);
    const fit = await page.evaluate(() => {
      const tab = document.querySelector('.tab[aria-current="page"]');
      const r = tab.getBoundingClientRect();
      const b = tab.parentElement.getBoundingClientRect();
      return { l: Math.round(r.left - b.left), r: Math.round(r.right - b.right), id: tab.dataset.screen };
    });
    expect(fit.l >= 0 && fit.r <= 0, `${screen} tab inside the bar ${JSON.stringify(fit)}`).toBe(true);
  }
});
