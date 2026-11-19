// Canonical JSON, turn ids, and signed-field consistency for turn.jsonl v1.
// Contract: docs/turn-record-sot.md in this package. The byte rules intentionally
// match awid message signing (sorted keys, minimal separators, no HTML
// escaping, ensure_ascii=false) so the same canonical form serves both.

import { createHash } from "node:crypto";

export class CanonicalError extends Error {}

// Canonical JSON serialization. Numbers must be integers within the safe
// range: float serialization is not canonical across languages, so floats
// are forbidden anywhere in a turn's canonical core.
export function canonicalJson(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new CanonicalError(`non-integer number in canonical core: ${value}`);
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (t === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  throw new CanonicalError(`unsupported value in canonical core: ${t}`);
}

// Canonical core = the turn without `id` and `sig`.
export function coreString(turn) {
  const core = {};
  for (const k of Object.keys(turn)) {
    if (k !== "id" && k !== "sig") core[k] = turn[k];
  }
  return canonicalJson(core);
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function turnId(turn) {
  return "t1:" + sha256Hex(Buffer.from(coreString(turn), "utf8"));
}

// Return a copy of `core` (a turn without id/sig) with its computed id.
export function finishTurn(core) {
  return { ...core, id: turnId(core) };
}

export function verifyTurnId(turn) {
  return typeof turn.id === "string" && turnId(turn) === turn.id;
}

// Value equality via canonical bytes — `to` may legally be an array, so a
// reference compare would flag every multi-recipient turn read from disk.
function sameValue(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return canonicalJson(a) === canonicalJson(b);
}

// Consistency rule for turns that carry a source signed_payload: readable
// duplicated fields must equal the signed_payload fields (the payload is
// authoritative). Throws CanonicalError on violation.
export function checkSignedConsistency(turn) {
  const p = JSON.parse(turn.signed_payload);
  const pairs = [
    [turn.ts, p.timestamp, "ts/timestamp"],
    [turn.from, p.from, "from"],
    [turn.to, p.to, "to"],
    [turn.body?.subject, p.subject, "body.subject/subject"],
    [turn.body?.text, p.body, "body.text/body"],
  ];
  for (const [a, b, what] of pairs) {
    if (!sameValue(a, b)) throw new CanonicalError(`signed consistency violation on ${what}`);
  }
}
