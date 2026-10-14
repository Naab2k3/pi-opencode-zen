import {
	createAssistantMessageEventStream,
	type AssistantMessageEventStream,
} from "@earendil-works/pi-ai/compat";

// Bounded retries for recoverable gateway failures (parity with
// pi-provider-opencode-console's streamConsole): transient network/server
// errors and 400s naming a rejected option. A retry only happens before any
// event reaches the consumer, so a partially-forwarded response is never
// re-sent. Mid-stream 401 refresh is intentionally out of scope: extension
// streams cannot reach pi's credential store (the runtime owns refresh).

export interface RequestRetryPolicy {
	maxTransientRetries?: number;
	maxPatchRetries?: number;
	backoffMs?: (attempt: number) => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Exponential backoff capped at 2s: 250, 500, 1000, 2000… */
export function retryDelayMs(attempt: number): number {
	return Math.min(2_000, 250 * 2 ** Math.max(0, attempt));
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const t = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(t);
				reject(signal.reason ?? new Error("aborted"));
			},
			{ once: true },
		);
	});
}

/** Extract an HTTP status (400-599) from a formatted provider error message. */
function statusFromErrorMessage(message: string): number | undefined {
	const paren = /\((\d{3})\)/.exec(message);
	const status = paren
		? Number(paren[1])
		: Number(/\b(\d{3}) status code\b/.exec(message)?.[1] ?? /^\s*(\d{3})\b/.exec(message.trim())?.[1]);
	if (!Number.isInteger(status) || status < 400 || status > 599) return undefined;
	return status;
}

function isTransientServerError(status: number, detail: string): boolean {
	return (
		status === 502 ||
		status === 503 ||
		status === 504 ||
		(status === 500 &&
			(/Router[._-]?Unavailable/i.test(detail) ||
				/(?:^|:\s|\b\d{3}\b\s*)Internal server error\.?\s*$/i.test(detail)))
	);
}

const NETWORK_PATTERN =
	/fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|socket hang up|terminated/i;

function isTransientNetworkError(error: unknown): boolean {
	if (!(error instanceof Error) || error.name === "AbortError") return false;
	const detail = `${error.name}: ${error.message} ${networkCause(error)}`;
	return NETWORK_PATTERN.test(detail);
}

function networkCause(error: Error): string {
	const cause = (error as Error & { cause?: unknown }).cause;
	if (cause instanceof Error) return `${cause.name}: ${cause.message} ${networkCause(cause)}`;
	return typeof cause === "string" ? cause : "";
}

// A 400 names the option the gateway rejected when a rejection qualifier
// (invalid / not supported / ...) sits near the field name, either order.
const PATCHABLE: Array<[RegExp, string]> = [
	[/\btemperature\b/i, "temperature"],
	// bare "thinking" maps to "reasoning" on purpose: pi-ai derives the wire
	// thinking payload from the reasoning level, so dropping reasoning is the
	// only retry available when the gateway rejects a thinking field.
	[/\b(?:enable_thinking|thinking(?:_budget|\.type)?|reasoning(?:_effort)?)\b/i, "reasoning"],
	[/\bbudget_tokens\b|\bthinking_budgets\b/i, "thinkingBudgets"],
];

function rejectedOption(message: string): string | undefined {
	for (const [field, option] of PATCHABLE) {
		if (!field.test(message)) continue;
		const hit = new RegExp(
			`(?:invalid|not supported|unsupported|only accepts|extra inputs)[^\\n]{0,120}${field.source}|${field.source}[^\\n]{0,120}(?:invalid|not supported|unsupported|only accepts)`,
			"i",
		);
		if (hit.test(message)) return option;
	}
	return undefined;
}

type StreamFn = (model: any, context: any, options?: any) => AssistantMessageEventStream;

function failedEvent(model: any, reason: "error" | "aborted", message: string): any {
	return {
		type: "error",
		reason,
		error: {
			role: "assistant",
			content: [],
			api: model?.api,
			provider: model?.provider,
			model: model?.id,
			stopReason: reason,
			errorMessage: message,
			timestamp: Date.now(),
		},
	};
}

function runWithRetries(
	fn: StreamFn,
	model: any,
	context: any,
	options: any,
	maxTransient: number,
	maxPatch: number,
	backoffMs: (attempt: number) => number,
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	(async () => {
		let currentOptions = options;
		let transientRetries = 0;
		let patchRetries = 0;
		for (;;) {
			let inner: AssistantMessageEventStream | undefined;
			let thrown: unknown;
			let syncError: unknown;
			let hasSyncError = false;
			try {
				inner = fn(model, context, currentOptions);
			} catch (err) {
				syncError = err;
				hasSyncError = true;
			}
			let forwarded = 0;
			let failed: any | undefined;
			let completed = false;
			if (!hasSyncError) {
				try {
					for await (const event of inner!) {
						if ((event as any)?.type === "error") {
							failed = event;
							break;
						}
						out.push(event);
						forwarded++;
						if ((event as any)?.type === "done") {
							completed = true;
							break;
						}
					}
				} catch (err) {
					thrown = err;
				}
			} else {
				thrown = syncError;
			}
			if (completed) {
				out.end();
				return;
			}
			const message = failed
				? String(failed.error?.errorMessage ?? "request failed")
				: thrown !== undefined
					? (thrown instanceof Error ? thrown.message : String(thrown))
					: "request failed";
			const status = statusFromErrorMessage(message);
			const signal = currentOptions?.signal as AbortSignal | undefined;
			// 400 naming a rejected option: drop it and retry.
			if (status === 400 && forwarded === 0 && patchRetries < maxPatch) {
				const option = rejectedOption(message);
				if (option && currentOptions?.[option] !== undefined) {
					currentOptions = { ...currentOptions };
					delete currentOptions[option];
					patchRetries++;
					continue;
				}
			}
			// Transient failure: back off and retry.
			const retryable =
				forwarded === 0 &&
				transientRetries < maxTransient &&
				(thrown !== undefined
					? isTransientNetworkError(thrown)
					: status !== undefined && isTransientServerError(status, message));
			if (retryable) {
				try {
					await sleep(backoffMs(transientRetries), signal);
				} catch {
					out.push(failedEvent(model, "aborted", message));
					out.end();
					return;
				}
				if (signal?.aborted) {
					out.push(failedEvent(model, "aborted", message));
					out.end();
					return;
				}
				transientRetries++;
				continue;
			}
			if (failed) out.push(failed);
			else out.push(failedEvent(model, signal?.aborted ? "aborted" : "error", message));
			out.end();
			return;
		}
	})();
	return out;
}

export function withRequestRetries<T extends object>(streams: T, policy: RequestRetryPolicy = {}): T {
	const s = streams as unknown as Record<string, StreamFn>;
	const maxTransient = policy.maxTransientRetries ?? 2;
	const maxPatch = policy.maxPatchRetries ?? 2;
	const backoffMs = policy.backoffMs ?? retryDelayMs;
	const sleep = policy.sleep ?? defaultSleep;
	const wrap = (fn: StreamFn): StreamFn => (model, context, options) =>
		runWithRetries(fn, model, context, options, maxTransient, maxPatch, backoffMs, sleep);
	const out: Record<string, StreamFn> = { ...s };
	if (typeof s.stream === "function") out.stream = wrap(s.stream);
	if (typeof s.streamSimple === "function") out.streamSimple = wrap(s.streamSimple);
	return out as T;
}
