import { MIN_SCREEN_RADIUS } from "./glRenderer.js";

/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./camera.js').Point} Point */

/**
 * @typedef {object} AimScene
 * @property {'planet' | 'scenario'} kind
 * @property {Point} start World position where the body will be created.
 * @property {Point} end Tip of the velocity arrow (world).
 * @property {Point | null} band Slingshot: where the rubber band is pulled back to (world).
 * @property {number} radius World radius of the new body.
 * @property {ReadonlyArray<{ x: number, y: number, r: number, color: string }> | null} ghost
 *   Scenario tool: the bodies that will be added, relative to `start`.
 * @property {string} color
 * @property {boolean} orbit Whether the velocity is an automatic circular orbit.
 */

/**
 * @typedef {object} OverlayScene
 * @property {AimScene | null} aim
 * @property {{ points: Float64Array, count: number, impact: boolean } | null} preview
 * @property {{ x: number, y: number, r: number } | null} focus Camera follow target.
 * @property {{ x: number, y: number, r: number } | null} selected Inspected body.
 * @property {Flash[]} [flashes] Recent collisions.
 * @property {Float32Array | null} [quadTree] Barnes–Hut cells (centreX, centreY,
 *   halfWidth triples) to outline.
 */

/**
 * @typedef {object} Flash
 * @property {number} x
 * @property {number} y
 * @property {number} size World radius of the merged body (or of the pair).
 * @property {boolean} bounce A bounce rather than a merge.
 * @property {number} age 0 when it happened, 1 when gone.
 */

const AIM_COLOR = "#4db2ff";

/**
 * Transient 2D layer on top of the WebGL canvas: aiming, trajectory preview and
 * selection rings. Cleared every frame.
 */
export class OverlayRenderer {
	#canvas;
	#ctx;
	#dpr = 1;

	/** @param {HTMLCanvasElement} canvas */
	constructor(canvas) {
		this.#canvas = canvas;
		this.#ctx = context2d(canvas);
	}

	/**
	 * @param {number} width
	 * @param {number} height
	 * @param {number} dpr
	 */
	resize(width, height, dpr) {
		this.#dpr = dpr;
		this.#canvas.width = Math.max(1, Math.round(width * dpr));
		this.#canvas.height = Math.max(1, Math.round(height * dpr));
	}

