"use strict";

const hive = require("hive-driver");
const { ProxyError } = require("../errors");

exports.kind = "query";
exports.defaultPort = 10000;

const { TCLIService, TCLIService_types } = hive.thrift;
const TYPE_NAMES = Object.fromEntries(
  Object.entries(TCLIService_types.TTypeId).map(([name, id]) => [id, name.replace(/_TYPE$/, "").toLowerCase()])
);

function authentication(cfg) {
  switch (cfg.auth || "none") {
    case "none":
      return new hive.auth.NoSaslAuthentication();
    case "ldap":
      return new hive.auth.PlainTcpAuthentication({
        username: cfg.username,
        password: cfg.password || "x", // HiveServer2 requires a non-empty password field
      });
    case "kerberos":
      throw new ProxyError("unsupported", "Kerberos is not supported by this proxy build");
    default:
      throw new ProxyError("bad_message", `Unknown auth mode: ${cfg.auth}`);
  }
}

function typeName(col) {
  const entry = col.typeDesc && col.typeDesc.types && col.typeDesc.types[0];
  const id = entry && entry.primitiveEntry && entry.primitiveEntry.type;
  return TYPE_NAMES[id] || "unknown";
}

/** Hive reports columns as `table.column`; show just the column. */
const displayName = (columnName) => String(columnName || "").split(".").pop();

/**
 * Turns the driver's per-column data into rows of values. The driver's own
 * object form is keyed by name, which loses duplicate names and mismatches
 * the schema's qualified names, so we read the columns by position instead.
 */
function rowsFromResult(result) {
  const descriptors = result.getSchemaColumns();
  const base = Math.max(Math.min(...descriptors.map((d) => d.position)), 0);
  const rows = [];
  for (const rowSet of result.data || []) {
    const cols = rowSet.columns || [];
    const perColumn = descriptors.map((d) => result.getSchemaValues(d, cols[d.position - base] || {}));
    const count = Math.max(0, ...perColumn.map((v) => v.length));
    for (let i = 0; i < count; i++) rows.push(perColumn.map((v) => (v[i] === undefined ? null : v[i])));
  }
  return rows;
}

/** DESK_TOOLS_HIVE_DEBUG=1: print the structure (never the values) of what the server sent. */
function debugShape(op, result, rows) {
  const shape = (op.getData() || []).map((rs) => ({
    rows: (rs.rows || []).length,
    columns: (rs.columns || []).map((c) => {
      const kind = Object.keys(c).find((k) => c[k] && c[k].values);
      const v = kind && c[kind];
      return v ? { kind, values: v.values.length, nullsBytes: v.nulls ? v.nulls.length : null, nulls: v.nulls ? [...v.nulls].slice(0, 8) : null } : { kind: "none" };
    }),
  }));
  console.error("[hive-debug] schema:", JSON.stringify(result.getSchemaColumns().map((c) => ({ name: c.columnName, position: c.position }))));
  console.error("[hive-debug] rowsets:", JSON.stringify(shape));
  console.error(`[hive-debug] produced ${rows.length} row(s)`);
}

exports.rowsFromResult = rowsFromResult;
exports.displayName = displayName;

exports.connect = async (cfg) => {
  const client = new hive.HiveClient(TCLIService, TCLIService_types);
  const utils = new hive.HiveUtils(TCLIService_types);
  await client.connect(
    { host: cfg.host, port: cfg.port || exports.defaultPort },
    new hive.connections.TcpConnection(),
    authentication(cfg)
  );
  const session = await client.openSession({
    client_protocol: TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10,
    username: cfg.username || undefined,
  });
  if (cfg.database) {
    const op = await session.executeStatement(`USE \`${String(cfg.database).replace(/`/g, "``")}\``);
    await utils.waitUntilReady(op, false, () => {});
    await op.close();
  }

  let current = null;

  return {
    serverVersion: undefined,

    async query(sql, { timeoutMs }) {
      const op = await session.executeStatement(sql, { runAsync: true, queryTimeout: Math.ceil(timeoutMs / 1000) });
      current = op;
      try {
        await utils.waitUntilReady(op, false, () => {});
        await utils.fetchAll(op);
        const schema = op.getSchema();
        const result = utils.getResult(op);
        const columns = result.getSchemaColumns().map((c) => ({ name: displayName(c.columnName), type: typeName(c) }));
        const rows = rowsFromResult(result);
        if (process.env.DESK_TOOLS_HIVE_DEBUG) debugShape(op, result, rows);
        return { columns, rows };
      } finally {
        current = null;
        await op.close().catch(() => {});
      }
    },

    async cancel() {
      if (current) await current.cancel();
    },

    async close() {
      await session.close().catch(() => {});
      await client.close().catch(() => {});
    },
  };
};
