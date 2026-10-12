import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { resolveZenRoute, type ZenModelMeta } from "./models.ts";

// OpenCode Zen console auth: device flow, workspace selection, token refresh.

export const CONSOLE = "https://opencode.ai/console";
export const CLIENT_ID = "opencode-cli";
// Versionless UA: the console accepts it, so no pinned version to drift.
export const UA = "opencode/cli";

export const SLOW_DOWN_PENALTY_MS = 5000;

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			reject(signal.reason ?? new Error("aborted"));
		}, { once: true });
	});
}

export async function postJson(
	url: string,
	body: unknown,
	signal?: AbortSignal,
	allowHttp400 = false,
): Promise<any> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", "User-Agent": UA },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok && !(allowHttp400 && res.status === 400))
		throw new Error(`${url}: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return res.json();
}

export interface Org {
	id: string;
	name: string;
}

export async function fetchOrgs(token: string, signal?: AbortSignal): Promise<Org[]> {
	const res = await fetch(`${CONSOLE}/api/orgs`, {
		headers: { Authorization: `Bearer ${token}`, "User-Agent": UA },
		signal,
	});
	if (!res.ok) throw new Error(`Failed to fetch workspaces: HTTP ${res.status}`);
	const data = (await res.json()) as Org[] | { orgs?: Org[] };
	return (Array.isArray(data) ? data : (data.orgs ?? [])).map((o) => ({ id: o.id, name: o.name ?? o.id }));
}

// Model IDs the workspace allows: not disabled, and on the org whitelist (if one exists).
export async function allowedModelIDs(token: string, orgID: string, signal?: AbortSignal): Promise<string[]> {
	return Object.keys(await fetchZenModels(token, orgID, signal));
}

export async function fetchZenModels(
	token: string,
	orgID: string,
	signal?: AbortSignal,
): Promise<Record<string, ZenModelMeta>> {
	const res = await fetch(`${CONSOLE}/api/config`, {
		headers: {
			Authorization: `Bearer ${token}`,
			// console API header; the inference endpoint uses x-opencode-org-id instead
			"x-org-id": orgID,
			"User-Agent": UA,
		},
		signal,
	});
	if (!res.ok) {
		const hint = res.status === 400 || res.status === 401 ? " (token rejected — run /login opencode-zen)" : "";
		throw new Error(`Failed to fetch workspace models: HTTP ${res.status}${hint}`);
	}
	const payload = (await res.json()) as {
		config?: { provider?: Record<string, Record<string, unknown> | undefined> };
	};
	const entries = payload?.config?.provider;
	if (!entries || typeof entries !== "object") return {};
	const out: Record<string, ZenModelMeta> = {};
	// Endpoints under opencode.ai/inference are the Zen gateway itself: the
	// workspace manages them and the OAuth token authenticates them (the
	// console even hands out a `{env:...}` apiKey placeholder there). Only an
	// entry pointing somewhere else with its own credentials is BYOK.
	const isZenGateway = (url: unknown): boolean => typeof url === "string" && url.includes("opencode.ai/inference");
	for (const [providerId, block] of Object.entries(entries)) {
		if (!block || typeof block !== "object") continue;
		const entry = block as {
			options?: { baseURL?: unknown; apiKey?: unknown };
			api?: unknown;
			npm?: unknown;
			whitelist?: unknown;
			blacklist?: unknown;
			models?: Record<string, ZenModelMeta>;
		};
		// entries carrying their own endpoint/key are BYOK — the Zen OAuth
		// token cannot authenticate them
		if (
			(entry.options?.baseURL || entry.options?.apiKey) &&
			!isZenGateway(entry.options?.baseURL) &&
			!isZenGateway(entry.api)
		)
			continue;
		// provider-level npm/api applies to every model without its own override
		const entryOverride =
			entry.npm || entry.api
				? { npm: entry.npm as string | undefined, api: entry.api as string | undefined }
				: undefined;
		const whitelist: Set<string> | undefined = Array.isArray(entry.whitelist) ? new Set(entry.whitelist as string[]) : undefined;
		const blacklist: Set<string> | undefined = Array.isArray(entry.blacklist) ? new Set(entry.blacklist as string[]) : undefined;
		for (const [id, model] of Object.entries(entry.models ?? {})) {
			if (!model || typeof model !== "object") continue;
			if (model.disabled === true) continue;
			// opencode itself disables models with status "deprecated"
			if (model.status === "deprecated") continue;
			if (whitelist && !whitelist.has(id)) continue;
			if (blacklist?.has(id)) continue;
			// only the zen entry has a default wire protocol; elsewhere every
			// model must name its route (model.provider or entry npm/api)
			if (providerId !== "opencode" && !entryOverride && !model.provider) continue;
			const merged: ZenModelMeta = { ...model, provider: model.provider ?? entryOverride };
			// skip models whose provider override cannot be routed via Zen
			if (!resolveZenRoute(id, merged)) continue;
			// zero-cost (free-tier) models stay listed: the gateway answers
			// them with FreeTierError outside the opencode client, but hiding
			// them re-creates the "logged in, no models" confusion
			out[id] = merged;
		}
	}
	return out;
}

function credentialFrom(poll: any): ZenCredential {
	return {
		type: "oauth",
		refresh: poll.refresh_token,
		access: poll.access_token,
		expires: Date.now() + poll.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export type ZenCredential = OAuthCredential & { orgID?: string; allowedModels?: string[] };

export async function deviceToken(body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
	return postJson(`${CONSOLE}/auth/device/token`, { client_id: CLIENT_ID, ...body }, signal, true);
}

export async function loginZen(interaction: ProviderAuthInteraction): Promise<ZenCredential> {
	const start = await postJson(`${CONSOLE}/auth/device/code`, { client_id: CLIENT_ID }, interaction.signal);
	interaction.notify({
		type: "device_code",
		userCode: start.user_code,
		verificationUri: new URL(start.verification_uri_complete ?? start.verification_uri, `${CONSOLE}/`).href,
		intervalSeconds: start.interval,
		expiresInSeconds: start.expires_in,
	});
	interaction.notify({
		type: "progress",
		message: "Leave \"All workspaces\" on the web page as-is — after approving, you will pick the workspace here in the terminal.",
	});

	let intervalMs = (start.interval ?? 5) * 1000;
	const deadline = Date.now() + (start.expires_in ?? 600) * 1000;
	while (Date.now() < deadline) {
		await sleep(intervalMs, interaction.signal);
		const poll = await deviceToken(
			{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code },
			interaction.signal,
		);
		if (poll.access_token) {
			const credential = credentialFrom(poll);
			interaction.notify({ type: "progress", message: "Approved. Loading workspaces..." });
			const orgs = await fetchOrgs(credential.access, interaction.signal);
			if (orgs.length === 1) {
				credential.orgID = orgs[0]!.id;
			} else if (orgs.length > 1) {
				credential.orgID = await interaction.prompt({
					type: "select",
					message: "Select workspace",
					options: orgs.map((o) => ({ id: o.id, label: o.name })),
				});
			}
			if (credential.orgID) {
				try {
					credential.allowedModels = await allowedModelIDs(credential.access, credential.orgID, interaction.signal);
				} catch {
					// config fetch failed — login still works; the next catalog
					// refresh retries fetchModels
				}
				interaction.notify({
					type: "progress",
					message: `Workspace ready. Models available: ${credential.allowedModels?.join(", ") || "workspace defaults"}`,
				});
			}
			return credential;
		}
		if (poll.error === "authorization_pending") continue;
		if (poll.error === "slow_down") {
			intervalMs += SLOW_DOWN_PENALTY_MS;
			continue;
		}
		throw new Error(`Zen login failed: ${poll.error ?? "unknown"} ${poll.error_description ?? ""}`);
	}
	throw new Error("Zen device code expired");
}

export async function refreshZenToken(credential: ZenCredential, signal: AbortSignal): Promise<ZenCredential> {
	const data = await deviceToken({ grant_type: "refresh_token", refresh_token: credential.refresh }, signal);
	if (!data.access_token) throw new Error(`Zen token refresh failed: ${data.error ?? "unknown"}`);
	const next: ZenCredential = { ...credentialFrom(data), orgID: credential.orgID };
	if (next.orgID) {
		try {
			next.allowedModels = await allowedModelIDs(next.access, next.orgID, signal);
		} catch {
			next.allowedModels = credential.allowedModels;
		}
	}
	return next;
}
