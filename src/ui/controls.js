import GUI from "../../vendor/lil-gui/lil-gui.esm.min.js";
import { getPreset } from "../physics/presets.js";
import { SCHEMA } from "../settings.js";

/** @typedef {import('../settings.js').Settings} Settings */
/** @typedef {import('../settings.js').SettingKey} SettingKey */
/** @typedef {import('../settings.js').Field} Field */

/**
 * @typedef {object} PanelActions
 * @property {() => void} restartScenario
 * @property {() => void} togglePause
 * @property {() => void} stepOnce
 * @property {() => void} fitView
 * @property {() => void} clear
 * @property {() => void} saveImage
 * @property {() => void} share
 * @property {() => void} toggleRecording
 * @property {() => void} resetSettings
 * @property {() => void} randomizeSettings
 */

/**
 * @typedef {object} ControlPanel
 * @property {() => void} refresh Re-reads every value from the settings object.
 * @property {(visible: boolean) => void} setVisible
 * @property {() => boolean} isVisible
 */

/**
 * Builds the settings panel from {@link SCHEMA}.
 *
 * @param {Settings} settings Edited in place.
 * @param {PanelActions} actions
 * @param {(key: SettingKey) => void} onChange
 * @returns {ControlPanel}
 */
export function createControlPanel(settings, actions, onChange) {
	const gui = new GUI({ title: "Settings", width: 300 });
	gui.domElement.id = "settings-panel";

	/**
	 * @param {GUI} folder
	 * @param {SettingKey} key
	 */
	const add = (folder, key) => {
		const field = /** @type {Field} */ (SCHEMA[key]);
		const controller = addField(folder, key, field);
		if (field.hint) controller.domElement.title = field.hint;
		return controller;
	};

	/**
	 * @param {GUI} folder
	 * @param {SettingKey} key
	 * @param {Field} field
	 */
	const addField = (folder, key, field) => {
		switch (field.type) {
			case "number": {
				const c = folder.add(settings, key, field.min, field.max, field.step);
				if (field.step === undefined) c.decimals(4);
				return c.name(field.label);
			}
			case "enum":
				// lil-gui wants { label: value }.
				return folder
					.add(
						settings,
						key,
						Object.fromEntries(
							Object.entries(field.options).map(([v, label]) => [label, v]),
						),
					)
					.name(field.label);
			case "boolean":
				return folder.add(settings, key).name(field.label);
			case "color":
				return folder.addColor(settings, key).name(field.label);
		}
	};

	/**
	 * @param {GUI} folder
	 * @param {keyof PanelActions} action
	 * @param {string} name
	 * @param {string} hint
	 */
	const button = (folder, action, name, hint) => {
		const controller = folder.add(actions, action).name(name);
		controller.domElement.title = hint;
		return controller;
	};

	button(
		gui,
		"randomizeSettings",
		"🎲 Randomize settings",
		"Roll random collision chances, bounciness, drag, speed, trails, planet mass and colors, and background (D). Accuracy, performance and sound settings stay as they are; Reset settings undoes it.",
	);

	const scenario = gui.addFolder("Scenario");
	const preset = add(scenario, "preset");
	button(
		scenario,
		"restartScenario",
		"↻ Restart scenario",
		"Load the current scenario again from the start.",
	);

	const create = gui.addFolder("New bodies");
	add(create, "tool");
	add(create, "mass");
	add(create, "color");
	add(create, "randomColors");
	add(create, "tapToOrbit");

	const physics = gui.addFolder("Physics");
	add(physics, "integrator");
	add(physics, "solver");
	const theta = add(physics, "theta");
	const quadTree = add(physics, "showQuadTree");
	add(physics, "timeStep");
	add(physics, "speed");
	add(physics, "adaptive");
	const maxSubsteps = add(physics, "maxSubsteps");
	add(physics, "drag");

	// What touching bodies do: chances of merging and bouncing, and the rest (shown,
	// not edited) pass through.
	const collisions = gui.addFolder("Collisions");
	add(collisions, "mergeChance");
	add(collisions, "bounceChance");
	const derived = { passThrough: 0 };
	const passThrough = collisions
		.add(derived, "passThrough", 0, 1, 0.05)
		.name("Pass through")
		.disable();
	passThrough.domElement.title =
		"Chance that touching bodies pass through each other: whatever the merge and bounce chances leave.";
	const restitution = add(collisions, "restitution");

	const view = gui.addFolder("View");
	add(view, "trailLength");
	add(view, "follow");
	add(view, "showPreview");
	add(view, "background");
	add(view, "showHud");

	const sound = gui.addFolder("Sound");
	add(sound, "sound");
	add(sound, "musicVolume");
	add(sound, "effectsVolume");

	const run = gui.addFolder("Actions");
	button(run, "togglePause", "Pause / resume", "Pause or resume the simulation (Space).");
	button(
		run,
		"stepOnce",
		"Step once",
		"Advance by a single physics step, handy while paused (. or N).",
	);
	button(run, "fitView", "Fit view", "Zoom and pan so every body is in view (R).");
	button(run, "clear", "Remove all bodies", "Delete every body and start from empty space (C).");
	button(run, "saveImage", "Save image", "Download the current view as a PNG image.");
	button(
		run,
		"toggleRecording",
		"Record / stop video",
		"Start or stop recording the view as a video and an animated GIF (V).",
	);
	button(
		run,
		"share",
		"Copy share link",
		"Copy a link that reopens this simulation as it is now: bodies, settings and view (L).",
	);
	button(
		run,
		"resetSettings",
		"Reset settings",
		"Put every setting back to its default, keeping the settings the current scenario needs (such as Barnes–Hut for the big galaxies).",
	);

	// The scenario dropdown also describes the scenario it shows.
	const describePreset = () => {
		preset.domElement.title = `${getPreset(settings.preset).description}\n\n${SCHEMA.preset.hint}`;
	};
	describePreset();

	const updateVisibility = () => {
		const tree = settings.solver !== "direct"; // Barnes–Hut, or Auto with many bodies
		theta.show(tree);
		quadTree.show(tree);
		restitution.show(settings.bounceChance > 0);
		derived.passThrough = Math.max(
			0,
			Math.round((1 - settings.mergeChance - settings.bounceChance) * 1e6) / 1e6,
		);
		passThrough.updateDisplay();
		maxSubsteps.show(settings.adaptive);
	};
	updateVisibility();

	gui.onChange(({ property }) => {
		if (typeof property !== "string" || !Object.hasOwn(SCHEMA, property)) return;
		updateVisibility();
		if (property === "preset") describePreset();
		onChange(/** @type {SettingKey} */ (property));
	});

	return {
		refresh() {
			for (const controller of gui.controllersRecursive()) controller.updateDisplay();
			updateVisibility();
			describePreset();
		},
		setVisible(visible) {
			gui.show(visible);
		},
		isVisible() {
			return !gui._hidden;
		},
	};
}

