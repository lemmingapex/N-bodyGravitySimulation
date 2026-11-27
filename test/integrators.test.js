import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { INTEGRATORS } from "../src/physics/integrators.js";
import { Simulation } from "../src/physics/simulation.js";

const M = 1e6;
const m = 10;
const D = 100;
const PERIOD = 2 * Math.PI * Math.sqrt(D ** 3 / (M + m));

/**
 * Two bodies on a circular orbit in the center-of-mass frame.
 *
 * @param {string} integrator
 */
function binary(integrator) {
	const sim = new Simulation({ integrator, mergeChance: 0, bounceChance: 0 });
	const v = Math.sqrt((M + m) / D);
	// Positions/velocities relative to the center of mass.
	const big = sim.addBody({ m: M, x: (-m / (M + m)) * D, y: 0, vx: 0, vy: (-m / (M + m)) * v });
	const small = sim.addBody({ m, x: (M / (M + m)) * D, y: 0, vx: 0, vy: (M / (M + m)) * v });
	return { sim, big, small };
}

/**
 * Position error of the light body after a quarter orbit, compared with the exact
 * circular solution. (After exactly one full period some first-order errors cancel,
 * which would hide the true order of semi-implicit Euler.)
 *
 * @param {string} integrator
 * @param {number} steps
 */
function orbitError(integrator, steps) {
	const { sim, small } = binary(integrator);
	const radius = small.x;
	const dt = PERIOD / 4 / steps;
	for (let k = 0; k < steps; k++) sim.step(dt);
	return Math.hypot(small.x - 0, small.y - radius);
}

/**
 * Largest relative energy error seen during orbits [from, to).
 *
 * @param {string} integrator
 * @param {number} stepsPerOrbit
 * @param {number} from
 * @param {number} to
 */
function maxEnergyError(integrator, stepsPerOrbit, from, to) {
	const { sim } = binary(integrator);
	const e0 = sim.diagnostics().total;
	const dt = PERIOD / stepsPerOrbit;
	let worst = 0;
	for (let k = 0; k < stepsPerOrbit * to; k++) {
		sim.step(dt);
		if (k >= stepsPerOrbit * from) {
			worst = Math.max(worst, Math.abs((sim.diagnostics().total - e0) / e0));
		}
	}
	return worst;
}

describe("integrators", () => {
	/** @type {Record<string, number>} */
	const expectedOrder = { euler: 1, leapfrog: 2, yoshida4: 4, rk4: 4 };

	for (const [id, integrator] of Object.entries(INTEGRATORS)) {
		it(`${id} converges at order ${integrator.order}`, () => {
			assert.equal(integrator.order, expectedOrder[id]);
			const coarse = orbitError(id, 100);
			const fine = orbitError(id, 200);
			const observed = Math.log2(coarse / fine);
			assert.ok(
				Math.abs(observed - integrator.order) < 0.35,
				`observed order ${observed.toFixed(2)} (errors ${coarse}, ${fine})`,
			);
		});
	}

	it("higher-order methods are more accurate at the same step size", () => {
		const errors = Object.fromEntries(
			Object.keys(INTEGRATORS).map((id) => [id, orbitError(id, 50)]),
		);
		assert.ok(errors.rk4 < errors.leapfrog, JSON.stringify(errors));
		assert.ok(errors.yoshida4 < errors.leapfrog, JSON.stringify(errors));
		assert.ok(errors.leapfrog < errors.euler, JSON.stringify(errors));
	});

	it("symplectic methods keep energy error bounded over many orbits", () => {
		for (const id of ["leapfrog", "yoshida4"]) {
			const early = maxEnergyError(id, 100, 0, 1);
			const late = maxEnergyError(id, 100, 29, 30);
			assert.ok(late < 2 * early + 1e-12, `${id}: ${early} -> ${late}`);
		}
	});

	it("all methods conserve linear momentum", () => {
		for (const id of Object.keys(INTEGRATORS)) {
			const { sim } = binary(id);
			for (let k = 0; k < 500; k++) sim.step(PERIOD / 300);
			const { momentum } = sim.diagnostics();
			assert.ok(
				Math.hypot(momentum.x, momentum.y) < 1e-6,
				`${id}: ${JSON.stringify(momentum)}`,
			);
		}
	});
});
