# Operations

What the running game depends on, and the switches the owner controls.

## The game (Vercel)

- Deploys from `main` to `derby.natwong.dev` (`vercel.json`: install Bun, `bun run build`, serve `dist/`). Only `dist/` is deployed, so files such as `fly.toml` and `server/` are never served.
- **`DERBY_RELAY_URL` is what turns online play on.** It is read when Vercel builds the game (`scripts/build.ts`). While it is empty (the default), nobody sees the **Online** button and invite links do nothing. Set it in Vercel under project settings → Environment Variables, e.g. `wss://relay.derby.natwong.dev/ws`, then redeploy. Clearing it and redeploying switches online play off again without touching the relay.

## The online relay (separate service)

- A small Bun WebSocket server in `server/`, deployed on its own because Vercel can't hold WebSockets open. The recommended host is Fly.io, with `fly.toml` in the repo root. Steps, logs, redeploys, cost and rollback: [ONLINE.md, "Deploy on Fly.io"](ONLINE.md#deploy-on-flyio).
- Health: `GET https://<relay>/health` answers `{"ok":true,...}` with room and socket counts.
- A relay restart or redeploy ends the online matches in progress. Friendlies record nothing, so nothing is lost.
