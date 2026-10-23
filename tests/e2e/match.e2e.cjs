// Matches: a short ranked game end to end, pausing, forfeiting, and keyboard-only start.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, headerElo, openApp, goTab, readSave, startRanked } = require('./lib/helpers.cjs');

const SHORT = { halfSeconds: 3 };

test('a short ranked match reaches the result modal, updates Elo, and closing returns to the club', async (t) => {
  const page = await openApp(t, { prefs: SHORT });
  const before = await readSave(page);
  const eloBefore = await headerElo(page);
  expect(eloBefore, 'header Elo matches save before the match').toBe(before.club.elo);

  await startRanked(page);
  // Two 3 second halves, half-time and the full-time pause; no input needed.
  await page.locator(SEL.modal).waitFor({ timeout: 60_000 });

  const after = await readSave(page);
  expect(after.history.length, 'one match recorded').toBe(before.history.length + 1);
  const rec = after.history.at(-1);
  expect(rec.ranked, 'recorded as ranked').toBe(true);
  expect(rec.eloBefore, 'record eloBefore').toBe(eloBefore);
  expect(after.club.elo, 'save Elo equals record').toBe(rec.eloAfter);
  expect(after.club.played, 'played count').toBe(before.club.played + 1);
  expect(await headerElo(page), 'header Elo reflects the change').toBe(rec.eloAfter);

  const modalText = await page.locator(SEL.modal).innerText();
  expect(modalText, 'modal shows the score').toContain(`${rec.goalsFor}`);
  expect(modalText, 'modal shows the new Elo').toContain(String(rec.eloAfter));

  await page.locator(SEL.modalClose).click();
  await page.locator(SEL.modal).waitFor({ state: 'detached' });
  expect(await page.locator(SEL.playRanked).count(), 'back on the club screen').toBe(1);
  expect(await page.locator(SEL.pitch).count(), 'pitch is gone').toBe(0);
  expect(await headerElo(page), 'header Elo still correct after closing').toBe(rec.eloAfter);
});

test('Escape pauses with the overlay and Resume hides it', async (t) => {
  const page = await openApp(t);
  await startRanked(page);
  expect(await page.locator(SEL.pause).isVisible(), 'overlay hidden at kick-off').toBe(false);
  await page.keyboard.press('Escape');
  await page.locator(SEL.pause).waitFor({ state: 'visible' });
  await page.locator(SEL.resume).click();
  await page.locator(SEL.pause).waitFor({ state: 'hidden' });
  // Pausing again with Escape toggles it back off.
  await page.keyboard.press('Escape');
  await page.locator(SEL.pause).waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.locator(SEL.pause).waitFor({ state: 'hidden' });
});

test('forfeiting a ranked match records a loss', async (t) => {
  const page = await openApp(t);
  const before = await readSave(page);
  await startRanked(page);
  await page.keyboard.press('Escape');
  await page.locator(SEL.forfeit).click();
  await page.locator(SEL.modal).waitFor();

  const after = await readSave(page);
  expect(after.club.lost, 'losses').toBe(before.club.lost + 1);
  expect(after.club.played, 'played').toBe(before.club.played + 1);
  const rec = after.history.at(-1);
  expect(rec.ranked, 'ranked').toBe(true);
  expect(rec.goalsFor, 'goals for').toBe(0);
  expect(rec.goalsAgainst, 'goals against').toBeGreaterThanOrEqual(3);
  expect(after.club.elo, 'Elo dropped').toBeLessThan(before.club.elo);
  expect(await headerElo(page), 'header Elo').toBe(after.club.elo);
  expect(await page.locator(SEL.modal).innerText(), 'modal says defeat').toMatch(/defeat/i);
  await page.locator(SEL.modalClose).click();
  await page.locator(SEL.modal).waitFor({ state: 'detached' });
});

test('keyboard only: Tab reaches "Kick off ranked" and Enter starts a match', async (t) => {
  const page = await openApp(t);
  await goTab(page, 'club');
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  let reached = false;
  for (let i = 0; i < 40 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = await page.evaluate((sel) => !!document.activeElement && document.activeElement.matches(sel), SEL.playRanked);
  }
  expect(reached, 'primary button reachable with Tab within 40 presses').toBe(true);
  await page.keyboard.press('Enter');
  await page.waitForSelector(SEL.pitch);
  expect(await page.locator(SEL.pitch).isVisible(), 'match is on screen').toBe(true);
});
