import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startServer } from "../scripts/serve.js";

describe("dev server", () => {
	/** @type {{ url: string, close: () => Promise<void> }} */
	let server;
	before(async () => {
		server = await startServer({ port: 0 });
	});
	after(() => server.close());

	it("serves the app with the cross-origin isolation headers", async () => {
		const res = await fetch(server.url);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /text\/html/);
		assert.equal(res.headers.get("cross-origin-opener-policy"), "same-origin");
		assert.equal(res.headers.get("cross-origin-embedder-policy"), "require-corp");
		await res.text();
	});

	it("answers 404 for a folder without index.html, and keeps running", async () => {
		const folder = await fetch(new URL("src/", server.url));
		assert.equal(folder.status, 404);
		await folder.text();
		const missing = await fetch(new URL("nope.js", server.url));
		assert.equal(missing.status, 404);
		await missing.text();
		const again = await fetch(server.url);
		assert.equal(again.status, 200);
		await again.text();
	});

	it("refuses dot folders and dependencies", async () => {
		for (const path of [".git/config", "node_modules/.package-lock.json"]) {
			const res = await fetch(new URL(path, server.url));
			assert.equal(res.status, 403, path);
			await res.text();
		}
	});
});
