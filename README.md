# Derby Day

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

Every match is the same length: 2 × 3 minutes (`HALF_SECONDS` in `src/sim/constants.ts`). There is no length setting; `prefs.halfSeconds` in `src/client/store.ts` is only a hidden override the e2e tests use for short matches.

- **Ranked** (Home, **Kick off**): one match against a ladder club near your Elo. Moves Elo.
- **Practice** (Home, Practice card): Easy, Normal or Hard CPU. Nothing recorded but a training session.
- **Cup** (Competitions tab): 8-club knockout, you plus the seven ladder clubs nearest your Elo, seeded 1v8, 4v5, 2v7, 3v6. Quarter-final, semi-final, final; a draw you play goes to a live penalty shootout (best of five, then sudden death): as taker, aim with the mouse, hold the left button for power and release (too hard skies it, corners are riskier); as keeper, read the run-up and click left, middle or right to dive. Arrow keys and Space work too, and leaving counts as a loss. Ties between two CPU clubs use a seeded roll weighted by shooting and goalkeeping. Prize money for every round reached; a win goes in the trophy cabinet.
- **League** (Competitions tab): the same 8 clubs, single round robin over 7 matchdays, 3/1/0 points, then goal difference, then goals scored. Prize money by finishing place; the top two are "promoted".

You play your own cup ties and league fixtures live. The other matches in the round are played by the real headless sim at 60 s a half (about 80 ms each), so results follow the squads. Competition matches pay money, training and player development, but **do not change ladder Elo** or the ladder record. Forfeiting one counts as 0–3.

CPU difficulty is `TeamSetup.aiSkill` (0..1). It sets reaction time, decision noise, execution error and how well the team defends (marking zone, interceptions, a sweeper, the keeper's sweeping); see the header of `src/sim/ai.ts`.

Every finished match leaves a replay: the match options plus the per-tick input log (run-length encoded, cursor to 1 cm), which the deterministic sim re-runs exactly. **Watch goals** on the result dialog plays each goal's last six seconds (½× slow-mo, previous/next goal, scrub bar; Space, arrows and Esc work). The last five replays are kept in this browser under **Recent replays** on the Club tab, and **Copy replay code** / **Paste replay code** share one as a short `OVR1.…` string. Code is in `src/meta/replay.ts` (pure) and `src/client/replayView.ts`.

A first visit runs a short setup: name your club, pick mouse or keyboard, then four drills on a training ground (run, pass, shoot, tackle). Every step can be skipped, and **Replay tutorial** in Club news (Club tab) runs the drills again.

## Home

The first screen does one job. The hero is the next ranked match against the CPU: both crests, Elo numbers, your last five results as W/D/L chips (and a small Elo sparkline once there is history), a win-chance gauge and one big **Kick off**. Under it sit the play-mode cards: **vs Player**, **Practice** (pick the CPU difficulty, each button starts a match) and **Cup** and **League**, shown with a padlock and their level until they open. The strip at the top holds the club, its level and XP bar, and gains training sessions (pips), money and the ladder position as those features unlock. News, replays, the club level panel, the tutorial and reset are on the **Club** tab. Code: `src/client/home.ts`; the strip is `statusStrip` in `src/client/ui.ts`.

## Club levels

The club earns experience and opens up as it levels (1 to 99; clearing level L takes 100 × L XP). A new club has Home, the Club tab, the Squad, ranked matches, Easy and Normal practice and both two-human modes (Local 2P and Link two tabs); Training arrives at level 2, Transfers at 3, the Ladder at 4, the Cup (and Practice Hard) at 5, replays at 6, the League at 8 and the season calendar and academy at 10, then small perks up to 99. Matches pay XP (win 120, draw 80, loss 50, +10 a goal, +20 a clean sheet; practice 30 to 60), so do training sessions (+5), cup and league finishes and first-time milestones. Forfeits pay nothing. The header shows the level and XP bar; the Club level panel on the Club tab lists every unlock. Older saves get XP back from their match history and keep anything they already use. The full tables and pacing are under "Club levels" in the roadmap; the rules are in `src/meta/levels.ts`.

## Two players

Both are on Home in the **vs Player** card (**One screen** is Local 2P, **Two tabs** is Link two tabs), open from club level 1. Each human steers one player of their side (yellow marker for home, cyan for away); the CPU runs the rest of both teams. Nothing is recorded: no Elo, money, training or replay.

- **Local 2P:** hot-seat on one keyboard, your club against a ladder club you pick.

  | | Player 1 (home, yellow) | Player 2 (away, cyan) |
  |---|---|---|
  | Move | W A S D, or the mouse once you move it over the pitch | Arrow keys |
  | Pass / tackle | Space, or left click | Enter or `/` |
  | Shoot | Hold F, release (or hold right button) | Hold `.` (period), release |
  | Switch player | E, or right click | `,` (comma) |
  | Sprint | Left Shift | Right Shift |
  | Pause | Esc or P | Esc or P |

- **Link two tabs:** open `dist/index.html` in two tabs or windows of the same browser. In one, **Host a match** and read out the 4-letter code; in the other, type it and **Join**. Each tab plays its own side with the normal controls. The tabs run the same match in deterministic lockstep over `BroadcastChannel` (no server) with a 4-tick (67 ms) input delay, exchange only inputs, and compare a state hash every second; a mismatch stops both with "Desync at tick N". Sandboxed viewers (such as some artifact hosts) block tabs from talking; the lobby says so. See "Multiplayer spike" in the roadmap for what this proves.

## Code layout

```
src/sim/      Deterministic match engine. Pure TS, no DOM, fixed 60 Hz, seeded RNG.
              step(state, input) is the only way time moves.
src/meta/     Club layer: name generators, players and attributes, Elo, market, training, ladder.
src/net/      Netcode, pure TS: lockstep with input delay and desync detection, a two-method
              Transport, BroadcastChannel and seeded in-memory (latency, jitter, loss) transports.
src/client/   Browser: canvas renderer, input, match loop, management screens, local save.
scripts/      build.ts (bundle and inline into one HTML file), balance.ts (headless CPU matches),
              ai-probe.ts (equal squads, different CPU skill), net-probe.ts (lockstep stalls by
              input delay and simulated latency).
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
