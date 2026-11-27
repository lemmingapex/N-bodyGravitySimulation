import { Worker as NodeWorker } from "node:worker_threads";

/**
 * A Web Worker look-alike for Node: runs the browser worker script at `url` in a
 * real Node thread (see nodeWorker.js).
 *
 * @param {URL} url
 * @returns {Worker}
 */
export function spawnNodeWorker(url) {
	const thread = new NodeWorker(new URL("./nodeWorker.js", import.meta.url), {
		workerData: { url: url.href },
	});
	thread.unref(); // don't keep the test process alive
	const worker = {
		addEventListener(/** @type {string} */ type, /** @type {(e: any) => void} */ listener) {
			if (type === "message") thread.on("message", (data) => listener({ data }));
			if (type === "error") {
				thread.on("error", (error) =>
					listener({
						message: error instanceof Error ? error.message : String(error),
						preventDefault() {},
					}),
				);
			}
		},
		postMessage: (/** @type {unknown} */ data) => thread.postMessage(data),
		terminate: () => void thread.terminate(),
	};
	return /** @type {any} */ (worker);
}
