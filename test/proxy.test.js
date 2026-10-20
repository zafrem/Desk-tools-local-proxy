"use strict";
const test = require("node:test");
const assert = require("node:assert");
const net = require("node:net");
const http = require("node:http");
const crypto = require("node:crypto");
const WebSocket = require("ws");
const { Server: SshServer } = require("ssh2");

// Replace the postgres driver with an in-memory fake so the query flow
// (result / truncation / busy / cancel / timeout) is testable without a DB.
const fakePath = require.resolve("../src/services/postgres");
let fakeBehaviour = {};
require.cache[fakePath] = {
  id: fakePath, filename: fakePath, loaded: true,
  exports: {
    kind: "query", defaultPort: 5432,
    connect: async () => {
      let release = null;
      return {
        serverVersion: "fake-1",
        query: async (sql, opts) => {
          if (fakeBehaviour.hang) {
            await new Promise((_, rej) => { release = () => rej(new Error("interrupted")); });
          }
          return fakeBehaviour.result(sql, opts);
        },
        cancel: async () => { if (release) release(); },
        close: async () => {},
      };
    },
  },
};

const { createServer } = require("../index.js");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/** Opens a WS and exposes next() to await the next JSON/binary frame. */
function client(port, opts) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, opts);
  const queue = [];
  const waiters = [];
  ws.on("message", (data, isBinary) => {
    const item = isBinary ? { binary: Buffer.from(data) } : JSON.parse(data.toString());
    if (waiters.length) waiters.shift()(item);
    else queue.push(item);
  });
  const opened = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const closed = new Promise((res) => ws.on("close", res));
  return {
    ws, opened, closed,
    next: () => new Promise((res, rej) => {
      if (queue.length) return res(queue.shift());
      const t = setTimeout(() => rej(new Error("timed out waiting for frame")), 5000);
      waiters.push((v) => { clearTimeout(t); res(v); });
    }),
    send: (o) => ws.send(JSON.stringify(o)),
  };
}

let server, port;
test.before(async () => { server = createServer(); port = await listen(server); });
test.after(() => { server.closeAll(); server.close(); });

test("/health advertises protocol 2 and the services", async () => {
  const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.strictEqual(body.service, "desk-tools-local-proxy");
  assert.strictEqual(body.protocol, 2);
  assert.deepStrictEqual(body.services, ["ssh", "telnet", "mysql", "postgres", "hive", "trino"]);
});

test("rejects a WebSocket from a foreign Origin", async () => {
  const c = client(port, { origin: "https://evil.example" });
  await assert.rejects(c.opened);
});

test("protocol errors carry codes and do not close the socket", async () => {
  const c = client(port);
  await c.opened;
  c.send({ type: "query", id: "1", sql: "SELECT 1" });
  assert.strictEqual((await c.next()).code, "not_connected");
  c.ws.send("not json");
  assert.strictEqual((await c.next()).code, "bad_message");
  c.send({ type: "nope" });
  assert.strictEqual((await c.next()).code, "bad_message");
  c.send({ type: "connect", service: "oracle", host: "h", username: "u" });
  assert.strictEqual((await c.next()).code, "unsupported");
  c.send({ type: "connect", service: "postgres", host: "h" });
  assert.strictEqual((await c.next()).code, "bad_message");
  assert.strictEqual(c.ws.readyState, WebSocket.OPEN);
  c.ws.close();
});

test("connect failure -> host_unreachable error then close", async () => {
  const c = client(port);
  await c.opened;
  c.send({ type: "connect", service: "telnet", host: "127.0.0.1", port: 1 });
  assert.strictEqual((await c.next()).state, "connecting");
  const err = await c.next();
  assert.strictEqual(err.type, "error");
  assert.strictEqual(err.code, "host_unreachable");
  await c.closed;
});

// ---- query flow (fake postgres) ----------------------------------------
async function pgSession() {
  const c = client(port);
  await c.opened;
  c.send({ type: "connect", service: "postgres", host: "h", username: "u" });
  await c.next(); // connecting
  const ready = await c.next();
  return { c, ready };
}

