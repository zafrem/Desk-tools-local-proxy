#!/usr/bin/env node
"use strict";

/**
 * desk-tools-local-proxy
 * -------------------------------------------------------------------------
 * A tiny local bridge that lets the Desk-tools web app talk to SSH, Telnet,
 * MySQL, PostgreSQL, Hive and Trino. Browsers cannot open raw TCP sockets, so
 * this process runs on your own machine, accepts a WebSocket from the browser,
 * and relays it to the real service. Nothing is sent to any third party.
 *
 *   Browser  --WebSocket-->  this proxy  --native protocol-->  target system
 *
 * The wire protocol is documented in PROTOCOL.md.
 */

const http = require("http");
const { WebSocketServer } = require("ws");
const { ProxyError, classifyConnectError } = require("./src/errors");
const { checkReadOnly } = require("./src/sql-guard");
const { normalize } = require("./src/values");

const VERSION = require("./package.json").version;
const PROTOCOL = 2;

// Loaded lazily so a missing optional driver only breaks its own service.
const SERVICE_MODULES = {
  ssh: () => require("./src/services/ssh"),
  telnet: () => require("./src/services/telnet"),
  mysql: () => require("./src/services/mysql"),
  postgres: () => require("./src/services/postgres"),
  hive: () => require("./src/services/hive"),
  trino: () => require("./src/services/trino"),
};
const SERVICES = Object.keys(SERVICE_MODULES);

