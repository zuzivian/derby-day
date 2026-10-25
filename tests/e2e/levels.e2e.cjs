// Club levels: a fresh club only sees the level-1 features, matches and training earn XP shown in
// the result dialog and the header, crossing a level opens the level-up dialog naming the unlock,
// and the new tab appears.

const { test, expect } = require('./lib/harness.cjs');
const { reload, SEL, openApp, goTab, readSave, startRanked, tabScreens, pageWidths, totalXpForLevel } = require('./lib/helpers.cjs');

const SHORT = { halfSeconds: 3, controls: 'mouse', onboarded: true };

/** Level, XP into the level and its bar length, the curve from src/meta/levels.ts. */
function progress(xp) {
  let level = 1;
  while (level < 99 && totalXpForLevel(level + 1) <= xp) level++;
  return { level, into: xp - totalXpForLevel(level), needed: 100 * level };
}
const headerText = (xp) => {
  const p = progress(xp);
  return `Level ${p.level} · ${p.into.toLocaleString('en-GB')} / ${p.needed.toLocaleString('en-GB')} XP`;
};

/** Play a short ranked match with no input and wait for the result dialog. */
async function playShortRanked(page) {
  await startRanked(page);
  await page.locator(SEL.modalClose).waitFor({ timeout: 60_000 });
}

test('levels: a fresh club shows only Home and Kick off, with a level 1 XP bar', async (t) => {
  const page = await openApp(t, { level: null });
  expect(await tabScreens(page), 'tabs').toEqual(['home']);
  expect(await page.locator(SEL.xpText).innerText(), 'header text').toBe('Level 1 · 0 / 100 XP');
  const bar = page.locator(SEL.xpBar);
  expect(await bar.getAttribute('aria-valuenow'), 'valuenow').toBe('0');
  expect(await bar.getAttribute('aria-valuemin'), 'valuemin').toBe('0');
  expect(await bar.getAttribute('aria-valuemax'), 'valuemax').toBe('100');
  expect(await bar.getAttribute('aria-valuetext'), 'valuetext').toMatch(/Level 1, 0 of 100 XP/);
  expect(await page.locator('.level-badge').innerText(), 'badge').toBe('1');
  // Locked controls are hidden, not disabled.
  expect(await page.locator(SEL.playPractice).count(), 'no Practice yet').toBe(0);
  expect(await page.locator(SEL.playLocal2p).count(), 'no Local 2P yet').toBe(0);
  expect(await page.locator(SEL.playLink).count(), 'no Link two tabs yet').toBe(0);
  expect(await page.locator(SEL.playRanked).count(), 'ranked is not open yet: Kick off is a warm-up').toBe(0);
  expect(await page.locator(SEL.kickOff).getAttribute('data-action'), 'warm-up friendly').toBe('play-warmup');
  // The club level details live on the Club tab (level 3), which is not there yet; the badge is not a button.
  expect(await page.locator(SEL.nextUnlock).count(), 'no teaser on Home').toBe(0);
  expect(await page.locator(SEL.levelBadge).count(), 'the badge is not a button yet').toBe(0);
  expect(await page.locator(`${SEL.tabFor('home')}[aria-current]`).count(), 'on Home').toBe(1);
  expect(await page.locator(SEL.levelUp).count(), 'no level-up dialog').toBe(0);
});

test('levels: the next-unlock teaser and the club level panel list what is next and later', async (t) => {
  const page = await openApp(t, { xp: 660 });
  expect(await page.locator(SEL.xpText).innerText(), 'header').toBe('Level 4 · 60 / 400 XP');
  expect(await tabScreens(page), 'tabs at level 4').toEqual(['home', 'squad', 'training', 'club']);
  await goTab(page, SEL.clubScreen);
  expect(await page.locator(SEL.nextUnlock).innerText(), 'teaser').toContain('The Cup and Practice: Hard at level 5 — 340 XP to go');
  await page.locator(`${SEL.levelPanel} summary`).click();
  const text = await page.locator(SEL.levelPanel).innerText();
  expect(text, 'unlocked row').toMatch(/Training[\s\S]*Unlocked/);
  expect(text, 'later row').toMatch(/League season[\s\S]*Level 8/);
  expect(text, 'perks listed').toContain('Squad of 25');
  // The header badge jumps to the panel, from any tab.
  await goTab(page, SEL.homeScreen);
  await page.locator(SEL.levelBadge).click();
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id), 'focus on panel heading').toBe('level-title');
});

