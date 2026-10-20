"use strict";

const net = require("net");

exports.kind = "terminal";
exports.defaultPort = 23;

// Telnet command bytes (RFC 854) and the few options we answer (RFC 857/858/1073).
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const OPT_ECHO = 1, OPT_SGA = 3, OPT_NAWS = 31;

/**
 * Strips telnet negotiation out of the incoming byte stream and answers it.
 * We accept ECHO and SGA from the server (so the remote side echoes typed
 * characters, as a real telnet client does), report window size via NAWS, and
 * refuse everything else.
 */
class TelnetParser {
  constructor({ reply, getSize }) {
    this.reply = reply;
    this.getSize = getSize;
    this.state = "data";
    this.cmd = 0;
    this.sbOpt = null;
  }

  /** @returns {Buffer} the application data with negotiation removed */
  feed(chunk) {
    const out = [];
    for (const b of chunk) {
      switch (this.state) {
        case "data":
          if (b === IAC) this.state = "iac";
          else out.push(b);
          break;
        case "iac":
          if (b === IAC) {
            out.push(255);
            this.state = "data";
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.cmd = b;
            this.state = "opt";
          } else if (b === SB) {
            this.state = "sb";
            this.sbOpt = null;
          } else {
            this.state = "data"; // NOP, GA, etc.
          }
          break;
        case "opt":
          this.negotiate(this.cmd, b);
          this.state = "data";
          break;
        case "sb":
          // Skip subnegotiation payloads until IAC SE.
          if (b === IAC) this.state = "sb_iac";
          break;
        case "sb_iac":
          this.state = b === SE ? "data" : "sb";
          break;
      }
    }
    return Buffer.from(out);
  }

  negotiate(cmd, opt) {
    if (cmd === DO) {
      if (opt === OPT_NAWS) {
        this.reply(Buffer.from([IAC, WILL, OPT_NAWS]));
        this.sendSize();
      } else if (opt === OPT_SGA) {
        this.reply(Buffer.from([IAC, WILL, OPT_SGA]));
      } else {
        this.reply(Buffer.from([IAC, WONT, opt]));
      }
    } else if (cmd === WILL) {
      if (opt === OPT_ECHO || opt === OPT_SGA) this.reply(Buffer.from([IAC, DO, opt]));
      else this.reply(Buffer.from([IAC, DONT, opt]));
    }
    // DONT / WONT need no answer.
  }

  sendSize() {
    const { cols, rows } = this.getSize();
    const bytes = [IAC, SB, OPT_NAWS];
    for (const n of [cols >> 8, cols & 255, rows >> 8, rows & 255]) {
      bytes.push(n);
      if (n === IAC) bytes.push(IAC); // IAC inside SB data must be doubled
    }
    bytes.push(IAC, SE);
    this.reply(Buffer.from(bytes));
  }
}

/** Escapes outgoing user bytes: IAC doubled, bare CR -> CR NUL. */
function encodeOutgoing(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    out.push(b);
    if (b === IAC) out.push(IAC);
    else if (b === 13 && buf[i + 1] !== 10) out.push(0);
  }
  return Buffer.from(out);
}

exports.TelnetParser = TelnetParser;
exports.encodeOutgoing = encodeOutgoing;

exports.connect = (cfg, io) =>
  new Promise((resolve, reject) => {
    const size = { cols: cfg.cols || 80, rows: cfg.rows || 24 };
    const sock = net.createConnection({
      host: cfg.host,
      port: cfg.port || exports.defaultPort,
    });
    let settled = false;
    sock.setNoDelay(true);
    sock.setTimeout(20000);

    const parser = new TelnetParser({
      reply: (buf) => sock.write(buf),
      getSize: () => size,
    });
    let naws = false;
    const origNegotiate = parser.negotiate.bind(parser);
    parser.negotiate = (cmd, opt) => {
      if (cmd === DO && opt === OPT_NAWS) naws = true;
      origNegotiate(cmd, opt);
    };

    sock.once("connect", () => {
      settled = true;
      sock.setTimeout(0);
      resolve({
        write: (buf) => sock.write(encodeOutgoing(Buffer.from(buf))),
        resize: (cols, rows) => {
          size.cols = cols || 80;
          size.rows = rows || 24;
          if (naws) parser.sendSize();
        },
        close: () => sock.destroy(),
      });
    });
    sock.on("data", (chunk) => {
      const data = parser.feed(chunk);
      if (data.length) io.onData(data);
    });
    sock.on("timeout", () => {
      sock.destroy(Object.assign(new Error("Connection timed out"), { code: "ETIMEDOUT" }));
    });
    sock.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      } else {
        io.onClose(err.message);
      }
    });
    sock.on("close", () => {
      if (settled) io.onClose("Session closed");
    });
  });
