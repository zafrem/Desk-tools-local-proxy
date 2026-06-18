#!/usr/bin/env node
"use strict";

/**
 * desk-tools-ssh-proxy
 * -------------------------------------------------------------------------
 * A tiny local bridge that lets the Desk-tools web terminal speak SSH.
 *
 * Why this exists: browsers cannot open raw TCP sockets, so a web page can
 * never talk to an SSH server (port 22) directly. This process runs on your
 * own machine, accepts a WebSocket from the browser, and relays it to a real
 * SSH connection. Nothing is sent to any third party.
 *
 *   Browser (xterm.js)  --WebSocket-->  this proxy  --TCP/SSH-->  ssh server
 *
 * Wire protocol (intentionally minimal):
 *   - Browser -> proxy, TEXT frame  = JSON control message:
 *         { type: "connect", host, port, username, password?, privateKey?,
 *           passphrase?, cols?, rows? }
 *         { type: "resize", cols, rows }
 *   - Browser -> proxy, BINARY frame = raw keystrokes -> ssh stdin
 *   - Proxy -> browser, TEXT frame   = JSON status:
 *         { type: "status", state: "connecting"|"ready"|"closed", message? }
 *         { type: "error", message }
 *   - Proxy -> browser, BINARY frame = raw ssh stdout/stderr -> terminal
 */

const http = require("http");
const { WebSocketServer } = require("ws");
const { Client } = require("ssh2");

const PORT = Number(process.env.DESK_TOOLS_SSH_PROXY_PORT || 8722);
const HOST = "127.0.0.1"; // bind to loopback only — never expose to the network
const VERSION = require("./package.json").version;

// Origins allowed to drive this proxy. The browser sends an Origin header on
// the WebSocket upgrade; we reject anything not on this list so a random
// website can't open SSH sessions through your machine.
const ALLOWED_ORIGINS = [
  "https://zafrem.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser clients (curl, native apps) have no Origin
  return ALLOWED_ORIGINS.includes(origin);
}

// --- HTTP server: only serves a health check so the browser can detect us ---
const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin) && origin) {
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
      JSON.stringify({ service: "desk-tools-ssh-proxy", version: VERSION, ok: true })
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

wss.on("connection", (ws) => {
  let ssh = null;
  let stream = null;

  const sendStatus = (state, message) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "status", state, message }));
    }
  };
  const sendError = (message) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: "error", message }));
    }
  };

  const startSession = (cfg) => {
    sendStatus("connecting", `${cfg.username}@${cfg.host}:${cfg.port || 22}`);
    ssh = new Client();

    ssh
      .on("ready", () => {
        ssh.shell(
          {
            term: "xterm-256color",
            cols: cfg.cols || 80,
            rows: cfg.rows || 24,
          },
          (err, sh) => {
            if (err) {
              sendError(`Failed to open shell: ${err.message}`);
              ws.close();
              return;
            }
            stream = sh;
            sendStatus("ready");
            stream.on("data", (d) => {
              if (ws.readyState === ws.OPEN) ws.send(d);
            });
            stream.stderr.on("data", (d) => {
              if (ws.readyState === ws.OPEN) ws.send(d);
            });
            stream.on("close", () => {
              sendStatus("closed", "Session closed");
              ssh.end();
              ws.close();
            });
          }
        );
      })
      .on("error", (err) => {
        sendError(err.message || "SSH connection error");
        ws.close();
      })
      .on("close", () => {
        sendStatus("closed");
      });

    const connectOpts = {
      host: cfg.host,
      port: cfg.port || 22,
      username: cfg.username,
      // Keepalives so dropped links surface instead of hanging forever.
      keepaliveInterval: 15000,
      readyTimeout: 20000,
    };
    if (cfg.password) connectOpts.password = cfg.password;
    if (cfg.privateKey) connectOpts.privateKey = cfg.privateKey;
    if (cfg.passphrase) connectOpts.passphrase = cfg.passphrase;
    // Let the user accept any host key from the UI side; we don't pin here.
    try {
      ssh.connect(connectOpts);
    } catch (e) {
      sendError(e.message || "Invalid connection options");
      ws.close();
    }
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Raw keystrokes -> ssh stdin
      if (stream) stream.write(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sendError("Malformed control message");
      return;
    }
    if (msg.type === "connect") {
      if (ssh) {
        sendError("Already connected");
        return;
      }
      if (!msg.host || !msg.username) {
        sendError("host and username are required");
        return;
      }
      startSession(msg);
    } else if (msg.type === "resize" && stream) {
      stream.setWindow(msg.rows || 24, msg.cols || 80, 0, 0);
    }
  });

  ws.on("close", () => {
    if (ssh) ssh.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`desk-tools-ssh-proxy v${VERSION}`);
  console.log(`Listening on http://${HOST}:${PORT}  (health: /health)`);
  console.log("Open the SSH Terminal tool in Desk-tools to connect.");
  console.log("Press Ctrl+C to stop.");
});
