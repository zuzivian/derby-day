// Shared e2e helpers. ALL selectors live in SEL (and the small helpers below) so that
// when the UI changes there is exactly one place to fix. Prefer data-action / data-screen
// attributes and ids over text and class names.

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SAVE_KEY = 'derbyday.save.v1';
const PREFS_KEY = 'derbyday.prefs.v1';
const DIST = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.html');
// E2E_RENDERER=2d or 3d pins the match renderer (default: whatever the browser supports).
const APP_URL = pathToFileURL(DIST).href + (process.env.E2E_RENDERER ? `?renderer=${process.env.E2E_RENDERER}` : '');

const SEL = {
  app: '#app',
  tab: '[data-action="nav"][data-screen]',
  tabFor: (screen) => `[data-action="nav"][data-screen="${screen}"]`,
  screen: 'main',
  toast: '.toast',
  modal: '.modal',
  modalClose: '.modal [data-action="close-result"]',
  header: '.topbar',
  // Club level (src/client/levels.ts)
  levelBadge: '[data-action="level-open"]',
  xpText: '#xp-text',
  xpBar: '.topbar [role="progressbar"]',
  levelPanel: '.level-panel',
  nextUnlock: '#next-unlock',
  levelUp: '[aria-labelledby="levelup-title"]',
  levelUpTitle: '#levelup-title',
  levelUpGo: '[data-action="levelup-go"]',
  levelUpClose: '[data-action="levelup-close"]',
  xpGain: '.modal .xp-gain',
  // Home screen (src/client/home.ts): the hero Kick off and the play-mode cards.
  // Screen ids: 'home' is the first view, 'club' the secondary Club tab (news, replays, club level).
  homeScreen: 'home',
  clubScreen: 'club',
  kickOff: '#kick-off',
  playRanked: '[data-action="play-ranked"]',
  playPractice: '[data-action="play-practice"]',
  hero: '.hero[data-mode="cpu"]',
  modeCard: '.mode-grid [data-mode]',
  modeCardFor: (mode) => `.mode-grid [data-mode="${mode}"]`,
  lockedCard: '.mode-card.locked',
  statusStrip: '.topbar .status-strip',
  // Club tab
  newsTitle: '#news-title',
  // Training
  train: '[data-action="train"]',
  // Transfers
  buy: '[data-action="buy"]',
  sell: (id) => `[data-action="sell"][data-id="${id}"]`,
  sellConfirm: (id) => `[data-action="sell-confirm"][data-id="${id}"]`,
  sellAny: '[data-action="sell"]',
  sellConfirmAny: '[data-action="sell-confirm"]',
  // Squad
  slot: (n) => `[data-change="slot"][data-slot="${n}"]`,
  // Two humans (versus.ts)
  playLocal2p: '[data-action="play-local2p"]',
  playLink: '[data-action="play-link"]',
  l2pOpp: '#l2p-opp',
  l2pStart: '#l2p-start',
  linkHost: '#link-host',
  linkCode: '#link-code',
  linkCodeInput: '#link-code-input',
  linkJoin: '#link-join',
  linkStatus: '#link-status',
  linkUnsupported: '#link-unsupported',
  netMatch: '#net-match',
  netWait: '#net-wait',
  netStop: '#net-stop',
  // Online (versus.ts, mountOnline)
  playOnline: '[data-action="play-online"]',
  onlineLobby: '#online-lobby',
  onlineHost: '#online-host',
  onlineCode: '#online-code',
  onlineLink: '#online-link',
  onlineCodeInput: '#online-code-input',
  onlineJoin: '#online-join',
  onlineStatus: '#online-status',
  resultNote: '.modal .result-note',
  // Match
  pitch: '#pitch',
  pause: '#pause',
  resume: '#resume',
  forfeit: '#forfeit',
  // Onboarding (best effort; another change owns this flow). Any match is clicked.
  onboardingSkip: [
    '[data-action="skip-onboarding"]',
    '[data-action="onboarding-skip"]',
    '[data-action="skip-tour"]',
    '[data-action="skip-intro"]',
    '[data-action="dismiss-onboarding"]',
    '[data-action="finish-onboarding"]',
    '[data-screen="onboarding"] [data-action="skip"]',
    '[data-onboarding] [data-action="skip"]',
    '.onboarding [data-action="skip"]',
  ].join(', '),
};

