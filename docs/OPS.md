# Running Derby Day: deploys, switches, privacy, launch checklist

Derby Day is one static site. There is no server and no database yet, so there is very little to run. This
page is for the owner: how a change reaches players, what can be switched on, what is (and is not) collected,
and what to do before telling thousands of people about it.

## How deploys work

- Vercel builds from `main` (`vercel.json`: `npm install -g bun@1`, then `bun run build`, output `dist/`).
  Every push to `main` is a production deploy at https://derby.natwong.dev/.
- Every pull request gets its own preview URL from Vercel (a comment appears on the PR). Open it and play
  before merging. Previews are built with the same `bun run build`, with whatever env vars the Preview
  environment has (leave the two endpoint vars empty there).
- CI (`.github/workflows/ci.yml`) runs on every push: typecheck, unit tests, build, the page size budget,
  the balance smoke test, and the browser e2e suite. Do not merge red.
- `bun run build` produces `dist/index.html` (the whole game inlined), `dist/derby-day.artifact.html` (the
  fragment for sandboxed viewers; it never registers a service worker), `dist/sw.js` (the offline worker, stamped
  with the build id), and copies `static/` (icons, `manifest.webmanifest`, `robots.txt`, `sitemap.xml`,
  `404.html`, `og.png`).

### Caching

| File | Cache-Control | Why |
| --- | --- | --- |
| `/` and `/index.html` | `max-age=0, must-revalidate` | the page is the app; players get a deploy on their next load |
| `/sw.js` | `no-cache, no-store, must-revalidate` | the browser must always be able to find a new worker |
| `/manifest.webmanifest` | `max-age=0, must-revalidate` | |
| `/icons/*` | 1 day, then stale-while-revalidate | rarely change, not content-hashed |
| `/og.png` | 1 hour | share image |

There are no content-hashed assets: the game is a single HTML file, so there is nothing to cache for a year.
If the game ever splits into hashed files, give them `public, max-age=31536000, immutable` in `vercel.json`.

### Offline and updates

After one visit the game opens with no network (the service worker keeps the last page that loaded). The page
is **network-first with a 4 second timeout**, so an online player always gets the newest deploy, and a player
on a bad connection gets the cached one after 4 s. Each deploy has a new build id, so it gets a new cache
(`derby-day-<build>`) and the old one is deleted when the new worker activates. A player with the game open
sees "Derby Day updated. Reload to get the latest version." (not during a match); their running page is never
swapped underneath them.

### Security headers

`vercel.json` sends `Strict-Transport-Security` (1 year, no preload), `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, `X-Frame-Options: SAMEORIGIN` and `Content-Security-Policy: frame-ancestors 'self'`. The build also
puts a full CSP in a `<meta>` on `dist/index.html` (not in the artifact build, whose host sets its own): `script-src` is the
SHA-256 of the single inline script, so injected script cannot run; `connect-src` is `'self'`, loopback WebSockets (`ws://127.0.0.1:*`, `ws://localhost:*`, for local relay development; they can only reach the
player's own machine) and the origins of `DERBY_ERROR_URL` / `DERBY_TELEMETRY_URL` / `DERBY_RELAY_URL` when they are absolute URLs, so a
`?relay=` link pointing at anyone else's server is blocked; styles allow `'unsafe-inline'` because `fx.ts` and
`versus.ts` add `<style>` elements at run time. Vercel's preview toolbar injects its own script, which the CSP blocks on
preview deployments only (a console message; production is unaffected).

### Rolling back

1. Vercel dashboard → the project → Deployments → find the last good production deploy → **Promote to
   Production** (instant, no rebuild). Or `git revert <bad merge> && git push` to `main`.
2. Players on the bad version get the good one on their next load (the page is network-first). Players
   who left a tab open from the bad version see the "updated" notice.
3. Saves are not affected by a rollback: they live in the player's browser. An older build **never overwrites
   or "repairs" a save written by a newer one**: a save whose version is above what the page understands is
   left byte for byte alone, and the page shows "Your club needs a newer version" with a Reload button. So a
   change to `SAVE_VERSION` is a one-way door for players who already loaded it: ship a migration in the new
   build (keep reading the old format) rather than relying on rollback. A save that is merely unreadable
   (damaged) is replaced by the rolling backup (`derbyday.save.v1.bak`) with a message; if there is no
   backup, the unreadable text is kept as `derbyday.save.v1.corrupt` and a new club starts.

## Build-time switches (env vars)

