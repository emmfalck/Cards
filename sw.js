// Card Scanner service worker
// 1) keeps the app working offline (after the first visit)
// 2) serves contact.vcf?d=… so iPhone opens the "Create New Contact" sheet
const VERSION = "cardscan-v1";
const SHELL = ["./", "index.html", "app.js", "parse.js", "manifest.json", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== "cardscan-cdn").map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function fromB64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  // generated contact card
  if (url.origin === location.origin && url.pathname.endsWith("/contact.vcf")) {
    try {
      const body = fromB64url(url.searchParams.get("d") || "");
      const name = (url.searchParams.get("n") || "contact").replace(/[^\w\-]/g, "_") + ".vcf";
      e.respondWith(new Response(body, {
        headers: { "Content-Type": "text/vcard; charset=utf-8", "Content-Disposition": `inline; filename="${name}"` }
      }));
    } catch {
      e.respondWith(new Response("Bad contact", { status: 400 }));
    }
    return;
  }

  if (e.request.method !== "GET") return;

  // app files: network first (so updates arrive), cache when offline
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(e.request).then(r => {
        if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
        return r;
      }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html")))
    );
    return;
  }

  // the text-reading library (cache after first download)
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(
      caches.open("cardscan-cdn").then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => {
        if (r.ok) c.put(e.request, r.clone());
        return r;
      })))
    );
  }
});
