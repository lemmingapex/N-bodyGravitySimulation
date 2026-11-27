import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRESETS } from "../src/physics/presets.js";
import { buildStamp, placeStamp } from "../src/stamp.js";

const colors = { random: false, color: "#abcdef" };

/** @param {ReadonlyArray<{ m: number, x: number, y: number, vx: number, vy: number }>} bodies */
function centreOfMass(bodies) {
	let m = 0;
	let x = 0;
	let y = 0;
	let vx = 0;
	let vy = 0;
	for (const b of bodies) {
		m += b.m;
		x += b.m * b.x;
		y += b.m * b.y;
		vx += b.m * b.vx;
		vy += b.m * b.vy;
	}
	return { m, x: x / m, y: y / m, vx: vx / m, vy: vy / m };
}

describe("scenario stamps", () => {
	it("are centred on their centre of mass and at rest as a whole", () => {
		for (const preset of PRESETS.filter((p) => p.id !== "empty" && p.id !== "spiral")) {
			const stamp = buildStamp(preset.id, { seed: 3, colors });
			assert.ok(stamp.bodies.length > 0, preset.id);
			const c = centreOfMass(stamp.bodies);
			assert.ok(Math.abs(c.m - stamp.mass) < 1e-9 * c.m, preset.id);
			for (const value of [c.x, c.y, c.vx, c.vy]) {
				assert.ok(Math.abs(value) < 1e-6, `${preset.id}: ${value}`);
			}
			const heaviest = stamp.bodies.reduce((a, b) => (b.m > a.m ? b : a));
			assert.equal(stamp.radius, heaviest.r);
		}
	});

	it("are reproducible from a seed and keep scenario colours", () => {
		const a = buildStamp("lagrange", { seed: 9, colors });
		const b = buildStamp("lagrange", { seed: 9, colors });
		assert.deepEqual(a, b);
		assert.ok(
			a.bodies.some((body) => body.color !== colors.color),
			"scenario colours kept",
		);
	});

	it("are placed and launched as a whole without changing their internal motion", () => {
		const stamp = buildStamp("binary", { seed: 1, colors });
		const placed = placeStamp(stamp, 500, -200, 30, 40);
		assert.equal(placed.length, stamp.bodies.length);
		const c = centreOfMass(placed);
		assert.ok(Math.abs(c.x - 500) < 1e-6 && Math.abs(c.y + 200) < 1e-6);
		assert.ok(Math.abs(c.vx - 30) < 1e-9 && Math.abs(c.vy - 40) < 1e-9);
		for (let i = 0; i < placed.length; i++) {
			assert.ok(Math.abs(placed[i].vx - stamp.bodies[i].vx - 30) < 1e-9);
			assert.ok(!("r" in placed[i]), "only body specs are sent to the engine");
		}
	});
});
