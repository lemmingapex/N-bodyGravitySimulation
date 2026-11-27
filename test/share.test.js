import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
	decodeShare,
	encodeShare,
	MAX_SHARE_LENGTH,
	MAX_SHARED_BODIES,
	readShareHash,
} from "../src/share.js";
import { defaultSettings } from "../src/settings.js";
import { createRng } from "../src/physics/rng.js";

/** @param {number} n */
function bodies(n) {
	const rng = createRng(3);
	return Array.from({ length: n }, (_, i) => ({
		m: 1000 + rng() * 1e5,
		x: (rng() - 0.5) * 800,
		y: (rng() - 0.5) * 800,
		vx: (rng() - 0.5) * 300,
		vy: (rng() - 0.5) * 300,
		color: i % 2 ? "#ff8800" : "#336699",
	}));
}

function state(n = 50) {
	const settings = defaultSettings();
	settings.integrator = "yoshida4";
	settings.mass = 25000;
	return {
		settings,
		camera: { x: 12.345, y: -6.789, zoom: 0.75 },
		time: 12.3456,
		bodies: bodies(n),
		preset: { id: "solar", seed: 1234 },
	};
}

describe("share links", () => {
	it("round-trips settings, camera, time and bodies (rounded)", async () => {
		const original = state();
		const { text, exact } = await encodeShare(original);
		assert.equal(exact, true);
		assert.match(text, /^[zj][A-Za-z0-9_-]+$/);

		const decoded = await decodeShare(text);
		assert.deepEqual(decoded.settings, original.settings);
		assert.deepEqual(decoded.camera, { x: 12.35, y: -6.79, zoom: 0.75 });
		assert.equal(decoded.time, 12.346);
		assert.deepEqual(decoded.preset, { id: "solar", seed: 1234 });
		assert.equal(decoded.bodies?.length, 50);
		decoded.bodies?.forEach((b, i) => {
			const o = original.bodies[i];
			assert.ok(Math.abs(b.x - o.x) <= 0.005 && Math.abs(b.vy - o.vy) <= 0.0005);
			assert.ok(Math.abs(b.m - o.m) / o.m < 1e-7);
			assert.equal(b.color, o.color);
		});
	});

	it("compresses well enough for typical scenes", async () => {
		const { text } = await encodeShare(state(300));
		assert.ok(text.startsWith("z"), "uses deflate when available");
		assert.ok(text.length < 20_000, `length ${text.length}`);
	});

	it("falls back to scenario + seed when the exact state is too long", async () => {
		const { text, exact } = await encodeShare(state(2000), { maxLength: 1000 });
		assert.equal(exact, false);
		const decoded = await decodeShare(text);
		assert.equal(decoded.bodies, null);
		assert.deepEqual(decoded.preset, { id: "solar", seed: 1234 });
	});

	it("reads the payload from a location hash", () => {
		assert.equal(readShareHash("#s=zAbC-_"), "zAbC-_");
		assert.equal(readShareHash("#other=1"), null);
		assert.equal(readShareHash(""), null);
	});

	it("rejects malformed or hostile payloads", async () => {
		const plain = (/** @type {unknown} */ value) =>
			`j${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
		await assert.rejects(decodeShare("x123"));
		await assert.rejects(decodeShare("j!!!"));
		await assert.rejects(decodeShare(plain({ v: 2 })));
		await assert.rejects(decodeShare(plain({ v: 1 })), /Malformed/);
		await assert.rejects(decodeShare(plain({ v: 1, b: [1, 2, 3] })), /Malformed/);
		await assert.rejects(decodeShare(plain({ v: 1, b: [-5, 0, 0, 0, 0, 0] })), /Malformed/);
		await assert.rejects(decodeShare(plain({ v: 1, b: [1, "x", 0, 0, 0, 0] })), /Malformed/);
		const zipped = (/** @type {unknown} */ value) =>
			`z${deflateRawSync(JSON.stringify(value)).toString("base64url")}`;
		const huge = new Array((MAX_SHARED_BODIES + 1) * 6).fill(1);
		await assert.rejects(decodeShare(zipped({ v: 1, b: huge })), /Malformed/);
		await assert.rejects(decodeShare(plain({ v: 1, b: huge })), /too long/);
		// A decompression bomb: a short link that would expand to 50 MB.
		const bomb = `z${deflateRawSync(Buffer.alloc(50e6, 0x20)).toString("base64url")}`;
		assert.ok(bomb.length < MAX_SHARE_LENGTH * 2);
		await assert.rejects(decodeShare(bomb), /too large/);

		const sanitized = await decodeShare(
			plain({
				v: 1,
				s: { mass: 1e99, color: "javascript:x", integrator: "nope" },
				c: [Infinity, "a", -3],
				b: [1000, 1, 2, 3, 4, 7],
				k: ["not-a-color"],
			}),
		);
		const defaults = defaultSettings();
		assert.equal(sanitized.settings.color, defaults.color);
		assert.equal(sanitized.settings.integrator, defaults.integrator);
		assert.deepEqual(sanitized.camera, { x: 0, y: 0, zoom: 1 });
		assert.equal(sanitized.bodies?.[0].color, defaults.color);
	});
});
