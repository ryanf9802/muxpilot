import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMessage, ManagedSession, QuestionRequest, RepoMetadata, TranscriptItem } from "@muxpilot/core";
import {
  activeSkillToken,
  appendUniqueTranscriptItems,
  appendUniqueMessages,
  buildQuestionAnswerRequest,
  composerLockReason,
  composerDraftStorageKey,
  createPendingUserMessage,
  elapsedSince,
  formatElapsedSeconds,
  groupEventStacks,
  groupStackableMessages,
  isDesktopVimAvailable,
  isPlanModeMessage,
  inputModeAction,
  latestUserPromptTimestamp,
  MarkdownBlock,
  MessageBubble,
  ModeToggle,
  modelAction,
  modelSelectorOptions,
  pendingProposedPlanMessage,
  pendingUserMessageToChatMessage,
  planActionRequest,
  planActionText,
  questionRemainingSeconds,
  parseProposedPlanSegments,
  queuedInputHasLineBreaks,
  relativeLineNumber,
  replaceTranscriptTail,
  loadComposerDraft,
  loadVimModePreference,
  sessionWithPendingInputMode,
  saveComposerDraft,
  saveVimModePreference,
  restoreScrollTopForAnchor,
  secondsUntil,
  SessionHeaderMeta,
  isNearMessageListBottom,
  isCodexPastedContentPlaceholder,
  scrollMessageListToBottom,
  scrollBehaviorForTranscriptUpdate,
  shouldQueueComposerInput,
  shouldHideInitialMessageList,
  shouldShowSessionLoading,
  shouldShowWorkingIndicator,
  shouldReconcileSessionForEvent,
  shouldSubmitComposer,
  skillSuggestionScore,
  skillSuggestions,
  stripAssistantSideChannelBlocks,
  transcriptItemsContainPendingUserMessage,
  replaceSkillToken,
  resizeComposerTextarea,
  reasoningEffortLabel,
  VimModeToggle,
  VIM_MODE_STORAGE_KEY,
  WorkingIndicator,
  UserText
} from "./SessionView.js";

function installLocalStorage(): Storage {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => values.set(key, value))
  } satisfies Storage;
  vi.stubGlobal("window", { localStorage: storage });
  return storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shouldSubmitComposer", () => {
  it("submits on Ctrl+Enter", () => {
    expect(shouldSubmitComposer({ ctrlKey: true, key: "Enter" })).toBe(true);
  });

  it("does not submit on plain Enter", () => {
    expect(shouldSubmitComposer({ ctrlKey: false, key: "Enter" })).toBe(false);
  });
});

describe("composerLockReason", () => {
  it("locks for pending question or plan actions", () => {
    expect(composerLockReason(true, true)).toBe("Answer the pending question below to continue");
    expect(composerLockReason(false, true)).toBe("Choose a proposed plan action below to continue");
    expect(composerLockReason(false, false)).toBeNull();
  });
});

describe("composer draft storage", () => {
  it("returns an empty draft when storage is empty or invalid", () => {
    const storage = installLocalStorage();

    expect(loadComposerDraft("session-a")).toBe("");
    storage.setItem(composerDraftStorageKey("session-a"), "{");
    expect(loadComposerDraft("session-a")).toBe("");
    storage.setItem(composerDraftStorageKey("session-a"), JSON.stringify({ text: 12 }));
    expect(loadComposerDraft("session-a")).toBe("");
  });

  it("round-trips exact draft text by session id", () => {
    installLocalStorage();

    saveComposerDraft("session-a", "first line\nsecond line  ");
    saveComposerDraft("session-b", "other draft");

    expect(loadComposerDraft("session-a")).toBe("first line\nsecond line  ");
    expect(loadComposerDraft("session-b")).toBe("other draft");
  });

  it("removes the stored draft when the value is empty", () => {
    const storage = installLocalStorage();

    saveComposerDraft("session-a", "draft");
    expect(storage.getItem(composerDraftStorageKey("session-a"))).not.toBeNull();

    saveComposerDraft("session-a", "");

    expect(loadComposerDraft("session-a")).toBe("");
    expect(storage.getItem(composerDraftStorageKey("session-a"))).toBeNull();
  });
});

describe("vim mode preference", () => {
  it("defaults to disabled when storage is empty or unavailable", () => {
    installLocalStorage();

    expect(loadVimModePreference()).toBe(false);
  });

  it("round-trips the persisted vim mode preference", () => {
    const storage = installLocalStorage();

    saveVimModePreference(true);
    expect(loadVimModePreference()).toBe(true);
    expect(storage.getItem(VIM_MODE_STORAGE_KEY)).toBe("true");

    saveVimModePreference(false);
    expect(loadVimModePreference()).toBe(false);
    expect(storage.getItem(VIM_MODE_STORAGE_KEY)).toBe("false");
  });
});

describe("desktop vim availability", () => {
  it("requires the desktop media query to match", () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn((query: string) => ({
        matches: query.includes("min-width: 560px") && query.includes("pointer: fine"),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    });

    expect(isDesktopVimAvailable()).toBe(true);
  });

  it("returns false when media query support is unavailable", () => {
    vi.stubGlobal("window", {});

    expect(isDesktopVimAvailable()).toBe(false);
  });
});

describe("vim line numbers", () => {
  it("formats relative distance from the active cursor line", () => {
    expect(relativeLineNumber(8, 8)).toBe("0");
    expect(relativeLineNumber(3, 8)).toBe("5");
    expect(relativeLineNumber(13, 8)).toBe("5");
  });
});

