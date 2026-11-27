import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHexColor } from "../src/physics/color.js";
import { PRESETS } from "../src/physics/presets.js";
import { createRng } from "../src/physics/rng.js";
import { Simulation } from "../src/physics/simulation.js";
import {
	applySettings,
	balanceCollisionChances,
	defaultSettings,
	loadSettings,
	RANDOMIZED_SETTINGS,
	randomSettings,
	sanitizeSettings,
	saveSettings,
	SCENARIO_SETTINGS,
	scenarioSettings,
	SCHEMA,
	simulationConfig,
	STORAGE_KEY,
	trailSeconds,
} from "../src/settings.js";

/** In-memory stand-in for localStorage. */
function memoryStorage() {
	/** @type {Map<string, string>} */
	const map = new Map();
	return {
		map,
		getItem: (/** @type {string} */ k) => map.get(k) ?? null,
		setItem: (/** @type {string} */ k, /** @type {string} */ v) => void map.set(k, v),
	};
}

describe("settings", () => {
	it("defaults satisfy the schema and configure a simulation", () => {
		const defaults = defaultSettings();
		assert.deepEqual(sanitizeSettings(defaults), defaults);
		for (const [key, field] of Object.entries(SCHEMA)) {
			assert.ok(key in defaults, key);
			if (field.type === "number")
				assert.ok(field.min <= field.default && field.default <= field.max);
		}
		assert.doesNotThrow(() => new Simulation(simulationConfig(defaults)));
	});

	it("maps trail length to seconds: 0 off, 1 permanent, smooth in between", () => {
		assert.equal(trailSeconds(0), 0);
		assert.equal(trailSeconds(-1), 0);
		assert.equal(trailSeconds(Number.NaN), 0);
		assert.equal(trailSeconds(1), Infinity);
		assert.ok(Math.abs(trailSeconds(0.1) - 0.5) < 1e-9);
		assert.ok(Math.abs(trailSeconds(0.9) - 60) < 1e-9);
		assert.ok(Math.abs(trailSeconds(SCHEMA.trailLength.default) - 3) < 0.1, "default ≈ 3 s");
		let previous = 0;
		for (let t = 0.01; t < 1; t += 0.01) {
			const seconds = trailSeconds(t);
			assert.ok(seconds > previous && Number.isFinite(seconds));
			previous = seconds;
		}
	});

	it("randomizes only look-and-behaviour settings, always to valid values", () => {
		const rng = createRng(42);
		/** @type {Map<string, Set<unknown>>} */
		const seen = new Map(RANDOMIZED_SETTINGS.map((key) => [key, new Set()]));
		for (let i = 0; i < 500; i++) {
			const random = randomSettings(rng);
			assert.deepEqual(Object.keys(random).sort(), [...RANDOMIZED_SETTINGS].sort());
			const settings = { ...defaultSettings(), ...random };
			assert.deepEqual(sanitizeSettings(settings), settings, "every value is valid as is");
			assert.ok(random.mergeChance + random.bounceChance <= 1 + 1e-9);
			const rgb = /** @type {{ r: number, g: number, b: number }} */ (
				parseHexColor(random.background)
			);
			assert.ok(Math.max(rgb.r, rgb.g, rgb.b) < 64, `dark background ${random.background}`);
			for (const [key, value] of Object.entries(random)) seen.get(key)?.add(value);
		}
		for (const [key, values] of seen) assert.ok(values.size > 1, `${key} varies`);
		assert.ok(seen.get("drag")?.has(0), "often no drag");
		assert.ok(seen.get("trailLength")?.has(1), "sometimes permanent trails");
	});

	it("give every scenario a full set of scenario settings", () => {
		const defaults = /** @type {Record<string, unknown>} */ (defaultSettings());
		for (const preset of PRESETS) {
			for (const key of Object.keys(preset.settings)) {
				assert.ok(
					SCENARIO_SETTINGS.includes(/** @type {any} */ (key)),
					`${preset.id} sets ${key}, which isn't a scenario setting`,
				);
			}
			const own = scenarioSettings(preset.id);
			assert.equal(own.preset, preset.id);
			for (const key of SCENARIO_SETTINGS) assert.ok(key in own, `${preset.id}: ${key}`);
		}
		// The default scenario is what a first visit shows with the default settings.
		const first = /** @type {Record<string, unknown>} */ (
			scenarioSettings(SCHEMA.preset.default)
		);
		for (const key of SCENARIO_SETTINGS) assert.equal(first[key], defaults[key], key);
		// What one scenario changes doesn't stick: the next one sets it again.
		const settings = defaultSettings();
		applySettings(settings, scenarioSettings("earth"));
		assert.equal(settings.trailLength, 0);
		applySettings(settings, scenarioSettings("disk"));
		assert.equal(settings.trailLength, SCHEMA.trailLength.default);
	});

	it("sanitizes untrusted input", () => {
		const s = sanitizeSettings({
			mass: 1e12,
			trailLength: -1,
			color: "javascript:alert(1)",
			integrator: "nope",
			randomColors: "yes",
			speed: Number.NaN,
			mergeChance: 0.7,
			bounceChance: 0.6,
			maxSubsteps: 2.5,
			unknownKey: 1,
		});
		assert.equal(s.mass, SCHEMA.mass.max);
		assert.equal(s.trailLength, SCHEMA.trailLength.min);
		assert.equal(s.color, SCHEMA.color.default);
		assert.equal(s.integrator, SCHEMA.integrator.default);
		assert.equal(s.randomColors, false);
		assert.equal(s.speed, SCHEMA.speed.default);
		assert.equal(s.mergeChance, 0.7);
		assert.equal(s.bounceChance, 0.3, "chances can't add up to more than 1");
		assert.equal(s.maxSubsteps, 3, "whole-number settings stay whole");
		assert.doesNotThrow(() => new Simulation(simulationConfig(s)));
		assert.ok(!("unknownKey" in s));
		assert.deepEqual(sanitizeSettings(null), defaultSettings());
		assert.deepEqual(sanitizeSettings("string"), defaultSettings());
	});

	it("applySettings reports only real changes", () => {
		const s = defaultSettings();
		assert.deepEqual(
			applySettings(s, {
				mergeChance: 0,
				bounceChance: 0,
				mass: s.mass,
				bogus: 1,
				solver: "x",
			}),
			["mergeChance"],
		);
		assert.equal(s.mergeChance, 0);
	});

	it("keeps the chance that was just set and lowers the other", () => {
		const s = defaultSettings();
		assert.deepEqual(applySettings(s, { bounceChance: 0.25 }), ["bounceChance", "mergeChance"]);
		assert.deepEqual([s.mergeChance, s.bounceChance], [0.75, 0.25]);
		assert.deepEqual(applySettings(s, { mergeChance: 0.9 }), ["mergeChance", "bounceChance"]);
		assert.deepEqual([s.mergeChance, s.bounceChance], [0.9, 0.1]);
		assert.deepEqual(applySettings(s, { mergeChance: 0.2 }), ["mergeChance"], "room to spare");
		assert.equal(balanceCollisionChances(s, "bounceChance"), null);
	});

	it("reads the old collisions setting from earlier saves and links", () => {
		const chances = (/** @type {string} */ collisions) => {
			const s = sanitizeSettings({ ...defaultSettings(), collisions });
			return [s.mergeChance, s.bounceChance];
		};
		assert.deepEqual(chances("merge"), [1, 0]);
		assert.deepEqual(chances("bounce"), [0, 1]);
		assert.deepEqual(chances("none"), [0, 0]);
		assert.deepEqual(chances("nonsense"), [1, 0]);
		assert.ok(!("collisions" in sanitizeSettings({ collisions: "none" })));
	});

	it("round-trips through storage", () => {
		const storage = memoryStorage();
		const s = defaultSettings();
		s.mass = 25000;
		s.integrator = "yoshida4";
		assert.equal(saveSettings(storage, s), true);
		assert.ok(storage.map.has(STORAGE_KEY));
		assert.deepEqual(loadSettings(storage), s);
	});

	it("stores only changed settings so new defaults still apply", () => {
		const storage = memoryStorage();
		const s = defaultSettings();
		s.mass = 25000;
		saveSettings(storage, s);
		assert.deepEqual(JSON.parse(storage.map.get(STORAGE_KEY) ?? ""), { mass: 25000 });
	});

	it("survives broken or unavailable storage", () => {
		const throwing = {
			getItem() {
				throw new Error("SecurityError");
			},
			setItem() {
				throw new Error("QuotaExceededError");
			},
		};
		assert.deepEqual(loadSettings(throwing), defaultSettings());
		assert.equal(saveSettings(throwing, defaultSettings()), false);
		assert.deepEqual(loadSettings(undefined), defaultSettings());
		assert.equal(saveSettings(undefined, defaultSettings()), false);

		const corrupt = memoryStorage();
		corrupt.map.set(STORAGE_KEY, "{not json");
		assert.deepEqual(loadSettings(corrupt), defaultSettings());
	});
});
