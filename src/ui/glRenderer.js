import { parseHexColor } from "../physics/color.js";
import { reprojection } from "./camera.js";

/** @typedef {import('../physics/body.js').Body} Body */
/** @typedef {import('./camera.js').Camera} Camera */
/** @typedef {import('./camera.js').CameraSnapshot} CameraSnapshot */

/** Bodies are never drawn smaller than this many CSS pixels. */
export const MIN_SCREEN_RADIUS = 0.8;
/** Bodies at least this heavy get a glow. */
export const GLOW_MASS = 1e6;
/** Opacity of the trail segment each frame adds; overlapping segments build up. */
const TRAIL_ALPHA = 0.5;
/** Movement longer than this (CSS px) between two frames is a jump, not motion. */
const MAX_STREAK = 150;

/**
 * Half-width (CSS px) of the trail left by a body of radius `r` (CSS px): a thin tail,
 * narrower than the body, never thinner than about a pixel.
 *
 * @param {number} r
 */
function trailHalfWidth(r) {
	return Math.min(Math.max(0.6, r * 0.5), 4);
}

/**
 * Per-instance floats: current x, y, previous x, y (device px from the screen centre,
 * y down), half-width (device px), r, g, b.
 */
const INSTANCE_FLOATS = 8;
/** With 8-bit trail textures, batch fades like the 2D renderer to avoid ghost trails. */
const MIN_FADE_8BIT = 0.08;
const GLOW_EXTENT = 4;

const ATTRIBUTES = { a_corner: 0, a_center: 1, a_previous: 2, a_radius: 3, a_color: 4 };

const QUAD_VS = `#version 300 es
in vec2 a_corner; // 0..1, origin top-left
uniform float u_scale;
uniform vec2 u_offset;
out vec2 v_uv;
void main() {
	vec2 p = a_corner * u_scale + u_offset;
	gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
	v_uv = vec2(a_corner.x, 1.0 - a_corner.y);
}`;

const TEXTURE_FS = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_texture;
out vec4 outColor;
void main() { outColor = vec4(texture(u_texture, v_uv).rgb, 1.0); }`;

const SOLID_FS = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`;

// A capsule from a_previous to a_center: a moving body's streak, or a plain disc when
// the two points coincide.
const CAPSULE_VS = `#version 300 es
in vec2 a_corner; // -1..1
in vec2 a_center;
in vec2 a_previous;
in float a_radius;
in vec3 a_color;
uniform vec2 u_halfViewport;
out vec2 v_position;
flat out vec2 v_from;
flat out vec2 v_to;
flat out float v_radius;
flat out vec3 v_color;
void main() {
	vec2 d = a_center - a_previous;
	float len = length(d);
	vec2 axis = len > 1e-3 ? d / len : vec2(1.0, 0.0);
	vec2 normal = vec2(-axis.y, axis.x);
	float pad = a_radius + 1.0;
	vec2 p = (a_center + a_previous) * 0.5
		+ axis * a_corner.x * (len * 0.5 + pad)
		+ normal * a_corner.y * pad;
	gl_Position = vec4(p.x / u_halfViewport.x, -p.y / u_halfViewport.y, 0.0, 1.0);
	v_position = p;
	v_from = a_previous;
	v_to = a_center;
	v_radius = a_radius;
	v_color = a_color;
}`;

const CAPSULE_FS = `#version 300 es
precision highp float;
in vec2 v_position;
flat in vec2 v_from;
flat in vec2 v_to;
flat in float v_radius;
flat in vec3 v_color;
uniform float u_alpha;
out vec4 outColor;
void main() {
	vec2 ab = v_to - v_from;
	float len2 = dot(ab, ab);
	float t = len2 > 0.0 ? clamp(dot(v_position - v_from, ab) / len2, 0.0, 1.0) : 0.0;
	float distance = length(v_position - (v_from + ab * t));
	float coverage = clamp(v_radius + 0.5 - distance, 0.0, 1.0);
	if (coverage <= 0.0) discard;
	outColor = vec4(v_color, coverage * u_alpha);
}`;

