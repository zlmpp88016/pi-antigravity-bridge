// Retry-after-error: pi re-calls the provider with the SAME context when a turn
// dies, so the tail is the dying assistant block instead of a user message.
// Before the backscan in runTurnDriver, extractUserPrompt read the last message
// only, returned null, and the pass hard-errored "No user message to send to
// agy." - which masked the real, recoverable upstream failure and poisoned the
// rest of the session (pi wrapped it as "Retry failed after 1 attempts: ...").
//
// Regression source: 2026-09-07 incident. agy's own client died with "timeout
// waiting for response" mid-turn, pi retried, the retry became a hard error.
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
	Message,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ToolRoundTrips, createStreamSimple } from "../src/provider.js";
import { SessionStore } from "../src/sessions.js";
import type { AgyDriver, DriverActivity, DriverTurnRequest } from "../src/driver.js";

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

/** Fake driver that records every run() request and never re-enters a turn:
 *  exactly the state after agy died, where the bridge has no live turn to
 *  attach to. A recorded-request array keeps later assertions out of TS's
 *  narrowing reach across passes. */
function fakeDriver(calls: DriverTurnRequest[]) {
	const fakeHandle = {
		id: "fake-turn",
		outcome: Promise.resolve({ status: "OK" as const, response: "ok", finished: true, aborted: false }),
		next: async (): Promise<DriverActivity | null> => null,
		pushExternal: (_a: DriverActivity) => {},
	};
	return {
		get activeHandle() {
			return fakeHandle;
		},
		kickIdle: () => {},
		reentry: () => null,
		run: async (opts: DriverTurnRequest) => {
			calls.push(opts);
			return fakeHandle;
		},
	} as unknown as AgyDriver;
}

/** pi's shape for a turn that ended in error: content may be partially filled
 *  (agy streamed before it died), stopReason is "error". */
function erroredAssistant(error: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text: "I will start the subagents now." }],
		stopReason: "error",
		errorMessage: error,
		timestamp: Date.now(),
	} as unknown as Message;
}

function makeStreamSimple(driver: AgyDriver, rt: ToolRoundTrips) {
	return createStreamSimple({
		entries: [{ full: "gemini-3.6-flash", id: "gemini-flash" }],
		store: new SessionStore(tmpStorePath()),
		driver,
		roundTrips: rt,
	});
}

async function collect(stream: ReturnType<ReturnType<typeof createStreamSimple>>): Promise<AssistantMessage[]> {
	const errors: AssistantMessage[] = [];
	for await (const ev of stream) {
		if (ev.type === "error") errors.push(ev.error);
	}
	return errors;
}

const options = { cwd: process.cwd() } as unknown as SimpleStreamOptions;

test("retry: a pass on top of an errored assistant turn re-sends the newest user prompt", async () => {
	const calls: DriverTurnRequest[] = [];
	const driver = fakeDriver(calls);
	const rt = new ToolRoundTrips(driver);
	const context: Context = {
		systemPrompt: undefined,
		messages: [
			{ role: "user", content: "log every mq consume", timestamp: Date.now() },
			erroredAssistant("timeout waiting for response"),
		],
	};

	const errors = await collect(makeStreamSimple(driver, rt)(model, context, options));

	assert.equal(errors.length, 0);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].prompt, "log every mq consume");
});

test("retry: repeated failed passes keep resending instead of poisoning the session", async () => {
	const calls: DriverTurnRequest[] = [];
	const driver = fakeDriver(calls);
	const rt = new ToolRoundTrips(driver);
	const streamSimple = makeStreamSimple(driver, rt);
	const user: Message = { role: "user", content: "log every mq consume", timestamp: Date.now() } as Message;
	const context: Context = { systemPrompt: undefined, messages: [user] };

	// Pass 1: normal turn.
	assert.equal((await collect(streamSimple(model, context, options))).length, 0);

	// Passes 2-3: pi retries on top of the bridge's own error block. Each pass
	// appends one more assistant error, so the tail keeps growing past the user
	// message; the backscan must keep finding it.
	for (let pass = 2; pass <= 3; pass++) {
		context.messages.push(erroredAssistant("No user message to send to agy."));
		const errors = await collect(streamSimple(model, context, options));
		assert.equal(errors.length, 0, `pass ${pass} must not error`);
	}

	assert.equal(calls.length, 3);
	assert.deepEqual(
		calls.map((c) => c.prompt),
		["log every mq consume", "log every mq consume", "log every mq consume"],
	);
});

test("retry: an image-only user prompt keeps its images across the resend", async () => {
	const calls: DriverTurnRequest[] = [];
	const driver = fakeDriver(calls);
	const rt = new ToolRoundTrips(driver);
	const context: Context = {
		systemPrompt: undefined,
		messages: [
			{
				role: "user",
				content: [{ type: "image", data: "AAECAw==", mimeType: "image/png" }],
				timestamp: Date.now(),
			},
			erroredAssistant("timeout waiting for response"),
		],
	};

	const errors = await collect(makeStreamSimple(driver, rt)(model, context, options));

	assert.equal(errors.length, 0);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].images, [{ data: "AAECAw==", mimeType: "image/png" }]);
});

test("retry: a context with no user message at all still reports it plainly", async () => {
	const calls: DriverTurnRequest[] = [];
	const driver = fakeDriver(calls);
	const rt = new ToolRoundTrips(driver);
	const context: Context = {
		systemPrompt: undefined,
		messages: [erroredAssistant("timeout waiting for response")],
	};

	const errors = await collect(makeStreamSimple(driver, rt)(model, context, options));

	assert.equal(calls.length, 0, "nothing was sent to agy");
	assert.equal(errors.length, 1);
	assert.equal(errors[0].errorMessage, "No user message to send to agy.");
});

test("retry: late tool delivery does not resurrect the already-consumed prompt", async () => {
	const calls: DriverTurnRequest[] = [];
	const driver = fakeDriver(calls);
	const rt = new ToolRoundTrips(driver);
	// A park that died, whose toolResult lands on the next pass: the late result
	// is the payload, and the old user prompt must not ride along with it.
	const settled = rt
		.onToolCall("call-1", "AskClaude", {}, new AbortController().signal)
		.then(() => "resolved", (err: unknown) => (err instanceof Error ? err.message : "rejected"));
	rt.failAll("expired");
	await settled;
	const context: Context = {
		systemPrompt: undefined,
		messages: [
			{ role: "user", content: "peer review the plugin", timestamp: Date.now() },
			{
				role: "toolResult",
				toolCallId: "call-1",
				content: [{ type: "text", text: "REVIEW OUTPUT" }],
				isError: false,
				timestamp: Date.now(),
			} as unknown as Message,
		],
	};

	const errors = await collect(makeStreamSimple(driver, rt)(model, context, options));

	assert.equal(errors.length, 0);
	assert.equal(calls.length, 1);
	assert.match(calls[0].prompt, /Late tool delivery/);
	assert.equal(calls[0].prompt.includes("peer review the plugin"), false);
});
