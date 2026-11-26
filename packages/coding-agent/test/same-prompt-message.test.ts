import { describe, expect, it } from "vitest";
import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	samePromptMessage,
} from "../src/core/messages.ts";

// #10956: cache warming compares the request's messages with the session's
// current ones after the session rebuilt them from entries.
describe("samePromptMessage", () => {
	const at = (ms: number) => new Date(ms).toISOString();

	it("matches rebuilt custom messages that send the same content", () => {
		const live = createCustomMessage("note", "x", true, undefined, at(5));
		const rebuilt = createCustomMessage("note", "x", false, { other: true }, at(9));
		expect(samePromptMessage(live, rebuilt)).toBe(true);

		const image = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
		const blocks = createCustomMessage("note", [{ type: "text", text: "x" }, image], true, undefined, at(5));
		const rebuiltBlocks = createCustomMessage(
			"note",
			[{ type: "text", text: "x" }, { ...image }],
			true,
			undefined,
			at(9),
		);
		expect(samePromptMessage(blocks, rebuiltBlocks)).toBe(true);
	});

	it("detects a changed custom message", () => {
		const live = createCustomMessage("note", [{ type: "text", text: "x" }], true, undefined, at(5));
		expect(
			samePromptMessage(live, createCustomMessage("note", [{ type: "text", text: "y" }], true, undefined, at(5))),
		).toBe(false);
		expect(samePromptMessage(live, createCustomMessage("note", [], true, undefined, at(5)))).toBe(false);
	});

	it("matches rebuilt summaries by summary text", () => {
		expect(
			samePromptMessage(
				createCompactionSummaryMessage("s", 10, at(5)),
				createCompactionSummaryMessage("s", 20, at(9)),
			),
		).toBe(true);
		expect(
			samePromptMessage(
				createCompactionSummaryMessage("s", 10, at(5)),
				createCompactionSummaryMessage("t", 10, at(5)),
			),
		).toBe(false);
		expect(
			samePromptMessage(createBranchSummaryMessage("s", "a", at(5)), createBranchSummaryMessage("s", "b", at(9))),
		).toBe(true);
		expect(
			samePromptMessage(createBranchSummaryMessage("s", "a", at(5)), createCompactionSummaryMessage("s", 10, at(5))),
		).toBe(false);
	});

	it("compares other roles by identity", () => {
		const user = { role: "user" as const, content: "x", timestamp: 0 };
		expect(samePromptMessage(user, user)).toBe(true);
		expect(samePromptMessage(user, { ...user })).toBe(false);
	});
});
