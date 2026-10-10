import { afterEach, describe, expect, test } from "bun:test";
import { allowedModelIDs, fetchZenModels, loginZen } from "../src/auth.ts";
import { provider } from "../src/extension.ts";
import { INFERENCE_URL, MODELS, modelFromZen, resolveZenRoute } from "../src/models.ts";

// Regression suite for "logged in but no models":
// - empty allowedModels must never wipe the catalog
// - console switches (blacklist / status) must be respected
// - provider overrides must route to the right protocol instead of being dropped

type FetchCall = { url: string; body: any; headers: any };
let responses: ((call: FetchCall) => { status?: number; body: any })[] = [];
const realFetch = globalThis.fetch;

function mockFetch() {
	responses = [];
	globalThis.fetch = (async (url: any, init?: any) => {
		const call: FetchCall = { url: String(url), body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers };
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
});

const oauth = (allowedModels?: string[]) =>
	({ type: "oauth", refresh: "r", access: "a", expires: 0, allowedModels }) as any;

describe("empty allowedModels never wipes the catalog", () => {
	test("empty array passes every model through", () => {
		const visible = provider.filterModels(MODELS, oauth([]));
		expect(visible.length).toBe(MODELS.length);
	});

	test("missing allowedModels passes every model through", () => {
		const visible = provider.filterModels(MODELS, oauth(undefined));
		expect(visible.length).toBe(MODELS.length);
	});

	test("a non-empty list still narrows the catalog", () => {
		const visible = provider.filterModels(MODELS, oauth(["glm-5.3-flash"]));
		expect(visible.map((m: any) => m.id)).toEqual(["glm-5.3-flash"]);
	});
});

describe("provider overrides route instead of dropping (Issue #2)", () => {
	test("anthropic override: kept, and the /v1 base is normalized for the SDK", async () => {
		mockFetch();
		responses.push(() => ({
			body: {
				config: {
					provider: {
						opencode: {
							models: {
								"qwen3.8-flash": {
									status: "active",
									cost: { input: 0.15, output: 0.47 },
									provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/anthropic/v1" },
								},
							},
						},
					},
				},
			},
		}));
		const ids = await allowedModelIDs("tok", "wrk_1");
		expect(ids).toEqual(["qwen3.8-flash"]);
		const route = resolveZenRoute("qwen3.8-flash", {
			provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/anthropic/v1" },
		});
		expect(route).toEqual({ api: "anthropic-messages", baseUrl: "https://opencode.ai/inference/anthropic" });
		const model = modelFromZen("qwen3.8-flash", {
			cost: { input: 0.15, output: 0.47 },
			provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/anthropic/v1" },
		});
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://opencode.ai/inference/anthropic");
	});

	test("@ai-sdk/openai picks responses vs completions by model family", () => {
		const openai = { npm: "@ai-sdk/openai", api: "https://opencode.ai/inference/openai/v1" };
		expect(resolveZenRoute("gpt-5.1", { provider: openai })?.api).toBe("openai-responses");
		expect(resolveZenRoute("grok-4.6", { provider: openai })?.api).toBe("openai-responses");
		expect(resolveZenRoute("glm-5.3", { provider: openai })?.api).toBe("openai-completions");
	});

	test("override without npm infers the protocol from the URL", () => {
		const route = resolveZenRoute("any", { provider: { api: "https://opencode.ai/inference/anthropic/v1" } });
		expect(route).toEqual({ api: "anthropic-messages", baseUrl: "https://opencode.ai/inference/anthropic" });
		expect(resolveZenRoute("any", { provider: { api: "https://opencode.ai/inference/openai/v1" } })?.api).toBe(
			"openai-completions",
		);
	});

	test("unknown npm packages are skipped — they cannot route through Zen", async () => {
		mockFetch();
		responses.push(() => ({
			body: {
				config: {
					provider: {
						opencode: {
							models: {
								keep: { cost: { input: 1, output: 2 } },
								orphan: { cost: { input: 1, output: 2 }, provider: { npm: "@openrouter/ai-sdk-provider" } },
							},
						},
					},
				},
			},
		}));
		expect(await allowedModelIDs("tok", "wrk_1")).toEqual(["keep"]);
	});

	test("no override keeps the default completions route", () => {
		expect(resolveZenRoute("glm-5.3-flash", {})).toEqual({ api: "openai-completions", baseUrl: INFERENCE_URL });
	});
});

describe("console switches are respected", () => {
	test("blacklist drops models", async () => {
		mockFetch();
		responses.push(() => ({
			body: {
				config: {
					provider: {
						opencode: {
							blacklist: ["glm-5.3-flash"],
							models: {
								"glm-5.3-flash": { cost: { input: 0.15, output: 0.5 } },
								"deepseek-v4.1-flash": { cost: { input: 0.3, output: 1.2 } },
							},
						},
					},
				},
			},
		}));
		expect(await allowedModelIDs("tok", "wrk_1")).toEqual(["deepseek-v4.1-flash"]);
	});

	test("status deprecated is treated as off", async () => {
		mockFetch();
		responses.push(() => ({
			body: {
				config: {
					provider: {
						opencode: {
							models: {
								"old-model": { status: "deprecated", cost: { input: 1, output: 2 } },
								"live-model": { status: "active", cost: { input: 1, output: 2 } },
								"beta-model": { status: "beta", cost: { input: 1, output: 2 } },
							},
						},
					},
				},
			},
		}));
		expect(await allowedModelIDs("tok", "wrk_1")).toEqual(["live-model", "beta-model"]);
	});

	test("whitelist still narrows", async () => {
		mockFetch();
		responses.push(() => ({
			body: {
				config: {
					provider: {
						opencode: {
							whitelist: ["glm-5.3-flash"],
							models: {
								"glm-5.3-flash": { cost: { input: 0.15, output: 0.5 } },
								"deepseek-v4.1-flash": { cost: { input: 0.3, output: 1.2 } },
							},
						},
					},
				},
			},
		}));
		expect(await allowedModelIDs("tok", "wrk_1")).toEqual(["glm-5.3-flash"]);
	});
});

describe("config entries beyond the opencode key", () => {
	test("entry-level npm routes every model in that entry", async () => {
		mockFetch();
		responses.push(() => ({
			body: {
				config: {
					provider: {
						opencode: { models: { "glm-5.3-flash": { cost: { input: 0.15, output: 0.5 } } } },
						anthropic: {
							npm: "@ai-sdk/anthropic",
							api: "https://opencode.ai/inference/anthropic/v1",
							models: { "claude-sonnet-5": { cost: { input: 3, output: 15 } } },
						},
					},
				},
			},
		}));
		const models = await fetchZenModels("tok", "wrk_1");
		expect(Object.keys(models).sort()).toEqual(["claude-sonnet-5", "glm-5.3-flash"]);
		expect(modelFromZen("claude-sonnet-5", models["claude-sonnet-5"]).api).toBe("anthropic-messages");
	});

	test("entries with neither npm nor model overrides are skipped", async () => {
		mockFetch();
		responses.push(() => ({
			body: {
				config: {
					provider: {
						weird: { models: { mystery: { cost: { input: 1, output: 2 } } } },
					},
				},
			},
		}));
		expect(await allowedModelIDs("tok", "wrk_1")).toEqual([]);
	});

	test("BYOK entries (own baseURL/key) are skipped — the Zen token cannot auth them", async () => {
		mockFetch();
		responses.push(() => ({
			body: {
				config: {
					provider: {
						openrouter: {
							npm: "@openrouter/ai-sdk-provider",
							options: { baseURL: "https://openrouter.ai/api/v1" },
							models: { "some/model": { cost: { input: 1, output: 2 } } },
						},
					},
				},
			},
		}));
		expect(await allowedModelIDs("tok", "wrk_1")).toEqual([]);
	});
});

describe("login stays usable when the config fetch fails", () => {
	const deviceStart = {
		device_code: "dc",
		user_code: "ABCD-EFGH",
		verification_uri_complete: "/console/device?user_code=ABCD-EFGH",
		expires_in: 900,
		interval: 0.001,
	};

	test("allowedModels stays unset and the catalog passes through", async () => {
		mockFetch();
		responses.push(() => ({ body: deviceStart }));
		responses.push(() => ({ body: { access_token: "acc", refresh_token: "ref", expires_in: 3600 } }));
		responses.push(() => ({ body: [{ id: "wrk_single", name: "Only" }] }));
		responses.push(() => ({ status: 500, body: { message: "boom" } }));
		const credential = await loginZen({
			signal: new AbortController().signal,
			notify: () => {},
			prompt: async () => {
				throw new Error("prompt should not be called");
			},
		} as any);
		expect(credential.access).toBe("acc");
		expect(credential.allowedModels).toBeUndefined();
		expect(provider.filterModels(MODELS, credential as any).length).toBe(MODELS.length);
	});
});
