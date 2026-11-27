import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { radiusForMass } from "../src/physics/body.js";
import {
	findOverlappingPairs,
	IMPACT_BOUNCE,
	IMPACT_MERGE,
	IMPACT_STRIDE,
	ImpactLog,
	mergeOverlapping,
	recordImpacts,
	resolveBounces,
} from "../src/physics/collisions.js";
import { MAX_IMPACTS, Simulation } from "../src/physics/simulation.js";
import { createRng } from "../src/physics/rng.js";
import { assertClose, stateOf } from "./helpers.js";

/** @param {import('../src/physics/state.js').State} s */
function bruteForcePairs(s) {
	const pairs = [];
	for (let i = 0; i < s.n; i++) {
		for (let j = i + 1; j < s.n; j++) {
			if (Math.hypot(s.x[i] - s.x[j], s.y[i] - s.y[j]) < s.r[i] + s.r[j])
				pairs.push(`${i},${j}`);
		}
	}
	return pairs.sort();
}

/** @param {number[]} flat */
const pairKeys = (flat) => {
	const keys = [];
	for (let k = 0; k < flat.length; k += 2) keys.push(`${flat[k]},${flat[k + 1]}`);
	return keys.sort();
};

/**
 * @param {number} id
 * @param {Partial<import('../src/physics/body.js').Body> & { m: number }} b
 * @returns {import('../src/physics/body.js').Body}
 */
const body = (id, b) => ({
	id,
	x: 0,
	y: 0,
	vx: 0,
	vy: 0,
	color: "#ffffff",
	r: radiusForMass(b.m),
	...b,
});

describe("findOverlappingPairs", () => {
	it("matches a brute-force search", () => {
		const rng = createRng(9);
		const s = stateOf(
			Array.from({ length: 400 }, () => ({
				m: 1000 + rng() * 200000,
				x: rng() * 300,
				y: rng() * 300,
			})),
		);
		const expected = bruteForcePairs(s);
		assert.ok(expected.length > 10, "test should exercise many overlaps");
		assert.deepEqual(pairKeys(findOverlappingPairs(s)), expected);
	});

	it("returns nothing for fewer than two bodies or separated bodies", () => {
		assert.deepEqual(findOverlappingPairs(stateOf([])), []);
		assert.deepEqual(findOverlappingPairs(stateOf([{ m: 1000, x: 0, y: 0 }])), []);
		assert.deepEqual(
			findOverlappingPairs(
				stateOf([
					{ m: 1000, x: 0, y: 0 },
					{ m: 1000, x: 100, y: 0 },
				]),
			),
			[],
		);
	});
});

describe("mergeOverlapping", () => {
	it("merges chains in one pass and conserves mass, momentum and center of mass", () => {
		const bodies = [
			body(1, { m: 1000, x: 0, y: 0, vx: 10, color: "#ff0000" }),
			body(2, { m: 3000, x: 2, y: 0, vy: -5, color: "#0000ff" }),
			body(3, { m: 2000, x: 4, y: 1, vx: -1, vy: 2, color: "#00ff00" }),
			body(4, { m: 5000, x: 500, y: 500 }),
		];
		let id = 100;
		const { bodies: result, merged } = mergeOverlapping(bodies, [0, 1, 1, 2], () => id++);

		assert.equal(merged, 2);
		assert.equal(result.length, 2);
		assert.equal(result[0], bodies[3], "untouched bodies are kept as-is");
		const combined = result[1];
		assert.equal(combined.id, 100);
		assert.equal(combined.m, 6000);
		assertClose(combined.r, radiusForMass(6000), 1e-12);
		assertClose(combined.x, (0 * 1000 + 2 * 3000 + 4 * 2000) / 6000, 1e-12);
		assertClose(combined.y, (1 * 2000) / 6000, 1e-12);
		assertClose(combined.vx, (10 * 1000 - 1 * 2000) / 6000, 1e-12);
		assertClose(combined.vy, (-5 * 3000 + 2 * 2000) / 6000, 1e-12);
		assert.equal(combined.color, "#2b5580");
	});

	it("returns a copy when nothing overlaps", () => {
		const bodies = [body(1, { m: 1000 })];
		const { bodies: result, merged } = mergeOverlapping(bodies, [], () => 0);
		assert.deepEqual(result, bodies);
		assert.notEqual(result, bodies);
		assert.equal(merged, 0);
	});
});

