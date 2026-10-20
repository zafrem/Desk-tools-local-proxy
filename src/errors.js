"use strict";

/** An error that maps onto a protocol `error` code (PROTOCOL.md §5.3). */
class ProxyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Best-effort mapping of a Node/driver connection failure to a protocol code. */
function classifyConnectError(err) {
  if (err instanceof ProxyError) return err;
  const msg = (err && err.message) || "Connection failed";
  const nodeCode = err && err.code;
  if (["ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(nodeCode)) {
    return new ProxyError("host_unreachable", msg);
  }
  if (["ETIMEDOUT", "ETIME"].includes(nodeCode) || /timed out|timeout/i.test(msg)) {
    return new ProxyError("timeout", msg);
  }
  if (
    /authentication|auth failed|access denied|password|permission denied|all configured/i.test(msg) ||
    nodeCode === "ER_ACCESS_DENIED_ERROR" ||
    nodeCode === "28P01" || nodeCode === "28000"
  ) {
    return new ProxyError("auth_failed", msg);
  }
  return new ProxyError("connect_failed", msg);
}

module.exports = { ProxyError, classifyConnectError };
