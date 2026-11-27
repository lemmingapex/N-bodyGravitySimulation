import { PARALLEL_MIN_BODIES } from "./barnesHut.js";
import { radiusForMass } from "./body.js";
import { mixColors } from "./color.js";

/** @typedef {import('./state.js').State} State */
/** @typedef {import('./body.js').Body} Body */

/** At most this many of the largest bodies are handled outside the grid. */
const MAX_LARGE_BODIES = 64;

/** Bodies per chunk of the neighbour search (the unit threads claim). */
export const PAIR_CHUNK_BODIES = 2048;

/** Own cell, then the four neighbours "ahead" of it: each adjacent cell pair once. */
const FORWARD_X = [1, -1, 0, 1];
const FORWARD_Y = [0, 1, 1, 1];

/**
 * The data the `pairs` job works on: the grid, and per-thread output.
 *
 * @typedef {object} PairJob
 * @property {Float64Array} x Copies of positions and radii.
 * @property {Float64Array} y
 * @property {Float64Array} r
 * @property {Int32Array} cellX Grid cell of each body.
 * @property {Int32Array} cellY
 * @property {Int32Array} bucket Hash bucket of each body (−1: a large body).
 * @property {Int32Array} items Grid bodies grouped by bucket: `items[start[b] … start[b + 1])`.
 * @property {Int32Array} start
 * @property {Int32Array} meta `[bodies, hash mask]`
 * @property {Int32Array[]} out Per thread: pairs found, chunk after chunk.
 * @property {Int32Array} outFill Per thread: how much of its `out` is used.
 * @property {Int32Array} chunkThread Per chunk: the thread whose `out` holds its pairs, or −1.
 * @property {Int32Array} chunkOffset Per chunk: where they start there.
 * @property {Int32Array} chunkCount Per chunk: how many numbers (two per pair).
 */

/**
 * Finds overlapping bodies with a hashed uniform grid. Cells are as wide as two
 * "typical" radii, so two typical bodies can only touch if their cells are the same
 * or adjacent; each body checks its own cell and the four neighbours ahead of it, so
 * every pair of cells is looked at once. The few largest bodies (stars and the like,
 * which would otherwise force huge cells) instead check every cell their circle
 * reaches. Roughly O(n), even for tens of thousands of bodies crowded into a disk.
 *
 * With a `parallel` helper the neighbour search is split across threads in chunks
 * of bodies; pairs are collected chunk by chunk in order, so the result is exactly
 * the same as on one thread.
 */
export class CollisionGrid {
	/** @type {import('./barnesHut.js').Parallel | null} */
	parallel = null;
	/** Changes whenever an array is replaced, so threads pick up the new ones. */
	version = 0;
	#shared;
	/** @type {PairJob} */
	#job;

