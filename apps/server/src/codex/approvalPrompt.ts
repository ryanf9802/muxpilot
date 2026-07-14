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
  const parsers = [
    {
      titleIndex: lastLineIndex(lines, (line) => /^Allow\s+.+\?$/i.test(line.trim())),
      parse: parseAppPermissionPrompt
    },
    {
      titleIndex: lastLineIndex(lines, (line) => /^\s*Would you like to run the following command\?\s*$/i.test(line)),
      parse: parseCommandApprovalPrompt
    },
    {
      titleIndex: lastLineIndex(lines, (line) => /^\s*Would you like to make the following edits\?\s*$/i.test(line)),
      parse: parsePatchApprovalPrompt
    }
  ].sort((first, second) => second.titleIndex - first.titleIndex);

  for (const candidate of parsers) {
    if (candidate.titleIndex < 0) continue;
    const prompt = candidate.parse(text);
    if (prompt) return prompt;
  }
  return null;
}

function parseAppPermissionPrompt(text: string): InteractiveApprovalPrompt | null {
  if (!/enter to submit\s*\|\s*esc to cancel/i.test(text)) return null;

  const lines = text.split("\n");
  if (!/enter to submit\s*\|\s*esc to cancel/i.test(lastNonEmptyLine(lines))) return null;
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
  const lastLine = lastNonEmptyLine(lines);
  if (!parseCommandApprovalOption(lastLine) && !isCommandApprovalFooter(lastLine)) return null;
  const titleIndex = lastLineIndex(lines, (line) => /^\s*Would you like to run the following command\?\s*$/i.test(line));
  if (titleIndex < 0) return null;

  const promptLines = lines.slice(titleIndex + 1);
  const options = approvalOptionLines(promptLines)
    .map(parseCommandApprovalOption)
    .filter((option): option is InteractiveApprovalOption => Boolean(option));
  const decisions = new Set(options.map((option) => option.decision));
  if (!decisions.has("approve_once") || !decisions.has("deny") || options.filter((option) => option.selected).length !== 1) {
    return null;
  }

  const command = labeledCommand(promptLines);
  if (!command) return null;
  const reason = labeledValue(promptLines, "Reason");
  const prefixRule = commandPrefixRule(approvalOptionLines(promptLines));
  return {
    kind: "command",
    title: lines[titleIndex]?.trim() ?? "Command approval required",
    command,
    reason,
    prefixRule,
    options
  };
}

function parsePatchApprovalPrompt(text: string): InteractiveApprovalPrompt | null {
  const lines = text.split("\n");
  if (!isCommandApprovalFooter(lastNonEmptyLine(lines))) return null;
  const titleIndex = lastLineIndex(lines, (line) => /^\s*Would you like to make the following edits\?\s*$/i.test(line));
  if (titleIndex < 0) return null;

  const options = approvalOptionLines(lines.slice(titleIndex + 1))
    .map(parsePatchApprovalOption)
    .filter((option): option is InteractiveApprovalOption => Boolean(option));
  const decisions = new Set(options.map((option) => option.decision));
  if (!decisions.has("approve_once") || !decisions.has("approve_for_session") || !decisions.has("deny")) return null;
  if (options.filter((option) => option.selected).length !== 1) return null;

  return {
    kind: "patch",
    title: lines[titleIndex]?.trim() ?? "Patch approval required",
    command: null,
    reason: null,
    prefixRule: null,
    options
  };
}

function approvalOptionLines(lines: string[]): string[] {
  const options: string[] = [];
  for (const line of lines) {
    if (/^\s*(?:›\s*)?\d+\.\s+/.test(line)) {
      options.push(line.trim());
      continue;
    }
    if (options.length === 0 || !line.trim()) continue;
    if (/^\s*(?:Environment|Reason):|^\s*\$\s+/.test(line) || isCommandApprovalFooter(line)) continue;
    const previous = options[options.length - 1] ?? "";
    const separator = previous.endsWith("/") ? "" : " ";
    options[options.length - 1] = `${previous}${separator}${line.trim()}`;
  }
  return options;
}

function isCommandApprovalFooter(line: string): boolean {
  return /^\s*Press enter to confirm or esc to cancel\s*$/i.test(line);
}

function lastLineIndex(lines: string[], predicate: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index] ?? "")) return index;
  }
  return -1;
}

function lastNonEmptyLine(lines: string[]): string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim()) return line;
  }
  return "";
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

function parsePatchApprovalOption(line: string): InteractiveApprovalOption | null {
  const match = line.match(/^\s*(›\s*)?(\d+)\.\s+(.+?)\s*$/);
  if (!match) return null;
  const rawLabel = (match[3] ?? "").replace(/\s+\((?:y|a|esc)\)\s*$/i, "").trim();
  const decision = patchApprovalDecision(rawLabel);
  if (!decision) return null;
  return {
    decision,
    label: decision === "approve_once" ? "Approve once" : decision === "approve_for_session" ? "Allow files for session" : "Deny",
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

function patchApprovalDecision(label: string): ApprovalDecision | null {
  if (/^Yes,\s*proceed\b/i.test(label)) return "approve_once";
  if (/^Yes,\s*and don['’]t ask again for these files\b/i.test(label)) return "approve_for_session";
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
  for (const [index, line] of lines.entries()) {
    const match = line.match(pattern);
    if (!match?.[1]) continue;
    const parts = [match[1]];
    for (const continuation of lines.slice(index + 1)) {
      if (!continuation.trim()) break;
      if (/^\s*(?:Environment|Reason):|^\s*\$\s+|^\s*(?:›\s*)?\d+\.\s+/.test(continuation)) break;
      parts.push(continuation.trim());
    }
    return parts.join(" ");
  }
  return null;
}

function commandPrefixRule(lines: string[]): string[] | null {
  for (const line of lines) {
    const match = line.match(/commands that start with\s+`([^`]+)`/i);
    if (!match?.[1]) continue;
    const parts = match[1].trim().replace(/\/\s+/g, "/").split(/\s+/).filter(Boolean);
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
