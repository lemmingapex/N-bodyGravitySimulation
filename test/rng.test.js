import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRng, uniform } from "../src/physics/rng.js";

describe("createRng", () => {
	it("is deterministic for a seed", () => {
		const a = createRng(123);
		const b = createRng(123);
		for (let i = 0; i < 100; i++) assert.equal(a(), b());
		assert.notEqual(createRng(1)(), createRng(2)());
	});

	it("produces values in [0, 1) with a roughly uniform mean", () => {
		const rng = createRng(99);
		let sum = 0;
		for (let i = 0; i < 10000; i++) {
			const v = rng();
			assert.ok(v >= 0 && v < 1);
			sum += v;
		}
		assert.ok(Math.abs(sum / 10000 - 0.5) < 0.02);
	});

	it("uniform() maps to the requested range", () => {
		const rng = createRng(5);
		for (let i = 0; i < 100; i++) {
			const v = uniform(rng, -3, 7);
			assert.ok(v >= -3 && v < 7);
		}
	});
});