describe("VimModeToggle", () => {
  it("renders pressed state when enabled", () => {
    const html = renderToStaticMarkup(createElement(VimModeToggle, { enabled: true, onChange: vi.fn() }));

    expect(html).toContain("vim-toggle selected");
    expect(html).toContain('aria-label="Disable Vim mode"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('class="vim-logo"');
    expect(html).not.toContain(">Vim<");
  });

  it("renders unpressed state when disabled", () => {
    const html = renderToStaticMarkup(createElement(VimModeToggle, { enabled: false, onChange: vi.fn() }));

    expect(html).toContain("vim-toggle");
    expect(html).not.toContain("vim-toggle selected");
    expect(html).toContain('aria-label="Enable Vim mode"');
    expect(html).toContain('aria-pressed="false"');
  });
});

describe("resizeComposerTextarea", () => {
  it("grows to content height while content fits under the max", () => {
    vi.stubGlobal("window", {
      getComputedStyle: vi.fn(() => ({ minHeight: "52px", maxHeight: "180px" }))
    });
    const textarea = { scrollHeight: 120, scrollTop: 8, scrollLeft: 2, style: {} } as HTMLTextAreaElement;
    const mirror = { scrollTop: 0, scrollLeft: 0, style: {} } as HTMLElement;

    resizeComposerTextarea(textarea, mirror);

    expect(textarea.style.height).toBe("120px");
    expect(textarea.style.overflowY).toBe("hidden");
    expect(mirror.style.height).toBe("120px");
    expect(mirror.scrollTop).toBe(8);
    expect(mirror.scrollLeft).toBe(2);
  });

  it("caps height and enables textarea scrolling after the max", () => {
    vi.stubGlobal("window", {
      getComputedStyle: vi.fn(() => ({ minHeight: "52px", maxHeight: "180px" }))
    });
    const textarea = { scrollHeight: 260, scrollTop: 42, scrollLeft: 0, style: {} } as HTMLTextAreaElement;
    const mirror = { scrollTop: 0, scrollLeft: 0, style: {} } as HTMLElement;

    resizeComposerTextarea(textarea, mirror);

    expect(textarea.style.height).toBe("180px");
    expect(textarea.style.overflowY).toBe("auto");
    expect(mirror.style.height).toBe("180px");
    expect(mirror.scrollTop).toBe(42);
  });
});

describe("skill composer helpers", () => {
  const skills = [
    { name: "teamweave-browser", description: "Operate TeamWeave UI", source: "user" as const },
    { name: "github:yeet", description: "Publish local changes", source: "plugin" as const, pluginName: "github" },
    { name: "pr-to-stage", description: "Prepare stage PRs", source: "user" as const }
  ];

  it("detects active dollar skill tokens until whitespace", () => {
    expect(activeSkillToken("use $team", 9)).toEqual({ start: 4, end: 9, query: "team" });
    expect(activeSkillToken("use $team now", 10)).toBeNull();
  });

  it("filters skill suggestions by prefix before substring", () => {
    expect(skillSuggestions(skills, "ye").map((skill) => skill.name)).toEqual(["github:yeet"]);
    expect(skillSuggestions(skills, "to").map((skill) => skill.name)[0]).toBe("pr-to-stage");
  });

  it("fuzzy matches ordered abbreviation characters", () => {
    expect(skillSuggestions(skills, "tw").map((skill) => skill.name)).toContain("teamweave-browser");
    expect(skillSuggestionScore("teamweave-browser", "tw")).not.toBeNull();
    expect(skillSuggestionScore("teamweave-browser", "zz")).toBeNull();
  });

  it("replaces the active token with a plain Codex skill invocation", () => {
    expect(replaceSkillToken("use $team now", { start: 4, end: 9, query: "team" }, "teamweave-browser")).toEqual({
      text: "use $teamweave-browser now",
      caret: 23
    });
  });
});

describe("shouldQueueComposerInput", () => {
  it("queues when the session is busy or a queue already exists", () => {
    expect(shouldQueueComposerInput({ status: "working" }, [])).toBe(true);
    expect(shouldQueueComposerInput({ status: "waiting" }, [{ status: "queued" }])).toBe(true);
  });

  it("sends directly when the session is ready and the queue is empty", () => {
    expect(shouldQueueComposerInput({ status: "waiting" }, [])).toBe(false);
    expect(shouldQueueComposerInput({ status: "idle" }, [])).toBe(false);
  });
});

describe("SessionHeaderMeta", () => {
  it("shows the repo and branch without the activity summary", () => {
    const session = {
      repo: repo("muxpilot", "feature/activity-summary"),
      activitySummary: "Header summary display"
    } satisfies Pick<ManagedSession, "repo" | "activitySummary">;

    const html = renderToStaticMarkup(
      createElement(SessionHeaderMeta, {
        session
      })
    );

    expect(html).toContain("muxpilot");
    expect(html).toContain("feature/activity-summary");
    expect(html).toContain('class="session-header-repo"');
    expect(html).toContain('class="session-header-branch"');
    expect(html).toContain('class="session-header-branch-separator"');
    expect(html).not.toContain("Header summary display");
    expect(html).not.toContain("session-header-summary");
  });

  it("omits blank activity summaries", () => {
    const html = renderToStaticMarkup(
      createElement(SessionHeaderMeta, {
        session: {
          repo: repo("muxpilot", "main")
        }
      })
    );

    expect(html).toContain("muxpilot");
    expect(html).toContain("main");
    expect(html).not.toContain("session-header-summary");
  });
});

describe("appendUniqueMessages", () => {
  it("replaces duplicate message updates and ignores wrong-session messages", () => {
    const current = [message("session-a", 1, "first")];

    const result = appendUniqueMessages(
      current,
      [
        message("session-a", 1, "duplicate sequence"),
        message("session-b", 2, "other session"),
        message("session-a", 2, "second")
      ],
      "session-a"
    );

    expect(result.map((item) => item.text)).toEqual(["duplicate sequence", "second"]);
  });
});

describe("appendUniqueTranscriptItems", () => {
  it("appends and replaces transcript items by id or sequence span", () => {
    const first = transcriptMessageItem(message("session-a", 1, "first"));
    const stale = transcriptRangeItem("stale", "activity", 2, 3, "2 intermediate events");
    const replacement = transcriptRangeItem("replacement", "activity", 2, 3, "2 intermediate items");

    const result = appendUniqueTranscriptItems([first, stale], [replacement, transcriptMessageItem(message("session-a", 4, "done"))]);

    expect(result.map((item) => item.id)).toEqual([first.id, replacement.id, "session-a-4"]);
  });
});

describe("replaceTranscriptTail", () => {
  it("replaces stale live fragments with the refreshed grouped tail", () => {
    const older = transcriptMessageItem(message("session-a", 1, "older prompt"));
    const prompt = transcriptMessageItem(message("session-a", 2, "current prompt"));
    const staleProgress = transcriptRangeItem("stale-progress", "stack", 3, 3, "1 event: 1 progress");
    const staleTool = transcriptRangeItem("stale-tool", "stack", 4, 4, "1 event: 1 tool");
    const staleFinal = transcriptMessageItem(message("session-a", 5, "done", "assistant", "assistant"));
    const groupedTail = [
      prompt,
      transcriptRangeItem("grouped-activity", "activity", 3, 4, "2 intermediate events"),
      staleFinal
    ];

    const result = replaceTranscriptTail([older, prompt, staleProgress, staleTool, staleFinal], groupedTail);

    expect(result).toEqual([older, ...groupedTail]);
    expect(result.map((item) => item.id)).not.toContain("stale-progress");
    expect(result.map((item) => item.id)).not.toContain("stale-tool");
  });

  it("keeps older loaded transcript items before the refreshed tail", () => {
    const olderPrompt = transcriptMessageItem(message("session-a", 1, "older prompt"));
    const olderAnswer = transcriptMessageItem(message("session-a", 2, "older answer", "assistant", "assistant"));
    const currentPrompt = transcriptMessageItem(message("session-a", 3, "current prompt"));
    const groupedTail = [currentPrompt, transcriptRangeItem("current-activity", "activity", 4, 8, "5 intermediate events")];

    const result = replaceTranscriptTail([olderPrompt, olderAnswer, currentPrompt], groupedTail);

    expect(result).toEqual([olderPrompt, olderAnswer, ...groupedTail]);
  });

  it("returns the existing transcript when the refreshed tail is empty", () => {
    const current = [transcriptMessageItem(message("session-a", 1, "prompt"))];

    expect(replaceTranscriptTail(current, [])).toBe(current);
  });
});

describe("shouldReconcileSessionForEvent", () => {
  it("refreshes session metadata for session status events", () => {
    expect(shouldReconcileSessionForEvent({ type: "session.updated" })).toBe(true);
    expect(shouldReconcileSessionForEvent({ type: "status.changed" })).toBe(true);
  });

  it("leaves message append events on the direct append path", () => {
    expect(shouldReconcileSessionForEvent({ type: "message.appended" })).toBe(false);
    expect(shouldReconcileSessionForEvent({ type: "connected" })).toBe(false);
  });
});

describe("input mode helpers", () => {
  it("builds explicit mode actions for the selected target", () => {
    expect(inputModeAction("plan")).toEqual({ type: "setInputMode", mode: "plan" });
    expect(inputModeAction("default")).toEqual({ type: "setInputMode", mode: "default" });
  });

  it("builds model setting actions for the selected mode", () => {
    expect(modelAction("plan", "gpt-5.5", "high")).toEqual({
      type: "setModelSettings",
      mode: "plan",
      model: "gpt-5.5",
      reasoningEffort: "high"
    });
    expect(modelAction("default", "gpt-5.4", null)).toEqual({
      type: "setModelSettings",
      mode: "default",
      model: "gpt-5.4",
      reasoningEffort: null
    });
  });

  it("preserves a pending input mode over stale session refreshes", () => {
    const staleSession = managedSession({ inputMode: "default" });

    expect(sessionWithPendingInputMode(staleSession, "plan")).toMatchObject({ id: "session-a", inputMode: "plan" });
    expect(sessionWithPendingInputMode(staleSession, null)).toBe(staleSession);
  });
});

describe("ModeToggle", () => {
  it("keeps accessible labels when rendered with compact icons", () => {
    const html = renderToStaticMarkup(createElement(ModeToggle, { mode: "default", busy: false, onChange: () => undefined }));

    expect(html).toContain('aria-label="Normal"');
    expect(html).toContain('aria-label="Plan"');
    expect(html).toContain("mode-toggle-icon");
    expect(html).toContain('class="mode-toggle-text"');
  });
});

describe("model selector helpers", () => {
  it("keeps the current model visible when the catalog does not include it", () => {
    expect(modelSelectorOptions([], "gpt-local")).toEqual([
      {
        id: "gpt-local",
        model: "gpt-local",
        displayName: "gpt-local",
        description: "",
        hidden: false,
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null
      }
    ]);
  });

  it("formats reasoning effort labels", () => {
    expect(reasoningEffortLabel("xhigh")).toBe("X-high");
    expect(reasoningEffortLabel("medium")).toBe("Medium");
  });
});

describe("queuedInputHasLineBreaks", () => {
  it("distinguishes single-line and multi-line queued input text", () => {
    expect(queuedInputHasLineBreaks("single line")).toBe(false);
    expect(queuedInputHasLineBreaks("first line\nsecond line")).toBe(true);
    expect(queuedInputHasLineBreaks("first line\r\nsecond line")).toBe(true);
  });
});

describe("session scroll behavior", () => {
  it("keeps the session page loading until the matching initial transcript is ready", () => {
    expect(shouldShowSessionLoading(null, "session-a", null)).toBe(true);
    expect(shouldShowSessionLoading({ id: "session-a" }, "session-a", null)).toBe(true);
    expect(shouldShowSessionLoading({ id: "session-a" }, "session-a", "session-b")).toBe(true);
    expect(shouldShowSessionLoading({ id: "session-a" }, "session-b", "session-b")).toBe(true);
    expect(shouldShowSessionLoading({ id: "session-a" }, "session-a", "session-a")).toBe(false);
  });

  it("hides the initial message list until the bottom scroll has been applied", () => {
    expect(shouldHideInitialMessageList(null, "session-a", false)).toBe(false);
    expect(shouldHideInitialMessageList("session-b", "session-a", false)).toBe(false);
    expect(shouldHideInitialMessageList("session-a", "session-a", false)).toBe(true);
    expect(shouldHideInitialMessageList("session-a", "session-a", true)).toBe(false);
  });

  it("detects when the message list is near the bottom", () => {
    expect(isNearMessageListBottom({ scrollHeight: 1000, scrollTop: 780, clientHeight: 120 })).toBe(true);
    expect(isNearMessageListBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 120 })).toBe(false);
  });

  it("only sticks to bottom for live updates when already near bottom", () => {
    expect(scrollBehaviorForTranscriptUpdate("live", true)).toBe("bottom");
    expect(scrollBehaviorForTranscriptUpdate("live", false)).toBe("none");
  });

  it("keeps explicit user bottom actions anchored to the bottom", () => {
    expect(scrollBehaviorForTranscriptUpdate("send", false)).toBe("bottom");
    expect(scrollBehaviorForTranscriptUpdate("explicit_bottom", false)).toBe("bottom");
    expect(scrollBehaviorForTranscriptUpdate("initial", false)).toBe("bottom");
  });

  it("preserves scroll for older pages and does not jump for manual newer loads", () => {
    expect(scrollBehaviorForTranscriptUpdate("older_page", false)).toBe("preserve");
    expect(scrollBehaviorForTranscriptUpdate("manual_newer", true)).toBe("none");
  });

  it("restores the same transcript item to its previous viewport offset", () => {
    const snapshot = { itemId: "item-3", offsetTop: 40, scrollTop: 260, scrollHeight: 900 };

    expect(restoreScrollTopForAnchor(snapshot, { offsetTop: 540 }, 1180)).toBe(500);
  });

  it("falls back to scroll-height delta preservation when the anchor item is unavailable", () => {
    const snapshot = { itemId: "item-3", offsetTop: 40, scrollTop: 260, scrollHeight: 900 };

    expect(restoreScrollTopForAnchor(snapshot, null, 1180)).toBe(540);
  });

  it("scrolls the message list to the newest transcript position", () => {
    const container = { scrollHeight: 1280, scrollTop: 0 };

    scrollMessageListToBottom(container);

    expect(container.scrollTop).toBe(1280);
  });
});

