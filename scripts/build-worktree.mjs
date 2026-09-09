#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const projects = ["packages/core", "apps/server", "apps/web"];
const tsc = join(root, "node_modules/.bin/tsc");

for (const project of projects) {
  run(tsc, ["-p", "tsconfig.json"], join(root, project));
}
run(join(root, "apps/web/node_modules/.bin/vite"), ["build"], join(root, "apps/web"));

function run(command, args, cwd) {
  process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
