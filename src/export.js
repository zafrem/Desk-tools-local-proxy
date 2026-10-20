"use strict";

// Serialises a query result ({columns, rows}) for the CLI. Rows are already in
// the PROTOCOL.md §5.2 encoding (see values.js).

const FORMATS = ["csv", "json", "ndjson", "table"];

/** Plain text for one cell: NULL is empty, binary is its base64, nested values are JSON. */
function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (!Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$base64 === "string") return v.$base64;
    return JSON.stringify(v);
  }
  return String(v);
}

const csvField = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function toCsv({ columns, rows }) {
  const lines = [columns.map((c) => csvField(c.name)).join(",")];
  for (const row of rows) lines.push(row.map((c) => csvField(cellText(c))).join(","));
  return lines.join("\n") + "\n";
}

/** Column names made unique (`id`, `id_2`) so object rows never lose a column. */
function uniqueNames(columns) {
  const seen = new Map();
  return columns.map((c) => {
    const n = (seen.get(c.name) || 0) + 1;
    seen.set(c.name, n);
    return n === 1 ? c.name : `${c.name}_${n}`;
  });
}

function toJson({ columns, rows, rowCount, truncated }) {
  return JSON.stringify({ columns, rows, rowCount, truncated }, null, 2) + "\n";
}

function toNdjson({ columns, rows }) {
  const names = uniqueNames(columns);
  return rows.map((r) => JSON.stringify(Object.fromEntries(r.map((v, i) => [names[i], v])))).join("\n") + (rows.length ? "\n" : "");
}

function toTable({ columns, rows }) {
  const text = rows.map((r) => r.map((c) => (c === null ? "NULL" : cellText(c)).replace(/\s+/g, " ")));
  const widths = columns.map((c, i) => Math.min(60, Math.max(c.name.length, ...text.map((r) => r[i].length))));
  const fmt = (cells) => cells.map((c, i) => (c.length > widths[i] ? c.slice(0, widths[i] - 1) + "…" : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [fmt(columns.map((c) => c.name)), widths.map((w) => "-".repeat(w)).join("  "), ...text.map(fmt)].join("\n") + "\n";
}

function formatResult(result, format) {
  switch (format) {
    case "csv": return toCsv(result);
    case "json": return toJson(result);
    case "ndjson": return toNdjson(result);
    case "table": return toTable(result);
    default: throw new Error(`Unknown format "${format}" (use ${FORMATS.join(", ")})`);
  }
}

module.exports = { FORMATS, formatResult, cellText };
