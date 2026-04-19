#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const out = {
    previous: null,
    current: null,
    messageOut: null,
    stateOut: null,
    githubOutput: process.env.GITHUB_OUTPUT || null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--previous") {
      out.previous = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === "--current") {
      out.current = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === "--message-out") {
      out.messageOut = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === "--state-out") {
      out.stateOut = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === "--github-output") {
      out.githubOutput = path.resolve(process.cwd(), argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!out.current || !out.messageOut || !out.stateOut) {
    throw new Error("--current, --message-out and --state-out are required");
  }

  return out;
}

async function loadJson(file, fallback = {}) {
  if (!file) {
    return fallback;
  }
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const previous = await loadJson(args.previous, {});
  const currentReport = await loadJson(args.current, {});
  const current = currentReport.results?.[0];

  if (!current) {
    throw new Error("Current recovery status report is empty");
  }

  const stateRecord = {
    account: current.name,
    state: current.state,
    summary: current.summary,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(args.stateOut, `${JSON.stringify(stateRecord, null, 2)}\n`);

  const shouldNotify = Boolean(previous.state && previous.state !== "running" && current.state === "running");
  if (shouldNotify) {
    const message = [
      "Ampere 恢复成功",
      `账号: ${current.name}`,
      `之前状态: ${previous.summary || previous.state}`,
      `当前状态: ${current.summary}`,
    ].join("\n");
    await fs.writeFile(args.messageOut, `${message}\n`);
  }

  if (args.githubOutput) {
    await fs.appendFile(args.githubOutput, `notify_recovery=${shouldNotify ? "true" : "false"}\n`);
  }

  process.stdout.write(`notify_recovery=${shouldNotify ? "true" : "false"}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
