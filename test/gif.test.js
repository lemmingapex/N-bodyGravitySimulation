import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRng } from "../src/physics/rng.js";
import { GifEncoder } from "../src/ui/gif.js";

/**
 * @typedef {{ delayCs: number | null, width: number, height: number, indices: Uint8Array,
 *   rgba: Uint8Array, clears: number }} DecodedFrame
 * @typedef {{ width: number, height: number, backgroundIndex: number, palette: Uint8Array,
 *   loop: number | null, frames: DecodedFrame[] }} DecodedGif
 */

/**
 * Minimal, strict GIF decoder: just enough to verify the encoder's output.
 *
 * @param {Uint8Array} bytes
 * @returns {DecodedGif}
 */
function decodeGif(bytes) {
	let p = 0;
	const u8 = () => {
		if (p >= bytes.length) throw new Error("unexpected end of file");
		return bytes[p++];
	};
	const u16 = () => u8() | (u8() << 8);
	const ascii = (/** @type {number} */ n) =>
		String.fromCharCode(...Array.from({ length: n }, u8));
	const subBlocks = () => {
		/** @type {number[]} */
		const data = [];
		for (let size = u8(); size !== 0; size = u8()) {
			for (let i = 0; i < size; i++) data.push(u8());
		}
		return Uint8Array.from(data);
	};

	assert.equal(ascii(6), "GIF89a");
	const width = u16();
	const height = u16();
	const packed = u8();
	const backgroundIndex = u8();
	u8(); // aspect
	assert.ok(packed & 0x80, "global color table present");
	const palette = Uint8Array.from({ length: 3 * (2 << (packed & 7)) }, u8);

	/** @type {number | null} */
	let loop = null;
	/** @type {number | null} */
	let delayCs = null;
	/** @type {DecodedFrame[]} */
	const frames = [];
	for (;;) {
		const introducer = u8();
		if (introducer === 0x3b) break;
		if (introducer === 0x21) {
			const label = u8();
			if (label === 0xf9) {
				assert.equal(u8(), 4);
				u8(); // packed
				delayCs = u16();
				u8(); // transparent index
				assert.equal(u8(), 0, "GCE terminator");
			} else if (label === 0xff) {
				assert.equal(u8(), 11);
				const app = ascii(11);
				const data = subBlocks();
				if (app === "NETSCAPE2.0") {
					assert.equal(data[0], 1);
					loop = data[1] | (data[2] << 8);
				}
			} else {
				subBlocks();
			}
		} else if (introducer === 0x2c) {
			u16(); // left
			u16(); // top
			const w = u16();
			const h = u16();
			assert.equal(u8() & 0x80, 0, "no local color table");
			const minCodeSize = u8();
			const { indices, clears } = lzwDecode(subBlocks(), minCodeSize, w * h);
			const rgba = new Uint8Array(w * h * 4);
			for (let i = 0; i < indices.length; i++) {
				rgba[i * 4] = palette[indices[i] * 3];
				rgba[i * 4 + 1] = palette[indices[i] * 3 + 1];
				rgba[i * 4 + 2] = palette[indices[i] * 3 + 2];
				rgba[i * 4 + 3] = 255;
			}
			frames.push({ delayCs, width: w, height: h, indices, rgba, clears });
			delayCs = null;
		} else {
			throw new Error(`unknown block 0x${introducer.toString(16)} at ${p - 1}`);
		}
	}
	assert.equal(p, bytes.length, "nothing after the trailer");
	return { width, height, backgroundIndex, palette, loop, frames };
}

/**
 * @param {Uint8Array} data Concatenated image data sub-blocks.
 * @param {number} minCodeSize
 * @param {number} pixelCount
 */
