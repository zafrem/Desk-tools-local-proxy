"use strict";

const { Client } = require("pg");
const { builtins } = require("pg-types");
const { ProxyError } = require("../errors");

exports.kind = "query";
exports.defaultPort = 5432;

const TYPE_NAMES = Object.fromEntries(Object.entries(builtins).map(([name, oid]) => [oid, name.toLowerCase()]));

/** Names for type OIDs pg-types doesn't know (arrays, enums, extensions). */
async function resolveTypeNames(client, oids, cache) {
  const unknown = [...new Set(oids)].filter((o) => !TYPE_NAMES[o] && !cache.has(o));
  if (!unknown.length) return;
  const res = await client.query(
    "SELECT t.oid::int AS oid, format_type(t.oid, NULL) AS name FROM pg_type t WHERE t.oid = ANY($1::oid[])",
    [unknown]
  );
  for (const row of res.rows) cache.set(row.oid, row.name);
}

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
  const extraTypes = new Map();

  return {
    serverVersion: version,

    async query(sql, { timeoutMs }) {
      running = true;
      try {
        await client.query(`SET statement_timeout = ${Math.floor(timeoutMs)}`);
        let res;
        try {
          res = await client.query({ text: sql, rowMode: "array" });
        } catch (err) {
          // Our own timer usually fires first; this covers the other order.
          if (err.code === "57014" && /statement timeout/.test(err.message)) {
            throw new ProxyError("timeout", `Query exceeded ${timeoutMs} ms`);
          }
          throw err;
        }
        const fields = res.fields || [];
        await resolveTypeNames(client, fields.map((f) => f.dataTypeID), extraTypes);
        return {
          columns: fields.map((f) => ({
            name: f.name,
            type: TYPE_NAMES[f.dataTypeID] || extraTypes.get(f.dataTypeID) || String(f.dataTypeID),
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
