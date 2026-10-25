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

  // Focus starts on the result's scrolling region (labelled by the title), taken from code: it must not draw a
  // focus ring (owner feedback 2026-10-24), and Page Down scrolls it straight away.
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    const cs = getComputedStyle(el);
    return { region: el.classList.contains('rs-scroll'), label: el.getAttribute('aria-labelledby'), outline: cs.outlineStyle, shadow: cs.boxShadow };
  });
  expect(focus.region, 'focus starts on the result region').toBe(true);
  expect(focus.label, 'the region is labelled by the title').toBe('result-title');
  expect(focus.outline, 'no outline on the programmatically focused region').toBe('none');
  expect(focus.shadow, 'no ring drawn as a shadow either').toBe('none');
  // The primary button stays in view without scrolling the dialog.
  const btn = await page.locator(SEL.modalClose).boundingBox();
  expect(btn && btn.y + btn.height <= 800, 'Back to the club is on screen').toBe(true);

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

test('keyboard only: Tab reaches "Kick off" and Enter starts a match', async (t) => {
  const page = await openApp(t);
  await goTab(page, 'home');
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

test('quick tactics: a mentality picked in the pause menu changes the side in the match, not the saved default', async (t) => {
  const page = await openApp(t, { e2eHook: true, prefs: { halfSeconds: 60, onboarded: true } });
  await startRanked(page);
  const mentality = () => page.evaluate(() => window.__derbyMatch.teams[0].mentality ?? 'balanced');
  expect(await mentality(), 'starts at the club default').toBe('balanced');
  await page.keyboard.press('Escape');
  await page.locator(SEL.pause).waitFor({ state: 'visible' });
  expect(await page.locator('#quick-tactics input').count(), 'five steps').toBe(5);
  await page.locator(SEL.quickMentality('attacking')).click();
  // The pause menu keeps its arrow keys: the radios step along (the match does not take them).
  await page.keyboard.press('ArrowRight');
  expect(await page.locator('#quick-tactics input:checked').getAttribute('value'), 'arrow right steps to High press').toBe('press');
  // Paused: nothing has changed yet; it goes to the sim with the first tick after resuming.
  expect(await mentality(), 'not while paused').toBe('balanced');
  await page.locator(SEL.resume).click();
  await page.waitForFunction(() => window.__derbyMatch.teams[0].mentality === 'press', null, { timeout: 10_000 });
  expect((await readSave(page)).mentality ?? 'balanced', 'the saved default is untouched').toBe('balanced');
});

for (const renderer of ['2d', '3d']) {
  test(`HUD (${renderer}): a card names the man you control, with his number and his legs`, async (t) => {
    const page = await openApp(t, { prefs: { halfSeconds: 20 }, e2eHook: true, renderer });
    await startRanked(page);
    await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 20_000 });
    await page.waitForTimeout(500);
    const got = await page.evaluate(() => {
      const s = window.__derbyMatch;
      const p = s.players[s.controlled[0]];
      const card = document.querySelector('.hud-me');
      return {
        shown: !!card && !card.hidden && card.getClientRects().length > 0,
        name: card?.querySelector('.hud-me-name')?.textContent,
        no: card?.querySelector('.hud-me-no')?.textContent,
        legs: card?.querySelector('.hud-me-legs i')?.style.width,
        want: { name: p.name, no: String(p.number), legs: `${Math.round(p.energy * 20) * 5}%` },
      };
    });
    expect(got.shown, 'the card is on screen').toBe(true);
    expect(got.name, 'his name').toBe(got.want.name);
    expect(got.no, 'his number').toBe(got.want.no);
    expect(got.legs, 'his energy').toBe(got.want.legs);
  });
}
