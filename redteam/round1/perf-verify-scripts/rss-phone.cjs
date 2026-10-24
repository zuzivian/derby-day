// Process memory (renderer + GPU RSS) and detached canvas backing size after N short matches.
const { chromium } = require('playwright');
const fs = require('node:fs');
const H = require('/tmp/rt/perf-verify/repo/tests/e2e/lib/helpers.cjs');
const renderer = process.argv[2] || '3d';
const N = Number(process.argv[3] || 4);
const query = process.argv[4] || '';
function kids(pid) {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === pid) out.push(Number(d));
    } catch {}
  }
  return out;
}
function tree(pid) { const all = []; const q = [pid]; while (q.length) { const p = q.shift(); all.push(p); q.push(...kids(p)); } return all; }
function rss(pid) { try { const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); return m ? Number(m[1]) / 1024 : 0; } catch { return 0; } }
function cmd(pid) { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return ''; } }
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const bpid = process.pid;
  const t = { newPage: async (o) => { const c = await browser.newContext(process.env.PHONE ? { ...o, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : o); const p = await c.newPage(); await p.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); return p; } };
  const page = await H.openApp(t, { prefs: { halfSeconds: 3 }, renderer, query: query || undefined });
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  async function measure(label) {
    await page.waitForTimeout(1500);
    for (let i = 0; i < 3; i++) await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(500);
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'HTMLCanvasElement.prototype' });
    const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: result.objectId });
    const r = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objectId, returnByValue: true,
      functionDeclaration: 'function(){const d=this.filter(c=>!c.isConnected);return {n:d.length, mb:d.reduce((a,c)=>a+c.width*c.height*4,0)/1e6, big:d.filter(c=>c.width*c.height>500000).map(c=>c.width+"x"+c.height+(c.className?"."+c.className:"")).join(" ")}}' });
    const procs = tree(bpid);
    const rend = procs.filter((p) => /--type=renderer/.test(cmd(p))).reduce((a, p) => a + rss(p), 0);
    const gpu = procs.filter((p) => /--type=gpu-process/.test(cmd(p))).reduce((a, p) => a + rss(p), 0);
    const quality = await page.evaluate(() => localStorage.getItem('derby-quality'));
    console.log(`${label.padEnd(10)} JSheap ${(m.JSHeapUsedSize / 1e6).toFixed(1)} MB | detached canvases ${r.result.value.n}, backing ${r.result.value.mb.toFixed(1)} MB [${r.result.value.big}] | renderer RSS ${rend.toFixed(0)} MB | gpu RSS ${gpu.toFixed(0)} MB`);
  }
  await measure('home-0');
  for (let i = 1; i <= N; i++) {
    await H.goTab(page, H.SEL.homeScreen); await page.locator(H.SEL.playRanked).click(); await page.locator(H.SEL.pitch).waitFor();
    const q = await page.locator('#pitch').getAttribute('data-quality');
    if (i === 1) await page.waitForTimeout(1500), await page.screenshot({ path: '/tmp/rt/perf-verify/out/phone-match1.png' });
    await page.locator(H.SEL.modal).waitFor({ timeout: 300000 });
    await page.locator(H.SEL.modalClose).click();
    await page.locator(H.SEL.modal).waitFor({ state: 'detached' });
    await measure(`home-${i} ${q}`);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
