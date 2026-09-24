import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createProvider,
	type ApiKeyCredential,
	type Model,
	type OAuthCredential,
	type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

const CONSOLE = "https://opencode.ai/console";
const CLIENT_ID = "opencode-cli";
const BASE_URL = "https://opencode.ai/inference/openai/v1";
const UA_FALLBACK = "opencode/2.0.15/cli";

const MODELS: Model<"openai-completions">[] = [
	{
		id: "glm-5.3-flash",
		name: "GLM 5.3 Flash (Zen)",
		api: "openai-completions",
		provider: "opencode-zen",
		baseUrl: BASE_URL,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 131072,
	},
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash (Zen)",
		api: "openai-completions",
		provider: "opencode-zen",
		baseUrl: BASE_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 384000,
	},
];

// The Zen edge serves the inference API only to opencode clients.
let uaCache: string | undefined;
async function userAgent(): Promise<string> {
	if (uaCache) return uaCache;
	try {
		const res = await fetch("https://registry.npmjs.org/-/package/opencode-ai/dist-tags", {
			signal: AbortSignal.timeout(3000),
		});
		const tags = await res.json();
		uaCache = tags.latest ? `opencode/${tags.latest}/cli` : UA_FALLBACK;
	} catch {
		uaCache = UA_FALLBACK;
	}
	return uaCache;
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			reject(signal.reason ?? new Error("aborted"));
		}, { once: true });
	});

async function postJson(url: string, body: unknown, signal?: AbortSignal, expectHttp400 = false): Promise<any> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": await userAgent() },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok && !(expectHttp400 && res.status === 400))
		throw new Error(`${url}: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return res.json();
}

interface Org {
	id: string;
	name: string;
}

async function fetchOrgs(token: string, signal?: AbortSignal): Promise<Org[]> {
	const res = await fetch(`${CONSOLE}/api/orgs`, {
		headers: { Authorization: `Bearer ${token}`, "User-Agent": await userAgent() },
		signal,
	});
	if (!res.ok) throw new Error(`Failed to fetch workspaces: HTTP ${res.status}`);
	const data = await res.json();
	return (Array.isArray(data) ? data : (data.orgs ?? [])).map((o: any) => ({ id: o.id, name: o.name ?? o.id }));
}

async function loginZen(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const start = await postJson(`${CONSOLE}/auth/device/code`, { client_id: CLIENT_ID }, interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: start.user_code,
		verificationUri: new URL(start.verification_uri_complete ?? start.verification_uri, `${CONSOLE}/`).href,
		intervalSeconds: start.interval,
		expiresInSeconds: start.expires_in,
	});

	let intervalMs = (start.interval ?? 5) * 1000;
	const deadline = Date.now() + (start.expires_in ?? 600) * 1000;
	while (Date.now() < deadline) {
		await sleep(intervalMs, interaction.signal);
		const poll = await postJson(
			`${CONSOLE}/auth/device/token`,
			{
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: start.device_code,
				client_id: CLIENT_ID,
			},
			interaction.signal,
			true,
		);
		if (poll.access_token) {
			const credential: OAuthCredential = {
				type: "oauth",
				refresh: poll.refresh_token,
				access: poll.access_token,
				expires: Date.now() + poll.expires_in * 1000 - 5 * 60 * 1000,
			};
			const orgs = await fetchOrgs(credential.access, interaction.signal);
			if (orgs.length === 1) {
				credential.orgID = orgs[0].id;
			} else if (orgs.length > 1) {
				credential.orgID = await interaction.prompt({
					type: "select",
					message: "Select workspace",
					options: orgs.map((o) => ({ id: o.id, label: o.name })),
				});
			}
			return credential;
		}
		if (poll.error === "authorization_pending") continue;
		if (poll.error === "slow_down") {
			intervalMs += 5000;
			continue;
		}
		throw new Error(`Zen login failed: ${poll.error ?? "unknown"} ${poll.error_description ?? ""}`);
	}
	throw new Error("Zen device code expired");
}

async function refreshZenToken(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	const data = await postJson(
		`${CONSOLE}/auth/device/token`,
		{ grant_type: "refresh_token", refresh_token: credential.refresh, client_id: CLIENT_ID },
		signal,
	);
	if (!data.access_token) throw new Error(`Zen token refresh failed: ${data.error ?? "unknown"}`);
	return {
		type: "oauth",
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		orgID: credential.orgID,
	};
}

export const provider = createProvider<"openai-completions">({
	id: "opencode-zen",
	name: "OpenCode Zen",
	baseUrl: BASE_URL,
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
