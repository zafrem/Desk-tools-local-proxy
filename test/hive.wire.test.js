"use strict";
// Drives the Hive service against a fake HiveServer2 speaking real Thrift, so the
// driver's own wire decoding is exercised (columnar rows, null bitmaps, `table.column` names).
const test = require("node:test");
const assert = require("node:assert");
const thrift = require("thrift");
const Int64 = require("node-int64");
const hive = require("hive-driver");
const hiveService = require("../src/services/hive");
const { TCLIService, TCLIService_types: T } = hive.thrift;
const ok = new T.TStatus({ statusCode: T.TStatusCode.SUCCESS_STATUS });
const h = (guid) => ({ guid: Buffer.alloc(16, guid), secret: Buffer.alloc(16, guid) });
const prim = (type) => new T.TTypeDesc({ types: [new T.TTypeEntry({ primitiveEntry: new T.TPrimitiveTypeEntry({ type }) })] });
const handlers = {
  OpenSession: (req, cb) => cb(null, new T.TOpenSessionResp({ status: ok, serverProtocolVersion: T.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10, sessionHandle: new T.TSessionHandle({ sessionId: new T.THandleIdentifier(h(1)) }) })),
  ExecuteStatement: (req, cb) => { cb(null, new T.TExecuteStatementResp({ status: ok, operationHandle: new T.TOperationHandle({ operationId: new T.THandleIdentifier(h(2)), operationType: 0, hasResultSet: true }) })); },
  GetOperationStatus: (req, cb) => cb(null, new T.TGetOperationStatusResp({ status: ok, operationState: T.TOperationState.FINISHED_STATE })),
  GetResultSetMetadata: (req, cb) => cb(null, new T.TGetResultSetMetadataResp({ status: ok, schema: new T.TTableSchema({ columns: [
    new T.TColumnDesc({ columnName: "t.id", typeDesc: prim(T.TTypeId.BIGINT_TYPE), position: 1 }),
    new T.TColumnDesc({ columnName: "t.name", typeDesc: prim(T.TTypeId.STRING_TYPE), position: 2 }),
    new T.TColumnDesc({ columnName: "t.score", typeDesc: prim(T.TTypeId.DOUBLE_TYPE), position: 3 }),
    new T.TColumnDesc({ columnName: "t.price", typeDesc: prim(T.TTypeId.DECIMAL_TYPE), position: 4 }),
    new T.TColumnDesc({ columnName: "t.ts", typeDesc: prim(T.TTypeId.TIMESTAMP_TYPE), position: 5 }),
    new T.TColumnDesc({ columnName: "t.ok", typeDesc: prim(T.TTypeId.BOOLEAN_TYPE), position: 6 }),
  ] }) })),
  FetchResults: (req, cb) => {
    let rows;
    if (req.orientation === T.TFetchOrientation.FETCH_FIRST || !handlers._done) { handlers._done = true; rows = true; }
    const col = rows ? {
      columns: [
        new T.TColumn({ i64Val: new T.TI64Column({ values: [new (Int64)(5), new (Int64)(6)], nulls: Buffer.from([0]) }) }),
        new T.TColumn({ stringVal: new T.TStringColumn({ values: ["alice", ""], nulls: Buffer.from([2]) }) }),
        new T.TColumn({ doubleVal: new T.TDoubleColumn({ values: [1.5, 2.5], nulls: Buffer.from([0]) }) }),
        new T.TColumn({ stringVal: new T.TStringColumn({ values: ["10.50", "0"], nulls: Buffer.from([0]) }) }),
        new T.TColumn({ stringVal: new T.TStringColumn({ values: ["2024-01-02 03:04:05", ""], nulls: Buffer.from([2]) }) }),
        new T.TColumn({ boolVal: new T.TBoolColumn({ values: [true, false], nulls: Buffer.from([0]) }) }),
      ] } : { columns: [] };
    cb(null, new T.TFetchResultsResp({ status: ok, hasMoreRows: false, results: new T.TRowSet({ startRowOffset: 0, rows: [], ...col }) }));
  },
  CloseOperation: (req, cb) => cb(null, new T.TCloseOperationResp({ status: ok })),
  CloseSession: (req, cb) => cb(null, new T.TCloseSessionResp({ status: ok })),
  CancelOperation: (req, cb) => cb(null, new T.TCancelOperationResp({ status: ok })),
};

test("hive: values survive the real Thrift round trip (qualified names, NULLs, types)", async () => {
  const server = thrift.createServer(TCLIService, handlers, { transport: thrift.TBufferedTransport, protocol: thrift.TBinaryProtocol });
  const port = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
  const session = await hiveService.connect({ host: "127.0.0.1", port, username: "me" });
  try {
    const out = await session.query("SELECT * FROM t", { timeoutMs: 5000 });
    assert.deepStrictEqual(out.columns.map((c) => [c.name, c.type]), [
      ["id", "bigint"], ["name", "string"], ["score", "double"], ["price", "decimal"], ["ts", "timestamp"], ["ok", "boolean"],
    ]);
    assert.deepStrictEqual(out.rows, [
      [5, "alice", 1.5, 10.5, "2024-01-02 03:04:05", true],
      [6, null, 2.5, 0, null, false],
    ]);
  } finally {
    await session.close();
    server.close();
  }
});
