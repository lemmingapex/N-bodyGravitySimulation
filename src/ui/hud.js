import { PARALLEL_MIN_BODIES } from "../physics/barnesHut.js";
import { byId } from "./dom.js";

/**
 * @typedef {object} HudStats
 * @property {number} bodies
 * @property {number} fps
 * @property {number} time Simulated time.
 * @property {number} stepsPerSecond
 * @property {number} simSpeed Simulated time actually passing, as a multiple of 1× speed.
 * @property {number} speed The speed setting: what `simSpeed` should be.
 * @property {number} substeps Adaptive substeps in the latest step.
 * @property {number} energyDrift Relative change in total energy (NaN if unknown).
 * @property {boolean} paused
 * @property {number} threads Threads doing the physics of large simulations.
 */

/**
 * The statistics readout in the top-left corner: one stat per line, values
 * right-aligned in tabular digits so nothing shifts as they change.
 */
export class Hud {
	#root = byId("hud", HTMLElement);
	#hint = byId("hint", HTMLElement);
	#bodies = byId("stat-bodies", HTMLElement);
	#fps = byId("stat-fps", HTMLElement);
	#time = byId("stat-time", HTMLElement);
	#simSpeed = byId("stat-speed", HTMLElement);
	#steps = byId("stat-steps", HTMLElement);
	#threads = byId("stat-threads", HTMLElement);
	#energy = byId("stat-energy", HTMLElement);

	/** @param {boolean} visible */
	setStatsVisible(visible) {
		this.#root.classList.toggle("hud--compact", !visible);
	}

	/** @param {string} text Empty hides the hint. */
	setHint(text) {
		this.#hint.textContent = text;
		this.#hint.hidden = text === "";
	}

	/** @param {HudStats} s */
	update(s) {
		this.#bodies.textContent = s.bodies.toLocaleString();
		this.#fps.textContent = Number.isFinite(s.fps) ? s.fps.toFixed(0) : "–";
		this.#time.textContent = s.time.toFixed(1);
		const steps = Number.isFinite(s.stepsPerSecond) ? Math.round(s.stepsPerSecond) : "–";
		this.#steps.textContent = s.paused
			? "paused"
			: `${steps}${s.substeps > 1 ? ` ×${s.substeps}` : ""}`;
		const behind = !s.paused && isBehind(s.simSpeed, s.speed);
		this.#simSpeed.textContent = s.paused
			? "paused"
			: `${formatSpeed(s.simSpeed)}${behind ? " slow" : ""}`;
		this.#simSpeed.classList.toggle("hud__value--slow", behind);
		this.#energy.textContent = formatDrift(s.energyDrift);
		this.#threads.textContent = formatThreads(s.threads, s.bodies);
	}
}

/**
 * @param {number} threads
 * @param {number} bodies
 */
export function formatThreads(threads, bodies) {
	if (!(threads > 1)) return "1";
	return `${threads} ${bodies >= PARALLEL_MIN_BODIES ? "in use" : "ready"}`;
}

/**
 * Whether the simulation runs clearly slower than asked: physics can't keep up.
 *
 * @param {number} simSpeed
 * @param {number} speed
 */
export function isBehind(simSpeed, speed) {
	return Number.isFinite(simSpeed) && simSpeed < speed * 0.9;
}

/** @param {number} speed */
export function formatSpeed(speed) {
	if (!Number.isFinite(speed)) return "–";
	return `${speed < 0.995 ? speed.toFixed(2) : speed.toFixed(1)}×`;
}

/** @param {number} drift */
export function formatDrift(drift) {
	if (!Number.isFinite(drift)) return "–";
	const percent = drift * 100;
	const magnitude = Math.abs(percent);
	const digits = magnitude >= 10 ? 1 : magnitude >= 0.1 ? 2 : 4;
	const sign = percent > 0 ? "+" : percent < 0 ? "−" : "";
	return `${sign}${magnitude.toFixed(digits)} %`;
}