describe("groupStackableMessages", () => {
  it("groups a single system event instead of rendering it inline", () => {
    const items = groupStackableMessages([message("session-a", 1, "task_complete", "system", "status")]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "stack",
      messages: [expect.objectContaining({ text: "task_complete" })]
    });
  });

  it("keeps user messages visible while collapsing adjacent system events after a prompt", () => {
    const items = groupStackableMessages([
      message("session-a", 1, "prompt"),
      message("session-a", 2, "task_complete", "system", "status"),
      message("session-a", 3, "next prompt")
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "activity", "message"]);
    expect(items[1]).toMatchObject({
      messages: [expect.objectContaining({ text: "task_complete" })]
    });
  });

  it("collapses intermediate turn activity before the newest assistant message", () => {
    const items = groupStackableMessages([
      message("session-a", 1, "prompt"),
      message("session-a", 2, "planning", "assistant", "assistant_update"),
      message("session-a", 3, "exec_command(ls)", "tool", "tool_call"),
      message("session-a", 4, "Process exited with code 0", "tool", "command_output"),
      message("session-a", 5, "done", "assistant", "assistant")
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "activity", "message"]);
    expect(items[1]).toMatchObject({
      messages: [
        expect.objectContaining({ text: "planning" }),
        expect.objectContaining({ text: "exec_command(ls)" }),
        expect.objectContaining({ text: "Process exited with code 0" })
      ]
    });
    expect(items[2]).toMatchObject({ message: expect.objectContaining({ text: "done" }) });
  });

  it("prefers assistant response items over duplicate progress updates", () => {
    const items = groupStackableMessages([
      message("session-a", 1, "prompt"),
      message("session-a", 2, "checking files", "assistant", "assistant_update"),
      message("session-a", 3, "checking files", "assistant", "assistant"),
      message("session-a", 4, "tool_result", "tool", "tool_output"),
      message("session-a", 5, "writing plan", "assistant", "assistant_update"),
      message("session-a", 6, "writing plan", "assistant", "assistant"),
      message("session-a", 7, proposedPlanText("Do it."), "assistant", "assistant")
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "activity", "message"]);
    expect(items[1]).toMatchObject({
      messages: [
        expect.objectContaining({ text: "checking files", type: "assistant" }),
        expect.objectContaining({ text: "tool_result" }),
        expect.objectContaining({ text: "writing plan", type: "assistant" })
      ]
    });
    expect(items[1]).not.toMatchObject({
      messages: expect.arrayContaining([expect.objectContaining({ text: "checking files", type: "assistant_update" })])
    });
    expect(items[2]).toMatchObject({ message: expect.objectContaining({ text: proposedPlanText("Do it.") }) });
    if (items[2]?.type !== "message") throw new Error("Expected visible assistant message");
    const html = renderToStaticMarkup(createElement(MessageBubble, { message: items[2].message }));
    expect(html).not.toContain("Progress");
  });

  it("keeps only the newest assistant message visible when a turn has multiple assistant messages", () => {
    const items = groupStackableMessages([
      message("session-a", 1, "prompt"),
      message("session-a", 2, "first answer", "assistant", "assistant"),
      message("session-a", 3, "tool_result", "tool", "tool_output"),
      message("session-a", 4, "second answer", "assistant", "assistant")
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "activity", "message"]);
    expect(items[1]).toMatchObject({
      messages: [
        expect.objectContaining({ text: "first answer" }),
        expect.objectContaining({ text: "tool_result" })
      ]
    });
    expect(items[2]).toMatchObject({ message: expect.objectContaining({ text: "second answer" }) });
  });

  it("uses the newest assistant response when duplicate progress responses are present", () => {
    const items = groupStackableMessages([
      message("session-a", 1, "prompt"),
      message("session-a", 2, "checking files", "assistant", "assistant_update"),
      message("session-a", 3, "checking files", "assistant", "assistant"),
      message("session-a", 4, "tool_result", "tool", "tool_output"),
      message("session-a", 5, "editing tests", "assistant", "assistant_update"),
      message("session-a", 6, "editing tests", "assistant", "assistant")
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "activity", "message"]);
    expect(items[1]).toMatchObject({
      messages: [
        expect.objectContaining({ text: "checking files", type: "assistant" }),
        expect.objectContaining({ text: "tool_result" })
      ]
    });
    expect(items[2]).toMatchObject({ message: expect.objectContaining({ text: "editing tests", type: "assistant" }) });
  });

  it("uses the newest progress update as the visible item for live turns without an assistant response", () => {
    const items = groupStackableMessages([
      message("session-a", 1, "prompt"),
      message("session-a", 2, "checking files", "assistant", "assistant_update"),
      message("session-a", 3, "tool_result", "tool", "tool_output"),
      message("session-a", 4, "editing tests", "assistant", "assistant_update")
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "activity", "message"]);
    expect(items[1]).toMatchObject({
      messages: [
        expect.objectContaining({ text: "checking files" }),
        expect.objectContaining({ text: "tool_result" })
      ]
    });
    expect(items[2]).toMatchObject({ message: expect.objectContaining({ text: "editing tests" }) });
  });

  it("collapses all turn activity when no assistant or progress message exists", () => {
    const items = groupStackableMessages([
      message("session-a", 1, "prompt"),
      message("session-a", 2, "exec_command(ls)", "tool", "tool_call"),
      message("session-a", 3, "Process exited with code 0", "tool", "command_output")
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "activity"]);
    expect(items[1]).toMatchObject({
      messages: [
        expect.objectContaining({ text: "exec_command(ls)" }),
        expect.objectContaining({ text: "Process exited with code 0" })
      ]
    });
  });

  it("keeps question requests outside collapsed turn activity", () => {
    const items = groupStackableMessages([
      message("session-a", 1, "prompt"),
      message("session-a", 2, "exec_command(ls)", "tool", "tool_call"),
      message("session-a", 3, "Question requested", "system", "question_request"),
      message("session-a", 4, "Process exited with code 0", "tool", "command_output")
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "activity", "message", "activity"]);
    expect(items[1]).toMatchObject({
      messages: [expect.objectContaining({ text: "exec_command(ls)" })]
    });
    expect(items[2]).toMatchObject({
      message: expect.objectContaining({ text: "Question requested", type: "question_request" })
    });
    expect(items[3]).toMatchObject({
      messages: [expect.objectContaining({ text: "Process exited with code 0" })]
    });
  });

  it("keeps assistant messages expanded and tool events stacked inside collapsed activity", () => {
    const items = groupEventStacks([
      message("session-a", 1, "first answer", "assistant", "assistant"),
      message("session-a", 2, "tool_result", "tool", "tool_output"),
      message("session-a", 3, "task_complete", "system", "status")
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "stack"]);
    expect(items[0]).toMatchObject({ message: expect.objectContaining({ text: "first answer" }) });
    expect(items[1]).toMatchObject({
      messages: [
        expect.objectContaining({ text: "tool_result" }),
        expect.objectContaining({ text: "task_complete" })
      ]
    });
  });

  it("compacts inline skill context before rendering user messages", () => {
    const items = groupStackableMessages([
      message(
        "session-a",
        1,
        [
          "open a $pr-to-stage",
          "",
          "<skill>",
          "<name>pr-to-stage</name>",
          "<path>/home/dev/.codex/skills/pr-to-stage/SKILL.md</path>",
          "# Pr To Stage",
          "</skill>"
        ].join("\n")
      )
    ]);

    expect(items).toEqual([
      {
        type: "message",
        message: expect.objectContaining({ text: "open a $pr-to-stage\n\nSkills: pr-to-stage" })
      }
    ]);
  });

  it("merges persisted skill-only user messages into the previous user message", () => {
    const items = groupStackableMessages([
      message("session-a", 1, "open a $pr-to-stage"),
      message(
        "session-a",
        2,
        [
          "<skill>",
          "<name>pr-to-stage</name>",
          "<path>/home/dev/.codex/skills/pr-to-stage/SKILL.md</path>",
          "# Pr To Stage",
          "</skill>"
        ].join("\n")
      )
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "message",
      message: expect.objectContaining({ text: "open a $pr-to-stage\n\nSkills: pr-to-stage" })
    });
  });

  it("omits persisted environment context user messages", () => {
    const items = groupStackableMessages([
      message("session-a", 1, "actual prompt"),
      message(
        "session-a",
        2,
        [
          "<environment_context>",
          "  <cwd>/home/dev/workspace/muxpilot</cwd>",
          "  <shell>bash</shell>",
          "</environment_context>"
        ].join("\n")
      )
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "message",
      message: expect.objectContaining({ text: "actual prompt" })
    });
  });

  it("converts persisted subagent notifications into collapsed subagent activity", () => {
    const items = groupStackableMessages([
      message("session-a", 1, "Review the change"),
      message(
        "session-a",
        2,
        [
          "<subagent_notification>",
          JSON.stringify({
            agent_path: "019f3ef2-2b43-77a1-a379-f9ddc8b270b3",
            status: { completed: "No blocking findings in the staged diff." }
          }),
          "</subagent_notification>"
        ].join("\n")
      )
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "activity"]);
    expect(items[1]).toMatchObject({
      messages: [
        expect.objectContaining({
          role: "system",
          type: "status",
          text: "Subagent completed: 019f3ef2-2b43-77a1-a379-f9ddc8b270b3\n\nNo blocking findings in the staged diff."
        })
      ]
    });
  });

  it("converts persisted AGENTS.md instruction context into a user-side action", () => {
    const items = groupStackableMessages([
      message(
        "session-a",
        1,
        [
          "# AGENTS.md instructions for /home/dev/workspace/teamweave",
          "",
          "<INSTRUCTIONS>",
          "# Repository Guidelines",
          "",
          "## Directory-Local Rules",
          "Before changing files in a directory, read that directory's AGENTS.md.",
          "</INSTRUCTIONS>"
        ].join("\n")
      )
    ]);

    expect(items).toEqual([
      {
        type: "user_action",
        message: expect.objectContaining({
          role: "system",
          type: "status",
          text: "Loaded AGENTS.md instructions for /home/dev/workspace/teamweave"
        })
      }
    ]);
  });

  it("converts persisted instruction plus environment context into a user-side action", () => {
    const items = groupStackableMessages([
      message(
        "session-a",
        1,
        [
          "# AGENTS.md instructions for /home/dev/workspace/teamweave",
          "",
          "<INSTRUCTIONS>",
          "# Repository Guidelines",
          "",
          "## Directory-Local Rules",
          "Before changing files in a directory, read that directory's AGENTS.md.",
          "</INSTRUCTIONS>",
          "",
          "<environment_context>",
          "  <cwd>/home/dev/workspace/teamweave</cwd>",
          "  <shell>bash</shell>",
          "</environment_context>"
        ].join("\n")
      ),
      message("session-a", 2, "Review the code changes")
    ]);

    expect(items).toEqual([
      {
        type: "user_action",
        message: expect.objectContaining({
          role: "system",
          type: "status",
          text: "Loaded AGENTS.md instructions for /home/dev/workspace/teamweave"
        })
      },
      {
        type: "message",
        message: expect.objectContaining({ text: "Review the code changes" })
      }
    ]);
  });

  it("converts persisted turn-aborted user context into a user-side action", () => {
    const items = groupStackableMessages([
      message(
        "session-a",
        1,
        [
          "<turn_aborted>",
          "The user interrupted the previous turn on purpose.",
          "</turn_aborted>"
        ].join("\n")
      )
    ]);

    expect(items).toEqual([
      {
        type: "user_action",
        message: expect.objectContaining({
          role: "system",
          type: "status",
          text: "Turn aborted"
        })
      }
    ]);
  });
});