	/** @param {{ shared?: boolean }} [options] Keep arrays in shared memory (for threads). */
	constructor({ shared = false } = {}) {
		this.#shared = shared;
		this.#job = {
			x: this.#float(0),
			y: this.#float(0),
			r: this.#float(0),
			cellX: this.#int(0),
			cellY: this.#int(0),
			bucket: this.#int(0),
			items: this.#int(0),
			start: this.#int(0),
			meta: this.#int(2),
			out: [],
			outFill: this.#int(0),
			chunkThread: this.#int(0),
			chunkOffset: this.#int(0),
			chunkCount: this.#int(0),
		};
	}

	/** @param {number} length */
	#float(length) {
		return this.#shared
			? new Float64Array(new SharedArrayBuffer(length * 8))
			: new Float64Array(length);
	}

	/** @param {number} length */
	#int(length) {
		return this.#shared
			? new Int32Array(new SharedArrayBuffer(length * 4))
			: new Int32Array(length);
	}

	/**
	 * Every pair of overlapping bodies (`distance < r_i + r_j`).
	 *
	 * @param {State} state
	 * @returns {number[]} Flat list of index pairs `[i0, j0, i1, j1, ...]` with `i < j`,
	 *   each overlapping pair exactly once.
	 */
	find(state) {
		const { n, r, x, y } = state;
		/** @type {number[]} */
		const pairs = [];
		if (n < 2) return pairs;

		// Bodies with radius ≤ `small` go in the grid; the rest (at most
		// MAX_LARGE_BODIES) are checked against it one by one.
		const small = smallRadius(r, n);
		const cell = 2 * small;
		let minX = Infinity;
		let minY = Infinity;
		for (let i = 0; i < n; i++) {
			if (x[i] < minX) minX = x[i];
			if (y[i] < minY) minY = y[i];
		}
		let tableSize = 16;
		while (tableSize < 2 * n) tableSize *= 2;
		const mask = tableSize - 1;
		const parallel = this.parallel?.helping && n >= PARALLEL_MIN_BODIES ? this.parallel : null;
		const threads = parallel ? parallel.threads : 1;
		const chunks = Math.ceil(n / PAIR_CHUNK_BODIES);
		this.#ensureCapacity(n, tableSize, threads, chunks);
		const job = this.#job;
		const { cellX, cellY, bucket, items, start } = job;
		job.x.set(x.subarray(0, n));
		job.y.set(y.subarray(0, n));
		job.r.set(r.subarray(0, n));
		job.meta[0] = n;
		job.meta[1] = mask;

		start.fill(0, 0, tableSize + 1);
		/** @type {number[]} */
		const large = [];
		for (let i = 0; i < n; i++) {
			if (r[i] > small) {
				large.push(i);
				bucket[i] = -1;
				continue;
			}
			const cx = Math.floor((x[i] - minX) / cell);
			const cy = Math.floor((y[i] - minY) / cell);
			cellX[i] = cx;
			cellY[i] = cy;
			const b = hashCell(cx, cy) & mask;
			bucket[i] = b;
			start[b + 1]++;
		}
		for (let b = 0; b < tableSize; b++) start[b + 1] += start[b];
		// Counting sort into buckets (start[b] is used as a cursor, then restored).
		for (let i = 0; i < n; i++) {
			const b = bucket[i];
			if (b >= 0) items[start[b]++] = i;
		}
		for (let b = tableSize; b > 0; b--) start[b] = start[b - 1];
		start[0] = 0;

		// Neighbour search among grid bodies, chunk by chunk (on all threads if worthwhile).
		job.outFill.fill(0);
		job.chunkThread.fill(-1, 0, chunks);
		if (parallel && chunks > 1) parallel.run("pairs", chunks, job, `${this.version}`);
		for (let c = 0; c < chunks; c++) {
			while (job.chunkThread[c] < 0) {
				searchChunk(job, c, 0);
				if (job.chunkThread[c] < 0) this.#growOut(0, job.out[0].length * 2);
			}
			const out = job.out[job.chunkThread[c]];
			for (let k = job.chunkOffset[c], stop = k + job.chunkCount[c]; k < stop; k++) {
				pairs.push(out[k]);
			}
		}
		// Give threads that nearly ran out of room more for next time.
		for (let t = 0; t < threads; t++) {
			if (job.outFill[t] > job.out[t].length * 0.75) this.#growOut(t, job.out[t].length * 2);
		}

		// The large bodies: every grid cell their circle (grown by `small`) reaches.
		const gx = job.x;
		const gy = job.y;
		const gr = job.r;
		for (let a = 0; a < large.length; a++) {
			const i = large[a];
			const xi = gx[i];
			const yi = gy[i];
			const ri = gr[i];
			const reach = ri + small;
			const cx0 = Math.floor((xi - reach - minX) / cell);
			const cx1 = Math.floor((xi + reach - minX) / cell);
			const cy0 = Math.floor((yi - reach - minY) / cell);
			const cy1 = Math.floor((yi + reach - minY) / cell);
			if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > n) {
				// Reaches more cells than there are bodies: just check them all.
				for (let j = 0; j < n; j++) {
					if (bucket[j] < 0) continue;
					const dx = gx[j] - xi;
					const dy = gy[j] - yi;
					const s = ri + gr[j];
					if (dx * dx + dy * dy < s * s) pairs.push(i < j ? i : j, i < j ? j : i);
				}
			} else {
				for (let cy = cy0; cy <= cy1; cy++) {
					for (let cx = cx0; cx <= cx1; cx++) {
						const b = hashCell(cx, cy) & mask;
						for (let k = start[b], stop = start[b + 1]; k < stop; k++) {
							const j = items[k];
							if (cellX[j] !== cx || cellY[j] !== cy) continue;
							const dx = gx[j] - xi;
							const dy = gy[j] - yi;
							const s = ri + gr[j];
							if (dx * dx + dy * dy < s * s) pairs.push(i < j ? i : j, i < j ? j : i);
						}
					}
				}
			}
			// Large bodies against each other.
			for (let c = a + 1; c < large.length; c++) {
				const j = large[c];
				const dx = gx[j] - xi;
				const dy = gy[j] - yi;
				const s = ri + gr[j];
				if (dx * dx + dy * dy < s * s) pairs.push(i < j ? i : j, i < j ? j : i);
			}
		}
		return pairs;
	}

	/**
	 * @param {number} n
	 * @param {number} tableSize
	 * @param {number} threads
	 * @param {number} chunks
	 */
	#ensureCapacity(n, tableSize, threads, chunks) {
		const job = this.#job;
		if (job.bucket.length < n) {
			const size = Math.max(n, job.bucket.length * 2);
			job.x = this.#float(size);
			job.y = this.#float(size);
			job.r = this.#float(size);
			job.cellX = this.#int(size);
			job.cellY = this.#int(size);
			job.bucket = this.#int(size);
			job.items = this.#int(size);
			this.version++;
		}
		if (job.start.length < tableSize + 1) {
			job.start = this.#int(tableSize + 1);
			this.version++;
		}
		if (job.chunkThread.length < chunks) {
			const size = Math.max(chunks, job.chunkThread.length * 2);
			job.chunkThread = this.#int(size);
			job.chunkOffset = this.#int(size);
			job.chunkCount = this.#int(size);
			this.version++;
		}
		if (job.outFill.length < threads) {
			job.outFill = this.#int(threads);
			this.version++;
		}
		// Room for about two pairs per body, shared among the threads.
		const room = Math.ceil((4 * n) / threads) + 1024;
		for (let t = 0; t < threads; t++) {
			if (!job.out[t] || job.out[t].length < room) this.#growOut(t, room);
		}
	}

	/**
	 * Gives thread `t` an output buffer of at least `length`, keeping what it holds.
	 *
	 * @param {number} t
	 * @param {number} length
	 */
	#growOut(t, length) {
		const job = this.#job;
		const old = job.out[t];
		const fresh = this.#int(Math.max(length, old ? old.length * 2 : 0));
		if (old) fresh.set(old);
		job.out[t] = fresh;
		this.version++;
	}
}

