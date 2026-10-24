# Derby Day stream brief: view

You are one of several parallel Claude Code sessions improving "Derby Day" (repo zuzivian/derby-day, private), a zero-dependency TypeScript browser football game: a club manager where you also play every match yourself with the mouse, in the spirit of the 2005-2016 browser game Power Soccer. 3D via vendored three.js r186 in vendor/three; a deterministic 60 Hz sim in src/sim (pure: seeded RNG, no Math.random/Date/DOM, all state in MatchState); 11 v 11 under the Laws of the Game; every match 2 x 3 minutes; replays are input logs re-simulated (src/meta/replay.ts); two-tab lockstep multiplayer (src/net). It deploys to Vercel from `main` (derby.natwong.dev). Read README.md and docs/ROADMAP.md first, then the code you own.

BRANCH AND PR: work on branch `feat/view` (check it out; it may already exist on origin with work in progress — if so continue from it). First run `git fetch origin main && git merge origin/main` so you are on top of main. Commit as you go. When your work passes all checks, push the branch and open a DRAFT pull request against `main` titled "Wider camera, power cone, set-piece long view and instant replays", then keep its CI green (fix failures at the root cause; never skip or weaken a test). Do not merge your PR: a coordinator session merges PRs in order (physics, tactics, view, ui, onboarding). If main moves while you work (another stream merged), merge origin/main into your branch, resolve conflicts keeping both sides' behaviour, re-run checks and push.

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

YOUR WORKSTREAM: 3D camera, aim feedback, set-piece views and instant replays. Owner asks 1, 7, 9, 10 and the camera/pointer side of 11.
- Ask 1 (too zoomed in): pull the broadcast camera back so the player sees much more of the pitch: roughly 45-60 m of pitch width around the action, enough to see passing options, with players still readable (see the owner's screenshot /tmp/match.webp and the Power Soccer references on the assets/feedback branch). Add zoom control: mouse wheel and +/- keys with sensible limits, remembered per browser (localStorage with try/catch).
- Ask 7 (power in the cone/arrows): the direction wedge/arrow must show the power of the pass, cross/loft or shot: length and/or fill proportional to power, colour bands (green sweet spot, amber, red over-hit), and live while charging; a plain click pass shows its pace too. Keep the bottom-right power bar in sync.
- Ask 9 (goal kick long view): when the human's team has a goal kick, or the human's keeper holds the ball, the camera eases to an elevated long view showing teammates up to and beyond halfway, then returns to the broadcast view after the kick. Consider the same for the human's free kicks in their own half.
- Ask 10 (replays for significant events): automatic instant replays after goals, yellow and red cards and key shots (saves from shots on target, woodwork, near misses within a few metres of the post). 4-7 s, broadcast-style replay cameras (low side, behind the goal), the REPLAY word in the HUD, skippable by click, Space or Esc, at most one per stoppage, and never during two-tab lockstep. The sim must be paused while a replay plays and resume exactly where it was. Use the input log the match already records (src/meta/replay.ts ReplayRecorder/ReplaySeeker) or a ring buffer of snapshots, whichever is cleaner; keep it deterministic and cheap.
- Visual polish visible in the owner's match screenshot: the crowd is high-frequency visual noise (random bright colour blocks); make the stands calmer and more readable (home-colour sections, lower contrast, darker towards the back, fewer random whites), keep ad boards legible, keep the HUD tidy (the "CAMERA: SIDE" chip can be smaller or appear only briefly when switched).
- Ask 11 (pointer side): make the world point under the mouse stable while the camera moves (no cursor drift), consider light smoothing, and apply the research notes on camera framing.
Take before/after screenshots at 1280x800 and 390x844 of: open play, a goal kick, a replay, and a charged pass/loft/shot, and compare critically with the owner's screenshots.

RESEARCH NOTES: Read /tmp/research.md (fetched from the assets/feedback branch as above); numbers are guidance, cite them in comments where used.
