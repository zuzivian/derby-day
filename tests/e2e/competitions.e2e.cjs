// Competitions: start the cup and the league, play a tie live, check the bracket,
// the table, and that the ladder record does not move (Elo does).

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, readSave } = require('./lib/helpers.cjs');

const C = {
  startCup: '[data-action="comp-start-cup"]',
  startSeason: '[data-action="comp-start-season"]',
  playCup: '[data-action="comp-play"][data-kind="cup"]',
  playSeason: '[data-action="comp-play"][data-kind="season"]',
  simCup: '[data-action="comp-sim-cup"]',
  bracket: '.bracket',
  tie: '.bracket .tie',
  table: '.league-table',
};

test('cup: forfeiting a quarter-final knocks you out, the rest simulates, Elo drops but not the ladder record', async (t) => {
  const page = await openApp(t);
  await goTab(page, 'competitions');
  await page.locator(C.startCup).click();
  expect(await page.locator(C.tie).count(), 'bracket ties (4 QF + 2 SF + final)').toBe(7);
  const before = await readSave(page);
  expect(before.cup.rounds[0].length, 'quarter-finals').toBe(4);

  await page.locator(C.playCup).click();
  await page.waitForSelector(SEL.pitch);
  await page.keyboard.press('Escape');
  expect(await page.locator(SEL.forfeit).innerText(), 'forfeit warns about the score').toMatch(/0–3/);
  await page.locator(SEL.forfeit).click(); // arm; the second press confirms
  await page.locator(SEL.forfeit).click();
  await page.locator(SEL.modal).waitFor();
  expect(await page.locator(SEL.modal).innerText(), 'result names the round').toMatch(/quarter-final/i);

  const after = await readSave(page);
  expect(after.club.elo, 'a forfeit costs Elo, like a ranked one').toBeLessThan(before.club.elo);
  expect(after.club.played, 'ladder record unchanged').toBe(before.club.played);
  expect(after.history.at(-1).competition, 'history label').toBe('Cup quarter-final');
  expect(after.cup.round, 'cup moved on to the semis').toBe(1);

  await page.locator(SEL.modalClose).click();
  await page.locator(C.simCup).click();
  const done = await readSave(page);
  expect(done.cup.done, 'cup finished').toBe(true);
  expect(done.cup.winner === done.club.id, 'someone else won').toBe(false);
});

test('league: starting a season shows an 8-row table with real headers and a next fixture', async (t) => {
  const page = await openApp(t, { width: 390, height: 844 });
  await goTab(page, 'competitions');
  await page.locator(C.startSeason).click();
  expect(await page.locator(`${C.table} tbody tr`).count(), 'table rows').toBe(8);
  expect(await page.locator(`${C.table} thead th[scope="col"]`).count(), 'column headers').toBeGreaterThanOrEqual(8);
  expect(await page.locator(C.playSeason).count(), 'play button').toBe(1);
  const s = await readSave(page);
  expect(s.season.matchdays.length, 'matchdays').toBe(7);
});

// WCAG relative luminance contrast of two "rgb(r, g, b)" strings.
const contrast = (a, b) => {
  const lum = (c) => {
    const [r, g, bl] = c.match(/\d+(\.\d+)?/g).slice(0, 3).map((v) => {
      const x = Number(v) / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('competitions: the stakes line and DERBY pill on the fixture card are readable in light, dark and more-contrast', async (t) => {
  for (const colorScheme of ['light', 'dark']) {
    for (const contrastPref of ['no-preference', 'more']) {
      const page = await openApp(t, { width: 390, height: 844, colorScheme });
      await page.emulateMedia({ colorScheme, contrast: contrastPref });
      await goTab(page, 'competitions');
      await page.locator(C.startCup).click();
      await page.locator('.comp-next .story-win').waitFor();
      const r = await page.evaluate(() => {
        const card = document.querySelector('.comp-next');
        const bg = getComputedStyle(document.documentElement).getPropertyValue('--surface-2');
        const probe = document.createElement('i');
        probe.style.color = bg.trim();
        card.appendChild(probe);
        const cardBg = getComputedStyle(probe).color;
        probe.remove();
        const story = getComputedStyle(card.querySelector('.story-win')).color;
        const derby = card.querySelector('.derby');
        return { cardBg, story, derby: derby ? [getComputedStyle(derby).color, getComputedStyle(derby).backgroundColor] : null };
      });
      const label = `${colorScheme}/${contrastPref}`;
      expect(contrast(r.story, r.cardBg), `${label}: stakes line contrast on the card`).toBeGreaterThanOrEqual(4.5);
      if (r.derby) expect(contrast(r.derby[0], r.derby[1]), `${label}: DERBY pill contrast`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('competitions: on a phone Cup and League chips jump to each panel; starting a competition lands on its heading, clear of the toast', async (t) => {
  const page = await openApp(t, { width: 390, height: 844, hasTouch: true });
  await goTab(page, 'competitions');
  const chips = page.locator('.comp-jump .chip');
  expect(await chips.allInnerTexts(), 'two anchor chips').toEqual(['Cup', 'League']);
  expect(Math.round((await chips.first().boundingBox()).height), 'chip is a 44 px target (rounded: layout can land at 43.99998)').toBeGreaterThanOrEqual(44);
  await chips.nth(1).click();
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'season-title');
  await page.waitForTimeout(900); // the smooth scroll settles

  await page.locator(C.startCup).scrollIntoViewIfNeeded();
  await page.locator(C.startCup).click();
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'cup-title');
  await page.waitForSelector('.toast');
  await page.waitForTimeout(400);
  const r = await page.evaluate(() => ({
    head: document.getElementById('cup-title').getBoundingClientRect(),
    next: document.querySelector('.comp-next').getBoundingClientRect(),
    toast: document.querySelector('.toast').getBoundingClientRect(),
    h: innerHeight,
  }));
  expect(r.head.top, 'heading is on screen').toBeGreaterThanOrEqual(0);
  expect(r.next.top, 'fixture card starts below the toast').toBeGreaterThanOrEqual(r.toast.bottom);
  expect(r.next.top, 'fixture card is in view').toBeLessThan(r.h - 100);
});

test('competitions: tabs and the level badge are 44 px targets on touch screens', async (t) => {
  for (const [w, h] of [[390, 844], [750, 342]]) {
    const page = await openApp(t, { width: w, height: h, hasTouch: true });
    const r = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('.tabs .tab')].map((e) => Math.round(e.getBoundingClientRect().height));
      const badge = document.querySelector('button.level-badge');
      const bb = badge.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(badge, '::before').top) || 0; // negative: the hit area extends past the badge
      return { tabs, badge: Math.round(bb.height - 2 * inset) };
    });
    for (const x of r.tabs) expect(x, `${w}x${h}: tab height`).toBeGreaterThanOrEqual(44);
    expect(r.badge, `${w}x${h}: level badge hit area`).toBeGreaterThanOrEqual(44);
  }
});