/**
 * Neighbour search for the grid bodies of chunk `c`, into thread `index`'s output.
 * Leaves the chunk undone (`chunkThread[c] = −1`) if that output is full.
 *
 * @param {PairJob} job
 * @param {number} c
 * @param {number} index
 */
function searchChunk(job, c, index) {
	const { x, y, r, cellX, cellY, bucket, items, start } = job;
	const n = job.meta[0];
	const mask = job.meta[1];
	const out = job.out[index];
	const capacity = out.length;
	const first = job.outFill[index];
	let fill = first;
	const from = c * PAIR_CHUNK_BODIES;
	const to = Math.min(n, from + PAIR_CHUNK_BODIES);
	for (let i = from; i < to; i++) {
		const own = bucket[i];
		if (own < 0) continue;
		const xi = x[i];
		const yi = y[i];
		const ri = r[i];
		const cx = cellX[i];
		const cy = cellY[i];
		// Own cell: each pair once, from its lower index.
		for (let k = start[own], stop = start[own + 1]; k < stop; k++) {
			const j = items[k];
			if (j <= i || cellX[j] !== cx || cellY[j] !== cy) continue;
			const dx = x[j] - xi;
			const dy = y[j] - yi;
			const s = ri + r[j];
			if (dx * dx + dy * dy < s * s) {
				if (fill + 2 > capacity) {
					job.chunkThread[c] = -1;
					return;
				}
				out[fill++] = i;
				out[fill++] = j;
			}
		}
		for (let f = 0; f < 4; f++) {
			const nx = cx + FORWARD_X[f];
			const ny = cy + FORWARD_Y[f];
			const b = hashCell(nx, ny) & mask;
			for (let k = start[b], stop = start[b + 1]; k < stop; k++) {
				const j = items[k];
				if (cellX[j] !== nx || cellY[j] !== ny) continue; // another cell, same bucket
				const dx = x[j] - xi;
				const dy = y[j] - yi;
				const s = ri + r[j];
				if (dx * dx + dy * dy < s * s) {
					if (fill + 2 > capacity) {
						job.chunkThread[c] = -1;
						return;
					}
					out[fill++] = i < j ? i : j;
					out[fill++] = i < j ? j : i;
				}
			}
		}
	}
	job.chunkOffset[c] = first;
	job.chunkCount[c] = fill - first;
	job.outFill[index] = fill;
	job.chunkThread[c] = index;
}

/**
 * The `pairs` job: neighbour search for one chunk of bodies (see {@link searchChunk}).
 *
 * @param {PairJob} job
 * @param {number} c
 * @param {import('../engine/jobs.js').ThreadContext} thread
 */
export function pairsChunk(job, c, thread) {
	searchChunk(job, c, thread.index);
}

/** Used by {@link findOverlappingPairs}: one thread, arrays reused between calls. */
const defaultGrid = new CollisionGrid();

