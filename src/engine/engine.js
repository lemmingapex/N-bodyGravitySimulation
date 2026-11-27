import { randomPastel } from "../physics/color.js";
import { getPreset } from "../physics/presets.js";
import { createRng } from "../physics/rng.js";
import { QuadTree } from "../physics/barnesHut.js";
import { Simulation } from "../physics/simulation.js";
import { loadState } from "../physics/state.js";

/** @typedef {import('../physics/body.js').BodySpec} BodySpec */
/** @typedef {import('../physics/simulation.js').SimulationConfig} SimulationConfig */
/** @typedef {import('../physics/simulation.js').Diagnostics} Diagnostics */

/**
 * How new bodies are colored. Functions can't cross a worker boundary, so the
 * coloring rule travels as data and is turned into a function where the bodies are made.
 *
 * @typedef {{ random: boolean, color: string }} ColorMode
 */

/**
 * Messages sent to the engine. All are plain data (structured-clonable).
 *
 * @typedef {{ type: 'configure', config: Partial<SimulationConfig> }
 *   | { type: 'addBody', body: BodySpec }
 *   | { type: 'addBodies', bodies: BodySpec[] }
 *   | { type: 'loadPreset', id: string, colors: ColorMode, seed: number }
 *   | { type: 'loadBodies', bodies: BodySpec[], time: number }
 *   | { type: 'remove', ids: number[] }
 *   | { type: 'clear' }
 *   | { type: 'advance', steps: number, dt: number, budgetMs: number, diagnostics: boolean, quadTree?: boolean }
 * } Command
 */

/** Values stored per body in {@link Frame.data}, in this order. */
export const FRAME_STRIDE = 7;

/**
 * Snapshot of the simulation sent back to the main thread after an `advance`.
 *
 * @typedef {object} Frame
 * @property {'frame'} type
 * @property {number} n Number of bodies.
 * @property {Float64Array} data `n × FRAME_STRIDE` values: id, m, r, x, y, vx, vy.
 * @property {string[] | null} colors Per-body colors, only when the body list changed
 *   (i.e. `revision` differs from the previous frame); otherwise null.
 * @property {number} revision
 * @property {number} time
 * @property {number} steps
 * @property {number} mergeCount
 * @property {number[]} impacts Collisions during this request (flat records, see
 *   `IMPACT_STRIDE` in collisions.js).
 * @property {number} substeps Substeps used by the last step (adaptive stepping).
 * @property {number} stepsDone Steps actually taken for this request (may be fewer
 *   than requested when the time budget ran out).
 * @property {number} stepMs Wall time spent stepping.
 * @property {Diagnostics | null} diagnostics Only when requested.
 * @property {Float32Array | null} quadTree Only when requested: the Barnes–Hut cells
 *   for the current positions, as (centreX, centreY, halfWidth) triples.
 * @property {number} threads Threads doing the physics of large systems.
 */

/** Most quadtree cells sent for drawing (a 10,000-body tree has about 15,000). */
export const MAX_QUADTREE_CELLS = 40000;

/** Energy is O(n²); skip it beyond this many bodies. */
export const DIAGNOSTICS_MAX_BODIES = 3000;

/**
 * Owns a {@link Simulation} and applies {@link Command}s to it. Contains no DOM code,
 * so it runs unchanged in a Web Worker or, as a fallback, on the main thread.
 */
export class Engine {
	sim;
	/** Threads doing the physics of large systems (see {@link useThreadPool}). */
	threads = 1;
	/** Revision included in the last frame; colors are only resent when it changes. */
	#sentRevision = -1;
	#now;
	/** For drawing only: rebuilt from the current positions when a frame asks for it. */
	#viewTree = new QuadTree();
	/** @type {import('../physics/state.js').State | undefined} */
	#viewState;

	/**
	 * @param {Partial<SimulationConfig>} [config]
	 * @param {() => number} [now] Clock in milliseconds (injectable for tests).
	 */
	constructor(config = {}, now = () => performance.now()) {
		this.sim = new Simulation(config);
		this.#now = now;
	}

