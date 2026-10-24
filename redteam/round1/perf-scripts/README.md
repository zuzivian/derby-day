# Perf red-team scripts (round 1)

These are the finder's scripts (perf-scripts/) and the verifier's scripts (perf-verify-scripts/). They were written against a checkout of main at 623a5a1 placed at /tmp/rt/perf/repo (or /tmp/rt/perf-verify/repo). To reuse them:

1. Point the hard-coded require/path at your own checkout, e.g. `sed -i 's#/tmp/rt/perf/repo#'"$PWD"'#g' *.cjs`.
2. Run `bun run build` first. Some scripts expect an unminified build: run `bun run build-dev.ts` from this folder.
3. Run them with `NODE_PATH=/opt/node22/lib/node_modules node <script>.cjs ...` (the arguments are in perf.json, `repro`).

The verifier found a harness trap. `page.waitForSelector` returns an ElementHandle that pins the #pitch canvas, so a leak test must use `locator.waitFor()` instead. tests/e2e/lib/helpers.cjs startRanked has this trap.
