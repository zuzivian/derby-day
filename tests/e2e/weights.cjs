#!/usr/bin/env node
// Refresh tests/e2e/shard-weights.json (seconds per e2e test, which lib/shard.cjs balances the CI shards by) from measured
// timings. CI keeps each shard's timings as an artifact (e2e-timings-<k>, a JSON of test name -> seconds); download a run's and:
//
//   node tests/e2e/weights.cjs e2e-timings-*.json
//
// A test with no new timing keeps its old weight; one that no longer exists is dropped. Tests are listed in run order.

const fs = require('node:fs');
const path = require('node:path');
const { registry } = require('./lib/harness.cjs');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tests/e2e/weights.cjs <timings.json>... (the e2e-timings-* artifacts of a CI run)');
  process.exit(2);
}
for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.e2e.cjs')).sort()) require(path.join(__dirname, f));

const out = path.join(__dirname, 'shard-weights.json');
const old = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
const fresh = Object.assign({}, ...files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))));
const weights = {};
for (const { name } of registry) {
  const s = typeof fresh[name] === 'number' ? fresh[name] : old[name];
  if (typeof s === 'number') weights[name] = s;
}
fs.writeFileSync(out, `${JSON.stringify(weights, null, 2)}\n`);
const total = Object.values(weights).reduce((a, b) => a + b, 0);
console.log(`${Object.keys(weights).length} of ${registry.length} tests weighted, ${Math.round(total)} s in all; wrote ${path.relative(process.cwd(), out)}`);
