import { Circle, CircleCheck, CircleDot } from "lucide-react";
import type { ReactNode } from "react";
import type { TranscriptTaskList, TranscriptTaskStatus } from "@muxpilot/core";

const TASK_STATUSES: readonly TranscriptTaskStatus[] = ["pending", "in_progress", "completed"];

/** Model reasoning stays collapsed so it never competes with the answer it led to. */
export function ReasoningBlock({ text, children }: { text: string; children?: ReactNode }) {
  const lines = text.trim() ? text.trim().split("\n").length : 0;
  return (
    <details className="reasoning-block">
      <summary>
        <span className="reasoning-block-title">Thinking</span>
        <span className="reasoning-block-meta">{lines ? `${lines} ${lines === 1 ? "line" : "lines"}` : "No text recorded"}</span>
      </summary>
      {lines ? <div className="reasoning-block-body">{children ?? <p className="reasoning-block-text">{text.trim()}</p>}</div> : null}
    </details>
  );
}

/** The validated task list carried on a tool call (`payload.taskList`), or null when absent or malformed. */
export function transcriptTaskList(payload: unknown): TranscriptTaskList | null {
  const candidate = payload && typeof payload === "object" ? (payload as Record<string, unknown>).taskList : null;
  const items = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>).items : null;
  if (!Array.isArray(items)) return null;
  const valid = items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { text, status } = item as Record<string, unknown>;
    if (typeof text !== "string" || !TASK_STATUSES.includes(status as TranscriptTaskStatus)) return [];
    return [{ text, status: status as TranscriptTaskStatus }];
  });
  return { items: valid };
}

export function TaskListBlock({ taskList }: { taskList: TranscriptTaskList }) {
  const completed = taskList.items.filter((item) => item.status === "completed").length;
  return (
    <div className="task-list-block" role="group" aria-label="Task list">
      <div className="task-list-block-head">
        <strong>Tasks</strong>
        <span>{completed}/{taskList.items.length} completed</span>
      </div>
      {taskList.items.length ? (
        <ul>
          {taskList.items.map((item, index) => (
            <li key={`${index}-${item.text}`} data-status={item.status}>
              <TaskStatusIcon status={item.status} />
              <span className="task-list-block-text">{item.text}</span>
              <span className="sr-only">{taskStatusLabel(item.status)}</span>
            </li>
          ))}
        </ul>
      ) : <p className="task-list-block-empty">The task list is empty.</p>}
    </div>
  );
}

function TaskStatusIcon({ status }: { status: TranscriptTaskStatus }) {
  if (status === "completed") return <CircleCheck className="task-list-block-icon" size={15} aria-hidden="true" />;
  if (status === "in_progress") return <CircleDot className="task-list-block-icon" size={15} aria-hidden="true" />;
  return <Circle className="task-list-block-icon" size={15} aria-hidden="true" />;
}

function taskStatusLabel(status: TranscriptTaskStatus): string {
  if (status === "completed") return "(completed)";
  if (status === "in_progress") return "(in progress)";
  return "(pending)";
}
