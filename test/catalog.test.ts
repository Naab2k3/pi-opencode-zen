import { afterEach, describe, expect, test } from "bun:test";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { allowedModelIDs, fetchZenModels, loginZen } from "../src/auth.ts";
import { provider } from "../src/extension.ts";
import { INFERENCE_URL, MODELS, healZenRoute, modelFromZen, resolveZenRoute } from "../src/models.ts";

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
		const visible = provider.filterModels?.(MODELS, oauth([]));
		expect(visible?.length).toBe(MODELS.length);
	});

	test("missing allowedModels passes every model through", () => {
		const visible = provider.filterModels?.(MODELS, oauth(undefined));
		expect(visible?.length).toBe(MODELS.length);
	});

	test("a non-empty list still narrows the catalog", () => {
		const visible = provider.filterModels?.(MODELS, oauth(["glm-5.3-flash"]));
		expect(visible?.map((m: any) => m.id)).toEqual(["glm-5.3-flash"]);
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
		expect(modelFromZen("claude-sonnet-5", models["claude-sonnet-5"]!).api).toBe("anthropic-messages");
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

describe("Issue #10 repro: Claude thinking payload on the Zen wire", () => {
	const anthropic = { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/anthropic/v1" };

	// Runs pi-ai's real anthropic-messages request builder for a console model
	// and captures the wire params via onPayload, aborting before any network.
	// No credit needed: the request never leaves the process.
	async function captureWireParams(id: string) {
		const model = modelFromZen(id, { reasoning: true, cost: { input: 1, output: 5 }, provider: anthropic });
		let captured: any;
		const events = anthropicMessagesApi().streamSimple(model as any, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		} as any, {
			apiKey: "test-key",
			reasoning: "high",
			onPayload: (params: any) => {
				captured = params;
				throw new Error("CAPTURE_ABORT");
			},
		} as any);
		for await (const _ of events) { /* drain to the abort error event */ }
		return captured;
	}

	test("claude-haiku-5-5 sends adaptive thinking, not the rejected enabled form", async () => {
		const params = await captureWireParams("claude-haiku-5-5");
		expect(params.thinking?.type).toBe("adaptive");
		expect(params.output_config?.effort).toBe("high");
	});

	// Whole current family, as classified in pi's bundled opencode catalog.
	test.each([
		"claude-haiku-5-5",
		"claude-sonnet-5",
		"claude-sonnet-5-5",
		"claude-opus-5",
		"claude-opus-5-5",
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"claude-fable-5",
		"claude-fable-5-1",
	])("%s sends adaptive thinking", async (id) => {
		const params = await captureWireParams(id);
		expect(params.thinking?.type).toBe("adaptive");
	});

	test.each([
		"claude-haiku-4-5",
		"claude-sonnet-4",
		"claude-sonnet-4-5",
		"claude-opus-4-5",
	])("%s keeps the legacy budget form", async (id) => {
		const params = await captureWireParams(id);
		expect(params.thinking?.type).toBe("enabled");
	});

	test.each([
		["claude-opus-4.7", "adaptive"],
		["claude-sonnet-4.5", "enabled"],
	] as const)("%s with dotted version sends %s thinking", async (id, type) => {
		const params = await captureWireParams(id);
		expect(params.thinking?.type).toBe(type);
	});

	test("without the flag the wire carries the exact payload Zen rejects", async () => {
		const model = modelFromZen("claude-haiku-5-5", {
			reasoning: true,
			cost: { input: 1, output: 5 },
			provider: anthropic,
		});
		const legacy = { ...(model as any), compat: undefined };
		let captured: any;
		const events = anthropicMessagesApi().streamSimple(legacy, {
			messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
		} as any, {
			apiKey: "test-key",
			reasoning: "high",
			onPayload: (params: any) => {
				captured = params;
				throw new Error("CAPTURE_ABORT");
			},
		} as any);
		for await (const _ of events) { /* drain */ }
		// the 1.2.7 shape Zen answers with "thinking.type.enabled is not supported"
		expect(captured.thinking?.type).toBe("enabled");
	});
});

describe("catalog resilience (parity #6, area: catalog)", () => {
	const zenStored = (id: string) =>
		modelFromZen(id, {
			name: `${id} (Zen)`,
			reasoning: true,
			modalities: { input: ["text"] },
			cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
			limit: { context: 1000000, output: 131072 },
		});

	function refreshContext(storedModels: any[], allowNetwork = true) {
		const published: any[] = [];
		return {
			ctx: {
				allowNetwork,
				credential: { type: "oauth", refresh: "r", access: "a", expires: 0, orgID: "wrk_1" },
				signal: new AbortController().signal,
				stored: { models: storedModels },
				publish: async (p: any) => {
					p.update?.();
					published.push(p);
					return true;
				},
			} as any,
			published,
		};
	}

	test("failed discovery keeps serving the stored catalog (no wipe)", async () => {
		mockFetch();
		responses.push(() => ({ status: 500, body: { message: "boom" } }));
		const { ctx, published } = refreshContext([zenStored("retained-model")]);
		// the failure propagates (the composer records it); what matters is
		// the catalog still serves the last-known list afterwards
		await expect(provider.refreshModels?.(ctx)).rejects.toThrow();
		expect(published.some((p) => p.persist && p.persist.models.length === 0)).toBe(false);
		expect(provider.getModels().map((m: any) => m.id)).toContain("retained-model");
	});

	test("cache-only startup serves the stored catalog", async () => {
		const { ctx } = refreshContext([zenStored("cached-model")], false);
		await provider.refreshModels?.(ctx);
		expect(provider.getModels().map((m: any) => m.id)).toContain("cached-model");
	});

	test("console smoke-test and decision-protocol ids never reach the picker", async () => {
		mockFetch();
		responses.push(() => ({
			body: {
				config: {
					provider: {
						opencode: {
							models: {
								"test-ping": { cost: { input: 0.15, output: 0.5 } },
								"jev-1": { cost: { input: 0.15, output: 0.5 } },
								"jev_2": { cost: { input: 0.15, output: 0.5 } },
								"good-model": { cost: { input: 0.15, output: 0.5 } },
							},
						},
					},
				},
			},
		}));
		expect(await allowedModelIDs("tok", "wrk_1")).toEqual(["good-model"]);
	});
});

describe("stale stored catalogs cannot outlive the code that wrote them", () => {
	// pi restores models-store.json before the network and lets a same-id stored
	// entry override the baseline — `api` included — so an old snapshot kept
	// pinning free models to the protocol that version chose (the 400
	// ModelProtocolUnsupported reports). Routing is re-derived on every read.
	const stale = (id: string, api: string) =>
		({
			id,
			name: id,
			provider: "opencode-zen",
			api,
			baseUrl: INFERENCE_URL,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		}) as any;

	test("a completions-family free model pinned to Responses is healed on read", () => {
		expect(healZenRoute(stale("nemotron-3-ultra-free", "openai-responses"))).toMatchObject({
			api: "openai-completions",
			baseUrl: INFERENCE_URL,
		});
	});

	test("crossed routes in both directions are healed", () => {
		expect(healZenRoute(stale("mimo-v2.6-flash-free", "openai-responses")).api).toBe("openai-completions");
		expect(healZenRoute(stale("gpt-5.1", "openai-completions")).api).toBe("openai-responses");
	});

	test("a zero-cost model without the -free suffix is healed too", () => {
		expect(healZenRoute(stale("big-pickle", "openai-responses")).api).toBe("openai-completions");
	});

	test("paid models and console-only routes are left alone", () => {
		const paid = { ...stale("glm-5.3-flash", "openai-completions"), cost: { input: 0.15, output: 0.5 } };
		const claude = { ...stale("claude-sonnet-5-free", "anthropic-messages"), baseUrl: "https://opencode.ai/inference/anthropic" };
		expect(healZenRoute(paid)).toBe(paid);
		expect(healZenRoute(claude)).toBe(claude);
	});

	test("the restored snapshot is healed where requests read it", async () => {
		mockFetch();
		const published: any[] = [];
		const ctx = {
			allowNetwork: false,
			credential: { type: "oauth", refresh: "r", access: "a", expires: 0, orgID: "wrk_1" },
			signal: new AbortController().signal,
			stored: {
				models: [
					stale("nemotron-3-ultra-free", "openai-responses"),
					stale("muse-spark-1.3-contributor-free", "openai-responses"),
				],
			},
			publish: async (p: any) => {
				p.update?.();
				published.push(p);
				return true;
			},
		} as any;
		await provider.refreshModels?.(ctx);
		const served = new Map(provider.getModels().map((m: any) => [m.id, m.api]));
		expect(served.get("nemotron-3-ultra-free")).toBe("openai-completions");
		expect(served.get("muse-spark-1.3-contributor-free")).toBe("openai-responses");
	});

	test("healed models still honour the workspace allowlist", () => {
		// the caller feeds provider.getModels() (already-healed models + stale
		// overrides merged in by pi-ai) into filterModels for the picker
		const visible = provider.filterModels?.(
			[stale("mimo-v2.6-flash-free", "openai-responses"), stale("nemotron-3-ultra-free", "openai-responses")],
			oauth(["nemotron-3-ultra-free"]),
		);
		expect(visible?.map((m: any) => m.id)).toEqual(["nemotron-3-ultra-free"]);
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
		expect(provider.filterModels?.(MODELS, credential as any)?.length).toBe(MODELS.length);
	});
});
