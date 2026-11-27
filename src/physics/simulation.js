import { DEFAULT_BODY_COLOR, radiusForMass } from "./body.js";
import { QuadTree } from "./barnesHut.js";
import {
	CollisionGrid,
	IMPACT_BOUNCE,
	IMPACT_MERGE,
	mergeOverlapping,
	ImpactLog,
	recordImpacts,
	resolveBounces,
} from "./collisions.js";
import { directAccelerations, potentialEnergy } from "./gravity.js";
import { INTEGRATORS, Workspace } from "./integrators.js";
import { createRng } from "./rng.js";
import { createState, loadState, storeState } from "./state.js";

/** @typedef {import('./body.js').Body} Body */
/** @typedef {import('./body.js').BodySpec} BodySpec */

/** @typedef {'auto' | 'direct' | 'barnes-hut'} GravitySolver */

/**
 * @typedef {object} SimulationConfig
 * @property {number} G Gravitational constant.
 * @property {string} integrator Key of {@link INTEGRATORS}.
 * @property {GravitySolver} solver
 * @property {number} theta Barnes–Hut opening angle.
 * @property {number} mergeChance Probability that two touching bodies merge, 0..1.
 * @property {number} bounceChance Probability that they bounce, 0..1; with the merge
 *   chance at most 1. Otherwise they pass through each other. Rolled once per
 *   encounter: the outcome holds while the bodies touch, and they roll again the next
 *   time they meet.
 * @property {number} restitution Bounciness of bounces, 0..1.
 * @property {number} drag Linear drag coefficient γ (velocity decays as e^(−γt)).
 * @property {boolean} adaptive Split each step into substeps when bodies accelerate hard
 *   relative to their size (e.g. while diving through another body's softened core).
 * @property {number} maxSubsteps Upper bound on substeps per step when `adaptive` (integer ≥ 1).
 */

/**
 * @typedef {object} Diagnostics
 * @property {number} bodies
 * @property {number} mass
 * @property {number} kinetic
 * @property {number} potential NaN when not computed.
 * @property {number} total NaN when the potential was not computed.
 * @property {{ x: number, y: number }} momentum
 * @property {number} angularMomentum About the origin.
 * @property {{ x: number, y: number }} centerOfMass
 */

export const GRAVITY_SOLVERS = Object.freeze(
	/** @type {Record<GravitySolver, string>} */ ({
		auto: "Auto",
		direct: "Direct O(n²)",
		"barnes-hut": "Barnes–Hut O(n log n)",
	}),
);

/**
 * Body count from which the "auto" solver switches from the exact direct sum to
 * Barnes–Hut. Below it the direct sum is about as fast, and exact.
 */
export const AUTO_BARNES_HUT_BODIES = 2000;

/**
 * Whether `solver` uses the Barnes–Hut tree for `n` bodies.
 *
 * @param {string} solver
 * @param {number} n
 */
export function usesBarnesHut(solver, n) {
	return solver === "barnes-hut" || (solver === "auto" && n >= AUTO_BARNES_HUT_BODIES);
}

/** @type {Readonly<SimulationConfig>} */
export const DEFAULT_CONFIG = Object.freeze({
	G: 1,
	integrator: "rk4",
	solver: "direct",
	theta: 0.5,
	mergeChance: 1,
	bounceChance: 0,
	restitution: 0.9,
	drag: 0,
	adaptive: false,
	maxSubsteps: 32,
});

/**
 * Accuracy parameter of the adaptive time-step criterion
 * `dt ≤ ADAPTIVE_ETA · √(r / |a|)` (minimum over bodies, r = body radius). Smaller
 * is more accurate and more expensive. The usual criterion uses the softening
 * length, which here is the sum of two radii, so 0.5 on a single radius matches
 * the customary η ≈ 0.2–0.35.
 */
export const ADAPTIVE_ETA = 0.5;

/**
 * @param {SimulationConfig} config
 * @returns {SimulationConfig}
 */
