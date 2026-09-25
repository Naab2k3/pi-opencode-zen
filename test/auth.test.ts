import { afterEach, describe, expect, test } from "bun:test";
import {
	CONSOLE,
	CLIENT_ID,
	UA_FALLBACK,
	allowedModelIDs,
	deviceToken,
	fetchOrgs,
	loginZen,
	refreshZenToken,
	userAgent,
} from "../src/auth.ts";
import { provider } from "../src/extension.ts";
import { MODELS, modelFromZen } from "../src/models.ts";

type FetchCall = { url: string; body: any };
let responses: ((call: FetchCall) => { status?: number; body: any })[] = [];
let calls: FetchCall[] = [];
const realFetch = globalThis.fetch;

function mockFetch() {
	calls = [];
	globalThis.fetch = (async (url: any, init?: any) => {
		const call: FetchCall = { url: String(url), body: init?.body ? JSON.parse(init.body) : undefined };
		calls.push(call);
		const next = responses.shift();
		if (!next) throw new Error("unexpected fetch: " + call.url);
		const { status = 200, body } = next(call);
		return new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	responses = [];
});

const interaction = (pickWorkspace?: string) => ({
	signal: new AbortController().signal,
	notify: () => {},
	prompt: async () => {
		if (!pickWorkspace) throw new Error("prompt should not be called");
		return pickWorkspace;
	},
});

const okToken = { access_token: "acc", refresh_token: "ref", expires_in: 3600 };

describe("userAgent", () => {
	test("falls back when registry is unreachable", async () => {
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as typeof fetch;
		expect(await userAgent()).toBe(UA_FALLBACK);
	});
});

describe("deviceToken", () => {
	test("accepts HTTP 400 error bodies as poll results", async () => {
		mockFetch();
		responses.push(() => ({ status: 400, body: { error: "authorization_pending" } }));
		const poll = await deviceToken({ grant_type: "device", device_code: "x" });
		expect(poll.error).toBe("authorization_pending");
		expect(calls[0].url).toBe(`${CONSOLE}/auth/device/token`);
		expect(calls[0].body.client_id).toBe(CLIENT_ID);
	});

	test("throws on non-400 errors", async () => {
		mockFetch();
		responses.push(() => ({ status: 500, body: { message: "boom" } }));
		expect(deviceToken({})).rejects.toThrow("HTTP 500");
	});
});

describe("fetchOrgs", () => {
	test("parses org list", async () => {
		mockFetch();
		responses.push(() => ({ body: [{ id: "wrk_1", name: "Mei Sheng" }] }));
		const orgs = await fetchOrgs("tok");
		expect(orgs).toEqual([{ id: "wrk_1", name: "Mei Sheng" }]);
	});

	test("fails loud on HTTP error", async () => {
		mockFetch();
		responses.push(() => ({ status: 403, body: {} }));
		expect(fetchOrgs("tok")).rejects.toThrow("HTTP 403");
	});
});

describe("loginZen", () => {
	const deviceStart = {
		device_code: "dc",
		user_code: "ABCD-EFGH",
		verification_uri_complete: "/console/device?user_code=ABCD-EFGH",
		expires_in: 900,
		interval: 0.001,
	};

	test("single workspace: orgID set without prompting", async () => {
		mockFetch();
		responses.push(() => ({ body: deviceStart }));
		responses.push(() => ({ body: okToken }));
		responses.push(() => ({ body: [{ id: "wrk_single", name: "Only" }] }));
		responses.push(() => ({ body: { config: { provider: { opencode: { models: { "glm-5.3-flash": {} } } } } } }));
		const credential = await loginZen(interaction());
		expect(credential).toEqual({ type: "oauth", refresh: "ref", access: "acc", expires: expect.any(Number), orgID: "wrk_single", allowedModels: ["glm-5.3-flash"] });
	});

	test("multiple workspaces: prompts selection", async () => {
		mockFetch();
		responses.push(() => ({ body: deviceStart }));
		responses.push(() => ({ body: okToken }));
		responses.push(() => ({ body: [{ id: "wrk_a", name: "A" }, { id: "wrk_b", name: "B" }] }));
		responses.push(() => ({ body: { config: { provider: { opencode: { models: {} } } } } }));
		const credential = await loginZen(interaction("wrk_b"));
		expect(credential.orgID).toBe("wrk_b");
	});

	test("device link is resolved against the console URL", async () => {
		mockFetch();
		responses.push(() => ({ body: deviceStart }));
		responses.push(() => ({ body: { error: "access_denied", error_description: "no" } }));
		const events: any[] = [];
		await loginZen({
			...interaction(),
			notify: (event) => events.push(event),
		}).catch(() => {});
		const deviceCode = events.find((e) => e.type === "device_code");
		expect(deviceCode.verificationUri).toBe("https://opencode.ai/console/device?user_code=ABCD-EFGH");
		expect(events.some((e) => e.type === "progress")).toBe(true);
	});

	test("slow_down extends the poll interval and keeps polling", async () => {
		mockFetch();
		responses.push(() => ({ body: deviceStart }));
		responses.push(() => ({ body: { error: "slow_down" } }));
		responses.push(() => ({ body: { error: "authorization_pending" } }));
		responses.push(() => ({ body: okToken }));
		responses.push(() => ({ body: [] }));
		const credential = await loginZen(interaction());
		expect(credential.access).toBe("acc");
		expect(calls.filter((c) => c.url.endsWith("/auth/device/token")).length).toBe(3);
	}, 15000);

	test("surfaces terminal poll errors", async () => {
		mockFetch();
		responses.push(() => ({ body: deviceStart }));
		responses.push(() => ({ body: { error: "access_denied", error_description: "nope" } }));
		expect(loginZen(interaction())).rejects.toThrow("access_denied");
	});
});

describe("allowedModelIDs", () => {
	test("drops disabled models and respects the whitelist", async () => {
		mockFetch();
		responses.push(() => ({
			body: {
				config: {
					provider: {
						opencode: {
							whitelist: ["glm-5.3-flash", "big-pickle"],
							models: {
								"glm-5.3-flash": { disabled: false },
								"big-pickle": { disabled: false },
								"claude-x": { disabled: false },
								"gpt-y": { disabled: true },
							},
						},
					},
				},
			},
		}));
		const ids = await allowedModelIDs("tok", "wrk_1");
		expect(ids).toEqual(["glm-5.3-flash", "big-pickle"]);
		expect(calls[0].url).toBe(`${CONSOLE}/api/config`);
	});

	test("no whitelist means every enabled model", async () => {
		mockFetch();
		responses.push(() => ({
			body: { config: { provider: { opencode: { models: { a: {}, b: { disabled: true } } } } } },
		}));
		expect(await allowedModelIDs("tok", "wrk_1")).toEqual(["a"]);
	});

	test("skips models with a custom provider override", async () => {
		mockFetch();
		responses.push(() => ({
			body: {
				config: {
					provider: {
						opencode: {
							models: {
								ok: { disabled: false },
								anthropicish: { disabled: false, provider: { npm: "@ai-sdk/anthropic" } },
							},
						},
					},
				},
			},
		}));
		expect(await allowedModelIDs("tok", "wrk_1")).toEqual(["ok"]);
	});

	test("modelFromZen maps console metadata to a pi model", () => {
		const model = modelFromZen("glm-5.3-flash", {
			name: "GLM-5.3-Flash",
			reasoning: true,
			modalities: { input: ["text", "image", "pdf"] },
			cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
			limit: { context: 1000000, output: 131072 },
		});
		expect(model).toMatchObject({
			id: "glm-5.3-flash",
			name: "GLM-5.3-Flash",
			api: "openai-completions",
			provider: "opencode-zen",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.1875 },
			contextWindow: 1000000,
			maxTokens: 131072,
		});
	});

	test("modelFromZen falls back on missing metadata", () => {
		const model = modelFromZen("mystery", {});
		expect(model).toMatchObject({
			name: "mystery",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32000,
		});
	});

	test("filterModels narrows the catalog to allowed models", () => {
		const filtered = provider.filterModels(
			MODELS,
			{ type: "oauth", refresh: "r", access: "a", expires: 0, allowedModels: ["glm-5.3-flash"] },
		);
		expect(filtered.map((m: any) => m.id)).toEqual(["glm-5.3-flash"]);
		const all = provider.filterModels(MODELS, { type: "oauth", refresh: "r", access: "a", expires: 0 });
		expect(all.length).toBe(MODELS.length);
	});
});

describe("refreshZenToken", () => {
	test("refreshes and preserves orgID", async () => {
		mockFetch();
		responses.push(() => ({ body: okToken }));
		const credential = await refreshZenToken(
			{ type: "oauth", refresh: "old-ref", access: "old", expires: 0, orgID: "wrk_keep" },
			new AbortController().signal,
		);
		expect(credential).toEqual({ type: "oauth", refresh: "ref", access: "acc", expires: expect.any(Number), orgID: "wrk_keep" });
		expect(calls[0].body.refresh_token).toBe("old-ref");
	});
});
