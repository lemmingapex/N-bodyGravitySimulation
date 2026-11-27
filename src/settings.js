import { hslToHex, isHexColor, randomPastel } from "./physics/color.js";
import { INTEGRATORS } from "./physics/integrators.js";
import { PRESETS } from "./physics/presets.js";
import { GRAVITY_SOLVERS } from "./physics/simulation.js";

/**
 * Single source of truth for every user-adjustable setting: defaults, ranges,
 * labels and validation. The control panel and persistence are both driven by it.
 *
 * @typedef {{ type: 'number', default: number, min: number, max: number, step?: number, label: string, hint?: string }} NumberField
 * @typedef {{ type: 'enum', default: string, options: Record<string, string>, label: string, hint?: string }} EnumField
 * @typedef {{ type: 'boolean', default: boolean, label: string, hint?: string }} BooleanField
 * @typedef {{ type: 'color', default: string, label: string, hint?: string }} ColorField
 * @typedef {NumberField | EnumField | BooleanField | ColorField} Field
 */

/** @param {ReadonlyArray<{ id: string, name: string }>} list */
const optionsOf = (list) => Object.fromEntries(list.map((p) => [p.id, p.name]));

/** @param {Readonly<Record<string, { label: string }>>} record */
const labelsOf = (record) =>
	Object.fromEntries(Object.entries(record).map(([id, value]) => [id, value.label]));

