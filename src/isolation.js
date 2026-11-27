/**
 * Cross-origin isolation lets the physics share memory between threads, so big
 * simulations can use every CPU core. Servers that send the COOP/COEP headers (like
 * `npm start`) are isolated already; elsewhere (GitHub Pages) a small service worker
 * adds the headers, and the page reloads once so they take effect.
 */

/** Session flag: we already reloaded once for the service worker. */
const RELOADED = "nbody.isolation-reloaded";

export function ensureCrossOriginIsolation() {
	if (globalThis.crossOriginIsolated || !window.isSecureContext) return;
	if (!("serviceWorker" in navigator)) return;
	const container = navigator.serviceWorker;
	// The app may tidy the address bar (dropping a share link's #s=…) before the
	// service worker takes over; reload the address the page was opened with.
	const opened = location.href;
	const reloadOnce = () => {
		try {
			// If the headers still don't make the page isolated (a browser that doesn't
			// support it this way), stay single-threaded rather than reload forever.
			if (sessionStorage.getItem(RELOADED)) return;
			sessionStorage.setItem(RELOADED, "1");
		} catch {
			return; // no storage to remember the reload in: don't risk a loop
		}
		if (location.href !== opened) history.replaceState(history.state, "", opened);
		location.reload();
	};
	container
		.register(new URL("../coi-sw.js", import.meta.url))
		.then(() => {
			// Already controlled but not isolated: the headers came too late for this load.
			if (container.controller) reloadOnce();
			else container.addEventListener("controllerchange", reloadOnce, { once: true });
		})
		.catch((error) => console.warn("Cross-origin isolation unavailable:", error));
}
