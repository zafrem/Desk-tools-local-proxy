# desk-tools-local-proxy

A tiny **local** WebSocket-to-SSH bridge for the [Desk-tools](https://zafrem.github.io/Desk-tools/) web terminal.

Browsers can't open raw TCP sockets, so a web page can never talk to an SSH
server directly. This program runs on **your** machine, accepts a WebSocket
from the Desk-tools page, and relays it to a real SSH connection. Your
credentials and traffic never leave your computer.

```
Browser (xterm.js)  --WebSocket-->  local-proxy (localhost:8722)  --SSH-->  your server
```

## Install and run

This package is not published to npm and no prebuilt binaries are provided.
Clone it and run it from source (Node.js 18+ and git required):

```bash
git clone https://github.com/zafrem/Desk-tools-local-proxy.git
cd Desk-tools-local-proxy
npm install
npm start
```

Then open any console under **Consoles** in Desk-tools — it detects the proxy
automatically. Use **Settings → Proxy → Test connection** to verify the link.

## Automation (no browser needed)

`cli.js` reuses the same drivers and read-only guard to run queries and remote
commands from a terminal, a cron job or CI, and export the results. No proxy
server has to be running.

```bash
export DESK_TOOLS_PASSWORD='…'            # secrets come from the environment, never from arguments

# One query -> CSV file (also json, ndjson, table; omit --out for stdout)
npm run cli -- query -s postgres --host db.internal -u report -d shop \
  --sql "SELECT * FROM orders WHERE day = current_date" --format csv --out orders.csv

# One remote command over SSH (key auth: --key-file, DESK_TOOLS_PASSPHRASE if protected)
npm run cli -- exec -s ssh --host web1 -u deploy --key-file ~/.ssh/id_ed25519 --command "df -h" --out df.txt

# A script: several steps on one connection
npm run cli -- run nightly.json
```

`nightly.json`:

```json
{
  "connection": { "service": "postgres", "host": "db.internal", "username": "report", "database": "shop",
                  "passwordEnv": "SHOP_DB_PASSWORD" },
  "steps": [
    { "name": "orders", "sql": "SELECT * FROM orders", "maxRows": 500000,
      "export": { "format": "csv", "file": "out/orders.csv" } },
    { "name": "customers", "sqlFile": "queries/customers.sql",
      "export": { "format": "ndjson", "file": "out/customers.ndjson" }, "continueOnError": true }
  ]
}
```

- Services: `query` works with `mysql`, `postgres`, `hive`, `trino`; `exec` works with `ssh` (one command, no pty). Telnet is interactive-only.
- Step fields: one of `sql` / `sqlFile` / `exec`, plus `name`, `maxRows`, `timeoutMs`, `export {format, file, overwrite}`, `continueOnError`. A step with no `export.file` prints to stdout.
- Secrets can't appear in job files or flags: use `DESK_TOOLS_PASSWORD` (or `passwordEnv` / `--password-env`), `keyFile`, `DESK_TOOLS_PASSPHRASE`, or `--ask-password` for a prompt.
- Export files are created owner-only (`0600`) and are not overwritten unless you pass `--overwrite`.
- Row limit defaults to 100,000 (max 1,000,000); results are held in memory, so very large exports should be split with `LIMIT`/`WHERE`.
- Same restriction as the browser: one read-only `SELECT`/`WITH`/`SHOW`/`DESCRIBE`/`EXPLAIN` per query. The filter is a convenience, not a security boundary; use a read-only database account for anything sensitive.
- Exit codes: `0` ok · `1` a step failed · `2` bad usage · `3` could not connect. Data goes to stdout, progress/errors to stderr.
- A command that exits non-zero still has its output exported, then the step fails.

## Configuration

| Env var                          | Default | Description                          |
| -------------------------------- | ------- | ------------------------------------ |
| `DESK_TOOLS_LOCAL_PROXY_PORT`      | `8722`  | Local port the proxy listens on.     |

The proxy binds to `127.0.0.1` only and rejects WebSocket upgrades whose
`Origin` is not the Desk-tools site (or `localhost:3000` for development).

## Standalone binaries (optional, not needed to run)

The proxy runs directly with `npm start`. If you want a single executable you can
build one yourself with a tool of your choice, e.g. `npx @yao-pkg/pkg index.js`
(needs a recent Node.js and OS). It is deliberately not a dependency, so
`npm install` stays light.

## Security notes

- Bound to loopback (`127.0.0.1`) — never exposed to your network.
- Validates the WebSocket `Origin` header so other sites can't drive it.
- Credentials are passed per-session from the browser and are never written to
  disk by the proxy.
