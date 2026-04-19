#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const TERMINAL_WORKER_PATH = fileURLToPath(new URL("./terminal-worker.mjs", import.meta.url));

function decodeJwtPayload(token) {
  const [, payload] = token.split(".");
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
}

function getFirebaseAuthRecord(session) {
  const db = session?.indexedDB?.firebaseLocalStorageDb?.stores?.firebaseLocalStorage;
  if (!db?.values?.length) {
    throw new Error("firebaseLocalStorageDb is missing from the session export");
  }

  const record = db.values.find((entry) => entry?.value?.stsTokenManager?.refreshToken);
  if (!record?.value) {
    throw new Error("No Firebase auth record with refreshToken was found");
  }

  return record;
}

function getApiKeyFromRecord(record) {
  const key = record?.fbase_key ?? "";
  const parts = key.split(":");
  if (parts.length < 3) {
    throw new Error("Could not parse Firebase apiKey from fbase_key");
  }
  return parts[2];
}

async function refreshAccessToken(apiKey, refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${text}`);
  }

  return JSON.parse(text);
}

function buildApiRequest(path, token, endpoints, method = "GET", body = null) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json, text/plain, */*",
    Origin: endpoints.origin,
    Referer: `${endpoints.origin}/`,
    "User-Agent": DEFAULT_USER_AGENT,
  };

  const init = { method, headers };

  if (body !== null && body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }

  return { url: `${endpoints.apiBase}${path}`, init };
}

async function loadSession(account) {
  if (account.session) {
    return structuredClone(account.session);
  }

  if (account.sessionJson) {
    return JSON.parse(account.sessionJson);
  }

  if (account.sessionBase64) {
    return JSON.parse(Buffer.from(account.sessionBase64, "base64").toString("utf8"));
  }

  if (account.sessionFile) {
    return JSON.parse(await fs.readFile(account.sessionFile, "utf8"));
  }

  throw new Error(`Account ${account.name || "(unnamed)"} is missing sessionFile/sessionJson/sessionBase64`);
}

function buildServiceEndpoints(account, session) {
  const webOrigin = account.webOrigin || session?.origin || new URL(session?.href).origin;
  const webUrl = new URL(webOrigin);
  const rootHost = webUrl.hostname.replace(/^www\./, "").replace(/^api\./, "");
  const apiProtocol = account.apiProtocol || webUrl.protocol;
  const wsProtocol = apiProtocol === "https:" ? "wss:" : "ws:";
  const apiHost = account.apiHost || `api.${rootHost}`;

  return {
    origin: webUrl.origin,
    apiBase: `${apiProtocol}//${apiHost}`,
    terminalWs: `${wsProtocol}//${apiHost}/api/my/terminal`,
  };
}

export class AmpereClient {
  constructor(account) {
    this.account = account;
    this.session = null;
    this.authRecord = null;
    this.authValue = null;
    this.apiKey = null;
    this.endpoints = null;
  }

  async init() {
    if (this.session) {
      return this;
    }

    this.session = await loadSession(this.account);
    this.authRecord = getFirebaseAuthRecord(this.session);
    this.authValue = this.authRecord.value;
    this.apiKey = getApiKeyFromRecord(this.authRecord);
    this.endpoints = buildServiceEndpoints(this.account, this.session);
    return this;
  }

  async getAccessToken() {
    await this.init();

    let accessToken = this.authValue.stsTokenManager.accessToken;
    let refreshToken = this.authValue.stsTokenManager.refreshToken;
    const payload = decodeJwtPayload(accessToken);
    const now = Math.floor(Date.now() / 1000);

    if (!payload.exp || payload.exp <= now + 60) {
      const refreshed = await refreshAccessToken(this.apiKey, refreshToken);
      accessToken = refreshed.access_token;
      refreshToken = refreshed.refresh_token || refreshToken;
      this.authValue.stsTokenManager.accessToken = accessToken;
      this.authValue.stsTokenManager.refreshToken = refreshToken;
      this.authValue.stsTokenManager.expirationTime = String(
        Date.now() + Number(refreshed.expires_in || 3600) * 1000,
      );
    }

    return accessToken;
  }

  async api(path, method = "GET", body = null) {
    const token = await this.getAccessToken();
    const { url, init } = buildApiRequest(path, token, this.endpoints, method, body);
    const response = await fetch(url, init);
    const text = await response.text();
    let json = null;

    try {
      json = JSON.parse(text);
    } catch {}

    return {
      ok: response.ok,
      status: response.status,
      text,
      json,
    };
  }

  async getStatus() {
    return this.api("/api/my/status");
  }

  async wake() {
    return this.api("/api/instance/wake", "POST", {});
  }

  async restart() {
    return this.api("/api/my/restart", "POST", {});
  }

  async repair() {
    return this.api("/api/my/retry", "POST", {});
  }

  async getResources() {
    return this.api("/api/my/resources");
  }

  async runTerminalCommands(
    commands,
    { timeoutMs = 10_000, cols = 120, rows = 40, waitFor = null } = {},
  ) {
    const token = await this.getAccessToken();
    const payload = {
      token,
      terminalWs: this.endpoints.terminalWs,
      commands,
      timeoutMs,
      cols,
      rows,
      waitFor:
        typeof waitFor === "string"
          ? { type: "string", value: waitFor }
          : waitFor instanceof RegExp
            ? { type: "regex", source: waitFor.source, flags: waitFor.flags }
            : null,
    };

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [TERMINAL_WORKER_PATH], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const guard = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Terminal worker timed out"));
      }, timeoutMs + 3_000);

      const cleanup = () => {
        clearTimeout(guard);
      };

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      });

      child.on("close", (code, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();

        if (code !== 0) {
          const detail = stderr.trim() || stdout.trim() || `signal=${signal || "unknown"}`;
          reject(new Error(`Terminal worker failed: ${detail}`));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (error) {
          const detail = stdout.trim() || stderr.trim() || String(error);
          reject(new Error(`Terminal worker returned invalid JSON: ${detail}`));
        }
      });

      child.stdin.end(JSON.stringify(payload));
    });
  }
}

export function mergeAccountConfig(defaults, account) {
  return {
    autoWake: true,
    autoRecover: false,
    restartFirst: true,
    acceptInProgressTimeout: false,
    pollMs: 7000,
    wakeTimeoutMs: 180000,
    recoveryTimeoutMs: 300000,
    heartbeatTimeoutMs: 10000,
    ignoreFailure: false,
    ...defaults,
    ...account,
  };
}

export function summarizeStatusPayload(payload) {
  if (!payload) {
    return "unknown";
  }

  const parts = [payload.status || "unknown"];
  if (payload.error_message) {
    parts.push(payload.error_message);
  }
  return parts.join(" | ");
}
