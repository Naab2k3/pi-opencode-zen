import type { Model } from "@earendil-works/pi-ai";

export const INFERENCE_URL = "https://opencode.ai/inference/openai/v1";

export interface ZenModelMeta {
	name?: string;
	reasoning?: boolean;
	modalities?: { input?: string[] };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	limit?: { context?: number; output?: number };
	disabled?: boolean;
	provider?: unknown;
}

export function modelFromZen(id: string, meta: ZenModelMeta): Model<"openai-completions"> {
	const cost = meta.cost ?? { input: 0, output: 0, cache_read: 0 };
	return {
		id,
		name: meta.name ?? id,
		api: "openai-completions",
		provider: "opencode-zen",
		baseUrl: INFERENCE_URL,
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
	};
}

// Baseline catalog for offline startup; fetchModels replaces it with the live workspace list.
export const MODELS: Model<"openai-completions">[] = [
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