/**
 * @typedef {object} Toolbar
 * @property {(state: { paused: boolean, tool: string, settingsOpen: boolean, scenario: string }) => void} sync
 */

/**
 * Wires the bottom toolbar: buttons (`data-action` / `data-tool`) and the picker for
 * the scenario the scenario tool adds.
 *
 * @param {HTMLElement} root
 * @param {{ onAction: (action: string) => void, onTool: (tool: string) => void, onScenario: (id: string) => void }} handlers
 * @returns {Toolbar}
 */
export function bindToolbar(root, handlers) {
	root.addEventListener("click", (event) => {
		const target = /** @type {Element} */ (event.target).closest("button");
		if (!target) return;
		if (target.dataset.tool) handlers.onTool(target.dataset.tool);
		else if (target.dataset.action) handlers.onAction(target.dataset.action);
	});

	const picker = root.querySelector("#scenario-picker");
	if (picker instanceof HTMLSelectElement) {
		const { options } = SCHEMA.addScenario;
		picker.replaceChildren(
			...Object.entries(options).map(([id, name]) => {
				const option = new Option(name, id);
				option.title = getPreset(id).description;
				return option;
			}),
		);
		picker.addEventListener("change", () => {
			handlers.onScenario(picker.value);
			picker.blur(); // give the keyboard shortcuts back
		});
	}

	const pause = root.querySelector('[data-action="pause"]');
	const settings = root.querySelector('[data-action="settings"]');
	const tools = [...root.querySelectorAll("[data-tool]")];

	return {
		sync({ paused, tool, settingsOpen, scenario }) {
			root.dataset.activeTool = tool;
			if (picker instanceof HTMLSelectElement) {
				picker.value = scenario;
				picker.title = `Scenario to add: ${getPreset(scenario).description}`;
			}
			if (pause) {
				pause.setAttribute("aria-pressed", String(paused));
				pause.setAttribute("aria-label", paused ? "Resume" : "Pause");
			}
			settings?.setAttribute("aria-expanded", String(settingsOpen));
			for (const button of tools) {
				button.setAttribute(
					"aria-pressed",
					String(/** @type {HTMLElement} */ (button).dataset.tool === tool),
				);
			}
		},
	};
}
