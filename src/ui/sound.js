/**
 * Procedural sound: ambient music and effects synthesized with the Web Audio API, so
 * there are no audio files to load. Browsers only allow audio after a user gesture,
 * so nothing is created until {@link Sound.unlock} is called from one.
 */

/** Notes of the music (D major pentatonic, semitones above D): open and unresolved. */
const SCALE = [0, 2, 4, 7, 9];
const ROOT_HZ = 73.42; // D2
/** Average seconds between individual collision sounds when collisions are constant. */
const IMPACT_GAP = 1 / 12;
/** Collision sounds that would start later than this (seconds) are dropped. */
const IMPACT_BACKLOG = 0.15;
/** Loudest impacts considered per frame; a galaxy merger can report dozens at once. */
const MAX_IMPACTS_PER_FRAME = 3;
/** How quickly the collision texture follows the collision rate (seconds). */
const ACTIVITY_TIME = 0.4;
/** Collisions per second where the texture starts, and where it is loudest. */
const TEXTURE_RATE = { quiet: 5, loud: 400 };

/**
 * @typedef {object} SoundSettings
 * @property {boolean} enabled
 * @property {number} music Music volume, 0–1.
 * @property {number} effects Effects volume, 0–1.
 */

/**
 * How big and how hard an impact is, each 0–1, from the combined mass and the
 * approach speed (both on log scales: masses here span planets to giant stars).
 *
 * @param {number} mass
 * @param {number} speed
 */
export function impactLoudness(mass, speed) {
	const clamp = (/** @type {number} */ v) => Math.min(1, Math.max(0, v));
	return {
		size: clamp((Math.log10(Math.max(mass, 1)) - 3) / 4.5),
		intensity: clamp(Math.log10(Math.max(speed, 1)) / 2.7),
	};
}

/**
 * Indices of the `max` most energetic impacts (mass × speed²) in flat impact records.
 *
 * @param {ArrayLike<number>} records
 * @param {number} stride Numbers per record; mass and speed are at offsets 3 and 4.
 * @param {number} max
 * @returns {number[]} Record indices, most energetic first.
 */
export function loudestImpacts(records, stride, max) {
	const count = Math.floor(records.length / stride);
	const energy = (/** @type {number} */ i) =>
		records[i * stride + 3] * records[i * stride + 4] ** 2;
	return Array.from({ length: count }, (_, i) => i)
		.sort((a, b) => energy(b) - energy(a))
		.slice(0, max);
}

/**
 * Spaces sounds out in time: each starts on average `gap` seconds after the one
 * before (randomly 0.5–1.5 × `gap`), so a constant stream of collisions sounds like
 * an even, irregular patter rather than bursts. A sound that would start more than
 * `backlog` seconds late is dropped.
 *
 * @param {number} gap
 * @param {number} backlog
 * @param {() => number} [random] Uniform in [0, 1).
 * @returns {(now: number) => number | null} When a sound asked for at `now` should
 *   start, or null to skip it.
 */
export function spacer(gap, backlog, random = Math.random) {
	let next = -Infinity;
	return (now) => {
		const start = Math.max(now, next);
		if (start - now > backlog) return null;
		next = start + gap * (0.5 + random());
		return start;
	};
}

/**
 * A smoothed events-per-second estimate (exponential moving average with time
 * constant `tau` seconds) that works however unevenly events are reported.
 *
 * @param {number} tau
 * @returns {(now: number, count: number) => number} Adds `count` events at `now`
 *   (seconds) and returns the current rate.
 */
export function activityMeter(tau) {
	let rate = 0;
	let last = -Infinity;
	return (now, count) => {
		rate = rate * Math.exp(-Math.max(0, now - last) / tau) + count / tau;
		last = now;
		return rate;
	};
}

/**
 * Loudness (0–1) of the collision texture at `rate` collisions per second: silent
 * while individual sounds can keep up, rising on a log scale above that.
 *
 * @param {number} rate
 */
export function textureLevel(rate) {
	const { quiet, loud } = TEXTURE_RATE;
	if (!(rate > quiet)) return 0;
	return Math.min(1, Math.log(rate / quiet) / Math.log(loud / quiet));
}

