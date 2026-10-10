import { describe, expect, test } from "bun:test";
import { applyFreeTierGate, freeTierHeaders, freeTierSessionId, isZeroCostModel } from "../src/free-tier.ts";
import { modelFromZen } from "../src/models.ts";

// The Zen free-tier gateway (FreeTierError) accepts a request only when it is
// streamed and carries a read + exec tool pair. The adapter always streams;
// these tests pin the tool-pair injection and the paid-model bypass.

const ZERO = { cost: { input: 0, output: 0, cache_read: 0 } };
const PAID = { cost: { input: 0.15, output: 0.5 } };

describe("freeTierSessionId", () => {
	test("matches the ses_<12 hex><14 alnum> shape the gateway validates", () => {
		for (let i = 0; i < 50; i++) {
			expect(freeTierSessionId()).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		}
	});

	test("ids differ between calls", () => {
		const ids = new Set(Array.from({ length: 20 }, () => freeTierSessionId()));
		expect(ids.size).toBe(20);
	});
});

describe("freeTierHeaders", () => {
	test("carries the official UA shape plus the session headers", () => {
		const h = freeTierHeaders("ses_abc");
		expect(h["User-Agent"]).toMatch(/^opencode\/(latest\/)?[0-9]+\.[0-9]+\.[0-9]+\//);
		expect(h["x-opencode-session"]).toBe("ses_abc");
		// the gateway accepts any one of the three; send all like opencode does
		expect(h["x-session-affinity"]).toBe("ses_abc");
		expect(h["x-session-id"]).toBe("ses_abc");
	});

	test("a fresh session id is generated when none is given", () => {
		const h = freeTierHeaders();
		expect(h["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	});
});

describe("applyFreeTierGate", () => {
	test("tool-less completions get both stubs and tool_choice none", () => {
		const next = applyFreeTierGate({ model: "big-pickle", messages: [] }, { cost: ZERO.cost });
		expect(next).toBeDefined();
		expect(next!.tools).toHaveLength(2);
		expect((next!.tools as any[]).map((t) => t.function.name)).toEqual(["read", "bash"]);
		expect(next!.tool_choice).toBe("none");
	});

	test("agent payloads that already carry read + bash are untouched", () => {
		const tools = [
			{ type: "function", function: { name: "read", description: "", parameters: {} } },
			{ type: "function", function: { name: "bash", description: "", parameters: {} } },
			{ type: "function", function: { name: "edit", description: "", parameters: {} } },
		];
		expect(applyFreeTierGate({ tools, tool_choice: "auto" }, { cost: ZERO.cost })).toBeUndefined();
	});

	test("agent payloads with read + shell also satisfy the gate", () => {
		const tools = [
			{ type: "function", function: { name: "read", description: "", parameters: {} } },
			{ type: "function", function: { name: "shell", description: "", parameters: {} } },
		];
		expect(applyFreeTierGate({ tools }, { cost: ZERO.cost })).toBeUndefined();
	});

	test("a payload missing only the exec tool gets just that stub, keeping its tool_choice", () => {
		const tools = [{ type: "function", function: { name: "read", description: "", parameters: {} } }];
		const next = applyFreeTierGate({ tools, tool_choice: "auto" }, { cost: ZERO.cost });
		expect(next!.tools).toHaveLength(2);
		expect((next!.tools as any[])[1].function.name).toBe("bash");
		expect(next!.tool_choice).toBe("auto");
	});

	test("a payload missing only the read tool gets just the read stub", () => {
		const tools = [{ type: "function", function: { name: "bash", description: "", parameters: {} } }];
		const next = applyFreeTierGate({ tools }, { cost: ZERO.cost });
		expect((next!.tools as any[]).map((t) => t.function.name)).toEqual(["bash", "read"]);
	});

	test("paid models are never modified", () => {
		const payload = { model: "glm-5.3-flash", messages: [] };
		expect(applyFreeTierGate(payload, { cost: PAID.cost })).toBeUndefined();
	});

	test("a stub-only tools array is extended, not replaced", () => {
		const tools = [{ type: "function", function: { name: "grep", description: "", parameters: {} } }];
		const next = applyFreeTierGate({ tools }, { cost: ZERO.cost });
		expect((next!.tools as any[]).map((t) => t.function.name)).toEqual(["grep", "read", "bash"]);
	});

	test("the caller's own payload fields survive", () => {
		const next = applyFreeTierGate({ model: "big-pickle", stream: true, temperature: 0.5 }, { cost: ZERO.cost });
		expect(next!.model).toBe("big-pickle");
		expect(next!.stream).toBe(true);
		expect(next!.temperature).toBe(0.5);
	});
});

describe("isZeroCostModel", () => {
	test("true for free-tier catalog entries", () => {
		expect(isZeroCostModel(modelFromZen("big-pickle", { cost: { input: 0, output: 0 } }))).toBe(true);
	});

	test("false for paid entries", () => {
		expect(isZeroCostModel(modelFromZen("glm-5.3-flash", { cost: { input: 0.15, output: 0.5 } }))).toBe(false);
	});
});
