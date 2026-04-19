#!/usr/bin/env node

import fs from "node:fs/promises";

function stamp() {
  return new Date().toISOString();
}

export class Logger {
  constructor(logFile = null) {
    this.logFile = logFile;
  }

  async init() {
    if (this.logFile) {
      await fs.writeFile(this.logFile, "");
    }
  }

  async log(message) {
    const line = `[${stamp()}] ${message}`;
    process.stdout.write(`${line}\n`);
    if (this.logFile) {
      await fs.appendFile(this.logFile, `${line}\n`);
    }
  }
}

