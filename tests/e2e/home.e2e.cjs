// Home screen (src/client/home.ts): at level 1 it is one hero Kick off and nothing else; the play-mode cards
// (vs Player, Practice, and locked Cup and League teasers) appear as the club levels up.
// The match length is standard, locked cards are not controls, the layout fits 390 and 1280
// in both themes, and the keyboard reaches Kick off first after the skip link.

const { test, expect } = require('./lib/harness.cjs');
const { reload, SEL, PREFS_KEY, openApp, readSave, pageWidths, tabScreens } = require('./lib/helpers.cjs');

const SHORT = { halfSeconds: 3, controls: 'mouse', onboarded: true };

test('home: a level-1 club sees exactly the hero Kick off, and the mode cards arrive with levels', async (t) => {
  const page = await openApp(t, { level: null });
  expect(await tabScreens(page), 'tabs').toEqual(['home']);
  expect(await page.locator(`${SEL.tabFor('home')}[aria-current]`).count(), 'Home is the first view').toBe(1);

  // The hero is the vs CPU mode: two crests, the gauge, Elo numbers and one Kick off.
  expect(await page.locator(SEL.hero).count(), 'one hero').toBe(1);
  expect((await page.locator(SEL.kickOff).innerText()).trim(), 'button text').toMatch(/^kick off$/i);
  expect(await page.locator(`${SEL.hero} .crest`).count(), 'two crests').toBe(2);
  expect((await page.locator(`${SEL.hero} .hero-tag`).innerText()).trim(), 'a warm-up, not ranked').toMatch(/^warm-up friendly$/i);
  expect(await page.locator(`${SEL.hero} .gauge`).count(), 'no win-chance gauge for a warm-up').toBe(0);
  expect(await page.locator(SEL.kickOff).getAttribute('data-action'), 'Kick off plays a warm-up').toBe('play-warmup');
  expect(await page.locator(`${SEL.hero} .form-strip`).getAttribute('aria-label'), 'form has a text equivalent').toBe('No matches played yet');
  expect(await page.locator(`${SEL.hero} .hero-elo`).allInnerTexts().then((x) => x.join(' ')), 'your Elo as a number, theirs a friendly').toMatch(/Elo\s*\d+[\s\S]*Friendly/);
  expect(await page.locator(`${SEL.hero} .mini-spark`).count(), 'no sparkline without history').toBe(0);

  // No mode cards at level 1.
  expect(await page.locator(SEL.modeCard).count(), 'no mode cards at level 1').toBe(0);

  // Nothing else on the first view: the only control is Kick off.
  const buttons = await page.$$eval('#main button, #main select, #main input, #main a[href], #main details', (els) => els.map((e) => e.id || e.tagName));
  expect(buttons, 'controls in the first view').toEqual(['kick-off']);
  for (const gone of ['#half-length', SEL.newsTitle, SEL.levelPanel, '.facts', '[data-action="replay-tutorial"]', '[data-action="reset"]', '.news-list']) {
    expect(await page.locator(gone).count(), `${gone} is not on Home`).toBe(0);
  }
  // The status strip at level 1 is the club and the level; sessions, money and rank arrive with their features.
  expect(await page.locator(`${SEL.statusStrip} .stat`).count(), 'no extra status yet').toBe(0);
  expect(await page.locator(`${SEL.statusStrip} [role="progressbar"]`).count(), 'XP bar').toBe(1);
});

test('home: from level 3 Kick off is ranked, and the win-chance gauge waits for the fourth ranked match', async (t) => {
  const page = await openApp(t, { level: 3 });
  expect((await page.locator(`${SEL.hero} .hero-tag`).innerText()).trim(), 'ranked').toMatch(/^ranked$/i);
  expect(await page.locator(SEL.kickOff).getAttribute('data-action'), 'Kick off plays ranked').toBe('play-ranked');
  expect(await page.locator(`${SEL.hero} .gauge`).count(), 'no gauge for the first three ranked matches').toBe(0);
  expect(await page.locator(`${SEL.hero} .hero-elo`).allInnerTexts().then((x) => x.join(' ')), 'both Elo numbers').toMatch(/Elo\s*\d+[\s\S]*Elo\s*\d+/);
  const ranked = await openApp(t, { level: 3, mutateSave: (save) => { for (let i = 0; i < 3; i++) save.history.push({ opponent: 'A', opponentShort: 'A', goalsFor: 1, goalsAgainst: 0, ranked: true, eloBefore: 1000, eloAfter: 1000, scorers: [] }); } });
  expect(await ranked.locator(`${SEL.hero} .gauge[role="img"]`).getAttribute('aria-label'), 'gauge has a text equivalent once shown').toMatch(/^Win chance \d+%$/);
});

