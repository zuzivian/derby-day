# Derby Day roadmap: from prototype to live service

Working title **Derby Day**: the match against your local rival that everyone circles on the calendar, which is the feeling a ranked match between two people's clubs should have. The old game that inspired this is not named anywhere in the product. Clubs, players, nations and the currency (club florins, ƒ) are all generated.

## The bet

Browser football games split into two camps that don't overlap:

| Camp | Examples | You control | Missing |
|---|---|---|---|
| Manager sims | Hattrick, Trophy Manager, Football Manager | Squad, tactics, money | You never touch the ball |
| Real-time physics | Haxball, Rocket League (cars) | One player, live | No club to build, nothing persists |

The niche is the middle: **your club, your squad, and you on the pitch**, with the mouse, in a tab, against another person, for Elo. Short matches (4–8 minutes) make it a lunch-break game.

The two things most likely to kill it:

1. **Feel.** If steering a player with the mouse isn't fun against the CPU, multiplayer won't save it.
2. **Liquidity.** A real-time ranked game with 40 concurrent players has empty queues and long waits. Most indie multiplayer games die here, not on tech.

So the roadmap tests feel before building netcode, and plans for low concurrency from day one.

## What the prototype already proves (Phase 0, done)

As of 2026-10-23. Everything below runs in one 240 KB HTML file with no dependencies, and CI (typecheck, ~175 unit tests, a balance guard, ~26 browser tests) runs on every push.

**Engine**
- **Eleven-a-side under the Laws.** A 105 × 68 m pitch with real markings, nine formations and five mentalities from Park the bus to High press, throw-ins, goal kicks, corners, offside (judged when the ball is played, an offence on involvement), fouls with advantage, direct and indirect free kicks with walls, live penalties, yellow and red cards (DOGSO, second yellow, a man short), and a referee who follows play. All seeded and deterministic (`src/sim/rules.ts`).
- **Deterministic sim.** `src/sim` is pure TypeScript: fixed 60 Hz tick, seeded RNG, no DOM, no clock, no `Math.random`, `sqrt` instead of `Math.hypot`. The same seed plus the same input log reproduces a match exactly (tested). That one property unlocks server authority, replays, rollback netcode and bot-driven balance testing.
- **Inputs are tiny.** A tick of human input is a cursor point plus a few flags. A recorded 2×2-minute match with constant mouse movement is about 39 KB as a replay code; an idle one is 1–3 KB.
- **Replays prove it.** Every match is recorded as its input log and re-simulated for goal highlights, with seeking (keyframes every 600 ticks, warm seeks ~3 ms) and a hash check that warns if the engine changed since recording.
- **Headless balance.** `bun run balance` plays CPU-vs-CPU matches at about 900× real time (a 2 × 3-minute eleven-a-side match in about 0.4 s). 30 matches average about 2.4 goals, 12 shots, 9 fouls, 2.3 yellows (a red every seven or eight matches), 2 corners and 1 offside; the higher-Elo club wins about twice as often as it loses.

**Playing**
- **Mouse-first control.** Your player runs to the pointer; pointer distance sets speed (walk to stamina-costing sprint, no key); left click passes to the point under the pointer, hold left lofts it there, right click shoots (hold for power); without the ball left click picks a player and right click tackles or slides. The ball has height, bounces, and can clear the bar. Full keyboard play works too.
- **A real CPU.** Team plans with interception prediction, goal-side marking, support runs, through balls, chips, sprinting and a keeper that narrows angles and sweeps. Difficulty is measured: identical squads at skill 0.85 beat 0.25 about 80% of the time.
- **Sound and feel.** Synthesised kicks, whistles, net and crowd (no audio files), goal shake and confetti, all reduced-motion aware.

**The club**
- **Loop.** Generated squad with attributes (1–99) that change speed, passing error, shot error, tackle odds and keeper reach; transfers, training sessions, a 16-club Elo ladder with the World Football Elo goal-difference multiplier, prize money.
- **Competitions.** An 8-club cup (seeded bracket, live penalty shootout when your tie is drawn) and an 8-club league season, neither touching ladder Elo. Forfeits pay nothing, so they can't be farmed.
- **Time passes.** A 10-match season calendar: ageing curves, retirements from 34, an academy intake with scouting fog on potential, CPU clubs that rise and fall, and a season review.
- **Club levels.** XP from matches, training and milestones; features unlock from level 1 to 12 and small perks run to 99 (see "Club levels" below).
- **Original world.** Ten fictional name styles and nations, blocklists against famous real players and clubs.

