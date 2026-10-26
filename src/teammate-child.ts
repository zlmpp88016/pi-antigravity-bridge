// Teammate child registration.
//
// Pi teammate children run with `--no-extensions` and load only the extensions
// pi-maestro-teammate passes explicitly (`buildInheritedExtensionArgs`). The
// antigravity provider is registered by THIS extension at load time, so without
// a registration a teammate dispatch with `model: "antigravity/gemini-*"` dies
// with `Model "antigravity/..." not found` - the child never learned the
// provider. Registering this entry point as a child extension makes the child
// load it, and the `antigravity` provider resolves there too.
//
// The teammate package is an OPTIONAL peer: it must never become a hard
// dependency, and it must never resolve to a second copy on disk. Two copies
// would each own their own `globalThis` registry, so the registration would
// land in a registry the dispatcher never reads. Preference order:
//
//   1. package specifier resolved from this file (the copy pi itself loaded);
//   2. the known global install path under the pi agent dir;
//   3. nothing - stay silent, the rest of the bridge works unchanged.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** This extension's entry point, as a teammate child must load it. */
export function childExtensionEntry(): string {
	return fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
}

/** Candidate specifiers for the optional teammate package, in trial order. */
export function teammateCandidateSpecifiers(
	agentDir: string = defaultAgentDir(),
): string[] {
	return [
		// Resolved against THIS module, i.e. the copy pi itself loaded. A bare
		// specifier is not derivable from a URL - building one with `new URL`
		// yields a file: path relative to this file and silently loses the
		// package resolution the child dispatcher shares.
		"pi-maestro-teammate/v1/child-extensions",
		pathToFileURL(
			path.join(
				agentDir,
				"npm",
				"node_modules",
				"pi-maestro-teammate",
				"src",
				"public",
				"v1",
				"child-extensions.ts",
			),
		).href,
	];
}

export interface ChildRegistrationResult {
	registered: boolean;
	/** Specifier that resolved, when registered. */
	source?: string;
	/** Last error text, when nothing resolved. */
	error?: string;
	/** Unregisters the entry; undefined when nothing was registered. */
	dispose?: () => void;
}

export interface RegisterOptions {
	/** Overrides the pi agent dir used for the global install candidate. */
	agentDir?: string;
	/** Injectable importer so tests never touch the real module graph. */
	importer?: (specifier: string) => Promise<unknown>;
	/** Injectable entry point so tests do not depend on this file's location. */
	entry?: string;
}

type Registrar = (entry: string, options?: { tools?: readonly string[] }) => unknown;

/**
 * Bridge-owned tool names the child must keep callable.
 *
 * `antigravity` is the display-only replay wrapper: whenever agy reports a tool
 * step the bridge cannot re-execute as a native pi builtin (file edits, agy
 * commands, unmapped tools), the provider emits a toolUse against this name and
 * replays the output agy already recorded. A teammate child runs under a tools
 * allowlist built from its role, which does not mention the wrapper, so without
 * this registration every such step would fail as an unknown tool - the child
 * would answer plain questions fine and die the moment agy touched a file.
 *
 * Nothing else is added: `bridge_poll_result` and `activate_skill` are answered
 * inside the bridge and never surface as pi tools.
 */
export const TEAMMATE_CHILD_TOOLS: readonly string[] = ["antigravity"];

/**
 * Registers this extension as a teammate child extension. Best effort by
 * contract: a teammate problem must never break the bridge. Returns what
 * happened so callers and tests can assert instead of guessing from silence.
 */
export async function registerTeammateChildExtensionBestEffort(
	options: RegisterOptions = {},
): Promise<ChildRegistrationResult> {
	const importer = options.importer ?? ((specifier: string): Promise<unknown> => import(specifier));
	const entry = options.entry ?? childExtensionEntry();
	let lastError: string | undefined;
	for (const specifier of teammateCandidateSpecifiers(options.agentDir)) {
		let mod: unknown;
		try {
			mod = await importer(specifier);
		} catch (error) {
			lastError = describeError(error);
			continue;
		}
		const register = pickRegistrar(mod);
		if (!register) {
			lastError = "resolved module exposes no registerTeammateChildExtension";
			continue;
		}
		// An already-registered entry is fine: the registrar replaces its own
		// prior generation, so /reload cannot leave a stale duplicate behind.
		const dispose = register(entry, { tools: TEAMMATE_CHILD_TOOLS });
		return {
			registered: true,
			source: specifier,
			dispose: typeof dispose === "function" ? (dispose as () => void) : undefined,
		};
	}
	return { registered: false, error: lastError };
}

/**
 * Pulls the registrar off a resolved teammate module. The export is a plain
 * function; the default-wrapped shape is accepted too because the subpath
 * re-exports its own module.
 */
function pickRegistrar(mod: unknown): Registrar | undefined {
	const holder = mod as Record<string, unknown> | null | undefined;
	const direct = holder?.registerTeammateChildExtension;
	if (typeof direct === "function") return direct as Registrar;
	const wrapped = (holder?.default as Record<string, unknown> | undefined)?.registerTeammateChildExtension;
	return typeof wrapped === "function" ? (wrapped as Registrar) : undefined;
}

function describeError(error: unknown): string {
	if (error && typeof error === "object") {
		const code = (error as { code?: unknown }).code;
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.length > 0) {
			return typeof code === "string" ? `${code}: ${message}` : message;
		}
		if (typeof code === "string") return code;
	}
	return String(error);
}

function defaultAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	return configured && configured.length > 0 ? configured : path.join(os.homedir(), ".pi", "agent");
}

/** True when the global install candidate exists on disk (doctor/debug aid). */
export function teammatePackageInstalled(agentDir: string = defaultAgentDir()): boolean {
	const globalCandidate = teammateCandidateSpecifiers(agentDir)[1];
	if (!globalCandidate) return false;
	try {
		return fs.statSync(fileURLToPath(new URL(globalCandidate))).isFile();
	} catch {
		return false;
	}
}
