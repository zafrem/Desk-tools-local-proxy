"use strict";

// Runs queries and remote commands without a browser or WebSocket. Used by the
// CLI (cli.js); shares the drivers, the read-only guard and the value encoding
// with the WebSocket server in index.js.

const fs = require("fs");
const path = require("path");
const { ProxyError, classifyConnectError } = require("./errors");
const { checkReadOnly } = require("./sql-guard");
const { normalize } = require("./values");
const { formatResult } = require("./export");

const DEFAULT_MAX_ROWS = 100000;
const HARD_MAX_ROWS = 1000000;
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_TIMEOUT_MS = 3600000;

const QUERY_SERVICES = ["mysql", "postgres", "hive", "trino"];
const MODULES = {
  ssh: () => require("./services/ssh"),
  mysql: () => require("./services/mysql"),
  postgres: () => require("./services/postgres"),
  hive: () => require("./services/hive"),
  trino: () => require("./services/trino"),
};
const CLI_SERVICES = Object.keys(MODULES);

function clamp(value, fallback, max) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

/** Opens a connection. For ssh the session only carries the config (each exec connects on its own). */
async function open(conn) {
  if (!CLI_SERVICES.includes(conn.service)) {
    throw new ProxyError("unsupported", `Service "${conn.service}" is not available from the CLI (use ${CLI_SERVICES.join(", ")})`);
  }
  if (!conn.host) throw new ProxyError("bad_message", "host is required");
  if (!conn.username && conn.service !== "hive" && conn.service !== "trino") throw new ProxyError("bad_message", "username is required");
  const mod = MODULES[conn.service]();
  const cfg = { ...conn, port: conn.port || mod.defaultPort };
  if (conn.service === "ssh") return { service: "ssh", mod, cfg, close: async () => {} };
  try {
    const session = await mod.connect(cfg);
    return { service: conn.service, session, serverVersion: session.serverVersion, close: () => session.close() };
  } catch (err) {
    throw classifyConnectError(err);
  }
}

async function runQuery(handle, sql, opts = {}) {
  if (!QUERY_SERVICES.includes(handle.service)) throw new ProxyError("unsupported", `${handle.service} does not run SQL; use "exec"`);
  const check = checkReadOnly(sql);
  if (!check.ok) throw new ProxyError("query_rejected", check.reason);
  const maxRows = clamp(opts.maxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS);
  const timeoutMs = clamp(opts.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    Promise.resolve(handle.session.cancel()).catch(() => {});
  }, timeoutMs);
  const started = Date.now();
  try {
    const out = await handle.session.query(check.sql, { maxRows, timeoutMs });
    const truncated = out.rows.length > maxRows;
    const rows = (truncated ? out.rows.slice(0, maxRows) : out.rows).map((r) => r.map(normalize));
    return { columns: out.columns, rows, rowCount: rows.length, truncated, elapsedMs: Date.now() - started };
  } catch (err) {
    if (timedOut) throw new ProxyError("timeout", `Query exceeded ${timeoutMs} ms`);
    if (err instanceof ProxyError) throw err;
    throw new ProxyError("query_failed", (err && err.message) || "Query failed");
  } finally {
    clearTimeout(timer);
  }
}

async function runExec(handle, command, opts = {}) {
  if (handle.service !== "ssh") throw new ProxyError("unsupported", `"exec" runs remote commands and needs the ssh service`);
  if (!command || typeof command !== "string") throw new ProxyError("bad_message", "command is required");
  const timeoutMs = clamp(opts.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const started = Date.now();
  try {
    const r = await handle.mod.exec(handle.cfg, command, { timeoutMs });
    return { ...r, elapsedMs: Date.now() - started };
  } catch (err) {
    throw classifyConnectError(err);
  }
}

/** Serialises a step result: query results by format, exec results as text or json. */
function render(result, format) {
  if (result.columns) return formatResult(result, format || "csv");
  if (!format || format === "text") return result.stdout;
  if (format === "json") {
    const { stdout, stderr, exitCode, truncated } = result;
    return JSON.stringify({ stdout, stderr, exitCode, truncated }, null, 2) + "\n";
  }
  throw new Error(`Format "${format}" is not valid for exec (use text or json)`);
}

/** Writes export data to `file` (stdout when omitted). Refuses to overwrite unless asked. */
function writeOutput(data, file, { overwrite = false, stdout = process.stdout } = {}) {
  if (!file || file === "-") {
    stdout.write(data);
    return null;
  }
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    // Exported data may be sensitive: owner-only permissions.
    fs.writeFileSync(abs, data, { flag: overwrite ? "w" : "wx", mode: 0o600 });
  } catch (err) {
    if (err.code === "EEXIST") throw new ProxyError("bad_message", `${abs} already exists (use --overwrite)`);
    throw err;
  }
  return abs;
}

module.exports = { open, runQuery, runExec, render, writeOutput, CLI_SERVICES, QUERY_SERVICES };
