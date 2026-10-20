# Desk-tools local-proxy protocol

Version: **2** (draft). Version 1 is the SSH-only protocol documented in the
header of `index.js`; v2 is a strict superset of it.

The browser talks to the proxy over a single WebSocket
(`ws://127.0.0.1:8722`). **One WebSocket = one session = one backend
connection.** To open several sessions, open several WebSockets.

Supported services:

| `service`    | Kind     | Default port | Notes                               |
| ------------ | -------- | ------------ | ----------------------------------- |
| `ssh`        | terminal | 22           | Password or private key             |
| `telnet`     | terminal | 23           | Plaintext, no auth handled by proxy |
| `mysql`      | query    | 3306         | `SELECT` only                       |
| `postgres`   | query    | 5432         | `SELECT` only                       |
| `hive`       | query    | 10000        | HiveServer2, `SELECT` only          |
| `trino`      | query    | 8080         | HTTP REST, `SELECT` only            |

## 1. Transport and framing

- **TEXT frames** carry one JSON object each (control messages). Every object
  has a `type` field.
- **BINARY frames** carry raw terminal bytes and are valid only for terminal
  services (`ssh`, `telnet`) once the session is `ready`. They are never used
  for query services.
- Unknown `type` values are answered with `error` (`code: "bad_message"`) and
  ignored; they do not close the session.
- Unknown fields are ignored (forward compatibility).

## 2. Discovery: `GET /health`

```json
{ "service": "desk-tools-local-proxy", "version": "0.2.0",
  "protocol": 2, "services": ["ssh","telnet","mysql","postgres","hive","trino"],
  "ok": true }
```

`protocol` and `services` are new in v2. A v1 proxy omits them; the browser
must treat a missing `protocol` as `1` and `services` as `["ssh"]`.

## 3. Session lifecycle

```
browser                                  proxy
  |---- connect ------------------------->|
  |<--- status: connecting ---------------|
  |<--- status: ready (+ info) -----------|   or  error  then close
  |  ... terminal bytes / query-result ...|
  |---- close (optional) ---------------->|
  |<--- status: closed -------------------|
```

Rules:

- The first message must be `connect`. Anything else gets
  `error` (`code: "not_connected"`).
- `connect` with an unknown `service` gets `error` (`code: "unsupported"`);
  a missing `host` (or `username`, except for `telnet`) gets `bad_message`.
  Neither closes the socket.
- A second `connect` on the same socket gets `error`
  (`code: "already_connected"`) and is ignored.
- If the backend fails to connect or authenticate, the proxy sends `error`
  and closes the WebSocket. No `ready` is ever sent.
- Terminal output produced while the proxy is still finishing the connect is
  held back: the browser always receives `status: ready` before the first
  BINARY frame.
- Closing the WebSocket closes the backend connection. Credentials live only
  in memory for the life of the session.

## 4. Browser → proxy messages

### 4.1 `connect`

Common fields:

| Field      | Type    | Req | Description                                      |
| ---------- | ------- | --- | ------------------------------------------------ |
| `type`     | string  | yes | `"connect"`                                      |
| `service`  | string  | no  | One of the services above. Default `"ssh"` (v1 compatible). |
| `host`     | string  | yes | Target host                                      |
| `port`     | number  | no  | Default per table above                          |
| `username` | string  | yes* | *Optional for `telnet`                          |

Service-specific fields:

| Service    | Extra fields |
| ---------- | ------------ |
| `ssh`      | `password?`, `privateKey?`, `passphrase?`, `cols?`, `rows?` |
| `telnet`   | `cols?`, `rows?`. If `username`/`password` are given the proxy does not auto-type them; the user types at the remote prompt. |
| `mysql`    | `password?`, `database?`, `tls?` (bool) |
| `postgres` | `password?`, `database?`, `tls?` (bool) |
| `hive`     | `password?`, `database?`, `auth?` (`"none"` or `"ldap"`, default `"none"`; Kerberos is not supported and returns `unsupported`) |
| `trino`    | `password?`, `catalog?`, `schema?`, `tls?` (bool; password auth requires it) |

Example:

```json
{ "type": "connect", "service": "postgres", "host": "db.internal",
  "username": "report", "password": "…", "database": "sales", "tls": true }
```

### 4.2 `resize` (terminal services)

```json
{ "type": "resize", "cols": 120, "rows": 40 }
```

Ignored with `error` (`code: "unsupported"`) on query services.

### 4.3 `query` (query services)

```json
{ "type": "query", "id": "q1", "sql": "SELECT * FROM orders",
  "maxRows": 1000, "timeoutMs": 30000 }
```

| Field       | Type   | Req | Description                                           |
| ----------- | ------ | --- | ----------------------------------------------------- |
| `id`        | string | yes | Client-chosen; echoed in every reply to this query. Unique per session. |
| `sql`       | string | yes | A single read-only statement (see §6)                 |
| `maxRows`   | number | no  | Default 1000, hard cap 10000. Extra rows are dropped and `truncated: true` is set. |
| `timeoutMs` | number | no  | Default 30000, cap 300000                             |

One query runs at a time per session. A `query` sent while another is
running gets `error` (`code: "busy"`, with that `id`).

### 4.4 `cancel` (query services)

```json
{ "type": "cancel", "id": "q1" }
```

Best-effort cancellation of the running query. The query then finishes with
`error` (`code: "cancelled"`, `id: "q1"`). Unknown or finished `id` is a no-op.

### 4.5 `close`

```json
{ "type": "close" }
```

