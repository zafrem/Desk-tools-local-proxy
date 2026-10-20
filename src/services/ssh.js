"use strict";

const { Client } = require("ssh2");

exports.kind = "terminal";
exports.defaultPort = 22;

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
    try {
      ssh.connect(opts);
    } catch (e) {
      settled = true;
      reject(e);
    }
  });
