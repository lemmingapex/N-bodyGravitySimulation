import { accelerationAt, directAccelerations } from "./gravity.js";
import { INTEGRATORS, Workspace } from "./integrators.js";
import { createState } from "./state.js";

/** @typedef {import('./body.js').Body} Body */
/** @typedef {import('./state.js').State} State */

/**
 * The body whose pull dominates at (x, y), i.e. the one maximising m / d².
 *
 * @param {ReadonlyArray<Body>} bodies
 * @param {number} x
 * @param {number} y
 * @returns {Body | undefined}
 */
export function dominantBody(bodies, x, y) {
	let best;
	let bestPull = 0;
	for (const b of bodies) {
		const dx = b.x - x;
		const dy = b.y - y;
		const d2 = Math.max(dx * dx + dy * dy, b.r * b.r);
		const pull = b.m / d2;
		if (pull > bestPull) {
			bestPull = pull;
			best = b;
		}
	}
	return best;
}

/**
 * Velocity for a circular orbit around the dominant body at (x, y), including that
 * body's own motion. Returns zero velocity in empty space.
 *
 * @param {ReadonlyArray<Body>} bodies
 * @param {number} x
 * @param {number} y
 * @param {number} [G]
 * @param {1 | -1} [direction] Orbit direction (1 = clockwise on a y-down screen).
 * @returns {{ vx: number, vy: number, around: Body | undefined }}
 */
export function circularOrbitVelocity(bodies, x, y, G = 1, direction = 1) {
	const around = dominantBody(bodies, x, y);
	if (!around) return { vx: 0, vy: 0, around };
	const dx = x - around.x;
	const dy = y - around.y;
	const d = Math.hypot(dx, dy);
	if (d === 0) return { vx: around.vx, vy: around.vy, around };
	const speed = Math.sqrt((G * around.m) / d);
	return {
		vx: around.vx - (direction * speed * dy) / d,
		vy: around.vy + (direction * speed * dx) / d,
		around,
	};
}

/**
 * @typedef {object} TrajectoryOptions
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} radius Radius of the new body (softening and impact detection).
 * @property {number} [mass] Mass of the new body; a heavy body also pulls the others.
 * @property {number} dt
 * @property {number} steps
 * @property {number} [G]
 * @property {boolean} [stopOnImpact]
 * @property {string} [integrator] Key of `INTEGRATORS`; use the simulation's own.
 * @property {number} [maxMovers] How many of the heaviest bodies move during the
 *   prediction; lighter ones are treated as fixed.
 * @property {number} [maxSubsteps] Extra substeps per step during close passes.
 */

/** Accuracy of the substep criterion `h ≤ η·√(r/|a|)`, as in the simulation. */
const PREDICTION_ETA = 0.5;

/**
 * Predicts the path of a new body.
 *
 * Runs a small simulation of its own: the new body plus the `maxMovers` heaviest bodies
 * move under their mutual gravity (so orbiting stars, binaries and passing planets are
 * followed), while lighter bodies stay fixed and only pull on the new body. It uses the
 * simulation's integrator and adds substeps during close passes, so the preview tracks
 * the real run closely at a fraction of its cost.
 *
 * @param {State} state Current bodies.
 * @param {TrajectoryOptions} options
 * @returns {{ points: Float64Array, count: number, impact: boolean }} `points` holds
 *   `count` (x, y) pairs, starting with the initial position.
 */
