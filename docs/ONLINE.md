# Online friendlies

Two people, two browsers, anywhere: one creates a match and sends a link, the other opens it, and they play the same deterministic lockstep match they would in two tabs. The game stays a static site on Vercel. A small **relay** server pairs the two browsers and forwards their messages. It runs as its own service, because Vercel can't hold WebSockets open.

Online play stays switched off until a relay is deployed and its URL is baked into the build (`DERBY_RELAY_URL`). Until then nobody sees an Online button. [Going live](#going-live-what-the-owner-needs-to-do) lists what's needed.

## Architecture

```
 browser A (host, home side)                relay (server/)                     browser B (guest, away side)
 ┌──────────────────────────┐       ┌──────────────────────────────┐       ┌──────────────────────────┐
 │ Lockstep (src/net)       │       │ server/bun.ts  (Bun.serve)   │       │ Lockstep (src/net)       │
 │ room handshake (room.ts) │  WS   │   └ RelayCore (relay-core.ts)│  WS   │ room handshake (room.ts) │
 │ WebSocketTransport ──────┼──────►│     rooms: code → 2 seats    │◄──────┼── WebSocketTransport     │
 │   (websocket.ts)         │◄──────┼     forwards {t:'relay',m}   ├──────►│   (websocket.ts)         │
 └──────────────────────────┘       └──────────────────────────────┘       └──────────────────────────┘
```

- **`src/net/lockstep.ts`** (unchanged design): each side samples its input for tick t + D, sends it at once, and simulates tick t only when both inputs for t are known. Every input message re-sends whatever the peer hasn't acknowledged. Every 60 ticks the two sides compare a state hash.
- **`src/net/websocket.ts`** implements the same two-method `Transport` as `BroadcastChannel` (`send`, `onMessage`), so lockstep and the room handshake run on it unchanged. It reconnects on its own and resumes its seat (below), and reports a status: `connecting`, `open`, `reconnecting` or `closed`.
- **`server/relay-core.ts`** is the whole relay as a pure state machine, with no sockets, timers or clock of its own. `server/bun.ts` wraps it in `Bun.serve`. `server/cloudflare.ts` is an untested Durable Object wrapper.
- **`src/net/presence.ts`** decides when the opponent counts as gone (see [Disconnects](#disconnects)).
- **`server/verify.ts`** re-simulates a replay code headlessly and checks it against its claims (see [Trust](#threat-model-and-trust)).

The relay never looks inside the game messages. It checks frame size and rate, pairs sockets under a room code, compares build versions, and forwards envelopes verbatim.

## Protocol

Messages are JSON text frames, one object per frame, told apart by `t`. Types live in `src/net/relay.ts`, which the client and the server share.

| Client → relay | Relay → client |
|---|---|
| `host { v }` | `hosted { code, seat: 0, token }` |
| `join { code, v }` | `joined { code, seat: 1, token }`, and the host gets `peer { s: 'joined' }` |
| `resume { code, seat, token }` | `resumed { code, seat, peer }`, and the other side gets `peer { s: 'back' }` |
| `relay { m }` | `relay { m }` to the other seat, untouched |
| `ping { n }` (every 5 s) | `pong { n }` |
| `leave {}` | the other side gets `peer { s: 'left', why: 'left' }` |
| | `peer { s: 'away' }` when the other socket drops, then `peer { s: 'left', why: 'timeout' }` if it doesn't come back |
| | `error { code, msg }`, always followed by a close. Codes: `no-room`, `full`, `version`, `bad-token`, `busy`, `rate`, `too-big`, `bad-msg`, `timeout` |

- **Version:** `v` is `p<protocol>.s<SIM_VERSION>.r<REPLAY_VERSION>` (`netVersion()` in `websocket.ts`). A room is pinned to the host's `v`. A guest on another build gets `version` and sees "Your friend is on a different version of Derby Day. Both of you reload the page, then try again." So when the physics stream bumps `SIM_VERSION`, old and new builds can't pair and desync.
- **Room codes:** 6 characters from a 32-letter alphabet with no 0/O or 1/I. That is about a billion codes, against 1 million for the 4-letter codes used in two-tab play.
- **Seat tokens:** `crypto.randomUUID()`, given to each seat once. Only the holder can resume that seat.
- **After pairing:** the existing room handshake (`src/net/room.ts`) runs inside `relay` envelopes. The guest sends `join { team, crest }` until the host answers with `start { seed, home, away, delay, ... }`. The guest then sends `ready`, and lockstep starts.

## Limits

These are defaults in `DEFAULT_LIMITS` (`server/relay-core.ts`). Every one can be overridden by an environment variable (`RELAY_` plus the name in SCREAMING_SNAKE_CASE, e.g. `RELAY_MAX_ROOMS=500`).

| Limit | Default | Why |
|---|---|---|
| `maxFrameBytes` | 32 KB | A room start with two full squads is ~4.5 KB. A worst-case lockstep batch (120 unacknowledged inputs) is ~17 KB, and a typical one ~0.4 KB. Bun also enforces the cap itself (`maxPayloadLength`). |
| `ratePerSec` / `burst` | 150/s, 300 | A token bucket per socket. Lockstep sends about 65 messages a second. Going over closes the socket. |
| `bytesPerSec` / `byteBurst` | 96 KB/s, 512 KB | A byte budget on top of the message rate, so 150 maximum-size frames a second (4.8 MB/s) aren't allowed. A player sends about 25 KB/s. |
| `maxRooms` | 2000 | 4000 players at once. |
| `maxSockets` | 5000 | |
| `maxSocketsPerIp` | 8 | Stops one machine filling the relay. Behind a proxy, set `TRUST_PROXY=1` (and `TRUST_PROXY_HOPS`) so the real client address is used. |
| `helloMs` | 10 s | A new socket must send `host`, `join` or `resume` within this. |
| `heartbeatMs` | 30 s | A socket silent this long is dropped (clients ping every 5 s). |
| `graceMs` | 30 s | How long a dropped seat can be resumed. The client gives up at 25 s and the UI at 20 s. |
| `waitingMs` | 30 min | A hosted room nobody joins. |
| `idleMs` | 2 min | A full room in which nothing is relayed. |
| `roomTtlMs` | 2 h | Hard cap on a room's life. A match is 6 minutes. |
| `maxBadJoins` | 5 | Failed joins or resumes before the socket is closed. |
| `maxBadJoinsPerIp` / `badJoinWindowMs` | 30 per 10 min | Failed joins and resumes per client address (IPv6 per /64), counted across reconnects. Past that, more *wrong* codes from the address are refused (`rate`) until the window passes. A right code, or a valid resume, still gets in, so one guesser behind a shared address (campus or carrier NAT, or a deployment missing `TRUST_PROXY`) can't lock everyone else out. Together with the 6-character codes, guessing a live room takes years: with 2,000 rooms open, each guess hits one in about 500,000. |

The relay keeps every room in memory, so a restart ends the matches in progress. Clients see `Lost the connection to the match server` and go back to the club; nothing is lost, because friendlies record nothing.

## Disconnects

This is the Phase 3 exit criterion: "a disconnect pauses for 20 s and then forfeits cleanly".

- **Pause.** Lockstep pauses on its own: neither side can simulate without the other's inputs.
- **Detecting the drop.** The opponent counts as lost when the relay says their socket dropped (`peer away`), when our own link is reconnecting, or when we have heard nothing at all for 2 s while waiting on them (a frozen or crashed tab whose socket is still open). Two-tab play has no relay, so it uses the silence rule.
- **Countdown.** The banner says **"Opponent disconnected, waiting 20 s"** and counts down. It says "Connection lost, reconnecting… N s" when it's our own link that dropped.
- **Our own freezes don't count.** Only time this tab spends running counts towards the 20 s: each gap between frames counts at most 1 s. A tab that was backgrounded or stuck compiling shaders doesn't come back and abandon an opponent who was waiting for it the whole time. (The first version of this did exactly that, in the e2e test: SwiftShader froze one page for 20 s.)
- **Coming back.** The client reconnects with backoff (250 ms doubling to 4 s, with jitter), sends `resume` with its token, and lockstep re-sends whatever was lost. Both sides carry on from the same tick, still in sync (tested in `tests/websocket.test.ts` and the e2e).
- **Not coming back.** After 20 s the match ends as an **abandoned friendly**: a result dialog that says so, with no Elo, money, training or XP for either side. Friendlies award nothing anyway, so there is nothing to farm by pulling the plug.
- **Leaving on purpose.** Leave from the menu, or close the tab, and the opponent is told at once ("Your opponent left the match"). Closing the tab sends lockstep's `bye` and the relay's `leave` on `pagehide`. If the page may come back (`pagehide` with `persisted`: the back-forward cache, or a phone switching apps), nothing is sent and the countdown covers it.

## Threat model and trust

Lockstep sends only inputs. Each client runs the whole match itself.

**Everything a peer sends is untrusted, and is checked where it arrives** (`src/net/validate.ts`, `tests/validate.test.ts`, and the e2e "hostile guest" test):
- **Team setups and the start message.** Colours must be `#rrggbb`. The short name is 1–4 of A–Z and 0–9. Names lose markup (`< > " ` \`) and control characters, have spaces collapsed and are length-capped by code point (`&` and `'` stay, for names like "Brighton & Hove"; every place that puts a name into HTML escapes it). There must be exactly 11 players with unique ids, a known role and finite attributes clamped to 0..1. The formation and crest pattern must come from the known lists. Seed, half length and input delay are bounded. A join with a bad team is refused ("Your friend's team couldn't be read"), and a bad start is refused on the guest. **The guest also checks that the away team in the start is its own squad**: the same players, numbers, roles, attributes, formation and skill. Only the kit (the clash swap: its own colours, swapped, or the neutral fallback) and a " II" on the name may differ. Anything else is refused ("The host's match didn't have your squad in it"), so a host can't hand the guest eleven zero-rated players or an unreadable kit. Only the host's own team rests on the host's word. The host runs its own start through the same function, so both sides build exactly the same match from exactly the same data.
- **Lockstep messages.** These must be a known type with the right fields. Input batches are at most 120. Inputs are stored only for ticks the peer could really be at (no far-future ticks, so no memory growth). Every input field is clamped to a finite value in range, and anything else is dropped. Each side runs its own sampled inputs through the same cleaning, so a dropped field is dropped on both screens and can't cause a desync.
- **Relay envelopes** that aren't JSON objects never reach the game.

**A malicious client can:**
- Steer **its own player** with any well-formed input: a perfect bot, instant reactions. Lockstep can't tell a bot from a person.
- Refuse to send inputs, which stalls the match. After 20 s it ends as abandoned, with nothing gained.
- As host, choose the seed and **its own** team setup. A host could send a doctored squad for itself. Attributes are clamped to the legal range, but within that range the guest has to take the host's word for the host's team (until a server owns the setup, see below). It can't change the guest's team: the guest checks its own squad in the start.
- Read everything the other side sends (its inputs and team). Nothing secret is in there.
- Spam the relay. Message and byte rate limits and size caps close its own sockets; connection caps limit how many it can open. Its wrong-code guesses use up the guess budget of its address (or its /64), which also blocks wrong guesses from others behind that address, but never a right code or a valid resume.

**A malicious client cannot:**
- Move the other team's players. Each side's inputs only drive that side's controlled player, and both screens apply the same inputs, so there is one match, not two. A difference between the screens (a determinism bug) shows up as a desync at the next 60-tick hash check and stops both sides.
- Put markup or script into the other player's page, or break their sim with NaN, Infinity or junk. Everything is validated at the boundary, as above.
- Reach anyone but its opponent. The relay forwards only within a room of two.
- Take over a seat. Resuming needs the seat's token, which only that player's browser ever had. An unknown room and a wrong token get the same answer, so resume can't be used to probe which codes exist.

**So results from online friendlies are not trusted.** They record nothing today. Before an online match can count for Elo, a server must decide the result:
1. **Re-simulate.** `server/verify.ts` already replays a replay code (`src/meta/replay.ts`) and returns the true score, stats and state fingerprint. It flags an edited score, edited goals, a tampered input log (the final state hash no longer matches), a log that stops before full-time, and a replay from another sim version (`tests/verify.test.ts`). Usage: `bun server/verify.ts <code>` prints a JSON verdict and exits 1 if the replay doesn't hold up.
2. **Own the setup.** The server, not the host, should send `start`, with both squads read from server-side saves. That needs accounts.
3. **Bots.** Inputs that were really played but by a script can't be caught by re-simulation. That takes server-side input timing analysis, or the server running the match itself as the authority (Phase 3).

`verify.ts` is not exposed over HTTP. Re-simulating a 6-minute match costs about a second of CPU, so a public endpoint would need authentication and a queue first.

**`?relay=` works only on local pages** (`file:`, `localhost`, `127.0.0.1`). On the real site the relay is the one baked into the build, so a link like `https://derby.natwong.dev/?join=X&relay=wss://evil.example` can't send players to someone else's server.

**The Origin allow-list only stops browsers.** `ALLOWED_ORIGINS` keeps other websites from opening sockets to the relay from their visitors' browsers. Any non-browser client can send whatever `Origin` header it likes, so it is not authentication. The limits above are what contain such a client.

**`/health` is public** and shows counts only: rooms, sockets, matches, messages relayed and uptime. No codes, addresses or tokens. Put it behind the host's private network if even the counts matter.

## Run it locally

```sh
bun server/bun.ts                       # relay on ws://localhost:8787 (GET /health for stats)
bun run build                           # the game, dist/index.html
# open dist/index.html?relay=ws://localhost:8787/ws in two browsers (or two profiles)
```

Home → vs Player → **Online** → Create a match. Copy the invite link into the other browser, or type the code there. To try it across two machines on one network, run the relay on one machine and use `?relay=ws://<that machine's LAN address>:8787/ws` on both.

Tests:
- `bun test tests/relay.test.ts tests/websocket.test.ts tests/presence.test.ts tests/verify.test.ts tests/netconfig.test.ts`: the relay core with fake sockets and a fake clock; the transport against the core with drops and refusals; the same over real sockets against `Bun.serve`; the presence rules; the verifier; invite links.
- `node tests/e2e/run.cjs Online` (after `bun run build`): starts the Bun relay on a free port and opens two browser contexts with `?relay=ws://127.0.0.1:<port>/ws`. One hosts, and the other opens the invite link and is in the match without typing anything. The test plays about 7 s, drops the guest's socket (it resumes), and checks that every 60-tick state hash both sides recorded is identical. It then crashes the guest's renderer and checks that the host shows the countdown and ends with an abandoned friendly. Other tests cover a wrong code and a mismatched version. The test uses the 2D renderer, because two SwiftShader WebGL pages freeze for seconds on shader compiles.

## Deploy the relay

The relay is one process with no dependencies, no disk and no database. Any host that runs a long-lived process and passes WebSockets through will do. Configure it with environment variables:

| Variable | Example | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port (`0` = any free port). |
| `HOST` | `0.0.0.0` | Listen address. |
| `ALLOWED_ORIGINS` | `https://derby.natwong.dev` | Comma-separated Origin allow-list. **Set this in production.** Empty allows every origin. Vercel preview URLs need adding if previews should work. |
| `TRUST_PROXY` | `1` | Behind a reverse proxy: read the client address from `X-Forwarded-For`, counting `TRUST_PROXY_HOPS` trusted proxies from the right (the entries further left are whatever the client sent). On Fly.io (`FLY_APP_NAME` set) `Fly-Client-IP` is used instead. Without it, every player behind the proxy shares one address and the per-address limits bite. |
| `TRUST_PROXY_HOPS` | `1` | How many proxies you run in front of the relay that each append to `X-Forwarded-For`. One for Render, Railway or a single Caddy/nginx; more if there's a CDN in front as well. |
| `RELAY_*` | `RELAY_MAX_ROOMS=500` | Any limit above. |
| `RELAY_QUIET` | `1` | No JSON event log (room open and close) on stdout. |

The container: `docker build -f server/Dockerfile -t derby-relay .` (from the repo root), then `docker run -p 8787:8787 -e ALLOWED_ORIGINS=https://derby.natwong.dev derby-relay`. It has a `HEALTHCHECK` on `/health`.

**Fly.io** (recommended to start: regions near players, WebSockets work, a small machine costs a few dollars a month):
```sh
fly launch --no-deploy --dockerfile server/Dockerfile --name derby-relay
fly secrets set ALLOWED_ORIGINS=https://derby.natwong.dev TRUST_PROXY=1
fly deploy
fly certs add relay.derby.natwong.dev      # then add the CNAME it prints at your DNS host
```
In `fly.toml`, keep `internal_port = 8787`. Set `auto_stop_machines = "off"` (or at least `min_machines_running = 1`): a machine stopped mid-match drops every match on it. Add an `http_checks` entry on `/health`. Start with **one machine in one region**: rooms live in memory, so two machines can't see each other's rooms (see Scaling).

**Render:** New → Web Service → this repo, runtime Docker, Dockerfile path `server/Dockerfile`, health check path `/health`. Set `ALLOWED_ORIGINS` and `TRUST_PROXY=1`. The free tier sleeps after inactivity, so use a paid instance for real play.

**Railway:** New project → Deploy from repo. Set `RAILWAY_DOCKERFILE_PATH=server/Dockerfile` and add `ALLOWED_ORIGINS` and `TRUST_PROXY=1`. Railway sets `PORT` itself. Add a custom domain under Settings → Networking.

**Any VPS:** install Bun (`curl -fsSL https://bun.sh/install | bash`), clone the repo, and run `bun server/bun.ts` under systemd with `Restart=always`. Put Caddy or nginx in front for TLS on `relay.derby.natwong.dev`. Caddy: `relay.derby.natwong.dev { reverse_proxy 127.0.0.1:8787 }` handles certificates and WebSocket upgrades on its own. Set `TRUST_PROXY=1`.

**Cloudflare (untested):** `server/cloudflare.ts` is a Worker plus one Durable Object holding the same `RelayCore`. It typechecks but has never been deployed. The `wrangler.toml` it needs is in its header comment. Try it only if you'd rather not run a server.

The client connects to whatever URL it is given, so use `wss://relay.derby.natwong.dev/ws`. The relay accepts the upgrade on any path. `/ws` keeps `/` and `/health` free.

### Scaling

One Bun process forwards messages without doing any game work. A local load test (`Bun.serve` relay in one process, the clients in another, on the same 4-core sandbox) had every player send 60 typical input messages a second:

| Matches | Sockets | Messages/s through the relay | Relay CPU (one core) | Relay memory | Relay latency p50 / p95 |
|---|---|---|---|---|---|
| 100 | 200 | 11,800 | 27% | 33 MB | 2.5 / 5.8 ms |
| 300 | 600 | 34,900 | 70% | 34 MB | 7.1 / 17.5 ms |

So one small machine with one core carries about 300–400 matches at a time, or 600–800 players. The latency figures include the load client's own scheduling, so the relay alone is faster. This hasn't been measured on real hosting hardware or over the internet. When one region isn't enough, run one relay per region and put the region in the room code or the invite link, so both players reach the same machine. Rooms don't need to be shared between machines. The step after that is the Phase 3 authoritative server, which runs `src/sim` itself.

## Going live: what the owner needs to do

1. **Pick a host and create an account.** Fly.io is the recommendation (above). Render, Railway or a VPS work the same way.
2. **Choose a domain** for the relay, e.g. `relay.derby.natwong.dev`, and add the DNS record the host gives you.
3. **Deploy** `server/Dockerfile` with `ALLOWED_ORIGINS=https://derby.natwong.dev` (plus any preview origins you want) and `TRUST_PROXY=1`. Check `https://relay.derby.natwong.dev/health` answers `{"ok":true,...}`.
4. **In Vercel**, add the environment variable `DERBY_RELAY_URL=wss://relay.derby.natwong.dev/ws` (Production, and Preview if wanted) and redeploy. The build bakes it in (`scripts/build.ts`), and the Online button appears on the vs Player card. Before that, you can try the deployed relay from a local build: `bun run build`, then open `dist/index.html?relay=wss://relay.derby.natwong.dev/ws`. `?relay=` is ignored on the real site.
5. **Play a match with someone in another city** and look at the stats line under the pitch (round trip, share of time waiting). If waits are common, raise the default input delay (`DEFAULT_DELAY` in `src/client/versus.ts`, 4 ticks = 67 ms).

Rough cost: one small always-on machine, about $2–5 a month on Fly.io or Railway, or $7 on Render's cheapest paid instance. Bandwidth is about 18 KB/s per player in each direction (JSON), roughly 13 MB in and 13 MB out of the relay per 6-minute match.

## Accounts and server-side saves (not built)

Ranked online play needs accounts, so the server can own each player's squad and Elo. **Recommendation: Supabase**, which gives auth (email magic link plus Google/Apple sign-in), Postgres and row-level security in one hosted service, with a generous free tier and a plain HTTP API. That fits a static Vercel site and the no-npm-dependencies rule: one small fetch client, no SDK. Keep the relay separate, so it stays stateless. When ranked online arrives, the relay (or a small API next to it) checks a Supabase JWT on `host`/`join`, the server sends `start` from both stored squads, and `server/verify.ts` decides the result from the match's input log before Elo moves. Clerk or Auth0 are alternatives if you'd rather not run the database, but then saves still need somewhere to live.
