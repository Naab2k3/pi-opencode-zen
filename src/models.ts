import type { Model } from "@earendil-works/pi-ai";

export const INFERENCE_URL = "https://opencode.ai/inference/openai/v1";

// Wire protocols the Zen inference gateway serves per path (probed live:
// /inference/{openai,anthropic,google}/... answer 401/500 vs 404 on the rest).
export type ZenApi = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

const ZEN_BASE: Record<ZenApi, string> = {
	"openai-completions": INFERENCE_URL,
	"openai-responses": INFERENCE_URL,
	// the anthropic SDK appends "/v1/messages" itself, so this base carries no version
	"anthropic-messages": "https://opencode.ai/inference/anthropic",
	"google-generative-ai": "https://opencode.ai/inference/google/v1beta",
};

// Zen serves the GPT-5/grok/muse families through the Responses API; everything
// else in the openai-compatible pool speaks Chat Completions (verified against
// pi's bundled opencode catalog).
const RESPONSES_MODEL = /^(gpt|grok|muse)-/;

export interface ZenProviderOverride {
	npm?: string;
	api?: string;
}

export interface ZenModelMeta {
	name?: string;
	reasoning?: boolean;
	modalities?: { input?: string[] };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	limit?: { context?: number; output?: number };
	disabled?: boolean;
	status?: string;
	provider?: ZenProviderOverride;
}

export interface ZenRoute {
	api: ZenApi;
	baseUrl: string;
}

function apiFromNpm(id: string, npm: string): ZenApi | undefined {
	switch (npm) {
		case "@ai-sdk/anthropic":
			return "anthropic-messages";
		case "@ai-sdk/google":
			return "google-generative-ai";
		case "@ai-sdk/openai":
			return RESPONSES_MODEL.test(id) ? "openai-responses" : "openai-completions";
		case "@ai-sdk/openai-compatible":
			return "openai-completions";
		default:
			// vertex/bedrock/azure and friends need their own auth — not routable
			// through the Zen gateway
			return undefined;
	}
}

function apiFromUrl(url: string): ZenApi {
	if (url.includes("anthropic")) return "anthropic-messages";
	if (url.includes("google")) return "google-generative-ai";
	return "openai-completions";
}

// Resolve the wire protocol + gateway base URL for a console model. Returns
// undefined when the model's provider override cannot be routed via Zen.
export function resolveZenRoute(id: string, meta: ZenModelMeta): ZenRoute | undefined {
	const override = meta.provider;
	if (!override?.npm && !override?.api) return { api: "openai-completions", baseUrl: INFERENCE_URL };
	const api = override.npm ? apiFromNpm(id, override.npm) : apiFromUrl(override.api as string);
	if (!api) return undefined;
	// console hands out ".../inference/anthropic/v1"; the anthropic SDK appends
	// "/v1/messages", so drop the version here or every request 404s
	const baseUrl =
		api === "anthropic-messages" && override.api?.endsWith("/v1")
			? override.api.slice(0, -3)
			: (override.api ?? ZEN_BASE[api]);
	return { api, baseUrl };
}

// Zen's Anthropic endpoint rejects `thinking.type.enabled` for newer Claude —
// 5th-gen across the family plus late 4.x sonnet/opus. Those need the adaptive
// form gated on this flag; older ones (haiku-4-5, sonnet-4/4-5, opus-4-5) still
// take the legacy budget form. Mirrors pi's bundled opencode catalog.
const CLAUDE_VERSION = /^claude-(haiku|sonnet|opus|fable)-(\d+)(?:[-.](\d+))?/;

function needsAdaptiveThinking(id: string): boolean {
	const m = CLAUDE_VERSION.exec(id);
	if (!m) return false;
	const major = Number(m[2]);
	const minor = m[3] === undefined ? 0 : Number(m[3]);
	if (m[1] === "haiku" || m[1] === "fable") return major >= 5;
	return major >= 5 || (major === 4 && minor >= 6);
}

export function modelFromZen(id: string, meta: ZenModelMeta): Model<ZenApi> {
	const cost = meta.cost ?? { input: 0, output: 0, cache_read: 0 };
	const free = meta.cost !== undefined && (cost.input ?? 0) <= 0 && (cost.output ?? 0) <= 0;
	const resolved = resolveZenRoute(id, meta);
	// The free-tier gateway serves each model on a fixed protocol: Responses for
	// the gpt/grok/muse families, Chat Completions for the rest. Forcing every
	// free model onto Responses made the non-muse ones 400 ModelProtocolUnsupported.
	const route = free
		? (resolved && resolved.api !== "openai-completions"
			? resolved
			: { api: RESPONSES_MODEL.test(id) ? "openai-responses" as const : "openai-completions" as const, baseUrl: INFERENCE_URL })
		: (resolved ?? { api: "openai-completions" as const, baseUrl: INFERENCE_URL });
	return {
		id,
		name: meta.name ?? id,
		api: route.api,
		provider: "opencode-zen",
		baseUrl: route.baseUrl,
		reasoning: meta.reasoning ?? false,
		input: meta.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
		cost: {
			input: cost.input ?? 0,
			output: cost.output ?? 0,
			cacheRead: cost.cache_read ?? 0,
			// ponytail: console omits cache_write; 1.25x input matches pi's own convention
			cacheWrite: cost.cache_write ?? (cost.input ?? 0) * 1.25,
		},
		contextWindow: meta.limit?.context ?? 128000,
		maxTokens: meta.limit?.output ?? 32000,
		compat: route.api === "anthropic-messages" && needsAdaptiveThinking(id)
			? { forceAdaptiveThinking: true }
			: undefined,
	};
}

// Baseline catalog for offline startup; fetchModels replaces it with the live workspace list.
export const MODELS: Model<ZenApi>[] = [
	modelFromZen("glm-5.3-flash", {
		name: "GLM 5.3 Flash (Zen)",
		reasoning: true,
		modalities: { input: ["text"] },
		cost: { input: 0.15, output: 0.5, cache_read: 0.03 },
		limit: { context: 1000000, output: 131072 },
	}),
	modelFromZen("deepseek-v4.1-flash", {
		name: "DeepSeek V4.1 Flash (Zen)",
		reasoning: true,
		modalities: { input: ["text", "image"] },
		cost: { input: 0.3, output: 1.2, cache_read: 0.006 },
		limit: { context: 1000000, output: 384000 },
	}),
];
