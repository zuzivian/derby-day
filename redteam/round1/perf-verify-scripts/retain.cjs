// Heap snapshot after N matches; shortest strong retainer path from GC roots to a detached canvas#pitch-like node.
const { chromium } = require('playwright');
const H = require('/tmp/rt/perf-verify/repo/tests/e2e/lib/helpers.cjs');
const renderer = process.argv[2] || '2d';
const N = Number(process.argv[3] || 2);
const TARGET = process.env.TARGET || 'HTMLCanvasElement';
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const t = { newPage: async (o) => { const c = await browser.newContext(o); const p = await c.newPage(); await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); return p; } };
  const page = await H.openApp(t, { prefs: { halfSeconds: 3 }, renderer });
  const cdp = await page.context().newCDPSession(page);
  for (let i = 1; i <= N; i++) {
    await H.goTab(page, H.SEL.homeScreen); await page.locator(H.SEL.playRanked).click(); await page.locator(H.SEL.pitch).waitFor();
    await page.locator(H.SEL.modal).waitFor({ timeout: 120000 });
    await page.locator(H.SEL.modalClose).click();
    await page.locator(H.SEL.modal).waitFor({ state: 'detached' });
  }
  await page.waitForTimeout(800);
  for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
  let chunks = [];
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => chunks.push(e.chunk));
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  const snap = JSON.parse(chunks.join(''));
  await browser.close();
  const meta = snap.snapshot.meta;
  const nf = meta.node_fields, ef = meta.edge_fields;
  const NFL = nf.length, EFL = ef.length;
  const nTypes = meta.node_types[0], eTypes = meta.edge_types[0];
  const nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
  const iType = nf.indexOf('type'), iName = nf.indexOf('name'), iEC = nf.indexOf('edge_count'), iId = nf.indexOf('id'), iSize = nf.indexOf('self_size');
  const eiType = ef.indexOf('type'), eiName = ef.indexOf('name_or_index'), eiTo = ef.indexOf('to_node');
  const count = nodes.length / NFL;
  const firstEdge = new Uint32Array(count + 1);
  for (let i = 0, e = 0; i < count; i++) { firstEdge[i] = e; e += nodes[i * NFL + iEC] * EFL; }
  firstEdge[count] = edges.length;
  const name = (i) => strings[nodes[i * NFL + iName]];
  const type = (i) => nTypes[nodes[i * NFL + iType]];
  // BFS from root (node 0), skipping weak edges and ephemeron-ish internal edges
  const prev = new Int32Array(count).fill(-1), prevEdge = new Int32Array(count).fill(-1);
  const seen = new Uint8Array(count); seen[0] = 1;
  const q = [0];
  for (let h = 0; h < q.length; h++) {
    const n = q[h];
    for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EFL) {
      const et = eTypes[edges[e + eiType]];
      if (et === 'weak' || et === 'shortcut') continue;
      const en = et === 'element' || et === 'hidden' ? String(edges[e + eiName]) : strings[edges[e + eiName]];
      if (process.env.NO_EPHEMERON === '1' && /part of key|-> \(|WeakMap|ephemeron/i.test(en)) continue;
      const to = edges[e + eiTo] / NFL;
      if (seen[to]) continue;
      seen[to] = 1; prev[to] = n; prevEdge[to] = e; q.push(to);
    }
  }
  const targets = [];
  const iDet = nf.indexOf('detachedness');
  for (let i = 0; i < count; i++) if (type(i) === 'native' && name(i).startsWith(TARGET) && seen[i] && (iDet < 0 || process.env.ANY === '1' || nodes[i * NFL + iDet] === 2)) targets.push(i);
  console.log('node fields', nf.join(','));{const names=new Map();for(let i=0;i<count;i++){if(type(i)==='native'&&/anvas/.test(name(i))){const k=name(i).slice(0,80)+' det='+nodes[i*NFL+iDet];names.set(k,(names.get(k)||0)+1)}}console.log([...names].slice(0,30))}
  console.log(`targets matching ${TARGET}: ${targets.length}`);
  const show = (t) => {
    const path = [];
    for (let n = t; n > 0; n = prev[n]) {
      const e = prevEdge[n];
      const et = eTypes[edges[e + eiType]];
      const en = et === 'element' || et === 'hidden' ? String(edges[e + eiName]) : strings[edges[e + eiName]];
      path.push(`  --[${et}:${en}]--> (${type(n)}) ${name(n).slice(0, 110)}`);
    }
    return path.reverse().join('\n');
  };
  for (const t of targets.slice(0, Number(process.env.SHOW || 3))) console.log(`\nPATH to ${name(t).slice(0,120)} @${nodes[t * NFL + iId]}:\n${show(t)}`);
})().catch((e) => { console.error(e); process.exit(1); });
