import { forcesChunk, subtreesChunk } from "../physics/barnesHut.js";
import { pairsChunk } from "../physics/collisions.js";

/**
 * Per-thread state a job may use: the thread's number (0 is the physics worker) and
 * scratch space it keeps between chunks.
 *
 * @typedef {{ index: number, scratch: Record<string, any> }} ThreadContext
 */

/**
 * The work the thread pool can split across threads, by name. Each does one chunk
 * given the job's shared data; helpers look jobs up here by the name in a message.
 */
export const JOBS = Object.freeze({
	forces: forcesChunk,
	subtrees: subtreesChunk,
	pairs: pairsChunk,
});

/** @typedef {keyof typeof JOBS} JobName */
