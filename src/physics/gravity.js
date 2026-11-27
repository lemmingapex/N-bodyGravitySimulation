/**
 * Softened Newtonian gravity.
 *
 * Bodies are modelled as spheres. While two bodies are farther apart than the sum of
 * their radii `s`, the force is the usual inverse-square law. When they overlap
 * (`d < s`) the force falls off linearly to zero at `d = 0`, as inside a uniform
 * sphere. That keeps accelerations bounded (no singularity when bodies pass through
 * each other) and the potential continuous, so energy is still well defined.
 *
 * Accelerations are written into caller-provided arrays; positions are passed
 * separately from the state so integrators can evaluate intermediate positions.
 */

/** @typedef {import('./state.js').State} State */

/**
 * Potential energy of a pair of bodies, consistent with the softened force.
 *
 * @param {number} mi
 * @param {number} mj
 * @param {number} d Distance between centers.
 * @param {number} s Softening length (sum of radii).
 * @param {number} [G]
 */
export function pairPotential(mi, mj, d, s, G = 1) {
	if (d >= s) return (-G * mi * mj) / d;
	return (-G * mi * mj * (3 * s * s - d * d)) / (2 * s * s * s);
}

/**
 * Exact O(n²) accelerations. Uses Newton's third law to visit each pair once.
 *
 * @param {State} state Masses and radii.
 * @param {Float64Array} x Positions to evaluate at.
 * @param {Float64Array} y
 * @param {Float64Array} ax Output.
 * @param {Float64Array} ay Output.
 * @param {number} [G]
 */
export function directAccelerations(state, x, y, ax, ay, G = 1) {
	const { n, m, r } = state;
	ax.fill(0, 0, n);
	ay.fill(0, 0, n);
	for (let i = 0; i < n; i++) {
		const xi = x[i];
		const yi = y[i];
		const mi = m[i];
		const ri = r[i];
		let axi = 0;
		let ayi = 0;
		for (let j = i + 1; j < n; j++) {
			const dx = x[j] - xi;
			const dy = y[j] - yi;
			const d2 = dx * dx + dy * dy;
			const s = ri + r[j];
			const inv3 = d2 > s * s ? 1 / (d2 * Math.sqrt(d2)) : 1 / (s * s * s);
			const fx = dx * inv3;
			const fy = dy * inv3;
			axi += m[j] * fx;
			ayi += m[j] * fy;
			ax[j] -= mi * fx;
			ay[j] -= mi * fy;
		}
		ax[i] += axi;
		ay[i] += ayi;
	}
	if (G !== 1) {
		for (let i = 0; i < n; i++) {
			ax[i] *= G;
			ay[i] *= G;
		}
	}
}

/**
 * Acceleration felt by a probe of radius `pr` at (px, py) from every body in `state`.
 * The probe itself exerts no force (used for trajectory previews).
 *
 * @param {State} state
 * @param {number} px
 * @param {number} py
 * @param {number} pr
 * @param {number} G
 * @param {Float64Array | number[]} out `[ax, ay]`
 * @returns {number} Index of a body the probe overlaps, or -1.
 */
export function accelerationAt(state, px, py, pr, G, out) {
	const { n, m, r, x, y } = state;
	let ax = 0;
	let ay = 0;
	let hit = -1;
	for (let j = 0; j < n; j++) {
		const dx = x[j] - px;
		const dy = y[j] - py;
		const d2 = dx * dx + dy * dy;
		const s = pr + r[j];
		let inv3;
		if (d2 > s * s) {
			inv3 = 1 / (d2 * Math.sqrt(d2));
		} else {
			inv3 = 1 / (s * s * s);
			hit = j;
		}
		ax += m[j] * dx * inv3;
		ay += m[j] * dy * inv3;
	}
	out[0] = G * ax;
	out[1] = G * ay;
	return hit;
}

/**
 * Total gravitational potential energy, O(n²).
 *
 * @param {State} state
 * @param {number} [G]
 */
export function potentialEnergy(state, G = 1) {
	const { n, m, r, x, y } = state;
	let energy = 0;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const dx = x[j] - x[i];
			const dy = y[j] - y[i];
			energy += pairPotential(m[i], m[j], Math.sqrt(dx * dx + dy * dy), r[i] + r[j], G);
		}
	}
	return energy;
}
