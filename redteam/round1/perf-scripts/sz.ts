const o = await Bun.build({ entrypoints: ['/tmp/rt/perf/repo/src/client/r3d/renderer3d.ts'], target: 'browser', minify: true, format: 'esm' });
console.log('renderer3d entry (three + r3d)', (await o.outputs[0].text()).length);
const o2 = await Bun.build({ entrypoints: ['/tmp/rt/perf/repo/src/client/main.ts'], target: 'browser', minify: true, format: 'esm' });
console.log('main', (await o2.outputs[0].text()).length);
