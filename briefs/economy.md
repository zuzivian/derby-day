# Derby Day stream brief: economy (the long game)

You are one of several parallel Claude Code sessions improving "Derby Day" (repo zuzivian/derby-day, private), a zero-dependency TypeScript browser football game: a club manager where you also play every match yourself with the mouse, in the spirit of the 2005-2016 browser game Power Soccer. 3D via vendored three.js r186 in vendor/three; a deterministic 60 Hz sim in src/sim (pure: seeded RNG, no Math.random/Date/DOM, all state in MatchState); 11 v 11 under the Laws of the Game; every match 2 x 3 minutes; replays are input logs re-simulated (src/meta/replay.ts); two-tab lockstep multiplayer (src/net). It deploys to Vercel from `main` (derby.natwong.dev). Read README.md and docs/ROADMAP.md first, then the code you own.

BRANCH AND PR: work on branch `feat/economy` (check it out; it may already exist on origin with work in progress — if so continue from it). First run `git fetch origin main && git merge origin/main` so you are on top of main. Commit as you go. When your work passes all checks, push the branch and open a DRAFT pull request against `main` titled "A living world: growing CPU clubs, fair rewards, no exploits, a long game", then keep its CI green (fix failures at the root cause; never skip or weaken a test). Do not merge your PR: a coordinator session merges PRs. If main moves while you work (another stream merged), merge origin/main into your branch, resolve conflicts keeping both sides' behaviour, re-run checks and push.

TOOLCHAIN: npm registry may be blocked; add no dependencies. Bun and global tsc should be installed (Bun at /root/.bun/bin/bun; if missing, try `curl -fsSL https://bun.sh/install | bash`). Before every push all must pass: `bun run check` (typecheck + unit tests + build), `bun run balance 30 --assert`, and `NODE_PATH="$(npm root -g)" bun run e2e` (also tries /opt/node22/lib/node_modules; slow with 3D under SwiftShader — iterate with `node tests/e2e/run.cjs "<name filter>"`, run the full suite before pushing). Headless Chromium: Playwright is installed globally; launch with executablePath '/opt/pw-browsers/chromium' and args ['--use-angle=swiftshader','--enable-unsafe-swiftshader'], open file://<repo>/dist/index.html after `bun run build`. Google Fonts may fail to load (expected). Setting window.__e2e = true before boot (page.addInitScript) exposes the live match as window.__derbyMatch for setting up scenes. Keep scratch scripts and screenshots outside the repo (e.g. /tmp/scratch). No real GPU here: 3D runs at a few fps in SwiftShader, so judge visuals from screenshots and feel from sim metrics and scripted playtests in bun.

THE OWNER'S FEEDBACK MATERIAL: `git fetch origin assets/feedback` then `git show origin/assets/feedback:feedback/2026-10-24-result-dialog.png > /tmp/result.png`, `git show origin/assets/feedback:feedback/2026-10-24-live-match.webp > /tmp/match.webp`, `git show origin/assets/feedback:feedback/research-mouse-and-pace.md > /tmp/research.md`, and look at them (Read tool). Power Soccer reference screenshots the owner shared: feedback/power-soccer-ref-1.webp and power-soccer-ref-2..5.png on the same branch. Power Soccer reference look (from the owner's screenshots): elevated broadcast camera on the long side; daytime stadium with crowd, ad boards and long shadows; player names in orange over players, orange triangle over the controlled player, yellow ground ring, stamina bars; HUD top-left crests + score + MM:SS clock, top-right Esc/MENU and "You vs AI", big bold italic centre words (GOAL, REPLAY), bottom-centre radar minimap, bottom-right power bar.

The owner's latest feedback, verbatim:
1. too zoomed in, can't se enough of the pitch
2. mouse passes seem to be air balls by default. not good tactically.
3. simple single click to pass should be weighted well to reach the other player expeditiously
4. collision handling w the ball is horrible, especially when the ball is in the air.
5. keeping collision handling and physics is terrible   [read as: GOALKEEPING collision handling and physics]
6. simple mouse clicks should enable tiki taka
7. the power level of the pass/cross/shot should be indicated in the direction cone/arrows
8. keeper should not auto pass/distribute the ball. should be done by player.
9. for goal kicks, give a long view so that it is easier for the player to distribute the ball to players
10. implement replays for significant events (goals, yellow cards, key shots etc)
11. find other best practices for mouse handling and pace in game.
12. implement common formations for teams to pick from, and level of tactical aggressiveness (park the bus to super high pressing)
13. fix the UI issues shown (not nice looking)
14. make the onboarding even more gradual get to the payoff of playing games asap, reveal more of the menus over time
Their standing goal: keep polishing and adding core features in the spirit of Power Soccer until the game is truly ready to be played by thousands of players.

