// Gradual onboarding: a fresh visit is one click from a live match (no forms first), light coach tips
// teach inside it, the menus are revealed by club level with a coach mark on each new tab, the first
// match stays pending until it is played to the end, and existing saves keep what they had.

const { test, expect } = require('./lib/harness.cjs');
const { APP_URL, SEL, PREFS_KEY, nextVisit, openApp, readSave, tabScreens, waitForHome } = require('./lib/helpers.cjs');

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

const prefsOf = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k)), PREFS_KEY);
const tipId = (page) => page.evaluate(() => { const el = document.querySelector('.coach-tip'); return el && !el.hidden ? el.dataset.coachTip : null; });

/**
 * Wait for open play, then put the ball at our controlled player's feet within shooting range (23 m out). The coach looks at it in the
 * same turn (window.__derbyCoach.advance(0)), so nothing in the sim, such as the CPU winning the ball back on a slow runner,
 * can change the situation before the coach has seen it.
 */
async function giveBall(page) {
  await page.waitForFunction(() => window.__derbyMatch.phase === 'play', null, { timeout: 60_000 });
  await page.evaluate(() => {
    const s = window.__derbyMatch;
    const me = s.controlled[0];
    s.players[me].pos = { x: 82, y: 34 };
    s.ball.owner = me;
    s.ball.pos = { x: 82, y: 34 };
    window.__derbyCoach.advance(0);
  });
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
  const t0 = await page.evaluate(() => window.__derbyMatch.tick);
  await page.waitForFunction((a) => window.__derbyMatch.tick > a + 30, t0, { timeout: 15_000 });
  expect(await page.locator('.scoreboard').innerText(), 'a scoreboard').toMatch(/\d/);
  const prefs = await prefsOf(page);
  expect(Array.isArray(prefs.coachSeen), 'the coach is on').toBe(true);
  expect(prefs.onboarded, 'setup is not over until the first match is played').toBe(false);
});

test('onboarding: leaving or reloading the first match brings the welcome and the same opponent back', async (t) => {
  const page = await freshVisit(t);
  const opp = (await page.locator('.ob-versus .side-name').nth(1).innerText()).trim();
  await page.locator(KICK).click();
  await page.waitForSelector(SEL.pitch);
  // Esc, Leave match: nothing recorded, and the welcome is back with the same club.
  await page.keyboard.press('Escape');
  await page.locator(SEL.forfeit).click();
  await page.waitForSelector(KICK);
  expect((await page.locator('.ob-versus .side-name').nth(1).innerText()).trim(), 'same opponent after leaving').toBe(opp);
  expect((await readSave(page)).history.length, 'nothing recorded').toBe(0);
  expect((await prefsOf(page)).onboarded, 'still pending').toBe(false);
  // Coming back mid-match (closing the tab during the first match) is the same: a new visit while the first page is
  // still in the match. (nextVisit, not page.reload(): see helpers.cjs.)
  await page.locator(KICK).click();
  await page.waitForSelector(SEL.pitch);
  const next = await nextVisit(page);
  await next.waitForSelector(KICK);
  expect((await next.locator('.ob-versus .side-name').nth(1).innerText()).trim(), 'same opponent on the next visit').toBe(opp);
  expect(await next.locator(SEL.tab).count(), 'no tabs yet').toBe(0);
});

test('onboarding: "I\'ve played before" skips straight to Home with no coach', async (t) => {
  const page = await freshVisit(t);
  await page.locator('[data-action="skip-onboarding"]').click();
  await page.waitForSelector(SEL.kickOff);
  expect(await tabScreens(page), 'only Home').toEqual(['home']);
  const prefs = await prefsOf(page);
  expect(prefs.onboarded, 'done').toBe(true);
  expect(prefs.coachSeen, 'no tips for them').toBe(undefined);
  expect(prefs.marks, 'no tab marks for them').toBe(undefined);
});

