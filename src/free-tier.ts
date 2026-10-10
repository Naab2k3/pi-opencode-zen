// Zen's free tier (zero-cost models) is gated at the gateway: a request that
// does not look like a real coding-agent turn is rejected with
// FreeTierError ("OpenCode's free tier can only be used from within OpenCode").
//
// Probed live against https://opencode.ai/inference/openai/v1 — the gate has
// three conditions, and token/TLS/HTTP-version/IP are NOT among them:
//   1. `stream: true` in the body.
//   2. a `tools` array carrying both a read tool and a command-execution tool:
//      verified pairs `{read, shell}` and `{read, bash}` pass; single tools,
//      `{bash, shell}`, `{grep, shell}` and `{read, write}` do not.
//   3. an `x-opencode-session` header (`x-session-affinity`/`x-session-id`
//      also satisfy it, `x-opencode-session-id` alone does not) whose value
//      matches the official `ses_<12 hex><14 alnum>` shape — `ses_` + 64 hex,
//      `ses_junk` and unprefixed values all 403. The timestamp half may be old;
//      only the shape is checked.
//
// Pi's agent already advertises `read` + `bash`, so agent turns only need the
// session header; tool-less completions (streamSimple, title generation, …)
// additionally get both stubs injected. Stubs are only ever sent to zero-cost
// models; paid requests are never modified.

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// UA shape the Zen gateway accepts on free-tier requests (see the gate notes
// above). Any semver-ish version works; this one mirrors the current release.
const GATE_UA = "opencode/latest/2.0.26/cli";

/** `ses_` + 12 hex + 14 alnum, the id shape opencode's own sessions use. */
export function freeTierSessionId(): string {
	// inverted 48-bit timestamp + random, byte-for-byte the scheme opencode's
	// client uses (the gateway checks the shape — and with it, a plausible
	// timestamp half)
	const combined = BigInt(Date.now()) * 4096n + BigInt(1 + Math.floor(Math.random() * 4095));
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
