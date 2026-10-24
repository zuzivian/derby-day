// Allocation sampling + CPU profile of a live match on the unminified build. node prof.cjs <renderer> <tag> [seconds]
const fs = require('fs');
const { launch, openPage, helpers } = require('./common.cjs');
const OUT = '/tmp/rt/perf/out';
(async () => {
  const [renderer = '3d', tag = 'prof', secs = '20'] = process.argv.slice(2);
  const html = fs.readFileSync(`${OUT}/dev/index.html`, 'utf8').split('\n');
  const browser = await launch();
  const { page, cdp } = await openPage(browser, { url: `file://${OUT}/dev/index.html?renderer=${renderer}`, prefs: { halfSeconds: 600 } });
  const c = cdp();
  await helpers.startRanked(page);
  await page.waitForFunction(() => window.__derbyMatch && window.__derbyMatch.phase === 'play', null, { timeout: 60000 });
  const box = await page.locator('#pitch').boundingBox();
  const drive = async (ms) => {
    const end = Date.now() + ms;
    let k = 0;
    while (Date.now() < end) {
      k++;
      const x = box.x + box.width * (0.15 + 0.7 * Math.random());
      const y = box.y + box.height * (0.2 + 0.65 * Math.random());
      await page.mouse.move(x, y, { steps: 3 });
      if (k % 4 === 0) await page.mouse.click(x, y, { delay: 80 });
      await page.waitForTimeout(250);
    }
  };
  await drive(4000);
  await c.send('HeapProfiler.enable');
  await c.send('HeapProfiler.collectGarbage');
  await c.send('Profiler.enable');
  await c.send('Profiler.setSamplingInterval', { interval: 200 });
  const frames0 = await page.evaluate(() => { window.__perf.on = true; return 0; });
  await c.send('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await c.send('Profiler.start');
  await drive(Number(secs) * 1000);
  const { profile: cpu } = await c.send('Profiler.stop');
  const { profile: heap } = await c.send('HeapProfiler.stopSampling');
  const nFrames = await page.evaluate(() => { window.__perf.on = false; return window.__perf.cb.length; });
  // Heap: self size by function+line.
  const agg = new Map();
  const walk = (n, stack) => {
    const f = n.callFrame;
    const key = `${f.functionName || '(anon)'} L${f.lineNumber + 1}`;
    if (n.selfSize) {
      const e = agg.get(key) || { bytes: 0, src: (html[f.lineNumber] || '').trim().slice(0, 140), parent: stack };
      e.bytes += n.selfSize;
      agg.set(key, e);
    }
    for (const ch of n.children || []) walk(ch, `${f.functionName || '(anon)'}`);
  };
  walk(heap.head, '');
  const total = [...agg.values()].reduce((a, b) => a + b.bytes, 0);
  const top = [...agg.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 45).map(([k, v]) => ({ site: k, KB: +(v.bytes / 1024).toFixed(1), perFrameB: Math.round(v.bytes / nFrames), parent: v.parent, src: v.src }));
  // CPU: self time by function.
  const byId = new Map(cpu.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dts = cpu.timeDeltas;
  cpu.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    const key = `${f.functionName || '(anon)'} L${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (dts[i] || 0));
  });
  const totalCpu = [...self.values()].reduce((a, b) => a + b, 0);
  // Long busy stretches (no '(idle)'/'(program)' samples), and what ran in them.
  const parent = new Map();
  for (const n of cpu.nodes) for (const ch of n.children || []) parent.set(ch, n.id);
  const stackOf = (id) => { const out = []; let x = id; while (x !== undefined) { const n = byId.get(x); const f = n.callFrame; if (f.functionName && f.functionName !== '(root)') out.push(`${f.functionName}:${f.lineNumber + 1}`); x = parent.get(x); } return out; };
  const segs = [];
  let cur = null;
  cpu.samples.forEach((id, i) => {
    const n = byId.get(id);
    const nm = n.callFrame.functionName;
    const idle = nm === '(idle)' || nm === '(program)';
    const dt = dts[i] || 0;
    if (!idle) { if (!cur) cur = { us: 0, ids: [] }; cur.us += dt; cur.ids.push([id, dt]); }
    else if (cur) { segs.push(cur); cur = null; }
  });
  if (cur) segs.push(cur);
  const long = segs.filter((g) => g.us > Number(process.env.LONG_MS || 30) * 1000).sort((a, b) => b.us - a.us).slice(0, 8).map((g) => {
    const incl = new Map();
    for (const [id, dt] of g.ids) for (const fr of new Set(stackOf(id))) incl.set(fr, (incl.get(fr) || 0) + dt);
    return { ms: +(g.us / 1000).toFixed(1), top: [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`) };
  });
  const cpuTop = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => ({ fn: k, ms: +(v / 1000).toFixed(1), pct: +((100 * v) / totalCpu).toFixed(1), src: (html[Number(k.split(' L')[1]) - 1] || '').trim().slice(0, 100) }));
  const res = { tag, renderer, secs, nFrames, allocTotalMB: +(total / 1048576).toFixed(2), allocPerFrameKB: +(total / nFrames / 1024).toFixed(1), top, cpuTotalMs: +(totalCpu / 1000).toFixed(0), cpuTop, long };
  fs.writeFileSync(`${OUT}/${tag}.json`, JSON.stringify(res, null, 1));
  console.log(JSON.stringify({ nFrames, allocTotalMB: res.allocTotalMB, allocPerFrameKB: res.allocPerFrameKB }));
  for (const t of top.slice(0, 30)) console.log(`${t.KB.toString().padStart(8)} KB ${String(t.perFrameB).padStart(6)} B/f  ${t.site}  <- ${t.parent} | ${t.src}`);
  console.log('--- cpu self');
  for (const t of cpuTop.slice(0, 30)) console.log(`${t.ms.toString().padStart(8)} ms ${t.pct}%  ${t.fn} | ${t.src}`);
  console.log('--- long busy stretches');
  for (const l of long) console.log(l.ms, 'ms :', l.top.join(' | '));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
