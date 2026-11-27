import { SimulationClient } from "./engine/client.js";
import { radiusForMass } from "./physics/body.js";
import { parseHexColor, randomPastel } from "./physics/color.js";
import { createRng } from "./physics/rng.js";
import {
	circularOrbitVelocity,
	dominantBody,
	orbitalElements,
	predictTrajectory,
} from "./physics/orbits.js";
import { getPreset, PRESETS } from "./physics/presets.js";
import { createState, loadState } from "./physics/state.js";
import {
	applySettings,
	balanceCollisionChances,
	defaultSettings,
	loadSettings,
	randomSettings,
	saveSettings,
	trailSeconds,
	SCHEMA,
	simulationConfig,
} from "./settings.js";
import { decodeShare, encodeShare, readShareHash } from "./share.js";
import { Camera } from "./ui/camera.js";
import { bindToolbar, createControlPanel } from "./ui/controls.js";
import { byId, downloadBlob, safeLocalStorage, Toast } from "./ui/dom.js";
import { WebGLRenderer } from "./ui/glRenderer.js";
import { Hud } from "./ui/hud.js";
import { InputController } from "./ui/input.js";
import { Inspector } from "./ui/inspector.js";
import { MAX_RECORDING_SECONDS, Recorder } from "./ui/recorder.js";
import { OverlayRenderer } from "./ui/overlay.js";
import { buildStamp, placeStamp } from "./stamp.js";
import { Sound } from "./ui/sound.js";
import { ensureCrossOriginIsolation } from "./isolation.js";
import { usesBarnesHut } from "./physics/simulation.js";
import { RateMeter } from "./ui/rateMeter.js";
import { IMPACT_BOUNCE, IMPACT_STRIDE } from "./physics/collisions.js";

/** @typedef {import('./ui/camera.js').Point} Point */
/** @typedef {import('./physics/body.js').Body} Body */
/** @typedef {import('./settings.js').SettingKey} SettingKey */
/** @typedef {import('./share.js').SharedState} SharedState */

/**
 * Simulated time per real second at speed 1×. Slow on purpose: a typical orbit takes
 * 15–20 seconds, so the scenes feel vast rather than busy.
 */
const SIM_TIME_PER_SECOND = 0.2;
/**
 * At slow speeds the step shrinks below the time-step setting so there is still at
 * least one step per displayed frame; otherwise bodies would visibly stutter.
 */
const MIN_STEPS_PER_SECOND = 60;
/** Trails fade to e⁻³ ≈ 5 % brightness over the chosen trail length. */
const TRAIL_FADE_EXPONENT = 3;
const MAX_STEPS_PER_REQUEST = 40;
/** Time physics may spend per request. On the main thread it must leave room to render. */
const WORKER_BUDGET_MS = 14;
const MAIN_THREAD_BUDGET_MS = 10;
/** A press that moves less than this (CSS px) is a tap, not a drag. */
const TAP_DISTANCE = 6;
/** Extra reach (CSS px) when tapping a body, more for fingers than for a mouse. */
const HIT_SLOP = { touch: 16, mouse: 8 };
/** Approximate pair interactions the trajectory preview may spend per frame. */
const PREVIEW_BUDGET = 2_500_000;
/**
 * How far ahead the trajectory preview looks, in simulated time (about 20 seconds at
 * 1× speed). Further than that, close passes make it guesswork; it fades out instead.
 */
const PREVIEW_HORIZON = 4;
const PREVIEW_MAX_STEPS = 300;
/** Heaviest bodies that keep moving in the preview (lighter ones are held fixed). */
const PREVIEW_MOVERS = 32;
/** Beyond this, the preview only uses the heaviest bodies (they dominate the pull). */
const PREVIEW_MAX_BODIES = 1500;
const HUD_INTERVAL_MS = 250;
/** Personal preferences a share link doesn't override. */
const VIEWER_SETTINGS = new Set(["sound", "musicVolume", "effectsVolume", "background"]);
/** How long a collision flash lasts. */
const FLASH_MS = 700;
/** Flashes shown at once; beyond this the oldest go first. */
const MAX_FLASHES = 24;
const DEVICE_PIXEL_RATIO_CAP = 2;

const HINTS = {
	touch: "Tap: planet in orbit · Pull back & release: launch · Tap a body: inspect · Two fingers: pan / zoom",
	mouse: "Click: planet in orbit · Pull back & release: launch · Click a body: inspect · Wheel: zoom · Right-drag: pan",
};

/**
 * @typedef {object} Aim
 * @property {'planet' | 'scenario'} kind
 * @property {Point} start World position.
 * @property {Point} pointer Current pointer (screen).
 */

