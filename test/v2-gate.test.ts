import { describe, expect, test } from "bun:test";
import { buildTextToolProtocol, convertTextToolMessage, flattenHistory, injectMarker, extractToolBlocks, shapeFreeTierRequest, ZEN_MARKER_PROMPT } from "../src/v2-gate.ts";

describe("v2 gate request shaping", () => {
	test("prepends the exact marker then keeps system and user messages within the input budget", () => {
		const input = [{ role: "system", content: "Keep answers concise." }, { role: "user", content: "Say OK" }];
		const shaped = flattenHistory(injectMarker({ input }));
		expect(shaped).toHaveLength(3);
		expect(shaped[0]).toEqual({ role: "developer", content: ZEN_MARKER_PROMPT });
		expect((shaped[1] as any).content).toContain("Keep answers concise.");
		expect((shaped[2] as any).role).toBe("user");
	});

	test("collapses prior turns and tool outputs into one user transcript", () => {
		const toolText = '```tool\n{"name":"read","arguments":{"path":"x"}}\n```';
		const input = [
			{ role: "user", content: "Read x" },
			{ role: "assistant", content: [{ type: "text", text: toolText }] },
			{ type: "function_call_output", call_id: "1", output: "ok" },
			{ role: "user", content: "Now answer" },
		];
		const shaped = flattenHistory(injectMarker({ input, tools: [{ type: "function", name: "read" }] }));
		expect(shaped).toHaveLength(2);
		expect((shaped[1] as any).content[0].text).toContain("[assistant tool call: read");
		expect((shaped[1] as any).content[0].text).toContain("[tool result");
	});

	test("strips native tools and tool_choice from the outbound payload", () => {
		const shaped = shapeFreeTierRequest({ input: [{ role: "user", content: "hi" }], tools: [{ type: "function", name: "read" }], tool_choice: "auto" });
		expect(shaped.tools).toBeUndefined();
		expect(shaped.tool_choice).toBeUndefined();
		expect(shaped.input).toHaveLength(2);
	});

	test("builds text protocol instructions from real tool schemas", () => {
		const prompt = buildTextToolProtocol([{ name: "bash", description: "Run commands", parameters: { type: "object", properties: { command: { type: "string" } } } }]);
		expect(prompt).toContain("```tool");
		expect(prompt).toContain("bash");
		expect(prompt).toContain('"command"');
	});

	test("converts fenced assistant blocks into native Pi tool calls", () => {
		const message: any = { role: "assistant", provider: "opencode-zen", model: "muse-spark-1.3-contributor-free", content: [{ type: "text", text: '```tool\n{"name":"bash","arguments":{"command":"echo ok"}}\n```' }], stopReason: "stop" };
		const converted = convertTextToolMessage(message);
		expect(converted?.content[0]).toMatchObject({ type: "toolCall", name: "bash", arguments: { command: "echo ok" } });
		expect(converted?.stopReason).toBe("toolUse");
	});

	test("parses fenced tool calls from assistant text", () => {
		const parsed = extractToolBlocks({ content: [{ type: "text", text: 'before\n```tool\n{"name":"bash","arguments":{"command":"echo ok"}}\n```\nafter' }] });
		expect(parsed.toolCalls).toHaveLength(1);
		expect(parsed.toolCalls[0]).toMatchObject({ name: "bash", arguments: { command: "echo ok" } });
		expect(parsed.textBlocks.map((x) => x.text).join(" ")).toContain("before");
		expect(parsed.textBlocks.map((x) => x.text).join(" ")).toContain("after");
	});
});
