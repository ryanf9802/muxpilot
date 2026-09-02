import type { MuxpilotGitSkillSyncResult } from "./bundled-skill.mjs";

export function syncBundledSkillForMode(mode: string, codexHome?: string): Promise<MuxpilotGitSkillSyncResult | null>;
export function shadowIsolationEnvironment(root: string, source?: NodeJS.ProcessEnv): Record<string, string>;
export function shadowDependencyIsolation(root: string): { expected: string | null; server: string | null; web: string | null; isolated: boolean };
export function shadowOwnedSystemdUnits(dataDir: string): string[];
