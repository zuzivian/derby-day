# Overlap

A browser football club manager where you also play the matches yourself, mouse-first. You run a generated club (squad, transfers, training, an Elo ladder) and play 6-a-side matches in real time against the CPU.

This is a prototype. The plan for turning it into an online live-service game is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Play

```sh
bun run build      # writes dist/index.html, a single self-contained file
open dist/index.html
```

Or `bun run dev` to rebuild on save and serve on http://localhost:5173.

Install Bun with `curl -fsSL https://bun.sh/install | bash` (no sudo needed). There are no npm dependencies.

### Controls

| | Mouse (recommended) | Keyboard |
|---|---|---|
| Move | Your player runs to the pointer | WASD or arrows |
| Pass (with the ball) | Left click toward a teammate or space | Space |
| Tackle (without the ball) | Left click | Space |
| Shoot | Hold right button, release | Hold F, release |
| Sprint | Hold Shift or the middle button (+18% top speed, drains stamina) | Hold Shift |
| Through ball | Ctrl/Cmd + left click: into space ahead of the receiver | R |
| Chip (lofted) | Ctrl/Cmd + hold right button, release: lands at the pointer, charge sets the range | Hold C, release |
| Switch player | Right click | E |
| Pause | Esc or P | Esc or P |

The dotted line shows where a click would pass right now; hold Ctrl/Cmd and a yellow diamond shows where a through ball would land, and while charging a chip a blue ring and arc show where it will come down. The bar under your player is stamina: sprint empties it, and when it is red you are winded until it refills. A chipped ball can't be taken by outfield players while it is above 1.2 m; keepers can reach it in their box up to 2.1 m, and over the bar is not a goal. Phones get on-screen Pass and Shoot buttons.

## Playing the CPU

- **Ranked** (Club tab): one match against a ladder club near your Elo. Moves Elo.
- **Practice** (Club tab): Easy, Normal or Hard CPU. Nothing recorded but a training session.
- **Cup** (Competitions tab): 8-club knockout, you plus the seven ladder clubs nearest your Elo, seeded 1v8, 4v5, 2v7, 3v6. Quarter-final, semi-final, final; a draw you play goes to a live penalty shootout (best of five, then sudden death): as taker, aim with the mouse, hold the left button for power and release (too hard skies it, corners are riskier); as keeper, read the run-up and click left, middle or right to dive. Arrow keys and Space work too, and leaving counts as a loss. Ties between two CPU clubs use a seeded roll weighted by shooting and goalkeeping. Prize money for every round reached; a win goes in the trophy cabinet.
- **League** (Competitions tab): the same 8 clubs, single round robin over 7 matchdays, 3/1/0 points, then goal difference, then goals scored. Prize money by finishing place; the top two are "promoted".

You play your own cup ties and league fixtures live. The other matches in the round are played by the real headless sim at 60 s a half (about 80 ms each), so results follow the squads. Competition matches pay money, training and player development, but **do not change ladder Elo** or the ladder record. Forfeiting one counts as 0–3.

CPU difficulty is `TeamSetup.aiSkill` (0..1). It sets reaction time, decision noise, execution error and how well the team defends (marking zone, interceptions, a sweeper, the keeper's sweeping); see the header of `src/sim/ai.ts`.

A first visit runs a short setup: name your club, pick mouse or keyboard, then four drills on a training ground (run, pass, shoot, tackle). Every step can be skipped, and **Replay tutorial** in Club news runs the drills again.

## Code layout

```
src/sim/      Deterministic match engine. Pure TS, no DOM, fixed 60 Hz, seeded RNG.
              step(state, input) is the only way time moves.
src/meta/     Club layer: name generators, players and attributes, Elo, market, training, ladder.
src/client/   Browser: canvas renderer, input, match loop, management screens, local save.
scripts/      build.ts (bundle and inline into one HTML file), balance.ts (headless CPU matches),
              ai-probe.ts (equal squads, different CPU skill).
tests/        bun test: determinism, plausible matches, Elo maths, transfers and training rules.
tests/e2e/    Browser tests (Playwright, no framework): boot, tabs, layout, transfers, matches.
.github/      CI: typecheck, unit tests, build, balance guard, e2e.
```

## Checks

```sh
bun run check      # typecheck + tests + build
bun run balance 50 # 50 CPU-vs-CPU matches at full speed, prints goal/shot/upset rates
bun run balance 20 --assert  # same, but exits non-zero if goals/match is outside 1.5 to 6 or passes/match < 80
bun run scripts/ai-probe.ts 40 0.85 0.25  # 40 matches, identical squads, CPU skill 0.85 vs 0.25: W/D/L
bun run e2e        # build, then drive the real page in headless Chromium (see below)
```

### End-to-end tests

`tests/e2e/` holds browser tests run by a small dependency-free runner (`tests/e2e/run.cjs`). They open `dist/index.html` in Chromium and exercise boot, every tab at 1280 and 390 px in light and dark, training, buying and selling, lineup persistence, a short ranked match, pause, forfeit and keyboard-only play.

Playwright is not a repo dependency. Install it once globally and let Node find it:

```sh
npm i -g playwright@1 && playwright install chromium
NODE_PATH="$(npm root -g)" bun run e2e
```

The runner also falls back to the global npm root and `/opt/node22/lib/node_modules` on its own, so `NODE_PATH` is usually optional. Set `PLAYWRIGHT_CHROMIUM=/path/to/chrome` to use a specific browser (default: `/opt/pw-browsers/chromium` if it exists, otherwise Playwright's own). `node tests/e2e/run.cjs <text>` runs only tests whose name contains `<text>`; `E2E_HEADED=1` shows the browser.

All selectors live in `tests/e2e/lib/helpers.cjs` (`SEL`), including the best-effort onboarding skipper. When the UI changes, fix them there.
