// Derby Day service worker: lets the game open offline, and never pins an old version.
//   - The page (navigations) is network-first with a short timeout, so an online player always gets the
//     latest deploy and an offline one gets the last page that loaded.
//   - Other same-origin files (icons, manifest) are stale-while-revalidate.
//   - Each deploy changes BUILD, so the cache name changes and the old cache is deleted on activate.
// sw.js itself is served with Cache-Control: no-cache (vercel.json) so a new worker is found promptly.
const BUILD = '__BUILD_ID__';
const CACHE = 'derby-day-' + BUILD;
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/favicon.svg'];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('derby-day-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Only the game page itself is ever stored as '/': never /og.png, /404, or any other address someone navigates to. */
const isPage = (url) => url.pathname === '/' || url.pathname === '/index.html';
const isHtml = (res) => /text\/html/i.test(res.headers.get('content-type') || '');

function networkFirst(request, cacheable) {
  return new Promise((resolve) => {
    let settled = false;
    const fromCache = () => caches.match('/', { ignoreSearch: true }).then((r) => r || Response.error());
    const timer = setTimeout(() => {
      if (settled || !cacheable) return;
      fromCache().then((r) => {
        if (!settled && r && r.type !== 'error') {
          settled = true;
          resolve(r);
        }
      });
    }, NETWORK_TIMEOUT_MS);
    fetch(request)
      .then((res) => {
        if (cacheable && res.ok && isHtml(res)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
        }
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(res);
        }
      })
      .catch(() => {
        clearTimeout(timer);
        if (!settled) fromCache().then((r) => ((settled = true), resolve(r)));
      });
  });
}

function staleWhileRevalidate(request) {
  return caches.open(CACHE).then((c) =>
    c.match(request).then((hit) => {
      const net = fetch(request).then((res) => {
        if (res.ok) c.put(request, res.clone());
        return res;
      });
      return hit || net;
    }),
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname === '/sw.js') return;
  if (req.mode === 'navigate') event.respondWith(networkFirst(req, isPage(url)));
  else if (SHELL.includes(url.pathname)) event.respondWith(staleWhileRevalidate(req));
});
