import { IMPACT_STRIDE } from "../physics/collisions.js";
import { DEFAULT_CONFIG, MAX_IMPACTS } from "../physics/simulation.js";
import { Engine, FRAME_STRIDE } from "./engine.js";

/** @typedef {import('../physics/body.js').Body} Body */
/** @typedef {import('../physics/simulation.js').SimulationConfig} SimulationConfig */
/** @typedef {import('../physics/simulation.js').Diagnostics} Diagnostics */
/** @typedef {import('./engine.js').Command} Command */
/** @typedef {import('./engine.js').Frame} Frame */

/**
 * @typedef {object} ClientOptions
 * @property {Partial<SimulationConfig>} [config]
 * @property {boolean} [useWorker] Run physics in a Web Worker (default: if available).
 * @property {(message: string) => void} [onError]
 * @property {(reason: string, restored: boolean) => void} [onFallback] The worker failed
 *   and physics now runs on the main thread. `restored` tells whether the state could be
 *   rebuilt by replaying commands (otherwise the caller should reload something).
 * @property {() => void} [onWorkerFrame] A frame arrived from the worker, so it is idle:
 *   a chance to send the next request right away rather than on the next animation
 *   frame, keeping a heavily loaded worker busy.
 */

/**
 * Main-thread handle on the simulation. Physics runs in a Web Worker when possible;
 * this class keeps a read-only mirror of the bodies (updated from each frame) for
 * rendering, aiming and camera logic, and forwards every change as a command.
 *
 * Only one `advance` is in flight at a time, which provides natural back-pressure:
 * when physics can't keep up, the simulation runs in slow motion instead of queueing.
 */
export class SimulationClient {
	/** @type {Body[]} Mirror of the simulated bodies. Treat as read-only. */
	bodies = [];
	time = 0;
	steps = 0;
	revision = -1;
	/**
	 * Barnes–Hut cells from the latest frame, if requested: (centreX, centreY,
	 * halfWidth) triples.
	 *
	 * @type {Float32Array | null}
	 */
	quadTree = null;
	mergeCount = 0;
	substeps = 1;
	/** Wall time the last advance spent stepping. */
	stepMs = 0;
	/** Threads doing the physics of large systems (more than 1 on isolated pages). */
	threads = 1;
	/** @type {Diagnostics | null} Most recent energy/momentum diagnostics. */
	diagnostics = null;
	/** @type {'worker' | 'local'} */
	mode = "local";
	/** @type {SimulationConfig} */
	config;

	/** @type {Worker | null} */
	#worker = null;
	/** @type {Engine | null} */
	#engine = null;
	#inFlight = false;
	#dirty = true;
	/** Advance requests sent, and frames received: one reply per request, in order. */
	#advancesSent = 0;
	#framesReceived = 0;
	#stepsApplied = 0;
	/** @type {number[]} */
	#impacts = [];
	/** Commands sent before the worker proved it works, replayed if it fails. */
	/** @type {Command[] | null} */
	#pendingLog = [];
	#options;

	/** @param {ClientOptions} [options] */
	constructor(options = {}) {
		this.#options = options;
		this.config = { ...DEFAULT_CONFIG, ...options.config };
		const canUseWorker = typeof Worker !== "undefined" && options.useWorker !== false;
		if (canUseWorker) {
			try {
				this.#startWorker();
			} catch (error) {
				this.#fallBack(error instanceof Error ? error.message : String(error));
			}
		} else {
			this.#engine = new Engine(this.config);
			this.#pendingLog = null;
		}
	}

	#startWorker() {
		const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
		worker.addEventListener("message", (event) => this.#onMessage(event.data));
		worker.addEventListener("error", (event) => {
			event.preventDefault();
			this.#fallBack(event.message || "worker failed to load");
		});
		this.#worker = worker;
		this.mode = "worker";
		worker.postMessage(/** @type {Command} */ ({ type: "configure", config: this.config }));
	}

	/** @param {string} reason */
	#fallBack(reason) {
		this.#worker?.terminate();
		this.#worker = null;
		this.mode = "local";
		const restored = this.#pendingLog !== null;
		this.#engine = new Engine(this.config);
		for (const command of this.#pendingLog ?? []) this.#engine.handle(command);
		this.#pendingLog = null;
		this.#inFlight = false;
		this.#framesReceived = this.#advancesSent; // the lost request will never be answered
		this.#dirty = true;
		this.#options.onFallback?.(reason, restored);
	}

