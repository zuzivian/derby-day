// Splitting the e2e tests into groups so CI can run them in parallel jobs (E2E_SHARD=k/n, see run.cjs).
// Pure and deterministic: every job computes the same split. tests/shard.test.ts checks it runs every test once.
//
// The split is by test, not by file: one file can hold ten minutes of tests (perf.e2e.cjs), and a shard can never be
// shorter than the biggest unit it is given.

const parse = (spec) => {
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m) throw new Error(`E2E_SHARD must look like 2/3, got "${spec}"`);
  const k = Number(m[1]);
  const n = Number(m[2]);
  if (!(n >= 1 && k >= 1 && k <= n)) throw new Error(`E2E_SHARD ${spec}: the shard number must be between 1 and ${n}`);
  return { k, n };
};

/** Seconds for an item: its weight, or the median weight for one with none (a new test). */
function weigher(weights) {
  const known = Object.values(weights).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  return (x) => (typeof weights[x] === 'number' ? weights[x] : median);
}

/** All n groups: items go, heaviest first, to the group with the least work so far. Each group keeps the items' own order. */
function groupsOf(items, n, weights) {
  const w = weigher(weights);
  const order = new Map(items.map((x, i) => [x, i]));
  const groups = Array.from({ length: n }, () => ({ load: 0, items: [] }));
  for (const x of [...items].sort((a, b) => w(b) - w(a) || a.localeCompare(b))) {
    const g = groups.reduce((best, cur) => (cur.load < best.load ? cur : best));
    g.items.push(x);
    g.load += w(x);
  }
  for (const g of groups) g.items.sort((a, b) => order.get(a) - order.get(b));
  return groups;
}

/**
 * The k-th (1-based) of n groups of `items` (test names), balanced by `weights` (seconds per test, from
 * tests/e2e/shard-weights.json). The group runs in the items' own order: file by file, each file's tests as it declares them.
 * Returns all of `items` when `spec` is empty. Throws on a malformed spec.
 */
function shardItems(items, spec, weights = {}) {
  if (!spec) return items;
  const { k, n } = parse(spec);
  return groupsOf(items, n, weights)[k - 1].items;
}

/** Total weight (seconds) of each of the n groups, for checking the split is even and for each shard's expected time. */
function shardLoads(items, n, weights = {}) {
  return groupsOf(items, n, weights).map((g) => g.load);
}

module.exports = { shardItems, shardLoads, parseShard: parse };
