import { GifEncoder } from "./gif.js";

/** GIF frames per second (higher makes much bigger files). */
const GIF_FPS = 10;
const GIF_MAX_WIDTH = 480;
/** GIF stops growing after this long or this many bytes; the video keeps going. */
const GIF_MAX_SECONDS = 30;
const GIF_MAX_BYTES = 20 * 1024 * 1024;
/** Recording stops automatically after this long. */
export const MAX_RECORDING_SECONDS = 120;
const VIDEO_TYPES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];

/**
 * @typedef {object} Recording
 * @property {Blob | null} video WebM or MP4, when MediaRecorder is supported.
 * @property {Blob | null} gif
 * @property {number} seconds
 * @property {boolean} gifTruncated The GIF stopped early to stay a reasonable size.
 */

/**
 * Records the simulation canvas as a video (MediaRecorder) and, in parallel, as an
 * animated GIF sampled at {@link GIF_FPS}.
 */
export class Recorder {
	/** @type {HTMLCanvasElement | null} */
	#source = null;
	/** @type {MediaRecorder | null} */
	#media = null;
	/** @type {Blob[]} */
	#chunks = [];
	/** @type {GifEncoder | null} */
	#gif = null;
	#gifTruncated = false;
	#gifCanvas = document.createElement("canvas");
	#lastGifFrame = -Infinity;
	#startedAt = 0;

	/** The best supported video MIME type, or null without MediaRecorder support. */
	static videoType() {
		if (typeof MediaRecorder === "undefined") return null;
		return VIDEO_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
	}

	get recording() {
		return this.#source !== null;
	}

	/** Seconds since recording started. */
	get seconds() {
		return this.recording ? (performance.now() - this.#startedAt) / 1000 : 0;
	}

	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {[number, number, number]} background RGB of empty space (exact in the GIF palette).
	 */
	start(canvas, background) {
		if (this.recording) return;
		this.#source = canvas;
		this.#startedAt = performance.now();
		this.#lastGifFrame = -Infinity;
		this.#gifTruncated = false;
		// This recording's chunks, even if another starts before its last one arrives.
		/** @type {Blob[]} */
		const chunks = [];
		this.#chunks = chunks;

		const type = Recorder.videoType();
		if (type && typeof canvas.captureStream === "function") {
			const media = new MediaRecorder(canvas.captureStream(60), {
				mimeType: type,
				videoBitsPerSecond: 8_000_000,
			});
			media.addEventListener("dataavailable", (e) => {
				if (e.data.size > 0) chunks.push(e.data);
			});
			media.start(1000);
			this.#media = media;
		}

		const scale = Math.min(1, GIF_MAX_WIDTH / canvas.width);
		this.#gifCanvas.width = Math.max(1, Math.round(canvas.width * scale));
		this.#gifCanvas.height = Math.max(1, Math.round(canvas.height * scale));
		this.#gif = new GifEncoder(this.#gifCanvas.width, this.#gifCanvas.height, {
			delayMs: 1000 / GIF_FPS,
			background,
		});
	}

	/**
	 * Call once per rendered frame, after drawing. Samples a GIF frame when due.
	 *
	 * @param {number} now `performance.now()`
	 */
	captureFrame(now) {
		const source = this.#source;
		const gif = this.#gif;
		if (!source || !gif || now - this.#lastGifFrame < 1000 / GIF_FPS) return;
		this.#lastGifFrame = now;
		if (this.seconds > GIF_MAX_SECONDS || gif.byteLength > GIF_MAX_BYTES) {
			this.#gifTruncated = true;
			return;
		}
		const ctx = this.#gifCanvas.getContext("2d", { willReadFrequently: true });
		if (!ctx) return;
		const { width, height } = this.#gifCanvas;
		ctx.drawImage(source, 0, 0, width, height);
		gif.addFrame(ctx.getImageData(0, 0, width, height).data);
	}

	/**
	 * Ends the recording. It counts as stopped straight away (so `recording` is false
	 * and a second call does nothing), though the video may take a moment to finish.
	 *
	 * @returns {Promise<Recording | null>} Null if it wasn't recording.
	 */
	async stop() {
		if (!this.recording) return null;
		const seconds = this.seconds;
		const media = this.#media;
		const chunks = this.#chunks;
		const encoder = this.#gif;
		const gifTruncated = this.#gifTruncated;
		this.#source = null;
		this.#media = null;
		this.#gif = null;
		this.#chunks = [];

		const gif =
			encoder && encoder.frameCount > 0
				? new Blob([/** @type {BlobPart} */ (encoder.finish())], { type: "image/gif" })
				: null;
		/** @type {Blob | null} */
		let video = null;
		if (media && media.state !== "inactive") {
			await new Promise((resolve) => {
				media.addEventListener("stop", resolve, { once: true });
				media.stop();
			});
			video = new Blob(chunks, { type: media.mimeType });
		}
		return { video, gif, seconds, gifTruncated };
	}
}