**First run and access**
- Gradual onboarding: a single welcome with one Kick off into a real first match (coach tips taught in play: running, passing, shooting, tackling, restarts), a celebration with the first XP, an optional club naming step, then menus revealed level by level. The training-ground drills are an optional Practice skills entry from level 3.
- WCAG 2.1 AA pass: skip link, ARIA tabs, focus restored after every render, live announcements for goals and results, dialogs with focus traps, contrast fixed in both themes, team markers that don't rely on colour alone.

Known gaps: saves live in one browser only (closing a tab mid-match is a free abort; two tabs can overwrite each other); no substitutions, no handball, holding or pushing offences, no VAR; corners come up less often than in a real 90 minutes (about 2 a match); the CPU's middle difficulty steps are uneven; sounds are untested by ear; no real screen-reader pass yet.

## Phase 1: Feel lab (2–4 weeks part-time)

Goal: people choose to play a second match against the CPU.

- Put the build on a URL, recruit 10–20 testers, and watch 5 of them play without help.
- Instrument: matches started vs. finished, second-session rate, control mode used (mouse vs. keys), goals per match, time to first goal.
- Tune the controls: arrival radius, acceleration, first-touch, pass auto-target cone, shot charge curve. Add one-twos, through balls (double-click?), and a sprint with stamina cost.
- ~~Decide the format~~: decided, eleven-a-side under the Laws, 2 × 3 minutes. Watch whether one human among 22 gets enough touches; more set pieces under the human's control (free kicks, corners) are the cheap lever.
- Replays from the input log: cheap, because the sim is deterministic. Good for bug reports and for sharing goals.
- Move the renderer to PixiJS (WebGPU with WebGL fallback) only if Canvas 2D becomes the bottleneck. It isn't yet.

**Exit criteria:** ≥40% of testers start a second session within a week; the median tester scores in their first three matches; no control complaint shows up in more than a quarter of feedback.

## Phase 2: Accounts and a server-owned club (3–5 weeks)

Goal: a club that lives on a server, so you can't edit your budget in DevTools.

- Auth with passkeys plus Google/Apple sign-in. No passwords to store.
- Postgres (Neon or Supabase) as the source of truth for clubs, players, transactions, and match results. Every money or attribute change is a row in a ledger, never a client-sent number.
- API: the `src/meta` functions already take data in and return data out, so they move behind endpoints mostly unchanged.
- Match results for CPU games get verified by re-simulating the input log on the server, which works because of determinism.
- Moderation for user-chosen club names (blocklist plus report button) once custom names exist.

**Exit criteria:** wiping local storage loses nothing; the server rejects a tampered result.

## Phase 3: Real-time multiplayer (6–10 weeks, the hard part)

Goal: two people, two browsers, one fair match.

- **Authority:** a server runs the same `src/sim` code and owns the truth. Clients send inputs, never positions.
- **Netcode choice.** For 1v1 with a deterministic sim, **rollback** (GGPO-style) feels best: predict the opponent's input, rewind and replay when the real one arrives. The simpler alternative is client-side prediction for your own player plus interpolation for everyone else. Start with prediction plus interpolation (2–3 weeks), and move to rollback if testers feel the lag.
- **Determinism across browsers.** JS floating-point arithmetic is IEEE-754 everywhere, but `Math.sin`, `Math.cos` and `Math.hypot` can differ between engines. Rollback needs bit-identical results on both ends, so either replace transcendental calls with lookup tables or fixed-point maths, or compile the sim to WASM (Rust or AssemblyScript). Write a cross-browser determinism test before choosing.
- **Transport:** WebSocket first. Add WebTransport (unreliable datagrams over HTTP/3) where the browser supports it, keeping the WebSocket fallback.
- **Hosting:** regional game servers near players (Fly.io, or a game-server host such as Hathora or Edgegap). Lobby and matchmaking state can live in Redis or Cloudflare Durable Objects; the 60 Hz sim itself should run on a normal server process.
- **Matchmaking:** by rating and ping region. Swap Elo for Glicko-2 under the hood (it handles uncertainty for new and returning players) while still showing a single number.
- **Low-liquidity design** (do this before launch, not after):
  - Friendlies by invite link: no queue needed.
  - Scheduled "match nights" so the few players online overlap.
  - When the queue is empty, offer a CPU match that still counts for a separate CPU ladder.
  - Async challenges: your club's CPU, playing with your squad, defends your ladder spot while you're offline.

