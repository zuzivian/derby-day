// Splitting the e2e test files into groups so CI can run them in parallel jobs (E2E_SHARD=k/n, see run.cjs).
// Pure and deterministic: every job computes the same split. tests/shard.test.ts checks it covers every file once.

/**
 * The k-th (1-based) of n groups of `files`. Files go, heaviest first, to the group with the least work so far, by `weights`
 * (seconds per file, from tests/e2e/shard-weights.json); a file with no weight counts as the median weight.
 * Returns all of `files` when `spec` is empty. Throws on a malformed spec.
 */
function shardFiles(files, spec, weights = {}) {
  if (!spec) return files;
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m) throw new Error(`E2E_SHARD must look like 2/3, got "${spec}"`);
  const k = Number(m[1]);
  const n = Number(m[2]);
  if (!(n >= 1 && k >= 1 && k <= n)) throw new Error(`E2E_SHARD ${spec}: the shard number must be between 1 and ${n}`);
  const known = Object.values(weights).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const w = (f) => (typeof weights[f] === 'number' ? weights[f] : median);
  const groups = Array.from({ length: n }, () => ({ load: 0, files: [] }));
  for (const f of [...files].sort((a, b) => w(b) - w(a) || a.localeCompare(b))) {
    const g = groups.reduce((best, cur) => (cur.load < best.load ? cur : best));
    g.files.push(f);
    g.load += w(f);
  }
  return groups[k - 1].files.sort();
}

/** Total weight of each of the n groups, for checking the split is even. */
function shardLoads(files, n, weights = {}) {
  const known = Object.values(weights).filter((v) => typeof v === 'number').sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  return Array.from({ length: n }, (_, i) => shardFiles(files, `${i + 1}/${n}`, weights).reduce((sum, f) => sum + (typeof weights[f] === 'number' ? weights[f] : median), 0));
}

module.exports = { shardFiles, shardLoads };
