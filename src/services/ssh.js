"use strict";

const { Client } = require("ssh2");
const { ProxyError } = require("../errors");

exports.kind = "terminal";
exports.defaultPort = 22;

function sshOptions(cfg) {
  const opts = {
    host: cfg.host,
    port: cfg.port || exports.defaultPort,
    username: cfg.username,
    // Keepalives so dropped links surface instead of hanging forever.
    keepaliveInterval: 15000,
    readyTimeout: 20000,
  };
  if (cfg.password) opts.password = cfg.password;
  if (cfg.privateKey) opts.privateKey = cfg.privateKey;
  if (cfg.passphrase) opts.passphrase = cfg.passphrase;
  return opts;
}

const MAX_EXEC_OUTPUT = 64 * 1024 * 1024;

/**
 * Runs one command without a pty and collects its output (CLI automation).
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, truncated: boolean}>}
 */
exports.exec = (cfg, command, { timeoutMs = 30000 } = {}) =>
  new Promise((resolve, reject) => {
    const ssh = new Client();
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ssh.end();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new ProxyError("timeout", `Command exceeded ${timeoutMs} ms`)), timeoutMs);

    ssh
      .on("ready", () => {
        ssh.exec(command, (err, stream) => {
          if (err) return finish(reject, err);
          const out = { stdout: [], stderr: [] };
          let size = 0;
          let truncated = false;
          const keep = (which) => (d) => {
            if (size >= MAX_EXEC_OUTPUT) return void (truncated = true);
            size += d.length;
            out[which].push(d);
          };
          stream.on("data", keep("stdout"));
          stream.stderr.on("data", keep("stderr"));
          stream.on("close", (code) =>
            finish(resolve, {
              stdout: Buffer.concat(out.stdout).toString("utf8"),
              stderr: Buffer.concat(out.stderr).toString("utf8"),
              exitCode: typeof code === "number" ? code : null,
              truncated,
            })
          );
        });
      })
      .on("error", (err) => finish(reject, err))
      .on("close", () => finish(reject, new Error("Connection closed before the command finished")));
    try {
      ssh.connect(sshOptions(cfg));
    } catch (e) {
      finish(reject, e);
    }
  });

/**
 * @param cfg  the `connect` message
 * @param io   { onData(buf), onClose(message?) }
 * @returns session { write(buf), resize(cols, rows), close() }
 */
exports.connect = (cfg, io) =>
  new Promise((resolve, reject) => {
    const ssh = new Client();
    let settled = false;
    let stream = null;

    ssh
      .on("ready", () => {
        ssh.shell(
          { term: "xterm-256color", cols: cfg.cols || 80, rows: cfg.rows || 24 },
          (err, sh) => {
            if (err) {
              settled = true;
              ssh.end();
              reject(new Error(`Failed to open shell: ${err.message}`));
              return;
            }
            stream = sh;
            sh.on("data", (d) => io.onData(d));
            sh.stderr.on("data", (d) => io.onData(d));
            sh.on("close", () => {
              io.onClose("Session closed");
              ssh.end();
            });
            settled = true;
            resolve({
              write: (buf) => stream.write(buf),
              resize: (cols, rows) => stream.setWindow(rows || 24, cols || 80, 0, 0),
              close: () => ssh.end(),
            });
          }
        );
      })
      .on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          io.onClose(err.message);
        }
      })
      .on("close", () => {
        if (!settled) {
          settled = true;
          reject(new Error("Connection closed before the session was ready"));
        } else {
          io.onClose();
        }
      });

    const opts = sshOptions(cfg);
    try {
      ssh.connect(opts);
    } catch (e) {
      settled = true;
      reject(e);
    }
  });