test('onboarding: the first tip is readable: it holds for seconds and is not cut off by the next one', async (t) => {
  const page = await freshVisit(t);
  await page.locator(KICK).click();
  await page.waitForSelector(SEL.pitch);
  await page.waitForSelector(TIP, { timeout: 40_000 });
  // The player holds the ball at kick-off, so the first tip is about the ball; it also says who he is and where he attacks.
  expect(await tipId(page), 'the first tip is about the ball').toBe('pass');
  // From here the tip clock moves only when this test advances it. Frames on a slow runner (and the wait for open play in
  // giveBall) would otherwise age the card in wall time and let the queued tip replace it before the checks below.
  await page.evaluate(() => window.__derbyCoach.freeze());
  expect(await page.locator(TIP).innerText(), 'text').toMatch(/pass/i);
  expect(await page.locator(TIP).innerText(), 'says which player is you and which way you attack').toMatch(/yellow ring.*goal on the right/i);
  await page.waitForFunction(() => /^Tip\./.test(document.getElementById('sr-announcer')?.textContent || ''), null, { timeout: 5000 });
  // The human has the ball (as at a real kick-off): 'run' is queued behind 'pass' and must wait its turn. The ball is
  // held there on every step. Time is the coach's own tip clock (window.__derbyCoach), not wall time, which a slow
  // software renderer stretches: advance it in steps and look at the card after each.
  await giveBall(page);
  const hold = () => page.evaluate(() => { const s = window.__derbyMatch; s.ball.owner = s.controlled[0]; return window.__derbyCoach.state(); });
  let st = await hold();
  expect(st.queue, "'run' is waiting behind 'pass'").toContain('run');
  expect(st.minMs, 'a tip holds for at least five seconds').toBeGreaterThanOrEqual(5000);
  while (st.age + 250 < st.minMs) {
    await page.evaluate(() => window.__derbyCoach.advance(250));
    st = await hold();
    expect(st.shown, `'pass' is still up at ${Math.round(st.age)} ms of tip time, before its ${st.minMs} ms are up`).toBe('pass');
  }
  // Counted as shown once it has been up for 4 s of tip time (and so remembered), well before it may be replaced.
  expect(st.counted, 'counted as shown after 4 s').toBe(true);
  expect((await prefsOf(page)).coachSeen, 'and remembered').toContain('pass');
  // Once its reading time is up, the queued tip takes over, because it is still true.
  await page.evaluate(() => window.__derbyCoach.advance(300));
  await page.evaluate(() => { const s = window.__derbyMatch; s.ball.owner = s.controlled[0]; window.__derbyCoach.advance(0); });
  expect(await tipId(page), 'then the queued tip takes over').toBe('run');
});

test('onboarding: a tip card never blocks the game: clicks pass through it, it is off the action, it hides while paused', async (t) => {
  const page = await freshVisit(t);
  await page.locator(KICK).click();
  await page.waitForSelector(TIP, { timeout: 40_000 });
  expect(await page.locator('.coach-tip').evaluate((el) => getComputedStyle(el).pointerEvents), 'card passes pointer events through').toBe('none');
  expect(await page.locator('.coach-x').evaluate((el) => getComputedStyle(el).pointerEvents), 'but the button works').toBe('auto');
  // Top-centre under the HUD row: clear of the radar (bottom) and the ball area, and inside the pitch.
  const wrap = await page.locator('.pitch-wrap').boundingBox();
  const tip = await page.locator('.coach-tip').boundingBox();
  const radar = await page.locator('.hud-radar').boundingBox();
  expect(tip.y, 'under the score row').toBeGreaterThanOrEqual(wrap.y + 50);
  expect(tip.y + tip.height, 'above the middle of the pitch').toBeLessThan(wrap.y + wrap.height * 0.4);
  expect(tip.y + tip.height, 'clear of the radar').toBeLessThan(radar.y);
  expect(tip.x, 'inside the pitch').toBeGreaterThanOrEqual(wrap.x);
  expect(tip.x + tip.width, 'inside the pitch').toBeLessThanOrEqual(wrap.x + wrap.width);
  // A point under the card reaches the canvas.
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y).id, [tip.x + tip.width / 2, tip.y + 4]);
  expect(hit, 'the pitch gets the pointer through the card').toBe('pitch');
  // Paused: the card is not shown above the pause menu.
  await page.keyboard.press('Escape');
  await page.locator(SEL.pause).waitFor({ state: 'visible' });
  expect(await page.locator('.coach-tip').evaluate((el) => getComputedStyle(el).visibility), 'hidden while paused').toBe('hidden');
  await page.locator(SEL.resume).click();
  expect(await page.locator('.coach-tip').evaluate((el) => getComputedStyle(el).visibility), 'back after resume').toBe('visible');
});