function lzwDecode(data, minCodeSize, pixelCount) {
	const clearCode = 1 << minCodeSize;
	const endCode = clearCode + 1;
	const prefix = new Int32Array(4096);
	const suffix = new Uint8Array(4096);
	const first = new Uint8Array(4096);
	const length = new Int32Array(4096);
	for (let i = 0; i < clearCode; i++) {
		suffix[i] = i;
		first[i] = i;
		length[i] = 1;
	}
	const out = new Uint8Array(pixelCount);
	let op = 0;
	let codeSize = minCodeSize + 1;
	let nextCode = endCode + 1;
	let prev = -1;
	let clears = 0;
	let bitPos = 0;
	let ended = false;

	/** @param {number} code */
	const writeSequence = (code) => {
		const n = length[code];
		if (op + n > pixelCount) throw new Error("too many pixels");
		for (let i = n - 1, c = code; i >= 0; i--, c = prefix[c]) out[op + i] = suffix[c];
		op += n;
	};

	while (bitPos + codeSize <= data.length * 8) {
		let code = 0;
		for (let i = 0; i < codeSize; i++, bitPos++) {
			code |= ((data[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
		}
		if (code === clearCode) {
			clears++;
			codeSize = minCodeSize + 1;
			nextCode = endCode + 1;
			prev = -1;
			continue;
		}
		if (code === endCode) {
			ended = true;
			break;
		}
		if (prev === -1) {
			if (code >= clearCode) throw new Error(`bad first code ${code}`);
			writeSequence(code);
			prev = code;
			continue;
		}
		let firstChar;
		if (code < nextCode) {
			writeSequence(code);
			firstChar = first[code];
		} else if (code === nextCode && nextCode < 4096) {
			firstChar = first[prev];
			writeSequence(prev);
			if (op >= pixelCount) throw new Error("too many pixels");
			out[op++] = firstChar;
		} else {
			throw new Error(`code ${code} out of range (next ${nextCode})`);
		}
		if (nextCode < 4096) {
			prefix[nextCode] = prev;
			suffix[nextCode] = firstChar;
			first[nextCode] = first[prev];
			length[nextCode] = length[prev] + 1;
			nextCode++;
			if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
		}
		prev = code;
	}
	assert.ok(ended, "end-of-information code present");
	assert.ok(data.length - Math.ceil(bitPos / 8) === 0, "no trailing data after end code");
	assert.equal(op, pixelCount, "pixel count");
	return { indices: out, clears };
}

/** @type {[number, number, number]} */
const BG = [13, 15, 20];

/**
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => [number, number, number]} [color]
 */
function makeFrame(width, height, color = () => /** @type {[number, number, number]} */ (BG)) {
	const rgba = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = color(x, y);
			const o = (y * width + x) * 4;
			rgba[o] = r;
			rgba[o + 1] = g;
			rgba[o + 2] = b;
			rgba[o + 3] = 255;
		}
	}
	return rgba;
}

/**
 * Simulation-like frame: background, fading trails and bright dots.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} seed
 */
function sceneFrame(width, height, seed) {
	const rng = createRng(seed);
	const rgba = makeFrame(width, height);
	const plot = (
		/** @type {number} */ x,
		/** @type {number} */ y,
		/** @type {number[]} */ c,
		/** @type {number} */ a,
	) => {
		if (x < 0 || y < 0 || x >= width || y >= height) return;
		const o = (Math.floor(y) * width + Math.floor(x)) * 4;
		for (let k = 0; k < 3; k++) rgba[o + k] = rgba[o + k] * (1 - a) + c[k] * a;
	};
	for (let body = 0; body < 40; body++) {
		const color = [rng() * 255, rng() * 255, rng() * 255];
		let x = rng() * width;
		let y = rng() * height;
		const vx = rng() * 4 - 2;
		const vy = rng() * 4 - 2;
		for (let t = 0; t < 60; t++) {
			plot(x, y, color, 0.6 * (t / 60));
			x += vx;
			y += vy;
		}
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++)
				if (dx * dx + dy * dy <= 5) plot(x + dx, y + dy, color, 1);
		}
	}
	return rgba;
}