/** @param {number} semitones Above {@link ROOT_HZ}. */
const pitch = (semitones) => ROOT_HZ * 2 ** (semitones / 12);

/** @param {number} octave Octaves above the root. */
function randomNote(octave) {
	return pitch(12 * octave + SCALE[Math.floor(Math.random() * SCALE.length)]);
}

/** @param {number} min @param {number} max */
const between = (min, max) => min + Math.random() * (max - min);

export class Sound {
	/** @type {AudioContext | null} */
	#ctx = null;
	/** @type {GainNode | null} */
	#musicBus = null;
	/** @type {GainNode | null} */
	#effectsBus = null;
	/** @type {AudioBuffer | null} */
	#noise = null;
	/** @type {SoundSettings} */
	#settings;
	/** @type {ReturnType<typeof setInterval> | undefined} */
	#scheduler;
	/** @type {AudioScheduledSourceNode[]} */
	#drone = [];
	#nextPad = 0;
	#nextBell = 0;
	#hidden = false;
	#nextImpact = spacer(IMPACT_GAP, IMPACT_BACKLOG);
	#bounceActivity = activityMeter(ACTIVITY_TIME);
	#mergeActivity = activityMeter(ACTIVITY_TIME);
	/** Volumes of the continuous collision textures. @type {{ bounce: GainNode, merge: GainNode } | null} */
	#textures = null;

	/** @param {SoundSettings} settings */
	constructor(settings) {
		this.#settings = { ...settings };
	}

	/** Whether audio is running (enabled, unlocked by a gesture, page visible). */
	get playing() {
		return this.#ctx?.state === "running";
	}