**Exit criteria:** two players on different continents finish a match with no desync; P95 input-to-screen latency under 120 ms within a region; a disconnect pauses for 20 s and then forfeits cleanly.

### Multiplayer spike (October 2026)

Two humans can now play one match, in two ways, from the **vs Player** card on Home (open from club level 1):

- **Local 2P:** hot-seat on one keyboard against a ladder club you pick. Player 1 has W A S D, Space, F, E and Left Shift (or the mouse); player 2 has the arrows, Enter or `/`, `.`, `,` and Right Shift. No Elo, no rewards.
- **Link two tabs:** two tabs of the same browser play each other over `BroadcastChannel`, with no server. One tab hosts and shows a 4-letter room code; the other joins with it. The host sends the seed and both team setups, both tabs build the same `MatchState`, and from then on only inputs cross between them.

How it works: `MatchState` has per-team control (`humans`, `controlled`), and `step(s, [home, away])` takes an input per team (a single input still means "the one human", so replays and every old caller are unchanged and CPU-vs-CPU results are bit-identical to before). `src/net/lockstep.ts` is deterministic lockstep with input delay: each tab samples its input for tick t + D and sends it straight away; tick t is only simulated when both inputs for t are known, otherwise the tab stalls and shows "Waiting for opponent". Every input message re-sends whatever the peer hasn't acknowledged, so reordering and loss are harmless. Every 60 ticks, and at full-time, each side sends a 32-bit hash of the state (`fingerprint()` plus the RNG position); a mismatch stops both tabs with "Desync at tick N". The network sits behind a two-method `Transport` (`send`, `onMessage`), so a WebSocket or WebTransport relay can replace `BroadcastChannel` without touching the lockstep code.

**What is now proven**

- Lockstep determinism between two running instances of the same engine: unit tests drive two peers over a seeded in-memory link with 0–140 ms jitter, reordering and 10% packet loss, and both end bit-identical to each other and to an offline replay of the same input log (`tests/lockstep.test.ts`). Corrupting one side by half a metre is caught at the next 60-tick check on both sides.
- The browser path end to end: two Chromium tabs host, join, play a full 2 × 5 s match with scripted mouse and keyboard input and finish on the same tick, score and state hash (`tests/e2e/lockstep.e2e.cjs`), with every one of the 14 hash checks matching.
- Input-delay numbers. The default is **D = 4 ticks (67 ms of added input lag)**. Across tabs, `BroadcastChannel` round trips measured 2–6 ms during play (including main-thread scheduling), the tabs never drifted more than 3 ticks apart, and neither tab waited at all over the match. `bun run scripts/net-probe.ts` simulates other links (share of time the worse peer waits, 30 s of play):

  | One-way latency | D=2 (33 ms) | D=3 (50 ms) | D=4 (67 ms) | D=5 (83 ms) | D=6 (100 ms) | D=8 (133 ms) |
  |---|---|---|---|---|---|---|
  | 0–4 ms (tabs) | 0% | 0% | 0% | 0% | 0% | 0% |
  | 10–25 ms (same city) | 0% | 0% | 0% | 0% | 0% | 0% |
  | 25–45 ms (same region) | 12% | 0% | 0% | 0% | 0% | 0% |
  | 40–70 ms (cross-country) | 34% | 15% | 1% | 0% | 0% | 0% |
  | 80–120 ms (intercontinental) | 58% | 45% | 32% | 20% | 9% | 0% |

  Rule of thumb: lockstep is smooth when the worst one-way latency is under D ticks. D = 4 covers a region (the Phase 3 target), at the cost of 67 ms between your click and your player reacting. That lag applies to your own player too, which is the main reason to move to rollback (predict the opponent, show your own input immediately) once it's on a real network.

**What is not proven yet**

