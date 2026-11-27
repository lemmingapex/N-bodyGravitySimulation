import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QuadTree } from "../src/physics/barnesHut.js";
import { AUTO_BARNES_HUT_BODIES, Simulation, usesBarnesHut } from "../src/physics/simulation.js";
import {
	accelerationAt,
	directAccelerations,
	pairPotential,
	potentialEnergy,
} from "../src/physics/gravity.js";
import { assertClose, randomState, stateOf } from "./helpers.js";

/** @param {import('../src/physics/state.js').State} s */
function accelerationsOf(s, G = 1) {
	const ax = new Float64Array(s.n);
	const ay = new Float64Array(s.n);
	directAccelerations(s, s.x, s.y, ax, ay, G);
	return { ax, ay };
}

describe("directAccelerations", () => {
	it("matches Newton's law for two distant bodies", () => {
		const s = stateOf([
			{ m: 1000, x: 0, y: 0 },
			{ m: 4000, x: 100, y: 0 },
		]);
		const { ax, ay } = accelerationsOf(s);
		assertClose(ax[0], 4000 / 100 ** 2, 1e-12);
		assertClose(ax[1], -1000 / 100 ** 2, 1e-12);
		assert.equal(ay[0], 0);
		assert.equal(ay[1], 0);
	});

	it("scales with G", () => {
		const s = stateOf([
			{ m: 1000, x: 0, y: 0 },
			{ m: 4000, x: 30, y: 40 },
		]);
		const a1 = accelerationsOf(s, 1);
		const a3 = accelerationsOf(s, 3);
		assertClose(a3.ax[0], 3 * a1.ax[0], 1e-12);
		assertClose(a3.ay[1], 3 * a1.ay[1], 1e-12);
	});

	it("conserves momentum (net force is zero)", () => {
		const s = randomState(60);
		const { ax, ay } = accelerationsOf(s);
		let fx = 0;
		let fy = 0;
		let scale = 0;
		for (let i = 0; i < s.n; i++) {
			fx += s.m[i] * ax[i];
			fy += s.m[i] * ay[i];
			scale += Math.abs(s.m[i] * ax[i]);
		}
		assert.ok(Math.abs(fx) < 1e-9 * scale && Math.abs(fy) < 1e-9 * scale);
	});

	it("stays finite for coincident bodies (softening)", () => {
		const s = stateOf([
			{ m: 1000, x: 5, y: 5 },
			{ m: 1000, x: 5, y: 5 },
		]);
		const { ax, ay } = accelerationsOf(s);
		assert.deepEqual([...ax, ...ay], [0, 0, 0, 0]);
	});

	it("is consistent with the potential (F = -dU/dx), inside and outside the softening radius", () => {
		for (const d of [0.5, 2, 3.9, 50]) {
			const s = stateOf([
				{ m: 1000, x: 0, y: 0, r: 2 },
				{ m: 3000, x: d, y: 0, r: 2 },
			]);
			const { ax } = accelerationsOf(s);
			const h = 1e-6;
			const dU =
				(pairPotential(1000, 3000, d + h, 4) - pairPotential(1000, 3000, d - h, 4)) /
				(2 * h);
			// Force on body 1 along +x is -dU/dd.
			assertClose(3000 * ax[1], -dU, 1e-6 * Math.abs(dU) + 1e-9, `d=${d}`);
		}
	});
});

describe("pairPotential", () => {
	it("is continuous at the softening radius", () => {
		const s = 5;
		assertClose(pairPotential(2, 3, s - 1e-9, s), pairPotential(2, 3, s + 1e-9, s), 1e-8);
		assertClose(pairPotential(2, 3, 10, s), -0.6, 1e-12);
	});

	it("sums over pairs in potentialEnergy", () => {
		const s = stateOf([
			{ m: 1, x: 0, y: 0, r: 0.1 },
			{ m: 2, x: 3, y: 4, r: 0.1 },
			{ m: 4, x: 3, y: 0, r: 0.1 },
		]);
		assertClose(potentialEnergy(s), -(2 / 5 + 4 / 3 + 8 / 4), 1e-12);
	});
});