	/**
	 * Call from a user gesture (click, tap, key press): creates or resumes the audio
	 * context if sound is enabled.
	 */
	unlock() {
		if (!this.#settings.enabled || this.#hidden) return;
		if (!this.#ctx) this.#create();
		void this.#ctx?.resume();
		this.#updateMusic();
	}

	/** @param {SoundSettings} settings */
	configure(settings) {
		this.#settings = { ...settings };
		const ctx = this.#ctx;
		if (!ctx) return;
		const now = ctx.currentTime;
		this.#musicBus?.gain.setTargetAtTime(settings.music * 0.6, now, 0.3);
		this.#effectsBus?.gain.setTargetAtTime(settings.effects, now, 0.05);
		if (settings.enabled && !this.#hidden) void ctx.resume();
		else void ctx.suspend();
		this.#updateMusic();
	}

	/** Pauses everything while the page is in the background. @param {boolean} hidden */
	setHidden(hidden) {
		this.#hidden = hidden;
		if (!this.#ctx) return;
		if (hidden) void this.#ctx.suspend();
		else if (this.#settings.enabled) void this.#ctx.resume();
		this.#updateMusic();
	}

	// ------------------------------------------------------------------ effects

	/**
	 * A launched planet: a soft whoosh, brighter for faster launches.
	 *
	 * @param {number} strength 0–1.
	 * @param {number} pan −1 (left) to 1 (right).
	 */
	launch(strength, pan) {
		const out = this.#effectOut(pan, 0.25);
		if (!out) return;
		const { ctx, node, t } = out;
		const noise = this.#noiseSource();
		const band = ctx.createBiquadFilter();
		band.type = "bandpass";
		band.Q.value = 1.5;
		band.frequency.setValueAtTime(300, t);
		band.frequency.exponentialRampToValueAtTime(900 + 1800 * strength, t + 0.35);
		noise.connect(band).connect(envelope(ctx, node, t, 0.04, 0.45, 0.12 + 0.18 * strength));
		noise.start(t);
		noise.stop(t + 0.5);
		tone(ctx, node, "sine", 330 + 220 * strength, 1.5, t, 0.01, 0.25, 0.04);
	}

	/**
	 * A scenario arriving: a deep swell with a shimmer on top.
	 *
	 * @param {number} pan
	 */
	arrive(pan = 0) {
		const out = this.#effectOut(pan, 0.5);
		if (!out) return;
		const { ctx, node, t } = out;
		tone(ctx, node, "sine", 55, 0.75, t, 0.5, 3, 0.35);
		tone(ctx, node, "triangle", 110, 0.75, t, 0.6, 2.5, 0.06);
		for (let i = 0; i < 3; i++) {
			tone(ctx, node, "sine", randomNote(4), 1, t + 0.25 + i * 0.18, 0.02, 2.5, 0.035);
		}
	}

	/**
	 * Collisions reported by the simulation since the last call; call every animation
	 * frame, even with none, so the collision texture fades when they stop. The
	 * loudest few play as individual sounds, spaced out in time (about
	 * 1 / {@link IMPACT_GAP} per second at most); the overall rate drives a
	 * continuous crackle (bounces) and rumble (merges) underneath.
	 *
	 * @param {ArrayLike<number>} records Flat impact records (kind, x, y, mass, speed).
	 * @param {number} stride
	 * @param {number} bounceKind Value of `kind` for bounces (others are merges).
	 * @param {(x: number, y: number) => { pan: number, visible: boolean }} locate
	 */
	impacts(records, stride, bounceKind, locate) {
		const ctx = this.#ctx;
		if (!ctx || !this.playing || this.#settings.effects <= 0) return;
		const now = ctx.currentTime;

		// Off-screen collisions count for less, as they sound quieter.
		let bounces = 0;
		let merges = 0;
		for (let o = 0; o + stride <= records.length; o += stride) {
			const weight = locate(records[o + 1], records[o + 2]).visible ? 1 : 0.35;
			if (records[o] === bounceKind) bounces += weight;
			else merges += weight;
		}
		this.#setTexture("bounce", this.#bounceActivity(now, bounces), now);
		this.#setTexture("merge", this.#mergeActivity(now, merges), now);

		for (const i of loudestImpacts(records, stride, MAX_IMPACTS_PER_FRAME)) {
			const start = this.#nextImpact(now + 0.01);
			if (start === null) break;
			const o = i * stride;
			const { pan, visible } = locate(records[o + 1], records[o + 2]);
			const { size, intensity } = impactLoudness(records[o + 3], records[o + 4]);
			const loudness = visible ? 1 : 0.35;
			if (records[o] === bounceKind) this.#bounce(size, intensity * loudness, pan, start);
			else this.#merge(size, intensity * loudness, pan, start);
		}
	}

	/**
	 * @param {"bounce" | "merge"} kind
	 * @param {number} rate Collisions per second.
	 * @param {number} now
	 */
	#setTexture(kind, rate, now) {
		const gain = this.#textures?.[kind].gain;
		gain?.setTargetAtTime(textureLevel(rate) * (kind === "bounce" ? 0.22 : 0.5), now, 0.15);
	}

	/**
	 * @param {number} size
	 * @param {number} intensity
	 * @param {number} pan
	 * @param {number} start
	 */
	#merge(size, intensity, pan, start) {
		const out = this.#effectOut(pan, 0.2 + 0.4 * size, start);
		if (!out) return;
		const { ctx, node, t } = out;
		const length = 0.3 + 0.9 * size;
		// A thump: a falling sine, lower for heavier bodies...
		const osc = ctx.createOscillator();
		osc.type = "sine";
		osc.frequency.setValueAtTime(170 - 110 * size, t);
		osc.frequency.exponentialRampToValueAtTime(32 + 20 * (1 - size), t + length);
		osc.connect(envelope(ctx, node, t, 0.005, length, 0.12 + 0.4 * intensity));
		osc.start(t);
		osc.stop(t + length + 0.05);
		// ...and a crunch of filtered noise, brighter for faster impacts.
		const noise = this.#noiseSource();
		const low = ctx.createBiquadFilter();
		low.type = "lowpass";
		low.frequency.setValueAtTime(300 + 2500 * intensity, t);
		low.frequency.exponentialRampToValueAtTime(120, t + length * 0.6);
		noise
			.connect(low)
			.connect(envelope(ctx, node, t, 0.002, length * 0.6, 0.1 + 0.25 * intensity));
		noise.start(t);
		noise.stop(t + length);
	}

	/**
	 * @param {number} size
	 * @param {number} intensity
	 * @param {number} pan
	 * @param {number} start
	 */
	#bounce(size, intensity, pan, start) {
		const out = this.#effectOut(pan, 0.15, start);
		if (!out) return;
		const { ctx, node, t } = out;
		const freq = 950 - 650 * size;
		tone(
			ctx,
			node,
			"triangle",
			freq,
			0.85,
			t,
			0.002,
			0.12 + 0.25 * size,
			0.05 + 0.2 * intensity,
		);
	}

	/**
	 * A per-effect output (stereo position, reverb send) if effects may play.
	 *
	 * @param {number} pan
	 * @param {number} reverb Share sent to the reverb.
	 * @param {number} [start] When the effect starts (audio clock); default now.
	 */
	#effectOut(pan, reverb, start) {
		const ctx = this.#ctx;
		if (!ctx || !this.playing || !this.#effectsBus || this.#settings.effects <= 0) return null;
		const t = start ?? ctx.currentTime + 0.01;
		const panner = ctx.createStereoPanner();
		panner.pan.value = Math.max(-0.9, Math.min(0.9, pan));
		panner.connect(this.#effectsBus);
		const send = ctx.createGain();
		send.gain.value = reverb;
		panner.connect(send).connect(/** @type {ConvolverNode} */ (this.#reverb));
		// Disconnect once the longest effect has finished, so nodes can be collected.
		setTimeout(() => {
			panner.disconnect();
			send.disconnect();
		}, 5000);
		return { ctx, node: /** @type {AudioNode} */ (panner), t };
	}

	#noiseSource() {
		const ctx = /** @type {AudioContext} */ (this.#ctx);
		const source = ctx.createBufferSource();
		source.buffer = this.#noise;
		source.loop = true;
		return source;
	}

	// -------------------------------------------------------------------- music

	/** @type {ConvolverNode | null} */
	#reverb = null;

	#create() {
		const ctx = new AudioContext({ latencyHint: "interactive" });
		const compressor = ctx.createDynamicsCompressor();
		compressor.threshold.value = -18;
		compressor.ratio.value = 4;
		compressor.connect(ctx.destination);

		const reverb = ctx.createConvolver();
		reverb.buffer = impulseResponse(ctx, 4.5, 2.2);
		const wet = ctx.createGain();
		wet.gain.value = 0.55;
		reverb.connect(wet).connect(compressor);

		const music = ctx.createGain();
		music.gain.value = this.#settings.music * 0.6;
		music.connect(compressor);
		const musicSend = ctx.createGain();
		musicSend.gain.value = 0.8;
		music.connect(musicSend).connect(reverb);

		const effects = ctx.createGain();
		effects.gain.value = this.#settings.effects;
		effects.connect(compressor);

		const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
		const samples = noise.getChannelData(0);
		for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

		this.#ctx = ctx;
		this.#reverb = reverb;
		this.#musicBus = music;
		this.#effectsBus = effects;
		this.#noise = noise;
		this.#textures = {
			bounce: this.#crackle(ctx, effects, reverb),
			merge: this.#rumble(ctx, effects),
		};
	}

	/**
	 * Continuous gravelly crackle for many bounces at once (silent until its gain is
	 * raised): looped random clicks through a band-pass filter.
	 *
	 * @param {AudioContext} ctx
	 * @param {AudioNode} bus
	 * @param {AudioNode} reverb
	 */
	#crackle(ctx, bus, reverb) {
		const source = ctx.createBufferSource();
		source.buffer = clicks(ctx, 3, 180);
		source.loop = true;
		const band = ctx.createBiquadFilter();
		band.type = "bandpass";
		band.frequency.value = 2200;
		band.Q.value = 0.6;
		const level = ctx.createGain();
		level.gain.value = 0;
		source.connect(band).connect(level).connect(bus);
		const send = ctx.createGain();
		send.gain.value = 0.25;
		level.connect(send).connect(reverb);
		source.start();
		return level;
	}

	/**
	 * Continuous low rumble for many merges at once (silent until its gain is raised).
	 *
	 * @param {AudioContext} ctx
	 * @param {AudioNode} bus
	 */
	#rumble(ctx, bus) {
		const source = this.#noiseSource();
		const low = ctx.createBiquadFilter();
		low.type = "lowpass";
		low.frequency.value = 140;
		low.Q.value = 0.8;
		const level = ctx.createGain();
		level.gain.value = 0;
		source.connect(low).connect(level).connect(bus);
		source.start();
		return level;
	}

	/** Starts or stops the music to match the settings and page visibility. */
	#updateMusic() {
		const ctx = this.#ctx;
		const wanted =
			Boolean(ctx) && this.#settings.enabled && this.#settings.music > 0 && !this.#hidden;
		if (wanted && this.#scheduler === undefined && ctx) {
			this.#startDrone(ctx);
			this.#nextPad = ctx.currentTime + 0.5;
			this.#nextBell = ctx.currentTime + between(3, 6);
			this.#scheduler = setInterval(() => this.#schedule(), 500);
			this.#schedule();
		} else if (!wanted && this.#scheduler !== undefined) {
			clearInterval(this.#scheduler);
			this.#scheduler = undefined;
			const stopAt = (ctx?.currentTime ?? 0) + 0.1;
			for (const node of this.#drone) node.stop(stopAt);
			this.#drone = [];
		}
	}

	/** A low, slowly breathing drone on the root and fifth. @param {AudioContext} ctx */
	#startDrone(ctx) {
		const bus = /** @type {GainNode} */ (this.#musicBus);
		const filter = ctx.createBiquadFilter();
		filter.type = "lowpass";
		filter.frequency.value = 320;
		filter.Q.value = 0.7;
		const level = ctx.createGain();
		level.gain.setValueAtTime(0, ctx.currentTime);
		level.gain.linearRampToValueAtTime(0.11, ctx.currentTime + 6);
		filter.connect(level).connect(bus);

		const lfo = ctx.createOscillator();
		lfo.frequency.value = 0.045;
		const depth = ctx.createGain();
		depth.gain.value = 140;
		lfo.connect(depth).connect(filter.frequency);
		lfo.start();
		this.#drone.push(lfo);

		for (const [semitones, type, detune] of /** @type {const} */ ([
			[0, "sawtooth", -6],
			[0, "sawtooth", 6],
			[7, "triangle", 0],
			[-12, "sine", 0],
		])) {
			const osc = ctx.createOscillator();
			osc.type = type;
			osc.frequency.value = pitch(semitones);
			osc.detune.value = detune;
			osc.connect(filter);
			osc.start();
			this.#drone.push(osc);
		}
	}

	/** Schedules the next pad chords and bell notes shortly before they are due. */
	#schedule() {
		const ctx = this.#ctx;
		if (!ctx || ctx.state !== "running") return;
		const horizon = ctx.currentTime + 1;
		while (this.#nextPad < horizon) {
			this.#pad(ctx, this.#nextPad);
			this.#nextPad += between(9, 15);
		}
		while (this.#nextBell < horizon) {
			this.#bell(ctx, this.#nextBell);
			this.#nextBell += between(2.5, 8);
		}
	}

	/** A slow-swelling chord of three scale notes. @param {AudioContext} ctx @param {number} t */
	#pad(ctx, t) {
		const bus = /** @type {GainNode} */ (this.#musicBus);
		const filter = ctx.createBiquadFilter();
		filter.type = "lowpass";
		filter.frequency.value = 700;
		const level = envelopeHold(ctx, bus, t, 5, 6, 7, 0.035);
		filter.connect(level);
		const root = Math.floor(Math.random() * SCALE.length);
		for (let k = 0; k < 3; k++) {
			const degree = root + k * 2;
			const semitones =
				12 * (1 + Math.floor(degree / SCALE.length)) + SCALE[degree % SCALE.length];
			for (const detune of [-8, 8]) {
				const osc = ctx.createOscillator();
				osc.type = "sawtooth";
				osc.frequency.value = pitch(semitones);
				osc.detune.value = detune;
				osc.connect(filter);
				osc.start(t);
				osc.stop(t + 18.5);
			}
		}
	}

	/** A distant, slightly inharmonic bell. @param {AudioContext} ctx @param {number} t */
	#bell(ctx, t) {
		const bus = /** @type {GainNode} */ (this.#musicBus);
		const panner = ctx.createStereoPanner();
		panner.pan.value = between(-0.7, 0.7);
		panner.connect(bus);
		const freq = randomNote(Math.random() < 0.5 ? 3 : 4);
		const decay = between(3, 5);
		tone(ctx, panner, "sine", freq, 1, t, 0.01, decay, 0.045);
		tone(ctx, panner, "sine", freq * 2.76, 1, t, 0.005, decay * 0.4, 0.012);
		setTimeout(() => panner.disconnect(), (t - ctx.currentTime + decay + 1) * 1000);
	}
}

/**
 * A gain node rising from silence to `peak` and decaying exponentially, connected to
 * `destination`; connect a source to it.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination
 * @param {number} t Start time.
 * @param {number} attack Seconds.
 * @param {number} decay Seconds after the attack.
 * @param {number} peak
 */
function envelope(ctx, destination, t, attack, decay, peak) {
	const gain = ctx.createGain();
	gain.gain.setValueAtTime(0.0001, t);
	gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
	gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
	gain.connect(destination);
	return gain;
}

/**
 * Attack, hold and release with linear ramps (for slow pads).
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination
 * @param {number} t
 * @param {number} attack
 * @param {number} hold
 * @param {number} release
 * @param {number} peak
 */
function envelopeHold(ctx, destination, t, attack, hold, release, peak) {
	const gain = ctx.createGain();
	gain.gain.setValueAtTime(0, t);
	gain.gain.linearRampToValueAtTime(peak, t + attack);
	gain.gain.setValueAtTime(peak, t + attack + hold);
	gain.gain.linearRampToValueAtTime(0, t + attack + hold + release);
	gain.connect(destination);
	return gain;
}

/**
 * A single enveloped oscillator note whose pitch glides to `glide` × its start.
 *
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} destination
 * @param {OscillatorType} type
 * @param {number} freq
 * @param {number} glide
 * @param {number} t
 * @param {number} attack
 * @param {number} decay
 * @param {number} peak
 */
function tone(ctx, destination, type, freq, glide, t, attack, decay, peak) {
	const osc = ctx.createOscillator();
	osc.type = type;
	osc.frequency.setValueAtTime(freq, t);
	if (glide !== 1) osc.frequency.exponentialRampToValueAtTime(freq * glide, t + attack + decay);
	osc.connect(envelope(ctx, destination, t, attack, decay, peak));
	osc.start(t);
	osc.stop(t + attack + decay + 0.05);
}

/**
 * Stereo random clicks (short decaying noise bursts at random times and loudness),
 * different in each ear, for a crackle that can loop without an obvious repeat.
 *
 * @param {BaseAudioContext} ctx
 * @param {number} seconds
 * @param {number} perSecond Average clicks per second, per ear.
 */
function clicks(ctx, seconds, perSecond) {
	const rate = ctx.sampleRate;
	const length = Math.floor(rate * seconds);
	const buffer = ctx.createBuffer(2, length, rate);
	for (let channel = 0; channel < 2; channel++) {
		const data = buffer.getChannelData(channel);
		for (let n = Math.round(seconds * perSecond); n > 0; n--) {
			const at = Math.floor(Math.random() * length);
			const amplitude = Math.random() ** 2;
			const decay = rate * between(0.0008, 0.004);
			for (let i = 0; i < decay * 5 && at + i < length; i++) {
				data[at + i] += (Math.random() * 2 - 1) * amplitude * Math.exp(-i / decay);
			}
		}
	}
	return buffer;
}

/**
 * Stereo reverb impulse: decaying noise, a little different in each ear.
 *
 * @param {BaseAudioContext} ctx
 * @param {number} seconds
 * @param {number} decay Higher fades faster.
 */
function impulseResponse(ctx, seconds, decay) {
	const length = Math.floor(ctx.sampleRate * seconds);
	const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
	for (let channel = 0; channel < 2; channel++) {
		const data = buffer.getChannelData(channel);
		for (let i = 0; i < length; i++) {
			data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
		}
	}
	return buffer;
}
