#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const out = {
    mode: "keepalive",
    output: path.resolve(process.cwd(), "config/accounts.json"),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") {
      out.mode = argv[++i];
    } else if (arg === "--output") {
      out.output = path.resolve(process.cwd(), argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!["keepalive", "recovery"].includes(out.mode)) {
    throw new Error(`Unsupported mode: ${out.mode}`);
  }

  return out;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function buildConfig(mode) {
  const secondarySessionBase64 = requireEnv("SERVICE_SECONDARY_SESSION_B64");

  const defaults = {
    autoWake: true,
    autoRecover: false,
    restartFirst: true,
    pollMs: mode === "recovery" ? 5000 : 7000,
    wakeTimeoutMs: 180000,
    recoveryTimeoutMs: mode === "recovery" ? 240000 : 300000,
    heartbeatTimeoutMs: 10000,
    ignoreFailure: false,
  };

  if (mode === "recovery") {
    return {
      defaults,
      accounts: [
        {
          name: "secondary",
          sessionBase64: secondarySessionBase64,
          autoWake: true,
          autoRecover: true,
          acceptInProgressTimeout: true,
          restartFirst: true,
        },
      ],
    };
  }

  const primarySessionBase64 = requireEnv("SERVICE_PRIMARY_SESSION_B64");

  return {
    defaults,
    accounts: [
      {
        name: "primary",
        sessionBase64: primarySessionBase64,
        autoWake: true,
        autoRecover: false,
        heartbeatCommand: "printf '__KEEPALIVE_HEARTBEAT__\\n'",
      },
      {
        name: "secondary",
        sessionBase64: secondarySessionBase64,
        autoWake: true,
        autoRecover: false,
      },
    ],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = buildConfig(args.mode);
  await fs.mkdir(path.dirname(args.output), { recursive: true });
  await fs.writeFile(args.output, JSON.stringify(config, null, 2));
  process.stdout.write(`wrote ${args.output} mode=${args.mode}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
