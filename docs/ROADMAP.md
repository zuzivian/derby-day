# Overlap roadmap: from prototype to live service

Working title **Overlap** (the run a full-back makes around a winger). The old game that inspired this is not named anywhere in the product. Clubs, players, nations and the currency (club florins, ƒ) are all generated.

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

- **Deterministic sim.** `src/sim` is pure TypeScript: fixed 60 Hz tick, seeded RNG, no DOM, no clock, no `Math.random`. The same seed plus the same input log reproduces a match exactly (tested). That one property unlocks server authority, replays, rollback netcode and bot-driven balance testing.
- **Inputs are tiny.** A tick of human input is a cursor point plus three flags. That is what a client would send a server.
- **Mouse-first control.** Your player runs to the pointer; left click passes toward it (auto-picks the teammate in that direction and leads the pass); hold right to charge a shot; right click switches player. Keyboard works too.
- **A club loop.** Generated squad, attributes (1–99) that change speed, passing error, shot error, tackle odds and keeper reach. Transfers, training sessions, a 16-club Elo ladder with the World Football Elo goal-difference multiplier, prize money.
- **Headless balance.** `bun run balance` plays CPU-vs-CPU matches at about 1,000× real time. Current numbers over 40 matches: ~3.1 goals, ~23 shots and ~150 completed passes a match; the higher-Elo club won 21, drew 8 and lost 11. A squad rated 70 beats one rated 55 about two times in three.

Known gaps: local storage only, CPU opponents only, no fouls or set pieces, no aging or seasons, AI is a simple state machine, attributes are only lightly tuned.

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
