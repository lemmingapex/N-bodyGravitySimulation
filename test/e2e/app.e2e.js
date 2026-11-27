// End-to-end smoke tests in a real browser (desktop and emulated phone).
// Run with `npm run test:e2e`. Uses Playwright's bundled Chromium if installed
// (`npx playwright-core install chromium`), otherwise the local Google Chrome.
// Set SCREENSHOT_DIR to save screenshots for manual review.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium, devices } from "playwright-core";
import { startServer } from "../../scripts/serve.js";

/** @typedef {import('playwright-core').Page} Page */
/** @typedef {import('playwright-core').Browser} Browser */

/** @type {{ url: string, close: () => Promise<void> }} */
let server;
/** @type {Browser} */
let browser;

async function launchBrowser() {
	try {
		return await chromium.launch();
	} catch {
		return chromium.launch({ channel: "chrome" });
	}
}

before(async () => {
	server = await startServer({ port: 0 });
	browser = await launchBrowser();
});

after(async () => {
	await browser?.close();
	await server?.close();
});

/**
 * Opens the app in a fresh context and collects page errors (including CSP violations).
 *
 * @param {import('playwright-core').BrowserContextOptions} [options]
 * @param {string} [path]
 */
async function openApp(options, path = "") {
	const context = await browser.newContext(options);
	const page = await context.newPage();
	/** @type {string[]} */
	const errors = [];
	page.on("pageerror", (e) => errors.push(e.message.slice(0, 300)));
	page.on("console", (m) => {
		if (m.type() === "error") errors.push(m.text().slice(0, 300));
	});
	await page.goto(server.url + path);
	await page.waitForFunction(() => /** @type {any} */ (window).nbody?.client.bodies.length > 0);
	return { page, context, errors };
}

/**
 * @param {Page} page
 * @param {string} name
 */
async function screenshot(page, name) {
	const dir = process.env.SCREENSHOT_DIR;
	if (!dir) return;
	mkdirSync(dir, { recursive: true });
	await page.screenshot({ path: join(dir, `${name}.png`) });
}

/** @param {Page} page */
const bodyCount = (page) =>
	page.evaluate(() => /** @type {any} */ (window).nbody.client.bodies.length);

/**
 * Physics runs asynchronously (in a worker), so wait for the mirror to catch up.
 *
 * @param {Page} page
 * @param {number} expected
 */
async function waitForBodies(page, expected) {
	try {
		await page.waitForFunction(
			(n) => /** @type {any} */ (window).nbody.client.bodies.length === n,
			expected,
			{ timeout: 5000 },
		);
	} catch {
		assert.equal(await bodyCount(page), expected);
	}
}

/** @param {Page} page */
async function pauseAndClear(page) {
	await page.evaluate(() => {
		const app = /** @type {any} */ (window).nbody;
		if (!app.paused) app.togglePause();
		app.clear();
	});
	await waitForBodies(page, 0);
}

