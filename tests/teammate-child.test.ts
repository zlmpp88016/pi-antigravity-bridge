// Tests for teammate child registration. The bug this guards: a teammate
// dispatch with model "antigravity/gemini-*" failed with `Model
// "antigravity/..." not found` because the child runs with --no-extensions and
// only loads extensions pi-maestro-teammate passes explicitly. These tests pin
// the two halves of the fix - the entry point handed to the child must be THIS
// extension, and an absent optional teammate package must degrade to a silent
// no-op - plus the resolution order that keeps a second package copy from
// capturing the registration.
//
// Expectations are hand-derived literals. No network, no real module graph:
// the importer is injected.

import { test } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	TEAMMATE_CHILD_TOOLS,
	childExtensionEntry,
	registerTeammateChildExtensionBestEffort,
	teammateCandidateSpecifiers,
	teammatePackageInstalled,
} from "../src/teammate-child.js";

type Call = { entry: string; options?: { tools?: readonly string[] } };

function fakeRegistrar(calls: Call[]) {
	return (entry: string, options?: { tools?: readonly string[] }) => {
		calls.push({ entry, options });
		return () => {
			calls.push({ entry: `disposed:${entry}`, options });
		};
	};
}

test("teammate-child: entry point is this package's extension entry", () => {
	const entry = childExtensionEntry();
	// The child must load the SAME extension that registers the antigravity
	// provider; pointing anywhere else reproduces the original failure.
	assert.ok(path.isAbsolute(entry), `expected an absolute path, got ${entry}`);
	assert.ok(
		entry.replace(/\\/g, "/").endsWith("/extensions/index.ts"),
		`expected .../extensions/index.ts, got ${entry}`,
	);
});

test("teammate-child: registers the bridge entry and reports the source", async () => {
	const calls: Call[] = [];
	const result = await registerTeammateChildExtensionBestEffort({
		entry: "/bridge/extensions/index.ts",
		importer: async () => ({ registerTeammateChildExtension: fakeRegistrar(calls) }),
	});
	assert.equal(result.registered, true);
	assert.equal(result.source, teammateCandidateSpecifiers()[0]);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.entry, "/bridge/extensions/index.ts");
	// The wrapper tool rides along because agy tool steps that cannot be
	// re-executed as native pi builtins replay through it; a child allowlist
	// without it fails the moment agy touches a file.
	assert.deepEqual(calls[0]?.options, { tools: TEAMMATE_CHILD_TOOLS });
	assert.deepEqual([...TEAMMATE_CHILD_TOOLS], ["antigravity"]);
});

test("teammate-child: an absent teammate package degrades to a silent no-op", async () => {
	const result = await registerTeammateChildExtensionBestEffort({
		entry: "/bridge/extensions/index.ts",
		importer: async () => {
			const error = new Error("Cannot find package 'pi-maestro-teammate'");
			(error as Error & { code?: string }).code = "ERR_MODULE_NOT_FOUND";
			throw error;
		},
	});
	// Not registered is the correct outcome when teammate is not installed: the
	// bridge must keep working, and there is nothing to warn the user about.
	assert.equal(result.registered, false);
	assert.equal(result.dispose, undefined);
	assert.match(result.error ?? "", /ERR_MODULE_NOT_FOUND/);
});

test("teammate-child: falls back to the global install when the bare specifier fails", async () => {
	const calls: Call[] = [];
	const seen: string[] = [];
	const result = await registerTeammateChildExtensionBestEffort({
		entry: "/bridge/extensions/index.ts",
		agentDir: "/agent",
		importer: async (specifier) => {
			seen.push(specifier);
			if (seen.length === 1) throw new Error("bare specifier unavailable");
			return { registerTeammateChildExtension: fakeRegistrar(calls) };
		},
	});
	assert.equal(result.registered, true);
	// First attempt is the package specifier, second the global install path:
	// resolving the copy pi actually loaded matters because the registry lives
	// on globalThis and a second copy would own a different one.
	assert.equal(seen.length, 2);
	assert.ok(!seen[0]?.startsWith("file://"), `expected a bare specifier first, got ${seen[0]}`);
	assert.equal(
		seen[1],
		pathToFileURL(
			path.join("/agent", "npm", "node_modules", "pi-maestro-teammate", "src", "public", "v1", "child-extensions.ts"),
		).href,
	);
});

test("teammate-child: a module without the registrar is not treated as success", async () => {
	const result = await registerTeammateChildExtensionBestEffort({
		entry: "/bridge/extensions/index.ts",
		importer: async () => ({ somethingElse: true }),
	});
	assert.equal(result.registered, false);
	assert.match(result.error ?? "", /no registerTeammateChildExtension/);
});

test("teammate-child: default-wrapped registrar export is accepted", async () => {
	const calls: Call[] = [];
	const result = await registerTeammateChildExtensionBestEffort({
		entry: "/bridge/extensions/index.ts",
		importer: async () => ({ default: { registerTeammateChildExtension: fakeRegistrar(calls) } }),
	});
	assert.equal(result.registered, true);
	assert.equal(calls.length, 1);
});

test("teammate-child: package presence is reported for doctor output", () => {
	// A directory that cannot exist: the global candidate is a file path, so
	// this must report false rather than throwing.
	assert.equal(teammatePackageInstalled("/definitely/not/a/pi/agent/dir"), false);
});
