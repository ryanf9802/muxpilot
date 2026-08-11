import { describe, expect, it } from "vitest";
import { buildExpandedTranscriptItems, buildTranscriptItems } from "./transcript.js";
import type { ChatMessage } from "./types.js";

describe("buildTranscriptItems", () => {
  it("keeps every assistant message visible while collapsing intervening activity", () => {
    const items = buildTranscriptItems([
      message(1, "first answer", "assistant", "assistant"),
      message(2, "tool_result", "tool", "tool_output"),
      message(3, "second answer", "assistant", "assistant"),
      message(4, "next prompt")
    ]);

    expect(items).toEqual([
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ text: "first answer" })
      }),
      expect.objectContaining({
        type: "range",
        rangeKind: "activity",
        firstSequence: 2,
        lastSequence: 2
      }),
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ text: "second answer" })
      }),
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ text: "next prompt" })
      })
    ]);
  });

  it("keeps live assistant progress visible without a final response", () => {
    const items = buildTranscriptItems([
      message(1, "prompt"),
      message(2, "checking files", "assistant", "assistant_update"),
      message(3, "tool_result", "tool", "tool_output"),
      message(4, "reviewing results", "assistant", "assistant_update")
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "message", "range", "message"]);
    expect(items[1]).toMatchObject({ message: { text: "checking files" } });
    expect(items[2]).toMatchObject({ rangeKind: "activity", firstSequence: 3, lastSequence: 3 });
    expect(items[3]).toMatchObject({ message: { text: "reviewing results" } });
  });

  it("coalesces duplicate update and response records for the same assistant output", () => {
    const items = buildTranscriptItems([
      message(1, "prompt"),
      message(2, "checking files", "assistant", "assistant_update"),
      message(3, "checking files", "assistant", "assistant")
    ]);

    expect(items).toEqual([
      expect.objectContaining({ type: "message", message: expect.objectContaining({ text: "prompt" }) }),
      expect.objectContaining({ type: "message", message: expect.objectContaining({ type: "assistant" }) })
    ]);
  });

  it("never puts assistant updates inside expanded event stacks", () => {
    const items = buildExpandedTranscriptItems([
      message(1, "tool_result", "tool", "tool_output"),
      message(2, "still working", "assistant", "assistant_update"),
      message(3, "task_complete", "system", "status")
    ]);

    expect(items.map((item) => item.type)).toEqual(["message", "message", "message"]);
    expect(items[1]).toMatchObject({ message: { text: "still working", role: "assistant" } });
  });

  it("collapses persisted subagent notifications as subagent activity", () => {
    const items = buildTranscriptItems([
      message(1, "Review the change"),
      message(
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

    expect(items.map((item) => item.type)).toEqual(["message", "range"]);
    expect(items[1]).toMatchObject({
      rangeKind: "activity",
      label: "1 intermediate event"
    });
  });

  it("labels standalone subagent notification stacks separately from generic system events", () => {
    const items = buildTranscriptItems([
      message(
        1,
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

    expect(items).toEqual([
      expect.objectContaining({
        type: "range",
        rangeKind: "stack",
        label: "1 event: 1 subagent"
      })
    ]);
  });
});

function message(
  sequence: number,
  text: string,
  role: ChatMessage["role"] = "user",
  type: ChatMessage["type"] = "user"
): ChatMessage {
  return {
    id: `message-${sequence}`,
    sessionId: "session-a",
    sequence,
    type,
    role,
    timestamp: `2026-07-07T00:00:0${sequence}.000Z`,
    text,
    payload: {}
  };
}
