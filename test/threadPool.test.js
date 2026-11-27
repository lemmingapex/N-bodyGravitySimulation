import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CONTROL, ThreadPool, work } from "../src/engine/threadPool.js";
import { QuadTree, subtreesChunk } from "../src/physics/barnesHut.js";
import { CollisionGrid, pairsChunk } from "../src/physics/collisions.js";
import { createRng } from "../src/physics/rng.js";
import { Simulation } from "../src/physics/simulation.js";
import { randomState } from "./helpers.js";
import { spawnNodeWorker } from "./support/spawn.js";

/**
 * A crowded disk around a heavy center: thousands of bodies, many of them touching.
 *
 * @param {Simulation} sim
 * @param {number} n
 */
function addDisk(sim, n) {
	const rng = createRng(3);
	sim.addBody({ m: 1e7, x: 0, y: 0 });
	for (let i = 0; i < n; i++) {
		const d = 40 + 300 * Math.sqrt(rng());
		const a = rng() * Math.PI * 2;
		const v = Math.sqrt(1e7 / d);
		sim.addBody({
			m: 300 + rng() * 3000,
			x: d * Math.cos(a),
			y: d * Math.sin(a),
			vx: -v * Math.sin(a),
			vy: v * Math.cos(a),
		});
	}
}

describe("thread pool (real threads)", () => {
	/** @type {ThreadPool} */
	let pool;

	before(async () => {
		pool = new ThreadPool(3, spawnNodeWorker);
		await new Promise((resolve) => setTimeout(resolve, 300)); // let the threads start
	});
	after(() => pool.dispose());

	it("steps a big system exactly as one thread does", () => {
		const config = {
			solver: /** @type {const} */ ("barnes-hut"),
			integrator: "leapfrog",
			theta: 0.7,
			mergeChance: 0.3,
			bounceChance: 0.5,
		};
		const serial = new Simulation(config);
		const threaded = new Simulation(config);
		threaded.useThreadPool(pool);
		addDisk(serial, 6000);
		addDisk(threaded, 6000);
		const helpedBefore = pool.helped;
		for (let i = 0; i < 8; i++) {
			serial.step(1 / 300);
			threaded.step(1 / 300);
		}
		assert.ok(pool.helped > helpedBefore, "helper threads did some of the work");
		assert.ok(serial.mergeCount > 0, "bodies merged");
		assert.equal(threaded.bodies.length, serial.bodies.length);
		assert.deepEqual(
			threaded.bodies.map((b) => [b.id, b.m, b.x, b.y, b.vx, b.vy]),
			serial.bodies.map((b) => [b.id, b.m, b.x, b.y, b.vx, b.vy]),
		);
	});

	it("builds the same tree and finds the same pairs as one thread", () => {
		const s = randomState(9000, 4);
		const serialTree = new QuadTree();
		const threadedTree = new QuadTree(64, { shared: true });
		threadedTree.parallel = pool;
		serialTree.build(s, s.x, s.y);
		threadedTree.build(s, s.x, s.y);
		assert.equal(threadedTree.count, serialTree.count);
		assert.deepEqual(threadedTree.cells(Infinity), serialTree.cells(Infinity));
		for (const key of /** @type {const} */ (["order", "next", "mass", "comX", "rmax"])) {
			assert.deepEqual(
				[...threadedTree.arrays[key].subarray(0, key === "order" ? s.n : serialTree.count)],
				[...serialTree.arrays[key].subarray(0, key === "order" ? s.n : serialTree.count)],
				key,
			);
		}

		const grid = new CollisionGrid({ shared: true });
		grid.parallel = pool;
		const pairs = new CollisionGrid().find(s);
		assert.ok(pairs.length > 100, "plenty of overlaps");
		assert.deepEqual(grid.find(s), pairs);
	});
});

describe("thread pool pieces", () => {
	it("work() claims only chunks of its own run", () => {
		const control = new Int32Array(new SharedArrayBuffer(CONTROL.LENGTH * 4));
		Atomics.store(control, CONTROL.CHUNKS, 5);
		Atomics.store(control, CONTROL.CLAIM, 6 << 16);
		/** @type {number[]} */
		const done = [];
		const job = (/** @type {unknown} */ _s, /** @type {number} */ chunk) =>
			void done.push(chunk);
		const thread = { index: 0, scratch: {} };
		assert.equal(work(control, 5, job, null, thread), 0, "an older run does nothing");
		assert.equal(work(control, 6, job, null, thread), 5);
		assert.deepEqual(done, [0, 1, 2, 3, 4]);
	});

	it("a subtree that doesn't fit its arena is left undone, body order restored", () => {
		const n = 200;
		const s = randomState(n, 2);
		const order = Int32Array.from({ length: n }, (_, i) => i);
		const job = {
			order,
			ux: s.x,
			uy: s.y,
			um: s.m,
			ur: s.r,
			sx: new Float64Array(n),
			sy: new Float64Array(n),
			sm: new Float64Array(n),
			sr: new Float64Array(n),
			taskBox: Float64Array.of(0, 0, 1000),
			taskRange: Int32Array.of(0, n, 0),
			taskThread: Int32Array.of(-1),
			taskOffset: new Int32Array(1),
			taskNodes: new Int32Array(1),
			arenas: [arena(5)],
			arenaFill: new Int32Array(1),
		};
		subtreesChunk(job, 0, { index: 0, scratch: {} });
		assert.equal(job.taskThread[0], -1);
		assert.deepEqual(
			[...order],
			Array.from({ length: n }, (_, i) => i),
		);
		assert.equal(job.arenaFill[0], 0);

		job.arenas[0] = arena(1000);
		subtreesChunk(job, 0, { index: 0, scratch: {} });
		assert.equal(job.taskThread[0], 0, "fits now");
		assert.ok(job.taskNodes[0] > 5);
	});

	it("a pair chunk that doesn't fit its output is left undone", () => {
		const job = {
			x: Float64Array.of(0, 1),
			y: Float64Array.of(0, 0),
			r: Float64Array.of(1, 1),
			cellX: Int32Array.of(0, 0),
			cellY: Int32Array.of(0, 0),
			bucket: Int32Array.of(0, 0),
			items: Int32Array.of(0, 1),
			start: Int32Array.of(0, 2, 2),
			meta: Int32Array.of(2, 1),
			out: [new Int32Array(1)],
			outFill: new Int32Array(1),
			chunkThread: Int32Array.of(-1),
			chunkOffset: new Int32Array(1),
			chunkCount: new Int32Array(1),
		};
		pairsChunk(job, 0, { index: 0, scratch: {} });
		assert.equal(job.chunkThread[0], -1);
		assert.equal(job.outFill[0], 0);
		job.out[0] = new Int32Array(8);
		pairsChunk(job, 0, { index: 0, scratch: {} });
		assert.deepEqual([...job.out[0].subarray(0, job.chunkCount[0])], [0, 1]);
	});

	it("is only created in an isolated worker with spare cores", () => {
		// Node's main thread is neither a worker nor cross-origin isolated.
		assert.equal(ThreadPool.create(), null);
	});
});

/** @param {number} capacity */
function arena(capacity) {
	const f = () => new Float64Array(capacity);
	const i = () => new Int32Array(capacity);
	return {
		capacity,
		cx: f(),
		cy: f(),
		half: f(),
		mass: f(),
		comX: f(),
		comY: f(),
		rmax: f(),
		start: i(),
		end: i(),
		next: i(),
	};
}
