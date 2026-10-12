import { describe, expect, test } from "bun:test";
import { mergeProviderAttributionHeaders } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-attribution.js";
import { modelFromZen } from "../src/models.ts";

// pi core attaches the REAL session header for any model whose baseUrl is on
// opencode.ai — no forged ses_ IDs needed. Pinned by reading
// provider-attribution.js:getSessionHeaders; this test fails if that path stops
// covering our models.
const settingsOff = { getEnableInstallTelemetry: () => false } as any;

describe("pi core session attribution covers opencode-zen models", () => {
	test("openai-completions route gets the real x-opencode-session", () => {
		const model = modelFromZen("big-pickle", { cost: { input: 0, output: 0 } });
		const headers = mergeProviderAttributionHeaders(
			model,
			settingsOff,
			"ses_realsession123",
			{ "User-Agent": "opencode/cli" },
		);
		expect(headers?.["x-opencode-session"]).toBe("ses_realsession123");
		expect(headers?.["x-opencode-client"]).toBe("pi");
	});

	test("anthropic-messages route (own baseUrl) is covered too", () => {
		const model = modelFromZen("qwen3.8-flash", {
			cost: { input: 0.15, output: 0.47 },
			provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/anthropic/v1" },
		});
		expect(model.api).toBe("anthropic-messages");
		const headers = mergeProviderAttributionHeaders(
			model,
			settingsOff,
			"ses_realsession123",
		);
		expect(headers?.["x-opencode-session"]).toBe("ses_realsession123");
	});

	test("our adapter headers must not overwrite the real session", async () => {
		const { provider } = await import("../src/extension.ts");
		const auth = await (provider.auth.oauth as any).toAuth({
			type: "oauth",
			access: "a",
			orgID: "wrk_1",
		});
		expect(auth.headers["x-opencode-session"]).toBeUndefined();
	});
});
