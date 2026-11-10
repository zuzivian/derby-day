// Club management: training, transfers, lineup persistence.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, nextVisit, goTab, readSave, pageWidths, totalXpForLevel } = require('./lib/helpers.cjs');

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

// --- Squad, Club and Ladder polish -------------------------------------------------------------------------------

test('squad on a phone: the XI board comes before tactics, which fold to a one-line summary and expand by keyboard', async (t) => {
  const page = await openApp(t, { width: 390, height: 844, hasTouch: true });
  await goTab(page, 'squad');
  const order = await page.evaluate(() => {
    const y = (sel) => document.querySelector(sel).getBoundingClientRect().top;
    return { board: y('.squad-grid .board'), tactics: y('.squad-grid .tactics') };
  });
  expect(order.board, 'XI board above tactics').toBeLessThan(order.tactics);
  const fold = page.locator('.tac-fold');
  expect(await fold.evaluate((d) => d.open), 'tactics start collapsed on a phone').toBe(false);
  expect((await page.locator('.tac-fold > summary').innerText()).replace(/\s+/g, ' '), 'summary shows shape and mentality').toMatch(/4-4-2 · Balanced/);
  await page.locator('.tac-fold > summary').focus();
  await page.keyboard.press('Enter');
  expect(await fold.evaluate((d) => d.open), 'Enter expands').toBe(true);
  await page.locator(`label:has(${SEL.mentalityRadio('attacking')})`).click();
  expect(await fold.evaluate((d) => d.open), 'stays open across the re-render').toBe(true);
  const notes = await page.$$eval('.tac-step', (els) => els.filter((e) => getComputedStyle(e.querySelector('.tac-step-note')).display !== 'none').length);
  expect(notes, 'only the selected mentality shows its description').toBe(1);
});

test('squad: a bench player who rates higher in a slot shows a "+N on bench" badge that swaps him in', async (t) => {
  const page = await openApp(t, {
    mutateSave: (s) => {
      // Put the weakest outfielders in the XI so the bench holds upgrades.
      const ovr = (p) => Object.values(p.attrs).reduce((a, b) => a + b, 0);
      const out = s.squad.filter((p) => p.role !== 'GK').sort((a, b) => ovr(a) - ovr(b));
      const keeper = s.lineup.find((id) => s.squad.find((p) => p.id === id).role === 'GK');
      s.lineup = [keeper, ...out.slice(0, s.lineup.length - 1).map((p) => p.id)];
    },
  });
  await goTab(page, 'squad');
  const hint = page.locator('.bench-hint').first();
  expect(await hint.count(), 'a bench hint is shown').toBe(1);
  expect(await hint.innerText(), 'text').toMatch(/^▲ \+\d+ on bench$/);
  expect(await hint.getAttribute('aria-label'), 'label names both players').toMatch(/^Swap in .+ for .+ at .+: plus \d+/);
  const slot = await hint.getAttribute('data-slot');
  const id = await hint.getAttribute('data-id');
  await hint.focus();
  await page.keyboard.press('Enter');
  const save = await readSave(page);
  expect(save.lineup[Number(slot)], 'the bench player is now in the slot').toBe(id);
});

test('squad: the attribute colour legend and the XI strength meaning are shown', async (t) => {
  const page = await openApp(t, { width: 1280, height: 800 });
  await goTab(page, 'squad');
  expect((await page.locator('.attr-legend').innerText()).replace(/\s+/g, ' '), 'legend tiers').toMatch(/80\+.*68.*55.*55/);
  expect(await page.locator('.strength-note').count(), 'XI strength meaning').toBe(1);
});

test('club: identity and rename fold under "Customise club"; the danger zone is its own last panel; level-up links open the fold', async (t) => {
  const page = await openApp(t, { width: 390, height: 844, hasTouch: true, xp: totalXpForLevel(18) - 3 });
  await goTab(page, 'training');
  await page.locator(SEL.train).first().click();
  await page.locator(SEL.levelUp).waitFor();
  await page.locator(SEL.levelUpGo).click();
  await page.locator(SEL.levelUp).waitFor({ state: 'detached' });
  expect(await page.locator('.customise-fold').evaluate((d) => d.open), 'fold opened for the crest target').toBe(true);
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id), 'crest picker focused').toBe('crest-select');
  const order = await page.evaluate(() => {
    const top = (s) => document.querySelector(s).getBoundingClientRect().top + scrollY;
    return { level: top('.level-panel'), news: top('.news'), custom: top('.customise'), danger: top('.danger-panel') };
  });
  expect(order.level, 'level before news').toBeLessThan(order.news);
  expect(order.news, 'news before customise').toBeLessThan(order.custom);
  expect(order.custom, 'danger zone last').toBeLessThan(order.danger);
  expect(await page.locator('.news .identity-editor, .news .rename-form, .news .danger-zone').count(), 'nothing of that left in the news card').toBe(0);
});

test('club: customise is collapsed by default and a fresh club shows one empty line instead of three', async (t) => {
  const page = await openApp(t, { width: 390, height: 844, hasTouch: true });
  await goTab(page, 'club');
  expect(await page.locator('.customise-fold').evaluate((d) => d.open), 'collapsed').toBe(false);
  expect(await page.locator('#club-rename').isVisible(), 'rename hidden until opened').toBe(false);
  expect(await page.locator('.club-grid .form .empty-state').count(), 'one merged empty state').toBe(1);
  expect(await page.locator('.club-grid .form .empty-state').innerText(), 'text').toMatch(/Play your first ranked match to fill your Elo, form and replays/);
  expect(await page.locator('#replay-paste').count(), 'the paste box is still there').toBe(1);
});

test('ladder: your row is tagged "You" and tinted, visible on a phone', async (t) => {
  const page = await openApp(t, { width: 390, height: 844, hasTouch: true });
  await goTab(page, 'ladder');
  const pill = page.locator('tr.you .pill');
  expect(await pill.isVisible(), 'the You tag is visible at 390 px').toBe(true);
  expect(await pill.innerText(), 'tag text').toMatch(/you/i);
  expect((await pageWidths(page)).scrollWidth, 'no sideways scroll').toBeLessThanOrEqual(390);
});
