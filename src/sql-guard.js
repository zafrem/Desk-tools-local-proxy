"use strict";

/**
 * Read-only filter for the query services (see PROTOCOL.md §6).
 *
 * This is a convenience filter, NOT a security boundary: the real boundary is
 * the database account the user connects with.
 */

const ALLOWED_FIRST_WORDS = new Set(["select", "with", "show", "describe", "desc", "explain"]);

/**
 * Walks the SQL once, dropping comments and tracking string literals.
 * Returns the statement with comments replaced by a single space, and the
 * positions of every top-level `;`.
 */
function scan(sql, backslashEscapes) {
  let out = "";
  const semicolons = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) return { error: "unterminated comment" };
      i = end + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      // Quote chars are doubled to escape ('' "" ``). Whether a backslash also
      // escapes depends on the dialect (MySQL/Hive yes; Postgres/Trino no), so
      // checkReadOnly scans both ways and rejects any statement they disagree on.
      const quote = c;
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (backslashEscapes && sql[j] === "\\" && quote !== "`") {
          j += 2;
          continue;
        }
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) return { error: "unterminated string literal" };
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else {
      if (c === ";") semicolons.push(out.length);
      out += c;
      i++;
    }
  }
  return { text: out, semicolons };
}

/**
 * @param {string} sql
 * @returns {{ ok: true, sql: string } | { ok: false, reason: string }}
 */
function checkReadOnly(sql) {
  if (typeof sql !== "string" || !sql.trim()) {
    return { ok: false, reason: "Empty statement" };
  }
  const scanned = scan(sql, false);
  const alt = scan(sql, true);
  if (
    scanned.error !== alt.error ||
    (!scanned.error && (scanned.text !== alt.text || scanned.semicolons.length !== alt.semicolons.length))
  ) {
    return { ok: false, reason: "Ambiguous quoting (backslash in a string literal); rewrite the statement" };
  }
  if (scanned.error) return { ok: false, reason: `Could not parse statement: ${scanned.error}` };

  let text = scanned.text.trim();
  // Allow exactly one trailing semicolon.
  const trailing = text.endsWith(";");
  const body = trailing ? text.slice(0, -1).trim() : text;
  const inner = scanned.semicolons.length - (trailing ? 1 : 0);
  if (inner > 0) return { ok: false, reason: "Only one statement is allowed" };
  if (!body) return { ok: false, reason: "Empty statement" };

  const first = /^[A-Za-z]+/.exec(body.replace(/^\(+\s*/, ""));
  if (!first || !ALLOWED_FIRST_WORDS.has(first[0].toLowerCase())) {
    return {
      ok: false,
      reason: "Only SELECT (and WITH, SHOW, DESCRIBE, EXPLAIN) statements are allowed",
    };
  }
  return { ok: true, sql: body };
}

module.exports = { checkReadOnly };
