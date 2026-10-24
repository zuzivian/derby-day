// Gradual onboarding: a fresh visit is one click from a live match (no forms first), light coach tips
// teach inside it, the menus are revealed by club level with a coach mark on each new tab, and
// existing saves keep what they had.

const { test, expect } = require('./lib/harness.cjs');
const { APP_URL, SEL, PREFS_KEY, openApp, readSave, tabScreens } = require('./lib/helpers.cjs');

const KICK = '#ob-kickoff';
const TIP = '.coach-tip:not([hidden])';

/** A brand-new visitor: no save, no prefs but the short-match override, the e2e hook to read the live match. */
async function freshVisit(t, { halfSeconds = null, width = 1280, height = 800 } = {}) {
  const page = await t.newPage({ viewport: { width, height } });
  await page.addInitScript(
    ([key, half]) => {
      window.__e2e = true;
      if (half && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ halfSeconds: half }));
    },
    [PREFS_KEY, halfSeconds],
  );
  await page.goto(APP_URL);
  await page.waitForSelector(KICK);
  return page;
}

test('onboarding: a fresh visit is one click from a live match', async (t) => {
  const page = await freshVisit(t);
  // One welcome, one big Kick off; no club forms, no controls quiz, no tabs.
  expect((await page.locator(KICK).innerText()).trim(), 'button text').toMatch(/^kick off$/i);
  expect(await page.locator('input, select, textarea').count(), 'no form fields on the welcome').toBe(0);
  expect(await page.locator(SEL.tab).count(), 'no tabs on the welcome').toBe(0);
  await page.locator(KICK).click();
  await page.waitForSelector(SEL.pitch);
  // The match is live: the sim clock moves.
  const tick = () => page.evaluate(() => window.__derbyMatch && window.__derbyMatch.tick);
  const t0 = await tick();
  await page.waitForFunction((a) => window.__derbyMatch.tick > a + 30, t0, { timeout: 15_000 });
  expect(await page.locator('.scoreboard').innerText(), 'a scoreboard').toMatch(/\d/);
  const prefs = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), PREFS_KEY);
  expect(prefs.onboarded, 'welcome done').toBe(true);
  expect(Array.isArray(prefs.coachSeen), 'the coach is on').toBe(true);
  // Reloading mid-match (a free abort) lands on Home with Kick off, not the welcome again.
  await page.reload();
  await page.waitForSelector(SEL.kickOff);
  expect(await page.locator(KICK).count(), 'no welcome again').toBe(0);
});

test('onboarding: "I\'ve played before" skips straight to Home with no coach', async (t) => {
  const page = await freshVisit(t);
  await page.locator('[data-action="skip-onboarding"]').click();
  await page.waitForSelector(SEL.kickOff);
  expect(await tabScreens(page), 'only Home').toEqual(['home']);
  const prefs = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), PREFS_KEY);
  expect(prefs.onboarded, 'done').toBe(true);
  expect(prefs.coachSeen, 'no tips for them').toBe(undefined);
  expect(prefs.marks, 'no tab marks for them').toBe(undefined);
});

test('onboarding: a coach tip appears in the first match, does not pause play, and can be dismissed once', async (t) => {
  const page = await freshVisit(t);
  await page.locator(KICK).click();
  await page.waitForSelector(SEL.pitch);
  await page.waitForSelector(TIP, { timeout: 20_000 });
  const tip = page.locator(TIP);
  expect(await tip.innerText(), 'the first tip is about running').toMatch(/run/i);
  await page.waitForFunction(() => /^Tip\./.test(document.getElementById('sr-announcer')?.textContent || ''), null, { timeout: 3000 });
  // It never pauses the match: the sim keeps running while it is up.
  const a = await page.evaluate(() => window.__derbyMatch.tick);
  await page.waitForFunction((x) => window.__derbyMatch.tick > x + 20, a, { timeout: 15_000 });
  expect(await page.locator(SEL.pause).isHidden(), 'no pause menu').toBe(true);
  // Clicking the card is not a pass or a shot: the controlled player is unchanged and no kick happens.
  await page.locator('.coach-x').click();
  expect(await page.locator('.coach-tip').isHidden(), 'dismissed').toBe(true);
  const prefs = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), PREFS_KEY);
  expect(prefs.coachSeen, 'remembered').toContain('run');
  // Each tip shows once: after dismissing, "run" never comes back, however long it plays.
  await page.waitForTimeout(1500);
  expect(await page.locator(`${TIP}[data-coach-tip="run"]`).count(), 'run is not shown twice').toBe(0);
});

