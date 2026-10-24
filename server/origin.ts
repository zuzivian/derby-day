/** Origin check for WebSocket upgrades. An empty allow-list allows every origin. */
export function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (!allowed.length) return true;
  return origin !== null && allowed.includes(origin.replace(/\/$/, ''));
}
