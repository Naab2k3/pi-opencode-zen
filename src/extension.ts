import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider, type ApiKeyCredential } from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	googleGenerativeAIApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { INFERENCE_URL, MODELS, healZenRoute, modelFromZen, type ZenApi } from "./models.ts";
import { withRequestRetries } from "./retry.ts";
import { getActiveOrg, registerZenCommands } from "./commands.ts";
import { freeTierHeaders, isZeroCostModel } from "./free-tier.ts";
import { UA, fetchZenModels, loginZen, refreshZenToken, type ZenCredential } from "./auth.ts";

// Free-tier identity only: the gate authenticates the client through headers
// (User-Agent, x-opencode-client, both session headers). Its content checks are
// satisfied by a normal pi request, so the body is passed through untouched and
// free models keep their native tools.
function withFreeTierGate<T extends object>(streams: T): T {
	const s = streams as unknown as Record<string, (...args: never[]) => unknown>;
	const wrap = (fn: (...args: never[]) => unknown) => (model: never, context: never, options?: never) => {
		const opts = (options ?? {}) as Record<string, unknown>;
		const free = isZeroCostModel(model as never) || ((model as { id?: string }).id ?? "").endsWith("-free");
		const requestOptions = free
			? { ...opts, headers: { ...((opts.headers as Record<string, string>) ?? {}), ...freeTierHeaders() } }
			: options;
		return fn(model, context, requestOptions as never);
	};
	return { ...streams, stream: wrap(s.stream!), streamSimple: wrap(s.streamSimple!) };
}

const zen = createProvider<ZenApi>({
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
				const activeOrgID = getActiveOrg()?.orgID ?? orgID;
				return {
					apiKey,
					headers: {
						"User-Agent": UA,
						...(activeOrgID ? { "x-opencode-org-id": activeOrgID } : {}),
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
		if (!context.allowNetwork || credential?.type !== "oauth") return [];
		const orgID = getActiveOrg()?.orgID ?? credential.orgID;
		if (!orgID) return [];
		const entries = await fetchZenModels(credential.access, orgID, context.signal);
		return Object.entries(entries).map(([id, meta]) => modelFromZen(id, meta));
	},
	filterModels: (models, credential) => {
		// a switched workspace brings its own server-scoped catalog; the
		// login-time allowlist belongs to the previous workspace
		const override = getActiveOrg();
		if (override && (credential as ZenCredential | undefined)?.orgID !== override.orgID) return [...models];
		// an empty allowed list means "no usable workspace restrictions" — never
		// wipe the catalog (that was the "logged in, no models" bug)
		const allowed = (credential as ZenCredential | undefined)?.allowedModels;
		return Array.isArray(allowed) && allowed.length > 0
			? models.filter((m) => allowed.includes(m.id))
			: models;
	},
	api: {
		// the gate fires for zero-cost models only; google has none today
		"openai-completions": withRequestRetries(withFreeTierGate(openAICompletionsApi())),
		"anthropic-messages": withRequestRetries(withFreeTierGate(anthropicMessagesApi())),
		"openai-responses": withRequestRetries(withFreeTierGate(openAIResponsesApi())),
		"google-generative-ai": withRequestRetries(googleGenerativeAIApi()),
	},
});

// pi restores the last snapshot it fetched (models-store.json) before touching
// the network, merges it over the baseline — a same-id stored entry wins,
// `api` included — and serves the result through getModels()/getAllModels().
// That is the accessor every request path reads; filterModels only shapes the
// picker, so healing there is not enough. The snapshot is rewritten by a
// networked refresh only (interactive start, /model search, switch-org); the
// refresh pi runs after a login is offline, so a route an older version chose
// survives the upgrade. Re-derive it on every read instead.
export const provider = {
	...zen,
	getModels: () => zen.getModels().map(healZenRoute),
	getAllModels: () => (zen.getAllModels?.() ?? zen.getModels()).map(healZenRoute),
};

export default function (pi: ExtensionAPI) {
	pi.registerProvider(provider);
	registerZenCommands(pi);
}
