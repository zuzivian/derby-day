// Club management: training, transfers, lineup persistence.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, readSave, pageWidths } = require('./lib/helpers.cjs');

test('training spends a session and shows a toast', async (t) => {
  const page = await openApp(t);
  const before = (await readSave(page)).trainingPoints;
  expect(before, 'starting sessions').toBeGreaterThan(0);
  await goTab(page, 'training');
  await page.locator(SEL.train).first().click();
  await page.locator(SEL.toast).waitFor();
  expect((await page.locator(SEL.toast).innerText()).trim().length, 'toast text').toBeGreaterThan(3);
  expect((await readSave(page)).trainingPoints, 'sessions after training').toBe(before - 1);
});

test('buying a player adds them to the squad; selling needs a two-step confirm', async (t) => {
  const page = await openApp(t, { mutateSave: (save) => (save.budget = 50_000_000) });
  const before = await readSave(page);
  expect(before.budget, 'budget').toBe(50_000_000);

  // Buy the first player on the market.
  await goTab(page, 'transfers');
  const buyBtn = page.locator(SEL.buy).first();
  const buyId = await buyBtn.getAttribute('data-id');
  expect(before.market.some((p) => p.id === buyId), 'bought player was on the market').toBeTruthy();
  await buyBtn.click();
  await page.locator(SEL.toast).waitFor();
  const afterBuy = await readSave(page);
  expect(afterBuy.squad.length, 'squad size after buy').toBe(before.squad.length + 1);
  expect(afterBuy.squad.some((p) => p.id === buyId), 'player is in squad').toBeTruthy();
  expect(afterBuy.market.some((p) => p.id === buyId), 'player left the market').toBeFalsy();
  expect(afterBuy.budget, 'budget fell').toBeLessThan(before.budget);

  // Sell a bench player: the first click only asks for confirmation.
  const bench = afterBuy.squad.find((p) => !afterBuy.lineup.includes(p.id));
  expect(bench, 'a bench player exists').toBeTruthy();
  await page.locator(SEL.sell(bench.id)).click();
  await page.locator(SEL.sellConfirm(bench.id)).waitFor();
  const midSell = await readSave(page);
  expect(midSell.squad.length, 'first click must not sell').toBe(afterBuy.squad.length);
  expect(midSell.budget, 'first click must not pay out').toBe(afterBuy.budget);

  await page.locator(SEL.sellConfirm(bench.id)).click();
  await page.locator(SEL.toast).waitFor();
  const afterSell = await readSave(page);
  expect(afterSell.squad.length, 'squad size after sell').toBe(afterBuy.squad.length - 1);
  expect(afterSell.squad.some((p) => p.id === bench.id), 'sold player gone').toBeFalsy();
  expect(afterSell.budget, 'budget rose').toBeGreaterThan(afterBuy.budget);
  expect(await page.locator(SEL.sellConfirmAny).count(), 'no confirm button left over').toBe(0);
});

test('selling confirmation is cancelled by doing something else', async (t) => {
  const page = await openApp(t);
  await goTab(page, 'transfers');
  const sell = page.locator(SEL.sellAny).first();
  const id = await sell.getAttribute('data-id');
  await sell.click();
  await page.locator(SEL.sellConfirm(id)).waitFor();
  await goTab(page, 'squad');
  await goTab(page, 'transfers');
  expect(await page.locator(SEL.sellConfirmAny).count(), 'confirm state reset after navigating').toBe(0);
});

test('lineup changes persist after reload', async (t) => {
  const page = await openApp(t);
  await goTab(page, 'squad');
  const save = await readSave(page);
  const slot = 1;
  const benchId = save.squad.find((p) => !save.lineup.includes(p.id)).id;
  expect(save.lineup[slot], 'slot starts with someone else').notToBe(benchId);

  await page.selectOption(SEL.slot(slot), benchId);
  expect((await readSave(page)).lineup[slot], 'save updated immediately').toBe(benchId);

  await page.reload();
  await page.waitForSelector(SEL.app + ' *');
  await goTab(page, 'squad');
  expect(await page.locator(SEL.slot(slot)).inputValue(), 'select shows the choice after reload').toBe(benchId);
  expect((await readSave(page)).lineup[slot], 'save after reload').toBe(benchId);
});

test('tactics board: formation and mentality are radio groups that save, survive a reload and fit a phone', async (t) => {
  for (const width of [1280, 390]) {
    const page = await openApp(t, { width, height: width > 600 ? 800 : 844 });
    await goTab(page, 'squad');
    expect(await page.locator('input[name="formation"]').count(), 'nine formations').toBe(9);
    expect(await page.locator('input[name="mentality"]').count(), 'five mentality steps').toBe(5);
    expect(await page.locator(SEL.formationChecked).getAttribute('value'), 'default formation').toBe('4-4-2');
    expect(await page.locator(SEL.mentalityChecked).getAttribute('value'), 'default mentality').toBe('balanced');

    // Pick by clicking the card (the label), the way a mouse user does.
    await page.locator(`label:has(${SEL.formationRadio('3-5-2')})`).click();
    let save = await readSave(page);
    expect(save.formation, 'formation saved').toBe('3-5-2');
    expect(save.lineup.length, 'XI re-picked').toBe(11);
    // Keyboard: arrow keys move within the mentality group.
    await page.locator(`label:has(${SEL.mentalityRadio('balanced')})`).click();
    await page.keyboard.press('ArrowRight');
    expect((await readSave(page)).mentality, 'arrow right steps up one').toBe('attacking');
    expect(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('value')), 'focus stays on the group after re-render').toBe('attacking');
    await page.locator(`label:has(${SEL.mentalityRadio('park')})`).click();
    expect((await readSave(page)).mentality, 'mentality saved').toBe('park');

    await page.reload();
    await page.waitForSelector(SEL.app + ' *');
    await goTab(page, 'squad');
    expect(await page.locator(SEL.formationChecked).getAttribute('value'), 'formation after reload').toBe('3-5-2');
    expect(await page.locator(SEL.mentalityChecked).getAttribute('value'), 'mentality after reload').toBe('park');
    const { scrollWidth, innerWidth } = await pageWidths(page);
    expect(scrollWidth, `no horizontal scroll at ${width}px`).toBeLessThan(innerWidth + 1);
  }
});