test('onboarding: situational tips fire once each: the ball, a shot, losing it', async (t) => {
  const page = await freshVisit(t);
  await page.locator(KICK).click();
  await page.waitForSelector(SEL.pitch);
  // Set the scenes on the live match. Dismiss whichever tip is up and read the next.
  const nextTip = async (name, setup) => {
    await page.evaluate(setup);
    await page.waitForFunction((n) => { const el = document.querySelector('.coach-tip'); return el && !el.hidden && el.dataset.coachTip === n; }, name, { timeout: 25_000 });
    const text = await page.locator('.coach-tip').innerText();
    await page.locator('.coach-x').click();
    return text;
  };
  await page.waitForFunction(() => window.__derbyMatch.phase === 'play', null, { timeout: 30_000 });
  // Put the ball at our controlled player's feet, near the opposite goal.
  const withBall = () => {
    const s = window.__derbyMatch;
    const me = s.controlled[0];
    const p = s.players[me];
    p.pos = { x: 92, y: 34 };
    s.ball.owner = me;
    s.ball.pos = { x: 92, y: 34 };
  };
  expect(await nextTip('pass', withBall), 'pass tip').toMatch(/pass/i);
  expect(await nextTip('shoot', withBall), 'shoot tip').toMatch(/shoot|shot/i);
  // Losing it: the other side gets the ball.
  const lose = () => {
    const s = window.__derbyMatch;
    const other = s.players.find((p) => p.team === 1);
    s.ball.owner = other.i;
  };
  expect(await nextTip('tackle', lose), 'tackle tip').toMatch(/tackle/i);
  // The same situations again show nothing new: all four ids are remembered.
  const prefs = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), PREFS_KEY);
  for (const id of ['pass', 'shoot', 'tackle']) expect(prefs.coachSeen, `${id} remembered`).toContain(id);
  await page.evaluate(withBall);
  await page.waitForTimeout(800);
  expect(await page.locator(TIP).count(), 'nothing new for the same situation').toBe(0);
});

test('onboarding: the first match ends in a celebration with XP, then an optional naming step', async (t) => {
  const page = await freshVisit(t, { halfSeconds: 3 });
  await page.locator(KICK).click();
  await page.waitForSelector('.ob-celebrate', { timeout: 80_000 });
  const text = await page.locator('.ob-celebrate').innerText();
  expect(text, 'XP for the match and the milestone').toMatch(/\+\d+ XP/);
  expect(text, 'first match milestone').toContain('first match 80');
  const save = await readSave(page);
  expect(save.history.length, 'recorded once').toBe(1);
  expect(save.history[0].ranked, 'a friendly, no Elo').toBe(false);
  expect(save.club.elo, 'Elo untouched').toBe(1000);
  expect(save.milestones, 'milestone claimed').toContain('first-match');
  expect(save.xp, 'at least level 2').toBeGreaterThanOrEqual(100);
  // Naming is offered and can be done.
  await page.locator('[data-ob="next"]').click();
  await page.locator('#ob-name').fill('Harbour Lights');
  await page.locator('[data-ob="rename"]').click();
  expect(await page.locator('.ob-club-name').innerText(), 'renamed').toMatch(/harbour lights/i);
  await page.locator('[data-ob="done"]').click();
  // Level 2 opens: the level-up dialog, then a coach mark on the Squad tab.
  await page.locator(SEL.levelUp).waitFor();
  expect(await page.locator(SEL.levelUp).innerText(), 'Squad unlocked').toContain('Squad');
  await page.locator(SEL.levelUpClose).click();
  await page.locator('.tab-mark[data-mark="squad"]').waitFor();
  expect(await tabScreens(page), 'Home and Squad').toEqual(['home', 'squad']);
  expect((await readSave(page)).club.name, 'name saved').toBe('Harbour Lights');
});

test('onboarding: the naming step can be skipped', async (t) => {
  const page = await freshVisit(t, { halfSeconds: 3 });
  await page.locator(KICK).click();
  await page.waitForSelector('.ob-celebrate', { timeout: 80_000 });
  const name = (await readSave(page)).club.name;
  await page.locator('[data-ob="skip"]').click();
  await page.waitForSelector(SEL.tab);
  expect((await readSave(page)).club.name, 'name unchanged').toBe(name);
});

