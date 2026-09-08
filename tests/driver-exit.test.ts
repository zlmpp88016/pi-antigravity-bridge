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
