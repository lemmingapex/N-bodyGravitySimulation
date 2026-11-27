/**
 * Barnes–Hut quadtree: approximates the gravity of distant groups of bodies by their
 * total mass at their center of mass, reducing the cost from O(n²) to ~O(n log n).
 *
 * The opening parameter `theta` trades accuracy for speed: a cell of width `w` whose
 * center of mass is at distance `d` is approximated when `w / d < theta`. `theta = 0`
 * reproduces the exact direct sum.
 *
 * Built for speed with tens of thousands of bodies:
 *
 * - **Buckets.** Leaves hold up to {@link LEAF_SIZE} bodies instead of one, so the
 *   tree is several times smaller and shallower.
 * - **Group traversal.** The tree is walked once per leaf rather than once per body:
 *   the walk collects the cells and bodies that act on the whole leaf, then each of
 *   its bodies sums over those lists in tight loops. Distances are measured to the
 *   nearest point of the leaf's bodies, so a cell is only approximated when it is far
 *   enough from every one of them (never less accurate than a per-body walk).
 * - **Locality.** Bodies are reordered so that each cell's bodies are contiguous
 *   (copies of their positions, masses and radii are kept in that order), and nodes
 *   are stored depth-first with a "next" (skip-subtree) index, so the walk needs no
 *   stack and reads memory mostly in order.
 * - **Threads.** With a {@link Parallel} helper, building the tree and evaluating
 *   forces are split across threads that share the tree's memory. The top levels are
 *   split serially into subtrees of at most {@link TASK_BODIES} bodies, which threads
 *   build independently and which are then spliced into place; forces are evaluated
 *   in chunks of nodes. Either way the tree, and every body's sum, come out exactly
 *   as on one thread.
 *
 * Arrays are reused between builds, so steady-state simulation does not allocate.
 */

/** @typedef {import('./state.js').State} State */

/**
 * Everything {@link evaluateNodes} reads: the arrays of a built tree.
 *
 * @typedef {object} TreeArrays
 * @property {Float64Array} half
 * @property {Float64Array} mass
 * @property {Float64Array} comX
 * @property {Float64Array} comY
 * @property {Float64Array} rmax
 * @property {Int32Array} start
 * @property {Int32Array} end
 * @property {Int32Array} next
 * @property {Int32Array} order
 * @property {Float64Array} sx
 * @property {Float64Array} sy
 * @property {Float64Array} sm
 * @property {Float64Array} sr
 */

/**
 * Splits work across threads sharing memory (the engine's thread pool).
 *
 * @typedef {object} Parallel
 * @property {number} threads Threads that may do chunks, numbered from 0 (the caller).
 * @property {boolean} helping Whether any helper thread is available.
 * @property {(job: 'forces' | 'subtrees' | 'pairs', chunks: number, shared: any, version: string) => void} run
 *   Does chunks `0 … chunks - 1` of `job` on all threads.
 */

/**
 * Where one thread builds subtrees: node arrays like the tree's, numbered locally.
 *
 * @typedef {object} Arena
 * @property {number} capacity
 * @property {Float64Array} cx
 * @property {Float64Array} cy
 * @property {Float64Array} half
 * @property {Float64Array} mass
 * @property {Float64Array} comX
 * @property {Float64Array} comY
 * @property {Float64Array} rmax
 * @property {Int32Array} start
 * @property {Int32Array} end
 * @property {Int32Array} next
 */

/**
 * The data the `subtrees` job works on.
 *
 * @typedef {object} SubtreeJob
 * @property {Int32Array} order
 * @property {Float64Array} ux Positions, masses and radii by body index.
 * @property {Float64Array} uy
 * @property {Float64Array} um
 * @property {Float64Array} ur
 * @property {Float64Array} sx The same in `order`, filled in for each subtree.
 * @property {Float64Array} sy
 * @property {Float64Array} sm
 * @property {Float64Array} sr
 * @property {Float64Array} taskBox Per subtree: centre x, centre y, half width.
 * @property {Int32Array} taskRange Per subtree: first body, end, depth.
 * @property {Int32Array} taskThread Per subtree: the arena it was built in, or −1.
 * @property {Int32Array} taskOffset Per subtree: its first node in that arena.
 * @property {Int32Array} taskNodes Per subtree: how many nodes it has.
 * @property {Arena[]} arenas One per thread.
 * @property {Int32Array} arenaFill Per thread: nodes used in its arena so far.
 */

