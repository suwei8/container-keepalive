#!/usr/bin/env node

function normalizeWsData(data) {
  if (typeof data === "string") {
    return Promise.resolve(Buffer.from(data, "utf8"));
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer().then((buffer) => Buffer.from(buffer));
  }
  if (data instanceof ArrayBuffer) {
    return Promise.resolve(Buffer.from(data));
  }
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
  if (Buffer.isBuffer(data)) {
    return Promise.resolve(data);
  }
  return Promise.resolve(Buffer.from(String(data ?? "")));
}

function reviveWaitFor(waitFor) {
  if (!waitFor) {
    return null;
  }
  if (waitFor.type === "string") {
    return waitFor.value;
  }
  if (waitFor.type === "regex") {
    return new RegExp(waitFor.source, waitFor.flags);
  }
  return null;
}

async function readPayload() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const payload = await readPayload();
  const { token, terminalWs, commands, timeoutMs, cols, rows } = payload;
  const waitFor = reviveWaitFor(payload.waitFor);
  const ws = new WebSocket(`${terminalWs}?token=${encodeURIComponent(token)}`);

  let output = "";
  let promptSeen = false;
  let settled = false;
  let timeout = null;
  let pingTimer = null;

  const cleanup = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const finish = (result, exitCode = 0) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    process.stdout.write(JSON.stringify(result), () => {
      process.exit(exitCode);
    });
  };

  const fail = (error) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`, () => {
      process.exit(1);
    });
  };

  timeout = setTimeout(() => {
    finish({ ok: false, output, reason: "timeout" });
  }, timeoutMs);

  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 25_000);
  });

  ws.addEventListener("message", async (event) => {
    const data = await normalizeWsData(event.data);
    const text = data.toString("utf8");
    output += text;

    if (!promptSeen && /(?:\r?\n|^).*[#$] $/.test(text)) {
      promptSeen = true;
      for (const command of commands) {
        ws.send(`${command}\r`);
      }
    }

    const matched =
      typeof waitFor === "string"
        ? output.includes(waitFor)
        : waitFor instanceof RegExp
          ? waitFor.test(output)
          : false;

    if (matched) {
      finish({ ok: true, output, reason: "matched" });
    }
  });

  ws.addEventListener("error", () => {
    fail(new Error("Terminal websocket error"));
  });

  ws.addEventListener("close", () => {
    finish({ ok: true, output, reason: "close" });
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
