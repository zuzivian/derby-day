// Where the relay lives, if anywhere. The build bakes in DERBY_RELAY_URL
// (scripts/build.ts; empty by default, so the Online option stays hidden
// until a relay is deployed). ?relay=wss://... in the page address overrides
// it, but only on a local page (file:, localhost, 127.0.0.1): on the real
// site a link with ?relay= would send players to someone else's server.
// Only ws: and wss: URLs are accepted.

declare const __DERBY_RELAY_URL__: string | undefined;

export interface RelayConfig {
  url: string;
  /** Came from ?relay= (so invite links should carry it along). */
  fromQuery: boolean;
}

const BUILT_IN = typeof __DERBY_RELAY_URL__ === 'string' ? __DERBY_RELAY_URL__ : '';

function wsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'ws:' || u.protocol === 'wss:' ? u.href : null;
  } catch {
    return null;
  }
}

/** A page where ?relay= may be honoured: a local file or a local dev server. */
export function isLocalPage(loc: { protocol: string; hostname: string }): boolean {
  return loc.protocol === 'file:' || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(loc.hostname);
}

const here = () => (typeof location === 'undefined' ? { protocol: 'file:', hostname: '', search: '' } : location);

export function relayConfig(loc: { protocol: string; hostname: string; search: string } = here(), builtIn: string = BUILT_IN): RelayConfig | null {
  const q = isLocalPage(loc) ? wsUrl(new URLSearchParams(loc.search).get('relay')) : null;
  if (q) return { url: q, fromQuery: true };
  const b = wsUrl(builtIn);
  return b ? { url: b, fromQuery: false } : null;
}

/** The ?join= code in the page address, if any (cleaned, upper case). */
export function inviteCode(search: string = typeof location === 'undefined' ? '' : location.search): string | null {
  const raw = new URLSearchParams(search).get('join');
  const code = raw ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : '';
  return code.length >= 4 ? code : null;
}

/**
 * The link a host sends a friend: this page with ?join=CODE (and the ?relay=
 * override, when that is how the relay was set). On https://derby.natwong.dev
 * that is https://derby.natwong.dev/?join=CODE.
 */
export function inviteLink(code: string, cfg: RelayConfig, loc: { origin: string; pathname: string; href: string } = location): string {
  const base = loc.origin && loc.origin !== 'null' ? `${loc.origin}${loc.pathname === '/index.html' ? '/' : loc.pathname}` : loc.href.split(/[?#]/)[0];
  const q = new URLSearchParams({ join: code });
  if (cfg.fromQuery) q.set('relay', cfg.url);
  return `${base}?${q.toString()}`;
}
