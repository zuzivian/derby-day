# Derby Day stream brief: perf

You are one of several parallel Claude Code sessions improving "Derby Day" (repo zuzivian/derby-day, private), a zero-dependency TypeScript browser football game: a club manager where you also play every match yourself with the mouse, in the spirit of the 2005-2016 browser game Power Soccer. 3D via vendored three.js r186 in vendor/three; a deterministic 60 Hz sim in src/sim (pure: seeded RNG, no Math.random/Date/DOM, all state in MatchState); 11 v 11 under the Laws of the Game; every match 2 x 3 minutes; replays are input logs re-simulated (src/meta/replay.ts); two-tab lockstep multiplayer (src/net). It deploys to Vercel from `main` (derby.natwong.dev). Read README.md and docs/ROADMAP.md first, then the code you own.

BRANCH AND PR: work on branch `feat/perf` (check it out; it may already exist on origin with work in progress — if so continue from it). First run `git fetch origin main && git merge origin/main` so you are on top of main. Commit as you go. When your work passes all checks, push the branch and open a DRAFT pull request against `main` titled "Match performance: no leak between matches, steady frame time, robust 3D", then keep its CI green (fix failures at the root cause; never skip or weaken a test). Do not merge your PR: a coordinator session merges PRs. If main moves while you work (another stream merged), merge origin/main into your branch, resolve conflicts keeping both sides' behaviour, re-run checks and push.

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
- perf (feat/perf, YOU): see YOUR WORKSTREAM below
- onboarding (feat/onboarding): onboarding.ts, tutorial.ts, drills.ts, UNLOCKS in src/meta/levels.ts, first-run routing in main.ts, src/client/coach.ts
The sim must stay deterministic and the determinism, replay and lockstep tests must keep passing (bump a replay/sim version where behaviour changes).

COMMITS: every commit message ends with exactly:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SwXgWnBxJDFASUuzjLYiWW

QUALITY BAR: do not stop at "it works". After building, red-team your own work: write scripted playtests and measurements for every feel claim, take screenshots for every visual claim at 1280x800 and 390x844, compare with the owner's words and screenshots, and iterate until you have nothing left to fix in your area. Put numbers and screenshot descriptions in the PR description. When done and CI is green, leave the PR as draft-ready (mark it ready for review) and stop.

YOUR WORKSTREAM: performance and robustness of the match screen, so the game holds up for thousands of players on ordinary laptops and phones, over many matches in one sitting. It comes from red-team round 1's performance lens. Read these first: `git show origin/assets/feedback:redteam/round1/perf.json` (11 findings with evidence, repro commands and suggested fixes) and `perf-verify.json` (the independent verification of the major, with corrected sizes and the root cause). The repro scripts are in `redteam/round1/perf-scripts/` and `perf-verify-scripts/` on the same branch; read their README. The findings were measured on main 623a5a1, and main has moved since (#15's phone layouts, #18's e2e harness, and #19 view batch 2, which is in flight). Before you fix each finding, re-measure it on current main and drop any that no longer reproduce.

Build, each with a test that fails before the fix and passes after:
1. MAJOR: the 3D match leak. Every 3D match leaves its whole renderer, scene, match DOM and closures alive. That is about 3.5 MB of JS heap, plus 10-20 MB of canvas backing store (the 2048x1386 grass canvas at high quality, the juice-fx canvas, about 35 sprite and texture canvases) and 14 listeners per match. RSS grows 35-40 MB per match at high quality, and nine matches in a row took the home heap from 9 to 33 MB. 2D is flat. The root cause, from perf-verify.json, is that three's module-level singletons keep a reference to the disposed renderer. Release them in Renderer3D.dispose(), and make sure matchView/replayView drop every listener, ResizeObserver and rAF they add. Add an e2e test that plays 4 short 3D matches back to back (use locator.waitFor, not page.waitForSelector, which pins the canvas), forces GC over CDP (HeapProfiler.collectGarbage), and asserts that the heap, the DOM node count, the JS listener count and the detached-canvas count (Runtime.queryObjects on HTMLCanvasElement) stay flat within a small tolerance. Run it under E2E_CPU_THROTTLE=4 as well, so CI timing doesn't flake it.
2. The first card of a match compiles a new shader mid-match: an 860 ms frame in SwiftShader, and a hitch on real GPUs. Make prepare() warm every program a match can use, including card sprites, the celebration and replay overlays. Test: count programs (renderer.info.programs) after prepare(), inject a yellow card and a goal, and assert that no new program appears.
3. WebGL context loss turns the pitch white while the match keeps running. On loss, pause with a calm "Restoring graphics…" note and resume on restore. If there is no restore within about 3 s, finish the match on the 2D renderer, without losing the result. Test it with WEBGL_lose_context.
4. Frame time. The 3D renderer costs about 16 ms of main-thread JS per frame at 4x throttle: draw p95 41 ms and 149-184 draw calls at high quality.
   - Take the cheap wins from perf.json: scene.matrixWorldAutoUpdate=false where Renderer3D already updates matrices; forceSinglePass or FrontSide on the overlay, wedge and net materials; merge static stadium meshes; slow or skip bone updates for far, off-screen players.
   - Add a simple CPU-time quality governor that steps quality down (crowd animation, shadows, pixel ratio) when the average draw time stays above budget, and never thrashes.
   - Report before and after numbers at 4x throttle: rAF avg/p95/p99, draw calls, long tasks over a full match.
5. Per-frame allocations, about 30-50 KB a frame. Reuse scratch objects (PlayerContext, CameraFocus, AimFrame, Vector3s) in the render loop, and remove the two-pass draws that make three rebuild program parameters every draw. Measure bytes per frame with the HeapProfiler sampling script before and after.
6. The HUD rewrites four text nodes and #pitch[data-camera] every frame, forcing a style and layout pass. Write them only when they change, like hud.ts's lastClock. Test it with a MutationObserver over 120 frames.
7. Match audio keeps running while paused and with the tab hidden (AudioContext 'running'; the crowd watchdog leaves gain at 0.02). Suspend the context on pause, hide and dispose, and resume it on play.
8. The cup shootout doesn't pause when the tab is hidden, so the kick is decided while you're away. Shift its timers by the hidden time, or restart the keeper window.
9. replayStore keeps every decoded replay of the session in memory. Cap the cache at what storage keeps (LRU).
10. The pitch's drawing buffer ignores devicePixelRatio changes (moving to a HiDPI screen, browser zoom) in both renderers. Re-arm a matchMedia resolution listener.
11. Landscape phone, 844x390: the pitch got 413x277 px, and the REPLAY tag overlapped the score bar. #15 may already have fixed this, so re-check it first with a screenshot.

Ownership: the view stream (feat/view, session busy with PR #19) owns src/client/r3d/*, hud.ts, hud.css, matchView.ts, renderer.ts and replayView.ts. In this workstream YOU own the performance and lifecycle code in those files: dispose paths, materials, the render loop, the governor and context loss. Keep your edits to matchView.ts small and additive, because #19 also edits it. When #19 merges, merge main and resolve conflicts keeping both sides' behaviour. You also own audio.ts suspend/resume, the shootout.ts visibility handling, and replayStore.ts.

Do not change the sim, and do not bump SIM_VERSION or REPLAY_VERSION. Your changes must not alter any match outcome; the determinism and replay tests prove that.
