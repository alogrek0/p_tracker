/*
 * sw.js  (service worker for the p_tracker pill ledger)
 *
 * READ THIS BEFORE EDITING. This file has one job beyond ordinary offline
 * caching: it must forcibly take over from a DIFFERENT, older app that was
 * deployed at this exact URL (https://alogrek0.github.io/p_tracker/) and is
 * still registered as a service worker on the user's phone.
 *
 * The takeover, in short:
 *
 *   1. This file lives at ./sw.js, the same path the old worker used. The
 *      browser only ever looks for updates at the path that was originally
 *      registered, so if we moved or renamed this file the old worker would
 *      never be replaced. Do not move it.
 *
 *   2. The page registers it with { updateViaCache: "none" } so the browser
 *      fetches sw.js from the network on every update check instead of
 *      trusting its HTTP cache. See src/sw-register.js.
 *
 *   3. On install we call self.skipWaiting() so this worker does not sit in
 *      the "waiting" state until every old tab closes. On a home-screen PWA
 *      that can effectively be forever.
 *
 *   4. On activate we call self.clients.claim() so already open pages are
 *      controlled by this worker immediately, then we delete EVERY cache that
 *      is not ours. That explicitly includes the legacy "pill-ledger-<n>"
 *      caches (the old app got as far as pill-ledger-v10). Those caches hold
 *      a dead application. If they survived, the old cache-first worker's
 *      leftovers could still be served, and offline the user would see the
 *      old app with no way to get out of it short of deleting the icon.
 *
 * Bump VERSION on every shipped change to any precached file (CLAUDE.md
 * invariant 8). The cache name is derived from it, so a bump is exactly what
 * makes the next activate throw away the previous shell.
 */

const VERSION = "2";
const CACHE_NAME = `ptracker-shell-v${VERSION}`;

/*
 * Everything is RELATIVE. GitHub Pages serves this app from /p_tracker/, not
 * from the origin root. A root-relative path like "/src/ui.js" would resolve
 * to https://alogrek0.github.io/src/ui.js, which is a 404, while looking
 * perfectly fine on a localhost dev server rooted at the project. Relative
 * URLs are resolved against this worker's own location, so "./src/ui.js"
 * becomes /p_tracker/src/ui.js in production and whatever the dev path is
 * locally.
 *
 * The full ES module graph must be enumerated here. A service worker does
 * not parse JavaScript and will never discover `import` statements on its
 * own. If a module is added to the app and not to this list, the app will
 * appear to work while online and then fail on a cold offline launch with a
 * failed module fetch. When you add a module under src/, add it here too.
 */

// The app shell. If any of these fail to cache, the install FAILS on purpose:
// a shell missing one module is worse than no new worker at all, because it
// would activate, claim the page, and then serve a broken offline app.
const SHELL_URLS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./src/main.js",
  "./src/state.js",
  "./src/ledger.js",
  "./src/ui.js",
  "./src/export.js",
  "./src/sw-register.js",
];

// Nice-to-have assets. A missing icon must not block the takeover, so these
// are cached one at a time and a failure is logged rather than thrown.
// cache.addAll() is atomic (one failure rejects the whole call), which is
// exactly why icons are kept out of SHELL_URLS.
const OPTIONAL_URLS = [
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
];

/*
 * Fetch each shell URL with cache: "reload" so precaching bypasses the HTTP
 * cache and we never seed the new cache with a stale copy that the old
 * deployment left in the browser's HTTP cache.
 */
async function precacheShell(cache) {
  const requests = SHELL_URLS.map((url) => new Request(url, { cache: "reload" }));
  const responses = await Promise.all(requests.map((req) => fetch(req)));
  responses.forEach((res, i) => {
    if (!res.ok) {
      throw new Error(`[sw] shell asset failed: ${SHELL_URLS[i]} (${res.status})`);
    }
  });
  await Promise.all(requests.map((req, i) => cache.put(req, responses[i])));
}

async function precacheOptional(cache) {
  await Promise.all(
    OPTIONAL_URLS.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: "reload" }));
        if (res.ok) {
          await cache.put(url, res);
        } else {
          console.warn(`[sw] optional asset skipped: ${url} (${res.status})`);
        }
      } catch (err) {
        console.warn(`[sw] optional asset skipped: ${url}`, err);
      }
    })
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await precacheShell(cache);
      await precacheOptional(cache);
      // Do not wait for old tabs or the old worker to go away. Takeover step 3.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      /*
       * Takeover step 4. Delete every cache that is not the current one.
       *
       * This is intentionally "everything except ours" rather than a
       * prefix match on "ptracker-shell-". The legacy app used the prefix
       * "pill-ledger-" (pill-ledger-v1 ... pill-ledger-v10) and a prefix
       * filter on OUR name would leave those alone. They belong to a dead
       * app and nothing else on this origin is entitled to a cache, so the
       * safe rule is: if it is not CACHE_NAME, it goes.
       *
       * The explicit isLegacy check is redundant with that rule. It exists so
       * that anyone who later "tidies" this into a prefix match still sees,
       * in code, that the pill-ledger-* caches must be removed.
       */
      const names = await caches.keys();
      await Promise.all(
        names.map((name) => {
          const isCurrent = name === CACHE_NAME;
          const isLegacy = name.startsWith("pill-ledger-");
          if (isCurrent) return Promise.resolve(false);
          if (isLegacy) {
            console.info(`[sw] removing legacy cache from previous app: ${name}`);
          }
          return caches.delete(name);
        })
      );

      // Take control of every open page right now, including the page that
      // registered us, so its very next fetch goes through this worker.
      await self.clients.claim();

      // Tell the pages a new worker is in charge so the UI can offer a reload.
      const clientList = await self.clients.matchAll({ includeUncontrolled: true });
      for (const client of clientList) {
        client.postMessage({ type: "SW_ACTIVATED", version: VERSION });
      }
    })()
  );
});

/*
 * Fetch strategy.
 *
 *   Navigations  -> app shell from cache, network as fallback. This is what
 *                   makes a cold standalone launch work in airplane mode.
 *                   We serve "./index.html" regardless of the requested
 *                   path within scope, since this is a single page app.
 *   Same-origin  -> cache first, then network (and stash the network copy).
 *                   The shell is versioned, so "cache first" is correct: a
 *                   VERSION bump is what invalidates it.
 *   Cross-origin -> not our business; let the browser handle it.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function handleNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  const shell = (await cache.match("./index.html")) || (await cache.match("./"));
  if (shell) return shell;

  // Nothing precached (should not happen after a successful install, but be
  // honest rather than returning a fabricated page): go to the network.
  try {
    return await fetch(request);
  } catch (err) {
    return new Response("Offline and the app shell is not cached yet.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;

  const res = await fetch(request);
  if (res && res.ok && res.type === "basic") {
    // Clone before the body is consumed by the page.
    cache.put(request, res.clone()).catch(() => {
      /* quota or opaque failures are not worth failing the request over */
    });
  }
  return res;
}

// Allow the page to ask a waiting worker to activate. With skipWaiting()
// already in install this is belt and braces, but it costs nothing and gives
// the UI an explicit lever if a future version ever drops the automatic skip.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
