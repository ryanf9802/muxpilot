import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MuxpilotGitSkillStatus } from "@muxpilot/core";

const SKILL_NAME = "muxpilot-git-workflow";

export async function muxpilotGitWorkflowSkillStatus(codexHome: string): Promise<MuxpilotGitSkillStatus> {
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

export async function installMuxpilotGitWorkflowSkill(codexHome: string): Promise<MuxpilotGitSkillStatus> {
  const source = await bundledSkillPath();
  const destination = join(resolve(codexHome), "skills", SKILL_NAME);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
  return muxpilotGitWorkflowSkillStatus(codexHome);
}

async function bundledFiles(root: string, current = ""): Promise<string[]> {
  const entries = await readdir(join(root, current), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await bundledFiles(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

async function bundledSkillPath(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "skills", SKILL_NAME),
    resolve(moduleDir, "../../../../skills", SKILL_NAME),
    resolve(moduleDir, "../../../../../skills", SKILL_NAME)
  ];
  for (const candidate of candidates) {
    try {
      await readFile(join(candidate, "SKILL.md"), "utf8");
      return candidate;
    } catch {
      // Try the next packaged/development location.
    }
  }
  throw new Error("Bundled muxpilot Git workflow skill was not found");
}
