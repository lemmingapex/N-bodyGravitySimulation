import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { radiusForMass } from "../src/physics/body.js";
import { directAccelerations } from "../src/physics/gravity.js";
import { INTEGRATORS, Workspace } from "../src/physics/integrators.js";
import { ADAPTIVE_ETA, DEFAULT_CONFIG, Simulation } from "../src/physics/simulation.js";
import { createRng } from "../src/physics/rng.js";
import { loadState, storeState } from "../src/physics/state.js";
import { assertClose } from "./helpers.js";

/**
 * @param {Simulation} sim
 * @param {number} n
 * @param {number} seed
 */
function scatter(sim, n, seed) {
	const rng = createRng(seed);
	for (let i = 0; i < n; i++) {
		sim.addBody({
			m: 1000 + rng() * 9000,
			x: (rng() - 0.5) * 2000,
			y: (rng() - 0.5) * 2000,
			vx: (rng() - 0.5) * 20,
			vy: (rng() - 0.5) * 20,
		});
	}
}

describe("Simulation", () => {
	it("validates bodies and config", () => {
		const sim = new Simulation();
		assert.throws(() => sim.addBody({ m: 0, x: 0, y: 0 }), RangeError);
		assert.throws(() => sim.addBody({ m: 1, x: Number.NaN, y: 0 }), RangeError);
		assert.throws(() => sim.addBody({ m: 1, x: 0, y: 0, vx: Infinity }), RangeError);
		assert.throws(() => sim.configure({ integrator: "magic" }), RangeError);
		assert.throws(() => sim.configure({ restitution: 2 }), RangeError);
		assert.throws(() => sim.step(0), RangeError);
		assert.throws(() => new Simulation({ solver: /** @type {any} */ ("fmm") }), RangeError);
	});

	it("assigns ids, radius, default color and tracks revisions", () => {
		const sim = new Simulation();
		const a = sim.addBody({ m: 5000, x: 1, y: 2 });
		const b = sim.addBody({ m: 1000, x: 100, y: 2, color: "#123456" });
		assert.notEqual(a.id, b.id);
		assertClose(a.r, radiusForMass(5000), 1e-12);
		assert.equal(a.color, "#bbbb99");
		assert.equal(sim.revision, 2);
		assert.equal(
			sim.removeWhere((x) => x === b),
			1,
		);
		assert.equal(sim.revision, 3);
		assert.equal(
			sim.removeWhere(() => false),
			0,
		);
		assert.equal(sim.revision, 3);
	});

	it("advances time even when empty and clear() resets it", () => {
		const sim = new Simulation();
		sim.step(0.5);
		sim.step(0.5);
		assert.equal(sim.time, 1);
		assert.equal(sim.steps, 2);
		sim.addBody({ m: 1000, x: 0, y: 0 });
		sim.clear();
		assert.equal(sim.bodies.length, 0);
		assert.equal(sim.time, 0);
	});

	it("moves a lone body in a straight line", () => {
		const sim = new Simulation();
		const b = sim.addBody({ m: 1000, x: 0, y: 0, vx: 3, vy: -4 });
		for (let k = 0; k < 10; k++) sim.step(0.1);
		assertClose(b.x, 3, 1e-12);
		assertClose(b.y, -4, 1e-12);
	});

	it("applies drag as exact exponential decay", () => {
		const sim = new Simulation({ drag: 0.5 });
		const b = sim.addBody({ m: 1000, x: 0, y: 0, vx: 10 });
		for (let k = 0; k < 100; k++) sim.step(0.01);
		assertClose(b.vx, 10 * Math.exp(-0.5), 1e-9);
	});

	it("conserves momentum and energy without collisions", () => {
		const sim = new Simulation({ mergeChance: 0, bounceChance: 0 });
		scatter(sim, 40, 1);
		const before = sim.diagnostics();
		for (let k = 0; k < 200; k++) sim.step(1 / 75);
		const after = sim.diagnostics();
		assertClose(after.momentum.x, before.momentum.x, 1e-6 * before.mass);
		assertClose(after.momentum.y, before.momentum.y, 1e-6 * before.mass);
		assertClose(after.total, before.total, 1e-3 * Math.abs(before.total));
	});

	it("leapfrog conserves angular momentum to round-off", () => {
		const sim = new Simulation({ mergeChance: 0, bounceChance: 0, integrator: "leapfrog" });
		scatter(sim, 40, 1);
		const before = sim.diagnostics().angularMomentum;
		for (let k = 0; k < 200; k++) sim.step(1 / 75);
		assertClose(sim.diagnostics().angularMomentum, before, 1e-9 * Math.abs(before));
	});

	it("Barnes–Hut tracks the direct solver closely", () => {
		const direct = new Simulation({ mergeChance: 0, bounceChance: 0 });
		const tree = new Simulation({
			mergeChance: 0,
			bounceChance: 0,
			solver: "barnes-hut",
			theta: 0.3,
		});
		scatter(direct, 150, 5);
		scatter(tree, 150, 5);
		for (let k = 0; k < 50; k++) {
			direct.step(1 / 75);
			tree.step(1 / 75);
		}
		let maxDiff = 0;
		for (let i = 0; i < direct.bodies.length; i++) {
			const a = direct.bodies[i];
			const b = tree.bodies[i];
			maxDiff = Math.max(maxDiff, Math.hypot(a.x - b.x, a.y - b.y));
		}
		assert.ok(maxDiff < 0.5, `max position difference ${maxDiff}`);
	});

	it("merges colliding bodies, conserving mass and momentum", () => {
		const sim = new Simulation({ mergeChance: 1, bounceChance: 0 });
		sim.addBody({ m: 1000, x: -1, y: 0, vx: 50 });
		sim.addBody({ m: 3000, x: 1, y: 0, vx: -10 });
		const rev = sim.revision;
		sim.step(0.01);
		assert.equal(sim.bodies.length, 1);
		assert.equal(sim.mergeCount, 1);
		assert.ok(sim.revision > rev);
		const [merged] = sim.bodies;
		assert.equal(merged.m, 4000);
		const { momentum } = sim.diagnostics();
		assertClose(momentum.x, 1000 * 50 - 3000 * 10, 1e-6);
	});

	it("bounces colliding bodies apart", () => {
		const sim = new Simulation({ mergeChance: 0, bounceChance: 1, restitution: 1 });
		const a = sim.addBody({ m: 1000, x: -1, y: 0, vx: 20 });
		const b = sim.addBody({ m: 1000, x: 1, y: 0, vx: -20 });
		sim.step(0.001);
		assert.equal(sim.bodies.length, 2);
		assert.ok(a.vx < 0 && b.vx > 0, `${a.vx}, ${b.vx}`);
	});

	it("lets bodies pass through each other when collisions are off", () => {
		const sim = new Simulation({ mergeChance: 0, bounceChance: 0 });
		sim.addBody({ m: 1000, x: -1, y: 0 });
		sim.addBody({ m: 1000, x: 1, y: 0 });
		sim.step(0.01);
		assert.equal(sim.bodies.length, 2);
	});

	it("drops bodies whose state became non-finite", () => {
		const sim = new Simulation();
		sim.addBody({ m: 1000, x: 0, y: 0 });
		sim.addBody({ m: 1000, x: 100, y: 0 }).vx = Number.NaN;
		sim.step(0.01);
		assert.equal(sim.bodies.length, 1);
		assert.ok(Number.isFinite(sim.bodies[0].x));
	});

	it("reports diagnostics and the heaviest body", () => {
		const sim = new Simulation();
		assert.equal(sim.heaviestBody(), undefined);
		assert.deepEqual(sim.diagnostics().centerOfMass, { x: 0, y: 0 });
		sim.addBody({ m: 1000, x: 0, y: 0, vx: 2 });
		const heavy = sim.addBody({ m: 3000, x: 100, y: 0 });
		const d = sim.diagnostics();
		assert.equal(sim.heaviestBody(), heavy);
		assert.equal(d.mass, 4000);
		assertClose(d.centerOfMass.x, 75, 1e-12);
		assertClose(d.kinetic, 2000, 1e-12);
		assert.ok(d.potential < 0);
		assert.ok(Number.isNaN(sim.diagnostics({ potential: false }).total));
	});

	it("can switch integrators and solvers mid-run", () => {
		const sim = new Simulation();
		scatter(sim, 30, 2);
		for (const integrator of ["euler", "leapfrog", "yoshida4", "rk4"]) {
			for (const solver of /** @type {const} */ (["direct", "barnes-hut"])) {
				sim.configure({ integrator, solver });
				sim.step(1 / 75);
			}
		}
		assert.ok(sim.bodies.every((b) => Number.isFinite(b.x) && Number.isFinite(b.vy)));
	});
});

