"use strict";

/**
 * Converts driver values into the JSON encoding defined in PROTOCOL.md §5.2:
 * integers beyond ±2^53 as strings, dates as ISO-8601, binary as
 * {"$base64": "..."}; arrays/maps/structs stay JSON.
 */
function normalize(value) {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "bigint":
      return value.toString();
    case "number":
      if (!Number.isFinite(value)) return String(value);
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) return String(value);
      return value;
    case "boolean":
    case "string":
      return value;
    case "object":
      break;
    default:
      return String(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { $base64: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(normalize);
  // node-int64 (used by hive-driver) exposes toString() for the full value.
  if (typeof value.toString === "function" && value.toString !== Object.prototype.toString &&
      !(value.constructor && value.constructor === Object)) {
    const s = value.toString();
    if (s !== "[object Object]") return s;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = normalize(v);
  return out;
}

module.exports = { normalize };
