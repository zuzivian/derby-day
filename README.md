# Derby Day

A browser football club manager where you also play the matches yourself, mouse-first. You run a generated club (squad, transfers, training, an Elo ladder) and play eleven-a-side matches in real time against the CPU, under the Laws of the Game: throw-ins, goal kicks, corners, offside, fouls, free kicks, penalties and cards.

This is a prototype. The plan for turning it into an online live-service game is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Play

```sh
bun run build      # writes dist/index.html, a single self-contained file
open dist/index.html
```

Or `bun run dev` to rebuild on save and serve on http://localhost:5173.

Install Bun with `curl -fsSL https://bun.sh/install | bash` (no sudo needed). There are no npm dependencies.

### Controls

Mouse is the main scheme: your player runs to the pointer, and **the pointer is also where every kick goes**. No sprint key: the further the pointer is from your player, the faster you run: nothing inside 0.6 m, a walk just outside, a jog (about 3.7 m/s) at 4 m, normal top speed at 8 m, a flat-out sprint from 11 m out (sprinting costs stamina; when the bar goes red you are winded and capped at a jog until it refills).

| | Mouse (recommended) | Keyboard |
|---|---|---|
| Run | Move the pointer. Distance sets speed: walk, jog (4 m), run (8 m), sprint (11 m+) | WASD or arrows, Shift to sprint |
| Pass (with the ball) | Left click: always a ground pass. Firm, to the feet of the teammate at or toward the pointer (or where he is running to); on empty grass it rolls out to the point | Space (to the teammate you are facing) |
| Lofted ball (with the ball) | Press and hold left: the charge shows from 0.3 s and is full at 0.9 s; release and it lands at the pointer. A longer hold goes higher and further (12 m range at the shortest, 40 m full) | Hold C, release |
| Shoot (with the ball) | Right click: a medium shot at the pointer. Hold right for power, release to strike | Hold F, release |
| First time (a pass on its way to you) | Click before it arrives: left plays it on first time (to the teammate you clicked), right shoots first time | Space |
| Keeper (with the ball) | He is yours: left click rolls or throws it out, hold left throws it high, right click punts it (30 m to 62 m with power). He may walk about his area with it; after six seconds (Law 12, a countdown shows) he plays it himself. Goal kicks are yours too | Space, hold C, hold F |
| Switch player (no ball) | Left click a teammate (pointer within 1.5 m of him); left click elsewhere to take the nearest teammate in that direction (40 degree cone), or stay if nobody is | E |
| Tackle (no ball) | Right click: a standing tackle toward the pointer, or a slide when it is more than 2.4 m away (slides go up to 6 m, reach 3 m, and leave you on the floor) | Space |
| Pause | Esc or P | Esc or P |

**Click or hold.** Any left press shorter than 300 ms is a click and a click is always a ground pass, never a lofted ball (360 ms on touch screens and pens, whose taps are slower). Real clicks last about 60-260 ms; the old 200 ms threshold turned slow clicks and trackpad taps into lofts. The pass goes on release, aimed where the button went down unless the pointer wandered more than 8 px meanwhile. A test clicks for 60-260 ms through the sim and gets a ground pass every time.

**Pass assist.** A teammate is the receiver when the pointer is within 1.5 m of him (or of where he is running to), plus 0.1 m per metre of pass up to 4 m (2.5 m at 10 m: the broadcast camera makes depth hard to judge), or when the pointer is on the line to him, within 12 degrees and 0.6 to 1.2 times his distance. Then the ball goes to his feet, played to arrive at 7 m/s for a short pass rising to 12 m/s from 12.5 m: a 10 m pass leaves the foot at about 13 m/s and gets there in 0.85 s. He steps up to meet it. Aim at empty grass (or well beyond a runner) and the ball goes exactly there, slowing to 3.5 m/s at the point: through balls are passes into space. A human's passes and lofted balls scatter about 40% as much as a CPU's.

