import { isHexColor } from "./physics/color.js";
import { defaultSettings, sanitizeSettings } from "./settings.js";

/** @typedef {import('./settings.js').Settings} Settings */
/** @typedef {import('./physics/body.js').BodySpec} BodySpec */

/**
 * Everything needed to reproduce a simulation from a link.
 *
 * @typedef {object} SharedState
 * @property {Settings} settings
 * @property {{ x: number, y: number, zoom: number }} camera
 * @property {number} time
 * @property {Required<BodySpec>[] | null} bodies Exact bodies, or null when the link
 *   restarts a scenario instead (see `preset`).
 * @property {{ id: string, seed: number } | null} preset Scenario and random seed.
 */

/** URL hash parameter: `#s=<payload>`. */
export const SHARE_PARAM = "s";
/** Longest link we generate; beyond this only the scenario and seed are shared. */
export const MAX_SHARE_LENGTH = 48_000;
/** Bodies accepted from a link (guards against hostile, huge payloads). */
export const MAX_SHARED_BODIES = 20_000;
/**
 * Most bytes a link may decompress to: a full link of {@link MAX_SHARED_BODIES} is
 * about 1 MB, while a tiny hostile one could otherwise expand to gigabytes.
 */
export const MAX_UNPACKED_BYTES = 4_000_000;
const VALUES_PER_BODY = 6; // m, x, y, vx, vy, color index

/**
 * @param {number} value
 * @param {number} digits Decimal places.
 */
const round = (value, digits) => {
	const f = 10 ** digits;
	return Math.round(value * f) / f;
};

/**
 * Encodes a state as a compact URL-safe string. Positions/velocities are rounded
 * (to 0.01 and 0.001), so a shared run is visually identical but, being chaotic,
 * eventually diverges from the original.
 *
 * @param {SharedState} state
 * @param {{ maxLength?: number }} [options]
 * @returns {Promise<{ text: string, exact: boolean }>} `exact` is false when the
 *   bodies did not fit and the link restarts the scenario instead.
 */
export async function encodeShare(state, { maxLength = MAX_SHARE_LENGTH } = {}) {
	const defaults = /** @type {Record<string, unknown>} */ (defaultSettings());
	const settings = Object.fromEntries(
		Object.entries(state.settings).filter(([key, value]) => defaults[key] !== value),
	);
	const base = {
		v: 1,
		s: settings,
		c: [
			round(state.camera.x, 2),
			round(state.camera.y, 2),
			Number(state.camera.zoom.toPrecision(6)),
		],
		t: round(state.time, 3),
		p: state.preset ? [state.preset.id, state.preset.seed] : undefined,
	};

	if (state.bodies && state.bodies.length <= MAX_SHARED_BODIES) {
		/** @type {Map<string, number>} */
		const palette = new Map();
		const flat = [];
		for (const b of state.bodies) {
			let index = palette.get(b.color);
			if (index === undefined) {
				index = palette.size;
				palette.set(b.color, index);
			}
			flat.push(
				Number(b.m.toPrecision(8)),
				round(b.x, 2),
				round(b.y, 2),
				round(b.vx, 3),
				round(b.vy, 3),
				index,
			);
		}
		const text = await pack({ ...base, k: [...palette.keys()], b: flat });
		if (text.length <= maxLength || !state.preset) return { text, exact: true };
	}
	if (!state.preset) throw new RangeError("Nothing to share.");
	return { text: await pack(base), exact: false };
}

/**
 * Decodes and validates a payload from {@link encodeShare}. Never trusts the input:
 * settings are sanitized, numbers must be finite, sizes are capped.
 *
 * @param {string} text
 * @returns {Promise<SharedState>}
 */