const GLOW_VS = `#version 300 es
in vec2 a_corner;
in vec2 a_center;
in float a_radius;
in vec3 a_color;
uniform vec2 u_halfViewport;
out vec2 v_local;
flat out float v_radius;
flat out vec3 v_color;
void main() {
	vec2 local = a_corner * (a_radius * ${GLOW_EXTENT.toFixed(1)} + 1.0);
	vec2 p = a_center + local;
	gl_Position = vec4(p.x / u_halfViewport.x, -p.y / u_halfViewport.y, 0.0, 1.0);
	v_local = local;
	v_radius = a_radius;
	v_color = a_color;
}`;

const GLOW_FS = `#version 300 es
precision mediump float;
in vec2 v_local;
flat in float v_radius;
flat in vec3 v_color;
out vec4 outColor;
void main() {
	float t = length(v_local) / (v_radius * ${GLOW_EXTENT.toFixed(1)});
	float a = 0.45 * exp(-t * t * 5.0) * (1.0 - smoothstep(0.8, 1.0, t));
	outColor = vec4(v_color * a, 0.0);
}`;

/** @typedef {'trail' | 'body' | 'glow'} InstanceMode */

/**
 * The renderer (WebGL 2). Trails are thin, translucent streaks accumulated in an
 * off-screen texture (half-float when available, so fading is exact and leaves no
 * ghosts); each frame the texture is composited and the bodies are drawn crisply on
 * top, followed by additive star glows.
 */
export class WebGLRenderer {
	/** @type {'webgl'} */
	kind = "webgl";
	lost = false;
	canvas;
	#gl;
	/** @type {[number, number, number]} */
	#background;
	#width = 1;
	#height = 1;
	#dpr = 1;
	#pendingSurvival = 1;
	#halfFloat;
	/** @type {{ texture: WebGLTexture, framebuffer: WebGLFramebuffer }[]} */
	#targets = [];
	#current = 0;
	#programs;
	#quadVao;
	#spriteVao;
	#instanceBuffer;
	#instances = new Float32Array(0);
	/** @type {Map<string, [number, number, number]>} */
	#colors = new Map();

	/**
	 * @param {HTMLCanvasElement} canvas A canvas without an existing context.
	 * @throws {Error} When WebGL 2 is unavailable.
	 * @param {string} background `#rrggbb`
	 */
	constructor(canvas, background) {
		const gl = canvas.getContext("webgl2", {
			alpha: false,
			antialias: false,
			depth: false,
			stencil: false,
			premultipliedAlpha: false,
			preserveDrawingBuffer: true, // needed for toBlob() and frame capture
		});
		if (!gl) throw new Error("WebGL 2 is not available.");
		this.canvas = canvas;
		this.#gl = gl;
		this.#background = toRgb(background);
		this.#halfFloat = !!gl.getExtension("EXT_color_buffer_float");

		canvas.addEventListener("webglcontextlost", (event) => {
			event.preventDefault();
			this.lost = true;
		});

		this.#programs = {
			texture: program(gl, QUAD_VS, TEXTURE_FS, ["u_scale", "u_offset", "u_texture"]),
			solid: program(gl, QUAD_VS, SOLID_FS, ["u_scale", "u_offset", "u_color"]),
			capsule: program(gl, CAPSULE_VS, CAPSULE_FS, ["u_halfViewport", "u_alpha"]),
			glow: program(gl, GLOW_VS, GLOW_FS, ["u_halfViewport"]),
		};

