// Club management: training, transfers, lineup persistence.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, nextVisit, goTab, readSave, pageWidths } = require('./lib/helpers.cjs');

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

  const next = await nextVisit(page); // not page.reload(): see helpers.cjs
  await goTab(next, 'squad');
  expect(await next.locator(SEL.slot(slot)).inputValue(), 'select shows the choice after reload').toBe(benchId);
  expect((await readSave(next)).lineup[slot], 'save after reload').toBe(benchId);
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

    const again = await nextVisit(page); // not page.reload(): see helpers.cjs
    await goTab(again, 'squad');
    expect(await again.locator(SEL.formationChecked).getAttribute('value'), 'formation after reload').toBe('3-5-2');
    expect(await again.locator(SEL.mentalityChecked).getAttribute('value'), 'mentality after reload').toBe('park');
    const { scrollWidth, innerWidth } = await pageWidths(again);
    expect(scrollWidth, `no horizontal scroll at ${width}px`).toBeLessThan(innerWidth + 1);
  }
});

test('screen reader: Ladder and Sell headings are short, the paste-replay button says what it plays', async (t) => {
  const page = await openApp(t);
  await goTab(page, 'ladder');
  expect(await page.getByRole('heading', { name: 'Ladder', exact: true }).count(), 'a short Ladder heading').toBe(1);
  expect(await page.getByRole('table', { name: 'Ladder', exact: true }).count(), 'the table is named Ladder').toBe(1);
  expect(await page.locator('#ladder-more').textContent(), 'the detail is kept').toContain('ranked by Elo');
  expect(await page.getByRole('table', { name: 'Ladder' }).getAttribute('aria-describedby'), 'and reachable as the description').toBe('ladder-more');
  await goTab(page, 'transfers');
  expect(await page.getByRole('heading', { name: 'Sell', exact: true }).count(), 'a short Sell heading').toBe(1);
  await goTab(page, 'club');
  expect(await page.getByRole('button', { name: 'Play pasted replay' }).count(), 'the Play button names its job').toBe(1);
});

test('mouse targets are at least 24 px: the profile name buttons in the squad', async (t) => {
  const page = await openApp(t);
  for (const screen of ['squad']) {
    await goTab(page, screen);
    const hs = await page.locator('.name-btn').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(hs.length, `${screen}: name buttons`).toBeGreaterThan(0);
    expect(Math.min(...hs), `${screen}: the smallest name button`).toBeGreaterThanOrEqual(24);
  }
});

test('Sell keeps focus on the same row when it becomes Confirm, and announces it', async (t) => {
  const page = await openApp(t);
  await goTab(page, 'transfers');
  const sells = page.locator(SEL.sellAny);
  expect(await sells.count(), 'at least two sell rows').toBeGreaterThan(1);
  const id = await sells.first().getAttribute('data-id');
  await sells.first().focus();
  await page.keyboard.press('Enter');
  await page.locator(SEL.sellConfirm(id)).waitFor();
  const focused = await page.evaluate(() => ({ action: document.activeElement?.dataset.action, id: document.activeElement?.dataset.id }));
  expect(focused.action, 'focus stays on the swapped button').toBe('sell-confirm');
  expect(focused.id, 'same row, not the next one').toBe(id);
  await page.waitForFunction(() => /Confirm sale of .+ for .+\. Press again to sell\./.test(document.getElementById('sr-announcer')?.textContent || ''), null, { timeout: 3000 });
});

test('document title follows the screen; status strip is keyboard reachable', async (t) => {
  const page = await openApp(t);
  expect(await page.title(), 'home title').toBe('Derby Day');
  await goTab(page, 'squad');
  expect(await page.title(), 'squad title').toBe('Squad · Derby Day');
  await goTab(page, 'transfers');
  expect(await page.title(), 'transfers title').toBe('Transfers · Derby Day');
  const strip = page.locator('.status-strip');
  expect(await strip.getAttribute('role'), 'strip role').toBe('group');
  expect(await strip.getAttribute('aria-label'), 'strip label').toBeTruthy();
  // Where every chip shows it is no tab stop; where it scrolls (a 568x320 landscape phone) the keyboard can reach it.
  expect(await strip.getAttribute('tabindex'), 'no extra stop on a wide screen').toBe(null);
});

test('the status strip is a tab stop only where it scrolls, re-checked on rotation', async (t) => {
  const page = await openApp(t, { width: 568, height: 320, level: 99 });
  const strip = page.locator('.status-strip');
  const scrolls = await strip.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(scrolls, 'the strip scrolls at 568x320').toBe(true);
  expect(await strip.getAttribute('tabindex'), 'focusable where it scrolls').toBe('0');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForFunction(() => !document.querySelector('.status-strip').hasAttribute('tabindex'), null, { timeout: 3000 });
});

// Runs inside the page (openApp stringifies it), so it cannot use anything from this file.
const strongFirst = (save) => {
  const ATTRS = ['pace', 'shooting', 'passing', 'dribbling', 'defending', 'goalkeeping', 'stamina'];
  save.budget = 500_000_000;
  const star = save.market[0];
  for (const k of ATTRS) star.attrs[k] = 99;
  star.potential = 99;
  const dud = save.market[1];
  for (const k of ATTRS) dud.attrs[k] = 5;
  dud.potential = 5;
};