/** Keys a focused dropdown needs for itself; every other shortcut still works. */
const SELECT_KEYS = new Set([
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Enter",
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);
/** Input types that take typed text (shortcut keys would be swallowed as text). */
const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

/** @param {Element | null} element Whether the user is typing into it. */
function isTextEntry(element) {
	if (!element) return false;
	if (element instanceof HTMLTextAreaElement) return true;
	if (element instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(element.type);
	return element instanceof HTMLElement && element.isContentEditable;
}

/** @returns {number} A random 32-bit seed. */
const randomSeed = () => (Math.random() * 0x100000000) >>> 0;

class App {
	storage = safeLocalStorage();
	settings = loadSettings(this.storage);
	camera = new Camera();
	stage = byId("stage", HTMLElement);
	overlay = new OverlayRenderer(byId("overlay", HTMLCanvasElement));
	hud = new Hud();
	toast = new Toast(byId("toast", HTMLElement));
	help = byId("help", HTMLDialogElement);
	recordingDialog = byId("recording", HTMLDialogElement);
	recorder = new Recorder();
	sound = new Sound({
		enabled: this.settings.sound,
		music: this.settings.musicVolume,
		effects: this.settings.effectsVolume,
	});
	coarsePointer = window.matchMedia("(pointer: coarse)").matches;

	paused = false;
	/** @type {Aim | null} */
	aim = null;
	/** @type {number | null} Id of the inspected body. */
	selectedId = null;

	/** @type {WebGLRenderer} */
	renderer;
	client;

	#presetSeed = randomSeed();
	#rng = createRng();
	#pendingSingleStep = false;
	/** Simulated time owed to the physics engine (not yet requested). */
	#timeAccumulator = 0;
	/** Step size of the most recent physics request. */
	#lastStepSize = 0;
	#lastFrame = performance.now();
	#lastCamera = this.camera.snapshot();
	#lastHud = 0;
	/** Running totals behind the frame and step rates in the stats. */
	#framesDrawn = 0;
	#stepsApplied = 0;
	#fpsMeter = new RateMeter();
	#stepMeter = new RateMeter();
	/** Simulated time per real second, to show whether physics keeps up. */
	#simTimeMeter = new RateMeter();
	#wantDiagnostics = false;
	/** @type {object | null} */
	#lastDiagnostics = null;
	#energy = { key: "", baseline: Number.NaN, scale: Number.NaN, drift: Number.NaN };
	#previewState = createState();
	/** @type {{ x: number, y: number, r: number, revision: number } | null} */
	#selectedLast = null;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	#saveTimer;
	/**
	 * The scenario the scenario tool will drop next, built ahead of time so its ghost
	 * can be shown while aiming (and is exactly what gets added).
	 *
	 * @type {{ key: string, stamp: import('./stamp.js').Stamp } | null}
	 */
	#stamp = null;
	/** @type {{ x: number, y: number, size: number, bounce: boolean, start: number }[]} */
	#flashes = [];
	#hintDismissed = false;
	#dpr = 0;
	/**
	 * Bodies were removed: wipe the trails again once a frame reflecting that arrives
	 * (a {@link SimulationClient#checkpoint}). Frames already on their way still show
	 * the old bodies, which would otherwise leave marks that never fade while paused
	 * or with permanent trails.
	 *
	 * @type {number | null}
	 */
	#clearTrailsAt = null;
	/** @type {string[]} Object URLs of the last recording, revoked when closed. */
	#recordingUrls = [];

	constructor() {
		this.client = new SimulationClient({
			config: simulationConfig(this.settings),
			// Ask for the steps already owed as soon as the worker is free, instead of
			// leaving it idle until the next animation frame.
			onWorkerFrame: () => this.#requestPhysics(0),
			onError: (message) => {
				console.error(message);
				this.toast.show(`Physics error: ${message}`);
			},
			onFallback: (reason, restored) => {
				console.warn(`Physics worker unavailable (${reason}); running on the main thread.`);
				if (!restored) this.loadPreset(this.settings.preset, { quiet: true });
			},
		});
		this.renderer = this.#createRenderer();

		this.input = new InputController(this.stage, this.camera, {
			getTool: () => this.settings.tool,
			onAimStart: (kind, screen) => {
				this.aim = {
					kind,
					start: this.camera.screenToWorld(screen.x, screen.y),
					pointer: screen,
				};
			},
			onAimMove: (screen) => {
				if (this.aim) this.aim.pointer = screen;
			},
			onAimEnd: (screen) => this.#launch(screen),
			onAimCancel: () => (this.aim = null),
			onCameraInput: (kind) => {
				if (kind === "pan" && this.settings.follow !== "off") {
					this.#changeSettings({ follow: "off" });
					this.toast.show("Camera follow off");
				}
			},
		});

		this.panel = createControlPanel(
			this.settings,
			{
				restartScenario: () => this.loadPreset(this.settings.preset),
				togglePause: () => this.togglePause(),
				stepOnce: () => this.stepOnce(),
				fitView: () => this.fitView(),
				clear: () => this.clear(),
				saveImage: () => void this.saveImage(),
				share: () => void this.share(),
				toggleRecording: () => void this.toggleRecording(),
				resetSettings: () => this.resetSettings(),
				randomizeSettings: () => this.randomizeSettings(),
			},
			(key) => this.#onSettingChanged(key),
		);

		this.toolbar = bindToolbar(byId("toolbar", HTMLElement), {
			onTool: (tool) => this.#changeSettings({ tool }),
			onAction: (action) => this.#runAction(action),
			// Picking a scenario means you want to add it.
			onScenario: (id) => this.#changeSettings({ addScenario: id, tool: "scenario" }),
		});
		for (const button of document.querySelectorAll("#hud [data-action], #rec-indicator")) {
			const action = /** @type {HTMLElement} */ (button).dataset.action ?? "";
			button.addEventListener("click", () => this.#runAction(action));
		}
		byId("help-close", HTMLButtonElement).addEventListener("click", () => this.help.close());
		for (const dialog of [this.help, this.recordingDialog]) {
			dialog.addEventListener("click", (e) => {
				if (e.target === dialog) dialog.close(); // click on the backdrop
			});
		}
		this.recordingDialog.addEventListener("close", () => this.#discardRecording());
		byId("recording-close", HTMLButtonElement).addEventListener("click", () =>
			this.recordingDialog.close(),
		);

		this.inspector = new Inspector({
			onFollow: () => {
				const following = this.settings.follow === "selected";
				this.#changeSettings({ follow: following ? "off" : "selected" });
				this.#updateInspector();
			},
			onDelete: () => this.deleteSelected(),
			onClose: () => this.select(null),
		});

		const compact = window.matchMedia("(max-width: 700px), (max-height: 500px)").matches;
		this.panel.setVisible(!compact);
		this.hud.setHint(this.coarsePointer ? HINTS.touch : HINTS.mouse);
		this.hud.setStatsVisible(this.settings.showHud);
		this.#applyPageBackground();

		// Browsers only allow audio to start from a user gesture: unlock on the first one.
		for (const type of ["pointerdown", "keydown"]) {
			window.addEventListener(type, () => this.sound.unlock(), { capture: true });
		}
		document.addEventListener("visibilitychange", () => this.sound.setHidden(document.hidden));
		this.#syncSoundButton();

		// Capture phase: the settings panel stops key events from bubbling out of its
		// controls, and shortcuts should work whatever has focus.
		window.addEventListener("keydown", (e) => this.#onKey(e), { capture: true });
		// Space pauses even when a button or checkbox has focus, so stop it from also
		// "clicking" that control (which happens on key up).
		window.addEventListener(
			"keyup",
			(e) => {
				if (e.key === " " && !isTextEntry(e.target instanceof Element ? e.target : null)) {
					e.preventDefault();
				}
			},
			{ capture: true },
		);
		new ResizeObserver(() => this.#resize()).observe(this.stage);
		window.addEventListener("resize", () => this.#resize()); // device-pixel-ratio changes
		this.#resize();
		this.#syncToolbar();
	}

	async start() {
		const payload = readShareHash(location.hash);
		if (payload) {
			// Forget the hash so a reload doesn't throw away what the user does next.
			history.replaceState(null, "", location.pathname + location.search);
			try {
				this.#applyShared(await decodeShare(payload));
				this.toast.show("Loaded shared simulation");
			} catch (error) {
				console.warn(error);
				this.toast.show("Couldn't open that share link");
				this.loadPreset(this.settings.preset, { quiet: true });
			}
		} else {
			this.loadPreset(this.settings.preset, { quiet: true });
		}
		// A reload right after changing something must not lose the change.
		addEventListener("pagehide", () => {
			if (this.#saveTimer !== undefined) this.#saveNow();
		});
		requestAnimationFrame(this.#frame);
	}

	// ---------------------------------------------------------------- actions

	/**
	 * @param {string} id
	 * @param {{ quiet?: boolean, seed?: number }} [options]
	 */
	loadPreset(id, { quiet = false, seed = randomSeed() } = {}) {
		const preset = getPreset(id);
		const changed = applySettings(this.settings, { preset: preset.id, ...preset.settings });
		this.client.configure(simulationConfig(this.settings));
		this.panel?.refresh();
		this.#scheduleSave();

		this.#presetSeed = seed;
		this.client.loadPreset(preset.id, this.#colorMode(), seed);
		this.select(null);
		this.camera.fit(preset.extent);
		this.#clearTrailsSoon();
		this.#lastCamera = this.camera.snapshot();
		this.#timeAccumulator = 0;

		this.#flashes = [];
		if (!quiet) {
			this.sound.arrive();
			const adjusted = changed
				.filter((k) => k !== "preset")
				.map((k) => SCHEMA[/** @type {SettingKey} */ (k)].label.toLowerCase());
			this.toast.show(
				adjusted.length ? `${preset.name} (adjusted ${adjusted.join(", ")})` : preset.name,
			);
		}
	}

	togglePause() {
		this.paused = !this.paused;
		this.#syncToolbar();
		this.toast.show(this.paused ? "Paused" : "Running", 1000);
	}

	stepOnce() {
		if (!this.paused) this.togglePause();
		this.#pendingSingleStep = true;
	}

	clear() {
		this.client.clear();
		this.select(null);
		this.#clearTrailsSoon();
		this.toast.show("All bodies removed", 1200);
	}

	/** Frames the bulk of the bodies (outliers that escaped are ignored). */
	fitView() {
		const bodies = this.client.bodies;
		if (bodies.length === 0) {
			this.camera.fit(getPreset(this.settings.preset).extent);
			return;
		}
		const c = centerOfMass(bodies);
		const distances = bodies
			.map((b) => Math.hypot(b.x - c.x, b.y - c.y) + b.r)
			.sort((a, b) => a - b);
		const extent = distances[Math.floor((distances.length - 1) * 0.9)];
		this.camera.fit(Math.max(extent * 1.15, 40), c.x, c.y);
	}

	async saveImage() {
		const blob = await this.renderer.toBlob();
		if (!blob) {
			this.toast.show("Could not create image");
			return;
		}
		downloadBlob(blob, `n-body-${timestamp()}.png`);
		this.toast.show("Image saved");
	}

	/** Copies (or, on phones, shares) a link that reproduces the current simulation. */
	async share() {
		try {
			const { text, exact } = await encodeShare({
				settings: this.settings,
				camera: this.camera.snapshot(),
				time: this.client.time,
				bodies: this.client.bodies.map(({ m, x, y, vx, vy, color }) => ({
					m,
					x,
					y,
					vx,
					vy,
					color,
				})),
				preset: { id: this.settings.preset, seed: this.#presetSeed },
			});
			const url = `${location.origin}${location.pathname}${location.search}#s=${text}`;
			const note = exact ? "" : " (too many bodies: it restarts the scenario)";
			if (this.coarsePointer && typeof navigator.share === "function") {
				await navigator.share({ title: document.title, url });
			} else {
				await navigator.clipboard.writeText(url);
				this.toast.show(`Link copied${note}`, 3000);
			}
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") return; // share sheet dismissed
			console.warn(error);
			this.toast.show("Couldn't create a share link");
		}
	}

	async toggleRecording() {
		if (this.#finishingRecording) return;
		if (this.recorder.recording) {
			await this.#finishRecording();
			return;
		}
		const rgb = parseHexColor(this.settings.background) ?? { r: 0, g: 0, b: 0 };
		this.recorder.start(this.renderer.canvas, [rgb.r, rgb.g, rgb.b]);
		this.#syncRecordingIndicator();
		this.toast.show("Recording… press V or tap REC to stop", 2500);
	}

	/** Set while a stopped recording's video is still being finished. */
	#finishingRecording = false;

	async #finishRecording() {
		const stopping = this.recorder.stop();
		this.#syncRecordingIndicator();
		this.#finishingRecording = true;
		let recording;
		try {
			recording = await stopping;
		} finally {
			this.#finishingRecording = false;
		}
		if (!recording) return; // already finished (e.g. the time limit and V together)
		this.#discardRecording();
		const video = byId("recording-video", HTMLVideoElement);
		const gif = byId("recording-gif", HTMLImageElement);
		const videoLink = byId("recording-download-video", HTMLAnchorElement);
		const gifLink = byId("recording-download-gif", HTMLAnchorElement);
		const stamp = timestamp();

		if (recording.video) {
			const url = URL.createObjectURL(recording.video);
			this.#recordingUrls.push(url);
			const ext = recording.video.type.includes("mp4") ? "mp4" : "webm";
			video.src = url;
			videoLink.href = url;
			videoLink.download = `n-body-${stamp}.${ext}`;
			videoLink.textContent = `Download video (${ext.toUpperCase()}, ${megabytes(recording.video.size)})`;
		}
		if (recording.gif) {
			const url = URL.createObjectURL(recording.gif);
			this.#recordingUrls.push(url);
			gif.src = url;
			gifLink.href = url;
			gifLink.download = `n-body-${stamp}.gif`;
			gifLink.textContent = `Download GIF (${megabytes(recording.gif.size)})`;
		}
		video.hidden = videoLink.hidden = !recording.video;
		gif.hidden = !!recording.video || !recording.gif;
		gifLink.hidden = !recording.gif;
		byId("recording-info", HTMLElement).textContent =
			`${recording.seconds.toFixed(1)} s recorded.` +
			(recording.gifTruncated ? " The GIF stops early to keep the file small." : "");
		this.recordingDialog.showModal();
	}

	#discardRecording() {
		const video = byId("recording-video", HTMLVideoElement);
		video.pause();
		video.removeAttribute("src");
		byId("recording-gif", HTMLImageElement).removeAttribute("src");
		for (const url of this.#recordingUrls) URL.revokeObjectURL(url);
		this.#recordingUrls = [];
	}

	#syncRecordingIndicator() {
		const indicator = byId("rec-indicator", HTMLButtonElement);
		indicator.hidden = !this.recorder.recording;
		byId("hud", HTMLElement)
			.querySelector('[data-action="record"]')
			?.setAttribute("aria-pressed", String(this.recorder.recording));
	}

	/**
	 * Restores the defaults, except what the current scenario needs (e.g. Barnes–Hut
	 * for the 10,000-body spiral). That is also what a reload would apply, so the
	 * panel shows the same values before and after refreshing.
	 */
	resetSettings() {
		const preset = getPreset(this.settings.preset);
		this.#changeSettings({ ...defaultSettings(), preset: preset.id, ...preset.settings });
		this.toast.show("Settings reset");
	}

	/**
	 * Rolls new values for the settings that change how things look and behave (see
	 * `randomSettings`); accuracy, performance and sound settings stay as they are.
	 */
	randomizeSettings() {
		this.#changeSettings(randomSettings(this.#rng));
		const s = this.settings;
		const percent = (/** @type {number} */ p) => `${Math.round(p * 100)} %`;
		const parts = [
			`merge ${percent(s.mergeChance)}`,
			`bounce ${percent(s.bounceChance)}`,
			`speed ${s.speed}×`,
			s.trailLength >= 1 ? "permanent trails" : `trails ${s.trailLength}`,
		];
		if (s.drag > 0) parts.push(`drag ${s.drag}`);
		this.toast.show(`🎲 ${parts.join(" · ")}`, 3500);
	}

	toggleHelp() {
		if (this.help.open) this.help.close();
		else this.help.showModal();
	}

	toggleSound() {
		this.#changeSettings({ sound: !this.settings.sound });
		if (this.settings.sound) this.sound.unlock();
		this.toast.show(this.settings.sound ? "Sound on" : "Sound off", 1000);
	}

	#soundSettings() {
		const s = this.settings;
		return { enabled: s.sound, music: s.musicVolume, effects: s.effectsVolume };
	}

	#syncSoundButton() {
		byId("hud", HTMLElement)
			.querySelector('[data-action="sound"]')
			?.setAttribute("aria-pressed", String(this.settings.sound));
	}

	/** Stereo position (−1 left … 1 right) of a world x coordinate on screen. @param {number} x */
	#stereoPan(x) {
		const screen = this.camera.worldToScreen(x, 0).x;
		return Math.max(-1, Math.min(1, (screen / this.camera.width) * 2 - 1));
	}

	toggleSettings() {
		this.panel.setVisible(!this.panel.isVisible());
		this.#syncToolbar();
	}

	/**
	 * Changes settings as if done through the panel (also handy from the console:
	 * `nbody.setSettings({ integrator: "leapfrog" })`).
	 *
	 * @param {Record<string, unknown>} changes
	 */
	setSettings(changes) {
		this.#changeSettings(changes);
	}

	/** @param {number | null} id */
	select(id) {
		this.selectedId = id;
		const body = id === null ? undefined : this.#bodyById(id);
		this.#selectedLast = body
			? { x: body.x, y: body.y, r: body.r, revision: this.client.revision }
			: null;
		if (id === null) {
			this.inspector?.hide();
			if (this.settings.follow === "selected") this.#changeSettings({ follow: "off" });
		} else {
			this.#updateInspector();
		}
	}

	deleteSelected() {
		if (this.selectedId === null) return;
		this.client.remove([this.selectedId]);
		if (this.paused) this.#clearTrailsSoon();
		this.toast.show(`Body #${this.selectedId} deleted`, 1200);
		this.select(null);
	}

	/** @param {string} action */
	#runAction(action) {
		switch (action) {
			case "pause":
				return this.togglePause();
			case "fit":
				return this.fitView();
			case "clear":
				return this.clear();
			case "settings":
				return this.toggleSettings();
			case "help":
				return this.toggleHelp();
			case "share":
				return void this.share();
			case "record":
				return void this.toggleRecording();
			case "sound":
				return this.toggleSound();
		}
	}

	// --------------------------------------------------------------- settings

	/** @param {Record<string, unknown>} changes */
	#changeSettings(changes) {
		const changed = applySettings(this.settings, changes);
		if (changed.length === 0) return;
		this.panel.refresh();
		for (const key of changed) this.#onSettingChanged(/** @type {SettingKey} */ (key));
	}

	/** @param {SettingKey} key */
	#onSettingChanged(key) {
		switch (key) {
			case "mergeChance":
			case "bounceChance":
				// Edited directly in the panel: keep the two chances within 1 in total.
				if (balanceCollisionChances(this.settings, key)) this.panel.refresh();
				this.client.configure(simulationConfig(this.settings));
				break;
			case "integrator":
			case "solver":
			case "theta":
			case "restitution":
			case "drag":
			case "adaptive":
			case "maxSubsteps":
				this.client.configure(simulationConfig(this.settings));
				break;
			case "preset":
				this.loadPreset(this.settings.preset);
				break;
			case "showHud":
				this.hud.setStatsVisible(this.settings.showHud);
				break;
			case "background":
				this.renderer.setBackground(this.settings.background);
				this.#applyPageBackground();
				break;
			case "sound":
			case "musicVolume":
			case "effectsVolume":
				this.sound.configure(this.#soundSettings());
				this.#syncSoundButton();
				break;
			case "tool":
			case "addScenario":
				this.#syncToolbar();
				break;
		}
		this.#scheduleSave();
	}

	#scheduleSave() {
		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => this.#saveNow(), 300);
	}

	#saveNow() {
		clearTimeout(this.#saveTimer);
		this.#saveTimer = undefined;
		saveSettings(this.storage, this.settings);
	}

	#syncToolbar() {
		this.toolbar.sync({
			paused: this.paused,
			tool: this.settings.tool,
			settingsOpen: this.panel.isVisible(),
			scenario: this.settings.addScenario,
		});
	}

	/** @param {SharedState} shared */
	#applyShared(shared) {
		// Sound is the viewer's choice, not the sender's.
		const simulation = Object.fromEntries(
			Object.entries(shared.settings).filter(([key]) => !VIEWER_SETTINGS.has(key)),
		);
		applySettings(this.settings, simulation);
		this.client.configure(simulationConfig(this.settings));
		this.panel.refresh();
		this.hud.setStatsVisible(this.settings.showHud);
		this.#syncToolbar();
		if (shared.bodies) {
			this.client.loadBodies(shared.bodies, shared.time);
			this.#presetSeed = shared.preset?.seed ?? randomSeed();
		} else if (shared.preset) {
			this.loadPreset(shared.preset.id, { quiet: true, seed: shared.preset.seed });
		}
		this.camera.x = shared.camera.x;
		this.camera.y = shared.camera.y;
		this.camera.zoomAt(
			this.camera.width / 2,
			this.camera.height / 2,
			shared.camera.zoom / this.camera.zoom,
		);
		this.#clearTrailsSoon();
		this.#lastCamera = this.camera.snapshot();
	}

	// -------------------------------------------------------------- rendering

	/**
	 * Creates the WebGL renderer on a fresh canvas (a canvas whose context was lost
	 * can't be reused).
	 *
	 * @returns {WebGLRenderer}
	 */
	#createRenderer() {
		return new WebGLRenderer(this.#freshTrailCanvas(), this.settings.background);
	}

	/** The page and the browser's UI around the canvas match the background color. */
	#applyPageBackground() {
		const color = this.settings.background;
		document.documentElement.style.setProperty("--bg", color);
		document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
	}

	#freshTrailCanvas() {
		const old = byId("trails", HTMLCanvasElement);
		const canvas = /** @type {HTMLCanvasElement} */ (old.cloneNode(false));
		old.replaceWith(canvas);
		return canvas;
	}

	#clearTrailsSoon() {
		this.renderer.clearTrails();
		this.#clearTrailsAt = this.client.checkpoint();
	}

	#replaceRenderer() {
		if (this.recorder.recording) void this.#finishRecording();
		this.renderer.dispose();
		this.renderer = this.#createRenderer();
		this.renderer.resize(this.camera.width, this.camera.height, this.#dpr || 1);
		this.#lastCamera = this.camera.snapshot();
	}

	#resize() {
		const rect = this.stage.getBoundingClientRect();
		const dpr = Math.min(window.devicePixelRatio || 1, DEVICE_PIXEL_RATIO_CAP);
		const width = Math.max(1, Math.round(rect.width));
		const height = Math.max(1, Math.round(rect.height));
		if (width === this.camera.width && height === this.camera.height && dpr === this.#dpr) {
			return;
		}
		this.#dpr = dpr;
		this.camera.setViewport(width, height);
		this.renderer.resize(width, height, dpr);
		this.overlay.resize(width, height, dpr);
		this.#lastCamera = this.camera.snapshot();
	}

	// ------------------------------------------------------------------ input

	/** @returns {import('./engine/engine.js').ColorMode} */
	#colorMode() {
		return { random: this.settings.randomColors, color: this.settings.color };
	}

	/** The scenario the scenario tool adds next (rebuilt when its settings change). */
	#currentStamp() {
		const colors = this.#colorMode();
		const id = this.settings.addScenario;
		const key = `${id}|${colors.random}|${colors.color}|${this.client.config.G}`;
		if (this.#stamp?.key !== key) {
			const stamp = buildStamp(id, { seed: randomSeed(), colors, G: this.client.config.G });
			this.#stamp = { key, stamp };
		}
		return this.#stamp.stamp;
	}

	/**
	 * Launch velocity for the current aim, or a circular orbit for a tap. Aiming works
	 * like a slingshot: the body flies opposite to the drag (pull back to launch).
	 *
	 * @param {Aim} aim
	 * @returns {{ vx: number, vy: number, orbit: boolean, tap: boolean }}
	 */
	#aimVelocity(aim) {
		const startScreen = this.camera.worldToScreen(aim.start.x, aim.start.y);
		const dragged = Math.hypot(aim.pointer.x - startScreen.x, aim.pointer.y - startScreen.y);
		if (dragged < TAP_DISTANCE) {
			if (!this.settings.tapToOrbit) return { vx: 0, vy: 0, orbit: false, tap: true };
			const v = circularOrbitVelocity(
				this.client.bodies,
				aim.start.x,
				aim.start.y,
				this.client.config.G,
			);
			return { vx: v.vx, vy: v.vy, orbit: v.around !== undefined, tap: true };
		}
		const pointer = this.camera.screenToWorld(aim.pointer.x, aim.pointer.y);
		return {
			vx: aim.start.x - pointer.x,
			vy: aim.start.y - pointer.y,
			orbit: false,
			tap: false,
		};
	}

	/**
	 * The body under a world point, if any (with a little extra reach for fingers).
	 *
	 * @param {Point} point
	 * @returns {Body | undefined}
	 */
	#bodyAt(point) {
		const slop = (this.coarsePointer ? HIT_SLOP.touch : HIT_SLOP.mouse) / this.camera.zoom;
		let best;
		let bestGap = Infinity;
		for (const b of this.client.bodies) {
			const gap = Math.hypot(b.x - point.x, b.y - point.y) - b.r;
			if (gap <= slop && gap < bestGap) {
				best = b;
				bestGap = gap;
			}
		}
		return best;
	}

	/** @param {Point} screen */
	#launch(screen) {
		const aim = this.aim;
		this.aim = null;
		if (!aim) return;
		aim.pointer = screen;
		const { vx, vy, tap } = this.#aimVelocity(aim);

		// Tapping an existing body inspects it instead of adding a new one.
		const hit = tap ? this.#bodyAt(aim.start) : undefined;
		if (hit) {
			this.select(hit.id);
			return;
		}
		if (this.selectedId !== null && tap) this.select(null);

		const { x, y } = aim.start;
		if (aim.kind === "planet") {
			const color = this.settings.randomColors
				? randomPastel(this.#rng)
				: this.settings.color;
			this.client.addBody({ m: this.settings.mass, x, y, vx, vy, color });
		} else {
			this.client.addBodies(placeStamp(this.#currentStamp(), x, y, vx, vy));
			this.#stamp = null; // the next one gets a fresh random layout
		}
		const pan = this.#stereoPan(x);
		if (aim.kind === "planet") {
			const screenSpeed = Math.hypot(vx, vy) * this.camera.zoom;
			this.sound.launch(Math.min(1, screenSpeed / 250), pan);
		} else {
			this.sound.arrive(pan);
		}
		if (!this.#hintDismissed) {
			this.#hintDismissed = true;
			this.hud.setHint("");
		}
	}

	/** @param {KeyboardEvent} e */
	#onKey(e) {
		if (e.defaultPrevented || e.metaKey || e.altKey || e.ctrlKey) {
			return;
		}
		// Shortcuts work wherever focus is (clicking a button or dropdown focuses it),
		// except while typing, or for the keys a focused control needs to operate.
		const target = e.target instanceof Element ? e.target : null;
		if (isTextEntry(target)) return;
		if (target?.closest("select") && SELECT_KEYS.has(e.key)) return;
		if (target?.closest("button, a, input") && e.key === "Enter") return;
		if (this.recordingDialog.open) return;
		if (this.help.open && e.key !== "?" && e.key !== "h") return;

		// 1–9 load the first nine scenarios, 0 the tenth.
		const digit = Number.parseInt(e.key, 10);
		const presetIndex = digit === 0 ? 9 : digit - 1;
		if (presetIndex >= 0 && presetIndex < Math.min(10, PRESETS.length)) {
			this.loadPreset(PRESETS[presetIndex].id);
			return;
		}
		/** @returns {[number, number]} */
		const center = () => [this.camera.width / 2, this.camera.height / 2];
		/** @type {Record<string, () => void>} */
		const bindings = {
			" ": () => this.togglePause(),
			".": () => this.stepOnce(),
			n: () => this.stepOnce(),
			p: () => this.#changeSettings({ tool: "planet" }),
			s: () => this.#changeSettings({ tool: "scenario" }),
			m: () => this.#changeSettings({ tool: "pan" }),
			r: () => this.fitView(),
			c: () => this.clear(),
			g: () => this.toggleSettings(),
			h: () => this.toggleHelp(),
			"?": () => this.toggleHelp(),
			v: () => void this.toggleRecording(),
			a: () => this.toggleSound(),
			d: () => this.randomizeSettings(),
			l: () => void this.share(),
			f: () => {
				const order = Object.keys(SCHEMA.follow.options).filter(
					(mode) => mode !== "selected" || this.selectedId !== null,
				);
				const next = order[(order.indexOf(this.settings.follow) + 1) % order.length];
				this.#changeSettings({ follow: next });
				this.toast.show(`Follow: ${SCHEMA.follow.options[next]}`, 1200);
			},
			"+": () => this.camera.zoomAt(...center(), 1.25),
			"=": () => this.camera.zoomAt(...center(), 1.25),
			"-": () => this.camera.zoomAt(...center(), 0.8),
			"]": () => this.#changeSpeed(1.25),
			"[": () => this.#changeSpeed(0.8),
			Delete: () => this.deleteSelected(),
			Backspace: () => this.deleteSelected(),
			Escape: () => (this.input.aiming ? this.input.cancelAim() : this.select(null)),
		};
		const action = bindings[e.key.length === 1 ? e.key.toLowerCase() : e.key];
		if (action) {
			e.preventDefault();
			if (e.repeat && e.key === " ") return; // holding Space shouldn't flicker pause
			action();
		}
	}

	/** @param {number} factor */
	#changeSpeed(factor) {
		this.#changeSettings({ speed: Math.round(this.settings.speed * factor * 10) / 10 || 0.1 });
		this.toast.show(`Speed ×${this.settings.speed}`, 1000);
	}

	// ----------------------------------------------------------------- frame

	/** Frames in a row that failed. */
	#frameErrors = 0;
	/** Earliest time (`performance.now()`) to try recreating a lost renderer again. */
	#retryRendererAt = 0;

	/** @param {number} now */
	#frame = (now) => {
		try {
			this.#drawFrame(now);
			this.#frameErrors = 0;
		} catch (error) {
			// Keep going: one bad frame (say, while the GPU recovers from a reset)
			// mustn't stop the animation for good.
			if (this.#frameErrors++ === 0) {
				console.error(error);
				this.toast.show("Something went wrong drawing; still trying…", 3000);
			}
		}
		requestAnimationFrame(this.#frame);
	};

	/** @param {number} now */
	#drawFrame(now) {
		const elapsed = Math.min(0.25, Math.max(0, (now - this.#lastFrame) / 1000));
		this.#lastFrame = now;
		this.#framesDrawn++;

		this.#requestPhysics(elapsed);
		const steps = this.client.takeStepsApplied();
		this.#stepsApplied += steps;
		this.#trackSelection();
		const focus = this.#followCamera();

		if (this.renderer.lost && now >= this.#retryRendererAt) {
			// The GPU context was lost (driver reset, too many contexts, ...): start
			// afresh, at most once a second if the GPU isn't ready again yet.
			this.#retryRendererAt = now + 1000;
			console.warn("WebGL context lost; recreating the renderer.");
			this.#replaceRenderer();
		}
		if (!this.camera.equals(this.#lastCamera)) {
			this.renderer.reproject(this.#lastCamera, this.camera);
			this.#lastCamera = this.camera.snapshot();
		}
		if (this.#clearTrailsAt !== null && this.client.caughtUp(this.#clearTrailsAt)) {
			this.renderer.clearTrails();
			this.#clearTrailsAt = null;
		}
		this.#collectImpacts(now);
		const bodies = this.client.bodies;
		this.renderer.fade(this.#trailSurvival(steps));
		this.renderer.drawTrails(bodies, this.camera);
		this.renderer.present(bodies, this.camera);
		for (const b of bodies) {
			b.lx = b.x;
			b.ly = b.y;
		}
		const selected = this.selectedId === null ? undefined : this.#bodyById(this.selectedId);
		this.overlay.draw(this.camera, {
			focus,
			selected: selected ?? null,
			flashes: this.#flashScene(now),
			quadTree: this.#showQuadTree() ? this.client.quadTree : null,
			...this.#aimScene(),
		});

		if (this.recorder.recording) {
			this.recorder.captureFrame(now);
			byId("rec-time", HTMLElement).textContent = formatClock(this.recorder.seconds);
			if (this.recorder.seconds > MAX_RECORDING_SECONDS) void this.#finishRecording();
		}
		if (now - this.#lastHud >= HUD_INTERVAL_MS) this.#updateHud(now);
	}

	/**
	 * Asks the physics engine for as many fixed-size steps as real time calls for. Only
	 * one request is in flight at a time; if physics can't keep up, the backlog is
	 * dropped and the simulation runs in slow motion instead of spiralling.
	 *
	 * @param {number} elapsed Real seconds since the last frame.
	 */
	#requestPhysics(elapsed) {
		const dt = this.#stepSize();
		if (!this.paused) {
			this.#timeAccumulator += elapsed * SIM_TIME_PER_SECOND * this.settings.speed;
			this.#timeAccumulator = Math.min(this.#timeAccumulator, MAX_STEPS_PER_REQUEST * 2 * dt);
		}
		if (this.client.busy) return;
		let steps = Math.min(Math.floor(this.#timeAccumulator / dt), MAX_STEPS_PER_REQUEST);
		if (this.#pendingSingleStep) steps = Math.max(steps, 1);
		const sent = this.client.advance({
			steps,
			dt,
			budgetMs: this.client.mode === "worker" ? WORKER_BUDGET_MS : MAIN_THREAD_BUDGET_MS,
			diagnostics: this.#wantDiagnostics,
			quadTree: this.#showQuadTree(),
		});
		if (sent) {
			this.#timeAccumulator = Math.max(0, this.#timeAccumulator - steps * dt);
			this.#lastStepSize = dt;
			this.#pendingSingleStep = false;
			this.#wantDiagnostics = false;
		}
	}

	/** The quadtree is only drawn while Barnes–Hut (which builds it) is in use. */
	#showQuadTree() {
		return (
			this.settings.showQuadTree &&
			usesBarnesHut(this.settings.solver, this.client.bodies.length)
		);
	}

	/**
	 * Physics step size: the time-step setting, made smaller at slow speeds so motion
	 * stays smooth. The speed setting changes how much simulated time passes per real
	 * second; the time step only trades accuracy for CPU.
	 */
	#stepSize() {
		const perSecond = SIM_TIME_PER_SECOND * this.settings.speed;
		return Math.min(this.settings.timeStep, perSecond / MIN_STEPS_PER_SECOND);
	}

	/**
	 * Turns the collisions the physics reported into sounds and flashes.
	 *
	 * @param {number} now
	 */
	#collectImpacts(now) {
		let impacts = this.client.takeImpacts();
		// Still waiting for the first frame after a clear or scenario change: these
		// collisions happened in the old simulation.
		if (this.#clearTrailsAt !== null) impacts = [];
		const { width, height } = this.camera;
		// Even with none, so the collision texture fades out when they stop.
		this.sound.impacts(impacts, IMPACT_STRIDE, IMPACT_BOUNCE, (x, y) => {
			const screen = this.camera.worldToScreen(x, y);
			return {
				pan: (screen.x / width) * 2 - 1,
				visible: screen.x >= 0 && screen.x <= width && screen.y >= 0 && screen.y <= height,
			};
		});
		for (let o = 0; o < impacts.length; o += IMPACT_STRIDE) {
			const mass = impacts[o + 3];
			this.#flashes.push({
				x: impacts[o + 1],
				y: impacts[o + 2],
				size: radiusForMass(mass),
				bounce: impacts[o] === IMPACT_BOUNCE,
				start: now,
			});
		}
		if (this.#flashes.length > MAX_FLASHES) {
			this.#flashes.splice(0, this.#flashes.length - MAX_FLASHES);
		}
	}

	/** Collision flashes still showing, with their age (0 new … 1 gone). @param {number} now */
	#flashScene(now) {
		this.#flashes = this.#flashes.filter((f) => now - f.start < FLASH_MS);
		return this.#flashes.map((f) => ({ ...f, age: (now - f.start) / FLASH_MS }));
	}

	/**
	 * Fraction of trail brightness kept after `steps` physics steps. Trails are tied to
	 * simulated time, so they freeze when paused and keep their shape at any speed;
	 * the trail length sets how long they last at 1× speed (or forever).
	 *
	 * @param {number} steps
	 */
	#trailSurvival(steps) {
		if (steps === 0) return 1;
		const seconds = trailSeconds(this.settings.trailLength);
		if (seconds <= 0) return 0;
		if (seconds === Infinity) return 1;
		const simulated = steps * this.#lastStepSize;
		return Math.exp((-TRAIL_FADE_EXPONENT * simulated) / (seconds * SIM_TIME_PER_SECOND));
	}

	/** @param {number} id */
	#bodyById(id) {
		return this.client.bodies.find((b) => b.id === id);
	}

	/**
	 * Keeps the selection on the "same" body across merges: if the selected body
	 * disappears, the body that absorbed it (nearest to where it was) takes over.
	 */
	#trackSelection() {
		if (this.selectedId === null || !this.#selectedLast) return;
		const body = this.#bodyById(this.selectedId);
		if (body) {
			Object.assign(this.#selectedLast, {
				x: body.x,
				y: body.y,
				r: body.r,
				revision: this.client.revision,
			});
			return;
		}
		if (this.client.revision === this.#selectedLast.revision) return; // frame not in yet
		const last = this.#selectedLast;
		let heir;
		let best = last.r * 3 + 20;
		for (const b of this.client.bodies) {
			const d = Math.hypot(b.x - last.x, b.y - last.y) - b.r;
			if (d < best) {
				best = d;
				heir = b;
			}
		}
		if (heir) {
			this.selectedId = heir.id;
			last.revision = this.client.revision;
			this.#updateInspector();
		} else {
			this.toast.show("The selected body is gone", 1500);
			this.select(null);
		}
	}

	#updateInspector() {
		const body = this.selectedId === null ? undefined : this.#bodyById(this.selectedId);
		if (!body) return;
		const others = this.client.bodies.filter((b) => b !== body);
		const around = dominantBody(others, body.x, body.y);
		this.inspector.show({
			body,
			aroundId: around?.id ?? null,
			orbit: around ? orbitalElements(body, around, this.client.config.G) : null,
			following: this.settings.follow === "selected",
		});
	}

	/** @returns {{ x: number, y: number, r: number } | null} */
	#followCamera() {
		const mode = this.settings.follow;
		const bodies = this.client.bodies;
		if (mode === "off" || bodies.length === 0) return null;
		/** @type {Body | undefined} */
		let target;
		if (mode === "heaviest") {
			for (const b of bodies) if (!target || b.m > target.m) target = b;
		} else if (mode === "selected") {
			target = this.selectedId === null ? undefined : this.#bodyById(this.selectedId);
		}
		if (target) {
			this.camera.centerOn(target.x, target.y);
			return mode === "selected" ? null : target; // the selection ring already marks it
		}
		if (mode === "com") {
			const c = centerOfMass(bodies);
			this.camera.centerOn(c.x, c.y);
		}
		return null;
	}

	#aimScene() {
		const aim = this.aim;
		if (!aim) return { aim: null, preview: null };
		const { vx, vy, orbit } = this.#aimVelocity(aim);
		const stamp = aim.kind === "scenario" ? this.#currentStamp() : null;
		const mass = stamp ? stamp.mass : this.settings.mass;
		const radius = stamp ? stamp.radius : radiusForMass(mass);
		// The arrow shows the launch velocity; the rubber band runs from the body back to
		// the pointer, opposite the arrow.
		const scale = orbit ? 0.25 : 1;
		const end = { x: aim.start.x + vx * scale, y: aim.start.y + vy * scale };
		const band = orbit ? null : this.camera.screenToWorld(aim.pointer.x, aim.pointer.y);

		let preview = null;
		if (this.settings.showPreview) {
			let bodies = this.client.bodies;
			if (bodies.length > PREVIEW_MAX_BODIES) {
				bodies = [...bodies].sort((a, b) => b.m - a.m).slice(0, PREVIEW_MAX_BODIES);
			}
			const state = (this.#previewState = loadState(bodies, this.#previewState));
			// Per step: ~4 force evaluations over the moving bodies plus the fixed ones.
			const moving = Math.min(PREVIEW_MOVERS, state.n) + 1;
			const costPerStep = 4 * ((moving * moving) / 2 + Math.max(0, state.n - PREVIEW_MOVERS));
			// Coarser steps than the simulation when needed to see far enough ahead; the
			// prediction adds substeps of its own during close passes.
			const dt = Math.max(this.settings.timeStep, PREVIEW_HORIZON / PREVIEW_MAX_STEPS);
			const steps = Math.min(
				Math.ceil(PREVIEW_HORIZON / dt),
				Math.floor(PREVIEW_BUDGET / costPerStep),
			);
			if (steps > 1) {
				preview = predictTrajectory(state, {
					x: aim.start.x,
					y: aim.start.y,
					vx,
					vy,
					radius,
					mass,
					dt,
					steps,
					G: this.client.config.G,
					stopOnImpact: this.settings.mergeChance + this.settings.bounceChance > 0,
					integrator: this.settings.integrator,
					maxMovers: PREVIEW_MOVERS,
				});
			}
		}

		return {
			aim: {
				kind: aim.kind,
				start: aim.start,
				end,
				band,
				radius,
				ghost: stamp?.bodies ?? null,
				color: this.settings.randomColors ? "#ffffff" : this.settings.color,
				orbit,
			},
			preview,
		};
	}

	/** @param {number} now */
	#updateHud(now) {
		this.#lastHud = now;
		this.#fpsMeter.sample(now, this.#framesDrawn);
		if (this.paused) {
			// Don't let the pause drag the averages down after resuming.
			this.#stepMeter.reset();
			this.#simTimeMeter.reset();
		} else {
			this.#stepMeter.sample(now, this.#stepsApplied);
			this.#simTimeMeter.sample(now, this.client.time);
		}
		this.#wantDiagnostics = true; // ask for fresh energy numbers with the next request
		if (this.inspector.visible) this.#updateInspector();

		const n = this.client.bodies.length;
		const energy = this.#energy;
		const diagnostics = this.client.diagnostics;
		if (n === 0 || !diagnostics || diagnostics.bodies !== n) {
			energy.key = "";
			energy.drift = Number.NaN;
		} else if (diagnostics !== this.#lastDiagnostics) {
			this.#lastDiagnostics = diagnostics;
			const { total, potential, kinetic } = diagnostics;
			// Restart the measurement whenever energy may legitimately change.
			const s = this.settings;
			const key = [
				this.client.revision,
				s.integrator,
				s.solver,
				s.theta,
				s.mergeChance,
				s.bounceChance,
				s.restitution,
				s.drag,
				s.timeStep,
				s.adaptive,
				s.maxSubsteps,
			].join("|");
			if (key === energy.key) {
				// Normalised by KE + |U| rather than |E|: E can be close to zero (e.g. a nearly
				// parabolic encounter), and |U| alone is tiny for widely separated bodies; both
				// would blow a small error up into a huge percentage.
				energy.drift = (total - energy.baseline) / energy.scale;
			} else {
				// Just (re)started: no meaningful drift yet. With constant merging this
				// stays "–" rather than pretending energy is perfectly conserved.
				energy.key = key;
				energy.baseline = total;
				energy.scale = kinetic + Math.abs(potential) || 1;
				energy.drift = Number.NaN;
			}
		}

		this.hud.update({
			bodies: n,
			fps: this.#fpsMeter.rate,
			time: this.client.time,
			stepsPerSecond: this.#stepMeter.rate,
			simSpeed: this.#simTimeMeter.rate / SIM_TIME_PER_SECOND,
			speed: this.settings.speed,
			substeps: this.client.substeps,
			energyDrift: energy.drift,
			paused: this.paused,
			threads: this.client.threads,
		});
	}
}