describe("UserText", () => {
  it("styles only dollar references that match actual skill metadata", () => {
    const html = renderToStaticMarkup(
      createElement(UserText, {
        text: "use $teamweave-browser and leave $not-a-skill alone\n\nSkills: teamweave-browser"
      })
    );

    expect(html).toContain('class="user-skill-reference"');
    expect(html).toContain("$teamweave-browser");
    expect(html).toContain("$not-a-skill");
    expect(html).not.toContain("Skills:");
    expect(html.match(/user-skill-reference/g)).toHaveLength(1);
  });

  it("styles plugin skill references that use Codex plugin prefixes", () => {
    const html = renderToStaticMarkup(createElement(UserText, { text: "publish with $github:yeet\n\nSkills: github:yeet" }));

    expect(html).toContain('class="user-skill-reference"');
    expect(html).toContain("$github:yeet");
  });

  it("leaves dollar references plain without skill metadata", () => {
    const html = renderToStaticMarkup(createElement(UserText, { text: "use $teamweave-browser" }));

    expect(html).toContain("$teamweave-browser");
    expect(html).not.toContain('class="user-skill-reference"');
  });
});

describe("MessageBubble", () => {
  it("marks pending user messages as in flight", () => {
    const pending = pendingUserMessageToChatMessage(createPendingUserMessage("session-a", "Ship this", "default", "2026-07-07T00:00:00.000Z"));
    const html = renderToStaticMarkup(createElement(MessageBubble, { message: pending, pending: true }));

    expect(html).toContain("message-pending");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Ship this");
  });

  it("renders a Plan badge for messages parsed from plan mode", () => {
    const planMessage = message("session-a", 1, "plan prompt", "user", "user", { collaborationMode: "plan" });
    const html = renderToStaticMarkup(createElement(MessageBubble, { message: planMessage }));

    expect(isPlanModeMessage(planMessage)).toBe(true);
    expect(html).toContain("message-mode-badge");
    expect(html).toContain("Plan");
  });

  it("omits the Plan badge for normal-mode messages", () => {
    const normalMessage = message("session-a", 1, "normal prompt", "user", "user", { collaborationMode: "default" });
    const html = renderToStaticMarkup(createElement(MessageBubble, { message: normalMessage }));

    expect(isPlanModeMessage(normalMessage)).toBe(false);
    expect(html).not.toContain("message-mode-badge");
  });
});