		// Full-screen quad (0..1).
		this.#quadVao = must(gl.createVertexArray());
		gl.bindVertexArray(this.#quadVao);
		bufferWith(gl, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
		gl.enableVertexAttribArray(ATTRIBUTES.a_corner);
		gl.vertexAttribPointer(ATTRIBUTES.a_corner, 2, gl.FLOAT, false, 0, 0);

		// Instanced sprites: a shared -1..1 quad plus per-instance attributes.
		this.#spriteVao = must(gl.createVertexArray());
		gl.bindVertexArray(this.#spriteVao);
		bufferWith(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
		gl.enableVertexAttribArray(ATTRIBUTES.a_corner);
		gl.vertexAttribPointer(ATTRIBUTES.a_corner, 2, gl.FLOAT, false, 0, 0);
		this.#instanceBuffer = must(gl.createBuffer());
		gl.bindBuffer(gl.ARRAY_BUFFER, this.#instanceBuffer);
		const stride = INSTANCE_FLOATS * 4;
		/** @type {[number, number, number][]} attribute, size, float offset */
		const layout = [
			[ATTRIBUTES.a_center, 2, 0],
			[ATTRIBUTES.a_previous, 2, 2],
			[ATTRIBUTES.a_radius, 1, 4],
			[ATTRIBUTES.a_color, 3, 5],
		];
		for (const [location, size, offset] of layout) {
			gl.enableVertexAttribArray(location);
			gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4);
			gl.vertexAttribDivisor(location, 1);
		}
		gl.bindVertexArray(null);
	}

	/**
	 * @param {number} width
	 * @param {number} height
	 * @param {number} dpr
	 */
	resize(width, height, dpr) {
		const gl = this.#gl;
		this.#width = width;
		this.#height = height;
		this.#dpr = dpr;
		this.canvas.width = Math.max(1, Math.round(width * dpr));
		this.canvas.height = Math.max(1, Math.round(height * dpr));
		for (const target of this.#targets) {
			gl.deleteTexture(target.texture);
			gl.deleteFramebuffer(target.framebuffer);
		}
		this.#targets = [this.#createTarget(), this.#createTarget()];
		this.#current = 0;
		this.clearTrails();
	}

	/** @returns {{ texture: WebGLTexture, framebuffer: WebGLFramebuffer }} */
	#createTarget() {
		const gl = this.#gl;
		const { width, height } = this.canvas;
		const texture = must(gl.createTexture());
		gl.bindTexture(gl.TEXTURE_2D, texture);
		if (this.#halfFloat) {
			gl.texImage2D(
				gl.TEXTURE_2D,
				0,
				gl.RGBA16F,
				width,
				height,
				0,
				gl.RGBA,
				gl.HALF_FLOAT,
				null,
			);
		} else {
			gl.texImage2D(
				gl.TEXTURE_2D,
				0,
				gl.RGBA8,
				width,
				height,
				0,
				gl.RGBA,
				gl.UNSIGNED_BYTE,
				null,
			);
		}
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		const framebuffer = must(gl.createFramebuffer());
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
			gl.deleteTexture(texture);
			gl.deleteFramebuffer(framebuffer);
			if (this.#halfFloat) {
				// Half-float targets advertised but unusable: fall back to 8-bit.
				this.#halfFloat = false;
				return this.#createTarget();
			}
			throw new Error("Could not create a WebGL framebuffer.");
		}
		return { texture, framebuffer };
	}

	/** @param {number} index */
	#bindTarget(index) {
		const gl = this.#gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.#targets[index].framebuffer);
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
	}

	/**
	 * Changes the color of empty space. Trails are wiped: they were drawn over the old
	 * color, which would otherwise linger wherever they never fade.
	 *
	 * @param {string} background `#rrggbb`
	 */
	setBackground(background) {
		this.#background = toRgb(background);
		this.clearTrails();
	}

