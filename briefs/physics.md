# Derby Day stream brief: physics

You are one of several parallel Claude Code sessions improving "Derby Day" (repo zuzivian/derby-day, private), a zero-dependency TypeScript browser football game: a club manager where you also play every match yourself with the mouse, in the spirit of the 2005-2016 browser game Power Soccer. 3D via vendored three.js r186 in vendor/three; a deterministic 60 Hz sim in src/sim (pure: seeded RNG, no Math.random/Date/DOM, all state in MatchState); 11 v 11 under the Laws of the Game; every match 2 x 3 minutes; replays are input logs re-simulated (src/meta/replay.ts); two-tab lockstep multiplayer (src/net). It deploys to Vercel from `main` (derby.natwong.dev). Read README.md and docs/ROADMAP.md first, then the code you own.

BRANCH AND PR: work on branch `feat/physics` (check it out; it may already exist on origin with work in progress — if so continue from it). First run `git fetch origin main && git merge origin/main` so you are on top of main. Commit as you go. When your work passes all checks, push the branch and open a DRAFT pull request against `main` titled "Passing, ball physics, goalkeeping and keeper control", then keep its CI green (fix failures at the root cause; never skip or weaken a test). Do not merge your PR: a coordinator session merges PRs in order (physics, tactics, view, ui, onboarding). If main moves while you work (another stream merged), merge origin/main into your branch, resolve conflicts keeping both sides' behaviour, re-run checks and push.

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

PARALLEL STREAMS AND FILE OWNERSHIP (edit outside your own files only when you must, keep it small and additive, and list it in your PR description):
- physics (feat/physics): src/sim/match.ts, kicks.ts, human.ts, rules.ts (restart taking), types.ts (additive), src/client/input.ts, pads.ts, src/meta/replay.ts (format bump)
- tactics (feat/tactics): src/sim/ai.ts, formations in src/sim/constants.ts, tactics fields in src/meta/club.ts and game.ts, src/client/tactics.ts (Squad screen hooks), scripts/tactics-probe.ts
- view (feat/view): src/client/r3d/*, hud.ts, hud.css, matchView.ts (instant-replay orchestration), renderer.ts, replayView.ts
- ui (feat/ui): styles.css, ui.ts (shell, result dialog, squad/club look), home.ts (look), review.css, levels.css, replay.css, levels.ts (dialog look)
- onboarding (feat/onboarding): onboarding.ts, tutorial.ts, drills.ts, UNLOCKS in src/meta/levels.ts, first-run routing in main.ts, src/client/coach.ts
The sim must stay deterministic and the determinism, replay and lockstep tests must keep passing (bump a replay/sim version where behaviour changes).

COMMITS: every commit message ends with exactly:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SwXgWnBxJDFASUuzjLYiWW

QUALITY BAR: do not stop at "it works". After building, red-team your own work: write scripted playtests and measurements for every feel claim, take screenshots for every visual claim at 1280x800 and 390x844, compare with the owner's words and screenshots, and iterate until you have nothing left to fix in your area. Put numbers and screenshot descriptions in the PR description. When done and CI is green, leave the PR as draft-ready (mark it ready for review) and stop.

YOUR WORKSTREAM: passing, ball physics, collisions, goalkeeping and keeper control. Owner asks 2, 3, 4, 5, 6, 8 and 11 (mouse handling and pace), plus a stats sanity check.
- Ask 2 (air balls by default): first DIAGNOSE exactly why a plain mouse click often becomes a lofted ball (check the click-vs-hold threshold in input.ts/human.ts against real click durations, pointer movement during a click, trackpads, how the 3D renderer shows ball height, whether ground passes bounce). Then make a single click ALWAYS a ground pass; a loft must need a deliberate hold with a visible charge (use the research's numbers). Prove it with a test that simulates realistic click durations (60-260 ms) and gets 100% ground passes.
- Ask 3 (weighted to reach the teammate quickly): a click pass should be firm and arrive fast and still controllable (real short passes travel roughly 10-15 m/s; arrive at the receiver at a controllable pace, not dribbling up at 3 m/s). Strengthen pass assist for simple clicks: when the pointer is near a teammate or in his direction, play it to his feet or leading him (distance-scaled assist radius / angular cone); empty-grass clicks still go to the point. The receiver moves to meet the ball.
- Ask 6 (tiki-taka with simple clicks): chains of quick short click passes must work: clean first touch, receivers controlling instantly, control switching to the receiver WITHOUT him running back toward the stale pointer (fix that known gotcha: e.g. hold position until the pointer moves, or re-anchor), sensible but not absurd interceptions. Coordinate with the tactics stream, which makes CPU teammates offer short angles; you make the passing and receiving crisp. Measure: with a scripted human doing short click passes to the nearest open teammate, completion rate and passes per possession.
- Ask 4 (ball collisions, especially in the air): height-aware ball-body collision: the ball must bounce off players' bodies (legs, torso, head volumes by height) instead of passing through or snapping to feet from distance; headers for balls at head height; chest/thigh control for mid-height balls when receiving; no teleporting. Deflections should be physical and deterministic.
- Ask 5 (goalkeeping physics): keeper reach volumes for hands when diving, dives that actually intercept the ball's path, catches at sensible heights, parries that deflect realistically, no ghosting through the keeper, sensible keeper-player collisions.
- Ask 8 (no auto distribution): when the human's keeper holds the ball (after a catch, or at a goal kick), control goes to the keeper and he waits for the human's click (pass, loft or right-click punt/long kick). Follow the Laws: a keeper may hold the ball about 6 s; show a countdown and only then auto-release. Goal kicks for the human's team are taken by the human through the keeper (no instant CPU take). CPU keepers keep distributing themselves.
- Ask 11 (mouse handling and pace): apply the research notes below to the speed-by-distance curve, dead zone, acceleration, pointer smoothing, click vs hold timing, player and ball speeds and overall tempo. Write the final tuning numbers into README Controls.
- Stats check: the owner's result showed 82% possession for their side but 8 passes against 38. Check possession, passes and shot counting are correct and meaningful (e.g. possession should not count dead-ball time or long solo dribbles oddly); fix if wrong and test it.
Tests: add tests for every behaviour above. Update e2e tests for changed controls.

RESEARCH NOTES: Read /tmp/research.md (fetched from the assets/feedback branch as above); numbers are guidance, cite them in comments where used.