/**
 * The data the `forces` job works on.
 *
 * @typedef {object} ForceJob
 * @property {TreeArrays} tree
 * @property {Int32Array} meta `[nodes]`
 * @property {Float64Array} params `[G, theta²]`
 * @property {Float64Array} ax Output, by body index.
 * @property {Float64Array} ay
 */

/** @typedef {{ task: number } | TopNode} TopItem */
/**
 * A node above the subtrees, built serially.
 *
 * @typedef {{ cx: number, cy: number, half: number, start: number, end: number, children: TopItem[] }} TopNode
 */

/** Beyond this depth coincident bodies share a leaf instead of splitting forever. */
export const MAX_DEPTH = 48;

/** Most bodies in a leaf (unless they are too close together to split, at MAX_DEPTH). */
export const LEAF_SIZE = 8;

/** Most bodies in a subtree built by one thread; the levels above are split serially. */
export const TASK_BODIES = 1024;

/** Nodes per chunk of force evaluation. */
export const FORCE_CHUNK_NODES = 32;

/** Below this many bodies, waking threads costs more than it saves. */
export const PARALLEL_MIN_BODIES = 3000;

/** Most chunks in one parallel run. */
const MAX_CHUNKS = 0xffff;

export class QuadTree {
	/** Number of nodes in use. */
	count = 0;
	/** Number of bodies in the last {@link build}. */
	bodies = 0;
	/** Changes whenever an array is replaced (grown), so threads pick up the new ones. */
	version = 0;
	/** @type {Parallel | null} */
	parallel = null;
	#shared;
	#capacity = 0;
	#bodyCapacity = 0;
	/** @type {Float64Array} */ #cx;
	/** @type {Float64Array} */ #cy;
	/** @type {TreeArrays} */ #arrays;
	/** @type {SubtreeJob} */ #job;
	#tasks = 0;
	/** Force outputs shared with threads. @type {Float64Array} */
	#ax = new Float64Array(0);
	/** @type {Float64Array} */
	#ay = new Float64Array(0);
	#meta;
	#params;
	/** @type {{ version: string, forces: ForceJob } | null} */
	#forceJob = null;
	#scratch = createScratch();
	/** @type {import('../engine/jobs.js').ThreadContext} */
	#thread = { index: 0, scratch: {} };