export const SCHEMA = Object.freeze({
	// New bodies
	tool: /** @type {EnumField} */ ({
		type: "enum",
		default: "planet",
		options: { planet: "Planet", scenario: "Scenario", pan: "Pan / zoom" },
		label: "Tool",
		hint: "What clicking or tapping in space does: add a planet, drop in the scenario chosen in the toolbar, or pan and zoom. Keys P, S and M.",
	}),
	mass: /** @type {NumberField} */ ({
		type: "number",
		default: 4000,
		min: 1000,
		max: 100000,
		step: 1000,
		label: "Mass",
		hint: "Mass of each new planet. Heavier planets are bigger and pull harder on everything around them.",
	}),
	color: /** @type {ColorField} */ ({
		type: "color",
		default: "#bbbb99",
		label: "Color",
		hint: "Color of new planets.",
	}),
	randomColors: /** @type {BooleanField} */ ({
		type: "boolean",
		default: false,
		label: "Random colors",
		hint: "Give each new planet a random color instead of the color above.",
	}),
	tapToOrbit: /** @type {BooleanField} */ ({
		type: "boolean",
		default: true,
		label: "Tap = circular orbit",
		hint: "On: a click or tap without dragging puts the new planet in a circular orbit around the body pulling on it hardest. Off: it starts at rest and falls in.",
	}),
	addScenario: /** @type {EnumField} */ ({
		type: "enum",
		default: "star",
		options: optionsOf(PRESETS.filter((p) => p.id !== "empty")),
		label: "Scenario to add",
		hint: "The scenario the scenario tool drops in. Click to place a copy; pull back and release to send it moving.",
	}),

	// Physics
	integrator: /** @type {EnumField} */ ({
		type: "enum",
		default: "leapfrog",
		options: labelsOf(INTEGRATORS),
		label: "Integrator",
		hint: "How each step moves the bodies forward in time. Leapfrog (default): fast, and keeps energy steady over long runs. Yoshida 4: more precise per step, about 3× the cost. Runge–Kutta 4: very precise per step but energy slowly drifts, about 4× the cost. Euler: cheapest and least accurate.",
	}),
	solver: /** @type {EnumField} */ ({
		type: "enum",
		default: "auto",
		options: { ...GRAVITY_SOLVERS },
		label: "Gravity solver",
		hint: "How gravity is added up. Direct: every pair of bodies, exact but slow with thousands of bodies. Barnes–Hut: distant groups of bodies count as one mass, slightly approximate but much faster. Auto (default): direct until there are 2,000 bodies, then Barnes–Hut.",
	}),
	theta: /** @type {NumberField} */ ({
		type: "number",
		default: 0.5,
		min: 0,
		max: 1.5,
		step: 0.05,
		label: "Barnes–Hut θ",
		hint: "Barnes–Hut accuracy (also used by Auto with 2,000+ bodies): a group of bodies counts as one mass when its width divided by its distance is below θ. Lower is more accurate and slower; 0 is exact.",
	}),
	timeStep: /** @type {NumberField} */ ({
		type: "number",
		default: 1 / 300,
		min: 1 / 2000,
		max: 1 / 60,
		label: "Time step",
		hint: "Longest stretch of simulated time a single physics step may cover. Smaller is more accurate but costs more. Steps also shrink automatically so there are at least 60 per second.",
	}),
	speed: /** @type {NumberField} */ ({
		type: "number",
		default: 1,
		min: 0.1,
		max: 8,
		step: 0.1,
		label: "Speed",
		hint: "How fast simulated time passes. 1× is deliberately slow to convey the scale of space. Keys [ and ] change it.",
	}),
	showQuadTree: /** @type {BooleanField} */ ({
		type: "boolean",
		default: false,
		label: "Show quadtree",
		hint: "Draw the Barnes–Hut quadtree while it is in use: space split into squares until each holds at most 8 bodies. Distant squares are treated as a single mass.",
	}),
	mergeChance: /** @type {NumberField} */ ({
		type: "number",
		default: 1,
		min: 0,
		max: 1,
		step: 0.05,
		label: "Merge chance",
		hint: "Chance that two bodies merge when they touch, combining into one that keeps their mass and momentum. Every encounter rolls afresh, so bodies that keep meeting will merge eventually even at a low chance. Merge and bounce chances add up to at most 1; whatever is left over passes through.",
	}),
	bounceChance: /** @type {NumberField} */ ({
		type: "number",
		default: 0,
		min: 0,
		max: 1,
		step: 0.05,
		label: "Bounce chance",
		hint: "Chance that two bodies bounce off each other when they touch (how hard is set by Bounciness). Raising it past what the merge chance leaves lowers the merge chance.",
	}),
	restitution: /** @type {NumberField} */ ({
		type: "number",
		default: 0.9,
		min: 0,
		max: 1,
		step: 0.05,
		label: "Bounciness",
		hint: "How much speed survives a bounce: 1 rebounds at full speed, 0 doesn't rebound at all.",
	}),
	adaptive: /** @type {BooleanField} */ ({
		type: "boolean",
		default: true,
		label: "Adaptive substeps",
		hint: "Split a step into smaller substeps when bodies pass close and accelerate hard, so near misses stay accurate. Steps/s in the stats shows ×N while this happens.",
	}),
	maxSubsteps: /** @type {NumberField} */ ({
		type: "number",
		default: 8,
		min: 1,
		max: 32,
		step: 1,
		label: "Max substeps",
		hint: "Most substeps a single step can be split into. Higher handles closer encounters accurately but can slow things down during them.",
	}),
	drag: /** @type {NumberField} */ ({
		type: "number",
		default: 0,
		min: 0,
		max: 4,
		step: 0.01,
		label: "Drag",
		hint: "Friction that drains every body's speed over time. 0 is empty space; higher values make orbits spiral inward.",
	}),

	// View
	trailLength: /** @type {NumberField} */ ({
		type: "number",
		default: 0.4, // about 3 seconds; see trailSeconds()
		min: 0,
		max: 1,
		step: 0.01,
		label: "Trail length",
		hint: "How long trails last. 0: no trails. 1: trails never fade. In between, from about half a second to a minute of motion at 1× speed.",
	}),
	follow: /** @type {EnumField} */ ({
		type: "enum",
		default: "off",
		options: {
			off: "Off",
			com: "Center of mass",
			heaviest: "Heaviest body",
			selected: "Selected body",
		},
		label: "Camera follows",
		hint: "Keep the camera on a moving point: the center of mass of everything, the heaviest body, or the body you selected. Key F cycles through them.",
	}),
	showPreview: /** @type {BooleanField} */ ({
		type: "boolean",
		default: true,
		label: "Trajectory preview",
		hint: "While aiming a new planet, draw the dashed path it will take; a red × marks where it would hit something.",
	}),
	background: /** @type {ColorField} */ ({
		type: "color",
		default: "#0d0f14",
		label: "Background",
		hint: "Color of empty space. Changing it clears the trails. Star glows add light, so they show best on dark backgrounds.",
	}),
	showHud: /** @type {BooleanField} */ ({
		type: "boolean",
		default: false,
		label: "Show stats",
		hint: "Show the stats in the top corner. When off, only the title and its buttons stay.",
	}),

	// Sound
	sound: /** @type {BooleanField} */ ({
		type: "boolean",
		default: true,
		label: "Sound",
		hint: "Ambient music and sound effects. Sound starts after your first click or key press. Key A turns it on and off.",
	}),
	musicVolume: /** @type {NumberField} */ ({
		type: "number",
		default: 0.5,
		min: 0,
		max: 1,
		step: 0.05,
		label: "Music",
		hint: "Volume of the ambient background music.",
	}),
	effectsVolume: /** @type {NumberField} */ ({
		type: "number",
		default: 0.0,
		min: 0,
		max: 1,
		step: 0.05,
		label: "Effects",
		hint: "Volume of launch, arrival and collision sounds.",
	}),
	preset: /** @type {EnumField} */ ({
		type: "enum",
		default: "disk",
		options: optionsOf(PRESETS),
		label: "Scenario",
		hint: "Replace everything with this scenario. Keys 1–9 and 0 load the first ten.",
	}),
});