	/**
	 * @param {Camera} camera
	 * @param {OverlayScene} scene
	 */
	draw(camera, scene) {
		const ctx = this.#ctx;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
		applyWorldTransform(ctx, camera, this.#dpr);
		const px = 1 / camera.zoom; // one CSS pixel in world units

		if (scene.focus) {
			ring(ctx, scene.focus, px, "rgba(255, 255, 255, 0.35)", [3 * px, 3 * px], 6);
		}
		if (scene.selected) {
			ring(ctx, scene.selected, px, AIM_COLOR, [], 4);
		}
		if (scene.quadTree?.length) drawQuadTree(ctx, scene.quadTree, camera, px);
		if (scene.flashes?.length) drawFlashes(ctx, scene.flashes, px);

		if (scene.preview && scene.preview.count > 1) {
			const { points, count, impact } = scene.preview;
			// Dashed, with a dark outline that keeps it readable over bright trails. It
			// fades along its length (the further ahead, the less certain), but never away.
			const dash = [7 * px, 5 * px];
			ctx.setLineDash(dash);
			ctx.lineCap = "butt"; // round caps would close the gaps
			ctx.lineJoin = "round";
			ctx.lineDashOffset = 0;
			ctx.strokeStyle = "rgba(5, 8, 14, 0.55)";
			ctx.lineWidth = 5 * px;
			tracePath(ctx, points, 0, count - 1);
			ctx.stroke();
			const SEGMENTS = 16;
			const perSegment = Math.ceil((count - 1) / SEGMENTS);
			ctx.lineWidth = 2.25 * px;
			let travelled = 0;
			for (let start = 0; start < count - 1; start += perSegment) {
				const end = Math.min(count - 1, start + perSegment);
				const alpha = 0.95 - 0.6 * (start / (count - 1));
				ctx.strokeStyle = `rgba(120, 200, 255, ${alpha.toFixed(3)})`;
				// Continue the dash pattern where the previous segment left off.
				ctx.lineDashOffset = travelled;
				tracePath(ctx, points, start, end);
				ctx.stroke();
				for (let k = start; k < end; k++) {
					travelled += Math.hypot(
						points[k * 2 + 2] - points[k * 2],
						points[k * 2 + 3] - points[k * 2 + 1],
					);
				}
			}
			ctx.setLineDash([]);
			ctx.lineDashOffset = 0;
			ctx.lineCap = "round";
			if (impact) {
				const x = points[(count - 1) * 2];
				const y = points[(count - 1) * 2 + 1];
				const s = 5 * px;
				ctx.strokeStyle = "#ff6b6b";
				ctx.lineWidth = 2 * px;
				ctx.beginPath();
				ctx.moveTo(x - s, y - s);
				ctx.lineTo(x + s, y + s);
				ctx.moveTo(x + s, y - s);
				ctx.lineTo(x - s, y + s);
				ctx.stroke();
			}
		}

		if (scene.aim) drawAim(ctx, scene.aim, px);
		ctx.setTransform(1, 0, 0, 1, 0, 0);
	}
}

/**
 * Starts a new path through `points[from..to]` (x, y pairs).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Float64Array} points
 * @param {number} from
 * @param {number} to
 */
function tracePath(ctx, points, from, to) {
	ctx.beginPath();
	ctx.moveTo(points[from * 2], points[from * 2 + 1]);
	for (let i = from + 1; i <= to; i++) ctx.lineTo(points[i * 2], points[i * 2 + 1]);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Camera} camera
 * @param {number} dpr
 */
function applyWorldTransform(ctx, camera, dpr) {
	const s = dpr * camera.zoom;
	ctx.setTransform(
		s,
		0,
		0,
		s,
		dpr * (camera.width / 2 - camera.x * camera.zoom),
		dpr * (camera.height / 2 - camera.y * camera.zoom),
	);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ x: number, y: number, r: number }} target
 * @param {number} px
 * @param {string} color
 * @param {number[]} dash
 * @param {number} gap Screen pixels between the body and the ring.
 */