test('onboarding: level 1 shows only Home; a level-up reveals the next tab with a coach mark, once', async (t) => {
  const prefs = { halfSeconds: 3, controls: 'mouse', onboarded: true, coachSeen: [], marks: ['home'] };
  // 10 XP short of level 2: any ranked match tips it over.
  const page = await openApp(t, { xp: 90, prefs });
  expect(await tabScreens(page), 'level 1: Home only').toEqual(['home']);
  expect(await page.locator(SEL.modeCard).count(), 'no mode cards').toBe(0);
  expect(await page.locator('.tab-mark').count(), 'no mark yet').toBe(0);
  await page.locator(SEL.kickOff).click();
  await page.locator(SEL.modalClose).waitFor({ timeout: 80_000 });
  await page.locator(SEL.modalClose).click();
  await page.locator(SEL.levelUp).waitFor();
  expect(await page.locator('.tab-mark').count(), 'the mark waits behind the dialog').toBe(0);
  await page.locator(SEL.levelUpClose).click();
  const mark = page.locator('.tab-mark[data-mark="squad"]');
  await mark.waitFor();
  expect(await mark.innerText(), 'says what it is').toContain('Squad');
  expect(await page.locator(`${SEL.tabFor('squad')}.coach-spot`).count(), 'the tab is spotlit').toBe(1);
  // The card sits under its tab, inside the viewport.
  const box = await mark.boundingBox();
  const tabBox = await page.locator(SEL.tabFor('squad')).boundingBox();
  expect(box.y, 'below the tab').toBeGreaterThanOrEqual(tabBox.y + tabBox.height);
  expect(box.x + box.width, 'inside the viewport').toBeLessThanOrEqual(1280);
  await page.waitForFunction(() => (document.getElementById('sr-announcer')?.textContent || '').includes('New: Squad'), null, { timeout: 3000 });
  await page.locator('[data-action="mark-ok"]').click();
  expect(await page.locator('.tab-mark').count(), 'dismissed').toBe(0);
  expect((await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), PREFS_KEY)).marks, 'remembered').toContain('squad');
  await page.reload();
  await page.waitForSelector(SEL.kickOff);
  expect(await page.locator('.tab-mark').count(), 'not again after a reload').toBe(0);
});

test('onboarding: opening a revealed tab counts as seeing it', async (t) => {
  const prefs = { halfSeconds: 3, controls: 'mouse', onboarded: true, coachSeen: [], marks: ['home'] };
  const page = await openApp(t, { xp: 120, prefs, mutateSave: (save) => { save.unlocksSeen = ['home', 'ranked', 'squad']; } });
  expect(await page.locator('.tab-mark[data-mark="squad"]').count(), 'squad is pointed out').toBe(1);
  await page.locator(SEL.tabFor('squad')).click();
  await page.waitForSelector(`${SEL.tabFor('squad')}[aria-current]`);
  expect(await page.locator('.tab-mark').count(), 'no mark on the tab you opened').toBe(0);
  await page.locator(SEL.tabFor('home')).click();
  expect(await page.locator('.tab-mark').count(), 'and not afterwards').toBe(0);
});

test('onboarding: an existing save keeps every feature the old unlock table gave it, with no tips or marks', async (t) => {
  // A level-2 club from before the gradual table: Squad, Club, Practice, vs Player and Training were all open.
  const page = await openApp(t, {
    level: null,
    mutateSave: (save) => {
      save.xp = 250;
      save.unlocksSeen = ['club', 'squad', 'ranked', 'practice', 'local2p', 'link', 'training'];
      delete save.unlocksV;
    },
  });
  expect(await tabScreens(page), 'tabs it had').toEqual(['home', 'squad', 'training', 'club']);
  expect(await page.locator(SEL.playPractice).count(), 'Easy and Normal practice').toBe(2);
  expect(await page.locator(SEL.playLocal2p).count(), 'Local 2P').toBe(1);
  expect(await page.locator(SEL.playLink).count(), 'Link two tabs').toBe(1);
  expect(await page.locator('.tab-mark').count(), 'no marks for a returning player').toBe(0);
  expect(await page.locator(SEL.levelUp).count(), 'no level-up flood').toBe(0);
  const save = await readSave(page);
  expect(save.unlocksV, 'migrated').toBe(2);
  // And it never sees the welcome.
  await page.reload();
  await page.waitForSelector(SEL.kickOff);
  expect(await page.locator(KICK).count(), 'no welcome').toBe(0);
});

test('onboarding: the welcome and the first match fit a phone', async (t) => {
  const page = await freshVisit(t, { width: 390, height: 844 });
  const w = await page.evaluate(() => ({ s: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), i: window.innerWidth }));
  expect(w.s, 'no horizontal overflow on the welcome').toBeLessThanOrEqual(w.i);
  expect(await page.locator(KICK).isVisible(), 'Kick off is visible without scrolling').toBe(true);
  const kb = await page.locator(KICK).boundingBox();
  expect(kb.y + kb.height, 'above the fold').toBeLessThanOrEqual(844);
  await page.locator(KICK).click();
  await page.waitForSelector(TIP, { timeout: 20_000 });
  const tb = await page.locator('.coach-tip').boundingBox();
  expect(tb.x, 'tip inside the screen').toBeGreaterThanOrEqual(0);
  expect(tb.x + tb.width, 'tip inside the screen').toBeLessThanOrEqual(390);
});