/** @typedef {keyof typeof SCHEMA} SettingKey */

/**
 * @typedef {object} Settings
 * @property {string} tool
 * @property {number} mass
 * @property {string} color
 * @property {boolean} randomColors
 * @property {boolean} tapToOrbit
 * @property {string} addScenario Scenario the scenario tool drops in.
 * @property {string} integrator
 * @property {string} solver
 * @property {number} theta
 * @property {number} timeStep
 * @property {number} speed
 * @property {number} mergeChance
 * @property {number} bounceChance
 * @property {number} restitution
 * @property {number} drag
 * @property {boolean} adaptive
 * @property {number} maxSubsteps
 * @property {number} trailLength 0 = no trails, 1 = permanent; see {@link trailSeconds}.
 * @property {string} follow
 * @property {boolean} showPreview
 * @property {string} background Color of empty space.
 * @property {boolean} showHud
 * @property {boolean} showQuadTree Draw the Barnes–Hut cells (Barnes–Hut solver only).
 * @property {boolean} sound
 * @property {number} musicVolume
 * @property {number} effectsVolume
 * @property {string} preset
 */

export const STORAGE_KEY = "nbody.settings.v3";

/** @returns {Settings} */
export function defaultSettings() {
	return /** @type {Settings} */ (
		Object.fromEntries(Object.entries(SCHEMA).map(([key, field]) => [key, field.default]))
	);
}

/**
 * @param {Field} field
 * @param {unknown} value
 * @returns {unknown} A valid value, or `undefined` if `value` cannot be used.
 */
function coerce(field, value) {
	switch (field.type) {
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
			// Whole-number settings (like max substeps) must stay whole numbers.
			return Math.min(
				field.max,
				Math.max(field.min, Number.isInteger(field.step) ? Math.round(value) : value),
			);
		case "enum":
			return typeof value === "string" && Object.hasOwn(field.options, value)
				? value
				: undefined;
		case "boolean":
			return typeof value === "boolean" ? value : undefined;
		case "color":
			return typeof value === "string" && isHexColor(value) ? value : undefined;
	}
}

/**
 * Builds a complete, valid settings object from untrusted input (e.g. localStorage),
 * falling back to defaults for anything missing or invalid and clamping numbers.
 *
 * @param {unknown} raw
 * @returns {Settings}
 */
