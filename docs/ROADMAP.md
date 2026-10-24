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
- **Deterministic sim.** `src/sim` is pure TypeScript: fixed 60 Hz tick, seeded RNG, no DOM, no clock, no `Math.random`, `sqrt` instead of `Math.hypot`. The same seed plus the same input log reproduces a match exactly (tested). That one property unlocks server authority, replays, rollback netcode and bot-driven balance testing.
- **Inputs are tiny.** A tick of human input is a cursor point plus a few flags. A recorded 2×2-minute match with constant mouse movement is about 39 KB as a replay code; an idle one is 1–3 KB.
- **Replays prove it.** Every match is recorded as its input log and re-simulated for goal highlights, with seeking (keyframes every 600 ticks, warm seeks ~3 ms) and a hash check that warns if the engine changed since recording.
- **Headless balance.** `bun run balance` plays CPU-vs-CPU matches at well over 1,000× real time. 40 matches average about 2.9 goals, 23 shots and 160 passes; the higher-Elo club wins about four times as often as it loses.

**Playing**
- **Mouse-first control.** Your player runs to the pointer; left click passes toward it (auto-picks the teammate and leads the pass); hold right to shoot; Ctrl/Cmd for through balls and chips; Shift or middle button to sprint on a stamina bar. The ball has height, bounces, and can clear the bar. Full keyboard play works too.
- **A real CPU.** Team plans with interception prediction, goal-side marking, support runs, through balls, chips, sprinting and a keeper that narrows angles and sweeps. Difficulty is measured: identical squads at skill 0.85 beat 0.25 about 80% of the time.
- **Sound and feel.** Synthesised kicks, whistles, net and crowd (no audio files), goal shake and confetti, all reduced-motion aware.

**The club**
- **Loop.** Generated squad with attributes (1–99) that change speed, passing error, shot error, tackle odds and keeper reach; transfers, training sessions, a 16-club Elo ladder with the World Football Elo goal-difference multiplier, prize money.
- **Competitions.** An 8-club cup (seeded bracket, live penalty shootout when your tie is drawn) and an 8-club league season, neither touching ladder Elo. Forfeits pay nothing, so they can't be farmed.
- **Time passes.** A 10-match season calendar: ageing curves, retirements from 34, an academy intake with scouting fog on potential, CPU clubs that rise and fall, and a season review.
- **Original world.** Ten fictional name styles and nations, blocklists against famous real players and clubs.

**First run and access**
- Five-step onboarding with a coached training-ground tutorial on the real engine, skippable at every step.
- WCAG 2.1 AA pass: skip link, ARIA tabs, focus restored after every render, live announcements for goals and results, dialogs with focus traps, contrast fixed in both themes, team markers that don't rely on colour alone.

Known gaps: saves live in one browser only (closing a tab mid-match is a free abort; two tabs can overwrite each other); no fouls or set pieces; the CPU's middle difficulty steps are uneven; sounds are untested by ear; no real screen-reader pass yet.

## Phase 1: Feel lab (2–4 weeks part-time)

Goal: people choose to play a second match against the CPU.

- Put the build on a URL, recruit 10–20 testers, and watch 5 of them play without help.
- Instrument: matches started vs. finished, second-session rate, control mode used (mouse vs. keys), goals per match, time to first goal.
- Tune the controls: arrival radius, acceleration, first-touch, pass auto-target cone, shot charge curve. Add one-twos, through balls (double-click?), and a sprint with stamina cost.
- Decide the format: 6-a-side on boards (current) vs. 7- or 11-a-side with throw-ins. Smaller sides mean more touches per person, which suits real-time play.
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

Two humans can now play one match, in two ways, from the Club tab:

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
