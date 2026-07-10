export function formatWorkspaceStatus(workspace) {
  const reconciliation = workspace?.reconciliation;
  const finalization = workspace?.finalization;
  const localContainsManaged = ["current", "updated"].includes(reconciliation?.localSync);
  const lines = [
    `WORKSPACE state=${workspace?.state ?? "unknown"} generation=${workspace?.generation ?? 0}`,
    `MANAGED ref=${reconciliation?.managedRef ?? "unknown"} sha=${workspace?.targetSha ?? reconciliation?.managedSha ?? "unknown"}`,
    `LOCAL ref=${reconciliation?.localRef ?? `refs/heads/${workspace?.targetBranch ?? "unknown"}`} sha=${reconciliation?.localSha ?? "missing"} sync=${reconciliation?.localSync ?? "unknown"} contains_managed=${localContainsManaged ? "yes" : "no"}`,
    `REMOTE ref=${reconciliation?.remoteRef ?? "none"} sha=${reconciliation?.remoteSha ?? workspace?.remoteSha ?? "missing"} freshness=${reconciliation?.remoteFreshness ?? workspace?.sourceFreshness ?? "unknown"}`
  ];
  lines.push(`PUBLICATION published=${workspace?.remoteSha && workspace.remoteSha === workspace.targetSha ? "yes" : "no"}`);
  if (reconciliation && !localContainsManaged) lines.push("WARNING The named local target does not contain the managed integration result.");
  if (reconciliation?.worktreePath) lines.push(`RECONCILIATION status=${reconciliation.status} worktree=${reconciliation.worktreePath}`);
  if (finalization) lines.push(`FINALIZATION id=${finalization.id} status=${finalization.status} candidate=${finalization.candidateSha}${finalization.error ? ` error=${JSON.stringify(finalization.error)}` : ""}`);
  for (const link of workspace?.dependencyLinks ?? []) {
    lines.push(`DEPENDENCY kind=${link.kind} path=${link.relativePath} source=${link.sourcePath} linked=${link.linked}`);
  }
  if (workspace?.lastError) lines.push(`WARNING ${workspace.lastError}`);
  return lines.join("\n");
}
