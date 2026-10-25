# Derby Day stream brief: fairness

You are one of several parallel Claude Code sessions improving "Derby Day" (repo zuzivian/derby-day, private), a zero-dependency TypeScript browser football game: a club manager where you also play every match yourself with the mouse, in the spirit of the 2005-2016 browser game Power Soccer. 3D via vendored three.js r186 in vendor/three; a deterministic 60 Hz sim in src/sim (pure: seeded RNG, no Math.random/Date/DOM, all state in MatchState); 11 v 11 under the Laws of the Game; every match 2 x 3 minutes; replays are input logs re-simulated (src/meta/replay.ts); two-tab lockstep multiplayer (src/net). It deploys to Vercel from `main` (derby.natwong.dev). Read README.md and docs/ROADMAP.md first, then the code you own.

BRANCH AND PR: work on branch `feat/fairness` (check it out; it may already exist on origin with work in progress — if so continue from it). First run `git fetch origin main && git merge origin/main` so you are on top of main. Commit as you go. When your work passes all checks, push the branch and open a DRAFT pull request against `main` titled "Fair matches: a human side that can win, honest difficulty", then keep its CI green (fix failures at the root cause; never skip or weaken a test). Do not merge your PR: a coordinator session merges PRs. If main moves while you work (another stream merged), merge origin/main into your branch, resolve conflicts keeping both sides' behaviour, re-run checks and push.

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

