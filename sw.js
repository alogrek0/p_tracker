/* Pill ledger service worker.
   Bump VERSION whenever index.html or any other shell file changes. */
var VERSION = "v5";
var CACHE = "pill-ledger-" + VERSION;
var CACHE_PREFIX = "pill-ledger-";

var SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./sw.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png"
];

var FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE) return caches.delete(key);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

function isShellRequest(url) {
  var scope = self.registration.scope;
  if (url.href.indexOf(scope) !== 0) return false;
  var rel = "./" + url.href.slice(scope.length).replace(/[?#].*$/, "");
  return SHELL.indexOf(rel) >= 0;
}

function cacheFirst(request, fallbackPath) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (response && response.ok) cache.put(request, response.clone());
        return response;
      }).catch(function () {
        if (fallbackPath) return cache.match(fallbackPath);
        throw new Error("Offline and not cached: " + request.url);
      });
    });
  });
}

function networkFirst(request) {
  return caches.open(CACHE).then(function (cache) {
    return fetch(request).then(function (response) {
      if (response && (response.ok || response.type === "opaque")) cache.put(request, response.clone());
      return response;
    }).catch(function () {
      return cache.match(request).then(function (cached) {
        if (cached) return cached;
        return new Response("", { status: 504, statusText: "Offline" });
      });
    });
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;
  var url = new URL(request.url);

  if (request.mode === "navigate") {
    event.respondWith(cacheFirst(request, "./index.html"));
    return;
  }
  if (url.origin === self.location.origin && isShellRequest(url)) {
    event.respondWith(cacheFirst(request, null));
    return;
  }
  if (FONT_HOSTS.indexOf(url.hostname) >= 0) {
    event.respondWith(networkFirst(request));
    return;
  }
});