for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844, hasTouch: true }]) {
  test(`transfers at ${size.width}px: upgrades are primary, chipped and first; signing offers Start at <POS>`, async (t) => {
    const page = await openApp(t, { ...size, mutateSave: strongFirst });
    const before = await readSave(page);
    const star = before.market[0];
    const dud = before.market[1];
    await goTab(page, 'transfers');
    const rows = page.locator('.panel:has(.has-action) tbody tr').filter({ has: page.locator('[data-action="buy"]') });
    expect(await rows.first().locator('[data-action="buy"]').getAttribute('data-id'), 'upgrade sorted first').toBe(star.id);
    expect(await rows.first().locator('.up-chip').innerText(), 'chip text').toMatch(/^Upgrade \+\d+ at [A-Z]+/);
    expect(await rows.first().locator('[data-action="buy"]').getAttribute('class'), 'upgrade Sign is primary').toMatch(/primary/);
    const dudBtn = page.locator(`[data-action="buy"][data-id="${dud.id}"]`);
    expect(await dudBtn.getAttribute('class'), 'non-upgrade Sign is not primary').toBe('btn small');
    expect(await page.locator(`tr:has([data-id="${dud.id}"]) .up-chip`).count(), 'no chip on non-upgrade').toBe(0);
    if (size.width < 1000) expect(await rows.first().locator('.name-sub').isVisible(), 'age and POT under the name on phones').toBe(true);

    await page.locator(`[data-action="buy"][data-id="${star.id}"]`).click();
    const start = page.locator(`[data-action="start-xi"][data-id="${star.id}"]`);
    await start.waitFor();
    expect(await page.evaluate(() => document.activeElement?.dataset.action), 'focus moves to Start').toBe('start-xi');
    expect((await page.locator(SEL.toast).innerText()).length, 'short toast (name, price, first-signing XP)').toBeLessThan(80);
    const slot = Number(await start.getAttribute('data-slot'));
    const b4 = await readSave(page);
    expect(b4.lineup[slot] === star.id, 'not started yet').toBe(false);
    await start.click();
    await page.waitForFunction(() => /XI strength \d+ → \d+/.test(document.querySelector('.toast')?.textContent ?? ''));
    expect((await readSave(page)).lineup[slot], 'in the XI slot').toBe(star.id);
    expect(await page.locator('.signed-bar').count(), 'bar gone').toBe(0);
  });
}

test('transfers: a non-upgrade signing says it joins the bench, with no Start button', async (t) => {
  const page = await openApp(t, { mutateSave: strongFirst });
  const dud = (await readSave(page)).market[1];
  await goTab(page, 'transfers');
  await page.locator(`[data-action="buy"][data-id="${dud.id}"]`).click();
  await page.locator(SEL.toast).waitFor();
  expect(await page.locator(SEL.toast).innerText(), 'bench toast').toMatch(/bench/i);
  expect(await page.locator('[data-action="start-xi"]').count(), 'no Start button').toBe(0);
});

test('transfers: selling a starter says so, shows the XI chip on phones, and the toast shows the budget change', async (t) => {
  const page = await openApp(t, { width: 390, height: 844, hasTouch: true });
  const save = await readSave(page);
  const id = save.lineup[1];
  await goTab(page, 'transfers');
  await page.locator(SEL.sell(id)).click();
  const confirm = page.locator(SEL.sellConfirm(id));
  expect(await confirm.getAttribute('aria-label'), 'confirm label').toMatch(/^Confirm: sells a starter \([A-Z]+\) for ƒ/);
  const chip = page.locator(`tr:has([data-id="${id}"]) .pill.sell-xi`);
  const box = await chip.boundingBox();
  expect(box && box.width > 8 && box.height > 8, 'XI chip is visible on a phone').toBe(true);
  await confirm.click();
  await page.locator(SEL.toast).waitFor();
  expect(await page.locator(SEL.toast).innerText(), 'budget change').toMatch(/Budget ƒ[\d.,]+[km]? → ƒ/i);
});

test('training: key attributes are tagged for the role, the best one is suggested, none is disabled; phones get a sticky summary', async (t) => {
  const page = await openApp(t, { width: 390, height: 844, hasTouch: true });
  await goTab(page, 'training');
  expect(await page.locator('.key-tag').count(), 'two key attributes').toBe(2);
  expect(await page.locator('.attr-list li.best').count(), 'one suggested').toBe(1);
  expect(await page.locator('.attr-list [data-action="train"][aria-disabled="true"]').count(), 'every choice stays available').toBe(0);
  const sticky = page.locator('.train-sticky');
  expect(await sticky.isVisible(), 'sticky bar on phones').toBe(true);
  expect(await sticky.innerText(), 'sessions, name and OVR').toMatch(/\d+ sessions? left[\s\S]*OVR \d+/);
  await page.locator('.attr-list li.best [data-action="train"]').click();
  await page.locator(SEL.toast).waitFor();
  await page.waitForTimeout(100);
  const covers = await page.evaluate(() => {
    const a = document.querySelector('.toast')?.getBoundingClientRect();
    const g = document.querySelector('.attr-list li:has(.gain)')?.getBoundingClientRect();
    return !!(a && g && a.bottom > g.top && a.top < g.bottom);
  });
  expect(covers, 'toast does not cover the gain row').toBe(false);
});
