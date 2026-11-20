// The shape of an aweb team id, `<name>:<namespace>`: the name matches
// ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ and the namespace is a hostname. The hook and the libs
// that need it (a command built from a team id) share this one check.

/** True when `value` is a hostname: dot-separated labels of letters, digits and inner hyphens. */
export function validHostname(value) { const s = String(value || ""); return s.length <= 253 && s.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)); }

/** True when `value` is an aweb team id, `<name>:<namespace>`. */
export function validAwebTeamId(value) { const m = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([^:]+)$/.exec(String(value || "")); return !!m && validHostname(m[2]); }

/** The team id as aw spells it (awid/team_id.go:8-32, BuildTeamID and ParseTeamID, at the
 *  tested version): the name lowercased and trimmed, the domain lowercased, trimmed and
 *  without a trailing dot. Undefined for anything that is not `<name>:<domain>`. */
export function canonicalAwebTeamId(value) {
  if (typeof value !== "string") return undefined;
  const at = value.indexOf(":");
  if (at < 0) return undefined;
  const name = value.slice(0, at).trim().toLowerCase();
  const domain = value.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
  return name && domain ? `${name}:${domain}` : undefined;
}
/** The path, under an identity home, of the file aw holds `team`'s certificate in:
 *  team-certs/<id>.pem, from the canonical id, the one aw names the team by when it writes the
 *  file (cli/go/cmd/aw/id_team.go:1906, :2837 and :3983-3988 at the tested version), encoded
 *  as aw's EncodeTeamIDForCertificatePath encodes it (awconfig/team_certs.go:23-32): each "__"
 *  written as "____", then each ":" as "__". Undefined when `team` is not a team id. */
export function teamCertificateRelativePath(team) {
  const id = canonicalAwebTeamId(team);
  return id === undefined ? undefined : `team-certs/${id.replaceAll("__", "____").replaceAll(":", "__")}.pem`;
}
/** True when aw reads `a` and `b` as one team. */
export const sameAwebTeamId = (a, b) => { const x = canonicalAwebTeamId(a); return x !== undefined && x === canonicalAwebTeamId(b); };
/** The key of `map` (a team-keyed setting such as `roots`) that names `team`: `team`
 *  itself when it is a key, else the one key aw reads as the same team. Undefined when
 *  there is none, or more than one. The key keeps the spelling it was written with. */
export function teamKeyIn(map, team) {
  if (!map || typeof map !== "object" || Array.isArray(map) || typeof team !== "string") return undefined;
  if (Object.hasOwn(map, team)) return team;
  const keys = Object.keys(map).filter((key) => sameAwebTeamId(key, team));
  return keys.length === 1 ? keys[0] : undefined;
}

/** Whether aw's TeamState.Membership takes the membership team id `stored` for `wanted`, the
 *  rule `aw workspace connect --team` finds a seat's membership by (cli/go/awconfig/
 *  team_state.go:100-113 at the tested version): both trimmed as Go's strings.TrimSpace trims,
 *  then strings.EqualFold; an empty `wanted` finds nothing. true or false for ASCII ids;
 *  undefined when either holds a non-ASCII character, whose Unicode case folding is not
 *  reproduced here. This is not sameAwebTeamId, which compares BuildTeamID's canonical form and
 *  so also drops a domain's trailing dot. */
export function membershipTeamMatch(stored, wanted) {
  if (typeof stored !== "string" || typeof wanted !== "string") return false;
  if (/[^\x00-\x7f]/.test(stored) || /[^\x00-\x7f]/.test(wanted)) return undefined;
  const trim = (s) => s.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  const want = trim(wanted);
  return want !== "" && trim(stored).toLowerCase() === want.toLowerCase();
}
