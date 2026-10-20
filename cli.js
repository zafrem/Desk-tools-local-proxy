#!/usr/bin/env node
"use strict";

/**
 * desk-tools-proxy — run queries and remote commands from a terminal or a
 * script, export the results, no browser needed. Same drivers and read-only
 * guard as the WebSocket proxy (index.js). See README.md ("Automation").
 *
 *   desk-tools-proxy query -s postgres --host H -u U -d DB --sql "SELECT 1" --format csv --out r.csv
 *   desk-tools-proxy exec  -s ssh --host H -u U --key-file ~/.ssh/id_ed25519 --command uptime
 *   desk-tools-proxy run   job.json
 *
 * Exit codes: 0 ok · 1 a step failed · 2 bad usage · 3 could not connect
 */

const fs = require("fs");
const { parseArgs } = require("util");
const { ProxyError } = require("./src/errors");
const { FORMATS } = require("./src/export");
const runner = require("./src/runner");

const USAGE = `Usage:
  desk-tools-proxy query [connection] (--sql "SELECT ..." | --sql-file q.sql) [--format csv|json|ndjson|table] [--out file]
  desk-tools-proxy exec  [connection] --command "uptime" [--format text|json] [--out file]
  desk-tools-proxy run   job.json [--overwrite]

Connection:
  -s, --service <ssh|mysql|postgres|hive|trino>   --host <h>  --port <n>  -u, --user <name>
  -d, --database <db>   --catalog <c>   --schema <s>   --tls   --key-file <path>
  Secrets are never taken from arguments. Set DESK_TOOLS_PASSWORD (or --password-env NAME),
  DESK_TOOLS_PASSPHRASE for a protected key, or pass --ask-password to be prompted.

Options:
  --max-rows <n>   default 100000, max 1000000      --timeout <ms>   default 60000
  --out <file>     write results to a file (owner-only); omit for stdout
  --overwrite      replace an existing --out file     -h, --help
Data goes to stdout, progress and errors to stderr. Queries are read-only (single SELECT/WITH/SHOW/DESCRIBE/EXPLAIN).
`;

const OPTIONS = {
  service: { type: "string", short: "s" },
  host: { type: "string" },
  port: { type: "string" },
  user: { type: "string", short: "u" },
  database: { type: "string", short: "d" },
  catalog: { type: "string" },
  schema: { type: "string" },
  tls: { type: "boolean" },
  "key-file": { type: "string" },
  "password-env": { type: "string" },
  "ask-password": { type: "boolean" },
  sql: { type: "string" },
  "sql-file": { type: "string" },
  command: { type: "string" },
  format: { type: "string", short: "f" },
  out: { type: "string", short: "o" },
  overwrite: { type: "boolean" },
  "max-rows": { type: "string" },
  timeout: { type: "string" },
  help: { type: "boolean", short: "h" },
};

const log = (msg) => process.stderr.write(msg + "\n");

class UsageError extends Error {}

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new UsageError("--ask-password needs an interactive terminal"));
    process.stderr.write(prompt);
    const stdin = process.stdin;
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          process.stderr.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") {
          stdin.setRawMode(false);
          process.stderr.write("\n");
          process.exit(130);
        }
        value = c === "\u007f" ? value.slice(0, -1) : value + c;
      }
    };
    stdin.on("data", onData);
  });
}

/** Builds the connect config, pulling secrets from the environment, a key file or a prompt. */
async function buildConnection(c, env = process.env) {
  if (c.password !== undefined || c.passphrase !== undefined || c.privateKey !== undefined) {
    throw new UsageError("Secrets can't be written in a command or job file. Use passwordEnv / passphraseEnv / keyFile.");
  }
  const conn = {
    service: c.service,
    host: c.host,
    port: c.port ? Number(c.port) : undefined,
    username: c.username,
    database: c.database,
    catalog: c.catalog,
    schema: c.schema,
    tls: c.tls || undefined,
    auth: c.auth,
  };
  if (!conn.service) throw new UsageError("--service is required");
  if (c.port && !Number.isInteger(conn.port)) throw new UsageError("--port must be a number");
  const passEnv = c.passwordEnv || "DESK_TOOLS_PASSWORD";
  if (env[passEnv]) conn.password = env[passEnv];
  else if (c.askPassword) conn.password = await askHidden(`Password for ${conn.username || ""}@${conn.host || ""}: `);
  if (c.keyFile) {
    conn.privateKey = fs.readFileSync(c.keyFile);
    const pp = env[c.passphraseEnv || "DESK_TOOLS_PASSPHRASE"];
    if (pp) conn.passphrase = pp;
  }
  return conn;
}