test("query: ready info, result encoding, truncation", async () => {
  fakeBehaviour = {
    result: () => ({
      columns: [{ name: "id", type: "int8" }, { name: "at", type: "timestamptz" }],
      rows: [[1n, new Date(0)], [2n, null], [3n, null]],
    }),
  };
  const { c, ready } = await pgSession();
  assert.deepStrictEqual(ready.info, { service: "postgres", kind: "query", serverVersion: "fake-1" });
  c.send({ type: "query", id: "q1", sql: "SELECT * FROM t", maxRows: 2 });
  const r = await c.next();
  assert.strictEqual(r.type, "result");
  assert.strictEqual(r.id, "q1");
  assert.deepStrictEqual(r.rows, [["1", "1970-01-01T00:00:00.000Z"], ["2", null]]);
  assert.strictEqual(r.rowCount, 2);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(typeof r.elapsedMs, "number");
  c.ws.close();
});

test("query: writes are rejected before reaching the driver, session stays usable", async () => {
  let called = 0;
  fakeBehaviour = { result: () => { called++; return { columns: [], rows: [] }; } };
  const { c } = await pgSession();
  c.send({ type: "query", id: "w", sql: "DROP TABLE t" });
  const e = await c.next();
  assert.strictEqual(e.code, "query_rejected");
  assert.strictEqual(e.id, "w");
  assert.strictEqual(called, 0);
  c.send({ type: "query", id: "ok", sql: "SELECT 1" });
  assert.strictEqual((await c.next()).type, "result");
  c.send({ type: "resize", cols: 1, rows: 1 });
  assert.strictEqual((await c.next()).code, "unsupported");
  c.ws.send(Buffer.from("raw")); // binary ignored on query services
  c.ws.close();
});

test("query: driver errors are query_failed and keep the session", async () => {
  fakeBehaviour = { result: () => { throw new Error('relation "x" does not exist'); } };
  const { c } = await pgSession();
  c.send({ type: "query", id: "e", sql: "SELECT * FROM x" });
  const e = await c.next();
  assert.deepStrictEqual([e.code, e.id, e.message], ["query_failed", "e", 'relation "x" does not exist']);
  fakeBehaviour = { result: () => ({ columns: [], rows: [] }) };
  c.send({ type: "query", id: "e2", sql: "SELECT 1" });
  assert.strictEqual((await c.next()).type, "result");
  c.ws.close();
});

test("query: busy, cancel, and timeout", async () => {
  fakeBehaviour = { hang: true };
  const { c } = await pgSession();
  c.send({ type: "query", id: "a", sql: "SELECT pg_sleep(100)" });
  c.send({ type: "query", id: "b", sql: "SELECT 1" });
  const busy = await c.next();
  assert.deepStrictEqual([busy.code, busy.id], ["busy", "b"]);
  c.send({ type: "cancel", id: "a" });
  const cancelled = await c.next();
  assert.deepStrictEqual([cancelled.code, cancelled.id], ["cancelled", "a"]);

  c.send({ type: "query", id: "t", sql: "SELECT pg_sleep(100)", timeoutMs: 50 });
  const timeout = await c.next();
  assert.deepStrictEqual([timeout.code, timeout.id], ["timeout", "t"]);
  c.ws.close();
});

test("a second connect is refused", async () => {
  fakeBehaviour = { result: () => ({ columns: [], rows: [] }) };
  const { c } = await pgSession();
  c.send({ type: "connect", service: "postgres", host: "h", username: "u" });
  assert.strictEqual((await c.next()).code, "already_connected");
  c.ws.close();
});

// ---- telnet against a fake server ----------------------------------------
test("telnet: negotiation is answered and stripped, data relays both ways", async () => {
  const IAC = 255, DO = 253, WILL = 251, WONT = 252;
  const received = [];
  const tserver = net.createServer((sock) => {
    // DO NAWS, DO TTYPE (refused), WILL ECHO, then "login: " with an escaped 0xFF.
    sock.write(Buffer.from([IAC, DO, 31, IAC, DO, 24, IAC, WILL, 1]));
    sock.write(Buffer.concat([Buffer.from("login: "), Buffer.from([IAC, IAC])]));
    sock.on("data", (d) => received.push(Buffer.from(d)));
  });
  const tport = await listen(tserver);

  const c = client(port);
  await c.opened;
  c.send({ type: "connect", service: "telnet", host: "127.0.0.1", port: tport, cols: 100, rows: 30 });
  assert.strictEqual((await c.next()).state, "connecting");
  const ready = await c.next();
  assert.deepStrictEqual(ready.info, { service: "telnet", kind: "terminal" });
  const data = await c.next();
  assert.deepStrictEqual([...data.binary], [...Buffer.from("login: "), 255]);

  c.ws.send(Buffer.from("root\r"));
  await new Promise((r) => setTimeout(r, 150));
  const all = [...Buffer.concat(received)];
  // WILL NAWS, subnegotiation 100x30, WONT TTYPE, DO ECHO, then "root" CR NUL.
  assert.deepStrictEqual(all.slice(0, 3), [IAC, WILL, 31]);
  assert.deepStrictEqual(all.slice(3, 12), [IAC, 250, 31, 0, 100, 0, 30, IAC, 240]);
  assert.deepStrictEqual(all.slice(12, 15), [IAC, WONT, 24]);
  assert.deepStrictEqual(all.slice(15, 18), [IAC, 253, 1]);
  assert.deepStrictEqual(all.slice(18), [...Buffer.from("root"), 13, 0]);

  c.ws.close();
  tserver.close();
});

