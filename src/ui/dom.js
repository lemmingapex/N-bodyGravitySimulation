/**
 * Looks up an element by id and checks its type, failing loudly if the markup and
 * the code disagree.
 *
 * @template {abstract new (...args: any) => Element} T
 * @param {string} id
 * @param {T} type
 * @returns {InstanceType<T>}
 */
export function byId(id, type) {
	const element = document.getElementById(id);
	if (!(element instanceof type)) {
		throw new Error(`Expected #${id} to be a ${type.name}.`);
	}
	return /** @type {InstanceType<T>} */ (element);
}

/**
 * `localStorage` if it is usable, otherwise `undefined` (private mode, disabled
 * cookies and sandboxed frames can all make it throw).
 *
 * @returns {Storage | undefined}
 */
export function safeLocalStorage() {
	try {
		const storage = window.localStorage;
		storage.getItem("probe");
		return storage;
	} catch {
		return undefined;
	}
}

/**
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Small transient status message ("Paused", "Image saved", ...). */
export class Toast {
	#element;
	/** @type {ReturnType<typeof setTimeout> | undefined} */
	#timer;

	/** @param {HTMLElement} element Should have `role="status"`. */
	constructor(element) {
		this.#element = element;
	}

	/**
	 * @param {string} message
	 * @param {number} [durationMs]
	 */
	show(message, durationMs = 2200) {
		this.#element.textContent = message;
		this.#element.classList.add("is-visible");
		clearTimeout(this.#timer);
		this.#timer = setTimeout(() => this.#element.classList.remove("is-visible"), durationMs);
	}
}
