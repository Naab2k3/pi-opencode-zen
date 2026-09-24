import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider, type ApiKeyCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { INFERENCE_URL, MODELS } from "./models.ts";
import { loginZen, refreshZenToken, userAgent } from "./auth.ts";

export const provider = createProvider<"openai-completions">({
	id: "opencode-zen",
	name: "OpenCode Zen",
	baseUrl: INFERENCE_URL,
	auth: {
		oauth: {
			name: "OpenCode Zen (workspace)",
			login: loginZen,
			refresh: refreshZenToken,
			toAuth: async (credential) => ({
				apiKey: credential.access,
				headers: {
					"User-Agent": await userAgent(),
					...(credential.orgID ? { "x-opencode-org-id": credential.orgID } : {}),
				},
			}),
		},
		apiKey: {
			name: "OpenCode Zen API key",
			login: async (interaction): Promise<ApiKeyCredential> => ({
				type: "api_key",
				key: await interaction.prompt({ type: "secret", message: "Enter OpenCode API key" }),
			}),
			resolve: async ({ ctx, credential }) => {
				const key = credential?.key ?? (await ctx.env("OPENCODE_API_KEY")) ?? undefined;
				if (!key) return undefined;
				return { auth: { apiKey: key, headers: { "User-Agent": await userAgent() } } };
			},
		},
	},
	models: MODELS,
	api: { "openai-completions": openAICompletionsApi() },
});

export default function (pi: ExtensionAPI) {
	pi.registerProvider(provider);
}
