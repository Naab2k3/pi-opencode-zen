import { afterEach, describe, expect, test } from "bun:test";
import { provider } from "../src/extension.ts";
import {
	clearActiveOrgForTests,
	getActiveOrg,
	registerZenCommands,
	switchWorkspace,
} from "../src/commands.ts";

// Part 3 (parity issue #6, area: auth lifecycle): multi-workspace users can
// switch workspace without a full re-login. The public extension API exposes
// no credential-write path, so the switch is session-scoped (documented in
// the command output); catalog, request headers, and model filtering all
// follow the override. All offline via mocked fetch.

type FetchCall = { url: string; body: any; headers: any };
let responses: ((call: FetchCall) => { status?: number; body: any })[] = [];
const realFetch = globalThis.fetch;

function mockFetch() {
	responses = [];
	globalThis.fetch = (async (url: any, init?: any) => {
		const call: FetchCall = { url: String(url), body: init?.body ? JSON.parse(init.body) : undefined, headers: init?.headers };
		const next = responses.shift();
		if (!next) throw new Error("unexpected fetch: " + call.url);
		const { status = 200, body } = next(call);
		return new Response(typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	clearActiveOrgForTests();
});

const ORGS = [
	{ id: "wrk_1", name: "One" },
	{ id: "wrk_2", name: "Two" },
];

function fakeCtx(pickedLabel?: string, token: string | undefined = "tok") {
	const notes: Array<{ message: string; type?: string }> = [];
	const selects: Array<{ title: string; options: string[] }> = [];
	const refreshes: any[] = [];
	return {
		ctx: {
			ui: {
				notify: (message: string, type?: "info" | "warning" | "error") => {
					notes.push({ message, type });
				},
				select: async (title: string, options: string[]) => {
					selects.push({ title, options });
					return pickedLabel;
				},
			},
			modelRegistry: {
				getApiKeyForProvider: async (_id: string) => token,
				refresh: async (opts: any) => {
					refreshes.push(opts);
					return {};
				},
			},
		} as any,
		notes,
		selects,
		refreshes,
	};
}

describe("switch-org", () => {
	test("two workspaces: prompts, switches, refreshes the catalog", async () => {
		mockFetch();
		responses.push(() => ({ body: ORGS }));
		const { ctx, notes, selects, refreshes } = fakeCtx("Two (wrk_2)");
		await switchWorkspace(ctx);
		expect(selects.length).toBe(1);
		expect(getActiveOrg()?.orgID).toBe("wrk_2");
		expect(notes.some((n) => n.message.includes("Two"))).toBe(true);
		expect(notes.some((n) => n.message.includes("restart"))).toBe(true);
		expect(refreshes).toEqual([{ providers: ["opencode-zen"] }]);
	});

	test("single workspace: no prompt, auto-selects", async () => {
		mockFetch();
		responses.push(() => ({ body: [ORGS[0]] }));
		const { ctx, selects } = fakeCtx(undefined);
		await switchWorkspace(ctx);
		expect(selects.length).toBe(0);
		expect(getActiveOrg()?.orgID).toBe("wrk_1");
	});

	test("not signed in: warns and does nothing", async () => {
		const { ctx, notes } = fakeCtx(undefined, "");
		await switchWorkspace(ctx);
		expect(getActiveOrg()).toBeUndefined();
		expect(notes.some((n) => n.type === "warning" && n.message.includes("/login"))).toBe(true);
	});

	test("catalog refresh follows the override org", async () => {
		mockFetch();
		responses.push(() => ({ body: [ORGS[1]] }));
		const { ctx } = fakeCtx(undefined);
		await switchWorkspace(ctx);

		const seenOrgs: unknown[] = [];
		mockFetch();
		responses.push((call) => {
			seenOrgs.push(call.headers?.["x-org-id"]);
			return { body: { config: { provider: { opencode: { models: {} } } } } };
		});
		const published: any[] = [];
		await provider.refreshModels?.({
			allowNetwork: true,
			credential: { type: "oauth", refresh: "r", access: "a", expires: 0, orgID: "wrk_1" },
			signal: new AbortController().signal,
			stored: { models: [] },
			publish: async (p: any) => {
				p.update?.();
				published.push(p);
				return true;
			},
		} as any);
		expect(seenOrgs).toEqual(["wrk_2"]);
	});

});

describe("filterModels with an active override", () => {
	test("passes the fresh catalog through instead of the stale allowlist", async () => {
		mockFetch();
		responses.push(() => ({ body: ORGS }));
		const { ctx } = fakeCtx("Two (wrk_2)");
		await switchWorkspace(ctx);
		const models = [{ id: "m2" }, { id: "other" }] as any;
		const visible = provider.filterModels?.(models, {
			type: "oauth",
			refresh: "r",
			access: "a",
			expires: 0,
			orgID: "wrk_1",
			allowedModels: ["m2"],
		} as any);
		expect(visible?.map((m: any) => m.id)).toEqual(["m2", "other"]);
	});
});

describe("command registration", () => {
	test("registers the opencode-zen command", () => {
		const names: string[] = [];
		registerZenCommands({ registerProvider: () => {}, registerCommand: (name: string) => names.push(name) } as any);
		expect(names).toEqual(["opencode-zen"]);
	});

	test("request auth carries the override org header", async () => {
		mockFetch();
		responses.push(() => ({ body: ORGS }));
		const { ctx } = fakeCtx("Two (wrk_2)");
		await switchWorkspace(ctx);
		const auth = await (provider.auth as any).oauth.toAuth({
			type: "oauth",
			refresh: "r",
			access: "a",
			expires: 0,
			orgID: "wrk_1",
		});
		expect(auth.headers["x-opencode-org-id"]).toBe("wrk_2");
	});
});
