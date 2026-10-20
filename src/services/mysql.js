"use strict";

const mysql = require("mysql2/promise");
const { Types } = require("mysql2");
const { ProxyError } = require("../errors");

exports.kind = "query";
exports.defaultPort = 3306;

// mysql2 exports name -> code; we need code -> name for display.
const TYPE_NAMES = Object.fromEntries(Object.entries(Types).map(([name, code]) => [code, name]));

function connectionOptions(cfg) {
  return {
    host: cfg.host,
    port: cfg.port || exports.defaultPort,
    user: cfg.username,
    password: cfg.password || undefined,
    database: cfg.database || undefined,
    ssl: cfg.tls ? {} : undefined,
    connectTimeout: 20000,
    // BIGINT/DECIMAL arrive as strings, dates as UTC Date objects (-> ISO).
    supportBigNumbers: true,
    bigNumberStrings: true,
    timezone: "Z",
  };
}

exports.connect = async (cfg) => {
  const opts = connectionOptions(cfg);
  const conn = await mysql.createConnection(opts);
  await conn.query("SET SESSION TRANSACTION READ ONLY");
  const [[{ v }]] = await conn.query("SELECT VERSION() AS v");
  const threadId = conn.threadId;
  let running = false;

  return {
    serverVersion: v,

    async query(sql, { timeoutMs }) {
      running = true;
      try {
        const [rows, fields] = await conn.query({ sql, rowsAsArray: true, timeout: timeoutMs });
        if (!Array.isArray(fields)) {
          throw new ProxyError("query_failed", "Statement did not return a result set");
        }
        return {
          columns: fields.map((f) => ({ name: f.name, type: TYPE_NAMES[f.columnType] || String(f.columnType) })),
          rows,
        };
      } finally {
        running = false;
      }
    },

    async cancel() {
      if (!running) return;
      // KILL QUERY must come from a second connection.
      const killer = await mysql.createConnection(opts);
      try {
        await killer.query("KILL QUERY ?", [threadId]);
      } finally {
        await killer.end().catch(() => {});
      }
    },

    close: () => conn.end().catch(() => {}),
  };
};
