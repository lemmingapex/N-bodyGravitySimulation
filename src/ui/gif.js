/**
 * Small, dependency-free, streaming animated-GIF (GIF89a) encoder for canvas recordings.
 *
 * Every frame shares one fixed 256-entry global palette, so frames are quantized and
 * LZW-compressed as soon as they are added; only the compressed bytes are kept.
 *
 * Palette layout:
 * - 0: the exact background color (also the logical-screen background index).
 * - 1..3: background-tinted grays a few steps lighter (or darker, for a light background),
 *   so dim, fading trails don't all collapse to the background or black.
 * - 4..255: a 6×7×6 RGB cube (green gets the extra level; the eye is most sensitive to it).
 *
 * Pixels within a small distance of the background map to index 0 exactly, so empty space
 * stays one flat color and compresses to long LZW runs. Everything else maps to its nearest
 * palette entry (no dithering): the nearest cube entry comes from per-channel lookup tables,
 * then the four extra entries are checked.
 */

const PALETTE_SIZE = 256;
const R_LEVELS = 6;
const G_LEVELS = 7;
const B_LEVELS = 6;
/** Background + 3 grays, stored before the cube. */
const EXTRA_COUNT = 4;
const BACKGROUND_INDEX = 0;
/** How far (fractionally) each extra gray moves from the background toward white/black. */
const EXTRA_STEPS = [0, 0.06, 0.12, 0.2];
/** Squared RGB distance (≈ 7 levels) within which a pixel snaps to the background index. */
const BACKGROUND_TOLERANCE_SQ = 48;

const MIN_CODE_SIZE = 8;
const CLEAR_CODE = 1 << MIN_CODE_SIZE;
const END_CODE = CLEAR_CODE + 1;
const FIRST_CODE = END_CODE + 1;
/** 12-bit codes: the dictionary is full once code 4095 has been assigned. */
const MAX_CODES = 4096;
/** Open-addressing dictionary: (prefix code << 8 | next index) → code. Load factor ≤ 0.25. */
const HASH_BITS = 14;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

/** Output is collected in fixed-size chunks rather than one preallocated buffer. */
const CHUNK_SIZE = 1 << 16;

const DEFAULT_DELAY_MS = 66;
/** Browsers treat delays below 2 cs as "as fast as possible" (often clamped to 10 cs). */
const MIN_DELAY_CS = 2;
/** @type {[number, number, number]} */
const DEFAULT_BACKGROUND = [13, 15, 20];

/**
 * Per-channel nearest-level tables for the color cube: `offset` is the channel's contribution
 * to the cube index and `value` is the level's channel value.
 *
 * @param {number} levels
 * @param {number} stride
 */
function channelTable(levels, stride) {
	const offset = new Uint16Array(256);
	const value = new Uint8Array(256);
	for (let v = 0; v < 256; v++) {
		const level = Math.round((v * (levels - 1)) / 255);
		offset[v] = level * stride;
		value[v] = levelValue(level, levels);
	}
	return { offset, value };
}

/**
 * @param {number} level
 * @param {number} levels
 */
function levelValue(level, levels) {
	return Math.round((level * 255) / (levels - 1));
}

const R_TABLE = channelTable(R_LEVELS, G_LEVELS * B_LEVELS);
const G_TABLE = channelTable(G_LEVELS, B_LEVELS);
const B_TABLE = channelTable(B_LEVELS, 1);

/**
 * @param {string} name
 * @param {number} value
 */
function checkDimension(name, value) {
	if (!Number.isInteger(value) || value < 1 || value > 0xffff) {
		throw new RangeError(`GIF ${name} must be an integer in 1..65535, got ${value}`);
	}
}

/** @param {number} c */
const toByte = (c) => Math.min(255, Math.max(0, Math.round(Number(c) || 0)));

/**
 * @param {readonly [number, number, number]} background
 * @returns {Uint8Array} 256 RGB triples.
 */