test('onboarding: a coach tip does not pause play, can be dismissed, and is not shown twice', async (t) => {
  const page = await freshVisit(t);
  await page.locator(KICK).click();
  await page.waitForSelector(SEL.pitch);
  await page.waitForSelector(TIP, { timeout: 40_000 });
  const a = await page.evaluate(() => window.__derbyMatch.tick);
  await page.waitForFunction((x) => window.__derbyMatch.tick > x + 20, a, { timeout: 15_000 });
  expect(await page.locator(SEL.pause).isHidden(), 'no pause menu').toBe(true);
  await page.locator('.coach-x').click();
  expect(await page.locator('.coach-tip').isHidden(), 'dismissed').toBe(true);
  expect((await prefsOf(page)).coachSeen, '"Got it" counts as read').toContain('pass');
  await page.waitForTimeout(1500);
  expect(await page.locator(`${TIP}[data-coach-tip="pass"]`).count(), 'pass is not shown twice').toBe(0);
});

test('onboarding: situational tips fire once each, only while still true: the ball, a shot, losing it', async (t) => {
  const page = await freshVisit(t);
  await page.locator(KICK).click();
  await page.waitForSelector(SEL.pitch);
  await page.waitForSelector(TIP, { timeout: 40_000 });
  await page.locator('.coach-x').click();
  await giveBall(page);
  // Each tip is read, dismissed, and the coach is let look again in the same turn, so the queued tip shows at once.
  const next = async (name) => {
    await page.waitForFunction((n) => document.querySelector('.coach-tip')?.dataset.coachTip === n && !document.querySelector('.coach-tip').hidden, name, { timeout: 15_000 });
    const text = await page.locator('.coach-tip').innerText();
    await page.locator('.coach-x').click();
    await page.evaluate(() => window.__derbyCoach.advance(0));
    return text;
  };
  // The first card (pass, the ball is ours at kick-off) is dismissed above; 'run' follows, then 'shoot' once in range.
  expect(await next('run'), 'run tip').toMatch(/run/i);
  expect(await next('shoot'), 'shoot tip (in range of goal)').toMatch(/shoot|shot/i);
  await page.evaluate(() => { const s = window.__derbyMatch; s.ball.owner = s.players.find((p) => p.team === 1).i; window.__derbyCoach.advance(0); });
  expect(await next('tackle'), 'tackle tip').toMatch(/tackle/i);
  const prefs = await prefsOf(page);
  for (const id of ['pass', 'run', 'shoot', 'tackle']) expect(prefs.coachSeen, `${id} remembered`).toContain(id);
  await giveBall(page);
  await page.waitForTimeout(800);
  // The match goes on, so a different first-time tip (a restart that is ours) may rightly appear; the three seen ones must not.
  expect(['pass', 'run', 'shoot', 'tackle'].includes(await tipId(page)), 'none of the four is shown again for the same situation').toBe(false);
});

test('onboarding: tip wording follows the live input, and the settled input becomes the preference', async (t) => {
  const page = await freshVisit(t, { halfSeconds: 3 });
  await page.locator(KICK).click();
  await page.waitForSelector(SEL.pitch);
  await page.waitForSelector(TIP, { timeout: 40_000 });
  await page.locator('.coach-x').click();
  // The controller goes back to mouse mode on any mouse pointermove over the pitch, and Chromium makes up such a move when
  // the layout changes under a still pointer. Park the pointer off the pitch, so only the keyboard decides the mode.
  await page.mouse.move(8, 400);
  expect(await page.evaluate(() => document.elementFromPoint(8, 400).id), 'the pointer is not over the pitch').notToBe('pitch');
  // Use the keyboard: the controller switches to keys, so the next tip talks about keys, not clicks.
  await page.locator(SEL.pitch).focus();
  await page.keyboard.down('d');
  await page.waitForTimeout(150);
  await page.keyboard.up('d');
  await giveBall(page);
  // 'run' is queued ahead of 'shoot': read it (dismiss it) and let the coach look again.
  await page.waitForFunction(() => document.querySelector('.coach-tip')?.dataset.coachTip === 'run', null, { timeout: 15_000 });
  await page.locator('.coach-x').click();
  await page.evaluate(() => window.__derbyCoach.advance(0));
  await page.waitForFunction(() => document.querySelector('.coach-tip')?.dataset.coachTip === 'shoot', null, { timeout: 15_000 });
  // The shoot tip may already be up in mouse words when the key is pressed; the coach re-writes the card on the next frame
  // after the mode changes, so wait for that: it is the feature.
  await page.waitForFunction(() => /hold f/i.test(document.querySelector('.coach-tip')?.textContent || ''), null, { timeout: 15_000 });
  expect(await page.locator('.coach-tip').innerText(), 'keyboard wording').toMatch(/hold f/i);
  expect(await page.locator('.coach-tip').innerText(), 'and not the mouse wording').notToContain('Right click');
  // The first match ends: the mode the player settled on is saved.
  await page.waitForSelector('.ob-celebrate', { timeout: 90_000 });
  expect((await prefsOf(page)).controls, 'keys remembered').toBe('keys');
});

