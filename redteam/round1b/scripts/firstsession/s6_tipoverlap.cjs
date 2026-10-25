const { launch, ctx, URL, logErrors, shot } = require('./lib.cjs');
(async () => {
  const browser = await launch();
  for (const [w, h, touch] of [[390, 844, true], [360, 740, true], [1280, 800, false]]) {
    const c = await ctx(browser, { width: w, height: h, touch });
    const page = await c.newPage();
    await page.goto(URL);
    await page.locator('#ob-kickoff').click();
    await page.locator('.coach-tip:not([hidden])').waitFor({ timeout: 60000 });
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => {
      const R = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
      const tip = document.querySelector('.coach-tip'), x = document.querySelector('.coach-x');
      const hudBtns = [...document.querySelectorAll('.pitch-wrap button')].filter((b) => !b.closest('.coach-tip') && !b.closest('.touch-pad') && !b.closest('#pause') && b.offsetParent).map((b) => ({ cls: b.className, text: b.innerText.trim().slice(0, 12), aria: b.getAttribute('aria-label'), rect: R(b) }));
      const tr = R(tip);
      const ov = hudBtns.filter((b) => b.rect.l < tr.r && b.rect.r > tr.l && b.rect.t < tr.b && b.rect.b > tr.t);
      const xr = R(x);
      // what a tap 4 px outside the Got it button hits
      const probes = [[xr.l - 4, (xr.t + xr.b) / 2], [(xr.l + xr.r) / 2, xr.b + 4], [(xr.l + xr.r) / 2, xr.t - 4]].map(([px, py]) => { const e = document.elementFromPoint(px, py); return { px, py, hit: e && (e.className || e.id || e.tagName) }; });
      return { tip: tr, gotIt: xr, overlapped: ov, probes };
    });
    console.log(w, h, JSON.stringify(r));
    await shot(page, `tip_overlap_${w}`);
    await c.close();
  }
  await browser.close();
})();
