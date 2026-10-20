"use strict";

const { Client } = require("pg");
const { builtins } = require("pg-types");

exports.kind = "query";
exports.defaultPort = 5432;

const TYPE_NAMES = Object.fromEntries(Object.entries(builtins).map(([name, oid]) => [oid, name.toLowerCase()]));

function clientConfig(cfg) {
  return {
    host: cfg.host,
    port: cfg.port || exports.defaultPort,
    user: cfg.username,
    password: cfg.password || undefined,
    database: cfg.database || undefined,
    ssl: cfg.tls ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: 20000,
  };
}

exports.connect = async (cfg) => {
  const config = clientConfig(cfg);
  const client = new Client(config);
  await client.connect();
  // Keep a dead server from becoming an unhandled 'error' event later.
  client.on("error", () => {});
  await client.query("SET default_transaction_read_only = on");
  const pid = client.processID;
  const version = (await client.query("SHOW server_version")).rows[0].server_version;
  let running = false;

  return {
    serverVersion: version,

    async query(sql, { timeoutMs }) {
      running = true;
      try {
        await client.query(`SET statement_timeout = ${Math.floor(timeoutMs)}`);
        const res = await client.query({ text: sql, rowMode: "array" });
        return {
          columns: (res.fields || []).map((f) => ({
            name: f.name,
            type: TYPE_NAMES[f.dataTypeID] || String(f.dataTypeID),
          })),
          rows: res.rows,
        };
      } finally {
        running = false;
      }
    },

    async cancel() {
      if (!running) return;
      const killer = new Client(config);
      await killer.connect();
      try {
        await killer.query("SELECT pg_cancel_backend($1)", [pid]);
      } finally {
        await killer.end().catch(() => {});
      }
    },

    close: () => client.end().catch(() => {}),
  };
};