test('onboarding: the first match ends in a celebration with XP that names what opens, then an optional naming step', async (t) => {
  const page = await freshVisit(t, { halfSeconds: 3 });
  await page.locator(KICK).click();
  await page.waitForSelector('.ob-celebrate', { timeout: 90_000 });
  const text = await page.locator('.ob-celebrate').innerText();
  expect(text, 'XP for the match and the milestone').toMatch(/\+\d+ XP/);
  expect(text, 'first match milestone').toContain('first match 80');
  expect(text, 'no "practice (Easy)" jargon').notToContain('practice');
  expect(text, 'names what level 2 opens, once').toMatch(/Now open: Squad, vs Player: one screen, vs Player: two tabs and Practice: Easy/);
  await page.waitForFunction(() => /(won|lost|draw)[^.]*\.\s*\d+ XP earned\./i.test(document.getElementById('sr-announcer')?.textContent || ''), null, { timeout: 3000 });
  expect(await page.evaluate(() => document.getElementById('sr-announcer')?.textContent || ''), 'no repeated "full time"').notToContain('Full time');
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
  // Said once on the celebration: no level-up dialog and no tab mark repeat it.
  await page.waitForSelector(SEL.kickOff);
  expect(await page.locator(SEL.modal).count(), 'no level-up dialog').toBe(0);
  expect(await page.locator('.tab-mark').count(), 'no tab mark').toBe(0);
  expect(await tabScreens(page), 'Home and Squad').toEqual(['home', 'squad']);
  expect(await page.locator(SEL.playLocal2p).count(), 'vs Player is on Home right after the first match').toBe(1);
  expect(await page.locator(SEL.playLink).count(), 'Link two tabs too').toBe(1);
  expect((await prefsOf(page)).onboarded, 'setup is over').toBe(true);
  expect((await readSave(page)).club.name, 'name saved').toBe('Harbour Lights');
  // After that Kick off is the warm-up friendly, not ranked.
  expect(await page.locator(SEL.kickOff).getAttribute('data-action'), 'warm-up').toBe('play-warmup');
});

test('onboarding: the naming step can be skipped', async (t) => {
  const page = await freshVisit(t, { halfSeconds: 3 });
  await page.locator(KICK).click();
  await page.waitForSelector('.ob-celebrate', { timeout: 90_000 });
  const name = (await readSave(page)).club.name;
  await page.locator('[data-ob="skip"]').click();
  await page.waitForSelector(SEL.tab);
  expect((await readSave(page)).club.name, 'name unchanged').toBe(name);
});

test('onboarding: coming back while the celebration is up does not replay the welcome', async (t) => {
  const page = await freshVisit(t, { halfSeconds: 3 });
  await page.locator(KICK).click();
  await page.waitForSelector('.ob-celebrate', { timeout: 90_000 });
  // What is stored when the celebration shows: the match is recorded, the milestone claimed, and setup is over.
  const before = await page.evaluate(() => {
    const save = JSON.parse(localStorage.getItem('derbyday.save.v1'));
    return { history: save.history.length, milestones: save.milestones, xp: save.xp, prefs: localStorage.getItem('derbyday.prefs.v1') };
  });
  expect(before.history, 'the first match is saved when the celebration shows').toBe(1);
  expect(before.milestones, 'with its milestone').toContain('first-match');
  const p = JSON.parse(before.prefs);
  expect(p.onboarded, 'setup is over').toBe(true);
  expect(p.coachSeen, 'and the coach prefs are kept').toBeTruthy();
  expect(p.marks, 'with the tab marks').toContain('squad');
  // A Chromium in-memory context can drop localStorage across page.reload(), so the next visit is a new page (see nextVisit).
  const next = await nextVisit(page);
  await waitForHome(next, 'celebration next visit');
  expect(await next.locator(KICK).count(), 'no welcome: the match is already recorded').toBe(0);
  expect(await next.locator(SEL.modal).count(), 'and no level-up dialog: the celebration already named what opened').toBe(0);
  expect((await prefsOf(next)).coachSeen, 'the coach prefs survive').toBeTruthy();
  expect((await readSave(next)).history.length, 'and so does the match').toBe(1);
});