function validateConfig(config) {
	const fail = (/** @type {string} */ message) => {
		throw new RangeError(`Invalid simulation config: ${message}`);
	};
	if (!Object.hasOwn(INTEGRATORS, config.integrator))
		fail(`unknown integrator "${config.integrator}"`);
	if (!Object.hasOwn(GRAVITY_SOLVERS, config.solver)) fail(`unknown solver "${config.solver}"`);
	const isChance = (/** @type {number} */ p) => p >= 0 && p <= 1;
	if (!isChance(config.mergeChance)) fail("mergeChance must be in [0, 1]");
	if (!isChance(config.bounceChance)) fail("bounceChance must be in [0, 1]");
	if (config.mergeChance + config.bounceChance > 1 + 1e-9)
		fail("mergeChance + bounceChance must be at most 1");
	if (!(config.G > 0 && Number.isFinite(config.G))) fail("G must be a positive number");
	if (!(config.theta >= 0 && Number.isFinite(config.theta))) fail("theta must be ≥ 0");
	if (!(config.restitution >= 0 && config.restitution <= 1))
		fail("restitution must be in [0, 1]");
	if (!(config.drag >= 0 && Number.isFinite(config.drag))) fail("drag must be ≥ 0");
	if (typeof config.adaptive !== "boolean") fail("adaptive must be a boolean");
	if (!(Number.isInteger(config.maxSubsteps) && config.maxSubsteps >= 1))
		fail("maxSubsteps must be an integer ≥ 1");
	return config;
}

/** @type {number[]} */
const NO_PAIRS = [];
/** Outcomes of an encounter between two touching bodies. */
const MERGE = 0;
const BOUNCE = 1;
const PASS = 2;

/** Collisions kept between {@link Simulation.takeImpacts} calls (the rest are dropped). */
export const MAX_IMPACTS = 32;
/** Bounces slower than this (approach speed) are resting contact, not impacts. */
const MIN_BOUNCE_SPEED = 5;

/**
 * The simulated universe: a list of bodies plus the rules used to advance them.
 * Contains no rendering or DOM code so it can be tested and reused headlessly.
 */
export class Simulation {
	/** @type {Body[]} */
	bodies = [];
	/** Simulated time elapsed. */
	time = 0;
	/** Steps taken. */
	steps = 0;
	/**
	 * Incremented whenever bodies are added, removed or merged, so observers (e.g. the
	 * energy-drift readout) know when conserved quantities legitimately changed.
	 */
	revision = 0;
	/** Total bodies absorbed by merges. */
	mergeCount = 0;
	/** Substeps used by the most recent {@link step} (always 1 unless `adaptive`). */
	lastSubsteps = 1;
	/**
	 * Collisions since the last {@link takeImpacts}: an evenly spread sample of at most
	 * {@link MAX_IMPACTS} of them. Seeded, so runs stay reproducible.
	 */
	#impacts = new ImpactLog(MAX_IMPACTS, createRng(0x1a2b3c));
	/**
	 * Outcome of the current encounter of every pair that is touching, keyed by their
	 * ids (`"low,high"`). Seeded rolls keep runs reproducible.
	 *
	 * @type {Map<string, number>}
	 */
	#contacts = new Map();
	#collisionRng = createRng(0x5eed);

	/** @type {SimulationConfig} */
	#config;
	#state = createState();
	#workspace = new Workspace();
	#tree = new QuadTree();
	#grid = new CollisionGrid();
	#nextId = 1;
	/** Largest (|a_i| / r_i)² seen by force evaluations during the current step. */
	#stiffness = 0;
	/** Value of `#stiffness` at the end of the previous step: the estimate for the next. */
	#lastStiffness = 0;
	/** `revision` when `#lastStiffness` was measured; NaN when there is no estimate. */
	#stiffnessRevision = Number.NaN;

	/** @param {Partial<SimulationConfig>} [config] */
	constructor(config = {}) {
		this.#config = validateConfig({ ...DEFAULT_CONFIG, ...config });
	}

