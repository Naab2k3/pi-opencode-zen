import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider, type ApiKeyCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	googleGenerativeAIApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { INFERENCE_URL, MODELS, modelFromZen, type ZenApi } from "./models.ts";
import { applyFreeTierGate, freeTierHeaders, isZeroCostModel } from "./free-tier.ts";
import { UA, fetchZenModels, loginZen, refreshZenToken, type ZenCredential } from "./auth.ts";

// Free-tier models only answer through the Zen gateway when the request looks
// like a coding-agent turn: streamed, carrying a read/exec tool pair, and sent
// with an `x-opencode-session` header. The pi openai-completions adapter
// always streams and agent turns already carry read+bash, so the only
// universal need is the session header — tool-less completions additionally
// get the stubs. Both are injected here (headers via the adapter's options,
// body via its onPayload hook) so every call path (stream/streamSimple) is
// covered without touching the SDK.
function withFreeTierGate(streams: {
	stream: (...args: never[]) => unknown;
	streamSimple: (...args: never[]) => unknown;
}) {
	const wrap = (fn: (...args: never[]) => unknown) =>
		(model: never, context: never, options?: never) => {
			const opts = (options ?? {}) as Record<string, unknown>;
			const free = isZeroCostModel(model as never);
			const caller = opts.onPayload as
				| ((payload: unknown, model: unknown) => unknown)
				| undefined;
			return (fn as Function)(model, context, {
				...opts,
				...(free ? { headers: { ...((opts.headers as Record<string, string>) ?? {}), ...freeTierHeaders() } } : {}),
				onPayload: async (payload: unknown, m: unknown) => {
					const gated = applyFreeTierGate(payload as Record<string, unknown>, m as never);
					const next = gated ?? payload;
					return caller ? caller(next, m) : next;
				},
			});
		};
	return {
		...streams,
		stream: wrap(streams.stream),
		streamSimple: wrap(streams.streamSimple),
	};
}

export const provider = createProvider<ZenApi>({
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
					"User-Agent": UA,
					...(credential.orgID ? { "x-opencode-org-id": credential.orgID as string } : {}),
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
		// the gate only ever fires on the openai-completions route (every
		// zero-cost model in the workspace catalog resolves to it)
		"openai-completions": withFreeTierGate(openAICompletionsApi()),
		"openai-responses": openAIResponsesApi(),
		"anthropic-messages": anthropicMessagesApi(),
		"google-generative-ai": googleGenerativeAIApi(),
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerProvider(provider);
}
