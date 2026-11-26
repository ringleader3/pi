import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { userMsg } from "./utilities.ts";

// #12120: compaction removes older messages from the interactive transcript.
// transcriptHistory "branch" keeps them visible without changing model context.
function createUI(history: "context" | "branch") {
	const sessionManager = SessionManager.inMemory();
	const oldId = sessionManager.appendMessage(userMsg("old message"));
	const keptId = sessionManager.appendMessage(userMsg("kept message"));
	sessionManager.appendCompaction("first summary", keptId, 100);
	const ui = {
		isInitialized: true,
		sessionManager,
		settingsManager: SettingsManager.inMemory({ transcriptHistory: history }),
		chatContainer: { clear: vi.fn() },
		pendingTools: new Map([["live-tool", {}]]),
		streamingComponent: {},
		entriesRenderedByBoundaryCompaction: new Set<string>(),
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		defaultEditor: {},
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		renderSessionEntries: vi.fn(),
		addMessageToChat: vi.fn(),
		addCompactionCostNotice: vi.fn(),
		clearStatusIndicator: vi.fn(),
		flushCompactionQueue: vi.fn(async () => {}),
		renderProjectTrustWarningIfNeeded: vi.fn(),
		showStatus: vi.fn(),
		getTranscriptEntries(): ReturnType<SessionManager["getBranch"]> {
			return Reflect.get(InteractiveMode.prototype, "getTranscriptEntries").call(this);
		},
	};
	return { ui, oldId, keptId };
}

async function event(ui: ReturnType<typeof createUI>["ui"], value: AgentSessionEvent) {
	await Reflect.get(InteractiveMode.prototype, "handleEvent").call(ui, value);
}

describe("display-only transcript history", () => {
	test("real transcript components retain earlier messages and each summary exactly once", async () => {
		initTheme("dark");
		const { ui: base, keptId } = createUI("branch");
		const ui = {
			...base,
			chatContainer: new Container(),
			toolOutputExpanded: true,
			outputPad: 1,
			session: {},
			getMarkdownThemeWithSettings: getMarkdownTheme,
			getMarkdownTransformers: () => [],
		};
		// Exercise Pi's real entry conversion and renderers, not only the selection seam.
		for (const method of ["renderSessionEntries", "renderSessionItems", "addMessageToChat", "getUserMessageText"]) {
			Reflect.set(ui, method, Reflect.get(InteractiveMode.prototype, method));
		}
		Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages").call(ui);
		const output = () => stripAnsi(ui.chatContainer.render(100).join("\n"));
		expect(output()).toContain("old message");
		expect(output()).toContain("first summary");
		const before = structuredClone(ui.sessionManager.buildSessionProjection().messages);
		ui.sessionManager.appendCompaction("second summary", keptId, 200);
		await Reflect.get(InteractiveMode.prototype, "handleEvent").call(ui, {
			type: "compaction_end",
			reason: "manual",
			result: { summary: "second summary", firstKeptEntryId: keptId, tokensBefore: 200 },
			aborted: false,
			willRetry: false,
		});
		expect(output()).toContain("old message");
		expect(output().match(/second summary/g)).toHaveLength(1);
		const compacted = structuredClone(ui.sessionManager.buildSessionProjection().messages);
		ui.settingsManager.setTranscriptHistory("context");
		Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages").call(ui);
		expect(output()).not.toContain("old message");
		ui.settingsManager.setTranscriptHistory("branch");
		Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages").call(ui);
		expect(output()).toContain("old message");
		expect(output().match(/first summary/g)).toHaveLength(1);
		expect(output().match(/second summary/g)).toHaveLength(1);
		expect(ui.sessionManager.buildSessionProjection().messages).toEqual(compacted);
		expect(compacted).not.toEqual(before);
	});
	test("defaults to context and persists the selection with ordinary trust and precedence", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () => JSON.stringify({ transcriptHistory: "branch" }));
		const trusted = SettingsManager.fromStorage(storage);
		expect(trusted.getTranscriptHistory()).toBe("branch");
		const untrusted = SettingsManager.fromStorage(storage, { projectTrusted: false });
		expect(untrusted.getTranscriptHistory()).toBe("context");
		untrusted.setTranscriptHistory("branch");
		await untrusted.flush();
		expect(SettingsManager.fromStorage(storage, { projectTrusted: false }).getTranscriptHistory()).toBe("branch");
		expect(SettingsManager.inMemory().getTranscriptHistory()).toBe("context");
	});

	test("initial load and rebuild select full active branch without changing context or entries", () => {
		const { ui, oldId, keptId } = createUI("branch");
		const stored = structuredClone(ui.sessionManager.getEntries());
		const context = structuredClone(ui.sessionManager.buildContextEntries());
		Reflect.get(InteractiveMode.prototype, "renderInitialMessages").call(ui);
		expect(ui.renderSessionEntries.mock.calls[0][0].map((entry: { id: string }) => entry.id)).toContain(oldId);
		ui.settingsManager.setTranscriptHistory("context");
		Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages").call(ui);
		expect(ui.renderSessionEntries.mock.lastCall?.[0]).toEqual(context);
		ui.settingsManager.setTranscriptHistory("branch");
		ui.sessionManager.branch(keptId);
		ui.sessionManager.appendMessage(userMsg("new branch"));
		Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages").call(ui);
		expect(ui.renderSessionEntries.mock.lastCall?.[0]).toEqual(ui.sessionManager.getBranch());
		expect(
			ui.renderSessionEntries.mock.lastCall?.[0].some((entry: { type: string }) => entry.type === "compaction"),
		).toBe(false);
		expect(stored).toEqual(ui.sessionManager.getEntries().slice(0, stored.length));
	});

	test.each(["manual", "threshold", "overflow"] as const)(
		"%s compaction appends one summary and preserves live rows",
		async (reason) => {
			const { ui, keptId } = createUI("branch");
			ui.sessionManager.appendCompaction("second summary", keptId, 200);
			const streaming = ui.streamingComponent;
			await event(ui, {
				type: "compaction_end",
				reason,
				result: { summary: "second summary", firstKeptEntryId: keptId, tokensBefore: 200 },
				aborted: false,
				willRetry: reason === "overflow",
			});
			expect(ui.chatContainer.clear).not.toHaveBeenCalled();
			expect(ui.renderSessionEntries).not.toHaveBeenCalled();
			expect(ui.addMessageToChat).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ role: "compactionSummary", summary: "second summary" }),
			);
			expect(ui.pendingTools.has("live-tool")).toBe(true);
			expect(ui.streamingComponent).toBe(streaming);
			expect(
				ui.sessionManager
					.buildContextEntries()
					.filter((entry) => entry.type === "message")
					.map((entry) => entry.id),
			).not.toContain(ui.sessionManager.getBranch()[0].id);
		},
	);

	test("boundary compaction does not clear pending tools or duplicate later entries", async () => {
		const { ui, keptId } = createUI("branch");
		ui.sessionManager.appendCompaction("boundary summary", keptId, 200);
		const entry = ui.sessionManager.getBranch().at(-1)!;
		await event(ui, { type: "entry_appended", entry });
		expect(ui.chatContainer.clear).not.toHaveBeenCalled();
		expect(ui.renderSessionEntries).not.toHaveBeenCalled();
		expect(ui.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(ui.pendingTools.has("live-tool")).toBe(true);
		expect(ui.entriesRenderedByBoundaryCompaction.size).toBe(0);
	});
});