/** Elo as shown in the header ("Elo 1000"). Reads text so markup changes do not matter. */
async function headerElo(page) {
  const text = await page.locator(SEL.header).first().innerText();
  const m = /Elo\s*(\d+)/i.exec(text);
  if (!m) throw new Error(`No Elo in header text: ${JSON.stringify(text)}`);
  return Number(m[1]);
}

/** Dismiss the first-run onboarding if the build has one. Never throws, never waits long. */
async function skipOnboarding(page) {
  for (let i = 0; i < 6; i++) {
    const el = page.locator(SEL.onboardingSkip).first();
    let visible = false;
    try {
      visible = await el.isVisible();
    } catch {
      /* page navigating */
    }
    if (!visible) return;
    try {
      await el.click({ timeout: 2000 });
    } catch {
      return;
    }
    await page.waitForTimeout(120);
  }
}

const readSave = (page) =>
  page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, SAVE_KEY);

/** Total XP to reach `level` (the curve in src/meta/levels.ts: 100 * L to clear level L). */
const totalXpForLevel = (level) => 50 * level * (level - 1);

/**
 * Open the app in a fresh context.
 *   colorScheme  'light' | 'dark'
 *   width/height viewport
 *   prefs        object stored under derbyday.prefs.v1 (e.g. { halfSeconds: 3 })
 *   mutateSave   (save) => void, applied to the stored save before the real test starts.
 *                Must be self-contained: it is serialised and run in the page.
 *   level        club level to start at (default 99, so every tab and button is unlocked).
 *                null leaves the fresh level-1 save alone. Everything up to the level counts
 *                as already seen, so no level-up dialog is waiting.
 *   xp           exact total XP instead of `level` (e.g. just short of a level boundary).
 *   renderer     '2d' or '3d': pin the match renderer (?renderer=). Tests that map world metres to
 *                pixels with the fixed top-down 2D projection use '2d'; the 3D camera moves.
 */
async function openApp(t, opts = {}) {
  const { colorScheme = 'light', width = 1280, height = 800, prefs, mutateSave: userMutate, level = 99, xp, e2eHook = false, renderer, query } = opts;
  const setXp = xp !== undefined ? xp : level === null ? null : totalXpForLevel(level);
  // Runs in the page, so it can only use its arguments.
  const levelMutate = setXp === null ? null : `save.xp = ${Number(setXp)}; delete save.unlocksSeen;`;
  const userSrc = userMutate ? `(${userMutate.toString()})(save);` : '';
  const mutateSrc = levelMutate || userSrc ? `${levelMutate || ''}${userSrc}` : null;
  const mutateSave = mutateSrc ? true : null;
  // query: extra page parameters, e.g. 'relay=ws://127.0.0.1:8787/ws' for online tests. Both pages of a seeded start get it.
  const base = renderer ? `${APP_URL.split('?')[0]}?renderer=${renderer}` : APP_URL;
  const url = query ? `${base}${base.includes('?') ? '&' : '?'}${query}` : base;
  const first = await t.newPage({ colorScheme, viewport: { width, height } });
  // e2eHook: expose the live match as window.__derbyMatch (see matchView.ts) so a test can set a scene up.
  if (e2eHook) await first.addInitScript(() => { window.__e2e = true; });
  await first.goto(url);
  await first.waitForSelector(SEL.app + ' *');
  await skipOnboarding(first);
  if (!(prefs || mutateSave)) return first;
  // The app made its first save and prefs; rewrite them with what the test asked for.
  await first.evaluate(
    ([saveKey, prefsKey, prefsObj, fnSrc]) => {
      if (prefsObj) localStorage.setItem(prefsKey, JSON.stringify(prefsObj));
      if (fnSrc) {
        const save = JSON.parse(localStorage.getItem(saveKey));
        new Function('save', fnSrc)(save);
        localStorage.setItem(saveKey, JSON.stringify(save));
      }
    },
    [SAVE_KEY, PREFS_KEY, prefs || null, mutateSrc],
  );
  // The test's page is a second page that boots on the seeded storage. Not page.reload() on the page that wrote it: see
  // openSecondPage. The first page stays open (idle, on Home) for the rest of the test, until its context closes.
  const page = await openSecondPage(first, { url, e2e: e2eHook });
  await skipOnboarding(page);
  return page;
}

