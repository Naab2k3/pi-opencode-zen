import { afterEach, describe, expect, test } from "bun:test";
import {
	CONSOLE,
	CLIENT_ID,
	UA_FALLBACK,
	deviceToken,
	fetchOrgs,
	loginZen,
	refreshZenToken,
	userAgent,
} from "./auth.ts";

type FetchCall = { url: string; body: any };
let responses: ((call: FetchCall) => { status?: number; body: any })[] = [];
let calls: FetchCall[] = [];
const realFetch = globalThis.fetch;

function mockFetch() {
	calls = [];
	globalThis.fetch = (async (url: any, init?: any) => {
		const call: FetchCall = { url: String(url), body: init?.body ? JSON.parse(init.body) : undefined };
		calls.push(call);
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
	responses = [];
});

const interaction = (pickWorkspace?: string) => ({
	signal: new AbortController().signal,
	notify: () => {},
	prompt: async () => {
		if (!pickWorkspace) throw new Error("prompt should not be called");
		return pickWorkspace;
	},
});

const okToken = { access_token: "acc", refresh_token: "ref", expires_in: 3600 };

describe("userAgent", () => {
	test("falls back when registry is unreachable", async () => {
		globalThis.fetch = (async () => {
			throw new Error("offline");
		}) as typeof fetch;
		expect(await userAgent()).toBe(UA_FALLBACK);
	});
});

describe("deviceToken", () => {
	test("accepts HTTP 400 error bodies as poll results", async () => {
		mockFetch();
		responses.push(() => ({ status: 400, body: { error: "authorization_pending" } }));
		const poll = await deviceToken({ grant_type: "device", device_code: "x" });
		expect(poll.error).toBe("authorization_pending");
		expect(calls[0].url).toBe(`${CONSOLE}/auth/device/token`);
		expect(calls[0].body.client_id).toBe(CLIENT_ID);
	});

	test("throws on non-400 errors", async () => {
		mockFetch();
		responses.push(() => ({ status: 500, body: { message: "boom" } }));
		expect(deviceToken({})).rejects.toThrow("HTTP 500");
	});
});

describe("fetchOrgs", () => {
	test("parses org list", async () => {
		mockFetch();
		responses.push(() => ({ body: [{ id: "wrk_1", name: "Mei Sheng" }] }));
		const orgs = await fetchOrgs("tok");
		expect(orgs).toEqual([{ id: "wrk_1", name: "Mei Sheng" }]);
	});

	test("fails loud on HTTP error", async () => {
		mockFetch();
		responses.push(() => ({ status: 403, body: {} }));
		expect(fetchOrgs("tok")).rejects.toThrow("HTTP 403");
	});
});

describe("loginZen", () => {
	const deviceStart = {
		device_code: "dc",
		user_code: "ABCD-EFGH",
		verification_uri_complete: "/console/device?user_code=ABCD-EFGH",
		expires_in: 900,
		interval: 0.001,
	};

	test("single workspace: orgID set without prompting", async () => {
		mockFetch();
		responses.push(() => ({ body: deviceStart }));
		responses.push(() => ({ body: okToken }));
		responses.push(() => ({ body: [{ id: "wrk_single", name: "Only" }] }));
		const credential = await loginZen(interaction());
		expect(credential).toEqual({ type: "oauth", refresh: "ref", access: "acc", expires: expect.any(Number), orgID: "wrk_single" });
	});

	test("multiple workspaces: prompts selection", async () => {
		mockFetch();
		responses.push(() => ({ body: deviceStart }));
		responses.push(() => ({ body: okToken }));
		responses.push(() => ({ body: [{ id: "wrk_a", name: "A" }, { id: "wrk_b", name: "B" }] }));
		const credential = await loginZen(interaction("wrk_b"));
		expect(credential.orgID).toBe("wrk_b");
	});

	test("device link is resolved against the console URL", async () => {
		mockFetch();
		responses.push(() => ({ body: deviceStart }));
		responses.push(() => ({ body: { error: "access_denied", error_description: "no" } }));
		let notified: any;
		await loginZen({
			...interaction(),
			notify: (event) => (notified = event),
		}).catch(() => {});
		expect(notified.verificationUri).toBe("https://opencode.ai/console/device?user_code=ABCD-EFGH");
	});

	test("slow_down extends the poll interval and keeps polling", async () => {
		mockFetch();
		responses.push(() => ({ body: deviceStart }));
		responses.push(() => ({ body: { error: "slow_down" } }));
		responses.push(() => ({ body: { error: "authorization_pending" } }));
		responses.push(() => ({ body: okToken }));
		responses.push(() => ({ body: [] }));
		const credential = await loginZen(interaction());
		expect(credential.access).toBe("acc");
		expect(calls.filter((c) => c.url.endsWith("/auth/device/token")).length).toBe(3);
	}, 15000);

	test("surfaces terminal poll errors", async () => {
		mockFetch();
		responses.push(() => ({ body: deviceStart }));
		responses.push(() => ({ body: { error: "access_denied", error_description: "nope" } }));
		expect(loginZen(interaction())).rejects.toThrow("access_denied");
	});
});

describe("refreshZenToken", () => {
	test("refreshes and preserves orgID", async () => {
		mockFetch();
		responses.push(() => ({ body: okToken }));
		const credential = await refreshZenToken(
			{ type: "oauth", refresh: "old-ref", access: "old", expires: 0, orgID: "wrk_keep" },
			new AbortController().signal,
		);
		expect(credential).toEqual({ type: "oauth", refresh: "ref", access: "acc", expires: expect.any(Number), orgID: "wrk_keep" });
		expect(calls[0].body.refresh_token).toBe("old-ref");
	});
});
