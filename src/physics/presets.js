import { QuadTree } from "./barnesHut.js";
import { radiusForMass } from "./body.js";
import { hslToHex, randomPastel } from "./color.js";
import { uniform } from "./rng.js";
import { createState } from "./state.js";

/** @typedef {import('./simulation.js').Simulation} Simulation */
/** @typedef {import('./body.js').Body} Body */

/**
 * @typedef {object} PresetContext
 * @property {() => number} rng
 * @property {() => string} color Color for "generic" bodies (user's choice or random).
 */

/**
 * @typedef {object} Preset
 * @property {string} id
 * @property {string} name
 * @property {string} description
 * @property {number} extent Approximate world-space radius, used to fit the camera.
 * @property {Record<string, unknown>} settings Setting overrides the scenario needs to behave as intended.
 * @property {(sim: Simulation, ctx: PresetContext) => void} build Adds bodies centred on the origin.
 */

/**
 * @typedef {object} RingOptions
 * @property {number} x Center.
 * @property {number} y
 * @property {number} [vx] Velocity of the center.
 * @property {number} [vy]
 * @property {number} centralMass Mass the ring orbits (e.g. a star or a binary).
 * @property {number} inner Inner radius.
 * @property {number} outer Outer radius.
 * @property {number} count
 * @property {number} bodyMass Mean body mass (actual masses vary ±25%).
 * @property {1 | -1} [direction]
 * @property {() => number} rng
 * @property {string | (() => string)} color
 */

/**
 * Adds a ring of bodies on circular orbits. Each orbital speed accounts for the
 * central mass plus the ring mass inside that radius.
 *
 * @param {Simulation} sim
 * @param {RingOptions} o
 * @returns {Body[]}
 */
export function spawnRing(sim, o) {
	const { rng, count, direction = 1, vx = 0, vy = 0 } = o;
	const G = sim.config.G;
	const outer = Math.max(o.outer, o.inner * 1.05);
	const samples = Array.from({ length: count }, () => ({
		d: uniform(rng, o.inner, outer),
		theta: rng() * Math.PI * 2,
		m: o.bodyMass * (1 + (rng() * 2 - 1) / 4),
	})).sort((a, b) => a.d - b.d);

	let enclosed = o.centralMass;
	return samples.map(({ d, theta, m }) => {
		const speed = Math.sqrt((G * enclosed) / d);
		enclosed += m;
		const cos = Math.cos(theta);
		const sin = Math.sin(theta);
		return sim.addBody({
			m,
			x: o.x + d * cos,
			y: o.y + d * sin,
			vx: vx - direction * speed * sin,
			vy: vy + direction * speed * cos,
			color: typeof o.color === "function" ? o.color() : o.color,
		});
	});
}

/**
 * @typedef {object} DiskOptions
 * @property {number} x
 * @property {number} y
 * @property {number} [vx]
 * @property {number} [vy]
 * @property {number} count Number of bodies orbiting the star.
 * @property {number} radius Outer radius of the disk.
 * @property {number} [innerRadius] Inner radius; defaults to just outside the star.
 * @property {number} bodyMass
 * @property {number} [starMass] Defaults to 8000 × `bodyMass`, as in the original simulation.
 * @property {string} [starColor]
 * @property {1 | -1} [direction]
 * @property {() => number} rng
 * @property {string | (() => string)} color
 */

/**
 * A star surrounded by a disk of bodies on circular orbits ("star system").
 *
 * @param {Simulation} sim
 * @param {DiskOptions} o
 * @returns {Body[]} All added bodies; the star is first.
 */
export function spawnDisk(sim, o) {
	const starMass = o.starMass ?? o.bodyMass * 8000;
	const vx = o.vx ?? 0;
	const vy = o.vy ?? 0;
	const starColor = o.starColor ?? (typeof o.color === "function" ? o.color() : o.color);
	const star = sim.addBody({ m: starMass, x: o.x, y: o.y, vx, vy, color: starColor });
	const inner = o.innerRadius ?? 3 * (star.r + radiusForMass(o.bodyMass));
	const ring = spawnRing(sim, {
		x: o.x,
		y: o.y,
		vx,
		vy,
		centralMass: starMass,
		inner,
		outer: o.radius,
		count: o.count,
		bodyMass: o.bodyMass,
		direction: o.direction,
		rng: o.rng,
		color: o.color,
	});
	return [star, ...ring];
}