export function sanitizeSettings(raw) {
	const settings = defaultSettings();
	if (raw === null || typeof raw !== "object") return settings;
	/** @type {Record<string, unknown>} */
	const input = { ...raw, ...legacyCollisions(raw) };
	const record = /** @type {Record<string, unknown>} */ (settings);
	for (const [key, field] of Object.entries(SCHEMA)) {
		const value = coerce(/** @type {Field} */ (field), input[key]);
		if (value !== undefined) record[key] = value;
	}
	balanceCollisionChances(settings, "mergeChance");
	return settings;
}

/** Settings {@link randomSettings} changes: how things look and behave, not accuracy,
 * performance or personal preferences such as sound. */
export const RANDOMIZED_SETTINGS = Object.freeze(
	/** @type {const} */ ([
		"mass",
		"color",
		"randomColors",
		"speed",
		"mergeChance",
		"bounceChance",
		"restitution",
		"drag",
		"trailLength",
		"background",
	]),
);

/**
 * A random but sensible combination of the {@link RANDOMIZED_SETTINGS}: dark
 * backgrounds (so glows still show), drag only sometimes, and merge and bounce
 * chances that never add up to more than 1.
 *
 * @param {() => number} rng Uniform in [0, 1).
 * @returns {Pick<Settings, typeof RANDOMIZED_SETTINGS[number]>}
 */
export function randomSettings(rng) {
	/** `value` rounded to the field's step and kept in its range. */
	const snap = (/** @type {NumberField} */ field, /** @type {number} */ value) => {
		const step = field.step ?? 0.01;
		const snapped = Math.min(field.max, Math.max(field.min, Math.round(value / step) * step));
		return Math.round(snapped * 1e6) / 1e6; // 0.30000000000000004 → 0.3
	};
	/** A uniform value in [min, max] on the field's step grid. */
	const pick = (/** @type {NumberField} */ field, min = field.min, max = field.max) =>
		snap(field, min + rng() * (max - min));
	const mergeChance = pick(SCHEMA.mergeChance);
	const { mass } = SCHEMA;
	return {
		// Log-uniform, so small and huge planets are equally likely.
		mass: snap(mass, mass.min * (mass.max / mass.min) ** rng()),
		color: randomPastel(rng),
		randomColors: rng() < 0.5,
		speed: pick(SCHEMA.speed, 0.5, 2.5),
		mergeChance,
		bounceChance: pick(SCHEMA.bounceChance, 0, 1 - mergeChance),
		restitution: pick(SCHEMA.restitution, 0.5, 1),
		drag: rng() < 0.7 ? 0 : pick(SCHEMA.drag, 0.02, 0.5),
		trailLength: rng() < 0.15 ? 1 : pick(SCHEMA.trailLength, 0.2, 0.95),
		background: hslToHex(rng() * 360, 0.25 + rng() * 0.35, 0.03 + rng() * 0.08),
	};
}

/**
 * Collision chances for the `collisions` setting of older saves and share links.
 *
 * @param {object} raw
 */
function legacyCollisions(raw) {
	switch (/** @type {Record<string, unknown>} */ (raw).collisions) {
		case "merge":
			return { mergeChance: 1, bounceChance: 0 };
		case "bounce":
			return { mergeChance: 0, bounceChance: 1 };
		case "none":
			return { mergeChance: 0, bounceChance: 0 };
		default:
			return {};
	}
}

/**
 * Keeps the merge and bounce chances from adding up to more than 1 by lowering the
 * one that was not just set.
 *
 * @param {Settings} settings Mutated in place.
 * @param {'mergeChance' | 'bounceChance'} kept The chance to keep as it is.
 * @returns {SettingKey | null} The chance that was lowered, if any.
 */