test('onboarding: until level 3 Kick off is a warm-up friendly that earns XP and leaves Elo alone; at 3 it is ranked', async (t) => {
  const page = await openApp(t, { xp: 120, prefs: { halfSeconds: 3, controls: 'mouse', onboarded: true } });
  expect((await page.locator(`${SEL.hero} .hero-tag`).innerText()).trim(), 'warm-up').toMatch(/^warm-up friendly$/i);
  await page.locator(SEL.kickOff).click();
  await page.waitForSelector(SEL.pitch);
  expect(await page.locator('.scoreboard').innerText(), 'a generated club, not a ladder club').toMatch(/\w/);
  await page.locator(SEL.modalClose).waitFor({ timeout: 80_000 });
  const save = await readSave(page);
  expect(save.history.at(-1).competition, 'recorded as a warm-up').toBe('Warm-up friendly');
  expect(save.history.at(-1).ranked, 'not ranked').toBe(false);
  expect(save.club.elo, 'Elo untouched').toBe(1000);
  expect(save.xp, 'earned XP').toBeGreaterThanOrEqual(120 + 50);
  // The result dialog does not talk about prize money or sessions it cannot use yet.
  const rewards = await page.locator('.rs-rewards').innerText();
  expect(rewards, 'the Training session is kept, and says until when').toMatch(/kept until Training opens at level 4/);
  await page.locator(SEL.modalClose).click();
});

test('onboarding: level 1 shows only Home; a level-up reveals the next tab with a coach mark, once', async (t) => {
  const prefs = { halfSeconds: 3, controls: 'mouse', onboarded: true, coachSeen: [], marks: ['home', 'squad'] };
  // 10 XP short of level 3: any warm-up tips it over (a win pays 120, even a loss 50).
  const page = await openApp(t, { xp: totalXp(3) - 10, prefs, mutateSave: (save) => { save.unlocksSeen = ['home', 'squad', 'local2p', 'link', 'practice']; } });
  expect(await tabScreens(page), 'level 2: Home and Squad').toEqual(['home', 'squad']);
  expect(await page.locator('.tab-mark').count(), 'no mark yet').toBe(0);
  await page.locator(SEL.kickOff).click();
  await page.locator(SEL.modalClose).waitFor({ timeout: 80_000 });
  await page.locator(SEL.modalClose).click();
  await page.locator(SEL.levelUp).waitFor();
  expect(await page.locator('.tab-mark').count(), 'the mark waits behind the dialog').toBe(0);
  await page.locator(SEL.levelUpClose).click();
  const mark = page.locator('.tab-mark[data-mark="club"]');
  await mark.waitFor();
  expect(await mark.innerText(), 'says what it is').toContain('Club');
  expect(await page.locator(`${SEL.tabFor('club')}.coach-spot`).count(), 'the tab is spotlit').toBe(1);
  // The card follows the tab bar in focus order and sits under its tab, inside the viewport.
  expect(await page.evaluate(() => document.querySelector('.tabs').nextElementSibling.classList.contains('tab-mark')), 'right after the tabs in the DOM').toBe(true);
  const box = await mark.boundingBox();
  const tabBox = await page.locator(SEL.tabFor('club')).boundingBox();
  expect(box.y, 'below the tab').toBeGreaterThanOrEqual(tabBox.y + tabBox.height);
  expect(box.x + box.width, 'inside the viewport').toBeLessThanOrEqual(1280);
  await page.locator('[data-action="mark-ok"]').click();
  expect(await page.locator('.tab-mark').count(), 'dismissed').toBe(0);
  expect((await prefsOf(page)).marks, 'remembered').toContain('club');
  const next = await nextVisit(page); // not page.reload(): see helpers.cjs
  await next.waitForSelector(SEL.kickOff);
  expect(await next.locator('.tab-mark').count(), 'not again on the next visit').toBe(0);
});

