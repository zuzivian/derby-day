// Where the relay lives, if anywhere. The build bakes in DERBY_RELAY_URL
// (scripts/build.ts; empty by default, so the Online option stays hidden
// until a relay is deployed), and ?relay=wss://... in the page address
// overrides it for testing. Only ws: and wss: URLs are accepted.

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

export function relayConfig(search: string = typeof location === 'undefined' ? '' : location.search, builtIn: string = BUILT_IN): RelayConfig | null {
  const q = wsUrl(new URLSearchParams(search).get('relay'));
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