	/**
	 * Splits the physics of large systems across the threads of `pool`.
	 *
	 * @param {import('./threadPool.js').ThreadPool} pool
	 */
	useThreadPool(pool) {
		this.sim.useThreadPool(pool);
		this.threads = pool.threads;
	}

	/**
	 * @param {Command} command
	 * @returns {Frame | null} A frame for `advance`, otherwise null.
	 */
	handle(command) {
		const sim = this.sim;
		switch (command.type) {
			case "configure":
				sim.configure(command.config);
				return null;
			case "addBody":
				sim.addBody(command.body);
				return null;
			case "addBodies":
				for (const body of command.bodies) sim.addBody(body);
				return null;
			case "loadPreset": {
				const rng = createRng(command.seed);
				sim.clear();
				getPreset(command.id).build(sim, { rng, color: colorFn(command.colors, rng) });
				return null;
			}
			case "loadBodies":
				sim.clear();
				for (const body of command.bodies) sim.addBody(body);
				sim.time = command.time;
				return null;
			case "remove": {
				const ids = new Set(command.ids);
				sim.removeWhere((b) => ids.has(b.id));
				return null;
			}
			case "clear":
				sim.clear();
				return null;
			case "advance":
				return this.#advance(command);
		}
	}

	/** @param {Extract<Command, { type: 'advance' }>} command */
	#advance({ steps, dt, budgetMs, diagnostics, quadTree = false }) {
		const start = this.#now();
		let done = 0;
		while (done < steps) {
			this.sim.step(dt);
			done++;
			if (this.#now() - start > budgetMs) break;
		}
		const stepMs = this.#now() - start;
		const wantDiagnostics = diagnostics && this.sim.bodies.length <= DIAGNOSTICS_MAX_BODIES;
		return this.frame(done, stepMs, wantDiagnostics, quadTree);
	}

	#quadTreeCells() {
		const state = (this.#viewState = loadState(this.sim.bodies, this.#viewState));
		this.#viewTree.build(state, state.x, state.y);
		return this.#viewTree.cells(MAX_QUADTREE_CELLS);
	}

	/**
	 * @param {number} [stepsDone]
	 * @param {number} [stepMs]
	 * @param {boolean} [withDiagnostics]
	 * @param {boolean} [withQuadTree]
	 * @returns {Frame}
	 */
	frame(stepsDone = 0, stepMs = 0, withDiagnostics = false, withQuadTree = false) {
		const { bodies } = this.sim;
		const n = bodies.length;
		const data = new Float64Array(n * FRAME_STRIDE);
		for (let i = 0, o = 0; i < n; i++, o += FRAME_STRIDE) {
			const b = bodies[i];
			data[o] = b.id;
			data[o + 1] = b.m;
			data[o + 2] = b.r;
			data[o + 3] = b.x;
			data[o + 4] = b.y;
			data[o + 5] = b.vx;
			data[o + 6] = b.vy;
		}
		const changed = this.sim.revision !== this.#sentRevision;
		this.#sentRevision = this.sim.revision;
		return {
			type: "frame",
			n,
			data,
			colors: changed ? bodies.map((b) => b.color) : null,
			revision: this.sim.revision,
			time: this.sim.time,
			steps: this.sim.steps,
			mergeCount: this.sim.mergeCount,
			impacts: this.sim.takeImpacts(),
			substeps: /** @type {{ lastSubsteps?: number }} */ (this.sim).lastSubsteps ?? 1,
			stepsDone,
			stepMs,
			diagnostics: withDiagnostics ? this.sim.diagnostics() : null,
			quadTree: withQuadTree ? this.#quadTreeCells() : null,
			threads: this.threads,
		};
	}
}

/**
 * @param {ColorMode} mode
 * @param {() => number} rng
 * @returns {() => string}
 */
export function colorFn(mode, rng) {
	return mode.random ? () => randomPastel(rng) : () => mode.color;
}
