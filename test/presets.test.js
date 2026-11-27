import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	BREAKUP,
	EARTH_MOON,
	FLYBY_COLORS,
	getPreset,
	LAGRANGE_COLORS,
	lagrangeGeometry,
	PRESETS,
	SPIRAL,
	spawnDisk,
} from "../src/physics/presets.js";
import { orbitalElements } from "../src/physics/orbits.js";
import { createRng } from "../src/physics/rng.js";
import { Simulation } from "../src/physics/simulation.js";
import { applySettings, defaultSettings, simulationConfig } from "../src/settings.js";
import { assertClose } from "./helpers.js";

describe("presets", () => {
	it("have unique ids", () => {
		assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
	});

	for (const preset of PRESETS) {
		it(`${preset.id}: builds a valid, finite system that fits its extent`, () => {
			const settings = defaultSettings();
			const changes = applySettings(settings, preset.settings);
			assert.deepEqual(
				changes.sort(),
				Object.keys(preset.settings)
					.filter((k) => /** @type {any} */ (defaultSettings())[k] !== preset.settings[k])
					.sort(),
				"preset settings must be valid setting values",
			);
			const sim = new Simulation(simulationConfig(settings));
			preset.build(sim, { rng: createRng(1), color: () => "#abcdef" });
			for (const b of sim.bodies) {
				assert.ok([b.x, b.y, b.vx, b.vy, b.m].every(Number.isFinite));
				assert.ok(
					Math.hypot(b.x, b.y) <= preset.extent * 1.1,
					`${preset.id} body outside extent`,
				);
			}
			for (let k = 0; k < 20; k++) sim.step(settings.timeStep);
			assert.ok(sim.bodies.every((b) => Number.isFinite(b.x)));
		});
	}

	it("keeps the newer scenarios after cold collapse, so number keys stay put", () => {
		const ids = PRESETS.map((p) => p.id);
		assert.deepEqual(ids.slice(ids.indexOf("cloud")), [
			"cloud",
			"lagrange",
			"flyby",
			"breakup",
			"spiral",
			"star",
			"empty",
		]);
	});

	it("cold collapse spins either way, chosen at random", () => {
		const spins = new Set();
		for (let seed = 1; seed <= 20; seed++) {
			const sim = new Simulation();
			getPreset("cloud").build(sim, { rng: createRng(seed), color: () => "#fff" });
			let angularMomentum = 0;
			for (const b of sim.bodies) angularMomentum += b.m * (b.x * b.vy - b.y * b.vx);
			spins.add(Math.sign(angularMomentum));
		}
		assert.deepEqual([...spins].sort(), [-1, 1]);
	});

	it("lone star is a single star at rest, as heavy as the Solar system's Sun", () => {
		const lone = new Simulation();
		getPreset("star").build(lone, { rng: createRng(1), color: () => "#fff" });
		const solar = new Simulation();
		getPreset("solar").build(solar, { rng: createRng(1), color: () => "#fff" });
		assert.equal(lone.bodies.length, 1);
		const [star] = lone.bodies;
		assert.deepEqual([star.x, star.y, star.vx, star.vy], [0, 0, 0, 0]);
		assert.equal(star.m, Math.max(...solar.bodies.map((b) => b.m)));
	});

	it("keeps the Moon on a near-circular orbit of the Earth for years", () => {
		const sim = new Simulation({ adaptive: true, maxSubsteps: 8 });
		getPreset("earth").build(sim, { rng: createRng(1), color: () => "#fff" });
		const [sun, earth, moon] = sim.bodies;
		const { sunMass, earthMass, moonMass, earthDistance, moonDistance } = EARTH_MOON;
		const pair = earthMass + moonMass;
		const year = 2 * Math.PI * Math.sqrt(earthDistance ** 3 / (sunMass + pair));
		const month = 2 * Math.PI * Math.sqrt(moonDistance ** 3 / pair);
		assert.ok(Math.abs(year / month - 13.4) < 0.2, `${year / month} months per year`);

		const dt = 1 / 300;
		let maxEccentricity = 0;
		for (let i = 0; i < (3 * year) / dt; i++) {
			sim.step(dt);
			if (i % 100 === 0) {
				maxEccentricity = Math.max(
					maxEccentricity,
					orbitalElements(moon, earth).eccentricity,
				);
			}
		}
		assert.equal(sim.bodies.length, 3, "nothing merged");
		assert.ok(maxEccentricity < 0.06, `Moon eccentricity ${maxEccentricity}`);
		const sunDistance = Math.hypot(earth.x - sun.x, earth.y - sun.y);
		assert.ok(Math.abs(sunDistance - earthDistance) < 5, `Earth at ${sunDistance}`);
	});

	it("getPreset falls back to the first preset", () => {
		assert.equal(getPreset("figure8").id, "figure8");
		assert.equal(getPreset("does-not-exist"), PRESETS[0]);
	});

	it("figure-eight returns close to its initial configuration after one period", () => {
		const sim = new Simulation({ mergeChance: 0, bounceChance: 0 });
		getPreset("figure8").build(sim, { rng: createRng(1), color: () => "#fff" });
		const start = sim.bodies.map((b) => ({ x: b.x, y: b.y }));
		const L = 200;
		const V = Math.sqrt(1e6 / L);
		const period = (6.32591398 * L) / V;
		const steps = 3000;
		for (let k = 0; k < steps; k++) sim.step(period / steps);
		sim.bodies.forEach((b, i) => {
			assertClose(b.x, start[i].x, 2);
			assertClose(b.y, start[i].y, 2);
		});
	});
});