describe("desktop", () => {
	it("runs physics in a worker, renders with WebGL, and logs no errors", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		await page.waitForTimeout(1500);
		await screenshot(page, "desktop");

		const state = await page.evaluate(() => {
			const a = /** @type {any} */ (window).nbody;
			return { mode: a.client.mode, renderer: a.renderer.kind, steps: a.client.steps };
		});
		assert.equal(state.mode, "worker");
		assert.equal(state.renderer, "webgl");
		assert.ok(state.steps > 30, `steps ${state.steps}`);

		const hud = await page.locator("#stat-bodies").textContent();
		assert.ok(Number(hud?.replace(/\D/g, "")) > 0, `HUD body count: ${hud}`);

		// The stats panel keeps its size while the numbers change.
		const sizes = new Set();
		for (let i = 0; i < 4; i++) {
			const box = await page.locator("#hud").boundingBox();
			sizes.add(`${box?.width}x${box?.height}`);
			await page.waitForTimeout(300); // the HUD refreshes every 250 ms
		}
		assert.equal(sizes.size, 1, `HUD resized: ${[...sizes].join(", ")}`);
		assert.ok(await page.locator("#settings-panel").isVisible(), "settings visible on desktop");

		// The rendered image should contain more than the background color.
		const litPixels = await page.evaluate(async () => {
			const blob = await /** @type {any} */ (window).nbody.renderer.toBlob();
			const bitmap = await createImageBitmap(blob);
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
			ctx.drawImage(bitmap, 0, 0);
			const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
			let lit = 0;
			for (let i = 0; i < data.length; i += 16) if (data[i] > 60) lit++;
			return lit;
		});
		assert.ok(litPixels > 50, `lit pixels: ${litPixels}`);
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("click, slingshot drag and the scenario tool create bodies; right-drag pans", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		await pauseAndClear(page);

		await page.mouse.click(500, 500);
		await waitForBodies(page, 1);

		/** Press at (600, y), drag 100 px to the right, release; returns the new body. */
		const dragRight = async (/** @type {number} */ y, /** @type {number} */ expected) => {
			await page.mouse.move(600, y);
			await page.mouse.down();
			await page.mouse.move(650, y, { steps: 5 });
			await page.mouse.move(700, y, { steps: 5 });
			await page.screenshot(); // let a frame render the aim overlay
			await page.mouse.up();
			await waitForBodies(page, expected);
			return page.evaluate(() => /** @type {any} */ (window).nbody.client.bodies.at(-1));
		};
		const zoom = await page.evaluate(() => /** @type {any} */ (window).nbody.camera.zoom);

		// Slingshot: pulling back to the right launches to the left.
		const slung = await dragRight(500, 2);
		assert.ok(Math.abs(slung.vx + 100 / zoom) < 1e-6, `slingshot vx ${slung.vx}`);

		// Right-drag pans the view (whatever the tool) and adds nothing.
		const cameraAt = () =>
			page.evaluate(() => {
				const { camera } = /** @type {any} */ (window).nbody;
				return { x: camera.x, y: camera.y };
			});
		const start = await cameraAt();
		await page.mouse.move(300, 300);
		await page.mouse.down({ button: "right" });
		await page.mouse.move(380, 340, { steps: 5 });
		await page.mouse.up({ button: "right" });
		const end = await cameraAt();
		assert.ok(Math.abs(start.x - end.x - 80 / zoom) < 1e-6, `panned x ${end.x}`);
		assert.ok(Math.abs(start.y - end.y - 40 / zoom) < 1e-6, `panned y ${end.y}`);
		await page.waitForTimeout(200);
		assert.equal(
			await page.evaluate(() => /** @type {any} */ (window).nbody.client.bodies.length),
			2,
		);

		// The toolbar picker chooses the scenario (and selects the scenario tool); then a
		// click drops in a copy of it (figure-8: three stars).
		const picker = page.locator("#scenario-picker");
		assert.ok(await picker.isVisible(), "picker is in the toolbar on desktop");
		await picker.selectOption("figure8");
		const chosen = await page.evaluate(() => {
			const { settings } = /** @type {any} */ (window).nbody;
			return [settings.addScenario, settings.tool];
		});
		assert.deepEqual(chosen, ["figure8", "scenario"]);
		await page.mouse.click(400, 400);
		await waitForBodies(page, 2 + 3);
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("clicking a body inspects it; Delete removes it", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		await pauseAndClear(page);
		await page.mouse.click(640, 400); // adds a planet
		await waitForBodies(page, 1);
		await page.mouse.click(642, 401); // clicks on it
		await page.locator("#inspector").waitFor({ state: "visible" });
		assert.match((await page.locator("#inspector-title").textContent()) ?? "", /Body #\d+/);
		await screenshot(page, "inspector");

		await page.locator("#inspector-follow").click();
		assert.equal(
			await page.evaluate(() => /** @type {any} */ (window).nbody.settings.follow),
			"selected",
		);

		await page.keyboard.press("Delete");
		await waitForBodies(page, 0);
		assert.ok(!(await page.locator("#inspector").isVisible()));
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("keyboard shortcuts load scenarios, clear, zoom and open help", async () => {
		const { page, context } = await openApp({ viewport: { width: 1280, height: 800 } });
		await page.locator("#stage").focus();

		await page.keyboard.press("5");
		await waitForBodies(page, 3); // figure-eight
		assert.equal(
			await page.evaluate(
				() =>
					/** @type {any} */ (window).nbody.settings.mergeChance +
					/** @type {any} */ (window).nbody.settings.bounceChance,
			),
			0,
		);

		await page.keyboard.press(" "); // pause: nothing fades any more
		await page.keyboard.press("c");
		await waitForBodies(page, 0);
		await page.waitForTimeout(200);
		const ghosts = await page.evaluate(async () => {
			const blob = await /** @type {any} */ (window).nbody.renderer.toBlob();
			const bitmap = await createImageBitmap(blob);
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
			ctx.drawImage(bitmap, 0, 0);
			const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
			let lit = 0;
			for (let i = 0; i < data.length; i += 4) if (data[i] > 60) lit++;
			return lit;
		});
		assert.equal(ghosts, 0, "clearing while paused must not leave stale bodies on screen");
		await page.keyboard.press(" ");

		const zoomBefore = await page.evaluate(() => /** @type {any} */ (window).nbody.camera.zoom);
		await page.mouse.move(640, 400);
		await page.mouse.wheel(0, -300);
		const zoomAfter = await page.evaluate(() => /** @type {any} */ (window).nbody.camera.zoom);
		assert.ok(zoomAfter > zoomBefore, `${zoomBefore} -> ${zoomAfter}`);

		await page.keyboard.press("?");
		assert.ok(await page.locator("#help").isVisible());
		await screenshot(page, "help");
		await page.keyboard.press("Escape");
		assert.ok(!(await page.locator("#help").isVisible()));

		await page.keyboard.press(" ");
		assert.equal(await page.evaluate(() => /** @type {any} */ (window).nbody.paused), true);
		assert.equal(
			await page.locator('[data-action="pause"]').getAttribute("aria-pressed"),
			"true",
		);
		await context.close();
	});

	it("Space pauses whichever control has focus, without activating it", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		const state = () =>
			page.evaluate(() => {
				const app = /** @type {any} */ (window).nbody;
				return {
					paused: app.paused,
					preview: app.settings.showPreview,
					tool: app.settings.tool,
				};
			});

		// Clicking the pause button leaves it focused; Space must toggle exactly once.
		await page.locator('[data-action="pause"]').click();
		assert.equal((await state()).paused, true);
		await page.keyboard.press(" ");
		assert.equal((await state()).paused, false);

		// A focused tool button: Space pauses and doesn't switch tools.
		await page.locator('[data-tool="pan"]').click();
		await page.keyboard.press(" ");
		assert.deepEqual(await state(), { paused: true, preview: true, tool: "pan" });

		// The toolbar dropdown and a settings checkbox.
		await page.locator("#scenario-picker").focus();
		await page.keyboard.press(" ");
		assert.equal((await state()).paused, false);
		const checkbox = page.getByRole("checkbox", { name: "Trajectory preview" });
		await checkbox.click();
		assert.equal((await state()).preview, false);
		await page.keyboard.press(" ");
		assert.deepEqual(await state(), { paused: true, preview: false, tool: "pan" });

		// Other shortcuts work there too.
		await page.keyboard.press("p");
		assert.equal((await state()).tool, "planet");
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("starts sound on the first click, and the sound button mutes it", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		const playing = () => page.evaluate(() => /** @type {any} */ (window).nbody.sound.playing);
		assert.equal(await playing(), false, "browsers need a gesture first");
		await page.mouse.click(1100, 150); // adds a planet: a gesture, and a launch sound
		await page.waitForFunction(() => /** @type {any} */ (window).nbody.sound.playing);

		const button = page.locator('#hud [data-action="sound"]');
		assert.equal(await button.getAttribute("aria-pressed"), "true");
		await button.click();
		assert.equal(await button.getAttribute("aria-pressed"), "false");
		await page.waitForFunction(() => !(/** @type {any} */ (window).nbody.sound.playing));
		await page.keyboard.press("a");
		await page.waitForFunction(() => /** @type {any} */ (window).nbody.sound.playing);
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("shows the Barnes–Hut quadtree when asked", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		await page.evaluate(() => /** @type {any} */ (window).nbody.loadPreset("galaxies"));
		const toggle = page.getByRole("checkbox", { name: "Show quadtree" });
		assert.ok(await toggle.isVisible(), "offered with the Barnes–Hut solver");
		await toggle.click();
		await page.waitForFunction(
			() => /** @type {any} */ (window).nbody.client.quadTree?.length > 3 * 100,
		);
		await screenshot(page, "quadtree");
		await page.evaluate(() =>
			/** @type {any} */ (window).nbody.setSettings({ solver: "direct" }),
		);
		assert.ok(!(await toggle.isVisible()), "hidden with the direct solver");
		await page.waitForFunction(
			() => /** @type {any} */ (window).nbody.client.quadTree === null,
		);
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("collision chances stay within 1 in the panel and show what passes through", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		/** @param {string} name */
		const row = (name) =>
			page.locator("#settings-panel .lil-controller").filter({
				has: page.locator(".lil-name", { hasText: new RegExp(`^${name}$`) }),
			});
		/** @param {string} name @param {string} value */
		const type = async (name, value) => {
			const input = row(name).locator("input");
			await input.fill(value);
			await input.press("Enter");
		};
		const read = async (/** @type {string} */ name) =>
			Number(await row(name).locator("input").inputValue());

		assert.ok(!(await row("Bounciness").isVisible()), "no bounces, no bounciness");
		await type("Bounce chance", "0.4");
		assert.deepEqual(
			[await read("Merge chance"), await read("Bounce chance"), await read("Pass through")],
			[0.6, 0.4, 0],
		);
		assert.ok(await row("Bounciness").isVisible());
		await type("Merge chance", "0.25");
		assert.deepEqual(
			[await read("Merge chance"), await read("Bounce chance"), await read("Pass through")],
			[0.25, 0.4, 0.35],
		);
		const settings = await page.evaluate(() => {
			const s = /** @type {any} */ (window).nbody.settings;
			return [s.mergeChance, s.bounceChance];
		});
		assert.deepEqual(settings, [0.25, 0.4]);
		await screenshot(page, "collision-chances");
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("explains every setting and control on hover", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		const rows = await page.locator("#settings-panel .lil-controller").count();
		assert.ok(rows > 20, `found ${rows} settings rows`);
		const untitled = await page.evaluate(() => [
			...[...document.querySelectorAll("#settings-panel .lil-controller")]
				.filter((c) => !c.getAttribute("title"))
				.map((c) => c.querySelector(".lil-name")?.textContent),
			...[...document.querySelectorAll("#toolbar button, #toolbar select, #hud button")]
				.filter((c) => !c.getAttribute("title"))
				.map((c) => c.outerHTML.slice(0, 60)),
			...[...document.querySelectorAll("#hud dt")]
				.filter((dt) => !dt.querySelector("abbr[title]"))
				.map((dt) => dt.textContent),
		]);
		assert.deepEqual(untitled, []);

		// Scenario dropdowns describe the scenario they show.
		await page.evaluate(() => /** @type {any} */ (window).nbody.loadPreset("star"));
		await waitForBodies(page, 1);
		const presetTitle = await page.evaluate(
			() =>
				[...document.querySelectorAll("#settings-panel .lil-controller")]
					.find((c) => c.querySelector(".lil-name")?.textContent === "Scenario")
					?.getAttribute("title") ?? "",
		);
		assert.match(presetTitle, /single Sun-like star/);
		await page.locator("#scenario-picker").selectOption("binary");
		assert.match(
			(await page.locator("#scenario-picker").getAttribute("title")) ?? "",
			/circumbinary disk/,
		);
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("the background color setting repaints space and survives a reload", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		await page.evaluate(() => /** @type {any} */ (window).nbody.loadPreset("empty"));
		await page.evaluate(() =>
			/** @type {any} */ (window).nbody.setSettings({ background: "#203a5c" }),
		);
		/** Color of an empty spot of space, read back from the WebGL canvas. */
		const spaceColor = () =>
			page.evaluate(async () => {
				await new Promise((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(resolve)),
				);
				const source = /** @type {HTMLCanvasElement} */ (document.getElementById("trails"));
				const probe = document.createElement("canvas");
				probe.width = probe.height = 1;
				const ctx = /** @type {CanvasRenderingContext2D} */ (probe.getContext("2d"));
				ctx.drawImage(source, source.width / 2, source.height / 2, 1, 1, 0, 0, 1, 1);
				return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)];
			});
		assert.deepEqual(await spaceColor(), [0x20, 0x3a, 0x5c]);
		assert.equal(
			await page.evaluate(() =>
				getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
			),
			"#203a5c",
		);
		await page.reload();
		await page.waitForFunction(() => /** @type {any} */ (window).nbody?.renderer);
		assert.deepEqual(await spaceColor(), [0x20, 0x3a, 0x5c], "kept after reload");
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("randomizes settings from the panel button and the D key", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		const snapshot = () =>
			page.evaluate(() => ({ .../** @type {any} */ (window).nbody.settings }));
		const original = await snapshot();
		await page.getByRole("button", { name: "🎲 Randomize settings" }).click();
		const rolled = await snapshot();
		assert.notDeepEqual(rolled, original);
		for (const key of ["integrator", "solver", "timeStep", "sound", "showHud", "tool"])
			assert.equal(rolled[key], original[key], `${key} left alone`);
		assert.ok(rolled.mergeChance + rolled.bounceChance <= 1 + 1e-9);
		assert.match((await page.locator("#toast").textContent()) ?? "", /🎲 merge \d+ %/);

		await page.locator("#stage").focus();
		await page.keyboard.press("d");
		assert.notDeepEqual(await snapshot(), rolled);
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("splits big force calculations across threads with identical results", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		assert.equal(await page.evaluate(() => crossOriginIsolated), true, "served isolated");
		const result = await page.evaluate(async () => {
			const app = /** @type {any} */ (window).nbody;
			if (!app.paused) app.togglePause();
			app.setSettings({
				solver: "barnes-hut",
				integrator: "leapfrog",
				theta: 0.7,
				adaptive: false,
				mergeChance: 0,
				bounceChance: 0,
			});
			// 6,000 bodies on a deterministic spiral, orbiting a heavy center.
			const bodies = [{ m: 1e7, x: 0, y: 0, vx: 0, vy: 0, color: "#ffffff" }];
			for (let i = 1; i <= 6000; i++) {
				const d = 40 + 0.05 * i;
				const a = i * 2.399963;
				const v = Math.sqrt(1e7 / d);
				bodies.push({
					m: 500,
					x: d * Math.cos(a),
					y: d * Math.sin(a),
					vx: -v * Math.sin(a),
					vy: v * Math.cos(a),
					color: "#ffffff",
				});
			}
			const { client } = app;
			client.loadBodies(bodies, 0);
			const steps = 10;
			const dt = 1 / 300;
			const until = (/** @type {() => boolean} */ ok) =>
				new Promise((resolve) => {
					const check = () => (ok() ? resolve(undefined) : setTimeout(check, 10));
					check();
				});
			await until(() => client.advance({ steps, dt, budgetMs: 1e6 }));
			await until(() => client.steps === steps);

			// The same steps single-threaded, on this page.
			const url = "./src/physics/simulation.js"; // resolved by the page, not by tsc
			const { Simulation } = await import(url);
			const sim = new Simulation(client.config);
			for (const b of bodies) sim.addBody(b);
			for (let i = 0; i < steps; i++) sim.step(dt);
			let differences = 0;
			sim.bodies.forEach((/** @type {any} */ b, /** @type {number} */ i) => {
				const other = client.bodies[i];
				if (b.x !== other.x || b.y !== other.y || b.vx !== other.vx || b.vy !== other.vy)
					differences++;
			});
			return { differences, threads: client.threads, cores: navigator.hardwareConcurrency };
		});
		if (result.cores >= 3) assert.ok(result.threads > 1, `threads ${result.threads}`);
		assert.equal(result.differences, 0, "bit-for-bit the same as one thread");
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("a service worker isolates the page where the server can't, reloading once", async () => {
		const plain = await startServer({ port: 0, isolate: false });
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		try {
			const page = await context.newPage();
			/** @type {string[]} */
			const errors = [];
			page.on("pageerror", (error) => errors.push(error.message));
			let loads = 0;
			page.on("framenavigated", (frame) => {
				if (frame === page.mainFrame()) loads++;
			});
			await page.goto(plain.url);
			await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 15000 });
			await page.waitForFunction(
				() => /** @type {any} */ (window).nbody?.client.bodies.length > 0,
			);
			assert.equal(loads, 2, "reloaded exactly once");
			const threads = await page.evaluate(() => ({
				threads: /** @type {any} */ (window).nbody.client.threads,
				cores: navigator.hardwareConcurrency,
			}));
			if (threads.cores >= 3) assert.ok(threads.threads > 1, `threads ${threads.threads}`);

			// Later visits are isolated from the start.
			await page.reload();
			await page.waitForFunction(() => /** @type {any} */ (window).nbody);
			assert.equal(await page.evaluate(() => crossOriginIsolated), true);
			assert.equal(loads, 3, "no further reloads");
			assert.deepEqual(errors, []);
		} finally {
			await context.close();
			await plain.close();
		}
	});

	it("a share link survives the service worker's reload on a first visit", async () => {
		const { page: sender, context: senderContext } = await openApp({
			viewport: { width: 1280, height: 800 },
			permissions: ["clipboard-read", "clipboard-write"],
		});
		await sender.keyboard.press("2"); // solar system
		await sender.waitForTimeout(300);
		await sender.evaluate(() => {
			const a = /** @type {any} */ (window).nbody;
			if (!a.paused) a.togglePause();
			a.setSettings({ integrator: "yoshida4" });
		});
		await sender.waitForTimeout(200);
		const expected = await bodyCount(sender);
		await sender.evaluate(() => /** @type {any} */ (window).nbody.share());
		const hash = new URL(await sender.evaluate(() => navigator.clipboard.readText())).hash;
		await senderContext.close();

		const plain = await startServer({ port: 0, isolate: false });
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
		try {
			const page = await context.newPage();
			await page.goto(plain.url + hash);
			await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 15000 });
			await page.waitForFunction(
				() => /** @type {any} */ (window).nbody?.client.bodies.length > 0,
			);
			assert.equal(
				await page.evaluate(() => /** @type {any} */ (window).nbody.settings.integrator),
				"yoshida4",
			);
			assert.equal(await bodyCount(page), expected);
			assert.equal(new URL(page.url()).hash, "", "the address bar is tidied after loading");
		} finally {
			await context.close();
			await plain.close();
		}
	});

	it("persists settings across reloads", async () => {
		const { page, context } = await openApp({ viewport: { width: 1280, height: 800 } });
		await page.locator('[data-tool="scenario"]').click();
		await page.reload(); // immediately: the debounced save must be flushed on pagehide
		await page.waitForFunction(
			() => /** @type {any} */ (window).nbody?.client.bodies.length > 0,
		);
		assert.equal(
			await page.evaluate(() => /** @type {any} */ (window).nbody.settings.tool),
			"scenario",
		);
		assert.equal(
			await page.locator('[data-tool="scenario"]').getAttribute("aria-pressed"),
			"true",
		);
		await context.close();
	});

	it("reset settings shows the same values after a reload", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 1280, height: 800 } });
		// The spiral needs Barnes–Hut, leapfrog, no collisions, ...
		await page.evaluate(() => /** @type {any} */ (window).nbody.loadPreset("spiral"));
		await page.evaluate(() =>
			/** @type {any} */ (window).nbody.setSettings({ mass: 77777, speed: 3, theta: 1 }),
		);
		await page.evaluate(() => {
			const panel = /** @type {any} */ (window).nbody.panel;
			if (!panel.isVisible()) panel.setVisible(true);
		});
		await page.getByRole("button", { name: "Reset settings" }).click();
		const settings = () =>
			page.evaluate(() => ({ .../** @type {any} */ (window).nbody.settings }));
		const afterReset = await settings();
		assert.equal(afterReset.solver, "barnes-hut", "the scenario keeps the solver it needs");
		assert.equal(afterReset.speed, 1, "everything else returns to its default");
		assert.equal(afterReset.theta, 0.7);
		await page.reload();
		await page.waitForFunction(
			() => /** @type {any} */ (window).nbody?.client.bodies.length > 0,
		);
		assert.deepEqual(await settings(), afterReset);
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("share links reproduce the bodies and settings", async () => {
		const { page, context, errors } = await openApp({
			viewport: { width: 1280, height: 800 },
			permissions: ["clipboard-read", "clipboard-write"],
		});
		await page.keyboard.press("2"); // solar system
		await page.waitForTimeout(300);
		await page.evaluate(() => {
			const a = /** @type {any} */ (window).nbody;
			if (!a.paused) a.togglePause();
			a.setSettings({ integrator: "yoshida4", mergeChance: 0, bounceChance: 0 });
		});
		await page.waitForTimeout(200);
		const expected = await bodyCount(page);
		await page.evaluate(() => /** @type {any} */ (window).nbody.share());
		const url = await page.evaluate(() => navigator.clipboard.readText());
		assert.match(url, /#s=z[A-Za-z0-9_-]+$/);

		const other = await context.newPage();
		await other.goto(url);
		await other.waitForFunction(
			(n) => /** @type {any} */ (window).nbody?.client.bodies.length === n,
			expected,
		);
		assert.equal(
			await other.evaluate(() => /** @type {any} */ (window).nbody.settings.integrator),
			"yoshida4",
		);
		assert.equal(
			await other.evaluate(
				() =>
					/** @type {any} */ (window).nbody.settings.mergeChance +
					/** @type {any} */ (window).nbody.settings.bounceChance,
			),
			0,
		);
		assert.equal(
			await other.evaluate(() => location.hash),
			"",
			"hash is cleared after loading",
		);
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("records a video and a GIF", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 800, height: 600 } });
		await page.keyboard.press("v");
		assert.ok(await page.locator("#rec-indicator").isVisible());
		await page.waitForTimeout(1500);
		await page.locator("#rec-indicator").click();
		await page.locator("#recording").waitFor({ state: "visible" });
		await screenshot(page, "recording");
		const gif = await page.evaluate(async () => {
			const link = /** @type {HTMLAnchorElement} */ (
				document.getElementById("recording-download-gif")
			);
			const img = /** @type {HTMLImageElement} */ (document.getElementById("recording-gif"));
			await img.decode();
			return { hidden: link.hidden, width: img.naturalWidth, label: link.textContent };
		});
		assert.equal(gif.hidden, false);
		assert.ok(gif.width > 100, `gif width ${gif.width}`);
		assert.match(gif.label ?? "", /GIF \(\d+ KB\)/);
		const videoVisible = await page.locator("#recording-download-video").isVisible();
		assert.ok(videoVisible, "MediaRecorder video available in Chromium");
		await page.locator("#recording-close").click();
		assert.ok(!(await page.locator("#recording").isVisible()));

		// Stopping twice at once (the time limit and a key press together) finishes once.
		await page.keyboard.press("v");
		await page.waitForTimeout(800);
		const twice = await page.evaluate(async () => {
			const app = /** @type {any} */ (window).nbody;
			await Promise.all([app.toggleRecording(), app.toggleRecording()]);
			const link = /** @type {HTMLAnchorElement} */ (
				document.getElementById("recording-download-gif")
			);
			return { recording: app.recorder.recording, gif: link.href, hidden: link.hidden };
		});
		assert.equal(twice.recording, false, "no new recording started");
		assert.equal(twice.hidden, false);
		// (The page's CSP blocks fetch() of blob: URLs; images may load them.)
		const gifStillThere = await page.evaluate((href) => {
			const img = new Image();
			img.src = href;
			return img.decode().then(
				() => true,
				() => false,
			);
		}, twice.gif);
		assert.ok(gifStillThere, "the GIF's URL wasn't revoked");
		assert.ok(await page.locator("#recording").isVisible());
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("recovers from a lost WebGL context and keeps drawing", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 800, height: 600 } });
		// dispose() forces a real context loss through WEBGL_lose_context.
		await page.evaluate(() => {
			const app = /** @type {any} */ (window).nbody;
			app.lostRenderer = app.renderer;
			app.renderer.dispose();
		});
		await page.waitForFunction(() => {
			const app = /** @type {any} */ (window).nbody;
			return app.renderer !== app.lostRenderer && !app.renderer.lost;
		});
		await page.waitForTimeout(500);
		const lit = await page.evaluate(async () => {
			const blob = await /** @type {any} */ (window).nbody.renderer.toBlob();
			const bitmap = await createImageBitmap(blob);
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
			const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext("2d"));
			ctx.drawImage(bitmap, 0, 0);
			const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
			let n = 0;
			for (let i = 0; i < data.length; i += 16) if (data[i] > 60) n++;
			return n;
		});
		assert.ok(lit > 50, `lit pixels ${lit}`);
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("keeps animating after a frame fails", async () => {
		const { page, context, errors } = await openApp({ viewport: { width: 800, height: 600 } });
		const result = await page.evaluate(async () => {
			const app = /** @type {any} */ (window).nbody;
			const draw = app.overlay.draw;
			let failed = 0;
			let drawn = 0;
			app.overlay.draw = (/** @type {any[]} */ ...args) => {
				if (failed < 3) {
					failed++;
					throw new Error("test: frame failure");
				}
				drawn++;
				return draw.apply(app.overlay, args);
			};
			await new Promise((resolve) => setTimeout(resolve, 600));
			app.overlay.draw = draw;
			return { failed, drawn };
		});
		assert.equal(result.failed, 3);
		assert.ok(result.drawn > 5, `frames drawn afterwards: ${result.drawn}`);
		assert.deepEqual(
			errors.filter((e) => !e.includes("test: frame failure")),
			[],
			"logged once, nothing else went wrong",
		);
		assert.equal(errors.length, 1, "three failures in a row are logged once");
		await context.close();
	});
});

describe("mobile", () => {
	const phone = devices["Pixel 7"];

	it("fits the screen with a usable toolbar and hidden settings", async () => {
		const { page, context, errors } = await openApp(phone);
		await page.waitForTimeout(1000);
		await screenshot(page, "mobile");

		const layout = await page.evaluate(() => ({
			scrollWidth: document.documentElement.scrollWidth,
			innerWidth: window.innerWidth,
			innerHeight: window.innerHeight,
		}));
		assert.ok(layout.scrollWidth <= layout.innerWidth, "no horizontal overflow");

		const toolbar = await page.locator("#toolbar").boundingBox();
		assert.ok(toolbar);
		assert.ok(toolbar.x >= 0 && toolbar.x + toolbar.width <= layout.innerWidth, "toolbar fits");
		assert.ok(toolbar.y + toolbar.height <= layout.innerHeight);
		for (const button of await page.locator("#toolbar button").all()) {
			const box = await button.boundingBox();
			assert.ok(box && box.width >= 38 && box.height >= 38, "touch targets are large enough");
		}

		// The scenario picker only appears (above the bar) with the scenario tool.
		const picker = page.locator("#scenario-picker");
		assert.ok(!(await picker.isVisible()), "picker hidden with the planet tool");
		await page.locator('[data-tool="scenario"]').tap();
		assert.ok(await picker.isVisible(), "picker shown with the scenario tool");
		const pickerBox = await picker.boundingBox();
		assert.ok(
			pickerBox &&
				pickerBox.x >= 0 &&
				pickerBox.x + pickerBox.width <= layout.innerWidth &&
				pickerBox.y + pickerBox.height <= toolbar.y &&
				pickerBox.height >= 38,
			"picker fits above the toolbar",
		);
		await screenshot(page, "mobile-scenario-picker");
		await page.locator('[data-tool="planet"]').tap();

		assert.ok(!(await page.locator("#settings-panel").isVisible()), "settings start hidden");
		await page.locator('[data-action="settings"]').tap();
		const panel = page.locator("#settings-panel");
		assert.ok(await panel.isVisible());
		const box = await panel.boundingBox();
		assert.ok(box && box.x >= 0 && box.x + box.width <= layout.innerWidth, "panel fits");
		await screenshot(page, "mobile-settings");
		assert.deepEqual(errors, []);
		await context.close();
	});

	it("tap adds a planet and two-finger pinch zooms without adding bodies", async () => {
		const { page, context, errors } = await openApp(phone);
		await pauseAndClear(page);

		await page.touchscreen.tap(200, 400);
		await waitForBodies(page, 1);

		const zoomBefore = await page.evaluate(() => /** @type {any} */ (window).nbody.camera.zoom);
		const cdp = await context.newCDPSession(page);
		/** @param {'touchStart' | 'touchMove' | 'touchEnd'} type @param {number} spread */
		const touch = (type, spread) =>
			cdp.send("Input.dispatchTouchEvent", {
				type,
				touchPoints:
					type === "touchEnd"
						? []
						: [
								{ x: 200 - spread, y: 450, id: 0 },
								{ x: 200 + spread, y: 450, id: 1 },
							],
			});
		await touch("touchStart", 30);
		for (let spread = 35; spread <= 120; spread += 5) await touch("touchMove", spread);
		await touch("touchEnd", 0);

		const zoomAfter = await page.evaluate(() => /** @type {any} */ (window).nbody.camera.zoom);
		assert.ok(zoomAfter > zoomBefore * 2, `${zoomBefore} -> ${zoomAfter}`);
		await page.waitForTimeout(200);
		assert.equal(await bodyCount(page), 1, "pinch must not create bodies");
		assert.deepEqual(errors, []);
		await context.close();
	});
});
