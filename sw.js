/* Offline cache for Patient Logger. Bump VERSION whenever any file changes. */
var VERSION = "pl-v1.1.0";
var FILES = ["./", "./index.html", "./style.css", "./app.js", "./parser.js", "./vendor/xlsx.full.min.js",
  "./manifest.webmanifest", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).catch(function () {
        if (e.request.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      });
    })
  );
});