Both are **empty by default, which means nothing is sent anywhere.** Set them in Vercel → Settings →
Environment Variables (Production only), then redeploy. They are baked into the page at build time.

| Var | What it turns on |
| --- | --- |
| `DERBY_TELEMETRY_URL` | Anonymous usage counts (below) are POSTed here with `navigator.sendBeacon`. |
| `DERBY_ERROR_URL` | Crash details (the same text as "Copy error details") are POSTed here, at most 3 a page load, never the same message twice. |
| `DERBY_RELAY_URL` | Turns the Online button on (see "Online relay" below). Its origin is added to the page's CSP `connect-src` automatically. |
| `DERBY_BUILD_ID` | Optional. Defaults to the commit (`VERCEL_GIT_COMMIT_SHA` on Vercel, else `git rev-parse`), else a timestamp. |

Both endpoints receive `Content-Type: text/plain` (a "simple" request, so no CORS preflight) with a JSON body.
A beacon ignores the response, so return `204` quickly.

```
telemetry: {"v":1,"iid":"<random uuid>","events":[{"name":"match_end","t":1761300000000,"kind":"Ranked","score":[2,1],"forfeit":false}, ...]}
errors:    {"message":"...","stack":"...","source":"error|rejection","build":"30dc935","time":"2026-10-24T09:00:00.000Z","page":"https://derby.natwong.dev/","userAgent":"..."}
```

### Suggested endpoints (pick one; none needs a change to the game)

- **Cheapest, zero servers to babysit:** a Cloudflare Worker that writes each event to Workers Analytics
  Engine (free tier is plenty), then query it with SQL. 15 lines of Worker code.
- **Stay on Vercel:** a Vercel Function at `/api/t` that inserts rows into Neon Postgres or Vercel Blob.
  Because it is the same origin, use a relative URL: `DERBY_TELEMETRY_URL=/api/t`.
- **Errors only:** a Sentry or GlitchTip "generic JSON" relay Worker, or just the same Function logging to
  Vercel's own log drain. Do not point `DERBY_ERROR_URL` at a third party that wants cookies or session replay.
- Whichever you choose: store events without IP addresses (drop `x-forwarded-for` on arrival), and keep
  them 90 days.

### The events (Phase 1 feel-lab metrics)

| Event | Properties | When |
| --- | --- | --- |
| `app_open` | none | the game booted in a tab that owns the club |
| `first_match_start` | none | the first match this browser ever started |
| `match_start` | `kind` (Ranked, Friendly, Cup, League…), `controls` (`mouse`/`keys`) | a live match kicked off |
| `match_end` | `kind`, `score` `[us, them]`, `forfeit` | the match ended (full time or forfeit) |
| `second_session` | none | the first visit more than 30 minutes after the previous one |
| `level_up` | `level` | the club level rose |
| `control_mode` | `mode` | with every `match_start`: which control scheme this match used |

This answers the roadmap's Phase 1 questions: matches started vs finished (`match_start` vs `match_end`),
second-session rate, mouse vs keys, goals per match (`score`).

## Privacy note (also fit to paste into a privacy page)

**By default Derby Day collects nothing.** Your club is stored in your own browser (localStorage) and never
leaves it. There are no accounts, no cookies, no analytics scripts, no ads.

If the owner turns on telemetry (`DERBY_TELEMETRY_URL`):

- It sends only the counts in the table above: event name, a timestamp, and the numbers listed. **No club name,
  player names, free text, IP-derived location or fingerprinting.**
- The only identifier is a random install id (`derbyday.iid.v1` in localStorage), created the first time an
  event is sent. It is not linked to a person, a device or another site; clearing site data resets it.
- It is **silent when the browser sends Do Not Track or Global Privacy Control**, and a "Don't send anonymous
  usage counts" checkbox in Club → Back up or restore turns it off for good (`derbyday.telemetry.off`).
  The checkbox only appears in builds that have telemetry compiled in.
- No cookies are set. Events leave in batches (every 15 s, and when the tab is hidden) with `sendBeacon`.

If the owner turns on error reporting (`DERBY_ERROR_URL`): a crash sends its message, a trimmed stack, the
build id, the browser's user-agent string and the page address without any query string. Never the save.

Third parties today: Google Fonts (Barlow, Big Shoulders Display, Permanent Marker) are loaded from Google by
the player's browser, which tells Google the visitor's IP. If that matters for your audience (EU), self-host
the three families and delete the `<link>` in `src/client/page.html`; the game already looks right on its
system-font fallbacks without them.