test('home: Kick off starts a ranked match against the opponent shown', async (t) => {
  const page = await openApp(t, { level: 3, prefs: SHORT });
  const opp = (await page.locator(`${SEL.hero} .hero-name`).nth(1).innerText()).trim();
  await page.locator(SEL.kickOff).click();
  await page.waitForSelector(SEL.pitch);
  expect(await page.locator('.scoreboard').innerText(), 'the opponent from the hero').toContain(opp);
  await page.locator(SEL.modalClose).waitFor({ timeout: 60_000 });
  const save = await readSave(page);
  expect(save.history.length, 'one match recorded').toBe(1);
  expect(save.history[0].ranked, 'ranked').toBe(true);
  expect(save.history[0].opponent, 'against that club').toBe(opp);
  await page.locator(SEL.modalClose).click();
  // Back home, the form strip now shows the result.
  await page.locator(SEL.levelUp).waitFor({ timeout: 1500 }).then(() => page.keyboard.press('Escape')).catch(() => {});
  expect(await page.locator(`${SEL.hero} .form-strip`).getAttribute('aria-label'), 'form updated').toMatch(/^Recent form, oldest first: (win|draw|defeat)$/);
});

test('home: the mode cards arrive with level 2; locked ones are teasers, not controls', async (t) => {
  const page = await openApp(t, { level: 4 });
  const modes = await page.$$eval(SEL.modeCard, (els) => els.map((e) => e.getAttribute('data-mode')));
  expect(modes, 'mode cards at level 4, in order').toEqual(['player', 'practice', 'cup', 'league']);
  const locked = await page.$$eval(SEL.lockedCard, (els) => els.map((e) => [e.getAttribute('data-mode'), e.getAttribute('data-locked-level')]));
  expect(locked, 'locked Cup and League with their levels').toEqual([['cup', '5'], ['league', '8']]);
  expect(await page.locator(`${SEL.lockedCard} .lock-badge`).count(), 'padlock badges').toBe(2);
  const inside = await page.$$eval(SEL.lockedCard, (els) => els.map((e) => e.querySelectorAll('button, a, input, select, [tabindex], [data-action]').length));
  expect(inside, 'nothing focusable or actionable inside').toEqual([0, 0]);
  for (const mode of ['cup', 'league']) {
    await page.locator(SEL.modeCardFor(mode)).click();
    await page.waitForTimeout(150);
    expect(await page.locator(`${SEL.tabFor('home')}[aria-current]`).count(), `still on Home after clicking ${mode}`).toBe(1);
    expect(await page.locator(SEL.pitch).count(), 'no match started').toBe(0);
    expect(await page.locator(SEL.tabFor('competitions')).count(), 'no Competitions tab').toBe(0);
  }
  // Tab never stops on them: the stops in Home are exactly the play buttons.
  await page.locator(SEL.kickOff).focus();
  const stops = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => (document.activeElement && (document.activeElement.id || document.activeElement.className)) || ''));
  }
  expect(stops.slice(0, 4), 'Tab order through the mode cards').toEqual(['play-local2p', 'play-link', 'practice-easy', 'practice-normal']);
  expect(stops.some((s) => /mode-card/.test(s)), 'no stop on a locked card').toBe(false);
});

