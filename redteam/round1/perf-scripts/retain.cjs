// Play N short matches, return Home, and print the retainer path of each detached match canvas. node retain.cjs <renderer> <n>
const { launch, openPage, metrics, helpers, startRankedClean, pitchBox } = require('./common.cjs');
async function snapshot(c) {
  const chunks = [];
  const onChunk = (p) => chunks.push(p.chunk);
  c.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await c.send('HeapProfiler.enable');
  await c.send('HeapProfiler.collectGarbage');
  await c.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, treatGlobalObjectsAsRoots: true, captureNumericValue: false });
  c.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  return JSON.parse(chunks.join(''));
}
function analyse(snap, wanted, anyDet) {
  const meta = snap.snapshot.meta;
  const NF = meta.node_fields.length, EF = meta.edge_fields.length;
  const nT = meta.node_types[0], eT = meta.edge_types[0];
  const { nodes, edges, strings } = snap;
  const f = (n) => meta.node_fields.indexOf(n), g = (n) => meta.edge_fields.indexOf(n);
  const iType = f('type'), iName = f('name'), iEc = f('edge_count'), iDet = f('detachedness'), iSize = f('self_size');
  const eType = g('type'), eName = g('name_or_index'), eTo = g('to_node');
  const N = nodes.length / NF;
  const first = new Uint32Array(N + 1);
  for (let i = 0, e = 0; i < N; i++) { first[i] = e; e += nodes[i * NF + iEc] * EF; first[i + 1] = e; }
  const name = (i) => strings[nodes[i * NF + iName]];
  const type = (i) => nT[nodes[i * NF + iType]];
  // BFS from the root (node 0), skipping weak edges.
  const par = new Int32Array(N).fill(-1), parEdge = new Int32Array(N).fill(-1);
  par[0] = 0;
  const q = [0];
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    for (let e = first[i]; e < first[i + 1]; e += EF) {
      const t = eT[edges[e + eType]];
      if (t === 'weak' || t === 'shortcut') continue;
      if (process.env.NO_EPHEMERON && (t === 'internal' || t === 'property' || t === 'hidden') && typeof strings[edges[e + eName]] === 'string' && / part of key /.test(strings[edges[e + eName]])) continue;
      const to = edges[e + eTo] / NF;
      if (par[to] !== -1) continue;
      par[to] = i; parEdge[to] = e;
      q.push(to);
    }
  }
  const edgeLabel = (e) => { const t = eT[edges[e + eType]]; const nm = edges[e + eName]; return t === 'element' || t === 'hidden' ? `[${nm}]` : `.${strings[nm]}`; };
  const out = [];
  let counts = {};
  for (let i = 0; i < N; i++) {
    const nm = name(i);
    if (iDet >= 0 && nodes[i * NF + iDet] === 2 && type(i) === 'native') counts[nm.split(' ')[0]] = (counts[nm.split(' ')[0]] || 0) + 1;
    if (!wanted(nm, type(i))) continue;
    if (!anyDet && iDet >= 0 && nodes[i * NF + iDet] !== 2) continue; // detached only
    const path = [];
    let x = i;
    let guard = 0;
    while (x !== 0 && par[x] !== -1 && guard++ < 60) { path.push(`${edgeLabel(parEdge[x])} -> ${type(x)}:${name(x).slice(0, 60)}`); x = par[x]; }
    out.push({ node: `${type(i)}:${nm.slice(0, 80)}`, reachable: par[i] !== -1, path: path.reverse() });
  }
  return { out, detachedNative: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12) };
}
(async () => {
  const [renderer = '3d', n = '2'] = process.argv.slice(2);
  const browser = await launch();
  const { page, cdp } = await openPage(browser, { renderer, prefs: { halfSeconds: 4 } });
  const c = cdp();
  for (let i = 0; i < Number(n); i++) {
    await startRankedClean(page);
    await page.locator('.modal').waitFor({ timeout: 10 * 60 * 1000 });
    await page.locator(helpers.SEL.modalClose).click();
    await page.locator('.modal').waitFor({ state: 'detached' });
    if (process.env.FIX) await page.evaluate(() => { const sp = window.__derby3d.aim && window.__derby3d.aim.markers && window.__derby3d.aim.markers[0]; window.__fixed = !!sp; if (sp) sp.geometry.dispose(); });
    await page.evaluate(() => { delete window.__derby3d; delete window.__derbyMatch; });
  }
  await page.waitForTimeout(500);
  console.log('fixed', await page.evaluate(() => window.__fixed)); console.log('metrics', JSON.stringify(await metrics(c, true)));
  const snap = await snapshot(c);
  const target = process.env.TARGET;
  const r = analyse(snap, target ? (nm, t) => t === 'object' && nm === target : (nm, t) => t === 'native' && /^<canvas/.test(nm), !!target);
  console.log('detached native nodes:', JSON.stringify(r.detachedNative));
  const seen = new Set(); for (const o of r.out) { const key = o.path.slice(0, 6).join('|'); if (seen.has(key) && !/pitch/.test(o.node)) continue; seen.add(key); console.log('\n==', o.node, 'reachable', o.reachable); for (const p of o.path) console.log('   ', p); }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
