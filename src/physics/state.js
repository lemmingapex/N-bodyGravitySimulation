/**
 * Struct-of-arrays snapshot of the bodies. The numerical kernels operate on typed
 * arrays because they are much faster than arrays of objects and allocation-free.
 *
 * Arrays may be longer than `n` (capacity is reused between steps); only the first
 * `n` entries are meaningful.
 *
 * @typedef {object} State
 * @property {number} n
 * @property {Float64Array} m
 * @property {Float64Array} r
 * @property {Float64Array} x
 * @property {Float64Array} y
 * @property {Float64Array} vx
 * @property {Float64Array} vy
 */

/**
 * @param {number} [capacity]
 * @returns {State}
 */
export function createState(capacity = 0) {
	return {
		n: 0,
		m: new Float64Array(capacity),
		r: new Float64Array(capacity),
		x: new Float64Array(capacity),
		y: new Float64Array(capacity),
		vx: new Float64Array(capacity),
		vy: new Float64Array(capacity),
	};
}

/**
 * Copies bodies into a state, reusing `state` when it is large enough.
 *
 * @param {ReadonlyArray<import('./body.js').Body>} bodies
 * @param {State} [state]
 * @returns {State} `state` or a newly allocated, larger one.
 */
export function loadState(bodies, state) {
	const n = bodies.length;
	const capacity = state?.m.length ?? 0;
	const s = state && capacity >= n ? state : createState(Math.max(n, Math.ceil(capacity * 1.5)));
	s.n = n;
	for (let i = 0; i < n; i++) {
		const b = bodies[i];
		s.m[i] = b.m;
		s.r[i] = b.r;
		s.x[i] = b.x;
		s.y[i] = b.y;
		s.vx[i] = b.vx;
		s.vy[i] = b.vy;
	}
	return s;
}

/**
 * Writes positions and velocities back to the bodies (same order as loaded).
 *
 * @param {State} state
 * @param {ReadonlyArray<import('./body.js').Body>} bodies
 */
export function storeState(state, bodies) {
	for (let i = 0; i < state.n; i++) {
		const b = bodies[i];
		b.x = state.x[i];
		b.y = state.y[i];
		b.vx = state.vx[i];
		b.vy = state.vy[i];
	}
}