describe("spawnDisk", () => {
	it("puts the star first and the disk on near-circular orbits", () => {
		const sim = new Simulation({ mergeChance: 0, bounceChance: 0 });
		const bodies = spawnDisk(sim, {
			x: 50,
			y: -20,
			vx: 3,
			vy: 4,
			count: 50,
			radius: 300,
			bodyMass: 1000,
			rng: createRng(4),
			color: "#ffffff",
			starColor: "#ffff00",
		});
		const [star, ...disk] = bodies;
		assert.equal(bodies.length, 51);
		assert.equal(star.m, 8e6);
		assert.equal(star.color, "#ffff00");
		for (const b of disk) {
			const dx = b.x - star.x;
			const dy = b.y - star.y;
			const radial = ((b.vx - star.vx) * dx + (b.vy - star.vy) * dy) / Math.hypot(dx, dy);
			assertClose(radial, 0, 1e-9);
			assert.ok(Math.hypot(dx, dy) <= 300 + 1e-9);
		}
	});
});

describe("galaxy collision", () => {
	it("cores pass at about the designed periapsis and stay well resolved", () => {
		const sim = new Simulation({ mergeChance: 0, bounceChance: 0, solver: "barnes-hut" });
		getPreset("galaxies").build(sim, { rng: createRng(1), color: () => "#fff" });
		const cores = sim.bodies.filter((b) => b.m > 1e7);
		assert.equal(cores.length, 2);
		let closest = Infinity;
		for (let k = 0; k < 400; k++) {
			sim.step(1 / 75);
			closest = Math.min(
				closest,
				Math.hypot(cores[0].x - cores[1].x, cores[0].y - cores[1].y),
			);
		}
		assert.ok(closest > 120 && closest < 200, `closest approach ${closest}`);
	});
});

/**
 * Builds a preset into a simulation configured with the preset's own settings.
 *
 * @param {string} id
 */
function buildPreset(id) {
	const preset = getPreset(id);
	const settings = defaultSettings();
	applySettings(settings, preset.settings);
	const sim = new Simulation(simulationConfig(settings));
	preset.build(sim, { rng: createRng(1), color: () => "#abcdef" });
	return { sim, dt: settings.timeStep };
}

