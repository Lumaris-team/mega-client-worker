# mega-client-worker

Internal MEGA storage API for the Lumaris account. This worker owns the
whole MEGA integration — megajs `Storage` login, connection cache, rate
limiting and retries — and exposes it to other workers **exclusively
through service bindings**. It has **no public URL** (`workers_dev: false`).

## Why it exists

- Single place for MEGA credentials (`MEGA_EMAIL` / `MEGA_PASSWORD`) and
  the anti-throttling logic (delays, backoff, browser user-agents).
- CPU safety: **user files are never loaded inside a Worker**. Downloads
  return a public `mega.nz/file/...#key` URL that the client fetches
  directly from MEGA. Only small internal state files (JSON/text) are
  read/written in memory.
- `main-client-worker` (and future workers) call it via
  `env.MEGA_CLIENT.fetch(...)` — see `update-client-account` for the
  `CONFIGURATION` entry and service binding.

## Routes

All paths are relative to the worker root (the caller strips its own
prefix). JSON in/out.

| Method | Path | Description |
|---|---|---|
| GET | `/ping` | MEGA connection check → `{ connected: true }` |
| POST | `/init` | Ensure the `lumaris/files` folder tree exists |
| GET | `/` or `/list/<path>` | List a directory (folders + files, max 5 items) |
| GET | `/read/<path>` | `{ url, name, size }` — **public download URL**, no content loaded |
| POST | `/upload` | `{ relativePath, content }` or `{ relativePath, url }` (streams remote → MEGA), or `multipart/form-data` with `file` + `relativePath` |
| POST | `/folder` | `{ relativePath }` — create folder |
| POST | `/rename` | `{ oldPath, newName }` |
| DELETE | `/delete/<path>` | Delete a file |
| GET | `/state/<path>` | Read a small state file → `{ content }` (JSON parsed or raw text; `null` if missing) |
| PUT/POST | `/state/<path>` | Write a small state file — body is the raw JSON value |
| GET | `/stats?path=files` | Storage usage of a `lumaris/` folder → `{ totalBytes, items }` |

All user files live under `lumaris/files/`; internal state under
`lumaris/pomodoro/`, `lumaris/websites/`, etc.

## Credentials

`MEGA_EMAIL` and `MEGA_PASSWORD` must be configured **on this worker**:

```bash
wrangler secret put MEGA_EMAIL
wrangler secret put MEGA_PASSWORD
```

Plain secrets/vars and Secrets Store bindings (`{ get() }`) are both
supported by the credential resolver.

## Development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in MEGA credentials
npm run dev                      # local wrangler dev
```

## Deployment

Deployed by `update-client-account` like every other worker — add
`"mega-client-worker": "<repo-url>"` to its `CONFIGURATION` variable and
make sure `main-client-worker` declares the service binding:

```jsonc
"services": [{ "binding": "MEGA_CLIENT", "service": "mega-client-worker" }]
```

Deploy **this worker before** `main-client-worker`.
