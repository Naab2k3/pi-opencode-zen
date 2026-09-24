import type { Model } from "@earendil-works/pi-ai";

export const INFERENCE_URL = "https://opencode.ai/inference/openai/v1";

// Zen paid-tier prices per million tokens, from the console workspace config.
export const MODELS: Model<"openai-completions">[] = [
	{
		id: "glm-5.3-flash",
		name: "GLM 5.3 Flash (Zen)",
		api: "openai-completions",
		provider: "opencode-zen",
		baseUrl: INFERENCE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0.1875 },
		contextWindow: 1000000,
		maxTokens: 131072,
	},
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash (Zen)",
		api: "openai-completions",
		provider: "opencode-zen",
		baseUrl: INFERENCE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0.375 },
		contextWindow: 1000000,
		maxTokens: 384000,
	},
];
