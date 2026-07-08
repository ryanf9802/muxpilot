export type NormalizedUserContext =
  | { kind: "action"; text: string; skillNames: string[] }
  | { kind: "hidden"; text: ""; skillNames: string[] }
  | { kind: "message"; text: string; skillNames: string[] };

export interface NormalizedSubagentNotification {
  agentPath: string | null;
  text: string;
}

interface CompactedSkillContext {
  names: string[];
  text: string;
}

const SKILL_BLOCK_PATTERN = /<skill>\s*[\s\S]*?<\/skill>/gi;
const SKILL_NAME_PATTERN = /<name>\s*([^<]+?)\s*<\/name>/i;
const SKILL_PATH_PATTERN = /<path>\s*([^<]+?)\s*<\/path>/i;
const ENVIRONMENT_CONTEXT_BLOCK_PATTERN = /<environment_context>\s*[\s\S]*?<\/environment_context>/gi;
const TURN_ABORTED_CONTEXT_PATTERN = /^<turn_aborted>\s*[\s\S]*?<\/turn_aborted>$/i;
const INSTRUCTIONS_CONTEXT_PATTERN =
  /^#\s*([^\n]*?\binstructions\s+for\s+(.+?))\s*\n+\s*<INSTRUCTIONS>\s*[\s\S]*?<\/INSTRUCTIONS>\s*$/i;
const STANDALONE_INSTRUCTIONS_CONTEXT_PATTERN = /^<INSTRUCTIONS>\s*[\s\S]*?<\/INSTRUCTIONS>$/i;
const COMPACTED_SKILLS_PATTERN = /\n\nSkills:\s*([^\n]+)\s*$/;
const SUBAGENT_NOTIFICATION_PATTERN = /^<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>$/i;

export function normalizeUserContextText(text: string): NormalizedUserContext {
  const withoutEnvironment = cleanText(text.replace(ENVIRONMENT_CONTEXT_BLOCK_PATTERN, ""));
  if (!withoutEnvironment) return { kind: "hidden", text: "", skillNames: [] };

  if (TURN_ABORTED_CONTEXT_PATTERN.test(withoutEnvironment)) {
    return { kind: "action", text: "Turn aborted", skillNames: [] };
  }

  const subagentNotification = normalizeSubagentNotificationText(withoutEnvironment);
  if (subagentNotification) return { kind: "action", text: subagentNotification.text, skillNames: [] };

  const instructionsAction = instructionsActionText(withoutEnvironment);
  if (instructionsAction) return { kind: "action", text: instructionsAction, skillNames: [] };

  const compacted = extractSkillContext(withoutEnvironment);
  const cleanedText = cleanText(compacted.text);
  if (!cleanedText) return { kind: "hidden", text: "", skillNames: compacted.names };

  return {
    kind: "message",
    text: appendSkillNamesToText(cleanedText, compacted.names),
    skillNames: compacted.names
  };
}

export function appendSkillNamesToText(text: string, names: string[]): string {
  const existingNames = skillNamesFromText(text);
  const baseText = text.replace(COMPACTED_SKILLS_PATTERN, "").trim();
  const allNames = mergeSkillNames(existingNames, names);
  if (allNames.length === 0) return baseText;
  return `${baseText}\n\nSkills: ${allNames.join(", ")}`;
}

export function isDisplayableUserPromptText(text: string): boolean {
  return normalizeUserContextText(text).kind === "message";
}

export function normalizeSubagentNotificationText(text: string): NormalizedSubagentNotification | null {
  const match = cleanText(text).match(SUBAGENT_NOTIFICATION_PATTERN);
  if (!match?.[1]) return null;

  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!isRecord(parsed)) return null;
    const agentPath = typeof parsed.agent_path === "string" && parsed.agent_path.trim() ? parsed.agent_path.trim() : null;
    const status = isRecord(parsed.status) ? parsed.status : null;
    const completed = typeof status?.completed === "string" ? status.completed.trim() : "";
    const text = completed ? `Subagent completed${agentPath ? `: ${agentPath}` : ""}\n\n${completed}` : `Subagent notification${agentPath ? `: ${agentPath}` : ""}`;
    return { agentPath, text };
  } catch {
    return null;
  }
}

function instructionsActionText(text: string): string | null {
  const match = text.match(INSTRUCTIONS_CONTEXT_PATTERN);
  if (!match) return STANDALONE_INSTRUCTIONS_CONTEXT_PATTERN.test(text) ? "Loaded repository instructions" : null;

  const title = match[1]?.trim() ?? "Repository instructions";
  const location = match[2]?.trim();
  const source = title.replace(/\s+instructions\s+for\s+.+$/i, "").trim() || "Repository";
  return location ? `Loaded ${source} instructions for ${location}` : `Loaded ${source} instructions`;
}

function extractSkillContext(text: string): CompactedSkillContext {
  const names: string[] = [];
  const strippedText = text.replace(SKILL_BLOCK_PATTERN, (block) => {
    const name = skillName(block);
    if (name && !names.includes(name)) names.push(name);
    return "";
  });
  return { names, text: strippedText };
}

function skillName(block: string): string | null {
  const name = block.match(SKILL_NAME_PATTERN)?.[1]?.trim();
  if (name) return name;

  const path = block.match(SKILL_PATH_PATTERN)?.[1]?.trim();
  if (!path) return null;
  const normalized = path.replace(/\/+$/, "");
  const last = normalized.split("/").at(-1);
  return last?.replace(/\.md$/i, "") || null;
}

function skillNamesFromText(text: string): string[] {
  const match = text.match(COMPACTED_SKILLS_PATTERN);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function mergeSkillNames(current: string[], incoming: string[]): string[] {
  for (const name of incoming) {
    if (name && !current.includes(name)) current.push(name);
  }
  return current;
}

function cleanText(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
