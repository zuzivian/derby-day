# three.js (vendored)

- Version: **r186** (`three@0.186.1`), MIT licence (see `LICENSE`).
- Source: the official build, `build/three.module.js` and `build/three.core.js`, copied unchanged.
- Used by the 3D match renderer in `src/client/r3d/` (imported only through `src/client/r3d/three.ts`).
  Bun bundles and tree-shakes it into the single-file build; there is no npm dependency.
- `three.module.d.ts` is a small hand-written declaration file for the parts the game uses
  (it is not `@types/three`). Unlisted members fall through to `any`; add types there as you use more.
- Nothing from `examples/jsm` is used.

To upgrade: replace the two `.js` files and `LICENSE` from a newer three.js release, update the version above,
then run `bun run check` and `bun run e2e` (the shaders patched in `src/client/r3d/stadium.ts` rely on the
`begin_vertex` and `color_vertex` chunks).
