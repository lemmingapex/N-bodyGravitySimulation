import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSpeed, formatThreads, isBehind } from "../src/ui/hud.js";
import { RateMeter } from "../src/ui/rateMeter.js";

describe("RateMeter", () => {
	it("averages exactly over the window, whatever the frame timing", () => {
		const meter = new RateMeter(1000);
		assert.ok(Number.isNaN(meter.rate), "no rate from a single sample");
		// Alternating 8 ms and 25 ms frames: 2 frames per 33 ms ≈ 60.6 fps. Averaging
		// 1/frameTime instead would claim about 82.
		let t = 0;
		let frames = 0;
		meter.sample(t, frames);
		for (let i = 0; i < 300; i++) {
			t += i % 2 ? 25 : 8;
			frames++;
			if (i % 8 === 7) meter.sample(t, frames);
		}
		assert.ok(Math.abs(meter.rate - 2000 / 33) < 1, `rate ${meter.rate}`);
	});

	it("follows changes within about a window", () => {
		const meter = new RateMeter(1000);
		let v = 0;
		for (let t = 0; t <= 3000; t += 250) {
			meter.sample(t, v);
			v += 15; // 60 per second
		}
		for (let t = 3250; t <= 4500; t += 250) {
			v += 5; // now 20 per second
			meter.sample(t, v);
		}
		assert.ok(Math.abs(meter.rate - 20) < 1e-9, `rate ${meter.rate}`);
	});

	it("restarts when the total goes backwards or after a long gap", () => {
		const meter = new RateMeter(1000);
		meter.sample(0, 5);
		meter.sample(500, 6);
		meter.sample(750, 0); // e.g. a new scenario reset the clock
		assert.ok(Number.isNaN(meter.rate));
		meter.sample(1000, 1);
		assert.equal(meter.rate, 4);

		meter.sample(60_000, 2); // the tab was hidden for a minute
		assert.ok(Number.isNaN(meter.rate), "doesn't average over the gap");
		meter.sample(60_500, 3);
		assert.equal(meter.rate, 2);

		meter.reset();
		assert.ok(Number.isNaN(meter.rate));
	});
});

describe("HUD speed readout", () => {
	it("formats the measured speed and flags when physics falls behind", () => {
		assert.equal(formatSpeed(1), "1.0×");
		assert.equal(formatSpeed(0.998), "1.0×");
		assert.equal(formatSpeed(0.56), "0.56×");
		assert.equal(formatSpeed(4), "4.0×");
		assert.equal(formatSpeed(Number.NaN), "–");
		assert.equal(isBehind(0.97, 1), false, "small jitter is fine");
		assert.equal(isBehind(0.56, 1), true);
		assert.equal(isBehind(3, 4), true);
		assert.equal(isBehind(Number.NaN, 1), false, "unknown yet");
	});
});

describe("HUD threads readout", () => {
	it("shows how many threads do the physics, and whether they are in use", () => {
		assert.equal(formatThreads(1, 50000), "1");
		assert.equal(formatThreads(8, 50000), "8 in use");
		assert.equal(formatThreads(8, 3000), "8 in use");
		assert.equal(formatThreads(8, 2999), "8 ready");
	});
});
