import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider, type ApiKeyCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	googleGenerativeAIApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { INFERENCE_URL, MODELS, modelFromZen, type ZenApi } from "./models.ts";
import {
	applyFreeTierGate,
	applyFreeTierGateAnthropic,
	freeTierHeaders,
	isZeroCostModel,
} from "./free-tier.ts";
import { UA, fetchZenModels, loginZen, refreshZenToken, type ZenCredential } from "./auth.ts";

// Free-tier models only answer through the Zen gateway when the request looks
// like an OpenCode-client turn: an official-shaped UA, an `x-opencode-session`
// header, a streamed body, and a read/exec tool pair. The pi
// openai-completions adapter always streams and agent turns already carry
// read+bash, so the universal need is the header pair; tool-less completions
// additionally get stubs (in the route's own tool format). All of it is
// injected here — headers via the adapter's options, body via its onPayload
// hook — so every call path (stream/streamSimple) is covered without touching
// the SDK.
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
				...(free
					? { headers: { ...((opts.headers as Record<string, string>) ?? {}), ...freeTierHeaders() } }
					: {}),
				onPayload: async (payload: unknown, m: unknown) => {
					// every zero-cost model routes openai-completions today; the
					// anthropic variant is here for models that switch routes
					const gated =
						(m as { api?: string })?.api === "anthropic-messages"
							? applyFreeTierGateAnthropic(payload as Record<string, unknown>, m as never)
							: applyFreeTierGate(payload as Record<string, unknown>, m as never);
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
		// the gate only ever fires for zero-cost models; headers cover any
		// route, the body stubs follow the route's own tool format
		"openai-completions": withFreeTierGate(openAICompletionsApi()),
		"anthropic-messages": withFreeTierGate(anthropicMessagesApi()),
		"openai-responses": openAIResponsesApi(),
		"google-generative-ai": googleGenerativeAIApi(),
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerProvider(provider);
}
