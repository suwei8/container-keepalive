# Container Keepalive

One-shot keepalive and recovery runner for the target container service. It is designed to be developed locally and then scheduled from GitHub Actions.

## What It Does

- Checks multiple accounts in one run.
- Wakes instances that are in `sleeping`, `expired`, or `archived`.
- Optionally runs a lightweight terminal heartbeat command for healthy accounts.
- Optionally tries `restart` and then `repair` for accounts stuck in `error` or `failed`.
- Writes a plain-text execution log that is easy to archive in GitHub Actions.

## Project Layout

- `scripts/keepalive.mjs`: one-pass multi-account runner.
- `scripts/recover-account.mjs`: manual recovery runner for a single account.
- `lib/service-client.mjs`: session auth, API calls, terminal command execution.
- `lib/recovery.mjs`: restart-first recovery state machine.
- `.github/workflows/keepalive.yml`: starter workflow for GitHub Actions.

## Config Format

Copy `config/accounts.example.json` to `config/accounts.json` and edit it.

Each account supports one of:

- `sessionFile`: local exported session JSON path.
- `sessionJson`: raw JSON string content.
- `sessionBase64`: base64-encoded session JSON.

Useful per-account fields:

- `name`
- `autoWake`
- `autoRecover`
- `restartFirst`
- `heartbeatCommand`
- `pollMs`
- `wakeTimeoutMs`
- `recoveryTimeoutMs`
- `heartbeatTimeoutMs`
- `ignoreFailure`

## Local Usage

Dry run:

```bash
cp ./config/accounts.example.json ./config/accounts.json
node ./scripts/keepalive.mjs --config ./config/accounts.json --dry-run
```

Real run:

```bash
node ./scripts/keepalive.mjs \
  --config ./config/accounts.json \
  --log-file ./keepalive.log
```

Manual recovery for one account:

```bash
node ./scripts/recover-account.mjs \
  --config ./config/accounts.json \
  --account jiyuanlihuizi \
  --log-file ./recovery.log
```

## GitHub Actions

Use three repository secrets:

- `SERVICE_HELENPAYNE261_SESSION_B64`
- `SERVICE_LIMING737_SESSION_B64`
- `SERVICE_JIYUANLIHUIZI_SESSION_B64`

Each value is the full exported session JSON encoded as base64.

The repository keeps only public workflow logic. Runtime config is rendered on the runner by `scripts/render-config.mjs`, so the session data is never committed.

Workflow layout:

- `.github/workflows/keepalive.yml`: scheduled keepalive for `helenpayne261` and `liming737`.
- `.github/workflows/recovery.yml`: higher-frequency recovery attempts for `jiyuanlihuizi`.

## Notes

- GitHub Actions scheduled workflows have a minimum interval of 5 minutes and can be delayed.
- Public repositories can have scheduled workflows auto-disabled after inactivity, so the schedule should be monitored.
- Session exports and Bearer tokens are sensitive. Rotate them if they have been pasted into logs or chat.
