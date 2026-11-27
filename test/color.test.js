import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	hslToHex,
	isHexColor,
	mixColors,
	parseHexColor,
	randomPastel,
	toHexColor,
} from "../src/physics/color.js";
import { createRng } from "../src/physics/rng.js";

describe("parseHexColor", () => {
	it("parses 6- and 3-digit colors with or without #", () => {
		assert.deepEqual(parseHexColor("#bbbb99"), { r: 0xbb, g: 0xbb, b: 0x99 });
		assert.deepEqual(parseHexColor("FF0080"), { r: 255, g: 0, b: 128 });
		assert.deepEqual(parseHexColor("#f08"), { r: 255, g: 0, b: 136 });
	});

	it("rejects anything else instead of crashing", () => {
		for (const bad of ["", "#12345", "rgb(1,2,3)", "#gggggg", "red"]) {
			assert.equal(parseHexColor(bad), null, bad);
			assert.equal(isHexColor(bad), false, bad);
		}
	});
});

describe("toHexColor", () => {
	it("round-trips and clamps", () => {
		assert.equal(toHexColor({ r: 255, g: 0, b: 128 }), "#ff0080");
		assert.equal(toHexColor({ r: 300, g: -5, b: 10.6 }), "#ff000b");
	});
});

describe("mixColors", () => {
	it("weights colors by mass", () => {
		assert.equal(
			mixColors([
				{ color: "#000000", weight: 3 },
				{ color: "#ffffff", weight: 1 },
			]),
			"#404040",
		);
	});

	it("ignores unparseable colors and falls back to the heaviest", () => {
		assert.equal(
			mixColors([
				{ color: "nope", weight: 10 },
				{ color: "#ff0000", weight: 1 },
			]),
			"#ff0000",
		);
		assert.equal(
			mixColors([
				{ color: "a", weight: 1 },
				{ color: "b", weight: 2 },
			]),
			"b",
		);
	});
});

describe("hslToHex / randomPastel", () => {
	it("converts primary hues", () => {
		assert.equal(hslToHex(0, 1, 0.5), "#ff0000");
		assert.equal(hslToHex(120, 1, 0.5), "#00ff00");
		assert.equal(hslToHex(240, 1, 0.5), "#0000ff");
		assert.equal(hslToHex(-120, 1, 0.5), "#0000ff");
	});

	it("produces valid, light colors", () => {
		const rng = createRng(1);
		for (let i = 0; i < 50; i++) {
			const rgb = parseHexColor(randomPastel(rng));
			assert.ok(rgb);
			assert.ok(Math.max(rgb.r, rgb.g, rgb.b) > 150);
		}
	});
});