	clearTrails() {
		if (this.lost) return;
		const gl = this.#gl;
		for (let i = 0; i < this.#targets.length; i++) {
			this.#bindTarget(i);
			gl.clearColor(...this.#background, 1);
			gl.clear(gl.COLOR_BUFFER_BIT);
		}
		this.#pendingSurvival = 1;
	}

	/**
	 * @param {CameraSnapshot} from
	 * @param {CameraSnapshot} to
	 */
	reproject(from, to) {
		if (this.lost) return;
		const gl = this.#gl;
		const { k, e, f } = reprojection(from, to, this.#width, this.#height);
		const source = this.#targets[this.#current];
		const next = 1 - this.#current;
		this.#bindTarget(next);
		gl.clearColor(...this.#background, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.disable(gl.BLEND);
		this.#drawTexture(source.texture, k, e / this.#width, f / this.#height);
		this.#current = next;
	}

	/**
	 * @param {WebGLTexture} texture
	 * @param {number} scale
	 * @param {number} offsetX Normalised (fraction of the width).
	 * @param {number} offsetY
	 */
	#drawTexture(texture, scale, offsetX, offsetY) {
		const gl = this.#gl;
		const p = this.#programs.texture;
		gl.useProgram(p.program);
		gl.uniform1f(p.uniforms.u_scale, scale);
		gl.uniform2f(p.uniforms.u_offset, offsetX, offsetY);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.uniform1i(p.uniforms.u_texture, 0);
		gl.bindVertexArray(this.#quadVao);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	/** @param {number} survival */
	fade(survival) {
		if (this.lost) return;
		this.#pendingSurvival *= survival;
		const alpha = 1 - this.#pendingSurvival;
		if (alpha <= 0 || (!this.#halfFloat && alpha < MIN_FADE_8BIT)) return;
		const gl = this.#gl;
		this.#bindTarget(this.#current);
		this.#blendOver();
		const p = this.#programs.solid;
		gl.useProgram(p.program);
		gl.uniform1f(p.uniforms.u_scale, 1);
		gl.uniform2f(p.uniforms.u_offset, 0, 0);
		gl.uniform4f(p.uniforms.u_color, ...this.#background, alpha);
		gl.bindVertexArray(this.#quadVao);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		this.#pendingSurvival = 1;
	}

	/** Normal alpha blending for colour; the target's alpha stays at 1. */
	#blendOver() {
		const gl = this.#gl;
		gl.enable(gl.BLEND);
		gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE);
	}

	/**
	 * Adds this frame's motion (previous → current position) to the trails.
	 *
	 * @param {ReadonlyArray<Body>} bodies
	 * @param {Camera} camera
	 */
	drawTrails(bodies, camera) {
		if (this.lost) return;
		const count = this.#upload(bodies, camera, "trail");
		if (count === 0) return;
		this.#bindTarget(this.#current);
		this.#blendOver();
		this.#drawCapsules(count, TRAIL_ALPHA);
	}

	/**
	 * Composites the trails, then draws the bodies and their glows on top.
	 *
	 * @param {ReadonlyArray<Body>} bodies
	 * @param {Camera} camera
	 */
	present(bodies, camera) {
		if (this.lost) return;
		const gl = this.#gl;
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.viewport(0, 0, this.canvas.width, this.canvas.height);
		gl.disable(gl.BLEND);
		this.#drawTexture(this.#targets[this.#current].texture, 1, 0, 0);

		const count = this.#upload(bodies, camera, "body");
		if (count > 0) {
			this.#blendOver();
			this.#drawCapsules(count, 1);
		}
		const glows = this.#upload(bodies, camera, "glow");
		if (glows > 0) {
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE);
			const p = this.#programs.glow;
			gl.useProgram(p.program);
			gl.uniform2f(p.uniforms.u_halfViewport, this.canvas.width / 2, this.canvas.height / 2);
			gl.bindVertexArray(this.#spriteVao);
			gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glows);
		}
	}

	/**
	 * @param {number} count
	 * @param {number} alpha
	 */
	#drawCapsules(count, alpha) {
		const gl = this.#gl;
		const p = this.#programs.capsule;
		gl.useProgram(p.program);
		gl.uniform2f(p.uniforms.u_halfViewport, this.canvas.width / 2, this.canvas.height / 2);
		gl.uniform1f(p.uniforms.u_alpha, alpha);
		gl.bindVertexArray(this.#spriteVao);
		gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
	}

	/**
	 * Fills the instance buffer. Positions are made camera-relative in float64 on the CPU
	 * so float32 on the GPU never loses precision far from the origin.
	 *
	 * @param {ReadonlyArray<Body>} bodies
	 * @param {Camera} camera
	 * @param {InstanceMode} mode
	 * @returns {number} Instances written.
	 */
	#upload(bodies, camera, mode) {
		const gl = this.#gl;
		if (this.#instances.length < bodies.length * INSTANCE_FLOATS) {
			this.#instances = new Float32Array(Math.max(1024, bodies.length * 2) * INSTANCE_FLOATS);
		}
		const out = this.#instances;
		const dpr = this.#dpr;
		const scale = camera.zoom * dpr;
		const minRadius = MIN_SCREEN_RADIUS * dpr;
		const maxStreak = MAX_STREAK * dpr;
		const halfW = this.canvas.width / 2;
		const halfH = this.canvas.height / 2;
		let count = 0;
		for (const b of bodies) {
			if (mode === "glow" && b.m < GLOW_MASS) continue;
			const bodyRadius = Math.max(b.r * scale, minRadius);
			const cx = (b.x - camera.x) * scale;
			const cy = (b.y - camera.y) * scale;
			let px = cx;
			let py = cy;
			let radius = bodyRadius;
			if (mode === "trail") {
				px = ((b.lx ?? b.x) - camera.x) * scale;
				py = ((b.ly ?? b.y) - camera.y) * scale;
				// A huge jump (teleport, merge) is not motion: don't streak across the screen.
				if (Math.hypot(cx - px, cy - py) > maxStreak) {
					px = cx;
					py = cy;
				}
				radius = trailHalfWidth(bodyRadius / dpr) * dpr;
			}
			const reach = (mode === "glow" ? bodyRadius * GLOW_EXTENT : radius) + 1;
			if (
				Math.max(cx, px) + reach < -halfW ||
				Math.min(cx, px) - reach > halfW ||
				Math.max(cy, py) + reach < -halfH ||
				Math.min(cy, py) - reach > halfH
			) {
				continue;
			}
			const [r, g, bl] = this.#rgb(b.color);
			const o = count * INSTANCE_FLOATS;
			out[o] = cx;
			out[o + 1] = cy;
			out[o + 2] = px;
			out[o + 3] = py;
			out[o + 4] = radius;
			out[o + 5] = r;
			out[o + 6] = g;
			out[o + 7] = bl;
			count++;
		}
		if (count > 0) {
			gl.bindBuffer(gl.ARRAY_BUFFER, this.#instanceBuffer);
			gl.bufferData(
				gl.ARRAY_BUFFER,
				out.subarray(0, count * INSTANCE_FLOATS),
				gl.DYNAMIC_DRAW,
			);
		}
		return count;
	}

	/**
	 * @param {string} color
	 * @returns {[number, number, number]}
	 */
	#rgb(color) {
		let rgb = this.#colors.get(color);
		if (!rgb) {
			const parsed = parseHexColor(color) ?? { r: 255, g: 255, b: 255 };
			rgb = [parsed.r / 255, parsed.g / 255, parsed.b / 255];
			this.#colors.set(color, rgb);
		}
		return rgb;
	}

	/** @returns {Promise<Blob | null>} */
	toBlob() {
		return new Promise((resolve) => this.canvas.toBlob(resolve, "image/png"));
	}

	dispose() {
		this.#gl.getExtension("WEBGL_lose_context")?.loseContext();
		this.lost = true;
	}
}

/**
 * @template T
 * @param {T | null} value
 * @returns {T}
 */
function must(value) {
	if (value === null) throw new Error("WebGL resource allocation failed.");
	return value;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {Float32Array} data
 */
function bufferWith(gl, data) {
	const buffer = must(gl.createBuffer());
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
	return buffer;
}

/**
 * @template {string} U
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertexSource
 * @param {string} fragmentSource
 * @param {U[]} uniformNames
 */
function program(gl, vertexSource, fragmentSource, uniformNames) {
	const compile = (/** @type {number} */ type, /** @type {string} */ source) => {
		const shader = must(gl.createShader(type));
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(shader)}`);
		}
		return shader;
	};
	const p = must(gl.createProgram());
	gl.attachShader(p, compile(gl.VERTEX_SHADER, vertexSource));
	gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragmentSource));
	for (const [name, location] of Object.entries(ATTRIBUTES)) {
		gl.bindAttribLocation(p, location, name);
	}
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
		throw new Error(`Shader link failed: ${gl.getProgramInfoLog(p)}`);
	}
	/** @type {Record<U, WebGLUniformLocation | null>} */
	const uniforms = /** @type {any} */ ({});
	for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(p, name);
	return { program: p, uniforms };
}

/**
 * @param {string} hex `#rrggbb`
 * @returns {[number, number, number]} Components in 0..1 (black if invalid).
 */
function toRgb(hex) {
	const rgb = parseHexColor(hex) ?? { r: 0, g: 0, b: 0 };
	return [rgb.r / 255, rgb.g / 255, rgb.b / 255];
}