describe("Lagrange points", () => {
	it("finds the five equilibrium points of the co-rotating frame", () => {
		const M = 1e8;
		const m = 1e6;
		const a = 280;
		const geo = lagrangeGeometry(1, M, m, a);
		for (const p of [geo.L1, geo.L2, geo.L3, geo.L4, geo.L5]) {
			// Gravity of both bodies plus the centrifugal force vanishes at each point.
			let fx = geo.omega ** 2 * p.x;
			let fy = geo.omega ** 2 * p.y;
			for (const [body, mass] of /** @type {const} */ ([
				[geo.star, M],
				[geo.planet, m],
			])) {
				const dx = body.x - p.x;
				const dy = body.y - p.y;
				const d3 = Math.hypot(dx, dy) ** 3;
				fx += (mass * dx) / d3;
				fy += (mass * dy) / d3;
			}
			assert.ok(Math.hypot(fx, fy) < 1e-6 * geo.omega ** 2 * a, `${JSON.stringify(p)}`);
		}
		assert.ok(geo.L1.x < geo.planet.x && geo.L1.x > 0);
		assert.ok(geo.L2.x > geo.planet.x);
		assert.ok(geo.L3.x < geo.star.x);
		assertClose(Math.hypot(geo.L4.x - geo.planet.x, geo.L4.y - geo.planet.y), a, 1e-9);
	});

	it("Trojans librate around L4 and L5 while bodies at L1–L3 drift away", () => {
		const { sim, dt } = buildPreset("lagrange");
		const [star, planet] = sim.bodies;
		assert.ok(planet.m / star.m < 1 / 25, "below Routh's stability limit");
		const barycenter = () => ({
			x: (star.x * star.m + planet.x * planet.m) / (star.m + planet.m),
			y: (star.y * star.m + planet.y * planet.m) / (star.m + planet.m),
		});
		/**
		 * Position in the frame co-rotating with the planet (planet on the +x axis).
		 *
		 * @param {{ x: number, y: number }} b
		 */
		const rotating = (b) => {
			const c = barycenter();
			const phi = Math.atan2(planet.y - c.y, planet.x - c.x);
			const dx = b.x - c.x;
			const dy = b.y - c.y;
			return {
				x: dx * Math.cos(phi) + dy * Math.sin(phi),
				y: -dx * Math.sin(phi) + dy * Math.cos(phi),
			};
		};
		const others = sim.bodies.slice(2);
		const start = new Map(others.map((b) => [b, rotating(b)]));
		/** Largest distance each body got from its starting point in the rotating frame. */
		const excursion = new Map(others.map((b) => [b, 0]));
		const a = Math.hypot(planet.x - star.x, planet.y - star.y);
		const period = 2 * Math.PI * Math.sqrt(a ** 3 / (star.m + planet.m));
		const steps = Math.round((4 * period) / dt);
		let worst = 0;
		for (let k = 0; k < steps; k++) {
			sim.step(dt);
			if (k % 10) continue;
			for (const b of others) {
				const p = rotating(b);
				const s = /** @type {{ x: number, y: number }} */ (start.get(b));
				const moved = Math.hypot(p.x - s.x, p.y - s.y);
				excursion.set(b, Math.max(/** @type {number} */ (excursion.get(b)), moved));
				const sign =
					b.color === LAGRANGE_COLORS.L4 ? 1 : b.color === LAGRANGE_COLORS.L5 ? -1 : 0;
				if (!sign) continue;
				const offset = Math.abs((Math.atan2(p.y, p.x) * 180) / Math.PI - sign * 60);
				worst = Math.max(worst, offset);
				assert.ok(Math.abs(Math.hypot(p.x, p.y) / a - 1) < 0.15, "Trojan left its orbit");
			}
		}
		// Tadpole orbits are lopsided (they reach farther from the planet than toward it),
		// but never come near the planet (0°) or the far side (±180°).
		assert.ok(worst < 60, `Trojans strayed ${worst.toFixed(1)}° from L4/L5`);
		const collinear = others.filter(
			(b) => b.color !== LAGRANGE_COLORS.L4 && b.color !== LAGRANGE_COLORS.L5,
		);
		assert.equal(collinear.length, 9);
		for (const b of collinear) {
			const moved = /** @type {number} */ (excursion.get(b));
			assert.ok(moved > 50, `${b.color} only moved ${moved.toFixed(1)}`);
		}
	});
});

