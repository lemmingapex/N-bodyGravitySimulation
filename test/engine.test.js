import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SimulationClient } from "../src/engine/client.js";
import { DIAGNOSTICS_MAX_BODIES, Engine, FRAME_STRIDE } from "../src/engine/engine.js";
import { LEAF_SIZE } from "../src/physics/barnesHut.js";

const colors = { random: false, color: "#123456" };

describe("Engine", () => {
	it("applies commands and reports frames with colors only when bodies change", () => {
		const engine = new Engine({ mergeChance: 0, bounceChance: 0 });
		engine.handle({ type: "addBody", body: { m: 1000, x: 0, y: 0, color: "#ff0000" } });
		engine.handle({ type: "addBody", body: { m: 1000, x: 100, y: 0 } });
		const first = /** @type {import('../src/engine/engine.js').Frame} */ (
			engine.handle({
				type: "advance",
				steps: 3,
				dt: 0.01,
				budgetMs: 1000,
				diagnostics: false,
			})
		);
		assert.equal(first.n, 2);
		assert.equal(first.data.length, 2 * FRAME_STRIDE);
		assert.equal(first.stepsDone, 3);
		assert.equal(first.steps, 3);
		assert.deepEqual(first.colors, ["#ff0000", "#bbbb99"]);
		assert.equal(first.diagnostics, null);
		assert.ok(first.data[3] > 0, "body 1 was pulled towards body 2");

		const second = engine.handle({
			type: "advance",
			steps: 1,
			dt: 0.01,
			budgetMs: 1000,
			diagnostics: true,
		});
		assert.equal(second?.colors, null, "no colors when nothing was added or removed");
		assert.ok(second?.diagnostics && second.diagnostics.potential < 0);

		engine.handle({ type: "remove", ids: [first.data[0]] });
		const third = engine.handle({
			type: "advance",
			steps: 0,
			dt: 0.01,
			budgetMs: 1000,
			diagnostics: false,
		});
		assert.equal(third?.n, 1);
		assert.deepEqual(third?.colors, ["#bbbb99"]);
	});

	it("stops stepping when the time budget runs out", () => {
		let clock = 0;
		const engine = new Engine({}, () => (clock += 10));
		const frame = engine.handle({
			type: "advance",
			steps: 100,
			dt: 0.01,
			budgetMs: 25,
			diagnostics: false,
		});
		assert.ok(frame && frame.stepsDone < 100 && frame.stepsDone >= 1, `${frame?.stepsDone}`);
	});

	it("builds presets deterministically from a seed and appends bodies", () => {
		const a = new Engine();
		const b = new Engine();
		for (const engine of [a, b]) {
			engine.handle({ type: "loadPreset", id: "disk", colors, seed: 42 });
			engine.handle({
				type: "addBodies",
				bodies: [
					{ m: 2000, x: 900, y: 0, vx: 0, vy: 1, color: "#123456" },
					{ m: 3000, x: 950, y: 0, vx: 0, vy: -1, color: "#654321" },
				],
			});
		}
		const fa = a.frame();
		const fb = b.frame();
		assert.deepEqual(fa.data, fb.data);
		assert.equal(fa.n, 301 + 2);
		assert.deepEqual(fa.colors?.slice(301), ["#123456", "#654321"]);
	});

	it("includes the Barnes–Hut cells only when asked", () => {
		const engine = new Engine();
		engine.handle({ type: "loadPreset", id: "disk", colors, seed: 1 });
		const plain = engine.handle({
			type: "advance",
			steps: 1,
			dt: 1 / 300,
			budgetMs: 100,
			diagnostics: false,
		});
		assert.equal(plain?.quadTree, null);
		const withTree = engine.handle({
			type: "advance",
			steps: 1,
			dt: 1 / 300,
			budgetMs: 100,
			diagnostics: false,
			quadTree: true,
		});
		assert.ok(withTree?.quadTree instanceof Float32Array);
		const cells = withTree.quadTree.length / 3;
		assert.ok(
			cells >= 301 / LEAF_SIZE,
			`a leaf for every ${LEAF_SIZE} bodies at most: ${cells}`,
		);
		assert.equal(withTree.quadTree.length % 3, 0);
	});

	it("loads explicit bodies and restores the clock", () => {
		const engine = new Engine();
		engine.handle({
			type: "loadBodies",
			bodies: [{ m: 5000, x: 1, y: 2, vx: 3, vy: 4, color: "#abcdef" }],
			time: 42,
		});
		const frame = engine.frame();
		assert.equal(frame.n, 1);
		assert.equal(frame.time, 42);
		assert.deepEqual(frame.colors, ["#abcdef"]);
	});

	it("skips diagnostics for very large systems", () => {
		const engine = new Engine({ solver: "barnes-hut", mergeChance: 0, bounceChance: 0 });
		for (let i = 0; i <= DIAGNOSTICS_MAX_BODIES; i++) {
			engine.handle({ type: "addBody", body: { m: 1000, x: i * 10, y: 0 } });
		}
		const frame = engine.handle({
			type: "advance",
			steps: 0,
			dt: 0.01,
			budgetMs: 10,
			diagnostics: true,
		});
		assert.equal(frame?.diagnostics, null);
	});
});

