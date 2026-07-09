import type { ApprovalDecision, ApprovalKind, ApprovalOption } from "@muxpilot/core";

export interface InteractiveApprovalOption extends ApprovalOption {
  menuNumber: number;
  selected: boolean;
}

export interface InteractiveApprovalPrompt {
  kind: ApprovalKind;
  title: string;
  command: string | null;
  reason: string | null;
  prefixRule: string[] | null;
  options: InteractiveApprovalOption[];
}

export function parseInteractiveApprovalPrompt(capture: string): InteractiveApprovalPrompt | null {
  const text = cleanTerminalText(capture);
  const lines = text.split("\n");
  const appTitleIndex = lastLineIndex(lines, (line) => /^Allow\s+.+\?$/i.test(line.trim()));
  const commandTitleIndex = lastLineIndex(lines, (line) => /^\s*Would you like to run the following command\?\s*$/i.test(line));
  if (commandTitleIndex > appTitleIndex) return parseCommandApprovalPrompt(text) ?? parseAppPermissionPrompt(text);
  return parseAppPermissionPrompt(text) ?? parseCommandApprovalPrompt(text);
}

function parseAppPermissionPrompt(text: string): InteractiveApprovalPrompt | null {
  if (!/enter to submit\s*\|\s*esc to cancel/i.test(text)) return null;

  const lines = text.split("\n");
  const titleIndex = lastLineIndex(lines, (line) => /^Allow\s+.+\?$/i.test(line.trim()));
  if (titleIndex < 0) return null;
  const title = lines[titleIndex]?.trim();
  if (!title) return null;

  const options = lines
    .slice(titleIndex + 1)
    .map(parseAppApprovalOption)
    .filter((option): option is InteractiveApprovalOption => Boolean(option));
  const decisions = new Set(options.map((option) => option.decision));
  if (!decisions.has("approve_once") || !decisions.has("deny") || options.filter((option) => option.selected).length !== 1) {
    return null;
  }

  return { kind: "permissions", title, command: null, reason: null, prefixRule: null, options };
}

function parseCommandApprovalPrompt(text: string): InteractiveApprovalPrompt | null {
  const lines = text.split("\n");
  const titleIndex = lastLineIndex(lines, (line) => /^\s*Would you like to run the following command\?\s*$/i.test(line));
  if (titleIndex < 0) return null;

  const options = lines
    .slice(titleIndex + 1)
    .map(parseCommandApprovalOption)
    .filter((option): option is InteractiveApprovalOption => Boolean(option));
  const decisions = new Set(options.map((option) => option.decision));
  if (!decisions.has("approve_once") || !decisions.has("deny") || options.filter((option) => option.selected).length !== 1) {
    return null;
  }

  const command = labeledCommand(lines.slice(titleIndex + 1));
  if (!command) return null;
  const reason = labeledValue(lines.slice(titleIndex + 1), "Reason");
  const prefixRule = commandPrefixRule(lines.slice(titleIndex + 1));
  return {
    kind: "command",
    title: lines[titleIndex]?.trim() ?? "Command approval required",
    command,
    reason,
    prefixRule,
    options
  };
}

function lastLineIndex(lines: string[], predicate: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index] ?? "")) return index;
  }
  return -1;
}

export function interactiveApprovalKeys(
  prompt: InteractiveApprovalPrompt,
  decision: ApprovalDecision
): string[] | null {
  const currentIndex = prompt.options.findIndex((option) => option.selected);
  const targetIndex = prompt.options.findIndex((option) => option.decision === decision);
  if (currentIndex < 0 || targetIndex < 0) return null;
  const direction = targetIndex >= currentIndex ? "Down" : "Up";
  return [...Array.from({ length: Math.abs(targetIndex - currentIndex) }, () => direction), "Enter"];
}

function parseAppApprovalOption(line: string): InteractiveApprovalOption | null {
  const match = line.match(
    /^\s*(›\s*)?(\d+)\.\s+(Allow for this session|Always allow|Allow|Cancel)(?:\s+(.*?))?\s*$/i
  );
  if (!match) return null;
  const decision = approvalDecision(match[3] ?? "");
  if (!decision) return null;
  return {
    decision,
    label: canonicalApprovalLabel(decision),
    description: match[4]?.trim() ?? "",
    menuNumber: Number(match[2]),
    selected: Boolean(match[1])
  };
}

function canonicalCommandApprovalLabel(decision: ApprovalDecision): string {
  if (decision === "approve_once") return "Approve once";
  if (decision === "approve_for_prefix") return "Always allow prefix";
  return "Deny";
}

function parseCommandApprovalOption(line: string): InteractiveApprovalOption | null {
  const match = line.match(/^\s*(›\s*)?(\d+)\.\s+(.+?)\s*$/);
  if (!match) return null;
  const rawLabel = (match[3] ?? "").replace(/\s+\((?:y|p|esc)\)\s*$/i, "").trim();
  const decision = commandApprovalDecision(rawLabel);
  if (!decision) return null;
  return {
    decision,
    label: canonicalCommandApprovalLabel(decision),
    description: rawLabel,
    menuNumber: Number(match[2]),
    selected: Boolean(match[1])
  };
}

function commandApprovalDecision(label: string): ApprovalDecision | null {
  if (/^Yes,\s*proceed\b/i.test(label)) return "approve_once";
  if (/^Yes,\s*and don['’]t ask again for commands that start with\b/i.test(label)) return "approve_for_prefix";
  if (/^No,\s*and tell Codex what to do differently\b/i.test(label)) return "deny";
  return null;
}

function labeledCommand(lines: string[]): string | null {
  for (const line of lines) {
    const match = line.match(/^\s*\$\s+(.+?)\s*$/);
    if (match?.[1]) return match[1];
  }
  return null;
}

function labeledValue(lines: string[], label: string): string | null {
  const pattern = new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, "i");
  for (const line of lines) {
    const match = line.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function commandPrefixRule(lines: string[]): string[] | null {
  for (const line of lines) {
    const match = line.match(/commands that start with\s+`([^`]+)`/i);
    if (!match?.[1]) continue;
    const parts = match[1].trim().split(/\s+/).filter(Boolean);
    if (parts.length > 0) return parts;
  }
  return null;
}

function approvalDecision(label: string): ApprovalDecision | null {
  const normalized = label.trim().toLowerCase();
  if (normalized === "allow") return "approve_once";
  if (normalized === "allow for this session") return "approve_for_session";
  if (normalized === "always allow") return "approve_always";
  if (normalized === "cancel") return "deny";
  return null;
}

function canonicalApprovalLabel(decision: ApprovalDecision): string {
  if (decision === "approve_once") return "Allow";
  if (decision === "approve_for_session") return "Allow for this session";
  if (decision === "approve_always") return "Always allow";
  if (decision === "deny") return "Cancel";
  return "Always allow prefix";
}

function cleanTerminalText(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}
