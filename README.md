# Overlap

A browser football club manager where you also play the matches yourself, mouse-first. You run a generated club (squad, transfers, training, an Elo ladder) and play 6-a-side matches in real time against the CPU.

This is a prototype. The plan for turning it into an online live-service game is in [docs/ROADMAP.md](docs/ROADMAP.md).

## Play

```sh
bun run build      # writes dist/index.html, a single self-contained file
open dist/index.html
```

Or `bun run dev` to rebuild on save and serve on http://localhost:5173.

Install Bun with `curl -fsSL https://bun.sh/install | bash` (no sudo needed). There are no npm dependencies.

### Controls

| | Mouse (recommended) | Keyboard |
|---|---|---|
| Move | Your player runs to the pointer | WASD or arrows |
| Pass (with the ball) | Left click toward a teammate or space | Space |
| Tackle (without the ball) | Left click | Space |
| Shoot | Hold right button, release | Hold F, release |
| Switch player | Right click | E |
| Pause | Esc or P | Esc or P |

The dotted line shows where a click would pass right now. Phones get on-screen Pass and Shoot buttons.

## Code layout

```
src/sim/      Deterministic match engine. Pure TS, no DOM, fixed 60 Hz, seeded RNG.
              step(state, input) is the only way time moves.
src/meta/     Club layer: name generators, players and attributes, Elo, market, training, ladder.
src/client/   Browser: canvas renderer, input, match loop, management screens, local save.
scripts/      build.ts (bundle and inline into one HTML file), balance.ts (headless CPU matches).
tests/        bun test: determinism, plausible matches, Elo maths, transfers and training rules.
```

## Checks

```sh
bun run check      # typecheck + tests + build
bun run balance 50 # 50 CPU-vs-CPU matches at full speed, prints goal/shot/upset rates
```