describe("resolveBounces", () => {
	it("swaps velocities in an elastic head-on collision of equal masses", () => {
		const s = stateOf([
			{ m: 1000, x: 0, y: 0, vx: 5, r: 1 },
			{ m: 1000, x: 1.5, y: 0, vx: -3, r: 1 },
		]);
		resolveBounces(s, findOverlappingPairs(s), 1);
		assertClose(s.vx[0], -3, 1e-12);
		assertClose(s.vx[1], 5, 1e-12);
		assert.ok(s.x[1] - s.x[0] > 1.5, "positional correction pushes bodies apart");
	});

	it("conserves momentum, and energy when elastic", () => {
		const s = stateOf([
			{ m: 1000, x: 0, y: 0, vx: 5, vy: 1, r: 1 },
			{ m: 7000, x: 1.2, y: 0.8, vx: -2, vy: -1, r: 1 },
		]);
		const momentum = () => [
			s.m[0] * s.vx[0] + s.m[1] * s.vx[1],
			s.m[0] * s.vy[0] + s.m[1] * s.vy[1],
		];
		const energy = () =>
			0.5 * s.m[0] * (s.vx[0] ** 2 + s.vy[0] ** 2) +
			0.5 * s.m[1] * (s.vx[1] ** 2 + s.vy[1] ** 2);
		const [px, py] = momentum();
		const e = energy();
		resolveBounces(s, [0, 1], 1);
		const [px2, py2] = momentum();
		assertClose(px2, px, 1e-9);
		assertClose(py2, py, 1e-9);
		assertClose(energy(), e, 1e-9);
	});

	it("loses energy when inelastic and ignores separating bodies", () => {
		const s = stateOf([
			{ m: 1000, x: 0, y: 0, vx: 5, r: 1 },
			{ m: 1000, x: 1.5, y: 0, vx: -5, r: 1 },
		]);
		resolveBounces(s, [0, 1], 0);
		assertClose(s.vx[0], 0, 1e-12);
		assertClose(s.vx[1], 0, 1e-12);

		const apart = stateOf([
			{ m: 1000, x: 0, y: 0, vx: -1, r: 1 },
			{ m: 1000, x: 1.5, y: 0, vx: 1, r: 1 },
		]);
		resolveBounces(apart, [0, 1], 1);
		assert.equal(apart.vx[0], -1);
		assert.equal(apart.vx[1], 1);
	});

	it("handles perfectly coincident bodies without producing NaN", () => {
		const s = stateOf([
			{ m: 1000, x: 3, y: 3, vx: 1, r: 1 },
			{ m: 1000, x: 3, y: 3, vx: -1, r: 1 },
		]);
		resolveBounces(s, [0, 1], 0.5);
		assert.ok([s.x[0], s.x[1], s.vx[0], s.vx[1]].every(Number.isFinite));
		assert.ok(s.x[1] > s.x[0]);
	});
});

