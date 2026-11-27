// Runs a browser worker script (one using `self.addEventListener("message", …)`) in
// a Node worker thread, so code built on Web Workers and shared memory can be
// tested with real threads. Started by `spawnNodeWorker`.
import { parentPort, workerData } from "node:worker_threads";

const port = /** @type {import('node:worker_threads').MessagePort} */ (parentPort);
/** @type {any} */ (globalThis).self = {
	addEventListener: (/** @type {string} */ type, /** @type {(e: any) => void} */ listener) => {
		if (type === "message") port.on("message", (data) => listener({ data }));
	},
	postMessage: (/** @type {unknown} */ data) => port.postMessage(data),
};
await import(workerData.url);
