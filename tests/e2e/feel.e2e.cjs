// Feel polish: a conceded goal is quieter than a scored one, the result card counts its rewards up (ending on the
// same text), and the big-desktop scoreboard does not touch the radar.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, startRanked } = require('./lib/helpers.cjs');

const PREFS = { halfSeconds: 120, onboarded: true };

async function inPlay(t, opts = {}) {
  const page = await openApp(t, { e2eHook: true, prefs: PREFS, ...opts });
  await startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60_000 });
  return page;
}

/** Add a goal to the live match the way the sim does (the match view and the juice watch s.goals). */
const addGoal = (page, team, ownGoal = false) =>
  page.evaluate(
    ({ team, ownGoal }) => {
      const s = window.__derbyMatch;
      s.goals.push({ kind: 'goal', tick: s.tick, team, player: -1, scorer: 'Tester', ownGoal, from: 'play', minute: 12 });
      s.score[team]++;
    },
    { team, ownGoal },
  );

const goalState = (page) =>
  page.evaluate(() => ({
    word: document.getElementById('banner').innerText,
    conceded: document.getElementById('banner').classList.contains('conceded'),
    wrapConceded: document.querySelector('.pitch-wrap').classList.contains('conceded'),
    flash: document.querySelector('.juice-flash')?.style.background || '',
    size: parseFloat(getComputedStyle(document.getElementById('banner')).fontSize),
  }));

/** The last goal's banner has gone, so the next wait sees the next goal's banner and not a leftover (a slow CI
 *  runner can keep one up past any fixed pause). */
const bannerClear = (page) => page.waitForFunction(() => { const b = document.getElementById('banner'); return !b || b.hidden || !/goal/i.test(b.innerText); }, null, { timeout: 15_000 });

const bannerHasGoal = () => {
  const b = document.getElementById('banner');
  return !!b && !b.hidden && /goal/i.test(b.innerText);
};

test('a conceded goal gets a small subdued banner and a dark flash; a scored one stays big, and an own goal into your net counts as conceded', async (t) => {
  const page = await inPlay(t);
  const home = await page.evaluate(() => (window.__derbyMatch.humans[0] ? 0 : 1));
  const opp = 1 - home;

  await addGoal(page, opp);
  await page.waitForFunction(bannerHasGoal);
  let g = await goalState(page);
  expect(g.conceded, 'banner is the subdued kind').toBe(true);
  expect(g.wrapConceded, 'dim flash class').toBe(true);
  expect(g.word, 'says Goal · Team').toMatch(/^goal · /i);
  expect(/255, 255, 255|#fff/i.test(g.flash), 'no white flash from the juice layer').toBe(false);
  const small = g.size;

  await bannerClear(page);
  await addGoal(page, home);
  await page.waitForFunction(() => {
    const b = document.getElementById('banner');
    return !b.hidden && /goal/i.test(b.innerText) && !b.classList.contains('conceded');
  });
  g = await goalState(page);
  expect(g.wrapConceded, 'a scored goal keeps the white flash').toBe(false);
  expect(g.word.includes('·'), 'big word, no team suffix').toBe(false);
  expect(g.size > small * 1.5, `scored word (${g.size}px) is bigger than the conceded one (${small}px)`).toBe(true);

  await bannerClear(page);
  await addGoal(page, opp, true);
  await page.waitForFunction(bannerHasGoal);
  g = await goalState(page);
  expect(g.conceded, 'an own goal credited to the other side is one you let in').toBe(true);
});

test('the result card counts Elo up, ends on the final text, and Watch goals is a small button', async (t) => {
  const page = await openApp(t, { prefs: { halfSeconds: 3 } });
  await startRanked(page);
  await page.locator(SEL.modal).waitFor({ timeout: 60_000 });
  const chip = page.locator('.modal .rs-elo .rs-chip-main[data-count]');
  expect(await chip.count(), 'the Elo value is a counting chip').toBe(1);
  // While it counts, a reader gets the final value (an sr-only twin) and the moving digits are aria-hidden.
  const said = await chip.evaluate((el) => el.querySelector('.sr-only')?.textContent ?? null);
  if (said !== null) {
    expect(await chip.evaluate((el) => el.querySelector('[aria-hidden="true"]') !== null), 'moving digits hidden from readers').toBe(true);
    // The visible text settles on that same value, as one plain string.
    await page.waitForFunction((l) => { const e = document.querySelector('.modal .rs-elo .rs-chip-main'); return e.textContent === l && !e.children.length; }, said, { timeout: 4000 });
  }
  expect(await chip.innerText(), 'final text is a signed Elo change').toMatch(/^[+−-]?\d+$|^±0$|^0$/);
  const btn = page.locator('.modal [data-replay="watch"]');
  if (await btn.count()) {
    expect(await btn.evaluate((e) => e.classList.contains('btn') && e.classList.contains('small') && !!e.querySelector('svg')), 'Watch goals: small button, play glyph').toBe(true);
  }
  expect(await page.locator('.modal [data-replay="copy"]').count(), 'copy stays').toBe(1);
});

test('big desktop (1440x900, 3D): bigger scoreboard, radar clear of it', async (t) => {
  const page = await openApp(t, { width: 1440, height: 900, prefs: { halfSeconds: 20 }, renderer: '3d' });
  await startRanked(page);
  await page.waitForSelector('.hud-radar');
  const r = await page.evaluate(() => {
    const b = (s) => document.querySelector(s).getBoundingClientRect();
    return {
      radar: b('.hud-radar'),
      tl: b('.hud-tl'),
      score: parseFloat(getComputedStyle(document.querySelector('.hud-bar')).fontSize),
      clock: parseFloat(getComputedStyle(document.querySelector('.hud-clock')).fontSize),
    };
  });
  expect(r.score, 'score font').toBe(28);
  expect(r.clock, 'clock font').toBe(18);
  expect(r.radar.top >= r.tl.bottom, `radar (${r.radar.top}) under the scoreboard (${r.tl.bottom})`).toBe(true);
});

test('a coach tip steps aside for a conceded goal too, as it does for a scored one', async (t) => {
  const page = await openApp(t, { e2eHook: true, prefs: { ...PREFS, coachSeen: [] } });
  await startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60_000 });
  await page.waitForSelector('.coach-tip.on:not([hidden])', { timeout: 30_000 });
  const home = await page.evaluate(() => (window.__derbyMatch.humans[0] ? 0 : 1));
  await addGoal(page, 1 - home);
  await page.waitForFunction(() => document.getElementById('banner').classList.contains('conceded'));
  const vis = await page.locator('.coach-tip').evaluate((el) => getComputedStyle(el).visibility);
  expect(vis, 'the tip is hidden while the conceded banner is up').toBe('hidden');
});
