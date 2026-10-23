// Competitions: start the cup and the league, play a tie live, check the bracket,
// the table and that ladder Elo does not move.

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

test('cup: forfeiting a quarter-final knocks you out, the rest simulates, Elo is untouched', async (t) => {
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
  await page.locator(SEL.forfeit).click();
  await page.locator(SEL.modal).waitFor();
  expect(await page.locator(SEL.modal).innerText(), 'result names the round').toMatch(/quarter-final/i);

  const after = await readSave(page);
  expect(after.club.elo, 'ladder Elo unchanged').toBe(before.club.elo);
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