describe("SimulationClient (main-thread fallback)", () => {
	it("mirrors bodies, updating them in place between structural changes", () => {
		const client = new SimulationClient({
			useWorker: false,
			config: { mergeChance: 0, bounceChance: 0 },
		});
		assert.equal(client.mode, "local");
		client.addBody({ m: 1000, x: 0, y: 0 });
		client.addBody({ m: 1000, x: 50, y: 0 });
		assert.equal(client.bodies.length, 0, "commands apply on the next frame");

		assert.equal(client.advance({ steps: 2, dt: 0.01, budgetMs: 100 }), true);
		assert.equal(client.bodies.length, 2);
		const first = client.bodies[0];
		const x = first.x;
		client.advance({ steps: 2, dt: 0.01, budgetMs: 100 });
		assert.equal(client.bodies[0], first, "same object, updated in place");
		assert.notEqual(first.x, x);
		assert.equal(client.takeStepsApplied(), 4);
		assert.equal(client.takeStepsApplied(), 0);
		assert.equal(client.steps, 4);
	});

	it("checkpoints report when frames reflect earlier commands", () => {
		const client = new SimulationClient({ useWorker: false });
		client.advance({ steps: 0, dt: 0.01, budgetMs: 10 });
		client.addBody({ m: 1000, x: 0, y: 0 });
		const mark = client.checkpoint();
		assert.equal(client.caughtUp(mark), false, "no frame since the command yet");
		client.advance({ steps: 1, dt: 0.01, budgetMs: 10 });
		assert.equal(client.caughtUp(mark), true);
		assert.equal(client.bodies.length, 1);
	});

	it("only requests idle frames when something changed", () => {
		const client = new SimulationClient({ useWorker: false });
		assert.equal(client.advance({ steps: 0, dt: 0.01, budgetMs: 10 }), true);
		assert.equal(client.advance({ steps: 0, dt: 0.01, budgetMs: 10 }), false);
		client.clear();
		assert.equal(client.advance({ steps: 0, dt: 0.01, budgetMs: 10 }), true);
		assert.equal(client.advance({ steps: 0, dt: 0.01, budgetMs: 10, diagnostics: true }), true);
	});

	it("reports engine errors instead of throwing", () => {
		/** @type {string[]} */
		const errors = [];
		const client = new SimulationClient({ useWorker: false, onError: (m) => errors.push(m) });
		client.configure({ integrator: "nope" });
		assert.equal(errors.length, 1);
		assert.match(errors[0], /integrator/);
		assert.equal(client.advance({ steps: 1, dt: 0.01, budgetMs: 10 }), true);
		assert.equal(client.busy, false);
	});
});