/**
 * Adds a body on a circular orbit around `parent` at distance `d`.
 *
 * @param {Simulation} sim
 * @param {Body} parent
 * @param {{ d: number, m: number, color: string, angle?: number }} o
 */
function addSatellite(sim, parent, { d, m, color, angle = 0 }) {
	const speed = Math.sqrt((sim.config.G * (parent.m + m)) / d);
	return sim.addBody({
		m,
		x: parent.x + d * Math.cos(angle),
		y: parent.y + d * Math.sin(angle),
		vx: parent.vx - speed * Math.sin(angle),
		vy: parent.vy + speed * Math.cos(angle),
		color,
	});
}

/**
 * Root of `f` in [lo, hi] by bisection; `f(lo)` and `f(hi)` must differ in sign.
 *
 * @param {(x: number) => number} f
 * @param {number} lo
 * @param {number} hi
 */
function bisect(f, lo, hi) {
	const sign = Math.sign(f(lo));
	for (let k = 0; k < 100; k++) {
		const mid = (lo + hi) / 2;
		if (Math.sign(f(mid)) === sign) lo = mid;
		else hi = mid;
	}
	return (lo + hi) / 2;
}

/**
 * Geometry of the circular restricted three-body problem used by the "lagrange"
 * preset, in the co-rotating frame: barycenter at the origin, star on the −x axis,
 * planet on the +x axis, rotating counterclockwise in math coordinates (so L4,
 * at +60°, leads the planet).
 *
 * @param {number} G
 * @param {number} starMass
 * @param {number} planetMass
 * @param {number} a Star–planet separation.
 */
export function lagrangeGeometry(G, starMass, planetMass, a) {
	const mu = planetMass / (starMass + planetMass);
	const omega = Math.sqrt((G * (starMass + planetMass)) / a ** 3);
	const xs = -mu * a;
	const xp = (1 - mu) * a;
	// Net force per unit mass along the x axis in the rotating frame (gravity +
	// centrifugal); the collinear points are its zeros.
	const f = (/** @type {number} */ x) =>
		omega * omega * x -
		(G * starMass * (x - xs)) / Math.abs(x - xs) ** 3 -
		(G * planetMass * (x - xp)) / Math.abs(x - xp) ** 3;
	const hill = a * Math.cbrt(mu / 3);
	return {
		mu,
		omega,
		star: { x: xs, y: 0 },
		planet: { x: xp, y: 0 },
		L1: { x: bisect(f, xp - 3 * hill, xp - hill / 10), y: 0 },
		L2: { x: bisect(f, xp + hill / 10, xp + 3 * hill), y: 0 },
		L3: { x: bisect(f, xs - 2 * a, xs - a / 2), y: 0 },
		L4: { x: xs + a / 2, y: (Math.sqrt(3) / 2) * a },
		L5: { x: xs + a / 2, y: (-Math.sqrt(3) / 2) * a },
	};
}

/**
 * Parameters of the "earth" preset. True proportions would put the Moon a fraction of
 * a pixel from the Earth, so the Earth is far heavier than in reality (giving it a
 * sphere of influence big enough to see) and the Moon sits at a quarter of that
 * sphere's radius, where the Sun's pull barely disturbs it. The Moon still goes round
 * about 13.4 times a year, as the real one does.
 */
export const EARTH_MOON = Object.freeze({
	sunMass: 4e6,
	earthMass: 2e5,
	moonMass: 2460, // 1.23 % of the Earth, as in reality
	earthDistance: 300,
	moonDistance: 19.4,
	colors: Object.freeze({ sun: "#ffd27a", earth: "#4f94ef", moon: "#cfcfcf" }),
});

/**
 * The Sun, Earth and Moon on circular orbits, with the centre of mass at rest at the
 * origin: the Earth–Moon pair circles its own barycentre, which circles the Sun.
 *
 * @param {Simulation} sim
 */