// ---- ssh against an in-process ssh2 server -------------------------------
test("ssh: password login, shell I/O, resize", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  let windowChange = null;
  const sshd = new SshServer({ hostKeys: [privateKey] }, (conn) => {
    conn.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "alice" && ctx.password === "secret") ctx.accept();
      else ctx.reject();
    });
    conn.on("ready", () => {
      conn.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acc) => acc && acc());
        session.on("window-change", (acc, rej, info) => { windowChange = info; acc && acc(); });
        session.on("shell", (acc) => {
          const stream = acc();
          stream.write("welcome\r\n");
          stream.on("data", (d) => stream.write(`echo:${d}`));
        });
      });
    });
  });
  const sport = await new Promise((r) => sshd.listen(0, "127.0.0.1", () => r(sshd.address().port)));

  // wrong password -> auth_failed
  const bad = client(port);
  await bad.opened;
  bad.send({ type: "connect", service: "ssh", host: "127.0.0.1", port: sport, username: "alice", password: "nope" });
  await bad.next();
  const err = await bad.next();
  assert.strictEqual(err.code, "auth_failed");

  // v1-style connect (no `service`) still works
  const c = client(port);
  await c.opened;
  c.send({ type: "connect", host: "127.0.0.1", port: sport, username: "alice", password: "secret", cols: 90, rows: 20 });
  assert.strictEqual((await c.next()).state, "connecting");
  const rdy = await c.next(); assert.deepStrictEqual(rdy.info, { service: "ssh", kind: "terminal" }, JSON.stringify(rdy));
  assert.match((await c.next()).binary.toString(), /welcome/);
  c.ws.send(Buffer.from("hi"));
  assert.strictEqual((await c.next()).binary.toString(), "echo:hi");
  c.send({ type: "resize", cols: 120, rows: 40 });
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(windowChange && windowChange.cols, 120);
  c.ws.close();
  sshd.close();
});

// ---- trino against a fake REST server ------------------------------------
test("trino: follows nextUri pages and returns columns/rows", async () => {
  const seen = {};
  const tr = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const base = `http://127.0.0.1:${tr.address().port}`;
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/info") return res.end(JSON.stringify({ nodeVersion: { version: "999" } }));
      if (req.url === "/v1/statement" && req.method === "POST") {
        seen.sql = body; seen.user = req.headers["x-trino-user"]; seen.catalog = req.headers["x-trino-catalog"];
        return res.end(JSON.stringify({ nextUri: `${base}/v1/statement/q/1` }));
      }
      if (req.url === "/v1/statement/q/1") {
        return res.end(JSON.stringify({ columns: [{ name: "n", type: "integer" }], data: [[1], [2]], nextUri: `${base}/v1/statement/q/2` }));
      }
      if (req.url === "/v1/statement/q/2") return res.end(JSON.stringify({ data: [[3]] }));
      res.statusCode = 404; res.end("{}");
    });
  });
  const tport = await listen(tr);

  const c = client(port);
  await c.opened;
  c.send({ type: "connect", service: "trino", host: "127.0.0.1", port: tport, username: "bob", catalog: "hive" });
  await c.next();
  assert.deepStrictEqual((await c.next()).info, { service: "trino", kind: "query", serverVersion: "999" });
  c.send({ type: "query", id: "t1", sql: "SELECT n FROM t;" });
  const r = await c.next();
  assert.deepStrictEqual(r.columns, [{ name: "n", type: "integer" }]);
  assert.deepStrictEqual(r.rows, [[1], [2], [3]]);
  assert.deepStrictEqual([seen.sql, seen.user, seen.catalog], ["SELECT n FROM t", "bob", "hive"]);
  c.ws.close();
  tr.close();
});
