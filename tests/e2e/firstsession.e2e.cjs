// The first session, end to end at a desktop (1280x800) and a phone (390x844): a welcome whose club names can be read, a typed
// name that is kept, a coach tip that stays off the controls, a shoot tip that waits for the goal, Back that asks before it
// leaves, a celebration with a level-up moment, and a Home that grows a card at a time.
// Screenshots go to $E2E_SHOTS when it is set (they are for a person to look at, not asserted on).

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('./lib/harness.cjs');
const { APP_URL, SEL, PREFS_KEY, openApp, readSave, totalXpForLevel } = require('./lib/helpers.cjs');

const KICK = '#ob-kickoff';
const TIP = '.coach-tip:not([hidden])';
const VIEWS = [
  { name: 'desktop', width: 1280, height: 800, touch: false },
  { name: 'phone', width: 390, height: 844, touch: true },
];

const shot = async (page, name, settle = 600) => {
  const dir = process.env.E2E_SHOTS;
  if (!dir) return;
  await page.waitForTimeout(settle); // let fades and the XP animation finish
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
};

async function fresh(t, { width, height, touch, colorScheme = 'light', halfSeconds = null }) {
  const page = await t.newPage({ colorScheme, viewport: { width, height }, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
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

/** WCAG contrast ratio of an element's text against the first opaque background behind it. */
const contrastOf = (page, selector) =>
  page.evaluate((sel) => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const el = document.querySelector(sel);
    const fg = parse(getComputedStyle(el).color);
    let bg = null;
    for (let n = el; n && !bg; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.95) bg = c; }
    bg = bg || { r: 255, g: 255, b: 255 };
    const [a, b] = [lum(fg), lum(bg)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, selector);

for (const v of VIEWS) {
  for (const colorScheme of ['light', 'dark']) {
    test(`first session: the welcome's club names can be read (${v.name}, ${colorScheme})`, async (t) => {
      const page = await fresh(t, { ...v, colorScheme });
      const names = page.locator('.ob-welcome .side-name');
      expect(await names.count(), 'two club names').toBe(2);
      for (let i = 0; i < 2; i++) {
        const ratio = await page.evaluate((i) => {
          const el = document.querySelectorAll('.ob-welcome .side-name')[i];
          el.dataset.probe = String(i);
          return i;
        }, i).then(() => contrastOf(page, `.ob-welcome .side-name[data-probe="${i}"]`));
        expect(ratio, `club name ${i + 1} contrast ${ratio.toFixed(2)}:1 is at least 4.5:1`).toBeGreaterThanOrEqual(4.5);
      }
      await shot(page, `welcome-${v.name}-${colorScheme}`);
    });
  }

  test(`first session: "Go to the club" keeps a typed name, and a bad one keeps the step open (${v.name})`, async (t) => {
    const page = await fresh(t, { ...v, halfSeconds: 3 });
    await page.locator(KICK).click();
    await page.waitForSelector('.ob-celebrate', { timeout: 90_000 });
    await page.locator('[data-ob="next"]').click();
    // Typed, never submitted with "Use this name": the big button must still take it.
    await page.locator('#ob-name').fill('x');
    await page.locator('[data-ob="done"]').click();
    await page.locator('#ob-name-error').waitFor();
    expect(await page.locator('[data-ob="done"]').count(), 'still on the naming step').toBe(1);
    expect(await page.evaluate(() => document.activeElement.id), 'focus goes back to the field').toBe('ob-name');
    await shot(page, `name-error-${v.name}`);
    await page.locator('#ob-name').fill('Harbour Lights');
    await page.locator('[data-ob="done"]').click();
    await page.waitForSelector(SEL.kickOff);
    expect((await readSave(page)).club.name, 'the typed name is the club name').toBe('Harbour Lights');
    // Skip still means "keep what I was given".
  });

  test(`first session: the first match says who you are and which way you attack, and the tip stays off the controls (${v.name})`, async (t) => {
    const page = await fresh(t, v);
    await page.locator(KICK).click();
    await page.waitForSelector(TIP, { timeout: 40_000 });
    const text = await page.locator(TIP).innerText();
    expect(text, 'which player is you and which way you attack').toMatch(/yellow ring.*goal on the right/i);
    const r = await page.evaluate(() => {
      const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, name: el.getAttribute('aria-label') || el.id || el.className || el.tagName }; };
      const tip = document.querySelector('.coach-tip');
      const tb = box(tip);
      const hits = [];
      let rightColumn = Infinity;
      for (const b of document.querySelectorAll('.pitch-wrap button')) {
        if (tip.contains(b)) continue;
        const st = getComputedStyle(b);
        const bb = box(b);
        if (st.visibility === 'hidden' || st.display === 'none' || bb.w === 0) continue;
        if (bb.x < tb.x + tb.w && bb.x + bb.w > tb.x && bb.y < tb.y + tb.h && bb.y + bb.h > tb.y) hits.push(bb.name);
        if (bb.y < tb.y + tb.h + 200) rightColumn = Math.min(rightColumn, bb.x);
      }
      return { tip: tb, hits, x: box(document.querySelector('.coach-x')), rightColumn, vw: window.innerWidth };
    });
    expect(r.hits, 'the tip covers no pitch button').toEqual([]);
    expect(r.tip.x + r.tip.w, 'inside the screen').toBeLessThanOrEqual(r.vw);
    if (v.touch) {
      expect(r.x.w, '"Got it" is at least 44 px wide').toBeGreaterThanOrEqual(44);
      expect(r.x.h, '"Got it" is at least 44 px tall').toBeGreaterThanOrEqual(44);
      expect(r.tip.x + r.tip.w, 'clear of the HUD column on the right').toBeLessThanOrEqual(r.rightColumn);
    }
    await shot(page, `first-tip-${v.name}`);
  });

  test(`first session: Back during the first match opens the pause menu instead of leaving (${v.name})`, async (t) => {
    const page = await fresh(t, v);
    await page.locator(KICK).click();
    await page.waitForSelector(SEL.pitch);
    await page.evaluate(() => history.back());
    await page.locator(SEL.pause).waitFor({ state: 'visible', timeout: 5000 });
    expect(await page.locator(SEL.pitch).count(), 'still in the match').toBe(1);
    await shot(page, `back-pause-${v.name}`);
    await page.locator(SEL.resume).click();
    await page.evaluate(() => history.back());
    await page.locator(SEL.pause).waitFor({ state: 'visible', timeout: 5000 });
    expect(await page.locator(SEL.pitch).count(), 'a second Back still asks').toBe(1);
  });

  test(`first session: the shoot tip waits until the player is in range (${v.name})`, async (t) => {
    const page = await fresh(t, v);
    await page.locator(KICK).click();
    await page.waitForSelector(TIP, { timeout: 40_000 });
    const put = (x) => page.evaluate((x) => {
      const s = window.__derbyMatch;
      const me = s.controlled[0];
      s.players[me].pos = { x, y: 34 };
      s.ball.pos = { x, y: 34 };
      s.ball.owner = me;
      window.__derbyCoach.advance(0);
      return window.__derbyCoach.state();
    }, x);
    await page.waitForFunction(() => window.__derbyMatch.phase === 'play', null, { timeout: 60_000 });
    for (const x of [53, 60]) {
      const st = await put(x);
      expect([st.shown, ...st.queue], `${105 - x} m out: no shoot tip`).notToContain('shoot');
    }
    const st = await put(85);
    expect([st.shown, ...st.queue], '20 m out: the shoot tip is offered').toContain('shoot');
  });

  test(`first session: the first match's celebration has a level-up moment and the Home that follows grows a card at a time (${v.name})`, async (t) => {
    const page = await fresh(t, { ...v, halfSeconds: 3 });
    await page.locator(KICK).click();
    await page.waitForSelector('.ob-celebrate', { timeout: 90_000 });
    expect(await page.locator('.ob-celebrate .xp-card.is-levelup').count(), 'the XP card shows the level-up').toBe(1);
    expect(await page.locator('.ob-celebrate .xp-level-tag').innerText(), 'tagged Level up').toMatch(/level up/i);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.ob-celebrate .xp-level')).opacity === '1' && getComputedStyle(document.querySelector('.ob-celebrate .xp-lv-new')).opacity === '1', null, { timeout: 8000 });
    await shot(page, `celebration-${v.name}`, 3000);
    await page.locator('[data-ob="skip"]').first().click().catch(() => {});
  });

  test(`first session: level 2 Home is two cards with no padlocks (${v.name})`, async (t) => {
    const page = await openApp(t, { level: 2, width: v.width, height: v.height, ...(v.touch ? { hasTouch: true } : {}) });
    expect(await page.$$eval(SEL.modeCard, (els) => els.map((e) => e.getAttribute('data-mode'))), 'vs Player and Practice only').toEqual(['player', 'practice']);
    expect(await page.locator(SEL.lockedCard).count(), 'no padlocked cards').toBe(0);
    expect(await page.locator('.diff-btn.is-locked').count(), 'no padlocked practice buttons').toBe(0);
    await shot(page, `home-level2-${v.name}`);
  });
}

test('first session: reaching level 3 offers "Play ranked", which lands on Kick off', async (t) => {
  const prefs = { halfSeconds: 3, controls: 'mouse', onboarded: true, coachSeen: [], marks: ['home', 'squad'] };
  const page = await openApp(t, { xp: totalXpForLevel(3) - 10, prefs, mutateSave: (save) => { save.unlocksSeen = ['home', 'squad', 'local2p', 'link', 'practice']; } });
  await page.locator(SEL.kickOff).click();
  await page.locator(SEL.modalClose).waitFor({ timeout: 80_000 });
  await page.locator(SEL.modalClose).click();
  await page.locator(SEL.levelUp).waitFor();
  expect((await page.locator(SEL.levelUpGo).innerText()).trim(), 'the headline unlock is the button').toMatch(/^play ranked$/i);
  await shot(page, 'levelup-ranked');
  await page.locator(SEL.levelUpGo).click();
  await page.locator(SEL.levelUp).waitFor({ state: 'detached' });
  expect(await page.evaluate(() => document.activeElement.id), 'Kick off is focused').toBe('kick-off');
});
