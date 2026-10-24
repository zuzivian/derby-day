# Derby Day stream brief: attack (final-third play)

You are one of several parallel Claude Code sessions improving "Derby Day" (repo zuzivian/derby-day, private), a zero-dependency TypeScript browser football game: a club manager where you also play every match yourself with the mouse, in the spirit of the 2005-2016 browser game Power Soccer. 3D via vendored three.js r186 in vendor/three; a deterministic 60 Hz sim in src/sim (pure: seeded RNG, no Math.random/Date/DOM, all state in MatchState); 11 v 11 under the Laws of the Game; every match 2 x 3 minutes; replays are input logs re-simulated (src/meta/replay.ts); two-tab lockstep multiplayer (src/net). It deploys to Vercel from `main` (derby.natwong.dev). Read README.md and docs/ROADMAP.md first, then the code you own.

BRANCH AND PR: work on branch `feat/attack` (check it out; it may already exist on origin with work in progress — if so continue from it). First run `git fetch origin main && git merge origin/main` so you are on top of main. Commit as you go. When your work passes all checks, push the branch and open a DRAFT pull request against `main` titled "Final-third attacking play: runs in behind, through balls, cut-backs, better chances", then keep its CI green (fix failures at the root cause; never skip or weaken a test). Do not merge your PR: a coordinator session merges PRs. If main moves while you work (another stream merged), merge origin/main into your branch, resolve conflicts keeping both sides' behaviour, re-run checks and push.

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
- attack (feat/attack, YOU): attacking behaviour in src/sim/ai.ts (runs, through balls, carries, crosses, cut-backs, shot choice), the probes in src/meta/shotProbe.ts, scripts/balance.ts and scripts/tactics-probe.ts
- fairness (feat/fairness, in parallel with you): human-team defensive support in src/sim/ai.ts and src/sim/human.ts, matchmaking and the skill estimate in src/meta
- onboarding (feat/onboarding): onboarding.ts, tutorial.ts, drills.ts, UNLOCKS in src/meta/levels.ts, first-run routing in main.ts, src/client/coach.ts
The sim must stay deterministic and the determinism, replay and lockstep tests must keep passing (bump a replay/sim version where behaviour changes).

COMMITS: every commit message ends with exactly:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SwXgWnBxJDFASUuzjLYiWW

QUALITY BAR: do not stop at "it works". After building, red-team your own work: write scripted playtests and measurements for every feel claim, take screenshots for every visual claim at 1280x800 and 390x844, compare with the owner's words and screenshots, and iterate until you have nothing left to fix in your area. Put numbers and screenshot descriptions in the PR description. When done and CI is green, leave the PR as draft-ready (mark it ready for review) and stop.

YOUR WORKSTREAM: final-third attacking play, so CPU sides (and the human's CPU team-mates) create chances the way real teams do, instead of shooting from 25 m because nobody gets into the box. This comes from the tactics stream's own measurements on PR #7 (read its description: `git log origin/main --grep "Formations"`, or the PR body on GitHub). Of the possessions that reach 18-28 m from goal, only 0-6% go on into the box. An attacker has the ball in the box for about 7 ticks a match. 61% of shots come from 18-30 m and 11.4% of those score; real football is about 40-50% of shots from there, with 4-7% scoring. Runners stand on the defenders' line instead of running beyond it. Every way of making long shots harder only lowers goals, so the fix is to create better chances.

Read first: README.md, docs/ROADMAP.md, src/sim/ai.ts (support play, buildPlan, the shoot/pass decisions, TACTICS per mentality), src/sim/match.ts and kicks.ts (pass and shot physics), src/meta/shotProbe.ts and scripts/balance.ts (the shots-by-distance table), scripts/tactics-probe.ts.

Build:
1. Measurement first. Extend the probes so one command prints, per mentality and in total: box entries per match (by carry, pass and cross), through balls attempted and completed, runs in behind (a runner who crosses the last defender's line before the pass), cut-backs, crosses and crossing success, shots by zone with share and conversion, xG-style shot quality, and goals per match. Record the baseline on main before you change anything.
2. Runs in behind: when a team-mate on the ball can play it, forwards and attacking midfielders time diagonal runs beyond the last defender. They stay onside (they curve or check back when the line steps up) and the run is a real option the passer weighs.
3. Through balls: the passer leads a runner into space behind the line, weighted so he arrives first, on the ground by default, lofted over a deep line only when the lane is blocked. Use the existing pass physics, without special-casing the outcome.
4. Carries into the box: a carrier with space ahead runs at the box rather than shooting from range. One-twos and wall passes at the edge of the box.
5. Width: wingers and full-backs get to the byline and cut back to the penalty spot area, or cross to the far post with attackers attacking those zones (near post, far post, edge of the box).
6. Better shot selection: in range but crowded, prefer the higher-quality option (a pass to a better-placed mate, or a carry) over a speculative shot; keep long shots for when there is real space and a good striker.
7. Mentality must still matter: Attacking and High press commit more runners and take more risk; Park the bus and Defensive counter with one or two runners and fewer bodies in the box.
8. Targets, measured by your probe over at least 120 balance matches, each asserted by a test or a `--assert` check:
   - 18-30 m shot share 40-50% and conversion 4-7%
   - shots in the box at least 35% of shots, with conversion 12-25%
   - box entries clearly up (report the multiple)
   - goals per match in the balance band, ideally 2.2-3.0
   - pass completion and the mentality ordering from #7's tables stay sensible
   - `bun run balance 30 --assert` passes
   - the physics stream's tiki-taka and keeper tests still pass
9. The human side: the human's CPU team-mates use the same runs, so a human on the ball gets runners to pick out. Write a scripted human (in bun, through step() with humans:[true,false]) who passes to the most advanced open runner, and show that he creates more box chances than on main.
10. Update README and ROADMAP with before/after tables. Bump SIM_VERSION by one (above main's at the time you merge) with the reason, since outcomes change.

Coordination: the fairness stream (feat/fairness) also edits src/sim/ai.ts and human.ts at the same time. It covers how CPU team-mates cover for the human when DEFENDING, plus matchmaking. You own the ATTACKING behaviour (runs, through balls, carries, crosses, cut-backs, shot choice). Keep your changes to functions in your area, merge origin/main often, and if a conflict is about behaviour, keep both sides' intent. If both of you bump SIM_VERSION, whoever merges second takes main + 1.