export function predictTrajectory(state, options) {
	const {
		radius,
		mass = 0,
		dt,
		steps,
		G = 1,
		stopOnImpact = true,
		integrator = "rk4",
		maxMovers = 32,
		maxSubsteps = 8,
	} = options;
	const n = state.n;
	const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => state.m[b] - state.m[a]);
	const movers = Math.min(maxMovers, n);

	// The new body is the last entry of the moving system.
	const system = createState(movers + 1);
	system.n = movers + 1;
	const probe = movers;
	for (let k = 0; k < movers; k++) {
		const i = order[k];
		system.m[k] = state.m[i];
		system.r[k] = state.r[i];
		system.x[k] = state.x[i];
		system.y[k] = state.y[i];
		system.vx[k] = state.vx[i];
		system.vy[k] = state.vy[i];
	}
	system.m[probe] = mass;
	system.r[probe] = radius;
	system.x[probe] = options.x;
	system.y[probe] = options.y;
	system.vx[probe] = options.vx;
	system.vy[probe] = options.vy;

	const fixed = createState(n - movers);
	fixed.n = n - movers;
	for (let k = movers; k < n; k++) {
		const i = order[k];
		fixed.m[k - movers] = state.m[i];
		fixed.r[k - movers] = state.r[i];
		fixed.x[k - movers] = state.x[i];
		fixed.y[k - movers] = state.y[i];
	}

	const pull = new Float64Array(2);
	let stiffness = 0; // largest |a|/r of the new body seen during the current step
	/** @type {import('./integrators.js').AccelerationFn} */
	const accel = (x, y, ax, ay) => {
		directAccelerations(system, x, y, ax, ay, G);
		accelerationAt(fixed, x[probe], y[probe], radius, G, pull);
		ax[probe] += pull[0];
		ay[probe] += pull[1];
		stiffness = Math.max(stiffness, Math.hypot(ax[probe], ay[probe]) / radius);
	};
	const step = (INTEGRATORS[integrator] ?? INTEGRATORS.rk4).step;
	const workspace = new Workspace();
	const scratch = new Float64Array(2 * system.n);
	accel(system.x, system.y, scratch.subarray(0, system.n), scratch.subarray(system.n));

	const points = new Float64Array((steps + 1) * 2);
	points[0] = options.x;
	points[1] = options.y;
	let count = 1;
	let impact = false;
	for (let k = 0; k < steps; k++) {
		const needed = PREDICTION_ETA / Math.sqrt(stiffness);
		const substeps = Math.min(maxSubsteps, Math.max(1, Math.ceil(dt / needed)));
		stiffness = 0;
		for (let s = 0; s < substeps; s++) step(system, dt / substeps, accel, workspace);

		const px = system.x[probe];
		const py = system.y[probe];
		points[count * 2] = px;
		points[count * 2 + 1] = py;
		count++;
		if (!Number.isFinite(px) || !Number.isFinite(py)) break;
		if (stopOnImpact && overlapsAny(system, probe, px, py, radius, fixed)) {
			impact = true;
			break;
		}
	}
	return { points, count, impact };
}

/**
 * @param {State} system
 * @param {number} probe Index of the new body in `system` (excluded from the test).
 * @param {number} px
 * @param {number} py
 * @param {number} radius
 * @param {State} fixed
 */
function overlapsAny(system, probe, px, py, radius, fixed) {
	for (const s of [system, fixed]) {
		for (let j = 0; j < s.n; j++) {
			if (s === system && j === probe) continue;
			const reach = radius + s.r[j];
			const dx = s.x[j] - px;
			const dy = s.y[j] - py;
			if (dx * dx + dy * dy < reach * reach) return true;
		}
	}
	return false;
}

/**
 * Two-body orbital elements of `body` relative to `around`.
 *
 * @param {Body} body
 * @param {Body} around
 * @param {number} [G]
 * @returns {{ distance: number, eccentricity: number, semiMajorAxis: number, period: number, bound: boolean }}
 *   `semiMajorAxis` and `period` are Infinity for unbound (e ≥ 1) orbits.
 */
export function orbitalElements(body, around, G = 1) {
	const rx = body.x - around.x;
	const ry = body.y - around.y;
	const vx = body.vx - around.vx;
	const vy = body.vy - around.vy;
	const mu = G * (body.m + around.m);
	const distance = Math.hypot(rx, ry);
	const v2 = vx * vx + vy * vy;
	const energy = v2 / 2 - mu / distance;
	// Eccentricity vector: ((v² − μ/r) r − (r·v) v) / μ
	const rv = rx * vx + ry * vy;
	const ex = ((v2 - mu / distance) * rx - rv * vx) / mu;
	const ey = ((v2 - mu / distance) * ry - rv * vy) / mu;
	const eccentricity = Math.hypot(ex, ey);
	const bound = energy < 0;
	const semiMajorAxis = bound ? -mu / (2 * energy) : Infinity;
	const period = bound ? 2 * Math.PI * Math.sqrt(semiMajorAxis ** 3 / mu) : Infinity;
	return { distance, eccentricity, semiMajorAxis, period, bound };
}