function ring(ctx, target, px, color, dash, gap) {
	ctx.strokeStyle = color;
	ctx.lineWidth = 1.5 * px;
	ctx.setLineDash(dash);
	ctx.beginPath();
	ctx.arc(
		target.x,
		target.y,
		Math.max(target.r, MIN_SCREEN_RADIUS * px) + gap * px,
		0,
		Math.PI * 2,
	);
	ctx.stroke();
	ctx.setLineDash([]);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {AimScene} aim
 * @param {number} px
 */
function drawAim(ctx, aim, px) {
	const { start, end, band } = aim;
	if (band) {
		// Rubber band from the body to the pointer, with a grip where the finger is.
		ctx.strokeStyle = "rgba(230, 236, 245, 0.35)";
		ctx.lineWidth = 1.5 * px;
		ctx.setLineDash([3 * px, 3 * px]);
		ctx.beginPath();
		ctx.moveTo(start.x, start.y);
		ctx.lineTo(band.x, band.y);
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.fillStyle = "rgba(230, 236, 245, 0.5)";
		ctx.beginPath();
		ctx.arc(band.x, band.y, 4 * px, 0, Math.PI * 2);
		ctx.fill();
	}
	if (aim.ghost) {
		drawGhost(ctx, aim.ghost, start, px);
	} else {
		ctx.fillStyle = aim.color;
		ctx.globalAlpha = 0.8;
		ctx.beginPath();
		ctx.arc(start.x, start.y, Math.max(aim.radius, 2 * px), 0, Math.PI * 2);
		ctx.fill();
		ctx.globalAlpha = 1;
	}

	const length = Math.hypot(end.x - start.x, end.y - start.y);
	if (length > 0) {
		ctx.strokeStyle = AIM_COLOR;
		ctx.lineWidth = 2 * px;
		ctx.lineCap = "round";
		ctx.beginPath();
		ctx.moveTo(start.x, start.y);
		ctx.lineTo(end.x, end.y);
		// Arrow head.
		const ux = (end.x - start.x) / length;
		const uy = (end.y - start.y) / length;
		const head = Math.min(10 * px, length / 2);
		ctx.moveTo(end.x - head * (ux - uy * 0.5), end.y - head * (uy + ux * 0.5));
		ctx.lineTo(end.x, end.y);
		ctx.lineTo(end.x - head * (ux + uy * 0.5), end.y - head * (uy - ux * 0.5));
		ctx.stroke();
	}
}

/**
 * Outlines the Barnes–Hut cells on screen. Cells smaller than a few pixels are
 * skipped (their parent already shows that the region is crowded).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Float32Array} cells
 * @param {Camera} camera
 * @param {number} px
 */
function drawQuadTree(ctx, cells, camera, px) {
	const halfW = (camera.width / 2) * px;
	const halfH = (camera.height / 2) * px;
	const left = camera.x - halfW;
	const right = camera.x + halfW;
	const top = camera.y - halfH;
	const bottom = camera.y + halfH;
	const minHalf = 1.5 * px;
	ctx.strokeStyle = "rgba(110, 231, 183, 0.3)";
	ctx.lineWidth = px;
	ctx.setLineDash([]);
	ctx.beginPath();
	for (let i = 0; i < cells.length; i += 3) {
		const cx = cells[i];
		const cy = cells[i + 1];
		const h = cells[i + 2];
		if (h < minHalf || cx + h < left || cx - h > right || cy + h < top || cy - h > bottom) {
			continue;
		}
		ctx.rect(cx - h, cy - h, 2 * h, 2 * h);
	}
	ctx.stroke();
}

/**
 * Collision flashes: a bright core and an expanding shock ring, warm for merges and
 * cool for bounces. Drawn additively so overlapping flashes glow.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Flash[]} flashes
 * @param {number} px
 */
function drawFlashes(ctx, flashes, px) {
	ctx.save();
	ctx.globalCompositeOperation = "lighter";
	ctx.setLineDash([]);
	for (const f of flashes) {
		const ease = 1 - (1 - f.age) ** 3;
		const fade = (1 - f.age) ** 2;
		const base = Math.max(f.size, 1.5 * px);
		const color = f.bounce ? "170, 220, 255" : "255, 210, 150";
		ctx.fillStyle = `rgba(${color}, ${(0.55 * fade * (1 - f.age)).toFixed(3)})`;
		ctx.beginPath();
		ctx.arc(f.x, f.y, base * (1.4 + ease), 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = `rgba(${color}, ${(0.7 * fade).toFixed(3)})`;
		ctx.lineWidth = 1.5 * px;
		ctx.beginPath();
		ctx.arc(f.x, f.y, base * (1 + 2.5 * ease) + 16 * px * ease, 0, Math.PI * 2);
		ctx.stroke();
	}
	ctx.restore();
}

/** Beyond this many bodies the ghost shows an even sample (it's only a preview). */
const MAX_GHOST_BODIES = 3000;

/**
 * Faint copy of a scenario where it will be dropped.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {ReadonlyArray<{ x: number, y: number, r: number, color: string }>} ghost
 * @param {{ x: number, y: number }} at
 * @param {number} px
 */
function drawGhost(ctx, ghost, at, px) {
	const stride = Math.max(1, Math.ceil(ghost.length / MAX_GHOST_BODIES));
	const min = 1.2 * px;
	ctx.globalAlpha = 0.45;
	for (let i = 0; i < ghost.length; i += stride) {
		const b = ghost[i];
		ctx.fillStyle = b.color;
		ctx.beginPath();
		ctx.arc(at.x + b.x, at.y + b.y, Math.max(b.r, min), 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.globalAlpha = 1;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2DSettings} [options]
 */
function context2d(canvas, options) {
	const ctx = canvas.getContext("2d", options);
	if (!ctx) throw new Error("Canvas 2D is not supported by this browser.");
	return ctx;
}
