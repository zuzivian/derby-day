# Round 1b repro scripts

These are the finders' and verifiers' scripts. They were written against a worktree of main 12e8e1d at /tmp/rt/<lens>/repo, and they import from that path or from ../repo.

To reuse a script:
1. Copy it into a scratch folder.
2. Point its imports at your own checkout. For example: `sed -i 's#/tmp/rt/rules/repo#'"$PWD"'#g' file.ts`.
3. Run it with `/root/.bun/bin/bun file.ts`, or with `NODE_PATH=/opt/node22/lib/node_modules node file.cjs` for the browser scripts.

Each finding's `repro` field in ../<lens>.json names the script and the arguments to pass it.
