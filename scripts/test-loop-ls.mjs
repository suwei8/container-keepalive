#!/usr/bin/env node

/**
 * Keep one or more Ampere terminals alive: open a persistent WebSocket per
 * account and send a heartbeat command (default `ls`) at a fixed interval.
 *
 * Pass --session multiple times to keep multiple accounts active in parallel.
 *
 * Usage:
 *   node scripts/test-loop-ls.mjs \
 *     --session config/jiyuanlihuizi-session.json \
 *     --session config/helenpayne261-session.json \
 *     --interval 60000
 */

import fs from "node:fs/promises";
import path from "node:path";

import { ServiceClient } from "../lib/service-client.mjs";

function parseArgs(argv) {
  const args = {
    interval: 60_000,
    command: "ls",
    sessions: [],
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    switch (key) {
      case "--session":
        args.sessions.push(next);
        i += 1;
        break;
      case "--interval":
        args.interval = Number(next);
        i += 1;
        break;
      case "--command":
        args.command = next;
        i += 1;
        break;
      default:
        break;
    }
  }
  return args;
}

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function makeLogger(label) {
  return (msg) => process.stdout.write(`[${ts()}] [${label}] ${msg}\n`);
}

async function loadAccount(sessionPath) {
  const resolved = path.resolve(sessionPath);
  const raw = await fs.readFile(resolved, "utf8");
  const session = JSON.parse(raw);
  // Derive a friendly name from the session if possible.
  let name = path.basename(resolved, path.extname(resolved));
  try {
    const value =
      session.indexedDB.firebaseLocalStorageDb.stores.firebaseLocalStorage
        .values[0].value;
    if (value?.email) {
      name = value.email.split("@")[0];
    }
  } catch {}
  return { name, session, sessionFile: resolved };
}

async function wakeAndWait(client, log, { timeoutMs = 300_000, pollMs = 7_000 } = {}) {
  try {
    const statusBefore = await client.getStatus();
    log(`pre-wake status: ${statusBefore.status} ${statusBefore.text.slice(0, 120)}`);
    const wakeRes = await client.wake();
    log(`wake call: ${wakeRes.status} ${wakeRes.text.slice(0, 120)}`);
    if (!wakeRes.ok) return false;
  } catch (error) {
    log(`wake failed: ${error.message || error}`);
    return false;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      const s = await client.getStatus();
      let st = "unknown";
      try {
        st = JSON.parse(s.text).status;
      } catch {}
      log(`waking... status=${st}`);
      if (st === "running") {
        log("container is running again");
        return true;
      }
    } catch (error) {
      log(`status poll error: ${error.message || error}`);
    }
  }
  log("wake timed out");
  return false;
}