test('levels: a warm-up match awards XP, shown in the result dialog and the header', async (t) => {
  const page = await openApp(t, { level: null, prefs: SHORT });
  await page.locator(SEL.kickOff).click();
  await page.waitForSelector(SEL.pitch);
  await page.locator(SEL.modalClose).waitFor({ timeout: 60_000 });
  const save = await readSave(page);
  const rec = save.history.at(-1);
  expect(save.xp, 'some XP').toBeGreaterThanOrEqual(50);
  const line = (await page.locator(SEL.xpGain).innerText()).replace(/\s+/g, ' ');
  const result = rec.goalsFor > rec.goalsAgainst ? 'win 120' : rec.goalsFor === rec.goalsAgainst ? 'draw 80' : 'loss 50';
  expect(line, 'result line').toMatch(new RegExp(`^\\+${save.xp} XP: ${result}`));
  if (rec.goalsFor) expect(line, 'goals').toContain(`${rec.goalsFor} goal`);
  if (!rec.goalsAgainst) expect(line, 'clean sheet').toContain('clean sheet 20');
  await page.locator(SEL.modalClose).click();
  // Level 2 (Squad) is 100 XP away, so a draw or a win also opens the level-up dialog.
  if (save.xp >= 100) {
    await page.locator(SEL.levelUp).waitFor();
    expect(await page.locator(SEL.levelUp).innerText(), 'names Squad').toContain('Squad');
    await page.keyboard.press('Escape');
    await page.locator(SEL.levelUp).waitFor({ state: 'detached' });
    expect(await tabScreens(page), 'Squad tab appears').toContain('squad');
  }
  expect(await page.locator(SEL.xpText).innerText(), 'header').toBe(headerText(save.xp));
});

test('levels: crossing a level opens the level-up dialog; focus is trapped, Esc closes it and the tab appears', async (t) => {
  const start = totalXpForLevel(7) - 10;
  const page = await openApp(t, { xp: start, prefs: SHORT, width: 390, height: 844 });
  expect(await tabScreens(page), 'no Ladder yet').notToContain('ladder');
  await playShortRanked(page);
  expect(await page.locator(SEL.levelUp).count(), 'waits behind the result').toBe(0);
  await page.locator(SEL.modalClose).click();
  const dialog = page.locator(SEL.levelUp);
  await dialog.waitFor();
  expect(await dialog.getAttribute('role'), 'role').toBe('dialog');
  expect(await dialog.getAttribute('aria-modal'), 'modal').toBe('true');
  expect(await page.locator(SEL.levelUpTitle).innerText(), 'title').toMatch(/level 7/i);
  expect(await dialog.innerText(), 'names the unlock').toContain('Ladder');
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id), 'focus on title').toBe('levelup-title');
  await page.waitForFunction(() => /Level 7\. Unlocked: Ladder/.test(document.getElementById('sr-announcer')?.textContent || ''), null, { timeout: 3000 });
  const w = await pageWidths(page);
  expect(w.scrollWidth, 'no horizontal overflow at 390px with the dialog open').toBeLessThanOrEqual(w.innerWidth);
  // Tab cycles between the dialog's two buttons and never leaves it.
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('[aria-labelledby="levelup-title"]')), `focus inside after Tab ${i + 1}`).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement.closest('[aria-labelledby="levelup-title"]')), 'focus inside after Shift+Tab').toBe(true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  expect(await tabScreens(page), 'Ladder tab appears').toContain('ladder');
  expect(await page.evaluate((sel) => document.activeElement.matches(sel), SEL.playRanked), 'focus back on Kick off ranked').toBe(true);
  const save = await readSave(page);
  expect(save.unlocksSeen, 'dismissal saved').toContain('ladder');
  expect(await page.locator(SEL.xpText).innerText(), 'header').toBe(headerText(save.xp));
  // Reloading doesn't bring it back.
  await reload(page);
  await page.waitForSelector(SEL.app + ' *');
  expect(await page.locator(SEL.levelUp).count(), 'no dialog after reload').toBe(0);
  const w2 = await pageWidths(page);
  expect(w2.scrollWidth, 'no horizontal overflow at 390px').toBeLessThanOrEqual(w2.innerWidth);
});