function buildPalette(background) {
	const palette = new Uint8Array(PALETTE_SIZE * 3);
	const [br, bg, bb] = background;
	const target = br * 0.299 + bg * 0.587 + bb * 0.114 < 128 ? 255 : 0;
	for (let i = 0; i < EXTRA_COUNT; i++) {
		const t = EXTRA_STEPS[i];
		palette[i * 3] = Math.round(br + (target - br) * t);
		palette[i * 3 + 1] = Math.round(bg + (target - bg) * t);
		palette[i * 3 + 2] = Math.round(bb + (target - bb) * t);
	}
	let o = EXTRA_COUNT * 3;
	for (let r = 0; r < R_LEVELS; r++) {
		for (let g = 0; g < G_LEVELS; g++) {
			for (let b = 0; b < B_LEVELS; b++) {
				palette[o++] = levelValue(r, R_LEVELS);
				palette[o++] = levelValue(g, G_LEVELS);
				palette[o++] = levelValue(b, B_LEVELS);
			}
		}
	}
	return palette;
}

/**
 * @param {Uint8Array} palette
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {number} Palette index.
 */
function nearestIndex(palette, r, g, b) {
	let dr = r - palette[0];
	let dg = g - palette[1];
	let db = b - palette[2];
	let bestDist = dr * dr + dg * dg + db * db;
	if (bestDist <= BACKGROUND_TOLERANCE_SQ) return BACKGROUND_INDEX;
	let best = BACKGROUND_INDEX;
	for (let i = 1; i < EXTRA_COUNT; i++) {
		dr = r - palette[i * 3];
		dg = g - palette[i * 3 + 1];
		db = b - palette[i * 3 + 2];
		const dist = dr * dr + dg * dg + db * db;
		if (dist < bestDist) {
			bestDist = dist;
			best = i;
		}
	}
	dr = r - R_TABLE.value[r];
	dg = g - G_TABLE.value[g];
	db = b - B_TABLE.value[b];
	if (dr * dr + dg * dg + db * db < bestDist) {
		best = EXTRA_COUNT + R_TABLE.offset[r] + G_TABLE.offset[g] + B_TABLE.offset[b];
	}
	return best;
}

/** Append-only byte sink that grows in fixed-size chunks. */
class ByteWriter {
	/** @type {Uint8Array<ArrayBuffer>[]} */
	#chunks = [];
	#chunk = new Uint8Array(CHUNK_SIZE);
	#pos = 0;
	#flushed = 0;

	get length() {
		return this.#flushed + this.#pos;
	}

