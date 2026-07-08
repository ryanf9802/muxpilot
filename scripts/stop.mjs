const mode = process.argv[2];
const suffix = mode && mode !== "all" ? ` ${mode}` : " all";
console.error(`pnpm stop${mode && mode !== "all" ? `:${mode}` : ""} has been replaced. Use "pnpm app stop${suffix}".`);
process.exit(1);
