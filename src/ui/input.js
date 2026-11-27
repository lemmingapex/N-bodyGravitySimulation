import { pinchGesture } from "./camera.js";

/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./camera.js').Point} Point */
/** @typedef {'planet' | 'scenario'} SpawnKind */

/**
 * @typedef {object} InputHandlers
 * @property {() => string} getTool Current tool: 'planet' | 'scenario' | 'pan'.
 * @property {(kind: SpawnKind, screen: Point) => void} onAimStart
 * @property {(screen: Point) => void} onAimMove
 * @property {(screen: Point) => void} onAimEnd
 * @property {() => void} onAimCancel
 * @property {(kind: 'pan' | 'zoom') => void} onCameraInput Called after the user pans or zooms.
 */

/**
 * Translates pointer, touch and wheel input into aiming and camera actions.
 *
 * - Primary button / one finger: aim and launch a planet or scenario (per the tool).
 * - Right or middle button, Shift+drag, or the Pan tool: pan. Ctrl+click (a Mac
 *   right-click) does nothing.
 * - Wheel / trackpad pinch: zoom around the cursor.
 * - Two fingers: pan and pinch-zoom (cancels an aim in progress).
 */
export class InputController {
	#element;
	#camera;
	#handlers;
	/** @type {Map<number, Point>} */
	#pointers = new Map();
	/** @type {'idle' | 'aim' | 'pan' | 'pinch'} */
	#mode = "idle";
	#aimPointer = -1;
	#abort = new AbortController();

	/**
	 * @param {HTMLElement} element
	 * @param {Camera} camera
	 * @param {InputHandlers} handlers
	 */
	constructor(element, camera, handlers) {
		this.#element = element;
		this.#camera = camera;
		this.#handlers = handlers;
		const options = { signal: this.#abort.signal };
		element.addEventListener("pointerdown", (e) => this.#onDown(e), options);
		element.addEventListener("pointermove", (e) => this.#onMove(e), options);
		element.addEventListener("pointerup", (e) => this.#onUp(e), options);
		element.addEventListener("pointercancel", (e) => this.#onCancel(e), options);
		element.addEventListener("wheel", (e) => this.#onWheel(e), { ...options, passive: false });
		element.addEventListener("contextmenu", (e) => e.preventDefault(), options);
	}

	get aiming() {
		return this.#mode === "aim";
	}

	/** Cancels an in-progress aim (e.g. on Escape). */
	cancelAim() {
		if (this.#mode !== "aim") return;
		this.#mode = this.#pointers.size > 0 ? "pan" : "idle";
		this.#handlers.onAimCancel();
	}

	dispose() {
		this.#abort.abort();
	}

	/**
	 * @param {PointerEvent | WheelEvent} e
	 * @returns {Point}
	 */
	#position(e) {
		const rect = this.#element.getBoundingClientRect();
		return { x: e.clientX - rect.left, y: e.clientY - rect.top };
	}

	/** @param {PointerEvent} e */
	#onDown(e) {
		if (this.#pointers.size >= 2) return;
		const pos = this.#position(e);
		this.#pointers.set(e.pointerId, pos);
		try {
			this.#element.setPointerCapture(e.pointerId);
		} catch {
			// Synthetic events cannot be captured; capture is only a convenience.
		}

		if (this.#pointers.size === 2) {
			if (this.#mode === "aim") this.#handlers.onAimCancel();
			this.#mode = "pinch";
			return;
		}

		const tool = this.#handlers.getTool();
		const isMouse = e.pointerType === "mouse";
		const panButton = e.button === 1 || e.button === 2; // middle or right
		if (tool === "pan" || (isMouse && (panButton || e.shiftKey))) {
			e.preventDefault();
			this.#mode = "pan";
		} else if (!isMouse || (e.button === 0 && !e.ctrlKey)) {
			this.#startAim(e, tool === "scenario" ? "scenario" : "planet", pos);
		} else {
			this.#pointers.delete(e.pointerId);
		}
	}

	/**
	 * @param {PointerEvent} e
	 * @param {SpawnKind} kind
	 * @param {Point} pos
	 */
	#startAim(e, kind, pos) {
		e.preventDefault();
		this.#mode = "aim";
		this.#aimPointer = e.pointerId;
		this.#handlers.onAimStart(kind, pos);
	}

	/** @param {PointerEvent} e */
	#onMove(e) {
		const pos = this.#position(e);
		const previous = this.#pointers.get(e.pointerId);

		if (!previous) return; // hovering
		this.#pointers.set(e.pointerId, pos);

		switch (this.#mode) {
			case "aim":
				if (e.pointerId === this.#aimPointer) this.#handlers.onAimMove(pos);
				break;
			case "pan":
				this.#camera.panBy(pos.x - previous.x, pos.y - previous.y);
				this.#handlers.onCameraInput("pan");
				break;
			case "pinch": {
				const other = [...this.#pointers.entries()].find(([id]) => id !== e.pointerId);
				if (!other) break;
				const g = pinchGesture(previous, other[1], pos, other[1]);
				this.#camera.panBy(g.dx, g.dy);
				this.#camera.zoomAt(g.center.x, g.center.y, g.scale);
				this.#handlers.onCameraInput(Math.hypot(g.dx, g.dy) > 0.5 ? "pan" : "zoom");
				break;
			}
		}
	}

	/** @param {PointerEvent} e */
	#onUp(e) {
		if (!this.#pointers.has(e.pointerId)) return;
		if (this.#mode === "aim" && e.pointerId === this.#aimPointer) {
			this.#handlers.onAimEnd(this.#position(e));
			this.#mode = "idle";
		}
		this.#release(e.pointerId);
	}

	/** @param {PointerEvent} e */
	#onCancel(e) {
		if (this.#mode === "aim" && e.pointerId === this.#aimPointer) {
			this.#handlers.onAimCancel();
			this.#mode = "idle";
		}
		this.#release(e.pointerId);
	}

	/** @param {number} pointerId */
	#release(pointerId) {
		this.#pointers.delete(pointerId);
		if (this.#pointers.size === 0) this.#mode = "idle";
		// Lifting one finger of a pinch continues as a one-finger pan.
		else if (this.#mode === "pinch") this.#mode = "pan";
	}

	/** @param {WheelEvent} e */
	#onWheel(e) {
		e.preventDefault();
		const pixels = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
		// Trackpad pinch arrives as ctrl+wheel with small deltas.
		const sensitivity = e.ctrlKey ? 0.01 : 0.0015;
		const pos = this.#position(e);
		this.#camera.zoomAt(pos.x, pos.y, Math.exp(-pixels * sensitivity));
		this.#handlers.onCameraInput("zoom");
	}
}
