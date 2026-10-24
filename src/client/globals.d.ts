// Build-time constants, replaced by scripts/build.ts (Bun's `define`). Read them through buildConfig()
// in build-config.ts: under `bun test` they are not defined at all.
declare const __BUILD_ID__: string;
declare const __ERROR_URL__: string;
declare const __TELEMETRY_URL__: string;