describe("recordImpacts", () => {
	const approaching = () =>
		stateOf([
			{ m: 3000, x: 0, y: 0, vx: 10, vy: 0 },
			{ m: 1000, x: 2, y: 0, vx: -30, vy: 5 },
		]);

	it("records the centre of mass, combined mass and approach speed", () => {
		const s = approaching();
		const log = new ImpactLog(10, Math.random);
		recordImpacts(s, [0, 1], IMPACT_MERGE, log);
		const out = log.take();
		assert.equal(out.length, IMPACT_STRIDE);
		const [kind, x, y, mass, speed] = out;
		assert.equal(kind, IMPACT_MERGE);
		assertClose(x, 0.5, 1e-12);
		assertClose(y, 0, 1e-12);
		assert.equal(mass, 4000);
		assertClose(speed, 40, 1e-12, "only the component along the line between them");
	});

	it("skips separating or slow pairs and stops at the limit", () => {
		const s = approaching();
		const log = new ImpactLog(2, Math.random);
		recordImpacts(s, [0, 1], IMPACT_BOUNCE, log, 50);
		assert.equal(log.records.length, 0, "slower than minSpeed");
		s.vx[1] = 30; // now moving apart
		recordImpacts(s, [0, 1], IMPACT_BOUNCE, log);
		assert.equal(log.records.length, 0, "separating");
		s.vx[1] = -30;
		recordImpacts(s, [0, 1, 0, 1, 0, 1], IMPACT_BOUNCE, log);
		assert.equal(log.take().length, 2 * IMPACT_STRIDE);
		assert.equal(log.records.length, 0, "taking empties the log");
	});

	it("keeps an evenly spread sample, not just the first collisions found", () => {
		// 2,000 collisions offered left to right, as collision detection finds them.
		const rng = createRng(7);
		let below = 0;
		let total = 0;
		for (let trial = 0; trial < 200; trial++) {
			const log = new ImpactLog(32, rng);
			for (let x = 0; x < 2000; x++) log.add(IMPACT_BOUNCE, x, 0, 1, 1);
			const records = log.take();
			assert.equal(records.length, 32 * IMPACT_STRIDE);
			for (let o = 0; o < records.length; o += IMPACT_STRIDE) {
				if (records[o + 1] < 1000) below++;
				total++;
			}
		}
		// Each collision is equally likely to be kept: half the sample from each half.
		assert.ok(Math.abs(below / total - 0.5) < 0.03, `${below / total} from the left half`);
	});

	it("are reported by the simulation for merges and bounces, then forgotten", () => {
		for (const collisions of /** @type {const} */ (["merge", "bounce"])) {
			const merge = collisions === "merge";
			const sim = new Simulation({
				mergeChance: merge ? 1 : 0,
				bounceChance: merge ? 0 : 1,
				G: 1e-12,
			});
			sim.addBody({ m: 5000, x: -20, y: 0, vx: 200, vy: 0 });
			sim.addBody({ m: 5000, x: 20, y: 0, vx: -200, vy: 0 });
			for (let i = 0; i < 60; i++) sim.step(1 / 300); // they meet after ~0.09
			const impacts = sim.takeImpacts();
			assert.equal(impacts.length, IMPACT_STRIDE, collisions);
			assert.equal(impacts[0], merge ? IMPACT_MERGE : IMPACT_BOUNCE);
			assert.equal(impacts[3], 10000);
			assert.deepEqual(sim.takeImpacts(), []);
		}
	});

	it("keeps at most MAX_IMPACTS between reads", () => {
		const sim = new Simulation({ mergeChance: 1, bounceChance: 0, G: 1e-12 });
		for (let i = 0; i < MAX_IMPACTS + 10; i++) {
			sim.addBody({ m: 1000, x: i * 100, y: 0, vx: 0, vy: 0 });
			sim.addBody({ m: 1000, x: i * 100 + 1, y: 0, vx: -1, vy: 0 });
		}
		sim.step(1 / 300);
		assert.equal(sim.takeImpacts().length, MAX_IMPACTS * IMPACT_STRIDE);
	});
});

