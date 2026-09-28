import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { HostApprovalCategory, HostApprovalResponse } from "./protocol.js";

/** Tools that never need operator approval: reads, planning aids, and in-session delegation. */
const ALWAYS_ALLOWED_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "Agent",
  "Skill",
  "ToolSearch",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskStop",
  "TaskOutput",
  "Monitor",
  "BashOutput",
  "KillShell",
  // Native Claude Code features muxpilot passes through rather than re-implementing.
  "EnterPlanMode",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "SendMessage",
  "ListAgents",
  "Workflow"
]);

const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Claude Code features that conflict with muxpilot's session model: muxpilot's git workflow owns worktrees (and
 * moving the cwd would move the transcript), and cloud triggers or phone pushes bypass muxpilot's own routing.
 * They are removed from the model's tool list at launch.
 */
export const DISALLOWED_TOOLS = [
  "RemoteTrigger",
  "PushNotification",
  "EnterWorktree",
  "ExitWorktree"
] as const;

export const MUXPILOT_MCP_TOOL_PREFIX = "mcp__muxpilot_sessions__";

export interface PermissionContext {
  cwd: string;
  writableRoots: readonly string[];
}

export interface PermissionOptions {
  suggestions?: unknown[];
  blockedPath?: string;
  decisionReason?: string;
  title?: string;
  description?: string;
}

export type PermissionDecision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "question" }
  | { kind: "plan" }
  | {
      kind: "ask";
      category: HostApprovalCategory;
      title: string;
      command: string | null;
      reason: string | null;
      prefixRule: string[] | null;
    };

/** Classifies one Claude tool permission request under muxpilot's session policy. */
export function decidePermission(
  toolName: string,
  input: Record<string, unknown>,
  options: PermissionOptions,
  context: PermissionContext
): PermissionDecision {
  if (toolName === "AskUserQuestion") return { kind: "question" };
  if (toolName === "ExitPlanMode") return { kind: "plan" };
  if ((DISALLOWED_TOOLS as readonly string[]).includes(toolName)) {
    return { kind: "deny", message: `${toolName} is not available in muxpilot sessions.` };
  }
  if (ALWAYS_ALLOWED_TOOLS.has(toolName) || toolName.startsWith(MUXPILOT_MCP_TOOL_PREFIX)) return { kind: "allow" };

  if (FILE_WRITE_TOOLS.has(toolName)) {
    const path = stringValue(input.file_path) ?? stringValue(input.notebook_path);
    if (path && isWithinWritableRoots(path, context)) return { kind: "allow" };
    return {
      kind: "ask",
      category: "patch",
      title: path ? `Edit ${path}` : "Apply proposed file changes?",
      command: null,
      reason: path ? "The file is outside this session's writable roots." : options.decisionReason ?? null,
      prefixRule: null
    };
  }

  if (toolName === "Bash") {
    const command = stringValue(input.command);
    const unsandboxed = input.dangerouslyDisableSandbox === true;
    return {
      kind: "ask",
      category: "command",
      title: command ? `Run ${command}` : "Run this command?",
      command,
      reason: unsandboxed
        ? "The command asked to run outside the sandbox."
        : options.decisionReason ?? options.blockedPath ?? null,
      prefixRule: bashPrefixSuggestion(options.suggestions)
    };
  }

  return {
    kind: "ask",
    category: toolName.startsWith("mcp__") ? "tool" : "permissions",
    title: options.title ?? `Use ${toolName}?`,
    command: null,
    reason: options.decisionReason ?? options.description ?? null,
    prefixRule: null
  };
}

/** SDK permission updates that implement an operator's approval scope. */
export function approvalPermissionUpdates(
  toolName: string,
  input: Record<string, unknown>,
  response: Extract<HostApprovalResponse, { behavior: "allow" }>,
  prefixRule: string[] | null = null
): unknown[] {
  if (response.scope === "once") return [];
  if (response.scope === "prefix") {
    return prefixRule?.length
      ? [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: `${prefixRule.join(" ")}:*` }], behavior: "allow", destination: "session" }]
      : [];
  }
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const path = stringValue(input.file_path) ?? stringValue(input.notebook_path);
    return path ? [{ type: "addDirectories", directories: [dirname(resolve(path))], destination: "session" }] : [];
  }
  if (toolName === "Bash") {
    const command = stringValue(input.command);
    return command
      ? [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: command }], behavior: "allow", destination: "session" }]
      : [];
  }
  return [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
}

/**
 * True when `target` resolves inside the session cwd or a writable root. Symlinks are resolved on the nearest
 * existing ancestor so a link cannot redirect a write outside the permitted roots.
 */
export function isWithinWritableRoots(target: string, context: PermissionContext): boolean {
  const absolute = isAbsolute(target) ? target : resolve(context.cwd, target);
  const resolved = resolveExistingAncestor(absolute);
  return [context.cwd, ...context.writableRoots].some((root) => {
    const resolvedRoot = resolveExistingAncestor(resolve(root));
    const relation = relative(resolvedRoot, resolved);
    return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation) && relation.split(sep)[0] !== "..");
  });
}

function resolveExistingAncestor(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    missing.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
  try {
    return resolve(realpathSync(current), ...missing);
  } catch {
    return resolve(path);
  }
}

function bashPrefixSuggestion(suggestions: unknown[] | undefined): string[] | null {
  for (const suggestion of suggestions ?? []) {
    const record = recordValue(suggestion);
    if (record?.type !== "addRules" || !Array.isArray(record.rules)) continue;
    for (const rule of record.rules) {
      const value = recordValue(rule);
      const content = stringValue(value?.ruleContent);
      if (value?.toolName !== "Bash" || !content?.endsWith(":*")) continue;
      const prefix = content.slice(0, -2).trim();
      if (prefix) return prefix.split(/\s+/);
    }
  }
  return null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
