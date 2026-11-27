import { byId } from "./dom.js";

/** @typedef {import('../physics/body.js').Body} Body */

/**
 * @typedef {object} InspectorInfo
 * @property {Body} body
 * @property {number | null} aroundId Body it orbits (dominant attractor), if any.
 * @property {ReturnType<typeof import('../physics/orbits.js').orbitalElements> | null} orbit
 * @property {boolean} following
 */

/** Floating card describing the selected body, with Follow / Delete actions. */
export class Inspector {
	#root = byId("inspector", HTMLElement);
	#title = byId("inspector-title", HTMLElement);
	#swatch = byId("inspector-swatch", HTMLElement);
	#fields = byId("inspector-fields", HTMLElement);
	#follow = byId("inspector-follow", HTMLButtonElement);

	/**
	 * @param {{ onFollow: () => void, onDelete: () => void, onClose: () => void }} handlers
	 */
	constructor(handlers) {
		this.#follow.addEventListener("click", handlers.onFollow);
		byId("inspector-delete", HTMLButtonElement).addEventListener("click", handlers.onDelete);
		byId("inspector-close", HTMLButtonElement).addEventListener("click", handlers.onClose);
	}

	get visible() {
		return !this.#root.hidden;
	}

	hide() {
		this.#root.hidden = true;
	}

	/** @param {InspectorInfo} info */
	show(info) {
		const { body, orbit, aroundId } = info;
		this.#root.hidden = false;
		this.#title.textContent = `Body #${body.id}`;
		this.#swatch.style.background = body.color;
		this.#follow.setAttribute("aria-pressed", String(info.following));
		this.#follow.textContent = info.following ? "Following" : "Follow";

		/** @type {[string, string][]} */
		const rows = [
			["Mass", formatNumber(body.m)],
			["Radius", body.r.toFixed(1)],
			["Speed", Math.hypot(body.vx, body.vy).toFixed(1)],
		];
		if (orbit && aroundId !== null) {
			rows.push(["Orbits", `#${aroundId} at ${orbit.distance.toFixed(0)}`]);
			if (orbit.bound) {
				rows.push(["Eccentricity", orbit.eccentricity.toFixed(3)]);
				rows.push(["Period", orbit.period.toFixed(2)]);
			} else {
				rows.push(["Trajectory", `escaping (e = ${orbit.eccentricity.toFixed(2)})`]);
			}
		}
		this.#fields.replaceChildren(
			...rows.flatMap(([label, value]) => {
				const dt = document.createElement("dt");
				dt.textContent = label;
				dt.title = FIELD_HINTS[label] ?? "";
				const dd = document.createElement("dd");
				dd.textContent = value;
				return [dt, dd];
			}),
		);
	}
}

/** Hover text for each inspector row. @type {Readonly<Record<string, string>>} */
const FIELD_HINTS = Object.freeze({
	Mass: "How much this body pulls on others, and how hard it is to move.",
	Radius: "Size of the body; it grows with mass. Bodies collide when they touch.",
	Speed: "Distance moved per unit of simulated time.",
	Orbits: "The body this one is most strongly bound to, and the distance between them.",
	Eccentricity:
		"Shape of the orbit: 0 is a perfect circle, closer to 1 is a longer, thinner ellipse.",
	Period: "Time for one full orbit, in the same simulated-time units as Time in the stats (about 5 real seconds per unit at 1× speed).",
	Trajectory:
		"Moving too fast to stay in orbit (eccentricity of 1 or more): it will escape unless something else catches it.",
});

/** @param {number} value */
function formatNumber(value) {
	return value >= 1e6
		? value.toExponential(2).replace("e+", "e")
		: Math.round(value).toLocaleString();
}