describe("pending user messages", () => {
  it("creates render-only user messages with collaboration mode metadata", () => {
    const pending = createPendingUserMessage("session-a", "Plan this", "plan", "2026-07-07T00:00:00.000Z");

    expect(pendingUserMessageToChatMessage(pending)).toMatchObject({
      id: "pending-user-2026-07-07T00:00:00.000Z",
      sessionId: "session-a",
      role: "user",
      type: "user",
      sequence: Number.MAX_SAFE_INTEGER,
      text: "Plan this",
      payload: { collaborationMode: "plan" }
    });
  });

  it("reconciles when refreshed transcript items include the sent text", () => {
    const pending = createPendingUserMessage("session-a", "Review the change", "default", "2026-07-07T00:00:00.000Z");

    expect(transcriptItemsContainPendingUserMessage([transcriptMessageItem(message("session-a", 3, "Review the change"))], pending)).toBe(
      true
    );
    expect(transcriptItemsContainPendingUserMessage([transcriptMessageItem(message("session-b", 3, "Review the change"))], pending)).toBe(
      false
    );
    expect(transcriptItemsContainPendingUserMessage([transcriptMessageItem(message("session-a", 3, "Different text"))], pending)).toBe(false);
  });

  it("reconciles skill prompts that gain display metadata after parsing", () => {
    const pending = createPendingUserMessage("session-a", "use $pr-to-stage", "default", "2026-07-07T00:00:00.000Z");
    const parsed = message("session-a", 3, "use $pr-to-stage\n\nSkills: pr-to-stage");

    expect(transcriptItemsContainPendingUserMessage([transcriptMessageItem(parsed)], pending)).toBe(true);
  });

  it("reconciles Codex paste placeholders for newer user turns", () => {
    const pending = createPendingUserMessage("session-a", "a".repeat(5108), "default", "2026-07-07T00:00:00.000Z");

    expect(isCodexPastedContentPlaceholder("[Pasted Content 4086 chars][Pasted Content 1022 chars]")).toBe(true);
    expect(
      transcriptItemsContainPendingUserMessage(
        [transcriptMessageItem(message("session-a", 3, "[Pasted Content 4086 chars][Pasted Content 1022 chars]"))],
        pending
      )
    ).toBe(true);
    expect(
      transcriptItemsContainPendingUserMessage(
        [
          transcriptMessageItem(
            message("session-a", 2, "[Pasted Content 4086 chars]", "user", "user", {}, "2026-07-06T23:59:59.000Z")
          )
        ],
        pending
      )
    ).toBe(false);
  });
});

