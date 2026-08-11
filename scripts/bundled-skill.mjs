import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "muxpilot-git-workflow";
const QUEUE_SKILL_NAME = "muxpilot-heavy-command-queue";

export async function muxpilotGitWorkflowSkillStatus(codexHome) {
  const workflow = await bundledSkillStatus(codexHome, SKILL_NAME);
  if (workflow.status !== "current") return workflow;
  const queue = await bundledSkillStatus(codexHome, QUEUE_SKILL_NAME);
  return queue.status === "current" ? workflow : queue;
}

export async function syncMuxpilotGitWorkflowSkill(codexHome) {
  const existing = await bundledSkillStatus(codexHome, SKILL_NAME);
  const queueExisting = await bundledSkillStatus(codexHome, QUEUE_SKILL_NAME);
  if (existing.status === "current" && queueExisting.status === "current") return { ...existing, action: "unchanged" };

  await syncBundledSkill(codexHome, SKILL_NAME, existing);
  await syncBundledSkill(codexHome, QUEUE_SKILL_NAME, queueExisting);
  const installed = await muxpilotGitWorkflowSkillStatus(codexHome);
  if (installed.status !== "current") {
    throw new Error(`Bundled muxpilot skills remained ${installed.status} after synchronization`);
  }
  return { ...installed, action: existing.status === "missing" || queueExisting.status === "missing" ? "installed" : "updated" };
}

async function syncBundledSkill(codexHome, skillName, existing) {
  if (existing.status === "current") return;
  const source = await bundledSkillPath(skillName);
  await mkdir(dirname(existing.path), { recursive: true });
  await cp(source, existing.path, { recursive: true, force: true });
  const installed = await bundledSkillStatus(codexHome, skillName);
  if (installed.status !== "current") throw new Error(`Bundled ${skillName} skill remained ${installed.status} after synchronization`);
}

async function bundledSkillStatus(codexHome, skillName) {
  const source = await bundledSkillPath(skillName);
  const destination = join(resolve(codexHome), "skills", skillName);
  try { await readFile(join(destination, "SKILL.md")); } catch { return { status: "missing", path: destination }; }
  for (const relativePath of await bundledFiles(source)) {
    try {
      const [bundled, installed] = await Promise.all([readFile(join(source, relativePath)), readFile(join(destination, relativePath))]);
      if (!bundled.equals(installed)) return { status: "outdated", path: destination };
    } catch { return { status: "outdated", path: destination }; }
  }
  return { status: "current", path: destination };
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

async function bundledSkillPath(skillName = SKILL_NAME) {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "skills", skillName),
    resolve(moduleDir, "../skills", skillName)
  ];
  for (const candidate of candidates) {
    try {
      await readFile(join(candidate, "SKILL.md"), "utf8");
      return candidate;
    } catch {
      // Try the next repository/development location.
    }
  }
  throw new Error(`Bundled ${skillName} skill was not found`);
}
