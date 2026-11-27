#!/usr/bin/env node
// Minimal static file server for local development (ES modules cannot be loaded
// from file:// URLs). No dependencies. Usage: `npm start` or `PORT=9000 npm start`.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Record<string, string>} */
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".md": "text/plain; charset=utf-8",
};

/**
 * Starts the server and resolves once it is listening.
 *
 * @param {{ port?: number, host?: string, isolate?: boolean }} [options] Port 0 picks a
 *   free port. `isolate: false` leaves out the cross-origin isolation headers, as
 *   GitHub Pages does.
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function startServer({ port = 8080, host = "127.0.0.1", isolate = true } = {}) {
	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", "http://localhost");
			let path = normalize(join(root, decodeURIComponent(url.pathname)));
			// Refuse anything outside the project directory or inside dot/dependency folders.
			const inside = path === root || path.startsWith(root + sep);
			if (!inside || /[\\/](\.|node_modules)/.test(path.slice(root.length))) {
				res.writeHead(403).end("Forbidden");
				return;
			}
			if ((await stat(path)).isDirectory()) path = join(path, "index.html");
			if (!(await stat(path)).isFile()) throw new Error("not a file"); // e.g. no index.html
			res.writeHead(200, {
				"Content-Type": TYPES[extname(path)] ?? "application/octet-stream",
				"Cache-Control": "no-store",
				// Cross-origin isolation, so physics can use several threads (shared memory).
				...(isolate && {
					"Cross-Origin-Opener-Policy": "same-origin",
					"Cross-Origin-Embedder-Policy": "require-corp",
				}),
			});
			createReadStream(path)
				.on("error", () => res.destroy()) // e.g. deleted while being sent
				.pipe(res);
		} catch {
			res.writeHead(404).end("Not found");
		}
	});
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			const address = /** @type {import('node:net').AddressInfo} */ (server.address());
			resolve({
				url: `http://${host}:${address.port}/`,
				close: () => new Promise((done) => server.close(() => done())),
			});
		});
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { url } = await startServer({
		port: Number(process.env.PORT ?? 8080),
		host: process.env.HOST ?? "127.0.0.1",
	});
	console.log(`Serving ${root}${sep} at ${url}`);
}