function buildEarthMoon(sim) {
	const { sunMass, earthMass, moonMass, earthDistance, moonDistance, colors } = EARTH_MOON;
	const G = sim.config.G;
	const pair = earthMass + moonMass;
	const total = sunMass + pair;
	const year = Math.sqrt((G * total) / earthDistance); // barycentre speed relative to the Sun
	const month = Math.sqrt((G * pair) / moonDistance); // Moon speed relative to the Earth
	const bx = (sunMass / total) * earthDistance;
	const bv = (sunMass / total) * year;
	sim.addBody({
		m: sunMass,
		x: bx - earthDistance,
		y: 0,
		vx: 0,
		vy: bv - year,
		color: colors.sun,
	});
	sim.addBody({
		m: earthMass,
		x: bx - (moonMass / pair) * moonDistance,
		y: 0,
		vx: 0,
		vy: bv - (moonMass / pair) * month,
		color: colors.earth,
	});
	sim.addBody({
		m: moonMass,
		x: bx + (earthMass / pair) * moonDistance,
		y: 0,
		vx: 0,
		vy: bv + (earthMass / pair) * month,
		color: colors.moon,
	});
}

/** Colors of the test bodies placed at each Lagrange point. */
export const LAGRANGE_COLORS = Object.freeze({
	L1: "#ff8a80",
	L2: "#ffd180",
	L3: "#ea80fc",
	L4: "#80d8ff",
	L5: "#b9f6ca",
});

/**
 * Star, planet (1 % of the star's mass) and test bodies at the five Lagrange points.
 *
 * @param {Simulation} sim
 * @param {() => number} rng
 */
function buildLagrange(sim, rng) {
	const G = sim.config.G;
	const starMass = 1e8;
	const planetMass = 1e6;
	const a = 280;
	const geo = lagrangeGeometry(G, starMass, planetMass, a);
	// Rotate the whole configuration so the planet starts at the top of the screen.
	const tilt = -Math.PI / 2;
	const cos = Math.cos(tilt);
	const sin = Math.sin(tilt);
	/**
	 * @param {number} X Position in the rotating frame.
	 * @param {number} Y
	 * @param {number} m
	 * @param {string} color
	 */
	const add = (X, Y, m, color) => {
		// Co-rotating with the planet: v = Ω × r about the barycenter.
		const x = X * cos - Y * sin;
		const y = X * sin + Y * cos;
		return sim.addBody({ m, x, y, vx: -geo.omega * y, vy: geo.omega * x, color });
	};
	add(geo.star.x, geo.star.y, starMass, "#ffe3a3");
	add(geo.planet.x, geo.planet.y, planetMass, "#e0a96d");

	// Trojan swarms: arcs along the orbit through L4 and L5, starting at rest in the
	// rotating frame. Each body librates on a tadpole orbit around its Lagrange point,
	// the wider the farther it starts from it, so the arcs smear into tadpole shapes.
	// The test bodies are very light: at mass 1000 their Hill radius (~4 px) would be
	// comparable to the spacing in a swarm, and they would scatter each other out of it.
	const trojan = 10;
	const count = 30;
	const spread = (20 * Math.PI) / 180;
	for (const [point, color] of /** @type {const} */ ([
		[geo.L4, LAGRANGE_COLORS.L4],
		[geo.L5, LAGRANGE_COLORS.L5],
	])) {
		const rho = Math.hypot(point.x, point.y);
		const phi = Math.atan2(point.y, point.x);
		for (let k = 0; k < count; k++) {
			const d = rho * (1 + uniform(rng, -0.003, 0.003));
			const angle = phi + spread * ((2 * k) / (count - 1) - 1) + uniform(rng, -0.004, 0.004);
			add(d * Math.cos(angle), d * Math.sin(angle), trojan, color);
		}
	}

	// A few bodies nudged slightly off the unstable collinear points; they drift away.
	for (const [point, color, nudge] of /** @type {const} */ ([
		[geo.L1, LAGRANGE_COLORS.L1, 1],
		[geo.L2, LAGRANGE_COLORS.L2, 1],
		[geo.L3, LAGRANGE_COLORS.L3, 4],
	])) {
		for (let k = 0; k < 3; k++) {
			add(
				point.x + uniform(rng, -nudge, nudge),
				point.y + uniform(rng, -nudge, nudge),
				trojan,
				color,
			);
		}
	}
}

/** Colors of probes that pass behind (gain speed) and in front of (lose speed) the planet. */
export const FLYBY_COLORS = Object.freeze({ trailing: "#ffab40", leading: "#40c4ff" });

