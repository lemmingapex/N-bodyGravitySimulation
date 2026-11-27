/**
 * 2D camera mapping world coordinates to screen (CSS pixel) coordinates.
 * Pure math, no DOM, so it is unit-testable.
 */

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 50;

/** @typedef {{ x: number, y: number, zoom: number }} CameraSnapshot */
/** @typedef {{ x: number, y: number }} Point */

/** @param {number} zoom */
const clampZoom = (zoom) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export class Camera {
	/** World point at the center of the screen. */
	x = 0;
	y = 0;
	/** Screen pixels per world unit. */
	zoom = 1;
	/** Viewport size in CSS pixels. */
	width = 1;
	height = 1;

	/**
	 * @param {number} width
	 * @param {number} height
	 */
	setViewport(width, height) {
		this.width = Math.max(1, width);
		this.height = Math.max(1, height);
	}

	/**
	 * @param {number} wx
	 * @param {number} wy
	 * @returns {Point}
	 */
	worldToScreen(wx, wy) {
		return {
			x: (wx - this.x) * this.zoom + this.width / 2,
			y: (wy - this.y) * this.zoom + this.height / 2,
		};
	}

	/**
	 * @param {number} sx
	 * @param {number} sy
	 * @returns {Point}
	 */
	screenToWorld(sx, sy) {
		return {
			x: (sx - this.width / 2) / this.zoom + this.x,
			y: (sy - this.height / 2) / this.zoom + this.y,
		};
	}

	/**
	 * Moves the view so the content follows a drag of (dx, dy) screen pixels.
	 *
	 * @param {number} dx
	 * @param {number} dy
	 */
	panBy(dx, dy) {
		this.x -= dx / this.zoom;
		this.y -= dy / this.zoom;
	}

	/**
	 * Zooms by `factor`, keeping the world point under (sx, sy) fixed on screen.
	 *
	 * @param {number} sx
	 * @param {number} sy
	 * @param {number} factor
	 */
	zoomAt(sx, sy, factor) {
		const before = this.screenToWorld(sx, sy);
		this.zoom = clampZoom(this.zoom * factor);
		const after = this.screenToWorld(sx, sy);
		this.x += before.x - after.x;
		this.y += before.y - after.y;
	}

	/**
	 * @param {number} wx
	 * @param {number} wy
	 */
	centerOn(wx, wy) {
		this.x = wx;
		this.y = wy;
	}

	/**
	 * Centers on (cx, cy) and zooms so a circle of radius `extent` fits the viewport.
	 *
	 * @param {number} extent
	 * @param {number} [cx]
	 * @param {number} [cy]
	 */
	fit(extent, cx = 0, cy = 0) {
		this.x = cx;
		this.y = cy;
		this.zoom = clampZoom(Math.min(this.width, this.height) / (2 * Math.max(extent, 1e-6)));
	}

	/** Radius (world units) of the largest circle visible around the center. */
	visibleRadius() {
		return Math.min(this.width, this.height) / (2 * this.zoom);
	}

	/** @returns {CameraSnapshot} */
	snapshot() {
		return { x: this.x, y: this.y, zoom: this.zoom };
	}

	/** @param {CameraSnapshot} s */
	equals(s) {
		return s.x === this.x && s.y === this.y && s.zoom === this.zoom;
	}
}

/**
 * Affine map (screen → screen) that moves pixels rendered with camera `from` to where
 * they belong under camera `to`. Used to keep trails aligned while panning/zooming:
 * `s' = k·s + (e, f)`.
 *
 * @param {CameraSnapshot} from
 * @param {CameraSnapshot} to
 * @param {number} width
 * @param {number} height
 * @returns {{ k: number, e: number, f: number }}
 */
export function reprojection(from, to, width, height) {
	const k = to.zoom / from.zoom;
	return {
		k,
		e: (width / 2) * (1 - k) + (from.x - to.x) * to.zoom,
		f: (height / 2) * (1 - k) + (from.y - to.y) * to.zoom,
	};
}

/**
 * Pan and zoom implied by a two-finger gesture moving from (a0, b0) to (a1, b1).
 *
 * @param {Point} a0
 * @param {Point} b0
 * @param {Point} a1
 * @param {Point} b1
 * @returns {{ dx: number, dy: number, scale: number, center: Point }}
 */
export function pinchGesture(a0, b0, a1, b1) {
	const c0 = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 };
	const c1 = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
	const d0 = Math.hypot(a0.x - b0.x, a0.y - b0.y);
	const d1 = Math.hypot(a1.x - b1.x, a1.y - b1.y);
	return {
		dx: c1.x - c0.x,
		dy: c1.y - c0.y,
		scale: d0 > 0 && d1 > 0 ? d1 / d0 : 1,
		center: c1,
	};
}