EARLIER STREAMS (merged; build on them, do not redo them) AND FILE OWNERSHIP (edit outside your own files only when you must, keep it small and additive, and list it in your PR description):
- physics (feat/physics): src/sim/match.ts, kicks.ts, human.ts, rules.ts (restart taking), types.ts (additive), src/client/input.ts, pads.ts, src/meta/replay.ts (format bump)
- tactics (feat/tactics): src/sim/ai.ts, formations in src/sim/constants.ts, tactics fields in src/meta/club.ts and game.ts, src/client/tactics.ts (Squad screen hooks), scripts/tactics-probe.ts
- view (feat/view): src/client/r3d/*, hud.ts, hud.css, matchView.ts (instant-replay orchestration), renderer.ts, replayView.ts
- ui (feat/ui): styles.css, ui.ts (shell, result dialog, squad/club look), home.ts (look), review.css, levels.css, replay.css, levels.ts (dialog look)
- economy (feat/economy, YOU): world, economy, rewards and calendar in src/meta (club.ts, game.ts, season/league/cup code), scripts/career.ts
- onboarding (feat/onboarding): onboarding.ts, tutorial.ts, drills.ts, UNLOCKS in src/meta/levels.ts, first-run routing in main.ts, src/client/coach.ts
The sim must stay deterministic and the determinism, replay and lockstep tests must keep passing (bump a replay/sim version where behaviour changes).

COMMITS: every commit message ends with exactly:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SwXgWnBxJDFASUuzjLYiWW

QUALITY BAR: do not stop at "it works". After building, red-team your own work: write scripted playtests and measurements for every feel claim, take screenshots for every visual claim at 1280x800 and 390x844, compare with the owner's words and screenshots, and iterate until you have nothing left to fix in your area. Put numbers and screenshot descriptions in the PR description. When done and CI is green, leave the PR as draft-ready (mark it ready for review) and stop.

YOUR WORKSTREAM: a long game worth playing for months. That means the progression, the economy and the living world around the matches. Red-team round 1b's progression lens simulated 300-match careers on main. Read `git show origin/assets/feedback:redteam/round1b/progression.json` (findings, evidence, suggested fixes and the skeptic's verdicts) and the scripts in `redteam/round1b/scripts/progression/` (see the README). Re-measure on current main first.

Fix, with tests and a career simulator:
1. A living world, the biggest finding. CPU clubs never grow, so within about 150 matches the player's XI is 15-25 points above every CPU club and the ladder runs out.
   - CPU clubs need to develop: squad ageing and retirement, youth, transfers between CPU clubs, a quality drift that tracks the player's tier, and promotion and relegation that matter.
   - Strong opposition must always exist at the top.
   - Keep it deterministic from the save's seed, and cheap to compute.
2. Close the exploits:
   - Reloading or closing the tab mid-match dodges a ranked, cup or league result, and re-rolls the next opponent. Record a pending match at kick-off and settle it on the next boot. An abandoned ranked match counts as a forfeit, and the player gets a clear, fair message, because a real crash is possible. Fix the opponent when the match is offered, not on each load.
   - Forfeits move the season calendar, giving free season rollovers.
   - Cups can be restarted without limit, never risk Elo, and pay 1.6-2x the XP of ranked.
   - Forfeiting a league season still pays last-place prize money.
   - Ranked rewards ignore opponent strength, and Elo can be lowered cheaply on purpose. Scale rewards by opponent strength and make sandbagging pointless.
3. League promotion and relegation must have real effects, such as different opposition, prize money and a visible tier. Fix the two unrelated "Season N" counters.
4. Pacing across levels 1-99:
   - Measure the hours to levels 5, 10, 20, 50 and 99 at 6 minutes a match plus menus.
   - Make the curve sensible for a live game, and make sure there are meaningful unlocks or goals beyond level 22: cosmetics, harder competitions, a club history and trophy cabinet, records.
   - Talk to the coordinator before changing the owner's XP formula (level 1 needs 100 XP, level 99 needs 9900 XP). Rewards per match can change.
5. Smaller items:
   - The transfer market should also refresh on time and on other match types.
   - CPU cup and league fixtures should be simulated at full length or calibrated so their scores look real.
   - Correct the docs on pacing and on what practice matches record.
   - Cap the match history in the save, keeping aggregates.
6. scripts/career.ts: a deterministic headless career simulator (300+ matches of mixed results and match types) that prints the level, Elo, money, squad quality against the ladder, and unlocks over time. Add a CI-friendly `--assert` with bands for the targets above, and put it in the check job.
7. Save migration for every new field, with tests. Update README and ROADMAP.

Coordination:
- The fairness stream (feat/fairness) will own opponent selection (pickOpponent, the hidden skill estimate and the aiSkill band) in src/meta.
- You own the world, the economy, rewards and the calendar.
- If both of you need the same function, agree an interface through the coordinator.
- The UI stream owns how screens look. Keep your markup minimal, use existing classes, and list every file outside your area that you touch.