- **Cross-browser float determinism.** Both tabs are the same engine (Chromium V8 in the test). Chrome against Firefox or Safari, or x86 against ARM, has not been run. The desync detector is the tool for that test: same seed, same input log, two browsers, compare the hashes every 60 ticks. The sim already avoids `Math.hypot`; `Math.sin`/`Math.cos` (in `rotate`), `Math.atan2`, `Math.exp`, `Math.log` and `Math.pow` (CPU shot and trajectory maths) are the remaining suspects.
- **A real network.** `BroadcastChannel` is same-browser, same-origin only; the latency table above is simulated. No NAT, no server relay, no WebSocket transport yet, and no reconnect: a tab that closes sends "bye", but a crashed or frozen tab just leaves the other waiting.
- **Server authority.** Either peer could send any input it likes, and both trust the host's team setups. A server running `src/sim` with the same lockstep inputs (or as the rollback authority) is still Phase 3 work.
- **Feel with humans.** Nobody has yet played two-tab or hot-seat matches and said whether 67 ms feels fine. Hot-seat keyboards may also ghost when both players press several keys at once.
- **Embedded viewers.** A sandboxed frame (opaque origin) can't reach other tabs; the lobby detects that and says to open `dist/index.html` directly. Linked and hot-seat matches are not recorded as replays.

## Club levels (October 2026)

The club opens up as it gains experience. A new player starts with Home and one big Kick off (a first match against an easy CPU club, with light coach tips) and nothing else: no tabs. Level 2 adds the Squad, vs Player (Local 2P, Link two tabs) and Easy practice; level 3 Ranked, the Club tab, replays and Practice skills; 4 Training and Practice Normal; 5 the Cup and Practice Hard; 6 Transfers; 7 the Ladder; 8 the League (calendar and academy at 10). Until level 3 Kick off is a warm-up friendly against a gentle generated club (no Elo, still XP); the Elo win-chance gauge stays hidden for the first three ranked matches. Each new tab is introduced once with a coach mark. Saves from before this table keep every feature the old one had opened for them (`unlocksV`). Everything else arrives with club levels 2 to 10, and small perks keep the levels meaningful up to 99. The rules are in `src/meta/levels.ts` (pure, unit-tested in `tests/levels.test.ts`), the UI in `src/client/levels.ts`. Match controls (sprint, through ball, chip) are never gated.

**The curve.** Clearing level L takes 100 × L XP: level 1 → 2 is 100, 2 → 3 is 200, 98 → 99 is 9,800. Reaching level L takes 50 × L × (L − 1) in total, so level 99 is 485,100 XP. Level 99 is the cap: its bar is 9,900 long and reads "Max level" when full, and XP keeps counting for a future prestige. Functions: `xpToClear(level)`, `levelForXp(totalXp)` → `{ level, intoLevel, needed, maxed }`, `totalXpForLevel(level)`.

**Unlocks and perks.** `UNLOCKS` in `levels.ts` is the one table; the tabs, buttons, the Club level panel and the level-up dialog all read it, and this copy is checked against it by a unit test.

| Level | Kind | Unlock | What it does |
|---|---|---|---|
| 1 | Feature | Home and Kick off | Kick off your next match from Home. Everything else opens as the club levels up. |
| 2 | Feature | Squad | See your players and pick the starting eleven. |
| 2 | Feature | Local 2P | vs Player on one screen: two humans, one keyboard. Nothing recorded. |
| 2 | Feature | Link two tabs | vs Player in two tabs of this browser, in lockstep. Nothing recorded. |
| 2 | Feature | Practice (Easy) | Friendlies against an Easy CPU. No Elo. |
| 3 | Feature | Ranked matches | Play ladder clubs near your Elo, live. Until then, Kick off is a warm-up friendly. |
| 3 | Feature | Club | Club news, your club level and every unlock still to come. |
| 3 | Feature | Replays | Watch your goals again, keep recent replays and share replay codes. |
| 3 | Feature | Practice skills | The training-ground drills: run, pass, shoot and tackle, any time you like. |
| 4 | Feature | Training | Spend the sessions you earn on player attributes. |
| 4 | Feature | Practice Normal | A fairer CPU friendly: the Academy Select. |
| 5 | Feature | The Cup | The Competitions tab opens with an 8-club knockout cup: prize money, penalties, a trophy. |
| 5 | Feature | Practice Hard | A tougher CPU friendly: the Veterans Select. |
| 6 | Feature | Transfers | Sign players from the market and sell to CPU clubs. |
| 7 | Feature | Ladder | The full Elo table of all 16 clubs. |
| 8 | Feature | League season | An 8-club round robin over 7 matchdays, with prize money for every place. |
| 10 | Feature | Season calendar and academy | Seasons of 10 matches start counting: players age, veterans retire and academy prospects arrive. |
| 15 | Perk | Squad of 25 | Room for one more player (24 to 25). |
| 18 | Perk | Crest pattern | Change your crest pattern any time from Club news. |
| 20 | Perk | Deeper market | Two extra players on the transfer market (10 to 12). |
| 22 | Perk | Custom kit colours | Pick your own kit colours from Club news. |
| 25 | Perk | Sharper scouts | An academy prospect's potential is known one match sooner (5 instead of 6). |
| 25 | Perk | Silver badge | Your level badge turns silver. |
| 30 | Perk | Squad of 26 | Room for another player (25 to 26). |
| 35 | Perk | Win bonus | One extra training session for every ranked or competition win. |
| 40 | Perk | Replay shelf of 8 | Keep your last 8 replays instead of 5. |
| 50 | Perk | Squad of 27 | Room for another player (26 to 27). |
| 50 | Perk | Gold badge | Your level badge turns gold. |
| 65 | Perk | Replay shelf of 10 | Keep your last 10 replays. |
| 75 | Perk | Platinum badge | Your level badge turns platinum. |
| 80 | Perk | Scouting network | Two more players on the transfer market (12 to 14). |
| 99 | Perk | Legend badge | Level 99. The bar keeps counting toward a future prestige. |