describe("WorkingIndicator", () => {
  it("renders an assistant-side working status with a spinner", () => {
    const html = renderToStaticMarkup(createElement(WorkingIndicator));

    expect(html).toContain('role="status"');
    expect(html).toContain("Codex is working");
    expect(html).toContain("spin");
    expect(html).toContain("message-assistant");
  });

  it("renders elapsed time since the last user prompt", () => {
    const html = renderToStaticMarkup(
      createElement(WorkingIndicator, {
        lastUserPromptAt: "2026-07-07T12:00:00.000Z",
        nowMs: Date.parse("2026-07-07T12:01:05.000Z")
      })
    );

    expect(html).toContain("Codex is working");
    expect(html).toContain("1m 05s");
    expect(html).toContain("working-indicator-elapsed");
  });

  it("renders planning status with planning copy", () => {
    const html = renderToStaticMarkup(createElement(WorkingIndicator, { status: "planning" }));

    expect(html).toContain("Codex is planning...");
    expect(html).not.toContain("Codex is working");
  });

  it("only shows for live working sessions at the newest transcript position", () => {
    expect(shouldShowWorkingIndicator("working", false)).toBe(true);
    expect(shouldShowWorkingIndicator("generating", false)).toBe(true);
    expect(shouldShowWorkingIndicator("executing", false)).toBe(true);
    expect(shouldShowWorkingIndicator("planning", false)).toBe(true);
    expect(shouldShowWorkingIndicator("working", true)).toBe(false);
    expect(shouldShowWorkingIndicator("idle", false)).toBe(false);
    expect(shouldShowWorkingIndicator(undefined, false)).toBe(false);
  });

  it("finds the latest user prompt timestamp", () => {
    expect(
      latestUserPromptTimestamp([
        message("session-a", 1, "first", "user", "user", {}, "2026-07-07T12:00:00.000Z"),
        message("session-a", 2, "thinking", "assistant", "assistant_update", {}, "2026-07-07T12:00:05.000Z"),
        message("session-a", 3, "second", "user", "user", {}, "2026-07-07T12:02:00.000Z")
      ])
    ).toBe("2026-07-07T12:02:00.000Z");
  });

  it("formats elapsed time compactly", () => {
    expect(elapsedSince("2026-07-07T12:00:00.000Z", Date.parse("2026-07-07T12:00:07.000Z"))).toBe(7);
    expect(formatElapsedSeconds(7)).toBe("7s");
    expect(formatElapsedSeconds(65)).toBe("1m 05s");
    expect(formatElapsedSeconds(3665)).toBe("1h 01m");
  });
});