describe("accelerationAt", () => {
	it("matches the direct sum for a probe and reports overlaps", () => {
		const s = randomState(20, 7);
		const out = [0, 0];
		const hit = accelerationAt(s, 1000, 1000, 1, 1, out);
		assert.equal(hit, -1);
		let ex = 0;
		let ey = 0;
		for (let j = 0; j < s.n; j++) {
			const dx = s.x[j] - 1000;
			const dy = s.y[j] - 1000;
			const d = Math.hypot(dx, dy);
			ex += (s.m[j] * dx) / d ** 3;
			ey += (s.m[j] * dy) / d ** 3;
		}
		assertClose(out[0], ex, 1e-12);
		assertClose(out[1], ey, 1e-12);
		assert.equal(accelerationAt(s, s.x[3], s.y[3], 1, 1, out), 3);
	});
});

describe("Barnes–Hut", () => {
	/**
	 * @param {import('../src/physics/state.js').State} s
	 * @param {number} theta
	 */
	function treeAccelerations(s, theta) {
		const tree = new QuadTree(4);
		const ax = new Float64Array(s.n);
		const ay = new Float64Array(s.n);
		tree.build(s, s.x, s.y);
		tree.accelerations(s, s.x, s.y, ax, ay, 1, theta);
		return { ax, ay };
	}

	it("is exact with theta = 0", () => {
		const s = randomState(200);
		const exact = accelerationsOf(s);
		const approx = treeAccelerations(s, 0);
		for (let i = 0; i < s.n; i++) {
			const scale = Math.hypot(exact.ax[i], exact.ay[i]);
			assertClose(approx.ax[i], exact.ax[i], 1e-9 * scale);
			assertClose(approx.ay[i], exact.ay[i], 1e-9 * scale);
		}
	});

	it("approximates the direct sum, more accurately for smaller theta", () => {
		const s = randomState(500, 3);
		const exact = accelerationsOf(s);
		/** @param {number} theta */
		const meanRelativeError = (theta) => {
			const approx = treeAccelerations(s, theta);
			let sum = 0;
			for (let i = 0; i < s.n; i++) {
				const err = Math.hypot(approx.ax[i] - exact.ax[i], approx.ay[i] - exact.ay[i]);
				sum += err / Math.hypot(exact.ax[i], exact.ay[i]);
			}
			return sum / s.n;
		};
		const loose = meanRelativeError(0.8);
		const standard = meanRelativeError(0.5);
		const tight = meanRelativeError(0.25);
		assert.ok(standard < 0.03, `theta=0.5 mean relative error ${standard}`);
		assert.ok(tight < standard && standard < loose, `${tight} < ${standard} < ${loose}`);
	});

	it("handles coincident bodies, a single body and an empty system", () => {
		const coincident = stateOf(Array.from({ length: 10 }, () => ({ m: 1000, x: 1, y: 1 })));
		const { ax, ay } = treeAccelerations(coincident, 0.5);
		assert.ok([...ax, ...ay].every((v) => v === 0));

		const single = treeAccelerations(stateOf([{ m: 1000, x: 3, y: 4 }]), 0.5);
		assert.deepEqual([...single.ax, ...single.ay], [0, 0]);

		const empty = treeAccelerations(stateOf([]), 0.5);
		assert.equal(empty.ax.length, 0);
	});

	it("can be rebuilt with different sizes (buffer reuse)", () => {
		const tree = new QuadTree(1);
		for (const n of [50, 5, 300, 20]) {
			const s = randomState(n, n);
			const ax = new Float64Array(n);
			const ay = new Float64Array(n);
			tree.build(s, s.x, s.y);
			tree.accelerations(s, s.x, s.y, ax, ay, 1, 0);
			const exact = accelerationsOf(s);
			for (let i = 0; i < n; i++) {
				assertClose(ax[i], exact.ax[i], 1e-9 * Math.abs(exact.ax[i]) + 1e-15);
			}
		}
	});
});

