/**
 * Time integrators for the whole system. Each advances every body by `dt`, calling
 * `accel(x, y, ax, ay)` to evaluate accelerations at whatever positions it needs.
 *
 * Every stage evaluates accelerations for all bodies at once. (The original code
 * froze the other bodies while stepping each one, which is not actually RK4 for an
 * N-body system.)
 */

/** @typedef {import('./state.js').State} State */

/**
 * @callback AccelerationFn
 * @param {Float64Array} x
 * @param {Float64Array} y
 * @param {Float64Array} ax Output.
 * @param {Float64Array} ay Output.
 * @returns {void}
 */

/**
 * @typedef {object} Integrator
 * @property {string} label
 * @property {number} order Global order of accuracy.
 * @property {boolean} symplectic Symplectic integrators keep energy error bounded over long runs.
 * @property {number} evaluations Force evaluations per step.
 * @property {(state: State, dt: number, accel: AccelerationFn, workspace: Workspace) => void} step
 */

/** Pool of reusable scratch arrays so integration does not allocate per step. */
export class Workspace {
	/** @type {Float64Array[]} */
	#buffers = [];
	#capacity = 0;

	/**
	 * @param {number} n Minimum length of each array.
	 * @param {number} count Number of arrays needed.
	 * @returns {Float64Array[]}
	 */
	take(n, count) {
		if (n > this.#capacity) {
			this.#capacity = Math.max(n, Math.ceil(this.#capacity * 1.5));
			this.#buffers = [];
		}
		while (this.#buffers.length < count) this.#buffers.push(new Float64Array(this.#capacity));
		return this.#buffers;
	}
}

/** @type {Integrator['step']} */
function eulerStep(state, dt, accel, workspace) {
	const { n, x, y, vx, vy } = state;
	const [ax, ay] = workspace.take(n, 2);
	accel(x, y, ax, ay);
	for (let i = 0; i < n; i++) {
		vx[i] += ax[i] * dt;
		vy[i] += ay[i] * dt;
		x[i] += vx[i] * dt;
		y[i] += vy[i] * dt;
	}
}

/**
 * Drift-kick-drift leapfrog (equivalent to velocity Verlet). One force evaluation.
 *
 * @type {Integrator['step']}
 */
function leapfrogStep(state, dt, accel, workspace) {
	const { n, x, y, vx, vy } = state;
	const [ax, ay] = workspace.take(n, 2);
	const half = dt / 2;
	for (let i = 0; i < n; i++) {
		x[i] += vx[i] * half;
		y[i] += vy[i] * half;
	}
	accel(x, y, ax, ay);
	for (let i = 0; i < n; i++) {
		vx[i] += ax[i] * dt;
		vy[i] += ay[i] * dt;
		x[i] += vx[i] * half;
		y[i] += vy[i] * half;
	}
}

// Yoshida (1990) coefficients for a 4th-order symplectic composition of leapfrog.
const CBRT2 = Math.cbrt(2);
const W1 = 1 / (2 - CBRT2);
const W0 = -CBRT2 / (2 - CBRT2);
const YOSHIDA_C = [W1 / 2, (W0 + W1) / 2, (W0 + W1) / 2, W1 / 2];
const YOSHIDA_D = [W1, W0, W1];

/**
 * Yoshida 4th-order symplectic integrator. Three force evaluations.
 *
 * @type {Integrator['step']}
 */
function yoshida4Step(state, dt, accel, workspace) {
	const { n, x, y, vx, vy } = state;
	const [ax, ay] = workspace.take(n, 2);
	for (let k = 0; k < 4; k++) {
		const c = YOSHIDA_C[k] * dt;
		for (let i = 0; i < n; i++) {
			x[i] += vx[i] * c;
			y[i] += vy[i] * c;
		}
		if (k === 3) break;
		accel(x, y, ax, ay);
		const d = YOSHIDA_D[k] * dt;
		for (let i = 0; i < n; i++) {
			vx[i] += ax[i] * d;
			vy[i] += ay[i] * d;
		}
	}
}

/**
 * Classic 4th-order Runge–Kutta over the full system state. Four force evaluations.
 *
 * @type {Integrator['step']}
 */
function rk4Step(state, dt, accel, workspace) {
	const { n, x, y, vx, vy } = state;
	const [tx, ty, tvx, tvy, ax, ay, sx, sy, svx, svy] = workspace.take(n, 10);
	const half = dt / 2;

	// Stage 1: derivative at the start.
	accel(x, y, ax, ay);
	for (let i = 0; i < n; i++) {
		sx[i] = vx[i];
		sy[i] = vy[i];
		svx[i] = ax[i];
		svy[i] = ay[i];
		tx[i] = x[i] + vx[i] * half;
		ty[i] = y[i] + vy[i] * half;
		tvx[i] = vx[i] + ax[i] * half;
		tvy[i] = vy[i] + ay[i] * half;
	}

	// Stages 2 and 3: midpoint derivatives.
	for (let stage = 2; stage <= 3; stage++) {
		accel(tx, ty, ax, ay);
		const h = stage === 2 ? half : dt;
		for (let i = 0; i < n; i++) {
			const kvx = tvx[i];
			const kvy = tvy[i];
			sx[i] += 2 * kvx;
			sy[i] += 2 * kvy;
			svx[i] += 2 * ax[i];
			svy[i] += 2 * ay[i];
			tx[i] = x[i] + kvx * h;
			ty[i] = y[i] + kvy * h;
			tvx[i] = vx[i] + ax[i] * h;
			tvy[i] = vy[i] + ay[i] * h;
		}
	}

	// Stage 4: derivative at the end.
	accel(tx, ty, ax, ay);
	const sixth = dt / 6;
	for (let i = 0; i < n; i++) {
		x[i] += (sx[i] + tvx[i]) * sixth;
		y[i] += (sy[i] + tvy[i]) * sixth;
		vx[i] += (svx[i] + ax[i]) * sixth;
		vy[i] += (svy[i] + ay[i]) * sixth;
	}
}

/** @type {Readonly<Record<string, Integrator>>} */
export const INTEGRATORS = Object.freeze({
	rk4: { label: "Runge–Kutta 4", order: 4, symplectic: false, evaluations: 4, step: rk4Step },
	yoshida4: {
		label: "Yoshida 4 (symplectic)",
		order: 4,
		symplectic: true,
		evaluations: 3,
		step: yoshida4Step,
	},
	leapfrog: {
		label: "Leapfrog / Verlet",
		order: 2,
		symplectic: true,
		evaluations: 1,
		step: leapfrogStep,
	},
	euler: {
		label: "Euler (semi-implicit)",
		order: 1,
		symplectic: true,
		evaluations: 1,
		step: eulerStep,
	},
});
