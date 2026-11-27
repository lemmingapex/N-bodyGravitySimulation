import assert from "node:assert/strict";
import { radiusForMass } from "../src/physics/body.js";
import { createRng } from "../src/physics/rng.js";
import { loadState } from "../src/physics/state.js";

/**
 * @param {ReadonlyArray<{ m: number, x: number, y: number, vx?: number, vy?: number, r?: number }>} specs
 */
export function stateOf(specs) {
	return loadState(
		specs.map((s, i) => ({
			id: i + 1,
			m: s.m,
			r: s.r ?? radiusForMass(s.m),
			x: s.x,
			y: s.y,
			vx: s.vx ?? 0,
			vy: s.vy ?? 0,
			color: "#ffffff",
		})),
	);
}

/**
 * @param {number} n
 * @param {number} [seed]
 */
export function randomState(n, seed = 42) {
	const rng = createRng(seed);
	return stateOf(
		Array.from({ length: n }, () => ({
			m: 1000 + rng() * 50000,
			x: (rng() - 0.5) * 800,
			y: (rng() - 0.5) * 800,
			vx: (rng() - 0.5) * 100,
			vy: (rng() - 0.5) * 100,
		})),
	);
}

/**
 * @param {number} actual
 * @param {number} expected
 * @param {number} tolerance Absolute tolerance.
 * @param {string} [message]
 */
export function assertClose(actual, expected, tolerance, message) {
	assert.ok(
		Math.abs(actual - expected) <= tolerance,
		`${message ?? "values differ"}: expected ${expected} ± ${tolerance}, got ${actual}`,
	);
}
