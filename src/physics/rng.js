/**
 * Small, fast, seedable pseudo-random number generator (mulberry32).
 * Deterministic seeds make scenarios reproducible and tests stable.
 *
 * @param {number} [seed] 32-bit integer seed. Defaults to a time-based seed.
 * @returns {() => number} Function returning uniformly distributed numbers in [0, 1).
 */
export function createRng(seed = (Date.now() ^ (Math.random() * 0x100000000)) >>> 0) {
	let a = seed >>> 0;
	return function next() {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * @param {() => number} rng
 * @param {number} min
 * @param {number} max
 */
export function uniform(rng, min, max) {
	return min + (max - min) * rng();
}
