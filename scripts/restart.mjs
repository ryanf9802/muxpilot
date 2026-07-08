const mode = process.argv[2] ?? "all";
console.error(`pnpm restart:${mode} has been replaced. Use "pnpm app restart ${mode}".`);
process.exit(1);
