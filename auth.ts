import type { OAuthCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";

// OpenCode Zen console auth: device flow, workspace selection, token refresh.

export const CONSOLE = "https://opencode.ai/console";
export const CLIENT_ID = "opencode-cli";
export const UA_FALLBACK = "opencode/2.0.15/cli";

let uaCache: string | undefined;
export async function userAgent(): Promise<string> {
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
		headers: { "Content-Type": "application/json", "User-Agent": await userAgent() },
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
		headers: { Authorization: `Bearer ${token}`, "User-Agent": await userAgent() },
		signal,
	});
	if (!res.ok) throw new Error(`Failed to fetch workspaces: HTTP ${res.status}`);
	const data = await res.json();
	return (Array.isArray(data) ? data : (data.orgs ?? [])).map((o: any) => ({ id: o.id, name: o.name ?? o.id }));
}

function credentialFrom(poll: any): ZenCredential {
	return {
		type: "oauth",
		refresh: poll.refresh_token,
		access: poll.access_token,
		expires: Date.now() + poll.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export type ZenCredential = OAuthCredential & { orgID?: string };

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
	return { ...credentialFrom(data), orgID: credential.orgID };
}