The schedule is the owner's. One change since the first cut (October 2026 home redesign): Local 2P and Link two tabs moved from levels 7 and 12 to level 1, because "vs Player" is one of the home screen's play modes from the start; level-1 features never open a level-up dialog, so older saves just find them there. Two notes on it: the calendar starts counting with the first counted match after level 10 (no week passes and nothing ages or rolls over before then), and the perks past level 12 are deliberately small, cosmetic or convenience, never strength for money: a slightly bigger squad, a deeper market, faster scouting, one more training session per win.

A feature is available when the club's level reaches it, when the save is already using it (a cup or league in progress, a trophy of that kind, a running calendar or academy offers), or when it was unlocked once before (`unlocksSeen`). So nothing is ever taken away, even if the XP table is rebalanced. Locked tabs and buttons are hidden, not disabled.

**XP sources.**

| Source | XP |
|---|---|
| Ranked, cup or league match | win 120, draw 80, loss 50; +10 per goal scored; +20 for a clean sheet |
| Practice | Easy 30, Normal 40, Hard 60 (flat) |
| Training session | 5 each |
| Cup finish | winners +500, runners-up +200, out in the semi-final +100 |
| League finish | 1st +800, 2nd +400, 3rd–4th +200, 5th–6th +100, 7th–8th +50 |
| First-time milestones | finish the training ground +100, first ranked win +100, first signing +50, first trophy +200 |
| Forfeits, abandoned matches | 0 (a forfeited cup final or last matchday also loses its finish bonus) |
| Local 2P, Link two tabs | 0 (they record nothing) |

XP is per match whatever the match length, like money and Elo. A cup tie settled on penalties counts as the draw it was.

**Pacing.** Expected values (`levelForXp` over a modelled run): a typical ranked match against clubs near your Elo, at 45% wins, 25% draws, 30% losses, 1.6 goals scored and a clean sheet a quarter of the time, is worth 110 XP, plus about 12 more once its ~2.5 training sessions are spent. The tutorial's 100 comes first and the first win and first signing add 150 early. "Mixed" plays one cup tie in four matches from level 5 and adds league matchdays from level 8. Real time assumes the standard 2 × 3-minute match (the old length selector is gone), about 5 minutes each with kick-off, half-time, the result and a minute in the menus.

| Level | Total XP | Matches, ranked only | Matches, mixed | Time (mixed) |
|---|---|---|---|---|
| 2 | 100 | 0 (the tutorial) or 1 | 0 or 1 | setup |
| 5 | 1,000 | 7 | 7 | ~35 min |
| 8 | 2,800 | 22 | 20 | ~1.7 h |
| 10 | 4,500 | 36 | 32 | ~2.7 h |
| 12 | 6,600 | 53 | 46 | ~3.8 h |
| 20 | 19,000 | 154 | 131 | ~11 h |
| 50 | 122,500 | 1,001 | 842 | ~70 h |
| 99 | 485,100 | 3,967 | 3,331 | ~280 h |

