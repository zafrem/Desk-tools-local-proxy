"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Server: SshServer } = require("ssh2");
const { formatResult } = require("../src/export");

// In-memory postgres so the CLI flow runs without a database.
const fakePath = require.resolve("../src/services/postgres");
const seen = [];
require.cache[fakePath] = {
  id: fakePath, filename: fakePath, loaded: true,
  exports: {
    kind: "query", defaultPort: 5432,
    connect: async (cfg) => {
      if (cfg.password !== "pw") throw Object.assign(new Error("password authentication failed"), { code: "28P01" });
      return {
        serverVersion: "fake",
        query: async (sql) => {
          seen.push(sql);
          return {
            columns: [{ name: "id", type: "int8" }, { name: "note", type: "text" }, { name: "blob", type: "bytea" }],
            rows: [[1n, 'say "hi", ok', Buffer.from("hi")], [2n, null, null], [3n, "x", null]],
          };
        },
        cancel: async () => {},
        close: async () => {},
      };
    },
  },
};

const { main } = require("../cli.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtp-cli-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const base = ["-s", "postgres", "--host", "h", "-u", "u"];
const quiet = async (args) => {
  const orig = process.stderr.write;
  let err = "";
  process.stderr.write = (s) => ((err += s), true);
  try { return { code: await main(args), err }; } finally { process.stderr.write = orig; }
};
process.env.DESK_TOOLS_PASSWORD = "pw";

const sample = { columns: [{ name: "a", type: "t" }, { name: "a", type: "t" }], rows: [[1, "x,y"], [null, { $base64: "aGk=" }]], rowCount: 2, truncated: false };

test("export formats", () => {
  assert.strictEqual(formatResult(sample, "csv"), 'a,a\n1,"x,y"\n,aGk=\n');
  assert.strictEqual(formatResult(sample, "ndjson"), '{"a":1,"a_2":"x,y"}\n{"a":null,"a_2":{"$base64":"aGk="}}\n');
  assert.deepStrictEqual(JSON.parse(formatResult(sample, "json")).rows, sample.rows);
  assert.match(formatResult(sample, "table"), /^a {5}a\n-{4} {2}-{4}\n/);
  assert.throws(() => formatResult(sample, "xml"));
});

test("query exports CSV to an owner-only file and encodes values", async () => {
  const out = path.join(dir, "r.csv");
  const r = await quiet(["query", ...base, "--sql", "SELECT 1", "--format", "csv", "--out", out]);
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(fs.readFileSync(out, "utf8"), 'id,note,blob\n1,"say ""hi"", ok",aGk=\n2,,\n3,x,\n');
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(out).mode & 0o777, 0o600);
  // refuses to clobber, unless asked
  assert.strictEqual((await quiet(["query", ...base, "--sql", "SELECT 1", "--out", out])).code, 1);
  assert.strictEqual((await quiet(["query", ...base, "--sql", "SELECT 1", "--out", out, "--overwrite"])).code, 0);
});

test("max-rows truncates and the read-only guard still applies", async () => {
  const out = path.join(dir, "t.json");
  const r = await quiet(["query", ...base, "--sql", "SELECT 1", "-f", "json", "-o", out, "--max-rows", "2"]);
  assert.strictEqual(r.code, 0, r.err);
  const j = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.deepStrictEqual([j.rowCount, j.truncated], [2, true]);
  const bad = await quiet(["query", ...base, "--sql", "DELETE FROM t"]);
  assert.strictEqual(bad.code, 1);
  assert.match(bad.err, /query_rejected/);
});

test("exit codes: bad auth 3, bad usage 2", async () => {
  process.env.DESK_TOOLS_PASSWORD = "wrong";
  const r = await quiet(["query", ...base, "--sql", "SELECT 1"]);
  process.env.DESK_TOOLS_PASSWORD = "pw";
  assert.strictEqual(r.code, 3);
  assert.match(r.err, /auth_failed/);
  await assert.rejects(main(["query", ...base]), /needs --sql/);
  await assert.rejects(main(["bogus"]), /Unknown command/);
});

test("job file runs several exports and refuses inline secrets", async () => {
  fs.writeFileSync(path.join(dir, "q.sql"), "SELECT 2");
  const job = path.join(dir, "job.json");
  const conn = { service: "postgres", host: "h", username: "u" };
  fs.writeFileSync(job, JSON.stringify({
    connection: conn,
    steps: [
      { name: "a", sql: "SELECT 1", export: { format: "ndjson", file: path.join(dir, "a.ndjson") } },
      { name: "b", sqlFile: path.join(dir, "q.sql"), export: { file: path.join(dir, "b.csv") } },
    ],
  }));
  const r = await quiet(["run", job]);
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(dir, "a.ndjson")) && fs.existsSync(path.join(dir, "b.csv")));
  assert.ok(seen.includes("SELECT 2"));

  fs.writeFileSync(job, JSON.stringify({ connection: { ...conn, password: "pw" }, steps: [{ sql: "SELECT 1" }] }));
  await assert.rejects(main(["run", job]), /Secrets can't be written/);

  // a failing step stops the job unless continueOnError
  fs.writeFileSync(job, JSON.stringify({ connection: conn, steps: [{ name: "bad", sql: "DROP TABLE t" }, { name: "never", sql: "SELECT 1", export: { file: path.join(dir, "never.csv") } }] }));
  assert.strictEqual((await quiet(["run", job])).code, 1);
  assert.ok(!fs.existsSync(path.join(dir, "never.csv")));
});

test("exec runs a remote command over ssh and exports stdout", async () => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const sshd = new SshServer({ hostKeys: [privateKey] }, (conn) => {
    conn.on("authentication", (ctx) => (ctx.method === "password" && ctx.password === "pw" ? ctx.accept() : ctx.reject()));
    conn.on("ready", () => conn.on("session", (accept) => {
      accept().on("exec", (acc, rej, info) => {
        const s = acc();
        if (info.command === "fail") { s.stderr.write("boom\n"); s.exit(3); } else { s.write(`ran:${info.command}\n`); s.exit(0); }
        s.end();
      });
    }));
  });
  const port = await new Promise((r) => sshd.listen(0, "127.0.0.1", () => r(sshd.address().port)));
  const ssh = ["-s", "ssh", "--host", "127.0.0.1", "--port", String(port), "-u", "alice"];
  try {
    const out = path.join(dir, "exec.txt");
    const r = await quiet(["exec", ...ssh, "--command", "uptime", "-o", out]);
    assert.strictEqual(r.code, 0, r.err);
    assert.strictEqual(fs.readFileSync(out, "utf8"), "ran:uptime\n");
    const f = await quiet(["exec", ...ssh, "--command", "fail"]);
    assert.strictEqual(f.code, 1);
    assert.match(f.err, /exit code 3: boom/);
    const q = await quiet(["query", ...ssh, "--sql", "SELECT 1"]);
    assert.strictEqual(q.code, 1); // ssh can't run SQL
  } finally {
    sshd.close();
  }
});
