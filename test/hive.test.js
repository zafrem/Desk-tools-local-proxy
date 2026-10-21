"use strict";
const test = require("node:test");
const assert = require("node:assert");
const hive = require("hive-driver");
const { rowsFromResult, displayName } = require("../src/services/hive");

const T = hive.thrift.TCLIService_types;
const col = (name, position, type) => ({ columnName: name, position, typeDesc: { types: [{ primitiveEntry: { type } }] } });

test("hive: qualified column names still yield values, duplicates keep their own data", () => {
  const JsonResult = require("hive-driver/dist/result/JsonResult").default;
  const result = new JsonResult(T);
  result.schema = { columns: [col("t.id", 0, T.TTypeId.INT_TYPE), col("t.name", 1, T.TTypeId.STRING_TYPE), col("u.id", 2, T.TTypeId.INT_TYPE)] };
  result.data = [
    { columns: [{ i32Val: { values: [1, 2], nulls: Buffer.from([0]) } }, { stringVal: { values: ["a", ""], nulls: Buffer.from([2]) } }, { i32Val: { values: [10, 20], nulls: Buffer.from([0]) } }] },
  ];
  assert.deepStrictEqual(rowsFromResult(result), [[1, "a", 10], [2, null, 20]]);
  assert.strictEqual(displayName("t.id"), "id");
  assert.strictEqual(displayName("plain"), "plain");
});
