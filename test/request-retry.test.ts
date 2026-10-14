import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { withRequestRetries } from "../src/retry.ts";

// Part 1 (parity issue #6, area: request lifecycle): the extension must retry
// recoverable failures the way pi-provider-opencode-console's streamConsole
// does — bounded transient retries with backoff, 400-option patching —
// instead of surfacing the first gateway error. All offline: scripted inner
// streams, no network.

type Attempt = { events?: any[]; throwSync?: unknown };

function doneEvent() {
	return { type: "done", reason: "stop", message: { role: "assistant", content: [], timestamp: Date.now() } };
}

function errorEvent(message: string) {
	return {
		type: "error",
		reason: "error",
		error: { role: "assistant", content: [], errorMessage: message, timestamp: Date.now() },
	};
}

function scriptedInner(attempts: Attempt[]) {
	const calls: any[] = [];
	const inner = {
		streamSimple: (_model: any, _context: any, options: any) => {
			calls.push(options);
			const attempt = attempts[Math.min(calls.length - 1, attempts.length - 1)]!;
			if (attempt.throwSync) throw attempt.throwSync;
			const s = createAssistantMessageEventStream();
			queueMicrotask(() => {
				for (const e of attempt.events ?? []) s.push(e);
				s.end();
			});
			return s;
		},
	};
	return { inner, calls };
}

async function drain(stream: AsyncIterable<any>) {
	const events: any[] = [];
	for await (const e of stream) events.push(e);
	return events;
}

const model = { id: "glm-5.3-flash", api: "openai-completions" } as any;
const context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as any;
const noSleep = () => Promise.resolve();

describe("transient retries", () => {
	test("502 then success: retried once, consumer sees one clean stream", async () => {
		const { inner, calls } = scriptedInner([
			{ events: [errorEvent("request failed (502): Bad Gateway")] },
			{ events: [doneEvent()] },
		]);
		const wrapped = withRequestRetries(inner, { sleep: noSleep });
		const events = await drain(wrapped.streamSimple(model, context, { apiKey: "k" } as any));
		expect(calls.length).toBe(2);
		expect(events.map((e) => e.type)).toEqual(["done"]);
	});

	test("non-transient 500 surfaces immediately without retry", async () => {
		const { inner, calls } = scriptedInner([{ events: [errorEvent("request failed (500): boom")] }]);
		const wrapped = withRequestRetries(inner, { sleep: noSleep });
		const events = await drain(wrapped.streamSimple(model, context, { apiKey: "k" } as any));
		expect(calls.length).toBe(1);
		expect(events.map((e) => e.type)).toEqual(["error"]);
		expect(events[0].error.errorMessage).toContain("500");
	});

	test("persistent 503 gives up after the bound and surfaces the error", async () => {
		const { inner, calls } = scriptedInner([{ events: [errorEvent("request failed (503): unavailable")] }]);
		const wrapped = withRequestRetries(inner, { maxTransientRetries: 2, sleep: noSleep });
		const events = await drain(wrapped.streamSimple(model, context, { apiKey: "k" } as any));
		expect(calls.length).toBe(3);
		expect(events.map((e) => e.type)).toEqual(["error"]);
	});

	test("sync-thrown network failure is retried", async () => {
		const { inner, calls } = scriptedInner([
			{ throwSync: new TypeError("fetch failed") },
			{ events: [doneEvent()] },
		]);
		const wrapped = withRequestRetries(inner, { sleep: noSleep });
		const events = await drain(wrapped.streamSimple(model, context, { apiKey: "k" } as any));
		expect(calls.length).toBe(2);
		expect(events.map((e) => e.type)).toEqual(["done"]);
	});

	test("error after forwarded events is never retried", async () => {
		const { inner, calls } = scriptedInner([
			{ events: [{ type: "text_start", contentIndex: 0, partial: {} }, errorEvent("request failed (502): late")] },
		]);
		const wrapped = withRequestRetries(inner, { sleep: noSleep });
		const events = await drain(wrapped.streamSimple(model, context, { apiKey: "k" } as any));
		expect(calls.length).toBe(1);
		expect(events.map((e) => e.type)).toEqual(["text_start", "error"]);
	});
});

describe("400 patch retries", () => {
	test("rejected temperature is dropped and the request retried", async () => {
		const { inner, calls } = scriptedInner([
			{ events: [errorEvent("request failed (400): temperature is not supported for this model")] },
			{ events: [doneEvent()] },
		]);
		const wrapped = withRequestRetries(inner, { sleep: noSleep });
		const events = await drain(
			wrapped.streamSimple(model, context, { apiKey: "k", temperature: 0.7 } as any),
		);
		expect(calls.length).toBe(2);
		expect("temperature" in calls[1]).toBe(false);
		expect(events.map((e) => e.type)).toEqual(["done"]);
	});

	test("400 without a patchable option surfaces immediately", async () => {
		const { inner, calls } = scriptedInner([
			{ events: [errorEvent("request failed (400): invalid request")] },
		]);
		const wrapped = withRequestRetries(inner, { sleep: noSleep });
		const events = await drain(wrapped.streamSimple(model, context, { apiKey: "k" } as any));
		expect(calls.length).toBe(1);
		expect(events.map((e) => e.type)).toEqual(["error"]);
	});

	test("abort during backoff stops retrying", async () => {
		const controller = new AbortController();
		const { inner, calls } = scriptedInner([
			{ events: [errorEvent("request failed (503): unavailable")] },
			{ events: [doneEvent()] },
		]);
		const wrapped = withRequestRetries(inner, {
			sleep: () => {
				controller.abort();
				return Promise.reject(new Error("aborted"));
			},
		});
		const events = await drain(
			wrapped.streamSimple(model, context, { apiKey: "k", signal: controller.signal } as any),
		);
		expect(calls.length).toBe(1);
		expect(events[events.length - 1].type).toBe("error");
	});
});
