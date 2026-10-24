// Progression: the tenth counted match ends the season. The review modal appears after the result,
// the calendar moves on, and academy prospects the squad has no room for can be signed by releasing someone.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, readSave, pageWidths } = require('./lib/helpers.cjs');

const R = {
  review: '[aria-labelledby="review-title"]',
  close: '[data-action="review-close"]',
  reopen: '[data-action="review-open"]',
  sign: '[data-action="review-sign"]',
  stars: '[aria-label^="Scouting estimate"]',
};

/** Nine weeks played, a full squad of 25-year-olds (nobody retires, so every prospect is only offered). */
function nearSeasonEndFullSquad(save) {
  save.week = 9;
  save.year = 1;
  save.squad.forEach((p) => (p.age = 25));
  let i = 0;
  while (save.squad.length < 14) {
    const c = JSON.parse(JSON.stringify(save.squad[i++ % 6]));
    c.id = `clone${i}`;
    c.number = 60 + i;
    c.age = 25;
    save.squad.push(c);
  }
}

/** A ranked match that ends at once by forfeiting (still counted: 0-3). */
async function forfeitRanked(page) {
  await goTab(page, 'club');
  await page.locator(SEL.playRanked).click();
  await page.waitForSelector(SEL.pitch);
  await page.keyboard.press('Escape');
  await page.locator(SEL.forfeit).click();
  await page.locator(SEL.modalClose).waitFor();
}

test('the 10th counted match rolls the season over and shows the review after the result', async (t) => {
  const page = await openApp(t, { width: 390, height: 844, mutateSave: (save) => ((save.week = 9), (save.year = 1)) });
  const before = await readSave(page);
  expect(before.week, 'week before').toBe(9);
  await forfeitRanked(page);

  const after = await readSave(page);
  expect(after.year, 'year advanced').toBe(2);
  expect(after.week, 'week counted').toBe(10);
  expect(after.review.year, 'review is for year 1').toBe(1);
  expect(await page.locator(R.review).count(), 'review waits behind the result').toBe(0);

  await page.locator(SEL.modalClose).click();
  await page.locator(R.review).waitFor();
  const text = await page.locator(R.review).innerText();
  expect(text, 'title').toMatch(/Season 1 review/i);
  expect(text, 'record section').toMatch(/\dW \dD \dL/);
  expect(text, 'changes section').toMatch(/Who changed/i);
  expect(text, 'academy section').toMatch(/Academy intake/i);
  expect(await page.locator(R.stars).count(), 'prospects show a star rating').toBeGreaterThan(1);
  expect(text, 'fogged potential range').toMatch(/POT \d+–\d+/);
  const w = await pageWidths(page);
  expect(w.scrollWidth, 'no horizontal scroll at 390px').toBeLessThanOrEqual(w.innerWidth);

  await page.locator(R.close).click();
  await page.locator(R.review).waitFor({ state: 'detached' });
  expect((await readSave(page)).review.seen, 'dismissal is saved').toBe(true);
  // It can be reopened from the club screen.
  await page.locator(R.reopen).click();
  await page.locator(R.review).waitFor();
});

test('a full squad is only offered prospects; you can release someone to sign one', async (t) => {
  // Level 14: the calendar is on and the squad cap is still 14 (level 15 adds a place).
  const page = await openApp(t, { level: 14, mutateSave: nearSeasonEndFullSquad });
  await forfeitRanked(page);
  await page.locator(SEL.modalClose).click();
  await page.locator(R.review).waitFor();
  const s = await readSave(page);
  expect(s.squad.length, 'squad stays at the cap').toBe(14);
  expect(s.offers.length, 'prospects are held as offers').toBeGreaterThan(1);

  await page.locator(R.close).click();
  await goTab(page, 'squad');
  const offer = s.offers[0];
  expect(await page.locator(`[data-offer="${offer.id}"]`).count(), 'academy panel lists the offer').toBe(1);
  await page.locator(`[data-offer="${offer.id}"] ${R.sign}`).click();
  await page.locator(SEL.toast).waitFor();
  const done = await readSave(page);
  expect(done.squad.length, 'squad still at the cap').toBe(14);
  expect(done.squad.some((p) => p.id === offer.id), 'prospect signed').toBe(true);
  expect(done.offers.length, 'offer taken').toBe(s.offers.length - 1);
  expect(done.budget, 'release was free').toBe(s.budget);
});
