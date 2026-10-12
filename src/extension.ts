import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider, type ApiKeyCredential } from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	googleGenerativeAIApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { INFERENCE_URL, MODELS, modelFromZen, type ZenApi } from "./models.ts";
import { UA, fetchZenModels, loginZen, refreshZenToken, type ZenCredential } from "./auth.ts";

export const provider = createProvider<ZenApi>({
	id: "opencode-zen",
	name: "OpenCode Zen",
	baseUrl: INFERENCE_URL,
	auth: {
		oauth: {
			name: "OpenCode Zen (workspace)",
			login: loginZen,
			refresh: refreshZenToken,
			toAuth: async (credential) => {
				const { orgID, access: apiKey } = credential as ZenCredential;
				return {
					apiKey,
					headers: {
						"User-Agent": UA,
						...(orgID ? { "x-opencode-org-id": orgID } : {}),
					},
				};
			},
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
				return { auth: { apiKey: key, headers: { "User-Agent": UA } } };
			},
		},
	},
	models: MODELS,
	fetchModels: async (context) => {
		const credential = context.credential as ZenCredential | undefined;
		if (!context.allowNetwork || credential?.type !== "oauth" || !credential.orgID) return [];
		const entries = await fetchZenModels(credential.access, credential.orgID, context.signal);
		return Object.entries(entries).map(([id, meta]) => modelFromZen(id, meta));
	},
	filterModels: (models, credential) => {
		// an empty allowed list means "no usable workspace restrictions" — never
		// wipe the catalog (that was the "logged in, no models" bug)
		const allowed = (credential as ZenCredential | undefined)?.allowedModels;
		return Array.isArray(allowed) && allowed.length > 0
			? models.filter((m) => allowed.includes(m.id))
			: models;
	},
	api: {
		"openai-completions": openAICompletionsApi(),
		"anthropic-messages": anthropicMessagesApi(),
		"openai-responses": openAIResponsesApi(),
		"google-generative-ai": googleGenerativeAIApi(),
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerProvider(provider);
}
