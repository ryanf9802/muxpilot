import type { MuxpilotGitSkillStatus } from "@muxpilot/core";

export interface MuxpilotGitSkillSyncResult extends MuxpilotGitSkillStatus {
  status: "current";
  action: "installed" | "updated" | "unchanged";
}

export function muxpilotGitWorkflowSkillStatus(codexHome: string): Promise<MuxpilotGitSkillStatus>;
export function syncMuxpilotGitWorkflowSkill(codexHome: string): Promise<MuxpilotGitSkillSyncResult>;