describe("MessageBubble action placement", () => {
  it("renders proposed plan actions inside the proposed plan block", () => {
    const plan = message("session-a", 1, proposedPlanText("Do it."), "assistant", "assistant");
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        message: plan,
        planAction: createElement("button", { type: "button" }, "Implement")
      })
    );

    expect(html).toContain("proposed-plan");
    expect(html).toContain("Implement");
    expect(html.indexOf("proposed-plan-body")).toBeLessThan(html.indexOf("Implement"));
  });

  it("attaches proposed plan actions only to the final plan block", () => {
    const plan = message(
      "session-a",
      1,
      `${proposedPlanText("First")}\n\n${proposedPlanText("Second")}`,
      "assistant",
      "assistant"
    );
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        message: plan,
        planAction: createElement("button", { type: "button" }, "Implement")
      })
    );

    expect(html.match(/Implement/g)?.length).toBe(1);
    expect(html.lastIndexOf("proposed-plan-body")).toBeLessThan(html.indexOf("Implement"));
  });

  it("renders question actions at the bottom of the source message", () => {
    const questionMessage = message("session-a", 1, "Question requested", "system", "question_request");
    const html = renderToStaticMarkup(
      createElement(MessageBubble, {
        message: questionMessage,
        questionAction: createElement("button", { type: "button" }, "Send answer")
      })
    );

    expect(html).toContain("Question requested");
    expect(html).toContain("Send answer");
    expect(html.indexOf("Question requested")).toBeLessThan(html.indexOf("Send answer"));
  });
});

describe("parseProposedPlanSegments", () => {
  it("extracts a single proposed plan block", () => {
    const result = parseProposedPlanSegments("<proposed_plan>\n# Plan\n\nDo it.\n</proposed_plan>");

    expect(result).toEqual([{ type: "plan", text: "# Plan\n\nDo it." }]);
  });

  it("preserves text before and after a proposed plan block", () => {
    const result = parseProposedPlanSegments("Before\n\n<proposed_plan>\nPlan body\n</proposed_plan>\n\nAfter");

    expect(result).toEqual([
      { type: "markdown", text: "Before\n\n" },
      { type: "plan", text: "Plan body" },
      { type: "markdown", text: "\n\nAfter" }
    ]);
  });

  it("supports multiple proposed plan blocks", () => {
    const result = parseProposedPlanSegments(
      "<proposed_plan>\nFirst\n</proposed_plan>\nBetween\n<proposed_plan>\nSecond\n</proposed_plan>"
    );

    expect(result).toEqual([
      { type: "plan", text: "First" },
      { type: "markdown", text: "\nBetween\n" },
      { type: "plan", text: "Second" }
    ]);
  });

  it("treats unclosed proposed plan tags as normal markdown", () => {
    const text = "Before\n<proposed_plan>\nNo close";

    expect(parseProposedPlanSegments(text)).toEqual([{ type: "markdown", text }]);
  });

  it("trims wrapper whitespace without changing inner indentation", () => {
    const result = parseProposedPlanSegments("<proposed_plan>\n  - keep indentation\n</proposed_plan>");

    expect(result).toEqual([{ type: "plan", text: "  - keep indentation" }]);
  });
});

describe("pendingProposedPlanMessage", () => {
  it("returns the latest assistant message with a complete proposed plan", () => {
    const plan = message("session-a", 2, proposedPlanText("Do it."), "assistant", "assistant");

    expect(pendingProposedPlanMessage([message("session-a", 1, "prompt"), plan], null)).toBe(plan);
  });

  it("does not return a plan after a later visible user message", () => {
    const plan = message("session-a", 2, proposedPlanText("Do it."), "assistant", "assistant");

    expect(pendingProposedPlanMessage([message("session-a", 1, "prompt"), plan, message("session-a", 3, "thanks")], null)).toBeNull();
  });

  it("ignores incomplete proposed plan tags", () => {
    const plan = message("session-a", 2, "Before\n<proposed_plan>\nNo close", "assistant", "assistant");

    expect(pendingProposedPlanMessage([message("session-a", 1, "prompt"), plan], null)).toBeNull();
  });

  it("suppresses an answered plan until a newer plan appears", () => {
    const oldPlan = message("session-a", 2, proposedPlanText("First"), "assistant", "assistant");
    const newPlan = message("session-a", 3, proposedPlanText("Second"), "assistant", "assistant");

    expect(pendingProposedPlanMessage([message("session-a", 1, "prompt"), oldPlan], oldPlan.id)).toBeNull();
    expect(pendingProposedPlanMessage([message("session-a", 1, "prompt"), oldPlan, newPlan], oldPlan.id)).toBe(newPlan);
  });
});

describe("planActionText", () => {
  it("uses the exact Codex plan action prompts", () => {
    expect(planActionText("implement")).toBe("Yes, implement the plan");
    expect(planActionText("clear_context_implement")).toBe("Yes, clear context and implement");
    expect(planActionText("stay_in_plan")).toBe("No, stay in plan mode");
  });

  it("builds typed plan action requests instead of composer text", () => {
    expect(planActionRequest("stay_in_plan")).toEqual({
      type: "choosePlanAction",
      action: "stay_in_plan"
    });
  });
});

