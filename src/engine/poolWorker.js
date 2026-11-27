// A helper thread of the thread pool (see threadPool.js): woken once per run, it
// claims and does chunks of the job (forces, collision search or tree building).
import { JOBS } from "./jobs.js";
import { CONTROL, work } from "./threadPool.js";

/** @typedef {import('./jobs.js').JobName} JobName */
/** @typedef {import('./jobs.js').ThreadContext} ThreadContext */

/** @type {Int32Array | null} */
let control = null;
/** @type {ThreadContext} */
const thread = { index: 0, scratch: {} };
/** Each job's shared data, as last received. @type {Map<JobName, unknown>} */
const data = new Map();

self.addEventListener("message", (event) => {
	const message = /** @type {any} */ (/** @type {MessageEvent} */ (event).data);
	if (message.init) {
		thread.index = message.init.index;
		control = message.init.control;
		return;
	}
	const job = /** @type {JobName} */ (message.job);
	if (message.shared) data.set(job, message.shared);
	if (!control || !data.has(job)) return;
	// Counted as busy before claiming anything, so the physics worker waits for us.
	Atomics.add(control, CONTROL.ACTIVE, 1);
	try {
		work(control, message.generation, JOBS[job], data.get(job), thread);
	} finally {
		Atomics.sub(control, CONTROL.ACTIVE, 1);
		Atomics.notify(control, CONTROL.ACTIVE);
	}
});
