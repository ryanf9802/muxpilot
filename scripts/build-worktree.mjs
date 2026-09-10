#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, "node_modules/.bin/tsc");

run(tsc, ["-p", "tsconfig.json"], join(root, "packages/core"));
for (const project of ["apps/server", "apps/web"]) {
  withWorktreeDependencies(join(root, project), () => run(tsc, ["-p", "tsconfig.json"], join(root, project)));
}
withWorktreeDependencies(join(root, "apps/web"), () => {
  run(join(root, "apps/web/node_modules/.bin/vite"), ["build"], join(root, "apps/web"));
});

function run(command, args, cwd) {
  process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

function withWorktreeDependencies(projectRoot, callback) {
  const modules = join(projectRoot, "node_modules");
  const backup = `${modules}.muxpilot-shared`;
  if (!lstatSync(modules).isSymbolicLink() && existsSync(backup) && lstatSync(backup).isSymbolicLink()) {
    rmSync(modules, { recursive: true, force: true });
    renameSync(backup, modules);
  }
  if (!lstatSync(modules).isSymbolicLink()) {
    callback();
    return;
  }
  const shared = readlinkSync(modules);
  const sharedRoot = shared.startsWith("/") ? shared : join(projectRoot, shared);
  renameSync(modules, backup);
  mkdirSync(modules);
  try {
    for (const entry of readdirSync(sharedRoot)) {
      if (entry === "@muxpilot") continue;
      symlinkSync(join(sharedRoot, entry), join(modules, entry));
    }
    mkdirSync(join(modules, "@muxpilot"));
    symlinkSync(join(root, "packages/core"), join(modules, "@muxpilot/core"));
    callback();
  } finally {
    rmSync(modules, { recursive: true, force: true });
    renameSync(backup, modules);
  }
}