test('levels: a training session can level up; the dialog button goes straight to the new feature', async (t) => {
  const page = await openApp(t, { xp: totalXpForLevel(5) - 3 });
  expect(await tabScreens(page), 'no Competitions yet').notToContain('competitions');
  await goTab(page, 'training');
  await page.locator(SEL.train).first().click();
  await page.locator(SEL.levelUp).waitFor();
  const text = await page.locator(SEL.levelUp).innerText();
  expect(text, 'the Cup').toContain('The Cup');
  expect(text, 'Practice: Hard').toContain('Practice: Hard');
  expect((await readSave(page)).xp, 'session XP').toBe(totalXpForLevel(5) + 2);
  await page.locator(SEL.levelUpGo).click();
  await page.locator(SEL.levelUp).waitFor({ state: 'detached' });
  expect(await page.locator(`${SEL.tabFor('competitions')}[aria-current]`).count(), 'on Competitions').toBe(1);
  expect(await page.locator('[data-action="comp-start-cup"]').count(), 'the cup can start').toBe(1);
  expect(await page.locator('[data-action="comp-start-season"]').count(), 'the league is still locked').toBe(0);
  await goTab(page, SEL.homeScreen);
  expect(await page.locator(`${SEL.playPractice}[data-level="hard"]`).count(), 'Practice Hard now shown').toBe(1);
  expect(await page.locator(SEL.lockedCard).count(), 'the Cup card is open, the League not teased yet').toBe(0);
  expect(await page.locator(SEL.modeCardFor('league')).count(), 'no League card yet').toBe(0);
});

test('levels: a forfeited match earns no XP', async (t) => {
  const page = await openApp(t, { xp: 350 });
  await startRanked(page);
  await page.keyboard.press('Escape');
  await page.locator(SEL.forfeit).click();
  await page.locator(SEL.modalClose).waitFor();
  expect(await page.locator(SEL.xpGain).innerText(), 'result line').toMatch(/No XP/);
  expect((await readSave(page)).xp, 'unchanged').toBe(350);
});

test('levels: at 1280x800 a level-up win shows the "Level up" flourish without scrolling the result', async (t) => {
  // Level 30, 40 XP short of 31; a 3–1 win pays well over that.
  const page = await openApp(t, { xp: totalXpForLevel(31) - 40, prefs: SHORT, e2eHook: true, width: 1280, height: 800 });
  await startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch);
  await page.evaluate(() => {
    const m = window.__derbyMatch;
    m.score = [3, 1];
    m.goals.push({ team: 0, scorer: 'K. Ashton', minute: 12 }, { team: 1, scorer: 'R. Cartmore', minute: 56 }, { team: 0, scorer: 'K. Ashton', minute: 61 }, { team: 0, scorer: 'M. Delacroix-Hartmann', minute: 88 });
  });
  await page.locator(SEL.modalClose).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500); // the flourish pops after the XP bar has filled
  const box = await page.evaluate(() => {
    const scroll = document.querySelector('.modal .rs-scroll').getBoundingClientRect();
    const lv = document.querySelector('.modal .xp-level')?.getBoundingClientRect();
    return lv && { top: lv.top, bottom: lv.bottom, viewTop: scroll.top, viewBottom: scroll.bottom };
  });
  expect(!!box, 'the result shows a level up').toBe(true);
  expect(box.top >= box.viewTop && box.bottom <= box.viewBottom, `"Level up" is inside the visible result (${JSON.stringify(box)})`).toBe(true);
});
