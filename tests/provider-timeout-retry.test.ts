// Transient-upstream retry guard: agy's own request errors ("timeout waiting
// for response", emitted by the agy binary when its upstream model call dies)
// arrive as ERROR result frames on a healthy child. Without a breaker, every
// retry re-sends the newest user prompt into the SAME stored conversation and
// replays the same giant prompt into the same timeout ("Retry failed after N
// attempts"). The second CONSECUTIVE transient failure on one conversation
// taints it, unbinds the pi session, and recycles the child, so the next
// attempt starts fresh. A single blip retries in place; OK turns reset.
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createStreamSimple, isTransientUpstreamError, ToolRoundTrips } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { AgyDriver, DriverActivity, DriverTurnRequest, TurnOutcome } from "../src/driver.js";

const model: Model<Api> = {
	id: "gemini-flash",
	name: "Gemini 3.6 Flash (Medium)",
	api: "agy-bridge" as Api,
	provider: "antigravity",
	baseUrl: "agy-bridge://antigravity",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

function tmpStorePath(): string {
	return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-retry-")), "sessions.json");
}

function userContext(prompt: string): Context {
	return {
		systemPrompt: undefined,
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	};
}

/** Fake driver with scripted outcomes per run() call. Records requests,
 *  taint calls, and close calls for assertions. */
function scriptedDriver(script: TurnOutcome[], seen: {
	opts: DriverTurnRequest[];
	tainted: string[];
	closed: Array<{ reason: string; cause?: string }>;
}): AgyDriver {
	let n = 0;
	return {
		run: async (opts: DriverTurnRequest) => {
			seen.opts.push(opts);
			const outcome = script[Math.min(n++, script.length - 1)];
			return {
				id: `fake-turn-${n}`,
				outcome: Promise.resolve(outcome),
				next: async (): Promise<DriverActivity | null> => null,
				pushExternal: (_a: DriverActivity) => {},
			};
		},
		reentry: () => null,
		kickIdle: () => {},
		get activeHandle() {
			return null;
		},
		taintConversation: (id: string) => {
			seen.tainted.push(id);
		},
		close: async (reason: "recycle" | "shutdown", cause?: string) => {
			seen.closed.push({ reason, cause });
		},
	} as unknown as AgyDriver;
}

function errorOutcome(conv: string): TurnOutcome {
	return {
		status: "ERROR",
		response: "",
		error: "timeout waiting for response",
		conversationId: conv,
		finished: true,
		aborted: false,
	};
}

function okOutcome(conv: string): TurnOutcome {
	return {
		status: "OK",
		response: "ok",
		conversationId: conv,
		finished: true,
		aborted: false,
	};
}

async function runPass(
	streamSimple: ReturnType<typeof createStreamSimple>,
	context: Context,
): Promise<{ errors: AssistantMessage[] }> {
	const stream = streamSimple(model, context, { cwd: process.cwd() } as unknown as SimpleStreamOptions);
	const errors: AssistantMessage[] = [];
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	return { errors };
}

test("isTransientUpstreamError matches upstream timeouts, rejects fatal errors", () => {
	assert.equal(isTransientUpstreamError("timeout waiting for response"), true);
	assert.equal(isTransientUpstreamError("request timed out after 120s"), true);
	assert.equal(isTransientUpstreamError("upstream: Bad Gateway"), true);
	assert.equal(isTransientUpstreamError("socket hang up"), true);
	assert.equal(isTransientUpstreamError(undefined), false);
	assert.equal(isTransientUpstreamError(""), false);
	assert.equal(isTransientUpstreamError("No user message to send to agy."), false);
	assert.equal(isTransientUpstreamError("agy exited with status 1"), false);
});

test("second consecutive transient failure taints, unbinds, and recycles; retry goes fresh", async () => {
	const seen = { opts: [] as DriverTurnRequest[], tainted: [] as string[], closed: [] as Array<{ reason: string; cause?: string }> };
	const driver = scriptedDriver([errorOutcome("conv-1"), errorOutcome("conv-1"), okOutcome("conv-2")], seen);
	const store = new SessionStore(tmpStorePath());
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	const context = userContext("do the thing");

	// Pass 1: fresh store, so the turn starts a new conversation; the ERROR
	// outcome binds conv-1. First blip: no taint.
	const p1 = await runPass(streamSimple, context);
	assert.equal(p1.errors.length, 1);
	assert.equal(seen.opts.length, 1);
	assert.equal(seen.opts[0].conversationId, null);
	assert.deepEqual(seen.tainted, []);

	// Pass 2: resumes conv-1 and fails transiently again -> breaks the loop.
	const p2 = await runPass(streamSimple, context);
	assert.equal(p2.errors.length, 1);
	assert.equal(seen.opts[1].conversationId, "conv-1");
	assert.deepEqual(seen.tainted, ["conv-1"]);
	assert.equal(seen.closed.length, 1);
	assert.equal(seen.closed[0].reason, "recycle");

	// Pass 3: binding is gone, so the retry starts a fresh conversation.
	const p3 = await runPass(streamSimple, context);
	assert.equal(p3.errors.length, 0);
	assert.equal(seen.opts.length, 3);
	assert.equal(seen.opts[2].conversationId, null);
});

test("an OK turn resets the transient count", async () => {
	const seen = { opts: [] as DriverTurnRequest[], tainted: [] as string[], closed: [] as Array<{ reason: string; cause?: string }> };
	const driver = scriptedDriver([errorOutcome("conv-1"), okOutcome("conv-1"), errorOutcome("conv-1")], seen);
	const store = new SessionStore(tmpStorePath());
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	const context = userContext("do the thing");

	await runPass(streamSimple, context); // transient #1
	await runPass(streamSimple, context); // OK resets
	await runPass(streamSimple, context); // transient #1 again, not #2
	assert.deepEqual(seen.tainted, []);
	assert.deepEqual(seen.closed, []);
	// Pass 1 starts fresh (empty store); passes 2-3 resume the bound conv-1.
	assert.deepEqual(
		seen.opts.map((o) => o.conversationId),
		[null, "conv-1", "conv-1"],
	);
});

test("non-transient errors never taint", async () => {
	const seen = { opts: [] as DriverTurnRequest[], tainted: [] as string[], closed: [] as Array<{ reason: string; cause?: string }> };
	const fatal: TurnOutcome = {
		status: "ERROR",
		response: "",
		error: "agy exited with status 1",
		conversationId: "conv-1",
		finished: true,
		aborted: false,
	};
	const driver = scriptedDriver([fatal, fatal], seen);
	const store = new SessionStore(tmpStorePath());
	const streamSimple = createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store,
		driver,
		roundTrips: new ToolRoundTrips(driver),
	});
	const context = userContext("do the thing");

	await runPass(streamSimple, context);
	await runPass(streamSimple, context);
	assert.deepEqual(seen.tainted, []);
	assert.deepEqual(seen.closed, []);
});