export async function decodeShare(text) {
	const raw = await unpack(text);
	if (raw === null || typeof raw !== "object" || raw.v !== 1) {
		throw new Error("Unsupported share link.");
	}
	const settings = sanitizeSettings({ ...defaultSettings(), ...(isObject(raw.s) ? raw.s : {}) });

	const c = Array.isArray(raw.c) ? raw.c : [];
	const camera = {
		x: finiteOr(c[0], 0),
		y: finiteOr(c[1], 0),
		zoom: finiteOr(c[2], 1) > 0 ? finiteOr(c[2], 1) : 1,
	};

	/** @type {SharedState['preset']} */
	let preset = null;
	if (Array.isArray(raw.p) && typeof raw.p[0] === "string" && Number.isInteger(raw.p[1])) {
		preset = { id: raw.p[0], seed: raw.p[1] >>> 0 };
	}

	/** @type {Required<BodySpec>[] | null} */
	let bodies = null;
	if (Array.isArray(raw.b)) {
		const flat = raw.b;
		if (
			flat.length % VALUES_PER_BODY !== 0 ||
			flat.length / VALUES_PER_BODY > MAX_SHARED_BODIES
		) {
			throw new Error("Malformed share link.");
		}
		const colors = Array.isArray(raw.k) ? raw.k : [];
		bodies = [];
		for (let i = 0; i < flat.length; i += VALUES_PER_BODY) {
			const [m, x, y, vx, vy, ci] = flat.slice(i, i + VALUES_PER_BODY);
			if (
				![m, x, y, vx, vy].every((v) => typeof v === "number" && Number.isFinite(v)) ||
				!(m > 0)
			) {
				throw new Error("Malformed share link.");
			}
			const color = colors[ci];
			bodies.push({
				m,
				x,
				y,
				vx,
				vy,
				color: typeof color === "string" && isHexColor(color) ? color : settings.color,
			});
		}
	}
	if (!bodies && !preset) throw new Error("Malformed share link.");
	return { settings, camera, time: Math.max(0, finiteOr(raw.t, 0)), bodies, preset };
}

/**
 * Extracts the payload from a location hash such as `#s=z...`.
 *
 * @param {string} hash
 * @returns {string | null}
 */
export function readShareHash(hash) {
	const params = new URLSearchParams(hash.replace(/^#/, ""));
	return params.get(SHARE_PARAM);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function finiteOr(value, fallback) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------- encoding

/**
 * JSON → (deflate when supported) → base64url, prefixed with `z` (deflated) or `j`.
 *
 * @param {unknown} value
 */
async function pack(value) {
	const json = new TextEncoder().encode(JSON.stringify(value));
	if (typeof CompressionStream === "function") {
		return `z${toBase64Url(await transform(json, new CompressionStream("deflate-raw")))}`;
	}
	return `j${toBase64Url(json)}`;
}

/**
 * @param {string} text
 * @returns {Promise<any>}
 */
async function unpack(text) {
	if (text.length > 2 * MAX_SHARE_LENGTH) throw new Error("Share link is too long.");
	const kind = text[0];
	let bytes = fromBase64Url(text.slice(1));
	if (kind === "z") {
		if (typeof DecompressionStream !== "function") {
			throw new Error("This browser cannot open compressed share links.");
		}
		bytes = await inflate(bytes, MAX_UNPACKED_BYTES);
	} else if (kind !== "j") {
		throw new Error("Unsupported share link.");
	}
	return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Decompresses deflate-raw data, giving up as soon as it passes `limit` bytes.
 *
 * @param {Uint8Array} bytes
 * @param {number} limit
 */
async function inflate(bytes, limit) {
	const reader = new Blob([/** @type {BlobPart} */ (bytes)])
		.stream()
		.pipeThrough(new DecompressionStream("deflate-raw"))
		.getReader();
	/** @type {Uint8Array[]} */
	const parts = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > limit) {
			await reader.cancel();
			throw new Error("Share link is too large.");
		}
		parts.push(value);
	}
	const out = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {CompressionStream | DecompressionStream} stream
 */
async function transform(bytes, stream) {
	const output = new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(stream);
	return new Uint8Array(await new Response(output).arrayBuffer());
}

/** @param {Uint8Array} bytes */
function toBase64Url(bytes) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} text */
function fromBase64Url(text) {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error("Malformed share link.");
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
