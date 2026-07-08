import { describe, expect, it } from "vitest";
import { buildTranscriptItems } from "./transcript.js";
import type { ChatMessage } from "./types.js";

describe("buildTranscriptItems", () => {
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

function message(sequence: number, text: string): ChatMessage {
  return {
    id: `message-${sequence}`,
    sessionId: "session-a",
    sequence,
    type: "user",
    role: "user",
    timestamp: `2026-07-07T00:00:0${sequence}.000Z`,
    text,
    payload: {}
  };
}
