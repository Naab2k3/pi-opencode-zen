import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fetchOrgs } from "./auth.ts";

// Session-scoped workspace override. The public extension API exposes no
// credential-write path, so unlike a re-login this does not survive a
// restart — the command output says so. Catalog refresh, request headers,
// and model filtering all follow the override while it is set.

export interface OrgOverride {
	orgID: string;
}

let activeOrgOverride: OrgOverride | undefined;

export function getActiveOrg(): OrgOverride | undefined {
	return activeOrgOverride;
}

/** @internal Test hook: drops the session workspace override. */
export function clearActiveOrgForTests(): void {
	activeOrgOverride = undefined;
}

export async function switchWorkspace(ctx: ExtensionCommandContext): Promise<void> {
	const token = await ctx.modelRegistry.getApiKeyForProvider("opencode-zen");
	if (!token) {
		ctx.ui.notify("Not signed in to OpenCode Zen. Run /login opencode-zen.", "warning");
		return;
	}
	let orgs;
	try {
		orgs = await fetchOrgs(token);
	} catch (err) {
		ctx.ui.notify(`Workspace switch failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}
	if (orgs.length === 0) {
		ctx.ui.notify("No workspaces available for this account.", "warning");
		return;
	}
	let picked = orgs[0]!;
	if (orgs.length > 1) {
		const labels = orgs.map((o) => `${o.name} (${o.id})`);
		const selected = await ctx.ui.select("Select workspace", labels);
		if (!selected) return;
		const match = orgs[labels.indexOf(selected)];
		if (!match) return;
		picked = match;
	}
	activeOrgOverride = { orgID: picked.id };
	ctx.ui.notify(
		`Switched to ${picked.name}. Session-only: re-login to keep it after a restart. Refreshing models…`,
		"info",
	);
	try {
		await ctx.modelRegistry.refresh({ providers: ["opencode-zen"] });
	} catch {
		ctx.ui.notify("Run /reload to refresh the model picker.", "warning");
	}
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
	const token = await ctx.modelRegistry.getApiKeyForProvider("opencode-zen");
	if (!token) {
		ctx.ui.notify("Not signed in to OpenCode Zen. Run /login opencode-zen.", "warning");
		return;
	}
	const org = getActiveOrg()?.orgID ?? "(login workspace)";
	ctx.ui.notify(`OpenCode Zen status\n  Auth: OAuth device-code session\n  Workspace: ${org}`, "info");
}

export function registerZenCommands(pi: ExtensionAPI): void {
	pi.registerCommand("opencode-zen", {
		description: "Manage OpenCode Zen: status, switch-org",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			if (sub === "switch-org" || sub === "switch") {
				await switchWorkspace(ctx);
				return;
			}
			await showStatus(ctx);
		},
	});
}