/**
 * A planet crossing the view left to right with a column of probes rising to meet
 * it. Each probe is aimed (in the planet's frame) at impact parameter `b`; the
 * planet bends its path, and back in the original frame it leaves faster if it
 * passed behind the planet and slower if it passed in front.
 *
 * @param {Simulation} sim
 */
function buildFlyby(sim) {
	const U = 40; // planet velocity (+x)
	const V = 80; // probe speed (−y, up the screen)
	const start = -240;
	const encounter = 4.5; // sim-seconds until closest approach
	sim.addBody({ m: 4.5e5, x: start, y: 0, vx: U, vy: 0, color: "#d9b38c" });
	// Probe velocity relative to the planet, and its unit normal.
	const wx = -U;
	const wy = -V;
	const w = Math.hypot(wx, wy);
	const nx = -wy / w;
	const ny = wx / w;
	for (const b of [-170, -130, -95, -65, -40, 40, 65, 95, 130, 170]) {
		// Straight-line approach with impact parameter b, rewound from the encounter.
		// n points to +x, so b < 0 crosses the planet's track behind it.
		sim.addBody({
			m: 50,
			x: start + b * nx - wx * encounter,
			y: b * ny - wy * encounter,
			vx: U + wx,
			vy: wy,
			color: b < 0 ? FLYBY_COLORS.trailing : FLYBY_COLORS.leading,
		});
	}
}

/**
 * Parameters of the "breakup" preset. The moon's Roche limit for synchronous
 * rotation is about R·(3·planetMass / moonMass)^⅓ ≈ 310 for its radius R ≈ 18,
 * so at `distance` the planet's tides beat the moon's self-gravity about ninefold.
 */
export const BREAKUP = Object.freeze({
	planetMass: 1e7,
	count: 300,
	particleMass: 20,
	distance: 150,
});

/**
 * A rubble-pile moon that has strayed inside its planet's Roche limit: a cold,
 * self-gravitating clump of touching particles, all moving with the moon's
 * circular orbital velocity (no internal motion). Tides stretch it into a stream
 * and differential rotation winds the stream up into a ring.
 *
 * @param {Simulation} sim
 * @param {() => number} rng
 */
function buildBreakup(sim, rng) {
	const { planetMass, count, particleMass, distance } = BREAKUP;
	const moonMass = count * particleMass;
	const speed = Math.sqrt((sim.config.G * (planetMass + moonMass)) / distance);
	// Barycentric positions and velocities, so the system as a whole stays put.
	const planetShare = moonMass / (planetMass + moonMass);
	sim.addBody({
		m: planetMass,
		x: -distance * planetShare,
		y: 0,
		vy: speed * planetShare,
		color: "#7fb3d5",
	});
	const cx = distance * (1 - planetShare);
	const vy = -speed * (1 - planetShare);
	// Touching particles on a hexagonal lattice: the `count` sites nearest the center.
	const spacing = 2 * radiusForMass(particleMass) * 1.001;
	const span = Math.ceil(Math.sqrt(count));
	/** @type {{ x: number, y: number }[]} */
	const sites = [];
	for (let j = -span; j <= span; j++) {
		for (let i = -span; i <= span; i++) {
			sites.push({ x: spacing * (i + j / 2), y: spacing * (Math.sqrt(3) / 2) * j });
		}
	}
	sites.sort((a, b) => a.x * a.x + a.y * a.y - (b.x * b.x + b.y * b.y));
	const moon = sites.slice(0, count);
	const radius = Math.hypot(moon[count - 1].x, moon[count - 1].y);
	for (const site of moon) {
		// Shade from orange (leading edge) to yellow (trailing edge) to show the stretch.
		const along = site.y / radius;
		sim.addBody({
			m: particleMass,
			x: cx + site.x,
			y: site.y,
			vy,
			color: hslToHex(35 + 20 * along + uniform(rng, -4, 4), 0.85, 0.66),
		});
	}
}

/**
 * Standard normal deviate (Box–Muller).
 *
 * @param {() => number} rng
 */
