import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRng } from "../src/physics/rng.js";
import {
	activityMeter,
	impactLoudness,
	loudestImpacts,
	spacer,
	textureLevel,
} from "../src/ui/sound.js";

describe("sound helpers", () => {
	it("map impacts to 0–1 size and intensity on log scales", () => {
		const small = impactLoudness(1000, 10);
		const huge = impactLoudness(1e8, 600);
		assert.ok(small.size === 0 && small.intensity > 0 && small.intensity < 0.5);
		assert.ok(huge.size === 1 && huge.intensity === 1);
		const mid = impactLoudness(1e5, 50);
		assert.ok(mid.size > small.size && mid.size < huge.size);
		for (const v of Object.values(impactLoudness(0, 0))) assert.ok(v >= 0 && v <= 1);
	});

	it("picks the most energetic impacts first", () => {
		// kind, x, y, mass, speed
		const records = [0, 0, 0, 1000, 10, 0, 0, 0, 10, 100, 0, 0, 0, 5000, 50];
		assert.deepEqual(loudestImpacts(records, 5, 2), [2, 0]);
		assert.deepEqual(loudestImpacts([], 5, 3), []);
	});

	it("spaces a constant stream of sounds evenly instead of in bursts", () => {
		const next = spacer(0.1, 0.15, () => 0.5); // exactly 0.1 s apart
		// Three asked for at once: spread out, the one too far behind dropped.
		assert.deepEqual([next(0), next(0), next(0)], [0, 0.1, null]);
		// Asked for 3 per 1/60 s for 2 s: about 10 per second, never bunched. (Gaps are
		// random, 0.05–0.15 s, so 2 s holds 14–41 at the extremes; seeded to be repeatable.)
		const play = spacer(0.1, 0.15, createRng(1));
		/** @type {number[]} */
		const starts = [];
		for (let frame = 0; frame < 120; frame++) {
			for (let k = 0; k < 3; k++) {
				const start = play(frame / 60);
				if (start !== null) starts.push(start);
			}
		}
		assert.ok(starts.length >= 14 && starts.length <= 30, `${starts.length} sounds`);
		for (let i = 1; i < starts.length; i++) {
			const gap = starts[i] - starts[i - 1];
			assert.ok(gap >= 0.05 - 1e-9 && gap <= 0.15 + 1e-9, `gap ${gap}`);
		}
	});

	it("measures collisions per second however unevenly they arrive", () => {
		const meter = activityMeter(0.4);
		let rate = 0;
		// 120 per second, reported in lumps of 4 every 1/30 s.
		for (let frame = 0; frame < 120; frame++) rate = meter(frame / 30, 4);
		assert.ok(Math.abs(rate - 120) < 10, `rate ${rate}`);
		assert.ok(meter(4 + 2, 0) < 1, "fades once they stop");
	});

	it("brings the collision texture in only when collisions are frequent", () => {
		assert.equal(textureLevel(0), 0);
		assert.equal(textureLevel(5), 0);
		assert.ok(textureLevel(40) > 0.3 && textureLevel(40) < 0.7);
		assert.equal(textureLevel(1e5), 1);
	});
});