for (const width of [1280, 390]) {
  for (const colorScheme of ['light', 'dark']) {
    test(`home: level 1 fits ${width}px ${colorScheme} with Kick off in the first view`, async (t) => {
      const height = width === 390 ? 844 : 800;
      const page = await openApp(t, { level: null, width, height, colorScheme });
      await page.evaluate(() => window.scrollTo(0, 0));
      const w = await pageWidths(page);
      expect(w.scrollWidth, `scrollWidth (innerWidth ${w.innerWidth})`).toBeLessThanOrEqual(w.innerWidth);
      const box = await page.locator(SEL.kickOff).boundingBox();
      expect(box.y + box.height, 'Kick off is above the fold').toBeLessThanOrEqual(height);
      expect(box.height, 'Kick off is big').toBeGreaterThanOrEqual(56);
      // Every mode card fits inside the page.
      const right = await page.$$eval(SEL.modeCard, (els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)));
      expect(right, 'cards inside the viewport').toBeLessThanOrEqual(w.innerWidth);
    });
  }
}

test('home: the keyboard reaches Kick off first after the skip link', async (t) => {
  const page = await openApp(t, { level: null });
  await reload(page);
  await page.waitForSelector(SEL.kickOff);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.getAttribute('data-action')), 'skip link first').toBe('skip-to-main');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => document.activeElement.id), 'main focused').toBe('main');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement.id), 'then Kick off').toBe('kick-off');
  expect(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'focus is visible').notToBe('none');
  await page.keyboard.press('Enter');
  await page.waitForSelector(SEL.pitch);
});

test('home: there is no match length choice; old saved lengths are dropped', async (t) => {
  const page = await openApp(t, { level: null, prefs: { halfSeconds: 120, controls: 'keys', onboarded: true } });
  expect(await page.locator('#main select').count(), 'no select on Home').toBe(0);
  expect(await page.locator(`${SEL.hero} .hero-len [aria-hidden]`).innerText(), 'the standard length is shown').toMatch(/^2 × \d min$/);
  // Boot rewrites prefs: the old selector's 2-minute choice is gone, the rest is kept.
  const prefs = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), PREFS_KEY);
  expect(prefs.halfSeconds, 'legacy length dropped').toBe(undefined);
  expect(prefs.controls, 'controls kept').toBe('keys');
});

test('home: the dashboard gains one element per unlock', async (t) => {
  const stats = async (level) => {
    const page = await openApp(t, { level });
    const r = {
      stats: await page.$$eval(`${SEL.statusStrip} .stat`, (els) => els.map((e) => e.classList[1])),
      locked: await page.$$eval(SEL.lockedCard, (els) => els.map((e) => e.getAttribute('data-mode'))),
      hard: await page.locator(`${SEL.playPractice}[data-level="hard"]`).count(),
      cards: await page.locator(SEL.modeCard).count(),
    };
    await page.close();
    return r;
  };
  expect((await stats(3)).stats, 'level 3: nothing yet').toEqual([]);
  expect((await stats(4)).stats, 'level 4: sessions').toEqual(['sessions']);
  const five = await stats(5);
  expect(five.locked, 'level 5: the Cup opens').toEqual(['league']);
  expect(five.hard, 'and Practice Hard').toBe(1);
  expect(five.cards, 'still four mode cards').toBe(4);
  expect(five.stats, 'level 5: still just sessions').toEqual(['sessions']);
  expect((await stats(6)).stats, 'level 6: money').toEqual(['sessions', 'money']);
  expect((await stats(7)).stats, 'level 7: ladder position').toEqual(['sessions', 'money', 'rank']);
  const eight = await stats(8);
  expect(eight.locked, 'level 8: the League opens').toEqual([]);
  expect((await stats(10)).stats, 'level 10: the season week').toEqual(['sessions', 'money', 'rank', 'week']);
});

test('home: an unlocked Cup card opens Competitions', async (t) => {
  const page = await openApp(t, { level: 5 });
  await page.locator(`${SEL.modeCardFor('cup')} [data-action="go"]`).click();
  await page.waitForSelector(`${SEL.tabFor('competitions')}[aria-current]`);
  expect(await page.evaluate(() => document.activeElement.id), 'focus on the Competitions tab').toBe('tab-competitions');
  expect(await page.locator('[data-action="comp-start-cup"]').count(), 'the cup can start').toBe(1);
});
