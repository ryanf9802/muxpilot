import { logsMode, restartMode, startMode, statusMode, stopMode } from "./lifecycle.mjs";

const [command, rawMode, ...rawOptions] = process.argv.slice(2);

switch (command) {
  case "start":
    await startMode(rawMode ?? "prod");
    break;
  case "stop":
    await stopMode(rawMode ?? "prod");
    break;
  case "restart":
    await restartMode(rawMode ?? "prod");
    break;
  case "status":
    await statusMode(rawMode ?? "all");
    break;
  case "logs":
    await logsMode(logMode(rawMode), parseLogOptions(logOptionArgs(rawMode, rawOptions)));
    break;
  default:
    printUsage();
    process.exit(command ? 1 : 0);
}

function logMode(value) {
  if (!value || value.startsWith("-")) return "prod";
  return value;
}

function logOptionArgs(value, args) {
  if (!value || !value.startsWith("-")) return args;
  return [value, ...args];
}

function parseLogOptions(args) {
  const options = {
    follow: false,
    lines: 80,
    processes: ["server"]
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--follow" || arg === "-f") {
      options.follow = true;
      continue;
    }
    if (arg === "--lines" || arg === "-n") {
      options.lines = args[index + 1] ?? options.lines;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--lines=")) {
      options.lines = arg.slice("--lines=".length);
      continue;
    }
    if (arg === "--process") {
      options.processes = [args[index + 1] ?? "server"];
      index += 1;
      continue;
    }
    if (arg?.startsWith("--process=")) {
      options.processes = [arg.slice("--process=".length)];
      continue;
    }

    console.error(`Unknown logs option "${arg}".`);
    printUsage();
    process.exit(1);
  }

  return options;
}

function printUsage() {
  console.log(`Usage:
  pnpm app start [prod|dev]
  pnpm app stop [prod|dev|all]
  pnpm app restart [prod|dev|all]
  pnpm app status [prod|dev|all]
  pnpm app logs [prod|dev] [--lines N] [--follow] [--process server|web|supervisor|all]

Defaults:
  start/restart/stop/logs use prod
  status uses all`);
}
