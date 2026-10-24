// Per-frame DOM churn during a live match: MutationObserver counts on the match root, and a 3 s
// devtools trace for Layout / UpdateLayoutTree / forced layouts. node dom.cjs <renderer>
const fs = require('fs');
const { launch, openPage, helpers } = require('./common.cjs');
(async () => {
  const [renderer = '3d'] = process.argv.slice(2);
  const browser = await launch();
  const { page, cdp } = await openPage(browser, { renderer, prefs: { halfSeconds: 600 } });
  const c = cdp();
  await helpers.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
  await page.waitForTimeout(2000);
  const mo = await page.evaluate(() => new Promise((res) => {
    const root = document.querySelector('.match');
    const counts = { childList: 0, characterData: 0, attributes: 0, addedNodes: 0, byTarget: {} };
    const ob = new MutationObserver((list) => {
      for (const m of list) {
        counts[m.type]++;
        counts.addedNodes += m.addedNodes.length;
        const t = m.target.nodeType === 1 ? (m.target.id || m.target.className || m.target.tagName) : (m.target.parentNode && (m.target.parentNode.id || m.target.parentNode.className));
        const k = `${m.type}:${t}${m.attributeName ? '[' + m.attributeName + ']' : ''}`;
        counts.byTarget[k] = (counts.byTarget[k] || 0) + 1;
      }
    });
    ob.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    let frames = 0;
    const f = () => { frames++; if (frames < 120) requestAnimationFrame(f); else { ob.disconnect(); setTimeout(() => res({ frames, ...counts }), 0); } };
    requestAnimationFrame(f);
  }));
  console.log('mutations over', mo.frames, 'frames:', JSON.stringify(mo));
  // Trace.
  const events = [];
  c.on('Tracing.dataCollected', (d) => events.push(...d.value));
  const done = new Promise((r) => c.once('Tracing.tracingComplete', r));
  await c.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
  await page.waitForTimeout(3000);
  await c.send('Tracing.end');
  await done;
  const main = events.filter((e) => e.name === 'Layout' || e.name === 'UpdateLayoutTree' || e.name === 'Paint' || e.name === 'FireAnimationFrame' || e.name === 'RecalculateStyles');
  const by = {};
  let forced = 0;
  const forcedStacks = {};
  for (const e of main) {
    by[e.name] = by[e.name] || { n: 0, ms: 0 };
    by[e.name].n++;
    by[e.name].ms += (e.dur || 0) / 1000;
    const st = e.args?.beginData?.stackTrace || e.args?.data?.stackTrace;
    if ((e.name === 'Layout' || e.name === 'UpdateLayoutTree') && st && st.length) {
      forced++;
      const k = st.slice(0, 2).map((f) => `${f.functionName}@${f.lineNumber}`).join(' < ');
      forcedStacks[k] = (forcedStacks[k] || 0) + 1;
    }
  }
  const frames = by.FireAnimationFrame ? by.FireAnimationFrame.n : 0;
  console.log('trace 3s:', JSON.stringify(by), 'forced:', forced, JSON.stringify(forcedStacks));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
