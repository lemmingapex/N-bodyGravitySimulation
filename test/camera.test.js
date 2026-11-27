import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Camera, MAX_ZOOM, MIN_ZOOM, pinchGesture, reprojection } from "../src/ui/camera.js";
import { assertClose } from "./helpers.js";

function camera() {
	const c = new Camera();
	c.setViewport(800, 600);
	c.x = 30;
	c.y = -20;
	c.zoom = 2;
	return c;
}

describe("Camera", () => {
	it("maps the camera position to the screen center", () => {
		const c = camera();
		assert.deepEqual(c.worldToScreen(30, -20), { x: 400, y: 300 });
	});

	it("screenToWorld inverts worldToScreen", () => {
		const c = camera();
		const w = c.screenToWorld(123, 456);
		const s = c.worldToScreen(w.x, w.y);
		assertClose(s.x, 123, 1e-9);
		assertClose(s.y, 456, 1e-9);
	});

	it("panBy moves content with the pointer", () => {
		const c = camera();
		const before = c.worldToScreen(0, 0);
		c.panBy(10, -5);
		const after = c.worldToScreen(0, 0);
		assertClose(after.x - before.x, 10, 1e-9);
		assertClose(after.y - before.y, -5, 1e-9);
	});

	it("zoomAt keeps the point under the cursor fixed and clamps", () => {
		const c = camera();
		const anchor = c.screenToWorld(100, 50);
		c.zoomAt(100, 50, 3);
		assert.equal(c.zoom, 6);
		const s = c.worldToScreen(anchor.x, anchor.y);
		assertClose(s.x, 100, 1e-9);
		assertClose(s.y, 50, 1e-9);
		c.zoomAt(0, 0, 1e9);
		assert.equal(c.zoom, MAX_ZOOM);
		c.zoomAt(0, 0, 1e-9);
		assert.equal(c.zoom, MIN_ZOOM);
	});

	it("fit() makes a circle of the given radius fill the shorter side", () => {
		const c = camera();
		c.fit(150);
		assert.equal(c.zoom, 2);
		assert.equal(c.x, 0);
		assert.equal(c.visibleRadius(), 150);
		c.fit(300, 10, -4);
		assert.deepEqual(c.snapshot(), { x: 10, y: -4, zoom: 1 });
	});

	it("snapshots compare by value", () => {
		const c = camera();
		const snap = c.snapshot();
		assert.ok(c.equals(snap));
		c.panBy(1, 0);
		assert.ok(!c.equals(snap));
	});

	it("guards against a zero-sized viewport", () => {
		const c = new Camera();
		c.setViewport(0, 0);
		assert.equal(c.width, 1);
	});
});

describe("reprojection", () => {
	it("maps old screen positions of world points to their new screen positions", () => {
		const c = camera();
		const from = c.snapshot();
		const world = c.screenToWorld(210, 75);
		c.zoomAt(500, 100, 1.7);
		c.panBy(-33, 12);
		const { k, e, f } = reprojection(from, c.snapshot(), c.width, c.height);
		const expected = c.worldToScreen(world.x, world.y);
		assertClose(k * 210 + e, expected.x, 1e-9);
		assertClose(k * 75 + f, expected.y, 1e-9);
	});
});

describe("pinchGesture", () => {
	it("derives pan from the midpoint and zoom from the finger distance", () => {
		const g = pinchGesture(
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 10, y: 10 },
			{ x: 210, y: 10 },
		);
		assert.equal(g.scale, 2);
		assert.deepEqual(g.center, { x: 110, y: 10 });
		assert.equal(g.dx, 60);
		assert.equal(g.dy, 10);
	});

	it("ignores degenerate distances", () => {
		const p = { x: 5, y: 5 };
		assert.equal(pinchGesture(p, p, p, { x: 6, y: 6 }).scale, 1);
	});
});