const totalXp = (level) => 50 * level * (level - 1);

test('onboarding: a tab mark is announced once, is dismissed with Esc, and never fights scrolling', async (t) => {
  const prefs = { controls: 'mouse', onboarded: true, coachSeen: [], marks: ['home'] };
  const page = await openApp(t, { xp: 120, prefs, width: 390, height: 420, mutateSave: (save) => { save.unlocksSeen = ['home', 'squad', 'local2p', 'link', 'practice']; } });
  await page.locator('.tab-mark[data-mark="squad"]').waitFor();
  // The first announcement is delayed a moment by the live region; let it land before counting repeats.
  await page.waitForFunction(() => (document.getElementById('sr-announcer')?.textContent || '').includes('New: Squad'), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  // Count how many times the live region is set to the mark's words across several renders.
  await page.evaluate(() => {
    window.__spoken = 0;
    new MutationObserver(() => { if ((document.getElementById('sr-announcer')?.textContent || '').includes('New: Squad')) window.__spoken++; })
      .observe(document.getElementById('sr-announcer'), { childList: true, characterData: true, subtree: true });
  });
  for (let i = 0; i < 3; i++) {
    await page.locator(SEL.tabFor('home')).click();
    await page.waitForTimeout(250);
  }
  expect(await page.evaluate(() => window.__spoken), 're-renders do not repeat the announcement').toBe(0);
  // Scrolling is the player's own: the mark does not pull the page back.
  expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 100), 'the page scrolls at this height').toBe(true);
  await page.evaluate(() => window.scrollTo(0, 160));
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.scrollY), 'scroll position held').toBeGreaterThan(100);
  await page.evaluate(() => window.scrollTo(0, 0));
  // Esc dismisses it, and counts as seen.
  await page.keyboard.press('Escape');
  expect(await page.locator('.tab-mark').count(), 'Esc dismisses').toBe(0);
  expect((await prefsOf(page)).marks, 'remembered').toContain('squad');
});

test('onboarding: opening a revealed tab counts as seeing it', async (t) => {
  const prefs = { halfSeconds: 3, controls: 'mouse', onboarded: true, coachSeen: [], marks: ['home'] };
  const page = await openApp(t, { xp: 120, prefs, mutateSave: (save) => { save.unlocksSeen = ['home', 'squad', 'local2p', 'link', 'practice']; } });
  expect(await page.locator('.tab-mark[data-mark="squad"]').count(), 'squad is pointed out').toBe(1);
  await page.locator(SEL.tabFor('squad')).click();
  await page.waitForSelector(`${SEL.tabFor('squad')}[aria-current]`);
  expect(await page.locator('.tab-mark').count(), 'no mark on the tab you opened').toBe(0);
  await page.locator(SEL.tabFor('home')).click();
  expect(await page.locator('.tab-mark').count(), 'and not afterwards').toBe(0);
});

test('onboarding: at level 1-2 the header badge is not a button; from the Club tab on it is', async (t) => {
  const a = await openApp(t, { level: null });
  expect(await a.locator(SEL.levelBadge).count(), 'no button at level 1').toBe(0);
  const b = await openApp(t, { level: 3 });
  expect(await b.locator(SEL.levelBadge).count(), 'a button once the Club tab exists').toBe(1);
});

test('onboarding: a club can be renamed from the Club tab at any time', async (t) => {
  const page = await openApp(t, { level: 4, mutateSave: (save) => { save.club.played = 9; } });
  await page.locator(SEL.tabFor('club')).click();
  await page.locator('#club-rename').fill('Harbour Lights');
  await page.locator('.rename-form [type="submit"]').click();
  await page.waitForFunction(() => /Harbour Lights/.test(document.querySelector('.club-name')?.textContent || ''));
  expect((await readSave(page)).club.name, 'saved').toBe('Harbour Lights');
  await page.locator('#club-rename').fill('x');
  await page.locator('.rename-form [type="submit"]').click();
  expect((await readSave(page)).club.name, 'an invalid name is refused').toBe('Harbour Lights');
});

