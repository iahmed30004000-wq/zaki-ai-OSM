/**
 * THE SERVICE WORKER — AND THE ONE THING IT MUST NEVER DO.
 *
 * A service worker's usual trick is to hold on to a failed request and
 * replay it when the network comes back. In this system that trick writes
 * money. An agent taps "confirm" in a lift with no signal, the request is
 * queued, and forty minutes later — after somebody else cancelled the
 * order, after the stock was given to another customer, after the shift
 * ended — it fires. A wallet movement, a shipment, a commission accrual,
 * all from a tap nobody remembers making against a world that has moved.
 *
 * So: this worker NEVER touches a request that changes anything. No POST,
 * no PATCH, no PUT, no DELETE is intercepted, cached, retried or queued.
 * Offline, they fail — loudly, immediately, in front of the person who made
 * them, who is the only one who can decide what to do instead.
 *
 * What it does do is keep the shell readable: the app opens, the screens
 * draw, and a clear line says the connection is gone. Reading something
 * slightly stale while disconnected is useful. Writing something silently
 * later is not.
 */

const VERSION = 'v3';
const SHELL = `shell-${VERSION}`;
const OFFLINE_URL = '/offline.html';

/**
 * HOW LONG A PAGE MAY TAKE BEFORE THE PERSON IS TOLD.
 *
 * A server that is down answers at once and the offline page follows. A
 * server that is busy — right after a deploy, while the build starves it —
 * may hold the request open for minutes, and the tab draws nothing at all:
 * a white screen that looks like the system has died. Past this long the
 * person gets the page that says the server is not answering, which comes
 * back by itself.
 */
const NAVIGATION_TIMEOUT_MS = 20_000;

/**
 * ONE CACHE PER BUILD FOR THE FRAMEWORK'S FILES.
 *
 * `/_next/static/` used to go into the one shell cache, whose name never
 * changed, so every deploy's files piled up on the phone beside the last
 * one's, for ever. Each build now stamps its files with its own id
 * (`?dpl=<id>`, from `deploymentId` in next.config.ts), and the files go
 * into a cache named after that id. The first file of a NEW build that
 * arrives empties every other build's cache: from then on this phone holds
 * one build's files, the one it is running.
 *
 * A build without an id (none set) shares one fixed cache, exactly as
 * before. Only a good answer opens a cache, so an old tab asking for a file
 * the new build no longer has gets its 404 and empties nothing.
 */
const STATIC_PREFIX = 'static-';

function staticCacheName(url) {
  const id = url.searchParams.get('dpl');
  return STATIC_PREFIX + (id && /^[\w.-]{1,128}$/.test(id) ? id : 'unversioned');
}

let currentStatic = null;

async function openStaticCache(name) {
  if (currentStatic !== name) {
    currentStatic = name;
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith(STATIC_PREFIX) && k !== name).map((k) => caches.delete(k))
    );
  }
  return caches.open(name);
}

/** Only what is safe to serve from yesterday. */
const PRECACHE = [OFFLINE_URL, '/logo.svg', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/** Anything that is not a plain read. */
function changesSomething(request) {
  return request.method !== 'GET' && request.method !== 'HEAD';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // THE RULE. Not intercepted at all: no cache, no retry, no queue. The
  // browser's own failure reaches the code that made the call, which is the
  // only place that knows what the person was trying to do.
  if (changesSomething(request)) return;

  // An API read is never served stale — a stale order list is a list
  // somebody acts on. It either comes from the network or it fails, and the
  // screen says which.
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return;

  // Navigations: network first, and the offline page when there is none —
  // or when the server has not answered in NAVIGATION_TIMEOUT_MS. A page is
  // a read, so giving up on one loses nothing.
  //
  // A race, not an AbortSignal: `fetch(request, { signal })` would build a
  // NEW request from the navigation one, and a non-empty init turns its
  // mode from 'navigate' into 'same-origin' — the sign-in redirect and the
  // browser's own navigation handling ride on that mode. The request goes
  // out exactly as the browser made it; only the wait is limited. Once the
  // headers are in, the page streams as long as it needs.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        let timer;
        const late = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('navigation timed out')), NAVIGATION_TIMEOUT_MS);
        });
        try {
          return await Promise.race([fetch(request), late]);
        } catch {
          const cache = await caches.open(SHELL);
          return (await cache.match(OFFLINE_URL)) ?? Response.error();
        } finally {
          clearTimeout(timer);
        }
      })()
    );
    return;
  }

  /**
   * Cache first ONLY for what can never change under its own URL.
   *
   * This used to cover every .js and .css by extension, and that was wrong
   * in a way that broke the app: a chunk whose NAME stays the same while
   * its contents change — which is every chunk in development, and any
   * unhashed file in production — was then served from yesterday. The page
   * asked for a module the old chunk knew about, the new build no longer
   * had it, and the screen died with "module factory is not available".
   *
   * `/_next/static/` is content-hashed by the framework: a changed file has
   * a changed URL, so a hit is always the right bytes. Fonts under /fonts/
   * are versioned by hand and never edited in place. Everything else goes
   * to the network first, because being one request slower is nothing and
   * being one deploy stale is a white screen.
   */
  const immutable =
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/_next/static/') ||
      url.pathname.startsWith('/fonts/') ||
      url.pathname.startsWith('/icons/') ||
      /\.(?:woff2?|png|svg|ico)$/.test(url.pathname));

  if (immutable) {
    // The framework's files go to their build's own cache; fonts and icons
    // stay in the shell cache, where nothing replaces them.
    const framework = url.pathname.startsWith('/_next/static/');
    const name = framework ? staticCacheName(url) : SHELL;
    event.respondWith(
      caches.match(request, { cacheName: name }).then(
        (hit) =>
          hit ??
          fetch(request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              (framework ? openStaticCache(name) : caches.open(SHELL))
                .then((cache) => cache.put(request, copy))
                .catch(() => undefined);
            }
            return res;
          })
      )
    );
  }
});
