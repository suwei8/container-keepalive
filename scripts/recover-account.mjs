#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { AmpereClient, mergeAccountConfig, summarizeStatusPayload } from "../lib/ampere-client.mjs";
import { Logger } from "../lib/logging.mjs";
import { RECOVERY_STATES, recoverAccount, waitForStateTransition } from "../lib/recovery.mjs";

function parseArgs(argv) {
  const out = {
    config: path.resolve(process.cwd(), "config/accounts.json"),
    account: null,
    dryRun: false,
    logFile: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      out.config = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === "--account") {
      out.account = argv[++i];
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--log-file") {
      out.logFile = path.resolve(process.cwd(), argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!out.account) {
    throw new Error("--account is required");
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await fs.readFile(args.config, "utf8"));
  const defaults = config.defaults || {};
  const account = (config.accounts || []).find((entry) => entry.name === args.account);

  if (!account) {
    throw new Error(`Account not found: ${args.account}`);
  }

  const merged = mergeAccountConfig(defaults, account);
  const logger = new Logger(args.logFile);
  await logger.init();
  await logger.log(`recover start account=${merged.name} dryRun=${args.dryRun}`);

  const client = new AmpereClient(merged);
  const status = await client.getStatus();
  const payload = status.json;
  const state = payload?.status || "unknown";
  const summary = payload ? summarizeStatusPayload(payload) : status.text;
  await logger.log(`recover initial status=${status.status} state=${state} summary=${summary}`);

  let result;
  if (RECOVERY_STATES.has(state)) {
    await logger.log(`recover wait-existing state=${state}`);
    result = args.dryRun
      ? { ok: true, finalState: "dry-run" }
      : await waitForStateTransition(client, logger, merged, merged.recoveryTimeoutMs, merged.pollMs);
  } else if (state === "running") {
    result = { ok: true, finalState: "running" };
  } else {
    result = await recoverAccount(client, logger, merged, { dryRun: args.dryRun });
  }

  await logger.log(`recover done ${JSON.stringify(result)}`);

  if (!result.ok && !merged.ignoreFailure) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