	/**
	 * @param {any} message
	 */
	#onMessage(message) {
		switch (message?.type) {
			case "frame":
				this.#pendingLog = null; // the worker works; no need to keep a replay log
				this.#apply(/** @type {Frame} */ (message));
				this.#options.onWorkerFrame?.();
				break;
			case "error":
				this.#options.onError?.(message.message);
				if (message.frame) {
					this.#apply(message.frame);
					this.#options.onWorkerFrame?.();
				} else this.#inFlight = false;
				break;
		}
	}

	/** @param {Command} command */
	#send(command) {
		if (command.type !== "advance") {
			this.#dirty = true;
			this.#pendingLog?.push(command);
		}
		if (this.#worker) {
			this.#worker.postMessage(command);
			return;
		}
		const engine = /** @type {Engine} */ (this.#engine);
		try {
			const frame = engine.handle(command);
			if (frame) this.#apply(frame);
		} catch (error) {
			this.#options.onError?.(error instanceof Error ? error.message : String(error));
			if (command.type === "advance") this.#apply(engine.frame());
		}
	}

	/** @param {Partial<SimulationConfig>} config */
	configure(config) {
		this.config = { ...this.config, ...config };
		this.#send({ type: "configure", config });
	}

	/** @param {import('../physics/body.js').BodySpec} body */
	addBody(body) {
		this.#send({ type: "addBody", body });
	}

	/** @param {import('../physics/body.js').BodySpec[]} bodies */
	addBodies(bodies) {
		this.#send({ type: "addBodies", bodies });
	}

	/**
	 * @param {string} id
	 * @param {import('./engine.js').ColorMode} colors
	 * @param {number} seed
	 */
	loadPreset(id, colors, seed) {
		this.#send({ type: "loadPreset", id, colors, seed });
	}

	/**
	 * @param {import('../physics/body.js').BodySpec[]} bodies
	 * @param {number} [time]
	 */
	loadBodies(bodies, time = 0) {
		this.#send({ type: "loadBodies", bodies, time });
	}

	/** @param {number[]} ids */
	remove(ids) {
		this.#send({ type: "remove", ids });
	}

	clear() {
		this.#send({ type: "clear" });
	}

	/**
	 * A marker for "every command sent so far": pass it to {@link caughtUp} to learn
	 * when the bodies and frame data reflect those commands.
	 */
	checkpoint() {
		return this.#advancesSent;
	}

	/**
	 * Whether a frame sent after every command before `checkpoint` has been applied.
	 * The engine handles commands in order, so the reply to any advance requested
	 * after them reflects them all.
	 *
	 * @param {number} checkpoint From {@link checkpoint}.
	 */
	caughtUp(checkpoint) {
		return this.#framesReceived > checkpoint;
	}

	/** Whether an advance request is still being processed. */
	get busy() {
		return this.#inFlight;
	}

	/**
	 * Asks for `steps` more steps of size `dt`. Ignored while a previous request is in
	 * flight. With `steps = 0` a frame is only requested if something changed (so a
	 * paused simulation still shows newly added bodies).
	 *
	 * @param {{ steps: number, dt: number, budgetMs: number, diagnostics?: boolean, quadTree?: boolean }} request
	 * @returns {boolean} Whether a request was sent.
	 */
	advance({ steps, dt, budgetMs, diagnostics = false, quadTree = false }) {
		if (this.#inFlight) return false;
		// A tree is wanted for the first time (e.g. just switched on while paused).
		const needTree = quadTree && this.quadTree === null;
		if (steps === 0 && !this.#dirty && !diagnostics && !needTree) return false;
		this.#inFlight = true;
		this.#dirty = false;
		this.#advancesSent++;
		this.#send({ type: "advance", steps, dt, budgetMs, diagnostics, quadTree });
		return true;
	}

	/**
	 * Collisions reported since the last call (flat records, see `IMPACT_STRIDE` in
	 * collisions.js), for sound and visual effects.
	 */
	takeImpacts() {
		const impacts = this.#impacts;
		this.#impacts = [];
		return impacts;
	}

	/** Steps applied since the last call (drives trail fading). */
	takeStepsApplied() {
		const steps = this.#stepsApplied;
		this.#stepsApplied = 0;
		return steps;
	}

	/** @param {Frame} frame */
	#apply(frame) {
		const { n, data } = frame;
		if (frame.colors || n !== this.bodies.length) {
			/** @type {Map<number, Body>} */
			const known = new Map(this.bodies.map((b) => [b.id, b]));
			/** @type {Body[]} */
			const bodies = new Array(n);
			for (let i = 0, o = 0; i < n; i++, o += FRAME_STRIDE) {
				const id = data[o];
				const previous = known.get(id);
				const x = data[o + 3];
				const y = data[o + 4];
				bodies[i] = {
					id,
					m: data[o + 1],
					r: data[o + 2],
					x,
					y,
					vx: data[o + 5],
					vy: data[o + 6],
					color: frame.colors?.[i] ?? previous?.color ?? "#ffffff",
					lx: previous?.lx ?? x,
					ly: previous?.ly ?? y,
				};
			}
			this.bodies = bodies;
		} else {
			const bodies = this.bodies;
			for (let i = 0, o = 0; i < n; i++, o += FRAME_STRIDE) {
				const b = bodies[i];
				b.x = data[o + 3];
				b.y = data[o + 4];
				b.vx = data[o + 5];
				b.vy = data[o + 6];
			}
		}
		this.revision = frame.revision;
		this.time = frame.time;
		this.steps = frame.steps;
		this.mergeCount = frame.mergeCount;
		this.substeps = frame.substeps;
		this.stepMs = frame.stepMs;
		this.threads = frame.threads ?? 1;
		this.#stepsApplied += frame.stepsDone;
		// Nobody may be collecting (e.g. effects off): keep only the latest batch.
		if (frame.impacts?.length) {
			this.#impacts =
				this.#impacts.length > MAX_IMPACTS * IMPACT_STRIDE
					? frame.impacts
					: this.#impacts.concat(frame.impacts);
		}
		if (frame.diagnostics) this.diagnostics = frame.diagnostics;
		this.quadTree = frame.quadTree ?? null;
		this.#framesReceived++;
		this.#inFlight = false;
	}

	dispose() {
		this.#worker?.terminate();
		this.#worker = null;
	}
}
