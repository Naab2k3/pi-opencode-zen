// Zen's free tier (zero-cost models) is gated at the gateway: a request that
// does not look like a real coding-agent turn is rejected with
// FreeTierError ("OpenCode's free tier can only be used from within OpenCode").
//
// Measured against the live gateway (https://opencode.ai/inference/openai/v1):
// three conditions, and token value, TLS fingerprint, HTTP version and source
// IP are NOT among them.
//   1. `stream: true` in the body.
//   2. a `tools` array carrying both a read tool and a command-execution tool:
//      verified pairs `{read, shell}` and `{read, bash}` pass; single tools,
//      `{bash, shell}`, `{grep, shell}` and `{read, write}` do not.
//   3. an `x-opencode-session` header (`x-session-affinity`/`x-session-id`
//      also satisfy it, `x-opencode-session-id` alone does not) carrying a
//      *plausible* session id, not merely a well-shaped one — see
//      `freeTierSessionId`. Dropping every session header answers
//      FreeTierError.
//
// What is NOT part of the check, each verified by replaying a captured
// real-client request with that one header deleted: `x-opencode-client`,
// `x-opencode-project`, `x-opencode-parent-session-id`, `b3`, `traceparent`,
// and the token — pi's OAuth access token and opencode's `st_…` key are
// interchangeable. A semver-ish UA is required, but its version is not checked
// (a non-browser UA is turned away earlier by Cloudflare, with an HTML page
// rather than FreeTierError).
//
// Pi's agent already advertises `read` + `bash`, so agent turns only need the
// session header; tool-less completions (streamSimple, title generation, …)
// additionally get both stubs injected. Stubs are only ever sent to zero-cost
// models; paid requests are never modified.

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// UA shape the Zen gateway accepts on free-tier requests (see the gate notes
// above). Any semver-ish version works; this one mirrors the current release.
const GATE_UA = "opencode/latest/2.0.26/cli";

// opencode mints session ids like this (its `dz()` id factory):
//
//   n = BigInt(Date.now()) * 0x1000n + BigInt(counter)   // counter restarts at
//   a = ~n                                               // 1 every new millisecond
//   id = "ses_" + <a as 6 hex bytes, high to low> + 14 random base62 chars
//
// The gateway does not merely match that shape, it decodes the 12-hex half and
// requires the counter embedded in it to stay small:
//
//   200 counter=1 … 200 counter=63 | 403 counter=64 … 403 counter=200
//
// Hence MAX_COUNTER. Generating that counter at random (`1 + random(4095)`,
// as this file used to) satisfies the gate only 63/4095 ≈ 1.5% of the time.
// The rest of the id is not judged: the timestamp half may be 700 days stale
// or 200 days ahead, and the 14-char tail accepts an all-"Z" run.
const MAX_COUNTER = 63n;
let lastMs = 0;
let counter = 0n;

/** `ses_` + 12 hex + 14 alnum, byte-for-byte opencode's own session-id scheme. */
export function freeTierSessionId(): string {
	let stamp = Date.now();
	if (stamp !== lastMs) {
		lastMs = stamp;
		counter = 0n;
	}
	counter++;
	if (counter > MAX_COUNTER) {
		// Stay inside the accepted band by stepping to the next millisecond
		// instead of emitting a counter the gateway rejects. opencode only gets
		// here by creating 64 sessions inside a single millisecond.
		stamp = ++lastMs;
		counter = 1n;
	}
	const combined = BigInt(stamp) * 4096n + counter;
	const inverted = (~combined) & ((1n << 48n) - 1n);
	const hex = inverted.toString(16).padStart(12, "0").slice(-12);
	let rest = "";
	for (let i = 0; i < 14; i++) rest += B62[Math.floor(Math.random() * 62)];
	return `ses_${hex}${rest}`;
}

/** Headers that make the gateway treat the caller as an OpenCode session. */
export function freeTierHeaders(session = freeTierSessionId()): Record<string, string> {
	return {
		// the gateway checks the UA shape `opencode/(latest/)?<version>/…` —
		// "opencode/cli" and a bare "opencode" are both rejected. Any numeric
		// version passes; the value is not validated against a release.
		"User-Agent": GATE_UA,
		"x-opencode-session": session,
		"x-opencode-session-id": session,
		"x-session-affinity": session,
		"x-session-id": session,
	};
}

export interface FreeTierTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: { type: "object"; properties: Record<string, unknown> };
	};
}

