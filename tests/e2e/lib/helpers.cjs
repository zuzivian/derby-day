// Shared e2e helpers. ALL selectors live in SEL (and the small helpers below) so that
// when the UI changes there is exactly one place to fix. Prefer data-action / data-screen
// attributes and ids over text and class names.

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SAVE_KEY = 'overlap.save.v1';
const PREFS_KEY = 'overlap.prefs.v1';
const DIST = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.html');
const APP_URL = pathToFileURL(DIST).href;

const SEL = {
  app: '#app',
  tab: '[data-action="nav"][data-screen]',
  tabFor: (screen) => `[data-action="nav"][data-screen="${screen}"]`,
  screen: 'main',
  toast: '.toast',
  modal: '.modal',
  modalClose: '.modal [data-action="close-result"]',
  header: '.topbar',
  // Club screen
  playRanked: '[data-action="play-ranked"]',
  playPractice: '[data-action="play-practice"]',
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

/**
 * Open the app in a fresh context.
 *   colorScheme  'light' | 'dark'
 *   width/height viewport
 *   prefs        object stored under overlap.prefs.v1 (e.g. { halfSeconds: 3 })
 *   mutateSave   (save) => void, applied to the stored save before the real test starts.
 *                Must be self-contained: it is serialised and run in the page.
 */
async function openApp(t, opts = {}) {
  const { colorScheme = 'light', width = 1280, height = 800, prefs, mutateSave } = opts;
  const page = await t.newPage({ colorScheme, viewport: { width, height } });
  await page.goto(APP_URL);
  await page.waitForSelector(SEL.app + ' *');
  await skipOnboarding(page);
  if (prefs || mutateSave) {
    await page.evaluate(
      ([saveKey, prefsKey, prefsObj, fnSrc]) => {
        if (prefsObj) localStorage.setItem(prefsKey, JSON.stringify(prefsObj));
        if (fnSrc) {
          const save = JSON.parse(localStorage.getItem(saveKey));
          new Function('save', fnSrc)(save);
          localStorage.setItem(saveKey, JSON.stringify(save));
        }
      },
      [SAVE_KEY, PREFS_KEY, prefs || null, mutateSave ? `(${mutateSave.toString()})(save)` : null],
    );
    await page.reload();
    await page.waitForSelector(SEL.app + ' *');
    await skipOnboarding(page);
  }
  return page;
}

async function goTab(page, screen) {
  await page.locator(SEL.tabFor(screen)).click();
  await page.waitForSelector(`${SEL.tabFor(screen)}[aria-current]`).catch(() => {});
}

async function tabScreens(page) {
  return page.$$eval(SEL.tab, (els) => [...new Set(els.map((e) => e.getAttribute('data-screen')))]);
}

/** Start a ranked match by clicking the primary button, then wait for the pitch. */
async function startRanked(page) {
  await goTab(page, 'club');
  await page.locator(SEL.playRanked).click();
  await page.waitForSelector(SEL.pitch);
}

const pageWidths = (page) =>
  page.evaluate(() => {
    const de = document.documentElement;
    return { scrollWidth: Math.max(de.scrollWidth, document.body.scrollWidth), innerWidth: window.innerWidth };
  });

module.exports = { APP_URL, SAVE_KEY, PREFS_KEY, SEL, headerElo, skipOnboarding, readSave, openApp, goTab, tabScreens, startRanked, pageWidths };