/**
 * @param {ReadonlyArray<Body>} bodies
 * @returns {Point}
 */
function centerOfMass(bodies) {
	let m = 0;
	let x = 0;
	let y = 0;
	for (const b of bodies) {
		m += b.m;
		x += b.m * b.x;
		y += b.m * b.y;
	}
	return m > 0 ? { x: x / m, y: y / m } : { x: 0, y: 0 };
}

function timestamp() {
	return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

/** @param {number} bytes */
function megabytes(bytes) {
	return bytes < 1024 * 1024
		? `${Math.ceil(bytes / 1024)} KB`
		: `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** @param {number} seconds */
function formatClock(seconds) {
	const s = Math.floor(seconds);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

ensureCrossOriginIsolation();

try {
	const app = new App();
	void app.start();
	// Debugging handle: inspect or script the simulation from the browser console.
	Object.defineProperty(window, "nbody", { value: app, configurable: true });
} catch (error) {
	console.error(error);
	const fallback = document.getElementById("fatal");
	if (fallback) {
		fallback.hidden = false;
		const message = error instanceof Error ? error.message : String(error);
		fallback.textContent = message.includes("WebGL")
			? "Sorry, this simulation needs WebGL 2, which this browser doesn't provide."
			: `Sorry, the simulation could not start: ${message}`;
	}
}
