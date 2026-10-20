"use strict";
// Runs against a real PostgreSQL. Skipped unless DESK_TOOLS_TEST_PG is set:
//   DESK_TOOLS_TEST_PG=host:port:user:password:database npm test
// The database needs a table:  items(id bigint, name text, tags text[])  with >= 6 rows.
const test = require("node:test");
const assert = require("node:assert");
const WebSocket = require("ws");
const { createServer } = require("../index.js");

const cfg = process.env.DESK_TOOLS_TEST_PG;
const [host, port, username, password, database] = (cfg || "").split(":");
const skip = cfg ? false : "set DESK_TOOLS_TEST_PG=host:port:user:password:database to run";

let server, proxyPort;
test.before(async () => {
  if (skip) return;
  server = createServer();
  proxyPort = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
});
test.after(() => {
  if (server) {
    server.closeAll();
    server.close();
  }
});

function session() {
  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}`);
  const queue = [];
  const waiters = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    waiters.length ? waiters.shift()(m) : queue.push(m);
  });
  const next = () =>
    new Promise((res, rej) => {
      if (queue.length) return res(queue.shift());
      const t = setTimeout(() => rej(new Error("timed out")), 10000);
      waiters.push((v) => { clearTimeout(t); res(v); });
    });
  const opened = new Promise((r) => ws.on("open", r));
  const send = (o) => ws.send(JSON.stringify(o));
  return { ws, opened, next, send };
}

async function connect(overrides = {}) {
  const s = session();
  await s.opened;
  s.send({ type: "connect", service: "postgres", host, port: Number(port), username, password, database, ...overrides });
  await s.next(); // connecting
  return { s, first: await s.next() };
}

test("postgres: wrong password -> auth_failed", { skip }, async () => {
  const { s, first } = await connect({ password: "definitely-wrong" });
  assert.strictEqual(first.code, "auth_failed");
  s.ws.close();
});

test("postgres: types, truncation, guard, read-only, errors", { skip }, async () => {
  const { s, first } = await connect();
  assert.strictEqual(first.info.kind, "query");
  assert.ok(first.info.serverVersion);

  s.send({ type: "query", id: "1", sql: "SELECT id, name, tags FROM items ORDER BY id LIMIT 3" });
  let r = await s.next();
  assert.strictEqual(r.type, "result");
  assert.deepStrictEqual(r.columns.map((c) => c.type), ["int8", "text", "text[]"]); // array type is named
  assert.strictEqual(typeof r.rows[0][0], "string"); // bigint -> string

  s.send({ type: "query", id: "2", sql: "SELECT id FROM items", maxRows: 5 });
  r = await s.next();
  assert.deepStrictEqual([r.rowCount, r.truncated], [5, true]);

  s.send({ type: "query", id: "3", sql: "DELETE FROM items" });
  assert.strictEqual((await s.next()).code, "query_rejected");

  s.send({ type: "query", id: "4", sql: "SHOW default_transaction_read_only" });
  assert.deepStrictEqual((await s.next()).rows, [["on"]]);

  s.send({ type: "query", id: "5", sql: "SELECT * FROM table_that_does_not_exist" });
  r = await s.next();
  assert.strictEqual(r.code, "query_failed");
  s.send({ type: "query", id: "6", sql: "SELECT 1" });
  assert.strictEqual((await s.next()).type, "result"); // session survives the error
  s.ws.close();
});

test("postgres: cancel and timeout, session survives both", { skip }, async () => {
  const { s } = await connect();
  s.send({ type: "query", id: "c", sql: "SELECT pg_sleep(30)" });
  await new Promise((r) => setTimeout(r, 300));
  s.send({ type: "cancel", id: "c" });
  assert.strictEqual((await s.next()).code, "cancelled");

  s.send({ type: "query", id: "t", sql: "SELECT pg_sleep(30)", timeoutMs: 600 });
  const t = await s.next();
  assert.deepStrictEqual([t.code, t.id], ["timeout", "t"]);

  s.send({ type: "query", id: "ok", sql: "SELECT 1" });
  assert.strictEqual((await s.next()).type, "result");
  s.ws.close();
});