	/** @returns {Readonly<SimulationConfig>} */
	get config() {
		return this.#config;
	}

	/**
	 * From now on, systems big enough to benefit build the Barnes–Hut tree, evaluate
	 * forces and look for collisions on all of `pool`'s threads (sharing memory).
	 * Results are exactly the same as on one thread.
	 *
	 * @param {import('./barnesHut.js').Parallel} pool
	 */
	useThreadPool(pool) {
		this.#tree = new QuadTree(64, { shared: true });
		this.#tree.parallel = pool;
		this.#grid = new CollisionGrid({ shared: true });
		this.#grid.parallel = pool;
	}

	/** @param {Partial<SimulationConfig>} changes */
	configure(changes) {
		this.#config = validateConfig({ ...this.#config, ...changes });
		this.#stiffnessRevision = Number.NaN; // G or the solver may have changed
	}

	/**
	 * @param {BodySpec} spec
	 * @returns {Body}
	 */
	addBody({ m, x, y, vx = 0, vy = 0, color = DEFAULT_BODY_COLOR }) {
		if (!(m > 0 && Number.isFinite(m))) throw new RangeError(`mass must be positive, got ${m}`);
		for (const [name, value] of Object.entries({ x, y, vx, vy })) {
			if (!Number.isFinite(value))
				throw new RangeError(`${name} must be finite, got ${value}`);
		}
		/** @type {Body} */
		const body = { id: this.#nextId++, m, r: radiusForMass(m), x, y, vx, vy, color };
		this.bodies.push(body);
		this.revision++;
		return body;
	}

	/**
	 * @param {(body: Body) => boolean} predicate
	 * @returns {number} Number of bodies removed.
	 */
	removeWhere(predicate) {
		const before = this.bodies.length;
		this.bodies = this.bodies.filter((b) => !predicate(b));
		const removed = before - this.bodies.length;
		if (removed > 0) this.revision++;
		return removed;
	}

	/** Removes all bodies and resets the clock. */
	clear() {
		this.bodies = [];
		this.time = 0;
		this.steps = 0;
		this.mergeCount = 0;
		this.#impacts.take();
		this.#contacts.clear();
		this.revision++;
	}

	/**
	 * Returns the collisions recorded since the last call (flat records, see
	 * `IMPACT_STRIDE` in collisions.js), and forgets them.
	 */
	takeImpacts() {
		return this.#impacts.take();
	}

	/**
	 * Advances the simulation by `dt`. With `adaptive` on, the step is split into
	 * `k = clamp(⌈dt / dtNeeded⌉, 1, maxSubsteps)` equal substeps, where
	 * `dtNeeded = ADAPTIVE_ETA · √(min_i r_i / |a_i|)` is estimated from the force
	 * evaluations of the previous step. Drag and collisions are handled per substep.
	 *
	 * @param {number} dt
	 */
	step(dt) {
		if (!(dt > 0 && Number.isFinite(dt)))
			throw new RangeError(`dt must be positive, got ${dt}`);
		this.time += dt;
		this.steps++;
		this.lastSubsteps = 1;
		// A single corrupted body would spread NaN to every other body through gravity.
		this.#removeNonFinite();
		if (this.bodies.length === 0) return;

		if (!this.#config.adaptive) {
			this.#substep(dt, false);
			return;
		}
		const substeps = (this.lastSubsteps = this.#substepsFor(dt));
		this.#stiffness = 0;
		const h = dt / substeps;
		for (let k = 0; k < substeps && this.bodies.length > 0; k++) this.#substep(h, true);
		this.#lastStiffness = this.#stiffness;
	}

	/**
	 * Number of substeps `dt` needs, seeding the stiffness estimate with one extra
	 * force evaluation when bodies changed since it was measured.
	 *
	 * @param {number} dt
	 */
	#substepsFor(dt) {
		if (this.#stiffnessRevision !== this.revision) {
			const state = (this.#state = loadState(this.bodies, this.#state));
			const [ax, ay] = this.#workspace.take(state.n, 2);
			this.#stiffness = 0;
			this.#measuredAccelerationFn(state)(state.x, state.y, ax, ay);
			this.#lastStiffness = this.#stiffness;
		}
		// (|a| / r)² → dtNeeded = η / √(|a| / r) = η · (|a| / r)²^(−1/4)
		const needed = ADAPTIVE_ETA / Math.sqrt(Math.sqrt(this.#lastStiffness));
		const k = Math.ceil(dt / needed);
		return k >= 1 ? Math.min(k, this.#config.maxSubsteps) : 1;
	}

	/**
	 * One integration step of length `h` followed by collision handling.
	 *
	 * @param {number} h
	 * @param {boolean} measure Track the stiffness of each force evaluation.
	 */
	#substep(h, measure) {
		const config = this.#config;
		const state = (this.#state = loadState(this.bodies, this.#state));

		// Drag is applied exactly (exponential decay) in two half steps around the
		// gravity step (Strang splitting), so it works with every integrator.
		applyDrag(state, config.drag, h / 2);
		INTEGRATORS[config.integrator].step(
			state,
			h,
			measure ? this.#measuredAccelerationFn(state) : this.#accelerationFn(state),
			this.#workspace,
		);
		applyDrag(state, config.drag, h / 2);

		let merges = NO_PAIRS;
		if (config.mergeChance + config.bounceChance === 0) this.#contacts.clear();
		else {
			const contacts = this.#sortContacts(this.#grid.find(state));
			merges = contacts.merges;
			if (contacts.bounces.length > 0) {
				// Resting contacts touch every step; only real hits are worth reporting.
				const { bounces } = contacts;
				recordImpacts(state, bounces, IMPACT_BOUNCE, this.#impacts, MIN_BOUNCE_SPEED);
				resolveBounces(state, bounces, config.restitution);
			}
		}
		storeState(state, this.bodies);

		if (merges.length > 0) {
			recordImpacts(state, merges, IMPACT_MERGE, this.#impacts, -Infinity);
			const result = mergeOverlapping(this.bodies, merges, () => this.#nextId++);
			this.bodies = result.bodies;
			this.mergeCount += result.merged;
			this.revision++;
		}

		this.#removeNonFinite();
	}

	/**
	 * Splits touching pairs into those that merge and those that bounce; the rest
	 * pass through. Each encounter is rolled when the bodies first touch and keeps its
	 * outcome while they stay in contact (so a pair can't flip from passing through to
	 * merging halfway); once they separate, their next meeting is rolled afresh.
	 *
	 * @param {number[]} pairs From {@link findOverlappingPairs}.
	 */
	#sortContacts(pairs) {
		const { mergeChance, bounceChance } = this.#config;
		if (mergeChance >= 1 || bounceChance >= 1) {
			this.#contacts.clear();
			return mergeChance >= 1
				? { merges: pairs, bounces: NO_PAIRS }
				: { merges: NO_PAIRS, bounces: pairs };
		}
		/** @type {number[]} */
		const merges = [];
		/** @type {number[]} */
		const bounces = [];
		const bodies = this.bodies;
		const previous = this.#contacts;
		/** @type {Map<string, number>} */
		const current = new Map();
		for (let k = 0; k < pairs.length; k += 2) {
			const i = pairs[k];
			const j = pairs[k + 1];
			const a = bodies[i].id;
			const b = bodies[j].id;
			const key = a < b ? `${a},${b}` : `${b},${a}`;
			let outcome = previous.get(key);
			if (outcome === undefined) {
				const roll = this.#collisionRng();
				outcome =
					roll < mergeChance ? MERGE : roll < mergeChance + bounceChance ? BOUNCE : PASS;
			}
			current.set(key, outcome);
			if (outcome === MERGE) merges.push(i, j);
			else if (outcome === BOUNCE) bounces.push(i, j);
		}
		// Pairs no longer touching are forgotten: their next encounter rolls again.
		this.#contacts = current;
		return { merges, bounces };
	}

	#removeNonFinite() {
		const isBroken = (/** @type {Body} */ b) =>
			!Number.isFinite(b.x) ||
			!Number.isFinite(b.y) ||
			!Number.isFinite(b.vx) ||
			!Number.isFinite(b.vy);
		// Scan first so the common, healthy case allocates nothing.
		if (this.bodies.some(isBroken)) this.removeWhere(isBroken);
	}

	/**
	 * @param {import('./state.js').State} state
	 * @returns {import('./integrators.js').AccelerationFn}
	 */
	#accelerationFn(state) {
		const { G, theta } = this.#config;
		if (usesBarnesHut(this.#config.solver, state.n)) {
			const tree = this.#tree;
			return (x, y, ax, ay) => {
				tree.build(state, x, y);
				tree.accelerations(state, x, y, ax, ay, G, theta);
			};
		}
		return (x, y, ax, ay) => directAccelerations(state, x, y, ax, ay, G);
	}

	/**
	 * {@link #accelerationFn} that also records the largest (|a_i| / r_i)² it produces
	 * in `#stiffness`, so the next step can choose its substep count for free.
	 *
	 * @param {import('./state.js').State} state
	 * @returns {import('./integrators.js').AccelerationFn}
	 */
	#measuredAccelerationFn(state) {
		const accel = this.#accelerationFn(state);
		const { n, r } = state;
		const revision = this.revision;
		return (x, y, ax, ay) => {
			accel(x, y, ax, ay);
			let worst = this.#stiffness;
			for (let i = 0; i < n; i++) {
				const ratio = (ax[i] * ax[i] + ay[i] * ay[i]) / (r[i] * r[i]);
				if (ratio > worst) worst = ratio;
			}
			this.#stiffness = worst;
			this.#stiffnessRevision = revision;
		};
	}

	/**
	 * Conserved quantities, useful for judging integrator accuracy.
	 *
	 * @param {{ potential?: boolean }} [options] Potential energy is O(n²); skip it for huge n.
	 * @returns {Diagnostics}
	 */
	diagnostics({ potential = true } = {}) {
		let mass = 0;
		let kinetic = 0;
		let px = 0;
		let py = 0;
		let angular = 0;
		let cx = 0;
		let cy = 0;
		for (const b of this.bodies) {
			mass += b.m;
			kinetic += 0.5 * b.m * (b.vx * b.vx + b.vy * b.vy);
			px += b.m * b.vx;
			py += b.m * b.vy;
			angular += b.m * (b.x * b.vy - b.y * b.vx);
			cx += b.m * b.x;
			cy += b.m * b.y;
		}
		const pe = potential
			? potentialEnergy((this.#state = loadState(this.bodies, this.#state)), this.#config.G)
			: Number.NaN;
		return {
			bodies: this.bodies.length,
			mass,
			kinetic,
			potential: pe,
			total: kinetic + pe,
			momentum: { x: px, y: py },
			angularMomentum: angular,
			centerOfMass: mass > 0 ? { x: cx / mass, y: cy / mass } : { x: 0, y: 0 },
		};
	}

	/** @returns {Body | undefined} */
	heaviestBody() {
		let best;
		for (const b of this.bodies) if (!best || b.m > best.m) best = b;
		return best;
	}

	/**
	 * A packed copy of the current bodies, e.g. for trajectory prediction.
	 *
	 * @param {import('./state.js').State} [reuse]
	 */
	snapshot(reuse) {
		return loadState(this.bodies, reuse);
	}
}

/**
 * @param {import('./state.js').State} state
 * @param {number} gamma
 * @param {number} dt
 */
function applyDrag(state, gamma, dt) {
	if (gamma === 0) return;
	const k = Math.exp(-gamma * dt);
	for (let i = 0; i < state.n; i++) {
		state.vx[i] *= k;
		state.vy[i] *= k;
	}
}
