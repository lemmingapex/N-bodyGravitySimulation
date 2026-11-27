import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	circularOrbitVelocity,
	dominantBody,
	orbitalElements,
	predictTrajectory,
} from "../src/physics/orbits.js";
import { radiusForMass } from "../src/physics/body.js";
import { getPreset } from "../src/physics/presets.js";
import { createRng } from "../src/physics/rng.js";
import { Simulation } from "../src/physics/simulation.js";
import { loadState } from "../src/physics/state.js";
import { assertClose, stateOf } from "./helpers.js";

describe("dominantBody / circularOrbitVelocity", () => {
	const sim = new Simulation();
	const star = sim.addBody({ m: 1e6, x: 0, y: 0, vx: 5, vy: 0 });
	const planet = sim.addBody({ m: 1e4, x: 300, y: 0 });

	it("picks the body with the strongest pull", () => {
		assert.equal(dominantBody(sim.bodies, 100, 0), star);
		assert.equal(dominantBody(sim.bodies, 295, 0), planet);
		assert.equal(dominantBody([], 0, 0), undefined);
	});

	it("gives a tangential velocity of sqrt(GM/d) plus the parent's velocity", () => {
		const { vx, vy, around } = circularOrbitVelocity(sim.bodies, 0, 100);
		assert.equal(around, star);
		const relX = vx - star.vx;
		const relY = vy - star.vy;
		assertClose(Math.hypot(relX, relY), Math.sqrt(1e6 / 100), 1e-9);
		assertClose(relX * 0 + relY * 100, 0, 1e-9); // perpendicular to the radius
		const reverse = circularOrbitVelocity(sim.bodies, 0, 100, 1, -1);
		assertClose(reverse.vx - star.vx, -relX, 1e-9);
	});

	it("returns zero velocity in empty space", () => {
		assert.deepEqual(circularOrbitVelocity([], 1, 2), { vx: 0, vy: 0, around: undefined });
	});
});

describe("predictTrajectory", () => {
	it("follows a straight line in empty space", () => {
		const { points, count, impact } = predictTrajectory(stateOf([]), {
			x: 0,
			y: 0,
			vx: 1,
			vy: 2,
			radius: 1,
			dt: 0.5,
			steps: 4,
		});
		assert.equal(count, 5);
		assert.equal(impact, false);
		assertClose(points[8], 2, 1e-12);
		assertClose(points[9], 4, 1e-12);
	});

	it("closes a circular orbit after one period", () => {
		const M = 1e6;
		const d = 100;
		const state = stateOf([{ m: M, x: 0, y: 0 }]);
		const v = Math.sqrt(M / d);
		const period = (2 * Math.PI * d) / v;
		const steps = 2000;
		const { points, count } = predictTrajectory(state, {
			x: d,
			y: 0,
			vx: 0,
			vy: v,
			radius: 1,
			dt: period / steps,
			steps,
		});
		assert.equal(count, steps + 1);
		assertClose(points[steps * 2], d, 0.1);
		assertClose(points[steps * 2 + 1], 0, 0.5);
	});

	it("stops at an impact", () => {
		const state = stateOf([{ m: 1e6, x: 100, y: 0, r: 10 }]);
		const result = predictTrajectory(state, {
			x: 0,
			y: 0,
			vx: 50,
			vy: 0,
			radius: 1,
			dt: 0.01,
			steps: 1000,
		});
		assert.equal(result.impact, true);
		assert.ok(result.count < 1000);
		assert.ok(result.points[(result.count - 1) * 2] > 85);
	});
});

describe("orbitalElements", () => {
	const star = { id: 1, m: 1e6, r: 10, x: 0, y: 0, vx: 0, vy: 0, color: "#fff" };

	it("recognises a circular orbit", () => {
		const v = Math.sqrt((1e6 + 1) / 100);
		const planet = { id: 2, m: 1, r: 1, x: 100, y: 0, vx: 0, vy: v, color: "#fff" };
		const el = orbitalElements(planet, star);
		assertClose(el.eccentricity, 0, 1e-9);
		assertClose(el.semiMajorAxis, 100, 1e-6);
		assertClose(el.period, 2 * Math.PI * Math.sqrt(100 ** 3 / (1e6 + 1)), 1e-9);
		assert.equal(el.bound, true);
	});

	it("matches vis-viva for an ellipse launched at apoapsis", () => {
		const ra = 300;
		const rp = 100;
		const mu = 1e6 + 1;
		const v = Math.sqrt((mu * 2 * rp) / (ra * (ra + rp)));
		const planet = { id: 2, m: 1, r: 1, x: ra, y: 0, vx: 0, vy: v, color: "#fff" };
		const el = orbitalElements(planet, star);
		assertClose(el.eccentricity, (ra - rp) / (ra + rp), 1e-9);
		assertClose(el.semiMajorAxis, (ra + rp) / 2, 1e-6);
	});

	it("flags escape trajectories", () => {
		const planet = { id: 2, m: 1, r: 1, x: 100, y: 0, vx: 0, vy: 200, color: "#fff" };
		const el = orbitalElements(planet, star);
		assert.equal(el.bound, false);
		assert.ok(el.eccentricity > 1);
		assert.equal(el.semiMajorAxis, Infinity);
	});
});

describe("predictTrajectory with moving attractors", () => {
	it("tracks the real simulation around a binary star", () => {
		const dt = 1 / 75;
		const sim = new Simulation({ mergeChance: 0, bounceChance: 0 });
		getPreset("binary").build(sim, { rng: createRng(1), color: () => "#fff" });
		const v = circularOrbitVelocity(sim.bodies, 0, 120);
		const launch = { x: 0, y: 120, vx: v.vx * 1.15, vy: v.vy * 1.15 };
		const prediction = predictTrajectory(loadState(sim.bodies), {
			...launch,
			radius: radiusForMass(4000),
			mass: 4000,
			dt,
			steps: 75,
			stopOnImpact: false,
		});
		const probe = sim.addBody({ m: 4000, ...launch });
		for (let k = 0; k < 75; k++) sim.step(dt);
		const error = Math.hypot(
			probe.x - prediction.points[150],
			probe.y - prediction.points[151],
		);
		// Holding the stars fixed (the old approach) was off by ~50 here.
		assert.ok(error < 5, `prediction error after 1 s: ${error}`);
	});

	it("lets a heavy new body pull the others", () => {
		const state = stateOf([{ m: 1e6, x: 0, y: 0 }]);
		const light = predictTrajectory(state, {
			x: 50,
			y: 0,
			vx: 0,
			vy: 0,
			radius: 1,
			dt: 0.01,
			steps: 20,
		});
		const heavy = predictTrajectory(state, {
			x: 50,
			y: 0,
			vx: 0,
			vy: 0,
			radius: 1,
			mass: 1e6,
			dt: 0.01,
			steps: 20,
		});
		// With equal masses the star also falls towards the new body, so the gap closes
		// faster and the new body gets further than it would towards a fixed star.
		assert.ok(
			heavy.points[40] < light.points[40],
			`${heavy.points[40]} vs ${light.points[40]}`,
		);
	});
});