/**
 * Finds every pair of overlapping bodies (`distance < r_i + r_j`); see
 * {@link CollisionGrid}.
 *
 * @param {State} state
 * @returns {number[]} Flat list of index pairs `[i0, j0, i1, j1, ...]` with `i < j`,
 *   each overlapping pair exactly once.
 */
export function findOverlappingPairs(state) {
	return defaultGrid.find(state);
}

/**
 * The radius below which all but at most {@link MAX_LARGE_BODIES} bodies fall, from a
 * logarithmic histogram (O(n), no sorting).
 *
 * @param {Float64Array} r
 * @param {number} n
 */
function smallRadius(r, n) {
	let rmin = Infinity;
	let rmax = 0;
	for (let i = 0; i < n; i++) {
		if (r[i] < rmin) rmin = r[i];
		if (r[i] > rmax) rmax = r[i];
	}
	if (n <= MAX_LARGE_BODIES || !(rmax > rmin)) return rmax;
	const BINS = 64;
	const counts = new Int32Array(BINS);
	const scale = BINS / Math.log(rmax / rmin);
	for (let i = 0; i < n; i++) {
		counts[Math.min(BINS - 1, Math.floor(Math.log(r[i] / rmin) * scale))]++;
	}
	// Walk down from the largest radii until including another bin would put too
	// many bodies outside the grid.
	let above = 0;
	for (let bin = BINS - 1; bin > 0; bin--) {
		if (above + counts[bin] > MAX_LARGE_BODIES) return rmin * Math.exp((bin + 1) / scale);
		above += counts[bin];
	}
	return rmin * Math.exp(1 / scale);
}

/**
 * @param {number} cx
 * @param {number} cy
 */
function hashCell(cx, cy) {
	return (Math.imul(cx, 0x9e3779b1) ^ Math.imul(cy, 0x85ebca77)) >>> 0;
}

/**
 * Elastic/inelastic impulse response plus a small positional correction so resting
 * bodies do not sink into each other. Momentum is conserved exactly; with
 * `restitution = 1` kinetic energy is conserved as well.
 *
 * @param {State} state Updated in place.
 * @param {ReadonlyArray<number>} pairs From {@link findOverlappingPairs}.
 * @param {number} restitution 0 (perfectly inelastic) .. 1 (perfectly elastic).
 */
export function resolveBounces(state, pairs, restitution) {
	const { m, r, x, y, vx, vy } = state;
	const CORRECTION = 0.4;
	const SLOP = 0.01;
	for (let k = 0; k < pairs.length; k += 2) {
		const i = pairs[k];
		const j = pairs[k + 1];
		const dx = x[j] - x[i];
		const dy = y[j] - y[i];
		const d = Math.sqrt(dx * dx + dy * dy);
		// Perfectly coincident bodies get an arbitrary (but deterministic) normal.
		const nx = d > 0 ? dx / d : 1;
		const ny = d > 0 ? dy / d : 0;
		const invMi = 1 / m[i];
		const invMj = 1 / m[j];
		const invSum = invMi + invMj;

		const approach = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny;
		if (approach < 0) {
			const impulse = (-(1 + restitution) * approach) / invSum;
			vx[i] -= impulse * invMi * nx;
			vy[i] -= impulse * invMi * ny;
			vx[j] += impulse * invMj * nx;
			vy[j] += impulse * invMj * ny;
		}

		const penetration = r[i] + r[j] - d;
		const correction = (Math.max(penetration - SLOP, 0) / invSum) * CORRECTION;
		x[i] -= correction * invMi * nx;
		y[i] -= correction * invMi * ny;
		x[j] += correction * invMj * nx;
		y[j] += correction * invMj * ny;
	}
}

/**
 * Merges every connected group of overlapping bodies into one body that conserves
 * total mass, linear momentum and center of mass. The color is the mass-weighted mix.
 *
 * Groups are found with union–find, so chains (A touches B touches C) merge in a
 * single step instead of one pair per frame.
 *
 * @param {ReadonlyArray<Body>} bodies
 * @param {ReadonlyArray<number>} pairs Index pairs into `bodies`.
 * @param {() => number} nextId Allocates ids for merged bodies.
 * @returns {{ bodies: Body[], merged: number }} New body list (survivors keep their
 *   order, merged bodies are appended) and how many bodies were absorbed.
 */
