import { JOBS } from "./jobs.js";

/**
 * Runs physics work on several threads that share memory (`SharedArrayBuffer`,
 * available on cross-origin isolated pages): force evaluation, collision detection
 * and building the Barnes–Hut tree (see jobs.js).
 *
 * A job is split into numbered chunks. The physics worker publishes a run, wakes the
 * helpers, and then everyone (the physics worker included) claims chunks from a
 * shared counter until none are left; the physics worker waits for helpers still
 * busy. Work is claimed rather than assigned, so a slow or missing helper never stalls
 * a step: the others simply do more. Jobs write each chunk's results to their own
 * place, so the outcome never depends on which thread did what.
 *
 * @typedef {import('./jobs.js').JobName} JobName
 * @typedef {import('./jobs.js').ThreadContext} ThreadContext
 */

/** Most helper threads (besides the physics worker itself). */
const MAX_HELPERS = 7;

/** Most chunks in one run (chunk numbers share a 32-bit word with the generation). */
export const MAX_CHUNKS = 0xffff;

/** Slots of the shared control array. */
export const CONTROL = Object.freeze({
	/** `generation << 16 | next chunk`: claims only succeed for the current run. */
	CLAIM: 0,
	/** Chunks in the current run. */
	CHUNKS: 1,
	/** Helpers currently working. */
	ACTIVE: 2,
	LENGTH: 3,
});

/** Generations wrap at 15 bits (the claim word is a signed 32-bit integer). */
const GENERATION_MASK = 0x7fff;

/**
 * Claims and does chunks of run `generation` until none are left (or a newer run has
 * started). Used by the physics worker and by every helper.
 *
 * @param {Int32Array} control
 * @param {number} generation
 * @param {(shared: any, chunk: number, thread: ThreadContext) => void} job
 * @param {unknown} shared
 * @param {ThreadContext} thread
 * @returns {number} How many chunks this thread did.
 */
export function work(control, generation, job, shared, thread) {
	const chunks = Atomics.load(control, CONTROL.CHUNKS);
	let done = 0;
	for (;;) {
		const claim = Atomics.load(control, CONTROL.CLAIM);
		if (claim >>> 16 !== generation) return done; // a newer run: not ours to do
		const chunk = claim & 0xffff;
		if (chunk >= chunks) return done;
		if (Atomics.compareExchange(control, CONTROL.CLAIM, claim, claim + 1) !== claim) continue;
		job(shared, chunk, thread);
		done++;
	}
}

export class ThreadPool {
	/** Threads doing the work, the physics worker included. */
	threads;
	/** @type {Worker[]} */
	#helpers = [];
	#control = new Int32Array(new SharedArrayBuffer(CONTROL.LENGTH * 4));
	#generation = 0;
	/** Per helper: the version of each job's shared data it last received. */
	#sent = new Map();
	/** @type {ThreadContext} */
	#thread = { index: 0, scratch: {} };
	/** Chunks done by helper threads (rather than the physics worker) so far. */
	helped = 0;

	/**
	 * A pool if this context can run one: a worker (the physics thread may block while
	 * it waits) on a cross-origin isolated page with spare cores. Otherwise null.
	 *
	 * @param {(url: URL) => Worker} [spawn] Creates a helper (injectable for tests).
	 */
	static create(spawn = (url) => new Worker(url, { type: "module" })) {
		const isolated = /** @type {any} */ (globalThis).crossOriginIsolated === true;
		const inWorker = typeof (/** @type {any} */ (globalThis).WorkerGlobalScope) !== "undefined";
		const cores = globalThis.navigator?.hardwareConcurrency ?? 1;
		// One core each for the page and the physics worker; the rest can help.
		const helpers = Math.min(MAX_HELPERS, cores - 2);
		if (!isolated || !inWorker || typeof SharedArrayBuffer === "undefined" || helpers < 1) {
			return null;
		}
		try {
			return new ThreadPool(helpers, spawn);
		} catch (error) {
			console.warn("No physics threads:", error);
			return null;
		}
	}

	/**
	 * @param {number} helpers
	 * @param {(url: URL) => Worker} spawn
	 */
	constructor(helpers, spawn) {
		const url = new URL("./poolWorker.js", import.meta.url);
		for (let i = 0; i < helpers; i++) {
			const helper = spawn(url);
			helper.addEventListener("error", (event) => {
				// The others (and the physics worker) take over its share.
				event.preventDefault();
				console.warn("A physics thread failed:", event.message);
				this.#helpers = this.#helpers.filter((h) => h !== helper);
			});
			helper.postMessage({ init: { index: i + 1, control: this.#control } });
			this.#helpers.push(helper);
			this.#sent.set(helper, new Map());
		}
		this.threads = helpers + 1;
	}

	/** Whether any helper is still alive. */
	get helping() {
		return this.#helpers.length > 0;
	}

	/**
	 * Does chunks `0 … chunks - 1` of `job` on all threads and returns when all are done.
	 *
	 * @param {JobName} job
	 * @param {number} chunks At most {@link MAX_CHUNKS}.
	 * @param {unknown} shared The job's data (shared memory); sent to a helper only when
	 *   `version` changed since it last received this job's data.
	 * @param {string} version
	 */
	run(job, chunks, shared, version) {
		if (chunks > MAX_CHUNKS) throw new RangeError(`too many chunks: ${chunks}`);
		const control = this.#control;
		Atomics.store(control, CONTROL.CHUNKS, chunks);
		this.#generation = (this.#generation + 1) & GENERATION_MASK;
		const generation = this.#generation;
		// Publishing the claim word releases the run: everything written before it
		// (the job's data included) is visible to whoever reads it.
		Atomics.store(control, CONTROL.CLAIM, generation << 16);

		for (const helper of this.#helpers) {
			const sent = this.#sent.get(helper);
			if (sent.get(job) === version) {
				helper.postMessage({ generation, job });
			} else {
				helper.postMessage({ generation, job, shared });
				sent.set(job, version);
			}
		}

		this.helped += chunks - work(control, generation, JOBS[job], shared, this.#thread);
		// Wait for helpers still finishing a chunk.
		for (let active; (active = Atomics.load(control, CONTROL.ACTIVE)) !== 0;) {
			Atomics.wait(control, CONTROL.ACTIVE, active, 100);
		}
	}

	dispose() {
		for (const helper of this.#helpers) helper.terminate();
		this.#helpers = [];
	}
}