describe("collision chances", () => {
	/**
	 * Pairs of bodies far apart from each other, each pair heading for a head-on
	 * encounter at relative speed `2 * speed`.
	 *
	 * @param {Simulation} sim
	 * @param {number} count
	 * @param {number} gap Starting distance between the two bodies of a pair.
	 * @param {number} speed
	 */
	const addPairs = (sim, count, gap, speed) => {
		const pairs = [];
		for (let k = 0; k < count; k++) {
			const y = k * 100; // only the two bodies of a pair ever meet
			const a = sim.addBody({ m: 5000, x: -gap / 2, y, vx: speed });
			const b = sim.addBody({ m: 5000, x: gap / 2, y, vx: -speed });
			pairs.push({ a: a.id, b: b.id });
		}
		return pairs;
	};

	it("splits encounters into merges, bounces and passes by their chances", () => {
		const sim = new Simulation({ mergeChance: 0.4, bounceChance: 0.35, G: 1e-12 });
		const pairs = addPairs(sim, 600, 40, 200);
		for (let i = 0; i < 60; i++) sim.step(1 / 300); // they meet after ~0.09
		const counts = { merge: 0, bounce: 0, pass: 0 };
		for (const { a } of pairs) {
			const left = sim.bodies.find((other) => other.id === a);
			if (!left) counts.merge++;
			else if (left.vx < 0 && left.x < 0) counts.bounce++;
			else if (left.vx > 0 && left.x > 0) counts.pass++;
			else assert.fail(`pair ${a} did none of them: ${JSON.stringify(left)}`);
		}
		const share = (/** @type {number} */ n) => n / pairs.length;
		assert.ok(Math.abs(share(counts.merge) - 0.4) < 0.06, JSON.stringify(counts));
		assert.ok(Math.abs(share(counts.bounce) - 0.35) < 0.06, JSON.stringify(counts));
		assert.ok(Math.abs(share(counts.pass) - 0.25) < 0.06, JSON.stringify(counts));
	});

	it("keeps an encounter's outcome while the bodies touch", () => {
		// Slow passes: each pair overlaps for over a hundred steps.
		const sim = new Simulation({ mergeChance: 0.3, bounceChance: 0, G: 1e-12 });
		const pairs = addPairs(sim, 200, 8, 10);
		const bodyCount = () => sim.bodies.length;
		const touching = () =>
			pairs.filter(({ a, b }) => {
				const p = sim.bodies.find((other) => other.id === a);
				const q = sim.bodies.find((other) => other.id === b);
				return p && q && Math.abs(p.x - q.x) < p.r + q.r;
			}).length;
		while (touching() === 0 && bodyCount() === 400) sim.step(1 / 300);
		const mergedAtFirstTouch = 400 - bodyCount(); // each merge turns two bodies into one
		assert.ok(mergedAtFirstTouch > 0, "some merge when they first touch");
		assert.ok(touching() > 100, "the rest pass through, overlapping for a while");
		for (let i = 0; i < 150; i++) sim.step(1 / 300);
		assert.equal(touching(), 0, "all through by now");
		assert.equal(400 - bodyCount(), mergedAtFirstTouch, "no pair changed its mind midway");
	});

	it("rolls again at every new encounter, so a low chance merges eventually", () => {
		const sim = new Simulation({ mergeChance: 0.05, bounceChance: 0, G: 1e-12 });
		addPairs(sim, 1, 40, 200);
		let encounters = 0;
		while (sim.bodies.length === 2 && encounters < 500) {
			// Send them back through each other.
			const [p, q] = sim.bodies;
			Object.assign(p, { x: -20, vx: 200 });
			Object.assign(q, { x: 20, vx: -200 });
			for (let i = 0; i < 60; i++) sim.step(1 / 300);
			encounters++;
		}
		assert.equal(sim.bodies.length, 1, `merged after ${encounters} encounters`);
		assert.ok(encounters > 1, "rarely on the first try at 5 %");
	});

	it("rejects chances that add up to more than 1", () => {
		assert.throws(() => new Simulation({ mergeChance: 0.7, bounceChance: 0.4 }), /at most 1/);
		assert.doesNotThrow(() => new Simulation({ mergeChance: 0.7, bounceChance: 0.3 }));
	});
});
