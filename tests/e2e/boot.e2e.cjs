// Boot and layout: the app starts cleanly, every tab renders, nothing overflows horizontally.

const { test, expect } = require('./lib/harness.cjs');
const { SEL, openApp, goTab, tabScreens, pageWidths } = require('./lib/helpers.cjs');

test('boots with no page errors and renders the club screen', async (t) => {
  const page = await openApp(t);
  expect(await page.title(), 'title').toMatch(/through ball/i);
  expect((await page.locator(SEL.app).innerText()).length, 'app text length').toBeGreaterThan(50);
  expect(await page.locator(SEL.tab).count(), 'tab count').toBeGreaterThanOrEqual(5);
  await page.waitForTimeout(500); // let any late async errors surface (the runner fails the test on them)
});

for (const width of [1280, 390]) {
  for (const colorScheme of ['light', 'dark']) {
    test(`every tab renders with no horizontal overflow at ${width}px, ${colorScheme}`, async (t) => {
      const page = await openApp(t, { width, height: width === 390 ? 844 : 800, colorScheme });
      const screens = await tabScreens(page);
      expect(screens.length, 'screens').toBeGreaterThanOrEqual(5);
      for (const screen of screens) {
        await goTab(page, screen);
        const text = await page.locator(SEL.screen).first().innerText();
        expect(text.trim().length, `"${screen}" screen text length`).toBeGreaterThan(20);
        const w = await pageWidths(page);
        expect(w.scrollWidth, `"${screen}" scrollWidth (innerWidth ${w.innerWidth})`).toBeLessThanOrEqual(w.innerWidth);
      }
    });
  }
}