	/** @param {number} value */
	byte(value) {
		if (this.#pos === this.#chunk.length) this.#grow();
		this.#chunk[this.#pos++] = value;
	}

	/** @param {number} value Little-endian 16-bit. */
	u16(value) {
		this.byte(value & 0xff);
		this.byte((value >> 8) & 0xff);
	}

	/**
	 * @param {ArrayLike<number> & { subarray(start: number, end: number): ArrayLike<number> }} src
	 * @param {number} [length]
	 */
	bytes(src, length = src.length) {
		let offset = 0;
		while (offset < length) {
			if (this.#pos === this.#chunk.length) this.#grow();
			const n = Math.min(length - offset, this.#chunk.length - this.#pos);
			this.#chunk.set(src.subarray(offset, offset + n), this.#pos);
			this.#pos += n;
			offset += n;
		}
	}

	/** @param {string} text ASCII only. */
	ascii(text) {
		for (let i = 0; i < text.length; i++) this.byte(text.charCodeAt(i));
	}

	/** Concatenates everything written so far and releases the chunks. */
	take() {
		const out = new Uint8Array(this.length);
		let o = 0;
		for (const chunk of this.#chunks) {
			out.set(chunk, o);
			o += chunk.length;
		}
		out.set(this.#chunk.subarray(0, this.#pos), o);
		this.#chunks = [];
		this.#chunk = new Uint8Array(0);
		this.#pos = 0;
		this.#flushed = out.length;
		return out;
	}

	#grow() {
		this.#chunks.push(this.#chunk);
		this.#flushed += this.#chunk.length;
		this.#chunk = new Uint8Array(CHUNK_SIZE);
		this.#pos = 0;
	}
}

export class GifEncoder {
	#width;
	#height;
	#delayCs;
	#palette;
	#writer = new ByteWriter();
	#frameCount = 0;
	/** @type {Uint8Array<ArrayBuffer> | null} */
	#result = null;
	/** Palette index per pixel, reused across frames. */
	#indices;
	#hashKeys = new Int32Array(HASH_SIZE);
	#hashCodes = new Uint16Array(HASH_SIZE);
	/** One data sub-block: length byte followed by up to 255 bytes. */
	#block = new Uint8Array(256);

	/**
	 * @param {number} width
	 * @param {number} height
	 * @param {{ delayMs?: number, background?: [number, number, number], loop?: boolean }} [options]
	 *   delayMs: per-frame delay; stored in centiseconds, rounded, minimum 2 cs. Default 66.
	 *   background: RGB that maps to an exact palette entry. Default [13, 15, 20].
	 *   loop: add the NETSCAPE2.0 infinite-loop extension. Default true.
	 */
	constructor(width, height, { delayMs = DEFAULT_DELAY_MS, background, loop = true } = {}) {
		checkDimension("width", width);
		checkDimension("height", height);
		this.#width = width;
		this.#height = height;
		const delay = Number.isFinite(delayMs) ? delayMs : DEFAULT_DELAY_MS;
		this.#delayCs = Math.min(0xffff, Math.max(MIN_DELAY_CS, Math.round(delay / 10)));
		const bg = background ?? DEFAULT_BACKGROUND;
		this.#palette = buildPalette([toByte(bg[0]), toByte(bg[1]), toByte(bg[2])]);
		this.#indices = new Uint8Array(width * height);
		this.#writeHeader(loop);
	}

	/** Number of frames added so far. */
	get frameCount() {
		return this.#frameCount;
	}

	/** Approximate encoded bytes so far (exact until `finish()`, which adds the 1-byte trailer). */
	get byteLength() {
		return this.#writer.length;
	}

	/**
	 * Quantizes and compresses one frame immediately; the pixels are not retained.
	 *
	 * @param {Uint8ClampedArray | Uint8Array} rgba width*height*4 bytes (ImageData.data). Alpha is ignored.
	 */
	addFrame(rgba) {
		if (this.#result) throw new Error("GifEncoder: addFrame() called after finish()");
		const expected = this.#width * this.#height * 4;
		if (!rgba || rgba.length !== expected) {
			throw new RangeError(
				`GifEncoder: expected ${expected} RGBA bytes for ${this.#width}×${this.#height}, got ${rgba?.length}`,
			);
		}
		this.#quantize(rgba);
		const w = this.#writer;
		// Graphic control extension: disposal 1 (leave in place), no transparency.
		w.bytes(Uint8Array.of(0x21, 0xf9, 4, 0b0000_0100));
		w.u16(this.#delayCs);
		w.bytes(Uint8Array.of(0, 0));
		// Image descriptor: full frame, no local color table, not interlaced.
		w.byte(0x2c);
		w.u16(0);
		w.u16(0);
		w.u16(this.#width);
		w.u16(this.#height);
		w.byte(0);
		this.#compress();
		this.#frameCount++;
	}

	/**
	 * @returns {Uint8Array<ArrayBuffer>} The complete GIF file. Later calls return the same bytes;
	 *   further `addFrame()` calls throw.
	 */
	finish() {
		if (!this.#result) {
			this.#writer.byte(0x3b);
			this.#result = this.#writer.take();
		}
		return this.#result;
	}

	/** @param {boolean} loop */
	#writeHeader(loop) {
		const w = this.#writer;
		w.ascii("GIF89a");
		w.u16(this.#width);
		w.u16(this.#height);
		// Global color table present, 8-bit color resolution, unsorted, 2^(7+1) entries.
		w.byte(0b1111_0111);
		w.byte(BACKGROUND_INDEX);
		w.byte(0); // pixel aspect ratio: unspecified
		w.bytes(this.#palette);
		if (loop) {
			w.bytes(Uint8Array.of(0x21, 0xff, 11));
			w.ascii("NETSCAPE2.0");
			w.bytes(Uint8Array.of(3, 1, 0, 0, 0)); // sub-block: id 1, loop count 0 (forever)
		}
	}

	/** @param {Uint8ClampedArray | Uint8Array} rgba */
	#quantize(rgba) {
		const indices = this.#indices;
		const palette = this.#palette;
		const count = indices.length;
		// Canvas frames are dominated by runs of one color, so cache the previous pixel.
		let lastKey = -1;
		let lastIndex = BACKGROUND_INDEX;
		for (let i = 0, p = 0; i < count; i++, p += 4) {
			const r = rgba[p];
			const g = rgba[p + 1];
			const b = rgba[p + 2];
			const key = r | (g << 8) | (b << 16);
			if (key !== lastKey) {
				lastKey = key;
				lastIndex = nearestIndex(palette, r, g, b);
			}
			indices[i] = lastIndex;
		}
	}

	/** Writes the LZW minimum code size, the image data sub-blocks and the block terminator. */
	#compress() {
		const indices = this.#indices;
		const count = indices.length;
		const writer = this.#writer;
		const keys = this.#hashKeys;
		const codes = this.#hashCodes;
		const block = this.#block;
		let blockLength = 0;
		let bits = 0;
		let bitCount = 0;
		let codeSize = MIN_CODE_SIZE + 1;
		let nextCode = FIRST_CODE;

		/** @param {number} code */
		const emit = (code) => {
			bits |= code << bitCount;
			bitCount += codeSize;
			while (bitCount >= 8) {
				block[++blockLength] = bits & 0xff;
				bits >>>= 8;
				bitCount -= 8;
				if (blockLength === 255) {
					block[0] = 255;
					writer.bytes(block, 256);
					blockLength = 0;
				}
			}
		};

		writer.byte(MIN_CODE_SIZE);
		keys.fill(-1);
		emit(CLEAR_CODE);
		let prefix = indices[0];
		for (let i = 1; i < count; i++) {
			const k = indices[i];
			const key = (prefix << 8) | k;
			let h = Math.imul(key, 0x9e3779b1) >>> (32 - HASH_BITS);
			let found = keys[h];
			while (found !== key && found !== -1) {
				h = (h + 1) & HASH_MASK;
				found = keys[h];
			}
			if (found === key) {
				prefix = codes[h];
				continue;
			}
			emit(prefix);
			if (nextCode < MAX_CODES) {
				keys[h] = key;
				codes[h] = nextCode++;
				// The decoder adds each entry one code later than we do, so its next code can
				// be at most nextCode - 1: widen only once that no longer fits.
				if (nextCode > 1 << codeSize) codeSize++;
			} else {
				emit(CLEAR_CODE);
				keys.fill(-1);
				nextCode = FIRST_CODE;
				codeSize = MIN_CODE_SIZE + 1;
			}
			prefix = k;
		}
		emit(prefix);
		// The decoder adds an entry after reading that last code, which may widen the end code.
		if (nextCode < MAX_CODES && nextCode >= 1 << codeSize) codeSize++;
		emit(END_CODE);
		if (bitCount > 0) block[++blockLength] = bits & 0xff;
		if (blockLength > 0) {
			block[0] = blockLength;
			writer.bytes(block, blockLength + 1);
		}
		writer.byte(0);
	}
}
