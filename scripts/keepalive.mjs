#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { AmpereClient, mergeAccountConfig, summarizeStatusPayload } from "../lib/ampere-client.mjs";
import { Logger } from "../lib/logging.mjs";
import { recoverAccount } from "../lib/recovery.mjs";

function parseArgs(argv) {
  const out = {
    config: path.resolve(process.cwd(), "config/accounts.json"),
    dryRun: false,
    logFile: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      out.config = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === "--dry-run") {
      out.dryRun = true;
    } else if (arg === "--log-file") {
      out.logFile = path.resolve(process.cwd(), argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadConfig(configPath) {
  return JSON.parse(await fs.readFile(configPath, "utf8"));
}

async function waitForWake(client, logger, account) {
  const startedAt = Date.now();
  let lastSummary = null;

  while (Date.now() - startedAt < account.wakeTimeoutMs) {
    const status = await client.getStatus();
    const payload = status.json;
    const summary = payload ? summarizeStatusPayload(payload) : status.text;
    const state = payload?.status || "unknown";

    if (summary !== lastSummary) {
      await logger.log(`${account.name}: wake status ${status.status} ${summary}`);
      lastSummary = summary;
    }

    if (!["sleeping", "expired", "archived", "waking"].includes(state)) {
      return { ok: state === "running", finalState: state, payload };
    }

    await sleep(account.pollMs);
  }

  return { ok: false, finalState: "timeout", payload: null };
}

async function heartbeat(client, logger, account, dryRun) {
  if (!account.heartbeatCommand) {
    return { ok: true, finalState: "running" };
  }

  const doneMarker = "__AMPERE_DONE__";

  if (dryRun) {
    await logger.log(`${account.name}: dry-run heartbeat command=${JSON.stringify(account.heartbeatCommand)}`);
    return { ok: true, finalState: "dry-run" };
  }

  const commands = [account.heartbeatCommand, `printf '${doneMarker}\\n'`, "exit"];
  const result = await client.runTerminalCommands(commands, {
    timeoutMs: account.heartbeatTimeoutMs,
    waitFor: doneMarker,
  });
  const ok = result.ok || result.output.includes(doneMarker);
  const lastLine = result.output.trim().split("\n").slice(-3).join(" | ");
  await logger.log(
    `${account.name}: heartbeat terminal ok=${ok} transportOk=${result.ok} reason=${result.reason || "close"} tail=${lastLine}`,
  );
  return { ok, finalState: "running" };
}

async function handleAccount(account, logger, dryRun) {
  const client = new AmpereClient(account);
  const status = await client.getStatus();
  const payload = status.json;
  const state = payload?.status || "unknown";
  const summary = payload ? summarizeStatusPayload(payload) : status.text;
  await logger.log(`${account.name}: initial status ${status.status} ${summary}`);

  if (["running", "degraded"].includes(state)) {
    return heartbeat(client, logger, account, dryRun);
  }

  if (["sleeping", "expired", "archived"].includes(state) && account.autoWake) {
    if (dryRun) {
      await logger.log(`${account.name}: dry-run wake`);
      return { ok: true, finalState: "dry-run" };
    }

    const wake = await client.wake();
    await logger.log(`${account.name}: trigger wake status=${wake.status} body=${wake.text}`);
    return waitForWake(client, logger, account);
  }

  if (["error", "failed"].includes(state) && account.autoRecover) {
    return recoverAccount(client, logger, account, { dryRun });
  }

  if (["queued", "creating_server", "creating_container", "installing", "pushing_config", "starting_gateway", "waking", "restarting", "provisioning", "migrating"].includes(state)) {
    await logger.log(`${account.name}: instance already in progress state=${state}`);
    return { ok: true, finalState: state };
  }

  await logger.log(`${account.name}: no action taken for state=${state}`);
  return { ok: account.ignoreFailure, finalState: state };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig(args.config);
  const logger = new Logger(args.logFile);
  const defaults = config.defaults || {};
  const accounts = (config.accounts || []).map((account) => mergeAccountConfig(defaults, account));

  if (accounts.length === 0) {
    throw new Error("No accounts defined in config");
  }

  await logger.init();
  await logger.log(`start config=${args.config} dryRun=${args.dryRun} accounts=${accounts.length}`);

  const results = [];
  for (const account of accounts) {
    try {
      const result = await handleAccount(account, logger, args.dryRun);
      results.push({ name: account.name, ...result, ignoreFailure: account.ignoreFailure });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logger.log(`${account.name}: fatal ${message}`);
      results.push({ name: account.name, ok: false, finalState: "fatal", ignoreFailure: account.ignoreFailure });
    }
  }

  const failed = results.filter((result) => !result.ok && !result.ignoreFailure);
  await logger.log(`summary ${JSON.stringify(results)}`);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