describe("gravity assist", () => {
	it("speeds up probes passing behind the planet and slows those passing in front", () => {
		const { sim, dt } = buildPreset("flyby");
		const probes = sim.bodies.slice(1);
		const speed = (/** @type {import('../src/physics/body.js').Body} */ b) =>
			Math.hypot(b.vx, b.vy);
		const before = probes.map(speed);
		for (let k = 0; k < Math.round(10 / dt); k++) sim.step(dt);
		assert.equal(sim.bodies.length, probes.length + 1);
		const trailing = probes.filter((b) => b.color === FLYBY_COLORS.trailing);
		const leading = probes.filter((b) => b.color === FLYBY_COLORS.leading);
		assert.ok(trailing.length >= 3 && leading.length >= 3);
		probes.forEach((b, i) => {
			const ratio = speed(b) / before[i];
			if (b.color === FLYBY_COLORS.trailing) assert.ok(ratio > 1.1, `gained ${ratio}`);
			else assert.ok(ratio < 0.9, `lost ${ratio}`);
		});
	});
});

describe("moon breakup", () => {
	it("tides stretch the moon into a ring around the planet", () => {
		const { sim, dt } = buildPreset("breakup");
		const [planet, ...rubble] = sim.bodies;
		assert.equal(rubble.length, BREAKUP.count);
		const spread = () => {
			let cx = 0;
			let cy = 0;
			for (const b of rubble) {
				cx += b.x / rubble.length;
				cy += b.y / rubble.length;
			}
			let s = 0;
			for (const b of rubble) s += ((b.x - cx) ** 2 + (b.y - cy) ** 2) / rubble.length;
			return Math.sqrt(s);
		};
		const initial = spread();
		assert.ok(initial < 20, `a compact clump, spread ${initial}`);
		for (let k = 0; k < Math.round(15 / dt); k++) sim.step(dt);
		assert.ok(spread() > 8 * initial, `spread grew from ${initial} to ${spread()}`);
		// A ring: debris all around the planet, still bound near the original orbit.
		const sectors = new Set(
			rubble.map((b) =>
				Math.floor(((Math.atan2(b.y - planet.y, b.x - planet.x) + Math.PI) / Math.PI) * 18),
			),
		);
		assert.ok(sectors.size >= 34, `debris in ${sectors.size} of 36 sectors`);
		for (const b of rubble) {
			const d = Math.hypot(b.x - planet.x, b.y - planet.y);
			const v2 = (b.vx - planet.vx) ** 2 + (b.vy - planet.vy) ** 2;
			assert.ok(v2 / 2 < planet.m / d, "debris escaped");
		}
	});
});

describe("spiral galaxy", () => {
	it("builds 10,000 stars around a black hole quickly, in rotational balance", () => {
		const preset = getPreset("spiral");
		const sim = new Simulation({ mergeChance: 0, bounceChance: 0, solver: "barnes-hut" });
		const t0 = performance.now();
		preset.build(sim, { rng: createRng(3), color: () => "#fff" });
		const elapsed = performance.now() - t0;
		assert.equal(SPIRAL.stars, 10000);
		assert.equal(sim.bodies.length, 10001);
		assert.ok(elapsed < 1000, `built in ${elapsed.toFixed(0)} ms`);
		const [hole, ...stars] = sim.bodies;
		assert.equal(hole, sim.heaviestBody());
		let radial = 0;
		let tangential = 0;
		for (const b of stars) {
			const d = Math.hypot(b.x, b.y);
			assert.ok(d >= SPIRAL.inner && d <= SPIRAL.outer);
			radial += (b.vx * b.x + b.vy * b.y) / d / stars.length;
			tangential += (b.vy * b.x - b.vx * b.y) / d / stars.length;
		}
		assert.ok(tangential > 200, `rotation ${tangential}`);
		assert.ok(Math.abs(radial) < 0.02 * tangential, `net radial motion ${radial}`);
	});
});
