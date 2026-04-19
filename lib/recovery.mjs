#!/usr/bin/env node

import { summarizeStatusPayload } from "./ampere-client.mjs";

export const RECOVERY_STATES = new Set([
  "queued",
  "creating_server",
  "creating_container",
  "installing",
  "pushing_config",
  "starting_gateway",
  "waking",
  "restarting",
  "provisioning",
  "migrating",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForStateTransition(client, logger, account, timeoutMs, pollMs) {
  const startedAt = Date.now();
  let lastSummary = null;
  let lastState = null;

  while (Date.now() - startedAt < timeoutMs) {
    const status = await client.getStatus();
    const payload = status.json;
    const summary = payload ? summarizeStatusPayload(payload) : status.text;
    const state = payload?.status || "unknown";

    if (summary !== lastSummary) {
      await logger.log(`${account.name}: status ${status.status} ${summary}`);
      lastSummary = summary;
    }

    if (state !== lastState) {
      await logger.log(`${account.name}: state-change ${lastState || "none"} -> ${state}`);
      lastState = state;
    }

    if (state === "running") {
      return { ok: true, finalState: state, payload };
    }

    if (!RECOVERY_STATES.has(state)) {
      return { ok: false, finalState: state, payload };
    }

    await sleep(pollMs);
  }

  return { ok: false, finalState: "timeout", payload: null };
}

export async function recoverAccount(client, logger, account, { dryRun = false } = {}) {
  const timeoutMs = account.recoveryTimeoutMs;
  const pollMs = account.pollMs;

  if (dryRun) {
    await logger.log(
      `${account.name}: dry-run recovery restartFirst=${account.restartFirst} timeoutMs=${timeoutMs} pollMs=${pollMs}`,
    );
    return { ok: true, finalState: "dry-run" };
  }

  if (account.restartFirst) {
    const restart = await client.restart();
    await logger.log(`${account.name}: trigger restart status=${restart.status} body=${restart.text}`);
    await sleep(1500);

    const restartResult = await waitForStateTransition(client, logger, account, timeoutMs, pollMs);
    if (restartResult.ok) {
      return restartResult;
    }

    if (restartResult.finalState !== "error" && restartResult.finalState !== "failed") {
      return restartResult;
    }

    await logger.log(`${account.name}: restart path ended in ${restartResult.finalState}, escalating to repair`);
  }

  const repair = await client.repair();
  await logger.log(`${account.name}: trigger repair status=${repair.status} body=${repair.text}`);
  await sleep(1500);

  return waitForStateTransition(client, logger, account, timeoutMs, pollMs);
}