function gaussian(rng) {
	return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

/** Parameters of the "spiral" preset. */
export const SPIRAL = Object.freeze({
	stars: 10000,
	starMass: 1000,
	blackHoleMass: 1e7,
	scaleLength: 100,
	inner: 40,
	outer: 360,
	/** Toomre Q: below ~1 the disk fragments into clumps, well above ~2 it stays featureless. */
	toomreQ: 1,
});

/**
 * An exponential disk of stars around a central black hole, with enough disk
 * self-gravity that swing amplification grows spiral arms out of the particle noise
 * within a rotation or two. Circular speeds come from the disk's actual (softened,
 * Barnes–Hut) gravity averaged in rings, and random velocities set its Toomre Q.
 *
 * Like real stellar disks without gas to cool them, the arms heat the disk (as do
 * close encounters, which are strong in 2D), so they fade over several rotations.
 *
 * @param {Simulation} sim
 * @param {() => number} rng
 */
function buildSpiral(sim, rng) {
	const { stars, starMass, blackHoleMass, scaleLength, inner, outer, toomreQ } = SPIRAL;
	const G = sim.config.G;
	const n = stars + 1;
	const state = createState(n);
	state.n = n;
	state.m.fill(starMass);
	state.r.fill(radiusForMass(starMass));
	state.m[0] = blackHoleMass;
	state.r[0] = radiusForMass(blackHoleMass);
	// Surface density ∝ e^(−R/h): radius ~ Gamma(2, h), truncated to [inner, outer].
	const radii = Float64Array.from({ length: stars }, () => {
		let d;
		do d = -scaleLength * Math.log((1 - rng()) * (1 - rng()));
		while (d < inner || d > outer);
		return d;
	}).sort();
	// "Quiet start": successive radii step by the golden angle (a jittered sunflower
	// pattern), which avoids the clumps and close pairs of random angles. Shot noise
	// would otherwise heat this 2D disk quickly through close encounters.
	const golden = Math.PI * (3 - Math.sqrt(5));
	for (let i = 1; i < n; i++) {
		const d = radii[i - 1];
		const angle = i * golden + uniform(rng, -0.5, 0.5) * golden;
		state.x[i] = d * Math.cos(angle);
		state.y[i] = d * Math.sin(angle);
	}

	// Mean inward pull and surface density in rings, from the actual softened gravity.
	const bins = 48;
	const width = (outer - inner) / bins;
	const center = (/** @type {number} */ k) => inner + (k + 0.5) * width;
	const pull = new Float64Array(bins);
	const count = new Float64Array(bins);
	const ax = new Float64Array(n);
	const ay = new Float64Array(n);
	const tree = new QuadTree();
	tree.build(state, state.x, state.y);
	tree.accelerations(state, state.x, state.y, ax, ay, G, 0.5);
	for (let i = 1; i < n; i++) {
		const d = Math.hypot(state.x[i], state.y[i]);
		const k = Math.min(bins - 1, Math.floor((d - inner) / width));
		pull[k] -= (ax[i] * state.x[i] + ay[i] * state.y[i]) / d;
		count[k]++;
	}
	// Per ring: v_c² · R (smooth, like an enclosed mass), σ_R and the asymmetric drift.
	const vc2R = new Float64Array(bins);
	const sigmaR = new Float64Array(bins);
	const sigmaT = new Float64Array(bins);
	const drift = new Float64Array(bins);
	for (let k = 0; k < bins; k++) {
		const d = center(k);
		// Empty rings fall back to the black hole's pull.
		const accel = count[k] > 0 ? pull[k] / count[k] : (G * blackHoleMass) / (d * d);
		vc2R[k] = Math.max(accel, 0) * d * d;
	}
	for (let k = 0; k < bins; k++) {
		const d = center(k);
		const omega2 = vc2R[k] / d ** 3;
		// Epicyclic frequency κ² = R dΩ²/dR + 4Ω², from neighbouring rings.
		const k0 = Math.max(k - 1, 0);
		const k1 = Math.min(k + 1, bins - 1);
		const dOmega2 =
			(vc2R[k1] / center(k1) ** 3 - vc2R[k0] / center(k0) ** 3) / (center(k1) - center(k0));
		const kappa2 = Math.max(d * dOmega2 + 4 * omega2, omega2);
		const density = (count[k] * starMass) / (2 * Math.PI * d * width);
		sigmaR[k] = (toomreQ * 3.36 * G * density) / Math.sqrt(kappa2);
		sigmaT[k] = sigmaR[k] * Math.sqrt(kappa2 / (4 * omega2));
		// Asymmetric drift (Jeans equation, taking Σσ² ∝ e^(−2R/h)): random motions
		// support part of the weight, so stars orbit a little slower than circular.
		drift[k] = sigmaR[k] ** 2 * (1 - kappa2 / (4 * omega2) - (2 * d) / scaleLength);
	}
	/** Linear interpolation of a ring profile at radius d. */
	const at = (/** @type {Float64Array} */ profile, /** @type {number} */ d) => {
		const f = Math.min(Math.max((d - inner) / width - 0.5, 0), bins - 1);
		const k = Math.min(Math.floor(f), bins - 2);
		return profile[k] + (profile[k + 1] - profile[k]) * (f - k);
	};

	sim.addBody({ m: blackHoleMass, x: 0, y: 0, color: "#fff6d8" });
	for (let i = 1; i < n; i++) {
		const x = state.x[i];
		const y = state.y[i];
		const d = Math.hypot(x, y);
		const vr = at(sigmaR, d) * gaussian(rng);
		const vt =
			Math.sqrt(Math.max(at(vc2R, d) / d + at(drift, d), 0)) + at(sigmaT, d) * gaussian(rng);
		const t = (d - inner) / (outer - inner);
		sim.addBody({
			m: starMass,
			x,
			y,
			vx: (vr * x - vt * y) / d,
			vy: (vr * y + vt * x) / d,
			color: hslToHex(45 + 175 * t + uniform(rng, -15, 15), 0.7, 0.78 - 0.12 * t),
		});
	}
}

/** @type {ReadonlyArray<Preset>} */
export const PRESETS = Object.freeze([
	{
		id: "disk",
		name: "Protoplanetary disk",
		description: "A star with 300 bodies on circular orbits that collide and accrete.",
		extent: 420,
		settings: { mergeChance: 1, bounceChance: 0 },
		build(sim, { rng, color }) {
			spawnDisk(sim, {
				x: 0,
				y: 0,
				count: 300,
				radius: 400,
				bodyMass: 4000,
				starColor: "#ffe3a3",
				rng,
				color,
			});
		},
	},
	{
		id: "solar",
		name: "Solar system",
		description: "Planets, an asteroid belt, a comet and a gas giant with moons.",
		extent: 520,
		settings: { mergeChance: 1, bounceChance: 0 },
		// Spaced to stay stable for many orbits: the planets are well clear of each
		// other's pull, the asteroids are too light to pull each other into collisions,
		// and the belt is outside the giant's zone of chaotic orbits (wider the heavier
		// the giant: about 1.3·(m/M)^(2/7) of its distance).
		build(sim, { rng }) {
			const sun = sim.addBody({ m: 3.2e7, x: 0, y: 0, color: "#ffd27a" });
			const planets = [
				{ d: 60, m: 3000, color: "#b8aaa2" },
				{ d: 90, m: 9000, color: "#e8c07d" },
				{ d: 125, m: 10000, color: "#6fa8ff" },
				{ d: 165, m: 5000, color: "#e07a5f" },
			];
			for (const p of planets) addSatellite(sim, sun, { ...p, angle: rng() * Math.PI * 2 });
			spawnRing(sim, {
				x: 0,
				y: 0,
				centralMass: sun.m,
				inner: 200,
				outer: 245,
				count: 60,
				bodyMass: 10,
				rng,
				color: "#8a8478",
			});
			const giant = addSatellite(sim, sun, {
				d: 360,
				m: 50000,
				color: "#d9b38c",
				angle: rng() * Math.PI * 2,
			});
			addSatellite(sim, giant, { d: 7, m: 100, color: "#dddddd" });
			addSatellite(sim, giant, { d: 11, m: 60, color: "#f0e6b0", angle: Math.PI });
			addSatellite(sim, sun, {
				d: 490,
				m: 10000,
				color: "#a9d8ec",
				angle: rng() * Math.PI * 2,
			});
			// A comet on an eccentric orbit, released at aphelion (vis-viva equation).
			const ra = 440;
			const rp = 45;
			const speed = Math.sqrt((sim.config.G * sun.m * 2 * rp) / (ra * (ra + rp)));
			// Light, so its close passes don't knock planets and moons off course.
			sim.addBody({ m: 20, x: -ra, y: 0, vx: 0, vy: -speed, color: "#9ff3ff" });
			// The Sun starts at rest and the planets don't, so the whole system would
			// drift: give everything the opposite of the total momentum.
			const total = sim.bodies.reduce((sum, b) => sum + b.m, 0);
			const px = sim.bodies.reduce((sum, b) => sum + b.m * b.vx, 0);
			const py = sim.bodies.reduce((sum, b) => sum + b.m * b.vy, 0);
			for (const b of sim.bodies) {
				b.vx -= px / total;
				b.vy -= py / total;
			}
		},
	},
	{
		id: "earth",
		name: "Sun, Earth & Moon",
		description:
			"The Moon circling the Earth as both circle the Sun (masses and distances adjusted to fit on screen).",
		extent: 400,
		settings: { mergeChance: 1, bounceChance: 0, trailLength: 0 },
		build(sim) {
			buildEarthMoon(sim);
		},
	},
	{
		id: "binary",
		name: "Binary star",
		description: "Two stars in a tight orbit with a circumbinary disk.",
		extent: 440,
		settings: { mergeChance: 1, bounceChance: 0 },
		build(sim, { rng, color }) {
			const m = 1.6e7;
			const a = 80;
			const speed = Math.sqrt((sim.config.G * m) / (2 * a));
			sim.addBody({ m, x: -a / 2, y: 0, vx: 0, vy: -speed, color: "#ffcf8a" });
			sim.addBody({ m, x: a / 2, y: 0, vx: 0, vy: speed, color: "#9fc4ff" });
			spawnRing(sim, {
				x: 0,
				y: 0,
				centralMass: 2 * m,
				inner: 2.5 * a,
				outer: 420,
				count: 220,
				bodyMass: 3000,
				rng,
				color,
			});
		},
	},
	{
		id: "figure8",
		name: "Figure-eight three-body",
		description:
			"Three equal masses chasing each other along a figure eight (Chenciner & Montgomery, 2000).",
		extent: 260,
		settings: { mergeChance: 0, bounceChance: 0, drag: 0 },
		build(sim) {
			const m = 1e6;
			const L = 200;
			const V = Math.sqrt((sim.config.G * m) / L);
			const p = { x: 0.97000436 * L, y: -0.24308753 * L };
			const v3 = { x: -0.93240737 * V, y: -0.86473146 * V };
			sim.addBody({ m, x: p.x, y: p.y, vx: -v3.x / 2, vy: -v3.y / 2, color: "#ff8a80" });
			sim.addBody({ m, x: -p.x, y: -p.y, vx: -v3.x / 2, vy: -v3.y / 2, color: "#80d8ff" });
			sim.addBody({ m, x: 0, y: 0, vx: v3.x, vy: v3.y, color: "#ccff90" });
		},
	},
	{
		id: "galaxies",
		name: "Galaxy collision",
		description: "Two disk galaxies on a close encounter, throwing out tidal tails.",
		extent: 650,
		settings: { mergeChance: 0, bounceChance: 0, solver: "barnes-hut" },
		build(sim, { rng }) {
			// Equal-mass galaxies on a bound elliptical orbit (closest approach
			// `periapsis`, farthest `apoapsis`), starting inbound at `separation`.
			// Close enough for strong tides, far enough that the cores never pass through
			// each other's softening radius, and bound so they return for more passes.
			const starMass = 3.2e7;
			const periapsis = 160;
			const apoapsis = 700;
			const separation = 600;
			const mu = sim.config.G * 2 * starMass;
			const a = (periapsis + apoapsis) / 2;
			const e = (apoapsis - periapsis) / (apoapsis + periapsis);
			const speed = Math.sqrt(mu * (2 / separation - 1 / a)); // vis-viva
			const tangential = Math.sqrt(mu * a * (1 - e * e)) / separation; // h / r
			const radial = Math.sqrt(speed * speed - tangential * tangential);
			// Inner orbits start at 60 so even they get ~40 steps per revolution.
			const common = {
				count: 280,
				radius: 170,
				innerRadius: 60,
				bodyMass: 1000,
				starMass,
				rng,
			};
			spawnDisk(sim, {
				...common,
				x: -separation / 2,
				y: 0,
				vx: radial / 2,
				vy: -tangential / 2,
				direction: 1, // prograde: spins with the encounter, grows long tidal tails
				starColor: "#ffe3a3",
				color: "#8fb8ff",
			});
			spawnDisk(sim, {
				...common,
				x: separation / 2,
				y: 0,
				vx: -radial / 2,
				vy: tangential / 2,
				direction: -1, // retrograde: survives the encounter mostly intact
				starColor: "#ffe3a3",
				color: "#ffab91",
			});
		},
	},
	{
		id: "cloud",
		name: "Cold collapse",
		description:
			"A slowly rotating cloud of dust that collapses and clumps into planets. It spins a random way each time.",
		extent: 400,
		settings: { mergeChance: 1, bounceChance: 0 },
		build(sim, { rng }) {
			const R = 350;
			const specs = Array.from({ length: 400 }, () => {
				const d = R * Math.sqrt(rng());
				const theta = rng() * Math.PI * 2;
				return { d, theta, m: uniform(rng, 2000, 12000) };
			});
			const total = specs.reduce((sum, s) => sum + s.m, 0);
			// Drawn after the layout, so a seed gives the same cloud as before. Either way
			// round: without the spin it would fall into a single lump.
			const direction = rng() < 0.5 ? 1 : -1;
			const omega = direction * 0.6 * Math.sqrt((sim.config.G * total) / R ** 3);
			for (const { d, theta, m } of specs) {
				const x = d * Math.cos(theta);
				const y = d * Math.sin(theta);
				sim.addBody({
					m,
					x,
					y,
					vx: -omega * y + uniform(rng, -10, 10),
					vy: omega * x + uniform(rng, -10, 10),
					color: randomPastel(rng),
				});
			}
		},
	},
	{
		id: "lagrange",
		name: "Lagrange points",
		description:
			"A star and a giant planet with Trojan swarms librating around the stable L4 and L5 points, while bodies at L1–L3 drift away.",
		extent: 360,
		settings: { mergeChance: 0, bounceChance: 0 },
		build(sim, { rng }) {
			buildLagrange(sim, rng);
		},
	},
	{
		id: "flyby",
		name: "Gravity assist",
		description:
			"Probes slingshot past a moving planet: passing behind it speeds them up, passing in front slows them down.",
		extent: 480,
		settings: { mergeChance: 0, bounceChance: 0 },
		build(sim) {
			buildFlyby(sim);
		},
	},
	{
		id: "breakup",
		name: "Moon breakup",
		description:
			"A rubble-pile moon that strayed inside its planet's Roche limit is pulled apart by tides into a stream that winds up into a ring.",
		extent: 240,
		settings: { mergeChance: 0, bounceChance: 0 },
		build(sim, { rng }) {
			buildBreakup(sim, rng);
		},
	},
	{
		id: "spiral",
		name: "Spiral galaxy (10,000 stars)",
		description:
			"Ten thousand stars in a self-gravitating disk around a central black hole grow swirling spiral arms.",
		extent: 380,
		// Substepping 10,000 bodies would make the galaxy crawl; leapfrog is stable as is.
		settings: {
			solver: "barnes-hut",
			integrator: "leapfrog",
			mergeChance: 0,
			bounceChance: 0,
			theta: 0.7,
			adaptive: false,
		},
		build(sim, { rng }) {
			buildSpiral(sim, rng);
		},
	},
	{
		id: "star",
		name: "Lone star",
		description:
			"A single Sun-like star and nothing else: click around it to build your own planetary system.",
		extent: 300,
		settings: { mergeChance: 1, bounceChance: 0 },
		build(sim) {
			// Same mass as the Solar system's Sun, so its planet distances work here too.
			sim.addBody({ m: 3.2e7, x: 0, y: 0, color: "#ffd27a" });
		},
	},
	{
		id: "empty",
		name: "Empty space",
		description: "Nothing at all. Add your own bodies.",
		extent: 400,
		settings: {},
		build() {},
	},
]);

/**
 * @param {string} id
 * @returns {Preset}
 */
export function getPreset(id) {
	return PRESETS.find((p) => p.id === id) ?? PRESETS[0];
}
