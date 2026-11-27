/**
 * Measures how fast a running total grows (frames drawn, simulated time, ...) over
 * roughly the last `windowMs` of wall-clock time: an exact average over the window,
 * so uneven frame times don't skew it the way averaging 1 / frameTime would.
 */
export class RateMeter {
	/** @type {{ t: number, v: number }[]} */
	#samples = [];
	#windowMs;

	/** @param {number} [windowMs] */
	constructor(windowMs = 1000) {
		this.#windowMs = windowMs;
	}

	/**
	 * Records the running total `value` at time `now` (milliseconds). A total that
	 * went down (e.g. the clock restarted) starts the measurement afresh.
	 *
	 * @param {number} now
	 * @param {number} value
	 */
	sample(now, value) {
		const samples = this.#samples;
		const last = samples.at(-1);
		if (last && value < last.v) samples.length = 0;
		samples.push({ t: now, v: value });
		// Keep one sample at least a window old, so the rate spans the whole window,
		// but forget samples from before a long gap (a hidden tab, a pause).
		while (samples.length > 2 && now - samples[1].t >= this.#windowMs) samples.shift();
		if (now - samples[0].t > this.#windowMs * 1.5) samples.splice(0, samples.length - 1);
	}

	/** Growth per second over the window, or NaN until there are two samples. */
	get rate() {
		const samples = this.#samples;
		if (samples.length < 2) return Number.NaN;
		const first = samples[0];
		const last = /** @type {{ t: number, v: number }} */ (samples.at(-1));
		const seconds = (last.t - first.t) / 1000;
		return seconds > 0 ? (last.v - first.v) / seconds : Number.NaN;
	}

	reset() {
		this.#samples.length = 0;
	}
}