/**
 * @param {Uint8Array} palette
 * @param {number} r
 * @param {number} g
 * @param {number} b
 */
function nearestDistance(palette, r, g, b) {
	let best = Infinity;
	for (let i = 0; i < palette.length; i += 3) {
		const d = (r - palette[i]) ** 2 + (g - palette[i + 1]) ** 2 + (b - palette[i + 2]) ** 2;
		best = Math.min(best, d);
	}
	return best;
}

describe("GifEncoder", () => {
	it("writes a GIF89a with a 256-color global table and an infinite loop", () => {
		const gif = new GifEncoder(4, 3);
		gif.addFrame(makeFrame(4, 3));
		const decoded = decodeGif(gif.finish());
		assert.equal(decoded.width, 4);
		assert.equal(decoded.height, 3);
		assert.equal(decoded.palette.length, 256 * 3);
		assert.equal(decoded.loop, 0);
		assert.deepEqual([...decoded.palette.subarray(0, 3)], BG);
		assert.equal(decoded.backgroundIndex, 0);
	});

	it("omits the loop extension when loop is false", () => {
		const gif = new GifEncoder(2, 2, { loop: false });
		gif.addFrame(makeFrame(2, 2));
		assert.equal(decodeGif(gif.finish()).loop, null);
	});

	it("maps the background, and colors close to it, to the exact background color", () => {
		const gif = new GifEncoder(8, 2);
		gif.addFrame(makeFrame(8, 2, (x, y) => (y === 0 ? [13, 15, 20] : [14 + (x % 3), 13, 22])));
		const [frame] = decodeGif(gif.finish()).frames;
		for (let i = 0; i < 16; i++) {
			assert.deepEqual([...frame.rgba.subarray(i * 4, i * 4 + 3)], BG, `pixel ${i}`);
		}
	});

	it("honors a custom background color", () => {
		const background = /** @type {[number, number, number]} */ ([40, 20, 70]);
		const gif = new GifEncoder(3, 1, { background });
		gif.addFrame(makeFrame(3, 1, () => background));
		const [frame] = decodeGif(gif.finish()).frames;
		assert.deepEqual([...frame.rgba.subarray(0, 3)], background);
		assert.deepEqual([...frame.rgba.subarray(8, 11)], background);
	});

	it("round-trips primary colors within quantization tolerance", () => {
		/** @type {[number, number, number][]} */
		const colors = [
			[255, 0, 0],
			[0, 255, 0],
			[0, 0, 255],
			[255, 255, 255],
			[0, 0, 0],
			[255, 255, 0],
			[0, 255, 255],
			[255, 0, 255],
			[128, 128, 128],
			[250, 140, 30],
		];
		const gif = new GifEncoder(colors.length, 1);
		gif.addFrame(makeFrame(colors.length, 1, (x) => colors[x]));
		const [frame] = decodeGif(gif.finish()).frames;
		colors.forEach((color, i) => {
			for (let k = 0; k < 3; k++) {
				const error = Math.abs(frame.rgba[i * 4 + k] - color[k]);
				assert.ok(error <= 26, `color ${color} channel ${k} off by ${error}`);
			}
		});
		assert.deepEqual([...frame.rgba.subarray(0, 3)], [255, 0, 0]);
		assert.deepEqual([...frame.rgba.subarray(12, 15)], [255, 255, 255]);
	});

	it("encodes several frames with the requested delay", () => {
		const gif = new GifEncoder(5, 4, { delayMs: 100 });
		for (let f = 0; f < 3; f++) {
			gif.addFrame(makeFrame(5, 4, (x) => (x === f ? [255, 255, 255] : BG)));
		}
		assert.equal(gif.frameCount, 3);
		const { frames } = decodeGif(gif.finish());
		assert.equal(frames.length, 3);
		frames.forEach((frame, f) => {
			assert.equal(frame.delayCs, 10);
			assert.deepEqual([...frame.rgba.subarray(f * 4, f * 4 + 3)], [255, 255, 255]);
			assert.deepEqual(
				[...frame.rgba.subarray(((f + 1) % 5) * 4, ((f + 1) % 5) * 4 + 3)],
				BG,
			);
		});
	});

	it("rounds delays to centiseconds with a 2 cs minimum", () => {
		for (const [delayMs, expected] of [
			[undefined, 7],
			[0, 2],
			[14, 2],
			[34, 3],
			[1000, 100],
		]) {
			const gif = new GifEncoder(1, 1, delayMs === undefined ? {} : { delayMs });
			gif.addFrame(makeFrame(1, 1));
			assert.equal(decodeGif(gif.finish()).frames[0].delayCs, expected, `delayMs ${delayMs}`);
		}
	});

	it("survives dictionary resets on a large noisy frame", () => {
		const rng = createRng(1234);
		const width = 300;
		const height = 211;
		const input = makeFrame(width, height, () => [
			Math.floor(rng() * 256),
			Math.floor(rng() * 256),
			Math.floor(rng() * 256),
		]);
		const gif = new GifEncoder(width, height);
		gif.addFrame(input);
		const decoded = decodeGif(gif.finish());
		const [frame] = decoded.frames;
		assert.ok(frame.clears > 5, `expected several table resets, got ${frame.clears}`);
		// Every pixel decodes to a nearest palette entry: exercises both the quantizer and LZW.
		for (let i = 0; i < width * height; i++) {
			const [r, g, b] = input.subarray(i * 4, i * 4 + 3);
			const d =
				(r - frame.rgba[i * 4]) ** 2 +
				(g - frame.rgba[i * 4 + 1]) ** 2 +
				(b - frame.rgba[i * 4 + 2]) ** 2;
			assert.equal(d, nearestDistance(decoded.palette, r, g, b), `pixel ${i}`);
		}
	});

	it("round-trips long repetitive runs and patterns", () => {
		const width = 640;
		const height = 97;
		const input = makeFrame(width, height, (x, y) =>
			(x * 7 + y * 3) % 13 < 2 ? [255, 255, 255] : x % 50 === 0 ? [0, 255, 0] : BG,
		);
		const gif = new GifEncoder(width, height);
		gif.addFrame(input);
		gif.addFrame(sceneFrame(width, height, 9));
		const { frames } = decodeGif(gif.finish());
		for (let i = 0; i < width * height * 4; i += 4) {
			const expected =
				input[i] === 255 ? [255, 255, 255] : input[i + 1] === 255 ? [0, 255, 0] : BG;
			assert.deepEqual([...frames[0].rgba.subarray(i, i + 3)], expected);
		}
		assert.equal(frames[1].indices.length, width * height);
	});

	describe("code width at the end of a frame", () => {
		/**
		 * One row of noise drawn from exact palette (cube) colors, so it must round-trip exactly.
		 *
		 * @param {() => number} rng
		 * @param {number} n
		 */
		const cubeNoiseRow = (rng, n) =>
			makeFrame(n, 1, () => [
				Math.floor(rng() * 6) * 51,
				Math.round(Math.floor(rng() * 7) * 42.5),
				Math.floor(rng() * 6) * 51,
			]);

		/** @param {Uint8ClampedArray} input */
		const assertExactRoundTrip = (input) => {
			const n = input.length / 4;
			const gif = new GifEncoder(n, 1);
			gif.addFrame(input);
			const [frame] = decodeGif(gif.finish()).frames;
			for (let i = 0; i < n * 4; i += 4) {
				assert.deepEqual(
					[...frame.rgba.subarray(i, i + 3)],
					[...input.subarray(i, i + 3)],
					`n=${n} pixel ${i / 4}`,
				);
			}
		};

		it("round-trips frames ending just below, at and above 512 / 1024 / 2048 entries", () => {
			// Noise yields roughly one code per pixel, so these lengths straddle each boundary.
			const rng = createRng(77);
			for (const center of [254, 766, 1790]) {
				for (let n = center - 24; n <= center + 24; n++)
					assertExactRoundTrip(cubeNoiseRow(rng, n));
			}
		});

		it("widens the end code when the decoder's dictionary reaches a power of two", () => {
			// Found by search: after two table resets this stream ends with 1024 entries and the
			// last data code ending on a byte boundary, so an end code written one bit too narrow
			// would be truncated rather than hidden by zero padding.
			assertExactRoundTrip(cubeNoiseRow(createRng(5), 8655));
		});
	});

	it("handles 1×1 and odd sizes", () => {
		for (const [width, height] of [
			[1, 1],
			[1, 7],
			[13, 1],
			[3, 5],
			[17, 11],
		]) {
			const gif = new GifEncoder(width, height);
			gif.addFrame(makeFrame(width, height, (x, y) => ((x + y) % 2 ? [255, 0, 0] : BG)));
			gif.addFrame(makeFrame(width, height));
			const decoded = decodeGif(gif.finish());
			assert.equal(decoded.width, width);
			assert.equal(decoded.height, height);
			assert.equal(decoded.frames.length, 2);
			for (let y = 0; y < height; y++) {
				for (let x = 0; x < width; x++) {
					const i = (y * width + x) * 4;
					const expected = (x + y) % 2 ? [255, 0, 0] : BG;
					assert.deepEqual([...decoded.frames[0].rgba.subarray(i, i + 3)], expected);
				}
			}
		}
	});

	it("rejects invalid dimensions and frames of the wrong length", () => {
		assert.throws(() => new GifEncoder(0, 10), RangeError);
		assert.throws(() => new GifEncoder(10.5, 10), RangeError);
		assert.throws(() => new GifEncoder(70000, 10), RangeError);
		const gif = new GifEncoder(4, 4);
		assert.throws(() => gif.addFrame(new Uint8ClampedArray(4 * 4 * 4 - 1)), RangeError);
		assert.throws(() => gif.addFrame(new Uint8Array(4 * 4 * 3)), RangeError);
		assert.equal(gif.frameCount, 0);
	});

	it("refuses frames after finish() and returns the same bytes again", () => {
		const gif = new GifEncoder(2, 2);
		gif.addFrame(makeFrame(2, 2));
		const bytes = gif.finish();
		assert.throws(() => gif.addFrame(makeFrame(2, 2)), /finish/);
		assert.equal(gif.finish(), bytes);
		assert.equal(gif.frameCount, 1);
		assert.equal(bytes[bytes.length - 1], 0x3b);
	});

	it("tracks byteLength as frames are added", () => {
		const gif = new GifEncoder(48, 30);
		const header = gif.byteLength;
		assert.ok(header >= 13 + 768, "header and palette are written up front");
		gif.addFrame(sceneFrame(48, 30, 1));
		const afterOne = gif.byteLength;
		assert.ok(afterOne > header);
		gif.addFrame(sceneFrame(48, 30, 2));
		assert.ok(gif.byteLength > afterOne);
		assert.equal(gif.finish().length, gif.byteLength);
	});

	it("encodes a 480×300 simulation frame quickly and compactly", () => {
		const width = 480;
		const height = 300;
		const frames = [1, 2, 3, 4].map((seed) => sceneFrame(width, height, seed));
		const gif = new GifEncoder(width, height);
		gif.addFrame(frames[0]); // warm-up
		let best = Infinity;
		for (const frame of frames.slice(1)) {
			const start = performance.now();
			gif.addFrame(frame);
			best = Math.min(best, performance.now() - start);
		}
		assert.ok(best < 50, `best frame took ${best.toFixed(1)} ms`);
		const bytes = gif.finish();
		assert.ok(bytes.length / 4 < 40_000, `average frame ${bytes.length / 4} bytes`);
		assert.equal(decodeGif(bytes).frames.length, 4);
	});
});