export function balanceCollisionChances(settings, kept) {
	if (settings.mergeChance + settings.bounceChance <= 1 + 1e-9) return null;
	const other = kept === "mergeChance" ? "bounceChance" : "mergeChance";
	// Rounded so 1 − 0.7 shows as 0.3, not 0.30000000000000004.
	settings[other] = Math.max(0, Math.round((1 - settings[kept]) * 1e6) / 1e6);
	return other;
}

/**
 * Applies a partial update, ignoring unknown keys and invalid values.
 *
 * @param {Settings} settings Mutated in place.
 * @param {Record<string, unknown>} changes
 * @returns {string[]} Keys that actually changed.
 */
export function applySettings(settings, changes) {
	const record = /** @type {Record<string, unknown>} */ (settings);
	/** @type {string[]} */
	const changed = [];
	for (const [key, value] of Object.entries(changes)) {
		if (!Object.hasOwn(SCHEMA, key)) continue;
		const coerced = coerce(
			/** @type {Field} */ (SCHEMA[/** @type {SettingKey} */ (key)]),
			value,
		);
		if (coerced !== undefined && record[key] !== coerced) {
			record[key] = coerced;
			changed.push(key);
		}
	}
	// Respect the chance that was set: with both set, the merge chance wins.
	const kept =
		changed.includes("mergeChance") || !changed.includes("bounceChance")
			? "mergeChance"
			: "bounceChance";
	const lowered = balanceCollisionChances(settings, kept);
	if (lowered && !changed.includes(lowered)) changed.push(lowered);
	return changed;
}

/**
 * @param {Pick<Storage, 'getItem'> | undefined} storage
 * @returns {Settings}
 */
export function loadSettings(storage) {
	try {
		const json = storage?.getItem(STORAGE_KEY);
		return sanitizeSettings(json ? JSON.parse(json) : null);
	} catch {
		return defaultSettings();
	}
}

/**
 * @param {Pick<Storage, 'setItem'> | undefined} storage
 * @param {Settings} settings
 * @returns {boolean} Whether the settings were saved.
 */
export function saveSettings(storage, settings) {
	// Only values that differ from the defaults are stored, so improved defaults reach
	// people who never touched that setting.
	const defaults = defaultSettings();
	const changed = Object.fromEntries(
		Object.entries(settings).filter(
			([key, value]) => value !== defaults[/** @type {SettingKey} */ (key)],
		),
	);
	try {
		storage?.setItem(STORAGE_KEY, JSON.stringify(changed));
		return storage !== undefined;
	} catch {
		return false; // Private mode, quota exceeded, storage disabled, ...
	}
}

/**
 * Seconds of motion (at 1× speed) a trail shows for a `trailLength` setting: 0 is no
 * trails, 1 is permanent, and in between grows exponentially so the slider is
 * equally fine-grained for short and long trails (0.1 ≈ 0.5 s, 0.4 ≈ 3 s, 0.9 ≈ 60 s).
 *
 * @param {number} length
 */
export function trailSeconds(length) {
	if (!(length > 0)) return 0;
	if (length >= 1) return Infinity;
	return TRAIL_SECONDS_SCALE * TRAIL_SECONDS_BASE ** length;
}
const TRAIL_SECONDS_BASE = 120 ** 1.25; // 0.1 → 0.9 spans 0.5 s → 60 s
const TRAIL_SECONDS_SCALE = 0.5 / TRAIL_SECONDS_BASE ** 0.1;

/**
 * The subset of settings the physics engine consumes.
 *
 * @param {Settings} s
 * @returns {Partial<import('./physics/simulation.js').SimulationConfig>}
 */
export function simulationConfig(s) {
	return /** @type {Partial<import('./physics/simulation.js').SimulationConfig>} */ ({
		integrator: s.integrator,
		solver: s.solver,
		theta: s.theta,
		mergeChance: s.mergeChance,
		bounceChance: s.bounceChance,
		restitution: s.restitution,
		drag: s.drag,
		adaptive: s.adaptive,
		maxSubsteps: s.maxSubsteps,
	});
}