**After a pass.** Control moves to the receiver as he gets it. If you have not moved the mouse since, he holds still with the ball (or, without it, plays like the CPU would) instead of running back to where the pointer was left; move the mouse and he is yours again. The pointer that steers is smoothed (a One Euro filter: calm when still, no lag when moving fast); kicks use the exact point. A scripted human playing quick click passes to the nearest open teammate completes about 80% of them, about three passes a possession (it completed 29% on the old controls).

**The ball and bodies.** The ball meets players by height: below 0.5 m it is at their feet (controlled if it isn't too hot for them, else it comes off the leg), up to 1.5 m it is taken on the thigh or chest (1.9 m from a teammate) and drops to the feet, up to 2.5 m it can be headed (clearances, and at goal in the box, aimed with the pointer when it is you), and anything that hits a body below 1.85 m bounces off it. Nothing passes through a player. A defender stretching for a ball that isn't at his body may miss it. The keeper in his area has hands. He reaches about 0.55-0.9 m around him standing, by quality, and up to 2.6 m high. He reacts 0.13-0.28 s after the ball last changed course, then dives late, timed to land as it arrives, across to where he reads it will pass; a better keeper dives further and faster and misreads it less. Down after a dive, his hands and body still lie along the line he went. He catches what isn't too hot (more easily into his body, less at full stretch, lying, or above 2 m). Otherwise he palms it back out (a poor keeper often into the six-yard box), tips it round the post or over the bar, never back between the posts. While he holds the ball nobody may barge him: opponents are kept 1.5 m away.

On screen (3D view): a light ring with a dark outline sits on the grass under the pointer. With the ball, a wedge runs from your player toward where a click would pass, with a white reticle (circle and four ticks) at that spot and a ring round the receiver if there is one. The wedge is also the power gauge: it is lit from your player outward as far as the kick's power, in green (the sweet spot), amber (a firm pass, a shot past the sweet spot, or a loft that would fall short of the pointer) or red (over-hit), with the unlit rest as a faint white track; a plain click shows the pace it would pass at, and the power bar bottom right shows the same numbers (dimmer until you charge; the tick is where the sweet spot ends). While a left hold charges, dots also trace the lofted ball's real flight and a ring marks where it comes down. Without the ball, a yellow ring on a teammate shows who a left click would switch to. Your player has an orange triangle and his name overhead and a yellow ring on the ground; the small orange bars over your team are stamina (red when winded). A hand-picked player stays yours for 3 s before the auto-switch (to whoever is nearest the ball) may take him back; whoever gets the ball always becomes yours, your keeper included.

Phones: drag to run toward your finger (further is faster), tap **Pass** to pass, hold it to loft (the hold starts at 0.36 s); **Shoot** shoots, and without the ball it tackles; tap a player on the pitch to pick him. Replays recorded before this control scheme (format 1 codes) can't be played back and are refused politely. Format 4 codes carry the click's aim point and whether the pointer moved; format 3 codes still open but were recorded on an earlier engine, so the viewer says so. Replays from the six-a-side game (format 2) still open, padded to eleven a side, but play back a different match, and the viewer says it was recorded on a different version.

## The match: eleven-a-side under the Laws

A full-size pitch, 105 × 68 m, with the real markings (penalty area 16.5 m, goal area 5.5 m, penalty mark 11 m, centre circle and arcs 9.15 m, corner arcs) and goals 7.32 m by 2.44 m. There are no boards: the ball goes out of play. The constants are in `src/sim/constants.ts`, the Laws in `src/sim/rules.ts`.

- **Formations.** Your club picks 4-4-2 or 4-3-3 on the Squad screen (the lineup board re-picks the XI for the new slots); ladder clubs have their own. Slots carry finer roles: full-back and centre-back, holding, central and wide midfielder, winger and striker. The CPU plays positionally: a back four that holds a line and steps up to play offside, the ball-side full-back overlapping while the far one tucks in, a holding midfielder screening the centre-backs, wingers wide and strikers on the shoulder of the last defender making runs in behind.
- **Restarts (Laws 8, 15, 16, 17).** Kick-off, throw-in (from the hands at the touchline, can't score directly), goal kick (from the goal area, opponents outside the penalty area) and corner (from the arc, can score directly). Play stops, the ball is placed, everyone takes up a legal position (opponents 9.15 m away at free kicks and corners, 2 m at a throw-in), a taker walks up and plays it. When your side has the restart, the player taking it is yours: pass, loft or shoot as usual (a shot at a throw-in is a long throw, at a goal kick a long kick). Goal kicks are taken by your keeper, so they are yours too. Do nothing for five seconds and the CPU takes it for you. The clock keeps running through dead balls, as in a real match.
- **Offside (Law 11).** Judged when a teammate plays the ball: in the opponents' half, nearer their goal line than both the ball and the second-last opponent (level is onside). It is an offence only when that player then plays the ball; a deliberate play by a defender, or an onside teammate getting it first, wipes it. No offside from a throw-in, goal kick or corner. An indirect free kick to the defenders where he touched it; the assistant's flag is an event.
- **Fouls and misconduct (Law 12).** A challenge that misses the ball, comes from behind, is late (the ball has gone) or goes in at full speed can be a foul: careless, reckless or (rarely) excessive. A direct free kick, or a penalty if it was inside the offender's own penalty area. The referee may play **advantage** when the fouled side keeps a good attack going (and brings the free kick back if they lose the ball within two seconds). Cards: yellow for a reckless challenge or for stopping a promising attack; red for excessive force or denying an obvious goal-scoring opportunity (in the penalty area a genuine attempt at the ball is a yellow instead); a second yellow is a red. A player sent off leaves the pitch and his side plays on a man short (a keeper is replaced in goal by an outfielder). CPU players on a yellow tackle more carefully.
- **Free kicks and penalties.** Direct or indirect. Near goal the defenders build a wall 9.15 m away and the taker may try to dip one over it; wide ones are crossed into the box, with the defence marking. A penalty is taker against keeper on his line; the keeper commits to a side as it's struck, everyone else waits outside the area and the arc.
- **The referee** runs the diagonal, 10 to 20 m from the ball. Whether a foul is given, and which card, are seeded rolls weighted by how bad the challenge was and how far away he is, so matches and replays stay deterministic.

Every whistle is in `MatchState.events` with its tick, match clock, team and player: goals, fouls, cards, sendings-off, offsides, restarts awarded and taken, advantage, half-time and full-time. `s.restart`, `s.referee`, `s.cards` and each player's `yellow` / `sentOff` describe the state for renderers.

Stats (`s.stats`): possession counts live-ball ticks only (no dead balls), to the side that last controlled the ball, including while it travels between teammates; a long dribble is possession too. A pass counts when a teammate takes it, whether it went along the ground, in the air, from a throw-in or from the keeper; `passAttempts` counts every one played. A shot is a deliberate strike at goal from within 35 m; a lofted ball or header only counts when it would cross the line near the frame. The result screen's old "82% possession, 8 passes" came from lofted passes (which slow clicks often became) never counting as passes, and from the ball in flight between teammates counting for nobody, so a side that dribbles looked far more dominant than one that passes.

### The 3D view

Matches, hot-seat, linked matches and the replay viewer draw the match in 3D with three.js (r186, vendored in `vendor/three/`, no npm). It is an afternoon match in a small stadium: mown grass, markings built from geometry, goals whose nets bulge and ripple, ad boards, stands with an instanced crowd waving flags in the home colours (the away end in theirs), orange floodlight pylons, and a car park, trees and a low town outside.

- **Players** are procedural low-poly footballers: each is one skinned mesh (a 14-bone skeleton, every primitive baked into one geometry with vertex colours, so a player is one draw call) in the team's shirt, shorts and socks, with a number on the back, a keeper in a contrasting kit (the away side changes to its swapped or a neutral kit when the shirts would be hard to tell apart under normal, protan or deutan colour vision: `src/client/kits.ts`), and varied skin tones, hair colours and styles, height and build. Animation is code-driven from the sim: idle, walk, jog and sprint blended by speed with arm swing and a stride that grows with pace, backpedal and side-step; pass, lofted ball and shot (striking foot picked by direction), standing tackle and slide tackle, being knocked down, headers and jumps for high balls, keeper set stance, dive (left or right, by height), catch and holding the ball, throw-in hold and throw, goal celebrations (arm punched high, aeroplane, knee slide), teammates cheering and opponents with hands on heads. `src/client/r3d/player3d.ts` exports a `Player3D` (`update(dt, simPlayer, events, ctx)`), so a rigged glTF character could replace the procedural one.
- **Camera:** an elevated broadcast view from the long side (33 degrees down, about 48 m of pitch across at the ball on a desktop window, about 45 m on a phone in portrait) that follows the ball through a small dead zone. The pointer's spot on the grass is taken when you move the mouse and kept while it is still, so your player runs to that spot and stops there even as the camera follows him, and widens a little when the ball is in the air; a lower, closer shot for goal celebrations. **Zoom** with the mouse wheel over the pitch (down shows more pitch; zoom follows how far you scroll, so a trackpad zooms smoothly), **+** / **−** (**0** resets), or on a touch screen a pinch or the **−** / **+** buttons, from about 29 to 69 m across; it is remembered in this browser (`localStorage['derby-zoom']`). When your side has a goal kick or a free kick in its own half, or your keeper holds the ball, the camera eases up and out to a long view framed to keep the ball, both touchlines and 20 m beyond halfway in shot on any screen shape, and stays up for as long as the restart waits for you, and eases back about a second after the kick. The small **Cam** chip (top right) or **V** switches to an end-to-end view from behind your own goal, looking up the pitch at the goal you attack (WASD then follows the screen: W is always toward their goal). Hot-seat always uses the side view. With `prefers-reduced-motion` the camera moves more slowly, does not swoop in for celebrations, and the screen never shakes.
- **HUD:** crests, codes and score top left with the match clock (MM:SS of 90 minutes) under it; Esc / Menu and the mode top right; big words for GOAL, HALF TIME, FULL TIME, REPLAY (and OFFSIDE, FOUL when the sim reports them); a radar bottom centre (home dots, away triangles that point where they face); the shot power bar bottom right.
- **Instant replays:** after a goal, a card, a save from a shot on target, a shot off the woodwork or a near miss (within 0.5 m of a post or the bar), the next stoppage (or your keeper holding the ball) shows a 4 to 7 s replay: a low side camera, then (except for cards) from behind the goal for the half-speed last 1.5 s, with REPLAY at the top. The live match is held while it plays and resumes on the tick it stopped at. Click, Space, Enter or Esc skips it (in hot-seat, where Space and Enter pass, only a click or Esc); the radar and clock follow the replay; at most one per stoppage, other than goals and red cards at most one every 90 s of play, never in a two-tab match, and the pause menu turns them off (`localStorage['derby-instant-replays']`). The last 12 s of the match are kept as half-second snapshots plus the inputs, and a replay re-simulates from the snapshot (`src/client/highlights.ts`). With `prefers-reduced-motion` they are off until turned on in the pause menu.
- The renderer reads the sim only. Pitch, goal and team size come from `src/sim/constants.ts` and the state, so a bigger 11-a-side pitch works; if the state has `restart` (a throw-in taker holds the ball overhead), `referee` (drawn in black) or card events (the referee holds the card up, the card shows over the player), they are drawn.
- **Fallback and quality:** without WebGL2 the old 2D canvas renderer is used. Software rasterisers (SwiftShader, llvmpipe) get a low-quality mode (no shadow maps, blob shadows, a thinner crowd, no town, 0.8 resolution). `?renderer=2d|3d` or `localStorage['derby-renderer']` forces a renderer, `?quality=low|high` or `localStorage['derby-quality']` the quality. The training ground tutorial still uses the 2D view.

## Playing the CPU

Every match is the same length: 2 × 3 minutes (`HALF_SECONDS` in `src/sim/constants.ts`). There is no length setting; `prefs.halfSeconds` in `src/client/store.ts` is only a hidden override the e2e tests use for short matches.

- **Ranked** (Home, **Kick off**): one match against a ladder club near your Elo. Moves Elo.
- **Practice** (Home, Practice card): Easy, Normal or Hard CPU. Nothing recorded but a training session.
- **Cup** (Competitions tab): 8-club knockout, you plus the seven ladder clubs nearest your Elo, seeded 1v8, 4v5, 2v7, 3v6. Quarter-final, semi-final, final; a draw you play goes to a live penalty shootout (best of five, then sudden death): as taker, aim with the mouse, hold the left button for power and release (too hard skies it, corners are riskier); as keeper, read the run-up and click left, middle or right to dive. Arrow keys and Space work too, and leaving counts as a loss. Ties between two CPU clubs use a seeded roll weighted by shooting and goalkeeping. Prize money for every round reached; a win goes in the trophy cabinet.
- **League** (Competitions tab): the same 8 clubs, single round robin over 7 matchdays, 3/1/0 points, then goal difference, then goals scored. Prize money by finishing place; the top two are "promoted".

You play your own cup ties and league fixtures live. The other matches in the round are played by the real headless sim at 60 s a half (about 130 ms each), so results follow the squads. Competition matches pay money, training and player development, but **do not change ladder Elo** or the ladder record. Forfeiting one counts as 0–3.

CPU difficulty is `TeamSetup.aiSkill` (0..1). It sets reaction time, decision noise, execution error and how well the team defends (marking zone, interceptions, a sweeper, the keeper's sweeping); see the header of `src/sim/ai.ts`.

Every finished match leaves a replay: the match options plus the per-tick input log (run-length and delta encoded, cursor to 1 cm, then compressed with a small adaptive range coder, `src/meta/pack.ts`), which the deterministic sim re-runs exactly. A full match is a code of about 45-70K characters. **Watch goals** on the result dialog plays each goal's last six seconds (½× slow-mo, previous/next goal, scrub bar; Space, arrows and Esc work). The last five replays are kept in this browser under **Recent replays** on the Club tab (fewer only if they are unusually long), and **Copy replay code** / **Paste replay code** share one as an `OVR1.…` string. Scrubbing a whole match is held at the part already prepared while the rest loads. Code is in `src/meta/replay.ts` (pure) and `src/client/replayView.ts`.

A first visit is one welcome with one big **Kick off** (a small "I've played before" skips it): no forms, no controls quiz. You are playing your first match, a friendly against a generated easy club, within one click. Light coach tips teach inside it (`src/client/coach.ts`): how to run (the pointer distance), the first time you have the ball (click to pass), near goal (right click to shoot), losing the ball (right click to tackle) and your first restart. Each tip shows once, ever, is dismissible, fades by itself, never pauses play and is announced to screen readers. Afterwards a short celebration of the result and the first XP (a "first match" bonus makes level 2 certain), then an optional, skippable step to name the club and pick colours. The training-ground drills are the optional **Practice skills** button in Club news (Club tab, unlocked at level 3). If you leave or reload the first match the welcome comes back with the same opponent; the first match counts once it is played to the end, not a gate; they earn their one-time XP there. Players who already had a save skip all of this, and see no tips or marks.

## Home

The first screen does one job. The hero is the next ranked match against the CPU: both crests, Elo numbers, your last five results as W/D/L chips (and a small Elo sparkline once there is history), a win-chance gauge and one big **Kick off**. Under it sit the play-mode cards: **vs Player**, **Practice** (pick the CPU difficulty, each button starts a match) and **Cup** and **League**, shown with a padlock and their level until they open. The strip at the top holds the club, its level and XP bar, and gains training sessions (pips), money and the ladder position as those features unlock. News, replays, the club level panel, the tutorial and reset are on the **Club** tab. Code: `src/client/home.ts`; the strip is `statusStrip` in `src/client/ui.ts`.

## Club levels

The club earns experience and opens up as it levels (1 to 99; clearing level L takes 100 × L XP). A new club has Home with one Kick off and nothing else (no tabs). The menus are revealed one step per level: level 2 adds the Squad, vs Player (Local 2P and Link two tabs) and Easy practice; level 3 Ranked matches, the Club tab, replays and Practice skills; 4 Training and Practice Normal; 5 the Cup and Practice Hard; 6 Transfers; 7 the Ladder; 8 the League; 10 the season calendar and academy; then small perks up to 99. Until level 3, Kick off is a warm-up friendly against a gentle generated club (no Elo, still XP), and the Elo win-chance gauge is hidden for the first three ranked matches. Each newly revealed tab gets a spotlight and a small card once (`pendingMark` in `src/client/coach.ts`), after the level-up dialog; opening the tab counts as seeing it. A save from before this table (`unlocksV` missing) opens each feature at the earlier of its old and new level, so nothing it was working toward moves away. Matches pay XP (win 120, draw 80, loss 50, +10 a goal, +20 a clean sheet; practice 30 to 60), so do training sessions (+5), cup and league finishes and first-time milestones. Forfeits pay nothing. The header shows the level and XP bar; the Club level panel on the Club tab lists every unlock. Older saves get XP back from their match history and keep anything they already use. The full tables and pacing are under "Club levels" in the roadmap; the rules are in `src/meta/levels.ts`.

## Two players

Both are on Home in the **vs Player** card (**One screen** is Local 2P, **Two tabs** is Link two tabs, and **Online** when a relay is configured), open from club level 2. Each human steers one player of their side (yellow marker for home, cyan for away); the CPU runs the rest of both teams. Nothing is recorded: no Elo, money, training or replay.

- **Local 2P:** hot-seat on one keyboard, your club against a ladder club you pick.

  | | Player 1 (home, yellow) | Player 2 (away, cyan) |
  |---|---|---|
  | Move | W A S D, or the mouse once you move it over the pitch (further = faster) | Arrow keys |
  | Pass / tackle | Space, or left click / right click | Enter or `/` |
  | Lofted ball | Hold C, release (or hold left button) | Hold `M`, release |
  | Shoot | Hold F, release (or right button) | Hold `.` (period), release |
  | Switch player | E, or left click a player | `,` (comma) |
  | Sprint | Left Shift (the mouse sprints by distance) | Right Shift |
  | Pause | Esc or P | Esc or P |

- **Link two tabs:** open `dist/index.html` in two tabs or windows of the same browser. Your club can only be played in one tab (the second shows "Derby Day is open in another tab"), so in the second tab choose **Use as a guest tab**: it plays Link matches but saves nothing. In one, **Host a match** and read out the 4-letter code; in the other, type it and **Join**. Each tab plays its own side with the normal controls. The tabs run the same match in deterministic lockstep over `BroadcastChannel` (no server) with a 4-tick (67 ms) input delay, exchange only inputs, and compare a state hash every second; a mismatch stops both with "Desync at tick N". Sandboxed viewers (such as some artifact hosts) block tabs from talking; the lobby says so. See "Multiplayer spike" in the roadmap for what this proves.
- **Online:** two browsers anywhere, over a small WebSocket relay (`server/`). **Create a match** shows a 6-letter code and an invite link (`https://derby.natwong.dev/?join=CODE`); the friend opens the link and is in. Same lockstep match as two tabs. A dropped connection reconnects and resumes the seat; while the opponent is gone the match pauses with "Opponent disconnected, waiting 20 s", then ends as an abandoned friendly. The button only appears when the build has a relay URL (`DERBY_RELAY_URL`, empty by default) or a local page has `?relay=ws://...` (ignored on the real site). Run one locally with `bun server/bun.ts` and open `dist/index.html?relay=ws://localhost:8787/ws`. Architecture, limits, threat model and deploy steps: [docs/ONLINE.md](docs/ONLINE.md). To deploy the relay on Fly.io, fill in the two placeholders in `fly.toml` and follow [Deploy on Fly.io](docs/ONLINE.md#deploy-on-flyio).

## Saves, backups and going live

The club lives in this browser's localStorage. One tab owns it at a time; each save keeps the previous good one as a backup and a damaged save is restored from it; a full disk shows a message instead of losing progress. **Club → Back up or restore** exports the club as a file or a copyable code and imports it back after a preview. Crashes show a calm "Something went wrong" panel, the page installs as an app and opens offline after one visit, and telemetry and crash reporting are compiled out unless `DERBY_TELEMETRY_URL` / `DERBY_ERROR_URL` are set at build time. How deploys and rollbacks work, what is collected (nothing by default), and the launch checklist are in [docs/OPS.md](docs/OPS.md).

## Code layout

```
src/sim/      Deterministic match engine. Pure TS, no DOM, fixed 60 Hz, seeded RNG.
              step(state, input) is the only way time moves.
src/meta/     Club layer: name generators, players and attributes, Elo, market, training, ladder.
src/net/      Netcode, pure TS: lockstep with input delay and desync detection, a two-method
              Transport, BroadcastChannel, WebSocket (relay, reconnect) and seeded in-memory (latency,
              jitter, loss) transports, the relay protocol, disconnect detection, relay config.
src/client/   Browser: match renderers (renderer.ts picks 3D or 2D; r3d/ is the three.js view, render.ts
              the 2D canvas), HUD, input, match loop, management screens, local save. boot.ts is the
              entry (crash handler, one-tab guard, then main.ts); store.ts, backup.ts, settings.ts,
              tabguard.ts, errors.ts, telemetry.ts and pwa.ts keep the live site safe (docs/OPS.md).
static/       Copied into dist/ as they are: icons, manifest, robots.txt, 404, share image, sw.js.
server/       The online relay: relay-core.ts (pure room/seat state machine with every limit),
              bun.ts (Bun.serve adapter, GET /health), Dockerfile, cloudflare.ts (untested),
              verify.ts (re-simulate a replay code and check its claims). See docs/ONLINE.md.
vendor/three/ three.js r186 (MIT), bundled into the build.
scripts/      build.ts (bundle and inline into one HTML file), size-budget.ts (page size guard),
              perf-probe.cjs (first paint and time-to-interactive at 4x CPU), make-assets.cjs
              (icons and share image), balance.ts (headless CPU matches),
              ai-probe.ts (equal squads, different CPU skill), net-probe.ts (lockstep stalls by
              input delay and simulated latency).
tests/        bun test: determinism, plausible matches, Elo maths, transfers and training rules.
tests/e2e/    Browser tests (Playwright, no framework): boot, tabs, layout, transfers, matches.
.github/      CI: typecheck, unit tests, build, balance guard, e2e.
```

## Checks

```sh
bun run check      # typecheck + tests + build + page size budget
bun run size       # fails if dist/index.html is over its size budget (scripts/size-budget.ts)
bun run balance 50 # 50 CPU-vs-CPU eleven-a-side matches at full speed: goals, shots, fouls, cards, corners, offsides, upsets
bun run balance 30 --assert  # same, but exits non-zero outside the sane bands (see scripts/balance.ts: goals 1.5-5, fouls 5-25, ...)
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