describe("stripAssistantSideChannelBlocks", () => {
  it("removes memory citation blocks from assistant text", () => {
    const text = [
      "Created the stage PR:",
      "",
      "https://github.com/TeamWeave-App/teamweave/pull/669",
      "",
      "<oai-mem-citation> <citation_entries> MEMORY.md:160-182|note=[TeamWeave PR workflow and PR body rules] </citation_entries> <rollout_ids> 019f28f4-47d2-7610-9dba-3606573c2a2b </rollout_ids> </oai-mem-citation>"
    ].join("\n");

    expect(stripAssistantSideChannelBlocks(text)).toBe(
      "Created the stage PR:\n\nhttps://github.com/TeamWeave-App/teamweave/pull/669"
    );
  });

  it("preserves assistant text around side-channel blocks", () => {
    expect(stripAssistantSideChannelBlocks("Before\n<oai-mem-citation>\ninternal\n</oai-mem-citation>\nAfter")).toBe(
      "Before\nAfter"
    );
  });
});

describe("MarkdownBlock", () => {
  it("opens rendered links in a new tab", () => {
    const html = renderToStaticMarkup(createElement(MarkdownBlock, { text: "[docs](https://example.com)" }));

    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe("question helpers", () => {
  it("calculates whole remaining seconds for pending question countdowns", () => {
    expect(secondsUntil("2026-07-07T00:01:00.000Z", Date.parse("2026-07-07T00:00:00.001Z"))).toBe(60);
    expect(secondsUntil("2026-07-07T00:01:00.000Z", Date.parse("2026-07-07T00:00:59.250Z"))).toBe(1);
    expect(secondsUntil("2026-07-07T00:01:00.000Z", Date.parse("2026-07-07T00:01:02.000Z"))).toBe(0);
    expect(secondsUntil(null, Date.parse("2026-07-07T00:00:00.000Z"))).toBeNull();
  });

  it("uses the server-observed countdown deadline for question countdowns", () => {
    const question = questionRequest({
      expiresAt: "2026-07-07T00:01:00.000Z",
      countdownExpiresAt: "2026-07-07T00:02:00.000Z"
    });

    expect(questionRemainingSeconds(question, Date.parse("2026-07-07T00:01:30.000Z"))).toBe(30);
  });

  it("builds compact question answer payloads", () => {
    const question = questionRequest();

    expect(
      buildQuestionAnswerRequest(question, {
        loading_treatment: { selectedOption: null, other: " Input only (Recommended) " }
      })
    ).toEqual({
      answers: {
        loading_treatment: { answers: ["Input only (Recommended)"] }
      }
    });
  });

  it("builds option and other answers together", () => {
    const question = questionRequest({
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "How far should this go?",
          options: [
            { label: "Small", description: "" },
            { label: "Complete", description: "" }
          ]
        }
      ]
    });

    expect(buildQuestionAnswerRequest(question, { scope: { selectedOption: "Complete", other: " include tests " } })).toEqual(
      {
        answers: {
          scope: { answers: ["Complete", "include tests"] }
        }
      }
    );
  });

  it("builds none of the above with other text when no option is selected", () => {
    const question = questionRequest({
      questions: [
        {
          id: "scope",
          header: "Scope",
          question: "How far should this go?",
          options: [{ label: "Small", description: "" }]
        }
      ]
    });

    expect(buildQuestionAnswerRequest(question, { scope: { selectedOption: null, other: " custom scope " } })).toEqual(
      {
        answers: {
          scope: { answers: ["None of the above", "custom scope"] }
        }
      }
    );
  });
});

function questionRequest(overrides: Partial<QuestionRequest> = {}): QuestionRequest {
  return {
    id: "call-question",
    sessionId: "session-a",
    messageId: "message-a",
    autoResolutionMs: 60000,
    createdAt: "2026-07-07T00:00:00.000Z",
    expiresAt: "2026-07-07T00:01:00.000Z",
    countdownStartedAt: "2026-07-07T00:01:00.000Z",
    countdownExpiresAt: "2026-07-07T00:02:00.000Z",
    questions: [
      {
        id: "loading_treatment",
        header: "Loading UI",
        question: "When sending, which area should get the reduced opacity treatment?",
        options: []
      }
    ],
    ...overrides
  };
}

function message(
  sessionId: string,
  sequence: number,
  text: string,
  role: ChatMessage["role"] = "user",
  type: ChatMessage["type"] = "user",
  payload: Record<string, unknown> = {},
  timestamp = `2026-07-07T00:00:0${sequence}.000Z`
): ChatMessage {
  return {
    id: `${sessionId}-${sequence}`,
    sessionId,
    sequence,
    type,
    role,
    timestamp,
    text,
    payload
  };
}

function managedSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "session-a",
    tmux: {
      sessionId: "tmux-session",
      sessionName: "work",
      windowId: "@1",
      windowIndex: 1,
      windowName: "codex",
      paneId: "%1",
      paneIndex: 0,
      paneActive: true,
      cwd: "/workspace/muxpilot",
      currentCommand: "node",
      title: "codex",
      pid: 123,
      size: "120x40"
    },
    repo: repo("muxpilot", "main"),
    codexSessionId: "codex-session",
    codexJsonlPath: "/tmp/codex-session.jsonl",
    discoveryConfidence: "high",
    status: "waiting",
    lastActivityAt: null,
    preview: "",
    recentUserPrompts: [],
    activitySummary: null,
    activitySummaryGeneratedAt: null,
    activitySummarySourceSequence: null,
    inputMode: "default",
    models: { default: { model: null, reasoningEffort: null }, plan: { model: null, reasoningEffort: null } },
    transcriptSize: 0,
    unreadCount: 0,
    archived: false,
    ...overrides
  };
}

function proposedPlanText(body: string): string {
  return `<proposed_plan>\n${body}\n</proposed_plan>`;
}

function transcriptMessageItem(message: ChatMessage): TranscriptItem {
  return {
    type: "message",
    id: message.id,
    message,
    firstSequence: message.sequence,
    lastSequence: message.sequence
  };
}

function transcriptRangeItem(
  id: string,
  rangeKind: "activity" | "stack",
  firstSequence: number,
  lastSequence: number,
  label: string
): TranscriptItem {
  return {
    type: "range",
    id,
    rangeKind,
    label,
    firstSequence,
    lastSequence,
    messageCount: lastSequence - firstSequence + 1
  };
}

function repo(name: string, branch: string | null): RepoMetadata {
  return {
    root: `/workspace/${name}`,
    name,
    branch,
    dirty: false,
    worktree: null
  };
}