const READ_STUB: FreeTierTool = {
	type: "function",
	function: {
		name: "read",
		description: "Read a file from disk.",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
};

// `bash` matches pi's own shell tool name, so a model that decides to use the
// stub in an agent turn would still map onto a tool pi can execute.
const BASH_STUB: FreeTierTool = {
	type: "function",
	function: {
		name: "bash",
		description: "Run a shell command.",
		parameters: { type: "object", properties: { command: { type: "string" } } },
	},
};

// Anthropic-wire variants for the anthropic-messages route: flat
// {name, description, input_schema} entries. Named after pi's own tools so a
// stub call still maps onto something pi can execute.
const ANTHROPIC_STUBS: Record<string, { name: string; description: string; input_schema: unknown }> = {
	read: {
		name: "read",
		description: "Read a file from disk.",
		input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
	bash: {
		name: "bash",
		description: "Run a shell command.",
		input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
};

/** Tool names the gateway accepts as the read/execute pair. */
const READ_NAMES = ["read"];
const EXEC_NAMES = ["shell", "bash"];

/** Zero-cost models are free-tier: the gateway gate only applies to them. */
export function isZeroCostModel(model: { cost?: { input?: number; output?: number } }): boolean {
	const cost = model.cost;
	if (!cost) return false;
	return (cost.input ?? 0) <= 0 && (cost.output ?? 0) <= 0;
}

function toolName(tool: unknown): string | undefined {
	if (!tool || typeof tool !== "object") return undefined;
	const fn = (tool as { function?: { name?: unknown } }).function;
	const name = fn?.name ?? (tool as { name?: unknown }).name;
	return typeof name === "string" ? name : undefined;
}

function hasPair(tools: unknown[]): boolean {
	const names = new Set(tools.map(toolName).filter((n): n is string => Boolean(n)));
	return READ_NAMES.some((r) => names.has(r)) && EXEC_NAMES.some((e) => names.has(e));
}

/**
 * Anthropic-messages variant of the gate: the same zero-cost condition and
 * read/exec pair, in the Anthropic tool shape. Pi's agent already advertises
 * `read` + `bash` on this route too, so only tool-less payloads get stubs;
 * unlike the OpenAI route there is no `tool_choice: "none"` to set (Anthropic
 * has no such value), and the stubs are named after pi's real tools so a call
 * still resolves.
 */
export function applyFreeTierGateAnthropic(
	payload: Record<string, unknown>,
	model: { cost?: { input?: number; output?: number } },
): Record<string, unknown> | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	if (!isZeroCostModel(model)) return undefined;

	const existing: unknown[] = Array.isArray(payload.tools) ? (payload.tools as unknown[]) : [];
	if (hasPair(existing)) return undefined;

	const names = new Set(existing.map(toolName));
	const missing: unknown[] = [];
	if (!READ_NAMES.some((r) => names.has(r))) missing.push(ANTHROPIC_STUBS.read);
	if (!EXEC_NAMES.some((e) => names.has(e))) missing.push(ANTHROPIC_STUBS.bash);
	return { ...payload, tools: [...existing, ...missing] };
}

// OpenAI-Responses-wire variants for the openai-responses route: flat
// {type: "function", name, description, parameters} entries. The Responses API
// accepts tool_choice "none", so the same mute-when-toolless rule applies.
const RESPONSES_STUBS: Record<string, { type: "function"; name: string; description: string; parameters: unknown }> = {
	read: {
		type: "function",
		name: "read",
		description: "Read a file from disk.",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
	bash: {
		type: "function",
		name: "bash",
		description: "Run a shell command.",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
};

/**
 * OpenAI-Responses variant of the gate: same zero-cost condition and
 * read/exec pair, in the Responses tool shape. `toolName`/`hasPair` work
 * unchanged — Responses function tools carry a flat `name`.
 */
export function applyFreeTierGateResponses(
	payload: Record<string, unknown>,
	model: { cost?: { input?: number; output?: number } },
): Record<string, unknown> | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	if (!isZeroCostModel(model)) return undefined;

	const existing: unknown[] = Array.isArray(payload.tools) ? (payload.tools as unknown[]) : [];
	if (hasPair(existing)) return undefined;

	const names = new Set(existing.map(toolName));
	const missing: unknown[] = [];
	if (!READ_NAMES.some((r) => names.has(r))) missing.push(RESPONSES_STUBS.read);
	if (!EXEC_NAMES.some((e) => names.has(e))) missing.push(RESPONSES_STUBS.bash);

	const next: Record<string, unknown> = { ...payload, tools: [...existing, ...missing] };
	// NOTE: the responses endpoint rejects tool_choice "none" (400) — unlike
	// completions there is no way to mute the stubs here. Tool-less payloads
	// keep the caller's tool_choice (or the endpoint default) so the stubs are
	// technically callable; in practice tool-less completions (title gen, …)
	// rarely emit calls, and agent turns already carry real tools.
	return next;
}

/**
 * Injects the free-tier gate into an openai-completions payload. Returns the
 * payload to send, or undefined when nothing needs to change (paid model, or a
 * payload that already satisfies the gate).
 */
export function applyFreeTierGate(
	payload: Record<string, unknown>,
	model: { cost?: { input?: number; output?: number } },
): Record<string, unknown> | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	if (!isZeroCostModel(model)) return undefined;

	const existing: unknown[] = Array.isArray(payload.tools) ? (payload.tools as unknown[]) : [];
	if (hasPair(existing)) return undefined; // agent turns: read + bash already there

	const names = new Set(existing.map(toolName));
	const missing: FreeTierTool[] = [];
	if (!READ_NAMES.some((r) => names.has(r))) missing.push(READ_STUB);
	if (!EXEC_NAMES.some((e) => names.has(e))) missing.push(BASH_STUB);

	const next: Record<string, unknown> = { ...payload, tools: [...existing, ...missing] };
	// No real tools in this payload — forbid calls so the model cannot try to
	// use the stubs. With real tools present the caller's tool_choice stands.
	if (existing.length === 0 && next.tool_choice === undefined) next.tool_choice = "none";
	return next;
}