const DEFAULT_ORIGINS = [
  "https://zafrem.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const DEFAULT_MAX_ROWS = 1000;
const HARD_MAX_ROWS = 10000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 300000;

function clamp(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function createServer({ allowedOrigins = DEFAULT_ORIGINS } = {}) {
  const isAllowedOrigin = (origin) => {
    if (!origin) return true; // non-browser clients (curl, native apps) have no Origin
    return allowedOrigins.includes(origin);
  };

  // --- HTTP: only a health check, so the browser can detect us -------------
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          service: "desk-tools-local-proxy",
          version: VERSION,
          protocol: PROTOCOL,
          services: SERVICES,
          ok: true,
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (!isAllowedOrigin(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", handleConnection);
  server.closeAll = () => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
  return server;
}

function handleConnection(ws) {
  let service = null; // the service module, once chosen
  let session = null; // the live backend session
  let connecting = false;
  let closed = false;
  let activeQuery = null; // { id, cancelled, timedOut }

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const sendStatus = (state, message, info) => {
    const msg = { type: "status", state };
    if (message) msg.message = message;
    if (info) msg.info = info;
    send(msg);
  };
  const sendError = (code, message, id) => {
    const msg = { type: "error", code, message };
    if (id !== undefined) msg.id = id;
    send(msg);
  };

  const teardown = () => {
    closed = true;
    const s = session;
    session = null;
    if (s) Promise.resolve(s.close()).catch(() => {});
  };

  // ---- connect --------------------------------------------------------
  const onConnect = async (msg) => {
    if (connecting || session) return sendError("already_connected", "Already connected");
    const name = msg.service === undefined ? "ssh" : msg.service;
    if (!SERVICES.includes(name)) {
      return sendError("unsupported", `Unsupported service: ${String(name)}`);
    }
    if (!msg.host) return sendError("bad_message", "host is required");
    if (!msg.username && name !== "telnet") return sendError("bad_message", "username is required");

    connecting = true;
    let mod;
    try {
      mod = SERVICE_MODULES[name]();
    } catch (err) {
      connecting = false;
      sendError("unsupported", `Service ${name} is not available in this build: ${err.message}`);
      return ws.close();
    }
    const port = msg.port || mod.defaultPort;
    sendStatus("connecting", `${msg.username ? msg.username + "@" : ""}${msg.host}:${port}`);

    // Output can arrive while the connect promise is still resolving; hold it
    // back so the browser always sees `ready` before the first byte.
    let pending = [];
    const io = {
      onData: (buf) => {
        if (pending) pending.push(buf);
        else if (ws.readyState === ws.OPEN) ws.send(buf);
      },
      onClose: (message) => {
        if (closed) return;
        sendStatus("closed", message);
        teardown();
        ws.close();
      },
    };

    try {
      const s = await mod.connect({ ...msg, port }, io);
      if (closed) {
        // The browser went away while we were connecting.
        Promise.resolve(s.close()).catch(() => {});
        return;
      }
      session = s;
      service = mod;
      connecting = false;
      const info = { service: name, kind: mod.kind };
      if (s.serverVersion) info.serverVersion = s.serverVersion;
      sendStatus("ready", undefined, info);
      const early = pending;
      pending = null;
      for (const buf of early) io.onData(buf);
    } catch (err) {
      connecting = false;
      const e = classifyConnectError(err);
      sendError(e.code, e.message || "Connection failed");
      ws.close();
    }
  };

  // ---- query ----------------------------------------------------------
  const onQuery = async (msg) => {
    const id = msg.id === undefined ? undefined : String(msg.id);
    if (!session) return sendError("not_connected", "Not connected", id);
    if (service.kind !== "query") return sendError("unsupported", "This service does not accept queries", id);
    if (id === undefined) return sendError("bad_message", "query requires an id");
    if (activeQuery) return sendError("busy", "Another query is still running", id);

    const check = checkReadOnly(msg.sql);
    if (!check.ok) return sendError("query_rejected", check.reason, id);

    const maxRows = clamp(msg.maxRows, DEFAULT_MAX_ROWS, HARD_MAX_ROWS);
    const timeoutMs = clamp(msg.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const q = { id, cancelled: false, timedOut: false };
    activeQuery = q;
    const timer = setTimeout(() => {
      q.timedOut = true;
      Promise.resolve(session && session.cancel()).catch(() => {});
    }, timeoutMs);

    const started = Date.now();
    try {
      const out = await session.query(check.sql, { maxRows, timeoutMs });
      const truncated = out.rows.length > maxRows;
      const rows = (truncated ? out.rows.slice(0, maxRows) : out.rows).map((r) => r.map(normalize));
      send({
        type: "result",
        id,
        columns: out.columns,
        rows,
        rowCount: rows.length,
        truncated,
        elapsedMs: Date.now() - started,
      });
    } catch (err) {
      if (q.timedOut) sendError("timeout", `Query exceeded ${timeoutMs} ms`, id);
      else if (q.cancelled) sendError("cancelled", "Query cancelled", id);
      else if (err instanceof ProxyError) sendError(err.code, err.message, id);
      else sendError("query_failed", (err && err.message) || "Query failed", id);
    } finally {
      clearTimeout(timer);
      activeQuery = null;
    }
  };

  const onCancel = (msg) => {
    if (!session || !activeQuery || String(msg.id) !== activeQuery.id) return;
    activeQuery.cancelled = true;
    Promise.resolve(session.cancel()).catch(() => {});
  };

  // ---- dispatch -------------------------------------------------------
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Raw keystrokes -> remote stdin (terminal services only).
      if (session && service.kind === "terminal") session.write(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return sendError("bad_message", "Malformed control message");
    }
    if (!msg || typeof msg !== "object") return sendError("bad_message", "Malformed control message");

    switch (msg.type) {
      case "connect":
        return void onConnect(msg);
      case "resize":
        if (!session) return sendError("not_connected", "Not connected");
        if (service.kind !== "terminal") return sendError("unsupported", "resize is only valid for terminal services");
        return session.resize(msg.cols, msg.rows);
      case "query":
        return void onQuery(msg);
      case "cancel":
        return onCancel(msg);
      case "close":
        sendStatus("closed");
        teardown();
        return ws.close();
      default:
        return sendError("bad_message", `Unknown message type: ${String(msg.type)}`);
    }
  });

  ws.on("close", teardown);
  ws.on("error", teardown);
}

module.exports = { createServer, PROTOCOL, SERVICES };

if (require.main === module) {
  const PORT = Number(process.env.DESK_TOOLS_LOCAL_PROXY_PORT || 8722);
  const HOST = "127.0.0.1"; // loopback only — never expose to the network
  const extra = (process.env.DESK_TOOLS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const server = createServer({ allowedOrigins: [...DEFAULT_ORIGINS, ...extra] });
  server.listen(PORT, HOST, () => {
    console.log(`desk-tools-local-proxy v${VERSION} (protocol ${PROTOCOL})`);
    console.log(`Listening on http://${HOST}:${PORT}  (health: /health)`);
    console.log(`Services: ${SERVICES.join(", ")}`);
    console.log("Open Desk-tools Settings > Connections to test the link.");
    console.log("Press Ctrl+C to stop.");
  });
}
