"use strict";

const { ProxyError } = require("../errors");

/**
 * Trino sends BIGINT as a JSON number, and JSON.parse would round anything
 * beyond 2^53. Quote such integers (outside strings only) before parsing so
 * they arrive as strings, as PROTOCOL.md §5.2 requires.
 */
function quoteUnsafeIntegers(text) {
  let out = "";
  let last = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++;
      const token = text.slice(i, j);
      if (/^-?\d{16,}$/.test(token) && !Number.isSafeInteger(Number(token))) {
        out += text.slice(last, i) + '"' + token + '"';
        last = j;
      }
      i = j - 1;
    }
  }
  return last === 0 ? text : out + text.slice(last);
}

exports.quoteUnsafeIntegers = quoteUnsafeIntegers;

exports.kind = "query";
exports.defaultPort = 8080;

/**
 * Trino speaks plain HTTP: POST the statement, then follow `nextUri` until it
 * disappears (https://trino.io/docs/current/develop/client-protocol.html).
 */
exports.connect = async (cfg) => {
  const base = `${cfg.tls ? "https" : "http"}://${cfg.host}:${cfg.port || exports.defaultPort}`;
  if (cfg.password && !cfg.tls) {
    throw new ProxyError("bad_message", "Trino password authentication requires tls: true");
  }
  const headers = {
    "X-Trino-User": cfg.username,
    "X-Trino-Source": "desk-tools-local-proxy",
  };
  if (cfg.catalog) headers["X-Trino-Catalog"] = cfg.catalog;
  if (cfg.schema) headers["X-Trino-Schema"] = cfg.schema;
  if (cfg.password) {
    headers.Authorization = "Basic " + Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
  }

  const get = async (url, init = {}) => {
    const res = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (!res.ok && res.status !== 204) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) throw new ProxyError("auth_failed", `HTTP ${res.status}: ${body.slice(0, 200)}`);
      throw new ProxyError("query_failed", `HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.status === 204 ? {} : JSON.parse(quoteUnsafeIntegers(await res.text()));
  };

  // Connectivity + credentials check, and the server version for `info`.
  const info = await get(`${base}/v1/info`);

  let nextUri = null;
  let controller = null;

  return {
    serverVersion: info && info.nodeVersion && info.nodeVersion.version,

    async query(sql, { timeoutMs, maxRows }) {
      controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new ProxyError("timeout", "Query timed out")), timeoutMs);
      let columns = [];
      const rows = [];
      try {
        let page = await get(`${base}/v1/statement`, { method: "POST", body: sql, signal: controller.signal });
        for (;;) {
          nextUri = page.nextUri || null;
          if (page.error) throw new ProxyError("query_failed", page.error.message || "Query failed");
          if (page.columns && !columns.length) columns = page.columns.map((c) => ({ name: c.name, type: c.type }));
          if (page.data) for (const r of page.data) if (rows.length <= maxRows) rows.push(r);
          if (!page.nextUri) break;
          if (rows.length > maxRows) {
            // One row past the limit marks `truncated`; stop the query on the server.
            await fetch(page.nextUri, { method: "DELETE", headers }).catch(() => {});
            nextUri = null;
            break;
          }
          page = await get(page.nextUri, { signal: controller.signal });
        }
        return { columns, rows };
      } catch (err) {
        if (controller.signal.aborted) {
          const reason = controller.signal.reason;
          throw reason instanceof ProxyError ? reason : new ProxyError("cancelled", "Query cancelled");
        }
        throw err;
      } finally {
        clearTimeout(timer);
        nextUri = null;
        controller = null;
      }
    },

    async cancel() {
      const uri = nextUri;
      if (controller) controller.abort(new ProxyError("cancelled", "Query cancelled"));
      if (uri) await fetch(uri, { method: "DELETE", headers }).catch(() => {});
    },

    async close() {},
  };
};
