/**
 * A point mass with a finite radius. All quantities use simulation units where the
 * gravitational constant defaults to 1 and one length unit is one CSS pixel at zoom 1.
 *
 * @typedef {object} Body
 * @property {number} id Unique, stable identifier.
 * @property {number} m Mass (> 0).
 * @property {number} r Radius, derived from the mass via {@link radiusForMass}.
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {string} color CSS hex color.
 * @property {number} [lx] Where the body was last drawn (renderers draw a streak from
 *   there to its current position, so fast bodies leave continuous trails).
 * @property {number} [ly]
 */

/**
 * @typedef {object} BodySpec
 * @property {number} m
 * @property {number} x
 * @property {number} y
 * @property {number} [vx]
 * @property {number} [vy]
 * @property {string} [color]
 */

/** Mass scale used by the radius formula. */
export const REFERENCE_MASS = 1000;

export const DEFAULT_BODY_COLOR = "#bbbb99";

/**
 * Radius grows logarithmically with mass so huge stars stay on screen.
 * A body with zero mass has radius 1.
 *
 * @param {number} m
 */
export function radiusForMass(m) {
	return Math.log(Math.E + m / REFERENCE_MASS);
}
