// Service worker that makes the page cross-origin isolated on hosts that can't send
// the headers themselves (such as GitHub Pages): it adds COOP and COEP to every
// same-origin response. Isolation lets the physics share memory between threads
// (SharedArrayBuffer), so big simulations can use every CPU core.
//
// It caches nothing: every request still goes to the network as usual.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (new URL(request.url).origin !== self.location.origin) return;
	// Can't be fetched from here (a quirk of some DevTools requests): leave it alone.
	if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
	event.respondWith(
		fetch(request).then((response) => {
			if (response.status === 0) return response; // opaque: headers can't be changed
			const headers = new Headers(response.headers);
			headers.set("Cross-Origin-Opener-Policy", "same-origin");
			headers.set("Cross-Origin-Embedder-Policy", "require-corp");
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}),
	);
});