describe("QuadTree.cells", () => {
	it("lists every cell, root first, each inside its parent region", () => {
		const s = randomState(200, 5);
		const tree = new QuadTree();
		tree.build(s, s.x, s.y);
		const cells = tree.cells(Infinity);
		assert.equal(cells.length, tree.count * 3);
		const [rx, ry, rh] = cells;
		for (let i = 0; i < s.n; i++) {
			assert.ok(Math.abs(s.x[i] - rx) <= rh * 1.0001 && Math.abs(s.y[i] - ry) <= rh * 1.0001);
		}
		for (let k = 3; k < cells.length; k += 3) {
			assert.ok(cells[k + 2] < rh, "children are smaller than the root");
			assert.ok(Math.abs(cells[k] - rx) <= rh && Math.abs(cells[k + 1] - ry) <= rh);
		}
		assert.equal(tree.cells(10).length, 30, "capped");
	});
});

describe("Barnes–Hut softening", () => {
	it("never exceeds the exact force for a tight cluster of overlapping neighbours", () => {
		// A probe next to a clump of overlapping bodies small enough to be approximated
		// as one cell. Softening that cell with only the probe's radius used to inflate
		// the force several-fold.
		const specs = [{ m: 1000, x: 0, y: 0, r: 1.3 }];
		for (let k = 0; k < 6; k++) {
			specs.push({ m: 1000, x: 2 + 0.01 * k, y: 0.01 * (k % 3), r: 1.3 });
		}
		specs.push({ m: 1000, x: 500, y: 500, r: 1.3 }); // stretches the root cell
		const s = stateOf(specs);
		const exact = accelerationsOf(s);
		const tree = new QuadTree();
		const ax = new Float64Array(s.n);
		const ay = new Float64Array(s.n);
		tree.build(s, s.x, s.y);
		tree.accelerations(s, s.x, s.y, ax, ay, 1, 1.5);
		const ratio = Math.hypot(ax[0], ay[0]) / Math.hypot(exact.ax[0], exact.ay[0]);
		assert.ok(ratio < 1.05, `tree/exact force ratio ${ratio}`);
	});
});

describe("auto solver", () => {
	/**
	 * Positions after one step of `count` bodies with the given solver.
	 *
	 * @param {string} solver
	 * @param {number} count
	 */
	const stepWith = (solver, count) => {
		const sim = new Simulation({
			solver: /** @type {any} */ (solver),
			mergeChance: 0,
			bounceChance: 0,
			theta: 0.8,
		});
		for (let i = 0; i < count; i++) {
			const a = i * 2.399963;
			const r = 20 + Math.sqrt(i) * 8;
			sim.addBody({ m: 50, x: r * Math.cos(a), y: r * Math.sin(a) });
		}
		sim.step(0.01);
		return sim.bodies.map((b) => [b.x, b.y]);
	};

	it("sums directly below the threshold and uses Barnes–Hut from it", () => {
		assert.equal(usesBarnesHut("auto", AUTO_BARNES_HUT_BODIES - 1), false);
		assert.equal(usesBarnesHut("auto", AUTO_BARNES_HUT_BODIES), true);
		assert.equal(usesBarnesHut("direct", 1e6), false);
		assert.equal(usesBarnesHut("barnes-hut", 2), true);

		assert.deepEqual(stepWith("auto", 300), stepWith("direct", 300));
		const n = AUTO_BARNES_HUT_BODIES;
		const auto = stepWith("auto", n);
		assert.deepEqual(auto, stepWith("barnes-hut", n));
		assert.notDeepEqual(auto, stepWith("direct", n), "θ = 0.8 is approximate");
	});
});