export function mergeOverlapping(bodies, pairs, nextId) {
	if (pairs.length === 0) return { bodies: bodies.slice(), merged: 0 };

	const parent = new Int32Array(bodies.length);
	for (let i = 0; i < parent.length; i++) parent[i] = i;
	const find = (/** @type {number} */ i) => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	for (let k = 0; k < pairs.length; k += 2) {
		const a = find(pairs[k]);
		const b = find(pairs[k + 1]);
		if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
	}

	/** @type {Map<number, Body[]>} */
	const groups = new Map();
	/** @type {Body[]} */
	const result = [];
	for (let i = 0; i < bodies.length; i++) {
		const root = find(i);
		const group = groups.get(root);
		if (group) group.push(bodies[i]);
		else groups.set(root, [bodies[i]]);
	}

	let merged = 0;
	/** @type {Body[]} */
	const created = [];
	for (let i = 0; i < bodies.length; i++) {
		const group = /** @type {Body[]} */ (groups.get(find(i)));
		if (group.length === 1) {
			result.push(bodies[i]);
		} else if (find(i) === i) {
			created.push(combine(group, nextId()));
			merged += group.length - 1;
		}
	}
	return { bodies: result.concat(created), merged };
}

/**
 * @param {Body[]} group
 * @param {number} id
 * @returns {Body}
 */
function combine(group, id) {
	let m = 0;
	let x = 0;
	let y = 0;
	let px = 0;
	let py = 0;
	for (const b of group) {
		m += b.m;
		x += b.m * b.x;
		y += b.m * b.y;
		px += b.m * b.vx;
		py += b.m * b.vy;
	}
	return {
		id,
		m,
		r: radiusForMass(m),
		x: x / m,
		y: y / m,
		vx: px / m,
		vy: py / m,
		color: mixColors(group.map((b) => ({ color: b.color, weight: b.m }))),
	};
}

/** Impact kinds, as stored in an impact record. */
export const IMPACT_MERGE = 0;
export const IMPACT_BOUNCE = 1;
/** Numbers per impact record: kind, x, y, combined mass, impact speed. */
export const IMPACT_STRIDE = 5;

/**
 * Collisions since they were last taken, for sound and visual effects: at most `max`
 * of them, an evenly spread random sample of all the collisions offered (reservoir
 * sampling). Keeping simply the first few would favor whichever collisions are found
 * first, such as the leftmost ones or those early in a batch of steps.
 */
export class ImpactLog {
	/** Flat records, {@link IMPACT_STRIDE} numbers each. @type {number[]} */
	records = [];
	#seen = 0;
	#max;
	#random;

	/**
	 * @param {number} max
	 * @param {() => number} random Uniform in [0, 1).
	 */
	constructor(max, random) {
		this.#max = max;
		this.#random = random;
	}

	/**
	 * @param {number} kind
	 * @param {number} x
	 * @param {number} y
	 * @param {number} mass
	 * @param {number} speed
	 */
	add(kind, x, y, mass, speed) {
		const seen = this.#seen++;
		let slot = seen;
		if (seen >= this.#max) {
			// Keep the newcomer with probability max / (seen + 1), in a random slot.
			slot = Math.floor(this.#random() * (seen + 1));
			if (slot >= this.#max) return;
		}
		const o = slot * IMPACT_STRIDE;
		const records = this.records;
		records[o] = kind;
		records[o + 1] = x;
		records[o + 2] = y;
		records[o + 3] = mass;
		records[o + 4] = speed;
	}

	/** The sampled records, emptying the log. */
	take() {
		const records = this.records;
		this.records = [];
		this.#seen = 0;
		return records;
	}
}

/**
 * Logs each colliding pair: its centre of mass, combined mass and approach speed
 * along the line between them. Pairs that are separating, or approaching slower than
 * `minSpeed`, are skipped.
 *
 * @param {State} state Positions and velocities at the moment of impact.
 * @param {number[]} pairs Flat index pairs from {@link findOverlappingPairs}.
 * @param {number} kind {@link IMPACT_MERGE} or {@link IMPACT_BOUNCE}.
 * @param {ImpactLog} log
 * @param {number} [minSpeed]
 */
export function recordImpacts(state, pairs, kind, log, minSpeed = 0) {
	const { m, x, y, vx, vy } = state;
	for (let k = 0; k < pairs.length; k += 2) {
		const i = pairs[k];
		const j = pairs[k + 1];
		const dx = x[j] - x[i];
		const dy = y[j] - y[i];
		const d = Math.hypot(dx, dy);
		const approach = d > 0 ? -((vx[j] - vx[i]) * dx + (vy[j] - vy[i]) * dy) / d : 0;
		if (approach <= minSpeed) continue;
		const mass = m[i] + m[j];
		log.add(
			kind,
			(m[i] * x[i] + m[j] * x[j]) / mass,
			(m[i] * y[i] + m[j] * y[j]) / mass,
			mass,
			approach,
		);
	}
}
