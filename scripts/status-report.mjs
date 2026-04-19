#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ServiceClient, mergeAccountConfig, summarizeStatusPayload } from "../lib/service-client.mjs";

function parseArgs(argv) {
  const out = {
    config: path.resolve(process.cwd(), "config/accounts.json"),
    jsonOut: null,
    textOut: null,
    title: "Container Status Report",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      out.config = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === "--json-out") {
      out.jsonOut = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === "--text-out") {
      out.textOut = path.resolve(process.cwd(), argv[++i]);
    } else if (arg === "--title") {
      out.title = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return out;
}

function formatTime(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function renderText(title, results) {
  const now = new Date();
  const lines = [
    title,
    `UTC: ${formatTime(now, "UTC")}`,
    `北京时间: ${formatTime(now, "Asia/Shanghai")}`,
    "",
  ];

  for (const result of results) {
    lines.push(`${result.name}: ${result.summary}`);
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await fs.readFile(args.config, "utf8"));
  const defaults = config.defaults || {};
  const accounts = (config.accounts || []).map((account) => mergeAccountConfig(defaults, account));

  const results = [];
  for (const account of accounts) {
    const client = new ServiceClient(account);
    const response = await client.getStatus();
    const payload = response.json;
    const state = payload?.status || "unknown";
    results.push({
      name: account.name,
      httpStatus: response.status,
      state,
      summary: payload ? summarizeStatusPayload(payload) : response.text,
      payload,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    title: args.title,
    results,
  };

  const text = renderText(args.title, results);

  if (args.jsonOut) {
    await fs.writeFile(args.jsonOut, JSON.stringify(report, null, 2));
  }
  if (args.textOut) {
    await fs.writeFile(args.textOut, text);
  }

  process.stdout.write(text);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