function connFromFlags(v) {
  return {
    service: v.service, host: v.host, port: v.port, username: v.user, database: v.database,
    catalog: v.catalog, schema: v.schema, tls: v.tls, keyFile: v["key-file"],
    passwordEnv: v["password-env"], askPassword: v["ask-password"],
  };
}

function stepOptions(v) {
  return { maxRows: v["max-rows"], timeoutMs: v.timeout };
}

/** Runs one step on an open handle; returns a one-line summary for stderr. */
async function runStep(handle, step, io) {
  let result;
  if (step.exec !== undefined) result = await runner.runExec(handle, step.exec, step);
  else result = await runner.runQuery(handle, step.sql, step);
  if (result.exitCode) {
    // Still export what the command printed, then fail the step.
    if (step.export) writeStep(result, step.export, io);
    throw new ProxyError("command_failed", `exit code ${result.exitCode}${result.stderr ? ": " + result.stderr.trim().split("\n").pop() : ""}`);
  }
  const where = step.export ? writeStep(result, step.export, io) : null;
  const detail = result.columns ? `${result.rowCount} row(s)${result.truncated ? " (truncated)" : ""}` : `exit ${result.exitCode}`;
  return `${detail} in ${result.elapsedMs} ms${where ? " -> " + where : ""}`;
}

function writeStep(result, exp, io) {
  const data = runner.render(result, exp.format);
  return runner.writeOutput(data, exp.file, { overwrite: exp.overwrite || io.overwrite });
}

async function withConnection(connConfig, work) {
  const conn = await buildConnection(connConfig);
  let handle;
  try {
    handle = await runner.open(conn);
  } catch (err) {
    log(`Connection failed (${err.code || "error"}): ${err.message}`);
    return 3;
  }
  try {
    return await work(handle);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function cmdSingle(kind, v) {
  const step = { ...stepOptions(v), export: { format: v.format, file: v.out, overwrite: v.overwrite } };
  if (kind === "query") {
    if (v.sql && v["sql-file"]) throw new UsageError("Use --sql or --sql-file, not both");
    step.sql = v.sql ?? (v["sql-file"] ? fs.readFileSync(v["sql-file"], "utf8") : undefined);
    if (!step.sql) throw new UsageError("query needs --sql or --sql-file");
    if (v.format && !FORMATS.includes(v.format)) throw new UsageError(`--format must be one of ${FORMATS.join(", ")}`);
  } else {
    step.exec = v.command;
    if (!step.exec) throw new UsageError("exec needs --command");
    if (v.format && !["text", "json"].includes(v.format)) throw new UsageError("--format must be text or json for exec");
  }
  return withConnection(connFromFlags(v), async (handle) => {
    try {
      log(await runStep(handle, step, { overwrite: v.overwrite }));
      return 0;
    } catch (err) {
      log(`Failed (${err.code || "error"}): ${err.message}`);
      return 1;
    }
  });
}

function loadJob(file) {
  let job;
  try {
    job = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new UsageError(`Can't read job file ${file}: ${err.message}`);
  }
  if (!job || typeof job.connection !== "object" || !Array.isArray(job.steps) || !job.steps.length) {
    throw new UsageError('A job file needs {"connection": {...}, "steps": [ ... ]}');
  }
  job.steps.forEach((s, i) => {
    const n = [s.sql, s.sqlFile, s.exec].filter((x) => x !== undefined).length;
    if (n !== 1) throw new UsageError(`steps[${i}]: give exactly one of sql, sqlFile, exec`);
    if (s.sqlFile) s.sql = fs.readFileSync(s.sqlFile, "utf8");
  });
  return job;
}

async function cmdRun(file, v) {
  const job = loadJob(file);
  return withConnection(job.connection, async (handle) => {
    let failed = 0;
    for (const [i, step] of job.steps.entries()) {
      const name = step.name || `step ${i + 1}`;
      try {
        log(`[${name}] ${await runStep(handle, step, { overwrite: v.overwrite })}`);
      } catch (err) {
        failed++;
        log(`[${name}] failed (${err.code || "error"}): ${err.message}`);
        if (!step.continueOnError) break;
      }
    }
    return failed ? 1 : 0;
  });
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(USAGE);
    return cmd ? 0 : 2;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const { values: v, positionals } = parsed;
  if (v.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (cmd === "query" || cmd === "exec") return cmdSingle(cmd, v);
  if (cmd === "run") {
    if (positionals.length !== 1) throw new UsageError("run needs a job file");
    return cmdRun(positionals[0], v);
  }
  throw new UsageError(`Unknown command "${cmd}"`);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      if (err instanceof UsageError) {
        log(`${err.message}\n\n${USAGE}`);
        process.exit(2);
      }
      log(`Error: ${err.message}`);
      process.exit(1);
    }
  );
}

module.exports = { main, buildConnection, loadJob };