async function runAccountLoop({ name, session }, args) {
  const log = makeLogger(name);
  const client = new ServiceClient({ name, session });
  await client.init();

  let stopRequested = false;
  let attempt = 0;
  let totalSendCount = 0;
  let lastCloseCode = null;
  let lastCloseReason = "";

  const shutdown = () => {
    stopRequested = true;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  while (!stopRequested) {
    attempt += 1;
    let ws = null;
    let sendTimer = null;
    let pingTimer = null;
    let promptSeen = false;
    const connectStartedAt = Date.now();

    const stopTimers = () => {
      if (sendTimer) clearInterval(sendTimer);
      if (pingTimer) clearInterval(pingTimer);
      sendTimer = null;
      pingTimer = null;
    };

    try {
      // Force a token refresh each time we (re)connect: cached accessToken may
      // have been server-side revoked even though its `exp` looks valid.
      client.authValue.stsTokenManager.accessToken =
        "eyJhbGciOiJub25lIn0.eyJleHAiOjB9.";
      const token = await client.getAccessToken();
      const wsUrl = `${client.endpoints.terminalWs}?token=${encodeURIComponent(token)}`;

      log(`connecting (attempt #${attempt}) to ${client.endpoints.terminalWs}`);
      ws = new WebSocket(wsUrl);
    } catch (error) {
      log(`failed to prepare connection: ${error.message || error}`);
    }

    const sendCommand = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      totalSendCount += 1;
      log(`>>> [#${totalSendCount}] sending: ${args.command}`);
      ws.send(`${args.command}\r`);
    };

    if (ws) {
      ws.addEventListener("open", () => {
        log("websocket opened");
        ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ping" }));
          }
        }, 25_000);
      });

      ws.addEventListener("message", async (event) => {
        let buf;
        if (typeof event.data === "string") {
          buf = Buffer.from(event.data, "utf8");
        } else if (event.data instanceof ArrayBuffer) {
          buf = Buffer.from(event.data);
        } else if (typeof Blob !== "undefined" && event.data instanceof Blob) {
          buf = Buffer.from(await event.data.arrayBuffer());
        } else if (ArrayBuffer.isView(event.data)) {
          buf = Buffer.from(
            event.data.buffer,
            event.data.byteOffset,
            event.data.byteLength,
          );
        } else {
          buf = Buffer.from(String(event.data ?? ""));
        }
        const text = buf.toString("utf8");
        for (const line of text.split(/\r?\n/)) {
          if (line.trim().length > 0) {
            process.stdout.write(`[${name}] ${line}\n`);
          }
        }

        if (!promptSeen && /[#$]\s?$/.test(text)) {
          promptSeen = true;
          log(`prompt detected; starting ${args.command} loop every ${args.interval}ms`);
          sendCommand();
          sendTimer = setInterval(sendCommand, args.interval);
        }
      });

      ws.addEventListener("error", (event) => {
        log(`websocket error: ${event?.message || "unknown"}`);
      });

      // Wait for the socket to close (whether by error, network drop, or shutdown).
      await new Promise((resolve) => {
        ws.addEventListener("close", (event) => {
          stopTimers();
          lastCloseCode = event?.code ?? null;
          lastCloseReason = event?.reason || "";
          log(
            `websocket closed: code=${lastCloseCode} reason=${lastCloseReason}`,
          );
          resolve();
        });
        // If user requested shutdown while connected, close gracefully.
        const shutdownInterval = setInterval(() => {
          if (stopRequested) {
            clearInterval(shutdownInterval);
            try {
              ws.close();
            } catch {}
          }
        }, 200);
      });
    }

    stopTimers();
    if (stopRequested) break;

    // If the close reason indicates the container is gone, try to wake it.
    const containerGone =
      /instance not found|container not running|expired/i.test(
        lastCloseReason,
      ) || lastCloseCode === 1008 || lastCloseCode === 4004;
    if (containerGone) {
      const ready = await wakeAndWait(client, log);
      if (ready) {
        attempt = 0; // fresh start
        continue;
      }
    }

    // If the previous connection survived for a while, reset the backoff so
    // a transient drop doesn't push us into long waits.
    if (Date.now() - connectStartedAt > 60_000) {
      attempt = 0;
    }

    // Backoff: 2s, 4s, 8s, capped at 30s.
    const backoffMs = Math.min(2000 * 2 ** Math.min(attempt, 4), 30_000);
    log(`reconnecting in ${backoffMs}ms...`);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  log("loop exited");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.sessions.length === 0) {
    process.stderr.write(
      "Usage: node scripts/test-loop-ls.mjs --session <file> [--session <file2> ...] [--interval 60000] [--command ls]\n",
    );
    process.exit(1);
  }

  const accounts = await Promise.all(args.sessions.map(loadAccount));
  process.stdout.write(
    `[${ts()}] starting ${accounts.length} account loop(s): ${accounts.map((a) => a.name).join(", ")} (interval ${args.interval}ms)\n`,
  );

  await Promise.all(accounts.map((account) => runAccountLoop(account, args)));
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exit(1);
});
