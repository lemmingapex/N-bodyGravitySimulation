import { colorFn } from "./engine/engine.js";
import { getPreset } from "./physics/presets.js";
import { createRng } from "./physics/rng.js";
import { Simulation } from "./physics/simulation.js";

/** @typedef {import('./physics/body.js').BodySpec} BodySpec */
/** @typedef {import('./engine/engine.js').ColorMode} ColorMode */
/** @typedef {Required<BodySpec> & { r: number }} StampBody */

/**
 * A scenario ready to be dropped into a running simulation: its bodies relative to
 * their centre of mass, at rest as a whole.
 *
 * @typedef {object} Stamp
 * @property {string} id Scenario id.
 * @property {StampBody[]} bodies Positions and velocities relative to the centre of mass.
 * @property {number} mass Total mass.
 * @property {number} radius Radius of the heaviest body.
 */

/**
 * Builds a scenario exactly as loading it would (same layout and scale), then moves
 * it to its centre of mass so it can be placed anywhere.
 *
 * @param {string} id Scenario id.
 * @param {{ seed: number, colors: ColorMode, G?: number }} options
 * @returns {Stamp}
 */
export function buildStamp(id, { seed, colors, G = 1 }) {
	const preset = getPreset(id);
	const sim = new Simulation({ G });
	const rng = createRng(seed);
	preset.build(sim, { rng, color: colorFn(colors, rng) });

	let mass = 0;
	let cx = 0;
	let cy = 0;
	let cvx = 0;
	let cvy = 0;
	let heaviest = sim.bodies[0];
	for (const b of sim.bodies) {
		mass += b.m;
		cx += b.m * b.x;
		cy += b.m * b.y;
		cvx += b.m * b.vx;
		cvy += b.m * b.vy;
		if (b.m > heaviest.m) heaviest = b;
	}
	if (mass > 0) {
		cx /= mass;
		cy /= mass;
		cvx /= mass;
		cvy /= mass;
	}
	return {
		id: preset.id,
		bodies: sim.bodies.map((b) => ({
			m: b.m,
			x: b.x - cx,
			y: b.y - cy,
			vx: b.vx - cvx,
			vy: b.vy - cvy,
			r: b.r,
			color: b.color,
		})),
		mass,
		radius: heaviest?.r ?? 0,
	};
}

/**
 * The stamp's bodies with their centre of mass at (x, y), moving at (vx, vy).
 *
 * @param {Stamp} stamp
 * @param {number} x
 * @param {number} y
 * @param {number} vx
 * @param {number} vy
 * @returns {Required<BodySpec>[]}
 */
export function placeStamp(stamp, x, y, vx, vy) {
	return stamp.bodies.map((b) => ({
		m: b.m,
		x: b.x + x,
		y: b.y + y,
		vx: b.vx + vx,
		vy: b.vy + vy,
		color: b.color,
	}));
}
