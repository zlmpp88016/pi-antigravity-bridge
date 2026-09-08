// Child-death forensics for the stream-json driver (src/driver.ts).
//
// 1. A dying process often leaves its last line unterminated; the exit handler
//    must replay the trailing stdout buffer instead of dropping it, or agy's
//    real final error degrades to a bare "agy exited with status N".
// 2. A death with the turn open and no result frame is flagged unexpectedDeath
//    so the provider resets the (possibly poisoned) conversation binding
//    instead of resuming into the same death.
//
// Drives AgyDriver against per-test fake `agy` scripts resolved via PATH,
// mirroring tests/driver.test.ts (POSIX-only by construction, like the
// existing fake-agy-bin helper).
//
// Run: npm test

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { AgyDriver } from "../src/driver.js";
import type { TurnOutcome } from "../src/driver-types.js";

/** Install `script` as executable `agy` at the front of PATH; returns a
 *  restore function. The read-then-die shape avoids stdin-EPIPE races: the
 *  script consumes the prompt line before exiting, so the exit handler - not
 *  the stdin error handler - settles the turn. The sleep lets the final bytes
 *  reach the parent pipe before the exit event fires. */
function installFakeAgy(script: string): () => void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-exit-"));
	fs.writeFileSync(path.join(dir, "agy"), script, { mode: 0o755 });
	const prev = process.env.PATH ?? "";
	process.env.PATH = `${dir}${path.delimiter}${prev}`;
	return () => {
		process.env.PATH = prev;
	};
}

async function runOnce(): Promise<TurnOutcome> {
	const driver = new AgyDriver();
	const handle = await driver.run({
		prompt: "hi",
		cwd: process.cwd(),
		model: "gemini-3.8-flash",
		mode: "accept-edits",
		skipPermissions: true,
		timeoutMin: 1,
		inactivityMin: 1,
	});
	for (;;) {
		const activity = await handle.next();
		if (activity === null) break;
	}
	return handle.outcome;
}

test("exit replays an unterminated final error line instead of reporting the bare status", async () => {
	const restore = installFakeAgy(
		"#!/usr/bin/env bash\n" +
			"read -r _line\n" +
			`printf '%s' '{"event":"result","result":{"status":"ERROR","error":"timeout waiting for response"}}'\n` +
			"sleep 0.3\n" +
			"exit 1\n",
	);
	try {
		const outcome = await runOnce();
		assert.equal(outcome.status, "ERROR");
		assert.equal(outcome.error, "timeout waiting for response");
		assert.equal(outcome.unexpectedDeath, undefined);
	} finally {
		restore();
	}
});

test("silent exit on an open turn reports the status and flags unexpected death", async () => {
	const restore = installFakeAgy("#!/usr/bin/env bash\nread -r _line\nsleep 0.2\nexit 1\n");
	try {
		const outcome = await runOnce();
		assert.equal(outcome.status, "ERROR");
		assert.equal(outcome.error, "agy exited with status 1");
		assert.equal(outcome.unexpectedDeath, true);
	} finally {
		restore();
	}
});

test("an instantly-dying child still reports its final error (exit/close race)", async () => {
	// No sleep: the process exits the moment it writes, so "exit" routinely
	// wins the race against the stdout delivery. The decision must wait for
	// "close" (stdio flushed), otherwise this degrades to the bare status.
	const restore = installFakeAgy(
		"#!/usr/bin/env bash\n" +
			"read -r _line\n" +
			`printf '%s' '{"event":"result","result":{"status":"ERROR","error":"timeout waiting for response"}}'\n` +
			"exit 1\n",
	);
	try {
		const outcome = await runOnce();
		assert.equal(outcome.status, "ERROR");
		assert.equal(outcome.error, "timeout waiting for response");
		assert.equal(outcome.unexpectedDeath, undefined);
	} finally {
		restore();
	}
});

test("a truncated garbage tail does not break the exit report", async () => {
	const restore = installFakeAgy(
		"#!/usr/bin/env bash\n" +
			"read -r _line\n" +
			`printf '%s' '{"event":"result","result":{"status":"ERR'\n` +
			"sleep 0.3\n" +
			"exit 1\n",
	);
	try {
		const outcome = await runOnce();
		assert.equal(outcome.status, "ERROR");
		assert.equal(outcome.error, "agy exited with status 1");
		assert.equal(outcome.unexpectedDeath, true);
	} finally {
		restore();
	}
});

test("a resume of a tainted conversation spawns fresh instead", async () => {
	// Phase 1 resumes conv-dead and dies silently (taints it via the child
	// binding - the turn never saw an init frame). Phase 2 asks for conv-dead
	// again and must spawn WITHOUT --conversation. The script logs its argv
	// per invocation so the test can prove what the driver actually passed.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-taint-"));
	const argvLog = path.join(dir, "argv.log");
	const diedOnce = path.join(dir, "died");
	fs.writeFileSync(
		path.join(dir, "agy"),
		"#!/usr/bin/env bash\n" +
			`echo "$@" >> "${argvLog}"\n` +
			"read -r _line\n" +
			`if [ -f "${diedOnce}" ]; then\n` +
				`printf '%s\\n' '{"event":"init","init":{"conversation_id":"conv-fresh"}}'\n` +
				`printf '%s\\n' '{"event":"result","result":{"status":"SUCCESS","response":"ok"}}'\n` +
				"exit 0\n" +
				"else\n" +
				`touch "${diedOnce}"\n` +
				"exit 1\n" +
				"fi\n",
		{ mode: 0o755 },
	);
	const prev = process.env.PATH ?? "";
	process.env.PATH = `${dir}${path.delimiter}${prev}`;
	try {
		const driver = new AgyDriver();
		const base = {
			prompt: "hi",
			cwd: process.cwd(),
			model: "gemini-3.8-flash",
			mode: "accept-edits",
			skipPermissions: true,
			timeoutMin: 1,
			inactivityMin: 1,
		} as const;
		const drain = async (h: { next: () => Promise<unknown> }) => {
			for (;;) {
				const a = await h.next();
				if (a === null) break;
			}
		};
		const h1 = await driver.run({ ...base, conversationId: "conv-dead" });
		await drain(h1);
		const o1 = await h1.outcome;
		assert.equal(o1.status, "ERROR");
		assert.equal(o1.unexpectedDeath, true);
		const h2 = await driver.run({ ...base, conversationId: "conv-dead" });
		await drain(h2);
		const o2 = await h2.outcome;
		assert.equal(o2.status, "OK");
		const argvLines = fs.readFileSync(argvLog, "utf8").trim().split("\n");
		assert.equal(argvLines.length, 2);
		assert.match(argvLines[0], /--conversation conv-dead/);
		assert.equal(argvLines[1].includes("--conversation"), false);
		assert.ok(
			driver.snapshot().lifecycle.some((l) => l.includes("tainted-conversation:conv-dead->fresh")),
			"lifecycle records the taint bypass",
		);
	} finally {
		process.env.PATH = prev;
	}
});