test('onboarding: an existing save keeps every feature it had, with nothing moved further away and no tips or marks', async (t) => {
  // A level-4 club from before the gradual table: Squad, Club, Practice, vs Player, Training, Transfers, Ladder.
  const page = await openApp(t, {
    level: null,
    mutateSave: (save) => {
      save.xp = 700;
      save.unlocksSeen = ['club', 'squad', 'ranked', 'practice', 'local2p', 'link', 'training', 'transfers', 'ladder'];
      delete save.unlocksV;
    },
  });
  expect(await tabScreens(page), 'tabs it had').toEqual(['home', 'squad', 'transfers', 'training', 'ladder', 'club']);
  expect(await page.locator(SEL.playPractice).count(), 'Easy and Normal practice').toBe(2);
  expect(await page.locator(SEL.playLocal2p).count(), 'Local 2P').toBe(1);
  expect(await page.locator(SEL.playLink).count(), 'Link two tabs').toBe(1);
  expect(await page.locator(SEL.playRanked).count(), 'ranked Kick off, not a warm-up').toBe(1);
  expect(await page.locator('.tab-mark').count(), 'no marks for a returning player').toBe(0);
  expect(await page.locator(SEL.levelUp).count(), 'no false level-up dialog').toBe(0);
  const save = await readSave(page);
  expect(save.unlocksV, 'migrated').toBe(2);
  expect(save.legacyUnlocks, 'flagged so nothing moves later').toBe(true);
  // The Cup it was working toward (old level 5) is still at 5, not at the new table's... 5; League stays at 8.
  await page.locator(SEL.tabFor('club')).click();
  expect(await page.locator(SEL.nextUnlock).innerText(), 'the next unlock is where it was').toContain('The Cup and Practice: Hard at level 5');
  const next = await nextVisit(page); // not page.reload(): see helpers.cjs
  await next.waitForSelector(SEL.kickOff);
  expect(await next.locator(KICK).count(), 'no welcome').toBe(0);
});

test('onboarding: the welcome and the first match fit a phone', async (t) => {
  const page = await freshVisit(t, { width: 390, height: 844 });
  const w = await page.evaluate(() => ({ s: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), i: window.innerWidth }));
  expect(w.s, 'no horizontal overflow on the welcome').toBeLessThanOrEqual(w.i);
  const kb = await page.locator(KICK).boundingBox();
  expect(kb.y + kb.height, 'Kick off above the fold').toBeLessThanOrEqual(844);
  await page.locator(KICK).click();
  await page.waitForSelector(TIP, { timeout: 40_000 });
  const tb = await page.locator('.coach-tip').boundingBox();
  expect(tb.x, 'tip inside the screen').toBeGreaterThanOrEqual(0);
  expect(tb.x + tb.width, 'tip inside the screen').toBeLessThanOrEqual(390);
  await expectTipClearOfControls(page, 'welcome phone');
});

/**
 * The phone tip must not sit on any pitch button (camera, zoom, pause) nor on the HUD column on the right, and its
 * "Got it" must be a real touch target.
 */
async function expectTipClearOfControls(page, label) {
  const r = await page.evaluate(() => {
    const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, name: el.getAttribute('aria-label') || el.id || el.className || el.tagName }; };
    const tip = document.querySelector('.coach-tip');
    const tb = box(tip);
    const hits = [];
    for (const b of document.querySelectorAll('.pitch-wrap button')) {
      if (tip.contains(b)) continue;
      const st = getComputedStyle(b);
      const bb = box(b);
      if (st.visibility === 'hidden' || st.display === 'none' || bb.w === 0) continue;
      if (bb.x < tb.x + tb.w && bb.x + bb.w > tb.x && bb.y < tb.y + tb.h && bb.y + bb.h > tb.y) hits.push(bb.name);
    }
    return { tip: tb, hits, x: box(document.querySelector('.coach-x')) };
  });
  expect(r.hits, `${label}: the tip covers no pitch button`).toEqual([]);
  expect(r.x.w, `${label}: "Got it" is at least 44 px wide`).toBeGreaterThanOrEqual(44);
  expect(r.x.h, `${label}: "Got it" is at least 44 px tall`).toBeGreaterThanOrEqual(44);
}