/**
 * A light body on a highly eccentric orbit (apoapsis 300, periapsis 15) around a
 * heavy one, starting at apoapsis. At dt = 1/75 the periapsis pass takes only a few
 * steps, which RK4 handles badly.
 *
 * @param {Simulation} sim
 */
function eccentricOrbit(sim) {
	const M = 1e7;
	const m = 1000;
	const ra = 300;
	const rp = 15;
	const v = Math.sqrt((M * 2 * rp) / (ra * (ra + rp)));
	sim.addBody({ m: M, x: 0, y: 0, vy: (-m * v) / M });
	sim.addBody({ m, x: ra, y: 0, vy: v });
	const a = (ra + rp) / 2;
	return { period: 2 * Math.PI * Math.sqrt(a ** 3 / (M + m)) };
}

describe("Simulation adaptive substepping", () => {
	it("is off by default and validates its settings", () => {
		assert.equal(DEFAULT_CONFIG.adaptive, false);
		assert.equal(DEFAULT_CONFIG.maxSubsteps, 32);
		assert.ok(ADAPTIVE_ETA > 0 && ADAPTIVE_ETA < 1);
		const sim = new Simulation({ adaptive: true, maxSubsteps: 1 });
		assert.equal(sim.config.maxSubsteps, 1);
		for (const bad of [0, -3, 1.5, Number.NaN, Infinity, /** @type {any} */ ("8")]) {
			assert.throws(() => sim.configure({ maxSubsteps: bad }), RangeError, String(bad));
		}
		assert.throws(() => sim.configure({ adaptive: /** @type {any} */ ("yes") }), RangeError);
		assert.throws(() => new Simulation({ adaptive: /** @type {any} */ (1) }), RangeError);
	});

	it("leaves the fixed-step path bit-identical when off", () => {
		const gamma = 0.3;
		const dt = 1 / 75;
		const sim = new Simulation({
			mergeChance: 0,
			bounceChance: 0,
			drag: gamma,
			adaptive: false,
		});
		scatter(sim, 25, 7);
		// Reference: the plain drag-kick-drag Strang splitting with RK4 and direct gravity.
		const bodies = sim.bodies.map((b) => ({ ...b }));
		const workspace = new Workspace();
		let state = loadState(bodies);
		const decay = Math.exp((-gamma * dt) / 2);
		for (let k = 0; k < 40; k++) {
			sim.step(dt);
			assert.equal(sim.lastSubsteps, 1);
			state = loadState(bodies, state);
			for (let i = 0; i < state.n; i++) {
				state.vx[i] *= decay;
				state.vy[i] *= decay;
			}
			const s = state;
			INTEGRATORS.rk4.step(
				s,
				dt,
				(x, y, ax, ay) => directAccelerations(s, x, y, ax, ay, 1),
				workspace,
			);
			for (let i = 0; i < state.n; i++) {
				state.vx[i] *= decay;
				state.vy[i] *= decay;
			}
			storeState(state, bodies);
		}
		sim.bodies.forEach((b, i) => {
			assert.equal(b.x, bodies[i].x);
			assert.equal(b.y, bodies[i].y);
			assert.equal(b.vx, bodies[i].vx);
			assert.equal(b.vy, bodies[i].vy);
		});
	});

	it("splits each step into equal substeps and keeps time exact", () => {
		const adaptive = new Simulation({ mergeChance: 0, bounceChance: 0, adaptive: true });
		const fixed = new Simulation({ mergeChance: 0, bounceChance: 0 });
		eccentricOrbit(adaptive);
		eccentricOrbit(fixed);
		const dt = 1 / 75;
		let substepped = false;
		for (let k = 0; k < 150; k++) {
			adaptive.step(dt);
			const n = adaptive.lastSubsteps;
			assert.ok(Number.isInteger(n) && n >= 1 && n <= 32);
			substepped ||= n > 1;
			// The same as n plain steps of dt / n, bit for bit.
			for (let j = 0; j < n; j++) fixed.step(dt / n);
			adaptive.bodies.forEach((b, i) => {
				assert.equal(b.x, fixed.bodies[i].x);
				assert.equal(b.vy, fixed.bodies[i].vy);
			});
		}
		assert.ok(substepped, "the periapsis pass should need substeps");
		assert.equal(adaptive.steps, 150);
		let expected = 0;
		for (let k = 0; k < 150; k++) expected += dt;
		assert.equal(adaptive.time, expected);
	});

	it("uses one substep when nothing accelerates and respects maxSubsteps", () => {
		const empty = new Simulation({ adaptive: true });
		empty.step(0.1);
		assert.equal(empty.lastSubsteps, 1);
		const lone = new Simulation({ adaptive: true });
		lone.addBody({ m: 1000, x: 0, y: 0, vx: 3 });
		lone.step(0.1);
		assert.equal(lone.lastSubsteps, 1);
		assertClose(lone.bodies[0].x, 0.3, 1e-12);

		// A body grazing a heavy star needs many substeps at a coarse step.
		/** @param {number} maxSubsteps */
		const graze = (maxSubsteps) => {
			const sim = new Simulation({
				mergeChance: 0,
				bounceChance: 0,
				adaptive: true,
				maxSubsteps,
			});
			sim.addBody({ m: 1e7, x: 0, y: 0 });
			sim.addBody({ m: 1000, x: 12, y: 0, vy: 900 });
			sim.step(1 / 20);
			return sim.lastSubsteps;
		};
		assert.ok(graze(1000) > 4, `unclamped ${graze(1000)}`);
		assert.equal(graze(4), 4);
		assert.equal(graze(1), 1);
	});

	it("re-estimates as soon as bodies are added", () => {
		const sim = new Simulation({ mergeChance: 0, bounceChance: 0, adaptive: true });
		const star = sim.addBody({ m: 1e7, x: 0, y: 0 });
		sim.addBody({ m: 1000, x: 400, y: 0, vy: Math.sqrt(1e7 / 400) });
		sim.step(1 / 75);
		assert.equal(sim.lastSubsteps, 1);
		sim.addBody({ m: 1000, x: star.x + 14, y: star.y, vy: 800 });
		sim.step(1 / 75);
		assert.ok(sim.lastSubsteps > 1, `got ${sim.lastSubsteps}`);
	});

	it("conserves energy far better on an eccentric orbit at the same dt", () => {
		/**
		 * @param {string} integrator
		 * @param {boolean} adaptive
		 */
		const drift = (integrator, adaptive) => {
			const sim = new Simulation({ mergeChance: 0, bounceChance: 0, integrator, adaptive });
			const { period } = eccentricOrbit(sim);
			const e0 = sim.diagnostics().total;
			const steps = Math.round(2 * period * 75);
			for (let k = 0; k < steps; k++) sim.step(1 / 75);
			return Math.abs((sim.diagnostics().total - e0) / e0);
		};
		const rk4Off = drift("rk4", false);
		const rk4On = drift("rk4", true);
		assert.ok(rk4Off > 0.1, `fixed-step RK4 drift ${rk4Off}`);
		assert.ok(rk4On < 1e-3, `adaptive RK4 drift ${rk4On}`);
		const yoshidaOn = drift("yoshida4", true);
		assert.ok(yoshidaOn < drift("yoshida4", false) / 5, `adaptive Yoshida drift ${yoshidaOn}`);
	});

	it("catches collisions that a single coarse step would tunnel through", () => {
		/** @param {boolean} adaptive */
		const run = (adaptive) => {
			const sim = new Simulation({ mergeChance: 1, bounceChance: 0, adaptive });
			sim.addBody({ m: 1e7, x: 0, y: 0 });
			sim.addBody({ m: 1000, x: -14, y: 0, vx: 3000 });
			sim.step(1 / 75);
			return sim;
		};
		assert.equal(run(false).bodies.length, 2);
		const adaptive = run(true);
		assert.equal(adaptive.bodies.length, 1);
		assert.equal(adaptive.mergeCount, 1);
	});
});
