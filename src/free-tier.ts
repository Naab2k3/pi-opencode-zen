const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const GATE_UA = "opencode/latest/2.0.32/cli";

export function freeTierSessionId(): string {
	const current = BigInt(Date.now()) * 0x1000n + 1n;
	const value = (~current) & ((1n << 48n) - 1n);
	const time = value.toString(16).padStart(12, "0").slice(-12);
	const bytes = new Uint8Array(14);
	crypto.getRandomValues(bytes);
	return `ses_${time}${Array.from(bytes, (byte) => B62[byte % 62]).join("")}`;
}

export function freeTierHeaders(session = freeTierSessionId()): Record<string, string> {
	return {
		"User-Agent": GATE_UA,
		"x-opencode-client": "cli",
		"x-opencode-session": session,
		// The gate now checks this duplicate header as well, with the same value
		// (verified against opencode 2.0.29); without it every free model 403s.
		"x-opencode-session-id": session,
	};
}

export function isZeroCostModel(model: { cost?: { input?: number; output?: number } }): boolean {
	const cost = model.cost;
	return cost !== undefined && (cost.input ?? 0) <= 0 && (cost.output ?? 0) <= 0;
}