Ends the session cleanly. The proxy replies `status: closed` and closes the
WebSocket. (Closing the WebSocket has the same effect.)

### 4.6 BINARY frame (terminal services)

Raw keystrokes written to the remote stdin.

## 5. Proxy → browser messages

### 5.1 `status`

```json
{ "type": "status", "state": "connecting" | "ready" | "closed", "message": "…" }
```

On `ready`, v2 adds an `info` object:

```json
{ "type": "status", "state": "ready",
  "info": { "service": "postgres", "kind": "query", "serverVersion": "16.2" } }
```

`kind` is `"terminal"` or `"query"`; the browser uses it to pick the UI.
`serverVersion` is optional.

### 5.2 `result` (query services)

```json
{ "type": "result", "id": "q1",
  "columns": [ { "name": "id", "type": "int4" }, { "name": "note", "type": "text" } ],
  "rows": [ [1, "hello"], [2, null] ],
  "rowCount": 2, "truncated": false, "elapsedMs": 41 }
```

- `rows` are arrays in `columns` order, not objects (duplicate column names
  are legal in SQL).
- `type` is the backend's native type name, as a string, for display only.
- Value encoding in JSON: `null` → `null`; booleans and numbers as-is;
  integers outside ±2^53 (BIGINT, DECIMAL) as **strings**; dates, times and
  timestamps as ISO-8601 strings; binary as `{"$base64": "…"}`; arrays, maps
  and structs (Hive, Trino) as JSON arrays/objects.
- A result is sent as a single message. There is no streaming in v2.
- `maxRows` is applied by the proxy after the driver returns, so a huge
  unbounded `SELECT` is still fetched in full from MySQL, Postgres and Hive
  (Trino stops after `maxRows + 1`). Clients should add a `LIMIT`.
- Hive rows are rebuilt from per-row objects keyed by column name, so a result
  with duplicate column names loses all but one of them.

### 5.3 `error`

```json
{ "type": "error", "code": "query_failed", "message": "relation \"x\" does not exist", "id": "q1" }
```

`id` is present only when the error belongs to a query. `message` is
human-readable and comes from the backend where possible. Query errors do
**not** close the session; connection-level errors do.

Codes: `bad_message`, `not_connected`, `already_connected`, `unsupported`,
`connect_failed`, `auth_failed`, `host_unreachable`, `timeout`, `busy`,
`cancelled`, `query_rejected`, `query_failed`, `internal`.

v1 clients that only read `message` keep working; `code` is additive.

## 6. Read-only enforcement

The proxy, not the browser, enforces `SELECT`-only. The browser may check too,
but its check is only UX.

1. Strip comments and leading whitespace.
2. Reject if more than one statement is present (`;` outside string
   literals, other than a trailing one).
3. The statement is scanned twice, with and without backslash escapes in
   string literals (MySQL/Hive honour them, Postgres/Trino do not). If the two
   readings disagree about where statements end, it is rejected as ambiguous.
4. Accept only statements starting with `SELECT`, or `WITH … SELECT`
   (case-insensitive). `SHOW`, `DESCRIBE` and `EXPLAIN` are also accepted so
   a browser can offer schema browsing.
5. Reject with `query_rejected` otherwise.
6. Defence in depth, where the backend supports it:
   - MySQL: `SET SESSION TRANSACTION READ ONLY` after connect
   - Postgres: `SET default_transaction_read_only = on` after connect
   - Trino, Hive: none; they rely on the statement filter above.

   Steps 1–4 are a convenience filter, not a security boundary. The real
   boundary is the database account the user connects with, which should
   itself be read-only.

## 7. Security

Unchanged from v1 and applying to every service:

- Bind to `127.0.0.1` only.
- Reject WebSocket upgrades whose `Origin` is not allow-listed.
- Credentials are per-session, in memory, never logged or written to disk.
  Log lines must not contain `password`, `privateKey`, `passphrase`, or SQL
  text.
- Telnet is plaintext on the wire between the proxy and the target; the UI
  should warn.
- Host-key / TLS-certificate trust: v2 does not pin. A `tls: true`
  connection verifies the server certificate against the system store;
  failure is `connect_failed`. (Pinning / "trust once" is out of scope here.)

## 8. Connection test (browser ↔ proxy)

The Settings "test connection" checks only the link between the browser and
the proxy; it never contacts a target system. It runs three steps:

1. `GET /health` succeeds, `service` is `desk-tools-local-proxy`, and
   `protocol` (missing = 1) is one the browser knows. This also proves the
   browser's Origin passes CORS.
2. A WebSocket to the proxy opens (proves the Origin is allow-listed for
   upgrades; a foreign Origin is rejected with HTTP 403).
3. The browser sends `{"type":"nonsense"}`; the proxy must answer
   `error` / `bad_message` (proves messages round-trip in both directions),
   and then the browser sends `{"type":"close"}`.

Extra origins can be allowed when self-hosting the web app with
`DESK_TOOLS_ALLOWED_ORIGINS=https://my.host,https://other.host`.

## 9. Versioning

- The protocol number is in `/health.protocol`. Additive changes (new
  optional fields, new error codes, new services) do not bump it.
- A change that breaks existing messages bumps it, and the browser must
  refuse to talk to a proxy whose `protocol` it does not know.

## 10. Non-goals (v2)

- Writes (`INSERT`/`UPDATE`/DDL), transactions across queries, prepared
  statements / bind parameters.
- Streaming or paginated results, multiple concurrent queries per session.
- SFTP / port forwarding, SSH agent forwarding.
- Persisting connection profiles or secrets in the proxy.
