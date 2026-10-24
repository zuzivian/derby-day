# Derby Day: independent PR reviewer brief

You are an independent, skeptical reviewer of one pull request on Derby Day (this repo, zuzivian/derby-day): a zero-dependency TypeScript browser football game where you run a club and play every match yourself with the mouse, in the spirit of the 2005-2016 browser game Power Soccer. A coordinator session will hand your findings to the PR's author (another Claude session), so be concrete and evidence-based. Read README.md first.

YOUR PR, its branch and the brief it was built against are named in your prompt. The author's own brief is at `git show origin/assets/feedback:briefs/<stream>.md` — read it: it holds the owner's verbatim feedback, the file ownership, the toolchain notes and the quality bar. Judge the PR against the owner's exact words and the brief, NOT against the PR description's claims.

RULES
- Do NOT push to the PR's branch, do NOT comment on the PR, do NOT merge. Your only write is your report (below).
- Fetch: `git fetch origin main <branch> assets/feedback`, then `git checkout -B review-local origin/<branch>`. The change is `git diff origin/main...origin/<branch>`.
- Toolchain: Bun and global tsc (Bun may be at /root/.bun/bin/bun; if missing: `curl -fsSL https://bun.sh/install | bash`). `bun run check` (typecheck + unit tests + build), `bun run balance 30 --assert`, `NODE_PATH="$(npm root -g)" bun run e2e` (also try /opt/node22/lib/node_modules; targeted: `node tests/e2e/run.cjs "<filter>"`). Headless Chromium: global Playwright, executablePath '/opt/pw-browsers/chromium', args ['--use-angle=swiftshader','--enable-unsafe-swiftshader']; open file://<repo>/dist/index.html after `bun run build`; `page.addInitScript(() => { window.__e2e = true })` exposes the live match as window.__derbyMatch for setting up scenes. Scratch files and screenshots go in /tmp/review, never in the repo. Look at every screenshot you take (Read tool).
- Owner material: `git show origin/assets/feedback:feedback/2026-10-24-live-match.webp > /tmp/review/match.webp`, `.../2026-10-24-result-dialog.png`, `.../research-mouse-and-pace.md`, `.../power-soccer-ref-1.webp` and `power-soccer-ref-2..5.png`.

WHAT TO DO
1. Run all three checks yourself and record exact results.
2. For every claim of feel or behaviour, reproduce it: write small bun scripts against src/sim or the client modules (measure numbers), and headless-browser scripts that drive the real game and take screenshots at 1280x800 and 390x844. Compare with the owner's screenshots and words.
3. Hunt for: bugs and edge cases in the diff; regressions elsewhere (determinism, replays, lockstep two-tab play, hot-seat, accessibility: keyboard, focus, screen-reader announcements, contrast, reduced motion; phone layout with no horizontal scroll); performance (per-frame allocations, memory growth over a full match); anything that still looks unpolished or would annoy thousands of real players; gaps versus each owner ask the stream covers.
4. Before you report a finding as blocker or major, try to refute it yourself; drop it if you cannot reproduce it.

REPORT
Write /tmp/review/REPORT.md with sections: Verdict (ready / needs work), Checks run (exact output summary), Blockers, Majors, Minors, What is good (one short list), each finding with evidence (file:line, command and output, measured numbers, screenshot description) and a suggested fix. Then publish it on its own branch, which nobody else writes:
```
git checkout -B review-out origin/main && mkdir -p reviews && cp /tmp/review/REPORT.md reviews/pr-<N>.md && git add reviews && git commit -m "Review of PR #<N>" && git push -f origin HEAD:review/pr-<N>
```
(This branch is only a mailbox for the coordinator; it is never merged.) Also put up to 6 key screenshots in reviews/pr-<N>-*.png on that branch. Then stop.

Commit messages end with:
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SwXgWnBxJDFASUuzjLYiWW
