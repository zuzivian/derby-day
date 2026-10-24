// Take a heap snapshot through CDP and count Replay-shaped objects (own props seed+runs+fp) and their size.
async function replaySnapshot(c) {
  const chunks = [];
  const onChunk = (p) => chunks.push(p.chunk);
  c.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await c.send('HeapProfiler.enable');
  await c.send('HeapProfiler.collectGarbage');
  await c.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  c.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  const snap = JSON.parse(chunks.join(''));
  const meta = snap.snapshot.meta;
  const NF = meta.node_fields.length, EF = meta.edge_fields.length;
  const nTypes = meta.node_types[0], eTypes = meta.edge_types[0];
  const nodes = snap.nodes, edges = snap.edges, strings = snap.strings;
  const iType = meta.node_fields.indexOf('type'), iName = meta.node_fields.indexOf('name'), iSize = meta.node_fields.indexOf('self_size'), iEc = meta.node_fields.indexOf('edge_count');
  const eType = meta.edge_fields.indexOf('type'), eName = meta.edge_fields.indexOf('name_or_index'), eTo = meta.edge_fields.indexOf('to_node');
  const N = nodes.length / NF;
  const firstEdge = new Uint32Array(N + 1);
  for (let i = 0, e = 0; i < N; i++) { firstEdge[i] = e; e += nodes[i * NF + iEc] * EF; firstEdge[i + 1] = e; }
  const propsOf = (i) => {
    const out = {};
    for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += EF) {
      const t = eTypes[edges[e + eType]];
      if (t === 'property') out[strings[edges[e + eName]]] = edges[e + eTo] / NF;
    }
    return out;
  };
  // Total size reachable from a node (not dominator-retained, but within replay-owned structure: stop at shared TeamSetup by not following 'home'/'away').
  const sizeFrom = (root, skip) => {
    const seen = new Set([root]);
    const stack = [root];
    let sum = 0;
    while (stack.length) {
      const i = stack.pop();
      sum += nodes[i * NF + iSize];
      for (let e = firstEdge[i]; e < firstEdge[i + 1]; e += EF) {
        const t = eTypes[edges[e + eType]];
        if (t === 'weak' || t === 'shortcut') continue;
        const nm = t === 'property' ? strings[edges[e + eName]] : '';
        if (i === root && skip.includes(nm)) continue;
        const to = edges[e + eTo] / NF;
        const tt = nTypes[nodes[to * NF + iType]];
        if (tt === 'hidden' && to !== i) { /* follow arrays' backing stores */ }
        if (tt === 'code' || tt === 'synthetic' || tt === 'closure' || tt === 'native') continue;
        if (!seen.has(to)) { seen.add(to); stack.push(to); }
      }
    }
    return sum;
  };
  let count = 0, bytes = 0, runs = 0;
  for (let i = 0; i < N; i++) {
    if (nTypes[nodes[i * NF + iType]] !== 'object') continue;
    const p = propsOf(i);
    if (p.runs !== undefined && p.seed !== undefined && p.fp !== undefined && p.ticks !== undefined) {
      count++;
      bytes += sizeFrom(i, ['home', 'away']);
      // number of runs elements
      const r = p.runs;
      runs += nodes[r * NF + iEc];
    }
  }
  const total = (snap.snapshot.meta && nodes.length) ? Array.from({ length: N }, (_, i) => nodes[i * NF + iSize]).reduce((a, b) => a + b, 0) : 0;
  return { replays: count, replayMB: +(bytes / 1048576).toFixed(2), runsEdges: runs, heapMB: +(total / 1048576).toFixed(2) };
}
module.exports = { replaySnapshot };