## Save safety (what players are protected from)

- **One tab owns the club.** Ownership is a Web Lock (`derby-day-owner`) held while the tab owns the club: taking
  it is atomic across tabs, and the browser releases it when the tab closes or crashes, so a fresh page can claim
  the club immediately (about 0.3 s including page load, measured). Where Web Locks is missing (old browsers, an
  opaque-origin sandbox) a localStorage lease (`derbyday.lease.v1`, 2 s heartbeat) plus a BroadcastChannel do the
  job: a new tab first pings the lease holder and claims if nothing answers within 400 ms (so a closed or crashed
  owner is replaced at once, not after a heartbeat), and if two tabs ever both hold it, **the lowest tab id keeps
  it**: every heartbeat, claim message and storage event re-checks, so it converges within a heartbeat. A second
  tab shows "Derby Day is open in another tab" instead of booting, with **Play here instead** (asks the owner to
  hand over; the owner refuses while a *match* is on screen, and the asking tab waits, so a result is never lost;
  menus and first-run setup do not block it) and **Use as a guest tab** (the game runs read-only, which is what
  Link play's second tab needs).
- **The guard cannot hang the page or a hand-over.** Boot never waits more than 3 s for the browser's lock manager (if it
  does not answer, the lease takes over, and a lock it grants late is released at once). A page that finds the lock held
  waits 0.8 s for it before deciding another tab owns the club, because a reload (and the reload that ends "Play here
  instead") starts while the page it replaces is still letting go. A hand-over asks the owner (1.5 s), then waits up to 3 s for
  the lock to come free (an owner that closes or crashes releases it at once), and only then takes it by force.
- **Saves are written defensively.** Each write first copies the previous readable save to
  `derbyday.save.v1.bak`. A save that fails validation on load is replaced by the backup (the unreadable text
  is kept as `derbyday.save.v1.corrupt` for support) and the player is told. A full disk (quota) or blocked
  storage shows a toast on every failed save; a full disk first gives up the backup to make room.
- **Guest tabs and imports.** A guest tab (read-only second tab) cannot restore a backup, and its writes, telemetry and
  crash recovery are all off. Two tabs opened in the same instant settle within about 120 ms: the one whose lease write
  landed last keeps the club.
- **What a backup holds.** The club only (`derbyday.save.v1`). Per-browser settings (`derbyday.prefs.v1`, replays, mute, `derby-renderer`, `derby-quality`, `derby-zoom`, `derby-instant-replays`, camera) stay in the browser they were set in: they are device preferences, never touched by import, and the tab guard only manages the club's lease. Imports are treated as hostile input (backup codes get shared): colours must be `#rrggbb`, club codes 1-4 capitals/digits, ids `[A-Za-z0-9_-]`, and any string containing `<`, `>`, a quote, a backtick or a control character anywhere in the file is refused.
- **Durable storage.** After the first successful save the game asks the browser once for persistent storage (`navigator.storage.persist()`; skipped on Firefox, where it would show a permission prompt, and never from a guest tab). Chromium and Safari decide silently. Even so, a browser can lose a site's whole localStorage (storage pressure, "clear site data", a corrupt profile; we measured about 1 whole-store loss in 40 brand-new Chromium profiles after a close and relaunch, in a test with no game code at all). That is one more reason to tell players to use Back up, and why the launch checklist asks you to say so when you announce.
- **Test flag.** The e2e harness lifts the tab guard for one page by setting `window.__e2eSkipTabGuard === true` (tests/e2e/lib/helpers.cjs `openSecondPage`, used by `openApp` and `nextVisit`); `window.__e2e` alone does not. Nothing in the shipped page sets them.
- **Back up your club** (Club tab → Back up or restore): downloads `derby-day-<club>-<date>.json`, or shows a
  copyable code (`DD1.` + gzip, base64url). Compressed imports are read in chunks and cancelled as soon as their
  expanded output exceeds 20 MB (20,000,000 bytes), before UTF-8 decoding or JSON parsing. Oversized codes get a size error;
  incomplete or damaged gzip streams get a damaged-code error. Restore checks every field of the backup (players, lineup, ladder, colours, number ranges) and dry-runs the game's boot
  and every screen on it before offering the confirm button, previews the club's name, level and record, says what
  it will replace, and keeps the old club under `derbyday.save.v1.pre-import` so a wrong restore can be undone from the same dialog ("Swap back to …"). After writing, it reads the club and the safety copy back; if either differs from what was written it shows an error and does not reload. A successful restore shows "Restoring…" and reloads after 300 ms, so the browser has time to flush storage before the next page opens (a reload straight after the write can open the old club). If a club ever crashes the game right
  at start-up, the crash panel offers "Restore my previous club" from that copy or the rolling backup. A full disk
  gives up the safety copies (unreadable-save copy, pre-import copy, rolling backup, in that order) before it gives up
  on the save.

## Crash safety

`src/client/errors.ts` installs `error` and `unhandledrejection` handlers before anything else. A real error
replaces the screen with "Something went wrong" (Reload, Copy error details). It shows once, never reloads by
itself, ignores browser noise (ResizeObserver loop, extension "Script error.", aborted audio plays), and
the details contain no personal data.

## Performance

- `bun run size` (also in CI) fails if `dist/index.html` is over its budget (1,252,000 bytes: the size when the
  check was added, 1,001,948, plus 25%). Raise `BUDGET_BYTES` in `scripts/size-budget.ts` only with a reason.
- `NODE_PATH="$(npm root -g)" node scripts/perf-probe.cjs [runs] [cpuRate]` measures first paint and
  time-to-interactive in headless Chromium with the CPU slowed (default 4x). Numbers at the time of writing are
  in the launch PR description (platform stream). Web fonts never block first paint: the font stylesheet loads as `media=print`
  and is switched on when it arrives.
- Without WebGL the match view falls back to the 2D renderer and says so once.

## Regenerating the images

`static/icons/*.png` and `static/og.png` are committed; `bun run build` needs no browser. After editing
`static/icons/favicon.svg` or `scripts/share-template.html` run
`NODE_PATH="$(npm root -g)" node scripts/make-assets.cjs` and commit the result.

## Launch checklist

Before telling people:

- [ ] `main` is green in CI and the latest production deploy is the commit you expect (the build id is in
      "Copy error details" and in the service worker's cache name).
- [ ] Open https://derby.natwong.dev/ in a clean browser profile: first paint is quick, first-run setup works,
      a ranked match plays to full time on a mid-range phone and on a laptop with no GPU.
- [ ] DevTools → Application: manifest has no warnings, a service worker is active, "Offline" reloads the game.
- [ ] Paste the URL into a Slack/Discord/iMessage/X/LinkedIn preview (or opentagparser.com style tools): the
      share image and title show up.
- [ ] Install it (Chrome: the install icon; iOS: Share → Add to Home Screen): the icon and name are right.
- [ ] Two tabs: the second one shows the "open in another tab" screen.
- [ ] Back up your club, wipe site data, restore the file.
- [ ] Decide telemetry: set `DERBY_TELEMETRY_URL` and `DERBY_ERROR_URL` (above) or leave them empty. If set,
      watch the first hour of events arrive and publish the privacy note.
- [ ] Add the privacy note and a contact address wherever you announce it.
- [ ] Know your rollback (above) and who can press it.
- [ ] Custom domain: DNS for `derby.natwong.dev` points at Vercel, HTTPS is green (service workers need HTTPS).
- [ ] Expect: saves are per browser (no accounts yet), so tell players to use Back up if they care about a club.

## Online relay (Vercel switch and the separate service)

(From the online stream.)

### The game side (Vercel)

- Deploys from `main` to `derby.natwong.dev` (`vercel.json`: install Bun, `bun run build`, serve `dist/`). Only `dist/` is deployed, so files such as `fly.toml` and `server/` are never served.
- **`DERBY_RELAY_URL` is what turns online play on.** It is read when Vercel builds the game (`scripts/build.ts`). While it is empty (the default), nobody sees the **Online** button and invite links do nothing. Set it in Vercel under project settings → Environment Variables, e.g. `wss://relay.derby.natwong.dev/ws`, then redeploy. Clearing it and redeploying switches online play off again without touching the relay.

### The relay service

- A small Bun WebSocket server in `server/`, deployed on its own because Vercel can't hold WebSockets open. The recommended host is Fly.io, with `fly.toml` in the repo root. Steps, logs, redeploys, cost and rollback: [ONLINE.md, "Deploy on Fly.io"](ONLINE.md#deploy-on-flyio).
- Health: `GET https://<relay>/health` answers `{"ok":true,...}` with room and socket counts.
- A relay restart or redeploy ends the online matches in progress. Friendlies record nothing, so nothing is lost.
