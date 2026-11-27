/** @typedef {{ r: number, g: number, b: number }} Rgb */

const HEX_COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Parses `#rgb` or `#rrggbb` (leading `#` optional).
 *
 * @param {string} hex
 * @returns {Rgb | null} `null` when the string is not a hex color.
 */
export function parseHexColor(hex) {
	const match = HEX_COLOR.exec(String(hex).trim());
	if (!match) return null;
	let digits = match[1];
	if (digits.length === 3) {
		digits = digits
			.split("")
			.map((c) => c + c)
			.join("");
	}
	const value = Number.parseInt(digits, 16);
	return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/** @param {string} hex */
export function isHexColor(hex) {
	return parseHexColor(hex) !== null;
}

/**
 * @param {Rgb} rgb Channels are rounded and clamped to 0..255.
 * @returns {string} `#rrggbb`
 */
export function toHexColor({ r, g, b }) {
	const channel = (/** @type {number} */ c) =>
		Math.min(255, Math.max(0, Math.round(c)))
			.toString(16)
			.padStart(2, "0");
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Weighted average of colors (e.g. weighted by mass when bodies merge).
 * Unparseable colors are ignored; if none parse, the heaviest entry's color is returned.
 *
 * @param {ReadonlyArray<{ color: string, weight: number }>} entries
 * @returns {string}
 */
export function mixColors(entries) {
	let r = 0;
	let g = 0;
	let b = 0;
	let total = 0;
	let heaviest = entries[0];
	for (const entry of entries) {
		if (entry.weight > heaviest.weight) heaviest = entry;
		const rgb = parseHexColor(entry.color);
		if (!rgb || !(entry.weight > 0)) continue;
		r += rgb.r * entry.weight;
		g += rgb.g * entry.weight;
		b += rgb.b * entry.weight;
		total += entry.weight;
	}
	if (total === 0) return heaviest?.color ?? "#ffffff";
	return toHexColor({ r: r / total, g: g / total, b: b / total });
}

/**
 * @param {number} h Hue in degrees.
 * @param {number} s Saturation 0..1.
 * @param {number} l Lightness 0..1.
 * @returns {string} `#rrggbb`
 */
export function hslToHex(h, s, l) {
	const hue = (((h % 360) + 360) % 360) / 360;
	const k = (/** @type {number} */ n) => (n + hue * 12) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (/** @type {number} */ n) =>
		l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return toHexColor({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
}

/**
 * A pleasant, light color suitable for a dark background.
 *
 * @param {() => number} rng
 */
export function randomPastel(rng) {
	return hslToHex(rng() * 360, 0.55 + rng() * 0.3, 0.68 + rng() * 0.12);
}