So the first session reaches level 2 (finishing the training ground alone does it; a skipped tutorial needs one match that isn't a goalless defeat) and level 5, the Cup, comes in about 35 minutes. Everything that is a feature is open in about four hours. The tail to 99 is long by design; if testers stall in the 20s, the lever is the per-match numbers, not the curve.

**Saves from before levels.** `ensureLevelFields` runs at boot. A save with no `xp` gets retro XP from what it records, using the same table: every match in its history (forfeits look like 0–3 defeats there, so they count as defeats), training sessions spent (sessions earned minus sessions left), cup runs and league seasons its history and trophies prove (a finished season without a title gets the bottom-place bonus), and the milestones it shows (first ranked win, a signing in the news, a trophy). The training-ground milestone can't be known, so it stays claimable from Replay tutorial. Everything its level reaches, plus anything it is using, is marked as seen, so an old save neither loses a feature in use nor gets a flood of level-up dialogs. New fields (`xp`, `unlocksSeen`, `milestones`) are optional and `isSave` accepts saves without them.

**UI.** The header shows a level badge (a button to the Club level panel) and an XP bar ("Level 4 · 230 / 400 XP", `role="progressbar"` with `aria-valuenow`, `-min`, `-max` and `-valuetext`). The Club tab has a Club level panel: the next unlock ("The Cup and Practice Hard at level 5 — 340 XP to go"), how XP is earned, and every unlock and perk marked Unlocked, Next or its level. The result dialog lists the XP ("+150 XP: win 120, 3 goals 30") and any level gained. Crossing a level that unlocks something opens a level-up dialog after the result: it names the unlocks, is announced through the live region, traps focus, closes with Esc or Later, and its main button goes straight to the new feature.

## Phase 4: The economy between players (4–6 weeks)

Goal: a market that people trade on, not just a CPU shop.

- Player-to-player transfers: listings, offers, a short auction window, a transfer fee tax that removes money from the economy.
- **Anti-abuse is the main design work.** Manager games historically suffer from multi-accounting: alts feed players and money to a main club. Mitigations: account age and play requirements before trading, a price band around the model's valuation, rate limits, flagging circular trades.
- Seasons: aging, retirements, generated youth intake, divisions with promotion and relegation.
- Wages and a stadium upgrade as money sinks.

## Phase 5: Live service (ongoing)

- **Seasons of 6–8 weeks** with a fresh ladder, a season pass of cosmetic rewards, and an end-of-season cup.
- **Monetisation that doesn't sell wins:** kits, crests, pitch styles, goal celebrations, a club "supporter" subscription for extra save slots or replay storage. Never sell attributes, training sessions or transfer budget. In a skill-plus-squad game, selling strength kills ranked credibility.
- **Social:** friend leagues, club chat, shareable goal replays (clips rendered from the input log).
- **Ops:** CI on every push (typecheck, unit tests, a headless 200-match balance run with goal and upset bands as assertions), feature flags, Sentry for errors, PostHog for product analytics, a status page.
- **Anti-cheat:** server authority already blocks teleporting and edited stats. Remaining risk is input bots (aim assist); detect them with input-timing statistics and review flagged replays.

## Stack (2026)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One sim codebase for client, server and tests |
| Build | Bun today; Vite once dependencies are allowed | Zero-dependency prototype; Vite for the dev server and plugins later |
| Rendering | Canvas 2D → PixiJS v8 if needed | Canvas is plenty for 13 circles; Pixi gives WebGPU when effects arrive |
| Menus | Plain DOM today → Preact or Solid | Small, fast, keeps the bundle light |
| Realtime | Node/Bun server running `src/sim`, WebSocket then WebTransport | Same code both sides |
| Data | Postgres + Redis | Ledger of truth; queues and presence |
| Hosting | Static client on Cloudflare Pages; game servers on Fly.io regions | Cheap to start, regional latency |
| Quality | Bun tests, Playwright e2e, headless balance suite | Determinism makes the sim very testable |

## Legal hygiene

- No real club, league, player or competition names, likenesses or crests. Generators only.
- Don't use the old game's name, logo or art. Keep "inspired by" talk out of store listings.
- Generated names can collide with a real person by chance. Add a blocklist for famous footballers' full names before launch.

## Suggested order and rough effort (part-time, one person)

1. Feel lab: 2–4 weeks. **Gate:** testers come back for a second session.
2. Accounts and server-owned club: 3–5 weeks.
3. Multiplayer friendlies by invite link (no queue): 4–6 weeks. **Gate:** matches between two continents complete without desync.
4. Ranked queue, Glicko-2, match nights: 2–4 weeks.
5. Player market and seasons: 4–6 weeks.
6. Cosmetics and season pass: when there are at least a few hundred weekly players.

Roughly 4–6 months part-time to a soft launch with friendlies and ranked play, if Phase 1 passes its gate.
