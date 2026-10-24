// Build-time settings with safe defaults, so the same modules load under `bun test` and in the browser.

/** Short id of this build (git commit when available); shown in crash details and used to version the offline cache. */
export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
/** DERBY_ERROR_URL at build time. Empty = crash reports are never sent. */
export const ERROR_URL: string = typeof __ERROR_URL__ === 'string' ? __ERROR_URL__ : '';
/** DERBY_TELEMETRY_URL at build time. Empty = telemetry is compiled off. */
export const TELEMETRY_URL: string = typeof __TELEMETRY_URL__ === 'string' ? __TELEMETRY_URL__ : '';
