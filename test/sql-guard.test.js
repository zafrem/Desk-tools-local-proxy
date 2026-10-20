"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { checkReadOnly } = require("../src/sql-guard");
const { normalize } = require("../src/values");

const ok = (sql) => assert.strictEqual(checkReadOnly(sql).ok, true, sql);
const bad = (sql) => assert.strictEqual(checkReadOnly(sql).ok, false, sql);

test("accepts read-only statements", () => {
  ok("SELECT 1");
  ok("  select * from t;  ");
  ok("WITH a AS (SELECT 1) SELECT * FROM a");
  ok("(SELECT 1) UNION (SELECT 2)");
  ok("SHOW TABLES");
  ok("describe t");
  ok("EXPLAIN SELECT 1");
  ok("-- hi\nSELECT 1 /* x */");
});

test("rejects writes and DDL", () => {
  bad("INSERT INTO t VALUES (1)");
  bad("update t set a=1");
  bad("DROP TABLE t");
  bad("DELETE FROM t");
  bad("CALL p()");
  bad("");
  bad("   ");
  bad(";");
});

test("rejects multiple statements", () => {
  bad("SELECT 1; DROP TABLE t");
  bad("SELECT 1; SELECT 2");
  bad("SELECT 1;;");
});

test("semicolons and keywords inside strings/comments are fine", () => {
  ok("SELECT 'a;b' FROM t");
  ok('SELECT "a;b" FROM t');
  ok("SELECT 'it''s; fine'");
  ok("SELECT 1 -- ; DROP TABLE t");
  ok("SELECT 1 /* ; DROP */");
});

test("a comment cannot hide the first keyword", () => {
  bad("/* SELECT */ DROP TABLE t");
  bad("-- SELECT\nDROP TABLE t");
});

test("unterminated constructs are rejected", () => {
  bad("SELECT 'abc");
  bad("SELECT 1 /* abc");
});

test("backslash-escaped quote cannot smuggle a second statement", () => {
  // MySQL reads this as one string 'a\'; DROP TABLE t; --' (no statement break),
  // Postgres (standard strings) reads it as 'a\' then a real statement.
  bad("SELECT 'a\\'; DROP TABLE t; --'");
});

test("normalize encodes values per PROTOCOL.md", () => {
  assert.strictEqual(normalize(null), null);
  assert.strictEqual(normalize(undefined), null);
  assert.strictEqual(normalize(5n), "5");
  assert.strictEqual(normalize(12), 12);
  assert.strictEqual(normalize(2 ** 60), String(2 ** 60));
  assert.strictEqual(normalize(NaN), "NaN");
  assert.strictEqual(normalize(new Date(0)), "1970-01-01T00:00:00.000Z");
  assert.deepStrictEqual(normalize(Buffer.from("hi")), { $base64: "aGk=" });
  assert.deepStrictEqual(normalize([1n, { a: Buffer.from("x") }]), ["1", { a: { $base64: "eA==" } }]);
});
