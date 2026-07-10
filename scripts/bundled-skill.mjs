import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "muxpilot-git-workflow";

export async function muxpilotGitWorkflowSkillStatus(codexHome) {
  const source = await bundledSkillPath();
  const destination = join(resolve(codexHome), "skills", SKILL_NAME);
  try {
    await readFile(join(destination, "SKILL.md"));
  } catch {
    return { status: "missing", path: destination };
  }
  for (const relativePath of await bundledFiles(source)) {
    try {
      const [bundled, installed] = await Promise.all([
        readFile(join(source, relativePath)),
        readFile(join(destination, relativePath))
      ]);
      if (!bundled.equals(installed)) return { status: "outdated", path: destination };
    } catch {
      return { status: "outdated", path: destination };
    }
  }
  return { status: "current", path: destination };
}

export async function syncMuxpilotGitWorkflowSkill(codexHome) {
  const existing = await muxpilotGitWorkflowSkillStatus(codexHome);
  if (existing.status === "current") return { ...existing, action: "unchanged" };

  const source = await bundledSkillPath();
  await mkdir(dirname(existing.path), { recursive: true });
  await cp(source, existing.path, { recursive: true, force: true });
  const installed = await muxpilotGitWorkflowSkillStatus(codexHome);
  if (installed.status !== "current") {
    throw new Error(`Bundled muxpilot Git workflow skill remained ${installed.status} after synchronization`);
  }
  return { ...installed, action: existing.status === "missing" ? "installed" : "updated" };
}

async function bundledFiles(root, current = "") {
  const entries = await readdir(join(root, current), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await bundledFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

async function bundledSkillPath() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "skills", SKILL_NAME),
    resolve(moduleDir, "../skills", SKILL_NAME)
  ];
  for (const candidate of candidates) {
    try {
      await readFile(join(candidate, "SKILL.md"), "utf8");
      return candidate;
    } catch {
      // Try the next repository/development location.
    }
  }
  throw new Error("Bundled muxpilot Git workflow skill was not found");
}
