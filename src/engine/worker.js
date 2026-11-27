// Web Worker entry point: runs the physics off the main thread so heavy simulations
// never make scrolling, aiming or the UI stutter.
import { Engine } from "./engine.js";
import { ThreadPool } from "./threadPool.js";

/** @typedef {import('./engine.js').Command} Command */

const engine = new Engine();
// On a cross-origin isolated page, big systems use every spare core.
const pool = ThreadPool.create();
if (pool) engine.useThreadPool(pool);

self.addEventListener("message", (event) => {
	const command = /** @type {Command} */ (/** @type {MessageEvent} */ (event).data);
	try {
		const frame = engine.handle(command);
		if (frame) {
			const transfer = [frame.data.buffer];
			if (frame.quadTree) transfer.push(frame.quadTree.buffer);
			self.postMessage(frame, { transfer });
		}
	} catch (error) {
		self.postMessage({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
			// The main thread waits for a reply to every advance; never leave it hanging.
			frame: command.type === "advance" ? engine.frame() : null,
		});
	}
});

self.postMessage({ type: "ready" });
