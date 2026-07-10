import type { MuxpilotGitSkillSyncResult } from "./bundled-skill.mjs";

export function syncBundledSkillForMode(mode: string, codexHome?: string): Promise<MuxpilotGitSkillSyncResult | null>;