	/**
	 * @param {number} [initialCapacity] Nodes to allocate up front.
	 * @param {{ shared?: boolean }} [options] Keep the arrays in shared memory (needs
	 *   `SharedArrayBuffer`, i.e. a cross-origin isolated page), for {@link parallel}.
	 */
	constructor(initialCapacity = 64, { shared = false } = {}) {
		this.#shared = shared;
		const float = (/** @type {number} */ n) => this.#float(n);
		const int = (/** @type {number} */ n) => this.#int(n);
		this.#cx = float(0);
		this.#cy = float(0);
		this.#arrays = {
			half: float(0),
			mass: float(0),
			comX: float(0),
			comY: float(0),
			rmax: float(0),
			start: int(0),
			end: int(0),
			next: int(0),
			order: int(0),
			sx: float(0),
			sy: float(0),
			sm: float(0),
			sr: float(0),
		};
		this.#job = {
			order: this.#arrays.order,
			ux: float(0),
			uy: float(0),
			um: float(0),
			ur: float(0),
			sx: this.#arrays.sx,
			sy: this.#arrays.sy,
			sm: this.#arrays.sm,
			sr: this.#arrays.sr,
			taskBox: float(0),
			taskRange: int(0),
			taskThread: int(0),
			taskOffset: int(0),
			taskNodes: int(0),
			arenas: [],
			arenaFill: int(0),
		};
		this.#meta = int(1);
		this.#params = float(2);
		this.#grow(Math.max(1, initialCapacity));
	}

	/** The arrays of the last {@link build} (shared memory if the tree is shared). */
	get arrays() {
		return this.#arrays;
	}

	/** @param {number} length */
	#float(length) {
		return this.#shared
			? new Float64Array(new SharedArrayBuffer(length * Float64Array.BYTES_PER_ELEMENT))
			: new Float64Array(length);
	}

	/** @param {number} length */
	#int(length) {
		return this.#shared
			? new Int32Array(new SharedArrayBuffer(length * Int32Array.BYTES_PER_ELEMENT))
			: new Int32Array(length);
	}

	/**
	 * @template {Float64Array | Int32Array} T
	 * @param {T} old
	 * @param {number} length
	 * @returns {T}
	 */
	#resize(old, length) {
		const fresh = /** @type {T} */ (
			old instanceof Float64Array ? this.#float(length) : this.#int(length)
		);
		fresh.set(/** @type {any} */ (old.length <= length ? old : old.subarray(0, length)));
		return fresh;
	}

	/** @param {number} capacity */
	#grow(capacity) {
		const a = this.#arrays;
		this.#cx = this.#resize(this.#cx, capacity);
		this.#cy = this.#resize(this.#cy, capacity);
		a.half = this.#resize(a.half, capacity);
		a.mass = this.#resize(a.mass, capacity);
		a.comX = this.#resize(a.comX, capacity);
		a.comY = this.#resize(a.comY, capacity);
		a.rmax = this.#resize(a.rmax, capacity);
		a.start = this.#resize(a.start, capacity);
		a.end = this.#resize(a.end, capacity);
		a.next = this.#resize(a.next, capacity);
		this.#capacity = capacity;
		this.version++;
	}

	/** @param {number} n */
	#ensureBodies(n) {
		if (this.#bodyCapacity >= n) return;
		const size = Math.max(n, this.#bodyCapacity * 2);
		const a = this.#arrays;
		const job = this.#job;
		a.order = job.order = this.#int(size);
		a.sx = job.sx = this.#float(size);
		a.sy = job.sy = this.#float(size);
		a.sm = job.sm = this.#float(size);
		a.sr = job.sr = this.#float(size);
		job.ux = this.#float(size);
		job.uy = this.#float(size);
		job.um = this.#float(size);
		job.ur = this.#float(size);
		this.#bodyCapacity = size;
		this.version++;
	}

	/**
	 * Arenas for `threads` threads, each at least `capacity` nodes; existing contents
	 * are kept.
	 *
	 * @param {number} threads
	 * @param {number} capacity
	 */
	#ensureArenas(threads, capacity) {
		const job = this.#job;
		if (job.arenaFill.length < threads) {
			job.arenaFill = this.#int(threads);
			this.version++;
		}
		for (let t = 0; t < threads; t++) {
			const old = job.arenas[t];
			if (old && old.capacity >= capacity) continue;
			const size = Math.max(capacity, (old?.capacity ?? 0) * 2);
			/** @type {(key: keyof Omit<Arena, 'capacity'>) => any} */
			const field = (key) =>
				old
					? this.#resize(old[key], size)
					: key === "start" || key === "end" || key === "next"
						? this.#int(size)
						: this.#float(size);
			job.arenas[t] = {
				capacity: size,
				cx: field("cx"),
				cy: field("cy"),
				half: field("half"),
				mass: field("mass"),
				comX: field("comX"),
				comY: field("comY"),
				rmax: field("rmax"),
				start: field("start"),
				end: field("end"),
				next: field("next"),
			};
			this.version++;
		}
	}

	/** Whether to split work for `n` bodies across threads. */
	#parallelFor(/** @type {number} */ n) {
		return this.parallel !== null && this.parallel.helping && n >= PARALLEL_MIN_BODIES;
	}

	/**
	 * Builds the tree for positions `x`, `y` and the masses and radii in `state`.
	 *
	 * @param {State} state
	 * @param {Float64Array} x
	 * @param {Float64Array} y
	 */
	build(state, x, y) {
		const { n, m, r } = state;
		this.count = 0;
		this.bodies = n;
		if (n === 0) return;
		this.#ensureBodies(n);
		const job = this.#job;
		const { order, ux, uy, um, ur } = job;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (let i = 0; i < n; i++) {
			order[i] = i;
			const xi = x[i];
			const yi = y[i];
			ux[i] = xi;
			uy[i] = yi;
			um[i] = m[i];
			ur[i] = r[i];
			if (xi < minX) minX = xi;
			if (xi > maxX) maxX = xi;
			if (yi < minY) minY = yi;
			if (yi > maxY) maxY = yi;
		}
		const half = Math.max(maxX - minX, maxY - minY) / 2 + 1e-6;

		// The top levels, serially, down to subtrees small enough for one thread.
		this.#tasks = 0;
		const root = this.#top(0, n, (minX + maxX) / 2, (minY + maxY) / 2, half, 0);

		// The subtrees, on all threads if worthwhile.
		const parallel = this.#parallelFor(n) ? /** @type {Parallel} */ (this.parallel) : null;
		const threads = parallel ? parallel.threads : 1;
		// About one node per three bodies: room for each thread's share, with headroom.
		this.#ensureArenas(threads, Math.ceil(n / threads) + 64);
		job.arenaFill.fill(0);
		job.taskThread.fill(-1, 0, this.#tasks);
		if (parallel && this.#tasks > 1 && this.#tasks <= MAX_CHUNKS) {
			parallel.run("subtrees", this.#tasks, job, `${this.version}`);
		}
		// Whatever is left (all of it on one thread; any a thread had no room for).
		for (let t = 0; t < this.#tasks; t++) {
			while (job.taskThread[t] < 0) {
				buildSubtree(job, t, 0, this.#thread);
				if (job.taskThread[t] < 0) {
					const arena = job.arenas[0];
					this.#ensureArenas(threads, arena.capacity * 2);
				}
			}
		}
		// Give threads that ran out of room more for next time.
		for (let t = 0; t < threads; t++) {
			if (job.arenaFill[t] > job.arenas[t].capacity * 0.9) {
				this.#ensureArenas(threads, job.arenas[t].capacity * 2);
			}
		}

		this.#assemble(root);
	}

	/**
	 * Splits bodies `order[start … end)` down to subtrees of at most
	 * {@link TASK_BODIES}, recording those as tasks.
	 *
	 * @param {number} start
	 * @param {number} end
	 * @param {number} cx
	 * @param {number} cy
	 * @param {number} half
	 * @param {number} depth
	 * @returns {TopItem}
	 */
	#top(start, end, cx, cy, half, depth) {
		if (end - start <= TASK_BODIES || end - start <= LEAF_SIZE || depth >= MAX_DEPTH) {
			return { task: this.#addTask(start, end, cx, cy, half, depth) };
		}
		const { order, ux, uy } = this.#job;
		const bounds = quadrants(order, ux, uy, start, end, cx, cy);
		const h = half / 2;
		/** @type {TopItem[]} */
		const children = [];
		for (let q = 0; q < 4; q++) {
			if (bounds[q] === bounds[q + 1]) continue;
			const qx = cx + (q & 1 ? h : -h);
			const qy = cy + (q & 2 ? h : -h);
			children.push(this.#top(bounds[q], bounds[q + 1], qx, qy, h, depth + 1));
		}
		return { cx, cy, half, start, end, children };
	}

	/**
	 * @param {number} start
	 * @param {number} end
	 * @param {number} cx
	 * @param {number} cy
	 * @param {number} half
	 * @param {number} depth
	 */
	#addTask(start, end, cx, cy, half, depth) {
		const job = this.#job;
		const t = this.#tasks++;
		if (job.taskThread.length < this.#tasks) {
			const size = Math.max(16, this.#tasks * 2);
			job.taskBox = this.#resize(job.taskBox, size * 3);
			job.taskRange = this.#resize(job.taskRange, size * 3);
			job.taskThread = this.#resize(job.taskThread, size);
			job.taskOffset = this.#resize(job.taskOffset, size);
			job.taskNodes = this.#resize(job.taskNodes, size);
			this.version++;
		}
		job.taskBox[t * 3] = cx;
		job.taskBox[t * 3 + 1] = cy;
		job.taskBox[t * 3 + 2] = half;
		job.taskRange[t * 3] = start;
		job.taskRange[t * 3 + 1] = end;
		job.taskRange[t * 3 + 2] = depth;
		return t;
	}

	/**
	 * Lays the tree out depth-first: top nodes, with each subtree copied from its arena
	 * into place. Same layout as building it all in one go.
	 *
	 * @param {TopItem} item
	 */
	#assemble(item) {
		if ("task" in item) {
			const job = this.#job;
			const t = item.task;
			const arena = job.arenas[job.taskThread[t]];
			const offset = job.taskOffset[t];
			const nodes = job.taskNodes[t];
			const base = this.count;
			if (base + nodes > this.#capacity)
				this.#grow(Math.max(base + nodes, this.#capacity * 2));
			const a = this.#arrays;
			const shift = base - offset;
			a.half.set(arena.half.subarray(offset, offset + nodes), base);
			a.mass.set(arena.mass.subarray(offset, offset + nodes), base);
			a.comX.set(arena.comX.subarray(offset, offset + nodes), base);
			a.comY.set(arena.comY.subarray(offset, offset + nodes), base);
			a.rmax.set(arena.rmax.subarray(offset, offset + nodes), base);
			a.start.set(arena.start.subarray(offset, offset + nodes), base);
			a.end.set(arena.end.subarray(offset, offset + nodes), base);
			this.#cx.set(arena.cx.subarray(offset, offset + nodes), base);
			this.#cy.set(arena.cy.subarray(offset, offset + nodes), base);
			for (let k = 0; k < nodes; k++) a.next[base + k] = arena.next[offset + k] + shift;
			this.count += nodes;
			return;
		}
		if (this.count === this.#capacity) this.#grow(this.#capacity * 2);
		const id = this.count++;
		this.#cx[id] = item.cx;
		this.#cy[id] = item.cy;
		let a = this.#arrays;
		a.half[id] = item.half;
		a.start[id] = item.start;
		a.end[id] = item.end;
		for (const child of item.children) this.#assemble(child);
		a = this.#arrays; // (re)read: children may have grown the arrays
		a.next[id] = this.count;
		summarizeNode(a.next, a.mass, a.comX, a.comY, a.rmax, id, item.cx, item.cy);
	}

	/**
	 * The cells of the last {@link build} as `(centreX, centreY, halfWidth)` triples,
	 * parents before their children, at most `max` of them: for drawing.
	 *
	 * @param {number} max
	 */
	cells(max) {
		const count = Math.min(this.count, max);
		const out = new Float32Array(count * 3);
		const half = this.#arrays.half;
		for (let i = 0; i < count; i++) {
			out[i * 3] = this.#cx[i];
			out[i * 3 + 1] = this.#cy[i];
			out[i * 3 + 2] = half[i];
		}
		return out;
	}

	/**
	 * Accelerations of every body using the tree built from the same `x`, `y` (the
	 * tree keeps its own copies of positions, masses and radii).
	 *
	 * @param {State} _state
	 * @param {Float64Array} _x Positions the tree was built from (kept for the API).
	 * @param {Float64Array} _y
	 * @param {Float64Array} ax Output.
	 * @param {Float64Array} ay Output.
	 * @param {number} G
	 * @param {number} theta Opening angle (0 = exact).
	 */
	accelerations(_state, _x, _y, ax, ay, G, theta) {
		const n = this.bodies;
		const chunks = Math.ceil(this.count / FORCE_CHUNK_NODES);
		if (!this.#parallelFor(n) || chunks > MAX_CHUNKS) {
			evaluateNodes(this.#arrays, 0, this.count, theta * theta, G, ax, ay, this.#scratch);
			return;
		}
		if (this.#ax.length < n) {
			this.#ax = this.#float(this.#bodyCapacity);
			this.#ay = this.#float(this.#bodyCapacity);
			this.version++;
		}
		const version = `${this.version}`;
		if (this.#forceJob?.version !== version) {
			this.#forceJob = {
				version,
				forces: {
					tree: { ...this.#arrays },
					meta: this.#meta,
					params: this.#params,
					ax: this.#ax,
					ay: this.#ay,
				},
			};
		}
		this.#meta[0] = this.count;
		this.#params[0] = G;
		this.#params[1] = theta * theta;
		/** @type {Parallel} */ (this.parallel).run(
			"forces",
			chunks,
			this.#forceJob.forces,
			version,
		);
		ax.set(this.#ax.subarray(0, n));
		ay.set(this.#ay.subarray(0, n));
	}
}

/**
 * Reorders `order[start … end)` into the four quadrants around (cx, cy) (bit 0: east,
 * bit 1: south), each contiguous.
 *
 * @param {Int32Array} order
 * @param {Float64Array} x
 * @param {Float64Array} y
 * @param {number} start
 * @param {number} end
 * @param {number} cx
 * @param {number} cy
 * @returns {number[]} Boundaries: quadrant q is `[bounds[q], bounds[q + 1])`.
 */
function quadrants(order, x, y, start, end, cx, cy) {
	const south = partition(order, start, end, y, cy);
	const northEast = partition(order, start, south, x, cx);
	const southEast = partition(order, south, end, x, cx);
	return [start, northEast, south, southEast, end];
}

/**
 * Reorders `order[start … end)` so bodies with `coord < pivot` come first.
 *
 * @param {Int32Array} order
 * @param {number} start
 * @param {number} end
 * @param {Float64Array} coord
 * @param {number} pivot
 * @returns {number} Index of the first body with `coord ≥ pivot`.
 */
function partition(order, start, end, coord, pivot) {
	let i = start;
	let j = end - 1;
	for (;;) {
		while (i <= j && coord[order[i]] < pivot) i++;
		while (i <= j && coord[order[j]] >= pivot) j--;
		if (i >= j) return i;
		const t = order[i];
		order[i] = order[j];
		order[j] = t;
		i++;
		j--;
	}
}

/**
 * Mass, center of mass and largest radius of internal node `id` from its children.
 *
 * @param {Int32Array} next
 * @param {Float64Array} mass
 * @param {Float64Array} comX
 * @param {Float64Array} comY
 * @param {Float64Array} rmax
 * @param {number} id
 * @param {number} cx Cell centre, the center of mass of a massless cell.
 * @param {number} cy
 */
function summarizeNode(next, mass, comX, comY, rmax, id, cx, cy) {
	let mt = 0;
	let mx = 0;
	let my = 0;
	let rm = 0;
	for (let c = id + 1; c < next[id]; c = next[c]) {
		const mc = mass[c];
		mt += mc;
		mx += mc * comX[c];
		my += mc * comY[c];
		if (rmax[c] > rm) rm = rmax[c];
	}
	mass[id] = mt;
	comX[id] = mt > 0 ? mx / mt : cx;
	comY[id] = mt > 0 ? my / mt : cy;
	rmax[id] = rm;
}

/**
 * Builds subtree `t` in thread `index`'s arena: its nodes, its bodies' sorted copies
 * and every node's mass, center of mass and largest radius. Leaves the task unbuilt
 * (`taskThread[t] = −1`, body order restored) if the arena runs out of room.
 *
 * @param {SubtreeJob} job
 * @param {number} t
 * @param {number} index
 * @param {import('../engine/jobs.js').ThreadContext} thread
 */
function buildSubtree(job, t, index, thread) {
	const arena = job.arenas[index];
	const { order, ux, uy, um, ur, sx, sy, sm, sr } = job;
	const start = job.taskRange[t * 3];
	const end = job.taskRange[t * 3 + 1];
	const depth = job.taskRange[t * 3 + 2];
	// Partitioning reorders bodies in place: keep a copy to undo a failed attempt, so
	// a retry produces exactly the same order.
	/** @type {Int32Array} */
	let saved = thread.scratch.order ?? new Int32Array(0);
	if (saved.length < end - start) saved = thread.scratch.order = new Int32Array(end - start);
	saved.set(order.subarray(start, end));

	const base = job.arenaFill[index];
	const after = buildNodes(
		arena,
		base,
		order,
		ux,
		uy,
		start,
		end,
		job.taskBox[t * 3],
		job.taskBox[t * 3 + 1],
		job.taskBox[t * 3 + 2],
		depth,
	);
	if (after < 0) {
		order.set(saved.subarray(0, end - start), start);
		job.taskThread[t] = -1;
		return;
	}
	for (let k = start; k < end; k++) {
		const i = order[k];
		sx[k] = ux[i];
		sy[k] = uy[i];
		sm[k] = um[i];
		sr[k] = ur[i];
	}
	// Children come after their parent, so a reverse sweep sees them first.
	const { next, mass, comX, comY, rmax } = arena;
	for (let id = after - 1; id >= base; id--) {
		if (next[id] !== id + 1) {
			summarizeNode(next, mass, comX, comY, rmax, id, arena.cx[id], arena.cy[id]);
			continue;
		}
		let mt = 0;
		let mx = 0;
		let my = 0;
		let rm = 0;
		for (let k = arena.start[id], stop = arena.end[id]; k < stop; k++) {
			const mk = sm[k];
			mt += mk;
			mx += mk * sx[k];
			my += mk * sy[k];
			if (sr[k] > rm) rm = sr[k];
		}
		mass[id] = mt;
		comX[id] = mt > 0 ? mx / mt : arena.cx[id];
		comY[id] = mt > 0 ? my / mt : arena.cy[id];
		rmax[id] = rm;
	}
	job.taskOffset[t] = base;
	job.taskNodes[t] = after - base;
	job.arenaFill[index] = after;
	job.taskThread[t] = index;
}

/**
 * Creates node `id` for bodies `order[start … end)` and its children, depth-first.
 *
 * @param {Arena} arena
 * @param {number} id
 * @param {Int32Array} order
 * @param {Float64Array} x
 * @param {Float64Array} y
 * @param {number} start
 * @param {number} end
 * @param {number} cx
 * @param {number} cy
 * @param {number} half
 * @param {number} depth
 * @returns {number} The next free node, or −1 if the arena is full.
 */
function buildNodes(arena, id, order, x, y, start, end, cx, cy, half, depth) {
	if (id >= arena.capacity) return -1;
	arena.cx[id] = cx;
	arena.cy[id] = cy;
	arena.half[id] = half;
	arena.start[id] = start;
	arena.end[id] = end;
	let next = id + 1;
	if (end - start > LEAF_SIZE && depth < MAX_DEPTH) {
		const bounds = quadrants(order, x, y, start, end, cx, cy);
		const h = half / 2;
		for (let q = 0; q < 4 && next >= 0; q++) {
			if (bounds[q] === bounds[q + 1]) continue;
			const qx = cx + (q & 1 ? h : -h);
			const qy = cy + (q & 2 ? h : -h);
			next = buildNodes(
				arena,
				next,
				order,
				x,
				y,
				bounds[q],
				bounds[q + 1],
				qx,
				qy,
				h,
				depth + 1,
			);
		}
		if (next < 0) return -1;
	}
	arena.next[id] = next;
	return next;
}

/**
 * The `subtrees` job: builds one subtree (see {@link buildSubtree}).
 *
 * @param {SubtreeJob} job
 * @param {number} t
 * @param {import('../engine/jobs.js').ThreadContext} thread
 */
export function subtreesChunk(job, t, thread) {
	buildSubtree(job, t, thread.index, thread);
}

/**
 * The `forces` job: accelerations of the bodies in one chunk of nodes.
 *
 * @param {ForceJob} job
 * @param {number} chunk
 * @param {import('../engine/jobs.js').ThreadContext} thread
 */
export function forcesChunk(job, chunk, thread) {
	const scratch = (thread.scratch.forces ??= createScratch());
	const from = chunk * FORCE_CHUNK_NODES;
	const to = Math.min(job.meta[0], from + FORCE_CHUNK_NODES);
	evaluateNodes(job.tree, from, to, job.params[1], job.params[0], job.ax, job.ay, scratch);
}

/**
 * Per-thread working space for {@link evaluateNodes}: the interaction lists of the
 * leaf being evaluated (cells, and [start, end) body ranges). Grown as needed.
 */
export function createScratch() {
	return { cells: new Int32Array(256), ranges: new Int32Array(512) };
}

/**
 * Accelerations of the bodies in the leaves among nodes `from … to - 1` of a built
 * tree, written to `ax[i]`, `ay[i]` by original body index. Any split of the nodes
 * into ranges gives exactly the same results.
 *
 * @param {TreeArrays} tree
 * @param {number} from
 * @param {number} to
 * @param {number} theta2 Opening angle squared.
 * @param {number} G
 * @param {Float64Array} ax
 * @param {Float64Array} ay
 * @param {ReturnType<typeof createScratch>} scratch
 */
export function evaluateNodes(tree, from, to, theta2, G, ax, ay, scratch) {
	const { half, mass, comX, comY, rmax, start, end, next, order, sx, sy, sm, sr } = tree;
	const count = next[0]; // the root's subtree is the whole tree
	for (let leaf = from; leaf < to; leaf++) {
		if (next[leaf] !== leaf + 1) continue; // groups are the leaves
		const gs = start[leaf];
		const ge = end[leaf];

		// Bounding box of the group's bodies.
		let gx0 = Infinity;
		let gy0 = Infinity;
		let gx1 = -Infinity;
		let gy1 = -Infinity;
		for (let k = gs; k < ge; k++) {
			if (sx[k] < gx0) gx0 = sx[k];
			if (sx[k] > gx1) gx1 = sx[k];
			if (sy[k] < gy0) gy0 = sy[k];
			if (sy[k] > gy1) gy1 = sy[k];
		}

		// One walk for the whole group: which cells to approximate, which bodies to
		// sum directly.
		let cells = scratch.cells;
		let ranges = scratch.ranges;
		let nc = 0;
		let nr = 0;
		let node = 0;
		while (node < count) {
			const after = next[node];
			const isLeaf = after === node + 1;
			if (node <= leaf && leaf < after) {
				// The group's own cell or one containing it: never approximated.
				if (isLeaf) {
					if (nr + 2 > ranges.length) ranges = scratch.ranges = growInt(ranges);
					ranges[nr++] = gs;
					ranges[nr++] = ge;
				}
				node = isLeaf ? after : node + 1;
				continue;
			}
			const cx = comX[node];
			const cy = comY[node];
			const dx = cx < gx0 ? gx0 - cx : cx > gx1 ? cx - gx1 : 0;
			const dy = cy < gy0 ? gy0 - cy : cy > gy1 ? cy - gy1 : 0;
			const w = 2 * half[node];
			if (w * w < theta2 * (dx * dx + dy * dy)) {
				if (nc === cells.length) cells = scratch.cells = growInt(cells);
				cells[nc++] = node;
				node = after;
			} else if (isLeaf) {
				if (nr + 2 > ranges.length) ranges = scratch.ranges = growInt(ranges);
				ranges[nr++] = start[node];
				ranges[nr++] = end[node];
				node = after;
			} else {
				node++;
			}
		}

		for (let k = gs; k < ge; k++) {
			const xi = sx[k];
			const yi = sy[k];
			const ri = sr[k];
			let axi = 0;
			let ayi = 0;
			// Far cells as point masses, softened with their largest radius so a small,
			// nearby cell of overlapping bodies is never pulled harder than its bodies.
			for (let c = 0; c < nc; c++) {
				const id = cells[c];
				const dx = comX[id] - xi;
				const dy = comY[id] - yi;
				const d2 = dx * dx + dy * dy;
				const s = ri + rmax[id];
				const inv3 = d2 > s * s ? 1 / (d2 * Math.sqrt(d2)) : 1 / (s * s * s);
				axi += mass[id] * dx * inv3;
				ayi += mass[id] * dy * inv3;
			}
			for (let q = 0; q < nr; q += 2) {
				for (let j = ranges[q], stop = ranges[q + 1]; j < stop; j++) {
					if (j === k) continue;
					const dx = sx[j] - xi;
					const dy = sy[j] - yi;
					const d2 = dx * dx + dy * dy;
					const s = ri + sr[j];
					const inv3 = d2 > s * s ? 1 / (d2 * Math.sqrt(d2)) : 1 / (s * s * s);
					axi += sm[j] * dx * inv3;
					ayi += sm[j] * dy * inv3;
				}
			}
			const i = order[k];
			ax[i] = G * axi;
			ay[i] = G * ayi;
		}
	}
}

/** @param {Int32Array} list */
function growInt(list) {
	const bigger = new Int32Array(list.length * 2);
	bigger.set(list);
	return bigger;
}