/**
 * A second page in the same browser context, at the app's URL, ready for use; the first page stays open on purpose. It is how
 * a test checks what survived a visit (nextVisit) and how openApp starts on seeded storage. Use it instead of page.reload(): Chromium drops
 * localStorage when the page that wrote it unloads, now and then, even for a static page that only writes a key.
 * Measured on such a page, 40 runs each: a second page with the old one left open lost 0 (at 6 s and at 15 s);
 * page.reload() 3 (at 15 s); close then reopen 13 and 8; a real on-disk profile closed and relaunched 1.
 * The new page sets window.__e2eSkipTabGuard, because the first page stays open and owns the club and a one-club-per-browser
 * guard would otherwise park the returned page; it is a different flag from __e2e, so tests of that guard (which set __e2e) still
 * meet it. It also sets window.__e2e (the live-match hooks) when `e2e` is true, the default (nextVisit); openApp passes its own
 * e2eHook option so a test sees what it asked for.
 * The first page stays inert after seeding: it sits on Home, and nothing on Home runs a timer or writes the save (timers and
 * unload handlers exist only in a match, the tutorial and the two-player lobbies), so it cannot overwrite the second page's saves.
 */
async function openSecondPage(page, { url = APP_URL, e2e = true } = {}) {
  // What the first page holds, to put in front of the new page's own boot. A page opened in the same context is meant to
  // see it already, but under CPU contention one in ten or so starts with *empty* storage (a browser-side gap, seen with an
  // on-disk profile too), boots a brand-new club and writes it. Restoring first makes this what the player's browser would
  // hold: a no-op when the browser delivered it, and only once per page so later changes are never undone.
  const held = await page.evaluate(() => Object.entries(localStorage)).catch(() => []);
  const next = await page.context().newPage(); // fonts are blocked and errors watched for the whole context (run.cjs)
  await next.addInitScript(
    ([withHook, entries]) => {
      if (withHook) window.__e2e = true;
      window.__e2eSkipTabGuard = true;
      try {
        if (sessionStorage.getItem('__restored')) return;
        sessionStorage.setItem('__restored', '1');
        for (const [k, v] of entries) if (localStorage.getItem(k) !== v) localStorage.setItem(k, v);
      } catch {
        /* storage unavailable: nothing to restore */
      }
    },
    [e2e, held],
  );
  await next.goto(url);
  await next.waitForSelector(SEL.app + ' *');
  return next;
}

/** The player's next visit, with the live-match hook (window.__e2e) on. */
const nextVisit = (page) => openSecondPage(page);

async function goTab(page, screen) {
  await page.locator(SEL.tabFor(screen)).click();
  await page.waitForSelector(`${SEL.tabFor(screen)}[aria-current]`).catch(() => {});
}

async function tabScreens(page) {
  return page.$$eval(SEL.tab, (els) => [...new Set(els.map((e) => e.getAttribute('data-screen')))]);
}

/** Start a ranked match with the home screen's Kick off, then wait for the pitch. */
async function startRanked(page) {
  await goTab(page, SEL.homeScreen);
  await page.locator(SEL.playRanked).click();
  await page.waitForSelector(SEL.pitch);
}

const pageWidths = (page) =>
  page.evaluate(() => {
    const de = document.documentElement;
    return { scrollWidth: Math.max(de.scrollWidth, document.body.scrollWidth), innerWidth: window.innerWidth };
  });

module.exports = { nextVisit, openSecondPage, APP_URL, SAVE_KEY, PREFS_KEY, SEL, headerElo, skipOnboarding, readSave, openApp, goTab, tabScreens, startRanked, pageWidths, totalXpForLevel };