EARLIER STREAMS (merged before you start; build on them, do not redo them) AND FILE OWNERSHIP (edit outside your own files only when you must, keep it small and additive, and list it in your PR description):
- physics (feat/physics): src/sim/match.ts, kicks.ts, human.ts, rules.ts (restart taking), types.ts (additive), src/client/input.ts, pads.ts, src/meta/replay.ts (format bump)
- tactics (feat/tactics): src/sim/ai.ts, formations in src/sim/constants.ts, tactics fields in src/meta/club.ts and game.ts, src/client/tactics.ts (Squad screen hooks), scripts/tactics-probe.ts
- view (feat/view): src/client/r3d/*, hud.ts, hud.css, matchView.ts (instant-replay orchestration), renderer.ts, replayView.ts
- ui (feat/ui): styles.css, ui.ts (shell, result dialog, squad/club look), home.ts (look), review.css, levels.css, replay.css, levels.ts (dialog look)
- attack (feat/attack, in parallel with you): attacking behaviour in src/sim/ai.ts (runs in behind, through balls, carries, crosses, cut-backs, shot choice) and the shot probes. Keep your ai.ts changes to defensive support for the human side; merge origin/main often; whoever merges second takes SIM_VERSION main + 1.
- fairness (feat/fairness, YOU): scripts/fairness.ts, the human-team support behaviour in src/sim/ai.ts and src/sim/human.ts, opponent selection and the hidden skill estimate in src/meta, tests for these
- onboarding (feat/onboarding): onboarding.ts, tutorial.ts, drills.ts, UNLOCKS in src/meta/levels.ts, first-run routing in main.ts, src/client/coach.ts
The sim must stay deterministic and the determinism, replay and lockstep tests must keep passing (bump a replay/sim version where behaviour changes).

COMMITS: every commit message ends with exactly:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SwXgWnBxJDFASUuzjLYiWW

QUALITY BAR: do not stop at "it works". After building, red-team your own work: write scripted playtests and measurements for every feel claim, take screenshots for every visual claim at 1280x800 and 390x844, compare with the owner's words and screenshots, and iterate until you have nothing left to fix in your area. Put numbers and screenshot descriptions in the PR description. When done and CI is green, leave the PR as draft-ready (mark it ready for review) and stop.

CURRENT STATE WHEN YOU START (written by the coordinator): main is 8e4ce9f. Tactics #7 has merged, so main has SIM_VERSION 5, REPLAY_VERSION 6, formations, mentalities, CPU support play (supportSpot, nearestK, TACTICS in src/sim/ai.ts) and quick tactics. Other sim streams are running in parallel with you; merge origin/main often and keep to your own functions:
- controls (physics session, feat/controls): human.ts loose-ball collection, tackles, lofted-pass control, clicks, shot height (src/sim/human.ts, kicks.ts, the contact and control code in match.ts, src/client/input.ts)
- rules (feat/rules): restarts and second touch, half-time ends, offside phases, added time (src/sim/rules.ts, field.ts, the restart and half-time code in match.ts)
- attack (feat/attack) and fairness (feat/fairness): see the ownership list above
Every PR that changes sim outcomes bumps SIM_VERSION to main + 1 at the moment it merges, so expect to re-bump after another stream lands. The tactics session (session_01Jbf67H76dUQ5n6oBg1q5wZ) wrote the support play. If you need to understand it, ask the coordinator to relay a question.

YOUR WORKSTREAM: fair, fun matches against the CPU for every skill level. This comes from an independent review: in headless sims of a new club's first ranked match (20 seeds each), a scripted human lost every time, whatever the style: passive 0-5.8, follow-the-ball 0-4.25, flailing 0-6.45, chaser 0-5.35, a "learner" 0.3-3.85, a dribbler 0.7-3.25, against a ladder club of similar Elo (aiSkill about 0.42), while the result dialog promised a 45-55% win chance. With thousands of new players, losing 0-5 every time is the fastest way to lose them. The fix must keep ranked meaningful for good players.

Read first: docs/ROADMAP.md, src/meta (how CPU opponents, aiSkill, squad quality and Elo are chosen: pickOpponent, cpuTeam, the ladder), src/sim/ai.ts and src/sim/human.ts (what the human's team-mates do around the human, and how the human's controlled player is helped). By the time you start, the physics stream (better passing assist, keeper control) and the tactics stream (formations, mentality, support play) have merged; build on them.

Build:
1. A headless harness, scripts/fairness.ts: a set of scripted human behaviours (passive, follow-the-ball, chaser, a simple competent bot that passes to open team-mates and shoots in range, a strong bot) playing full matches through the real step() with humans:[true,false], across opponent tiers, many seeds, reporting goals for/against, win/draw/loss and shots. Also the CPU-vs-CPU baseline with the same squads. Make it fast and deterministic; print a table.
2. Diagnose WHY a human side does so much worse than the same squad run by the CPU (likely candidates: the controlled player standing still or running the wrong way while the 10 CPU team-mates keep their shape around him; team-mates not pressing or covering for the human; possession lost from the human's touches; the human's man counted as "the presser" so nobody else presses). Measure each candidate before fixing it.
3. Fix it with fair, honest assists, not rubber-banding that cheats: the CPU team-mates should cover for the human (press when he doesn't, fill his position when he wanders), the human's controlled player should get sensible auto-behaviour when the human gives no input for a moment (hold position / jockey), and the auto-switch should give the human the right man when defending.
4. Difficulty that fits the player: a hidden skill estimate per club from recent results (separate from Elo, which stays the honest ladder), used to choose the CPU opponent's aiSkill within a band so new and struggling players get winnable matches and strong players get real opposition. Ranked Elo stays honest: the win-chance shown must match what the harness measures for that player's estimate. Practice tiers stay fixed and labelled.
5. Targets, measured by the harness and asserted by a CI script (add it to the check job like balance): a passive human loses but not by a rout (goal difference better than -3 on average vs a new club's first ranked opponents); the competent bot wins about 45-60% against an equal-estimate opponent; the strong bot wins most matches against new-club opponents and fewer against top clubs; CPU-vs-CPU balance stays in its current bands (`bun run balance 30 --assert`).
6. Tests for the estimate, the matchmaking band and the save migration; README and ROADMAP updated with the table of measured numbers.
Do not add dependencies. Keep the sim deterministic (bump the replay/sim version if behaviour changes).
