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
        const columns = ((schema && schema.columns) || []).map((c) => ({
          name: c.columnName,
          type: typeName(c),
        }));
        const objects = utils.getResult(op).getValue();
        // The driver returns one object per row keyed by column name.
        const rows = objects.map((o) => columns.map((c) => o[c.name]));
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
