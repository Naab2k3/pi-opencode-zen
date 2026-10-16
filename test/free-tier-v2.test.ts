import { describe, expect, test } from "bun:test";
import { freeTierHeaders, freeTierSessionId } from "../src/free-tier.ts";

describe("v2 free-tier identity", () => {
	test("uses the current CLI UA and client identity with one session header", () => {
		const headers = freeTierHeaders("ses_abc");
		expect(headers["User-Agent"]).toBe("opencode/latest/2.0.30/cli");
		expect(headers["x-opencode-client"]).toBe("cli");
		expect(headers["x-opencode-session"]).toBe("ses_abc");
		// The gate checks this duplicate header too; without it every free model 403s.
		expect(headers["x-opencode-session-id"]).toBe("ses_abc");
		expect(headers["x-session-affinity"]).toBeUndefined();
		expect(headers["x-session-id"]).toBeUndefined();
	});

	test("creates structurally valid descending session ids", () => {
		expect(freeTierSessionId()).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	});
});
