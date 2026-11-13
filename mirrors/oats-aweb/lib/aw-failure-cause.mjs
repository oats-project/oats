// The cause of a failed aw call whose output is withheld because it can hold a
// credential (an invite mint), named from a fixed vocabulary: aw's own text is
// matched, never relayed (awebai/oats-aweb#52).

/** The refusal codes read from aw's --json error envelope
 *  (`{"error":{"code":...}}`, aw 1.36.52-rc.3 and later). A code is a fixed
 *  word, so naming it leaks nothing; anything else is never read. */
export const AW_ERROR_CODES = new Set(["unknown_or_invalid"]);

/** Transport failures as Go's net, net/http and crypto/tls word them in the aw
 *  binary: a dial (tcp, tcp4, tcp6), DNS, refused/reset/unreachable, timeouts
 *  (i/o, deadline, TLS handshake, the client's own), TLS and certificate
 *  errors, and a connection that ended early (`Post "…": EOF`). */
const NETWORK_FAILURE_RE = /\b(?:dial tcp[46]?|no such host|connection refused|connection reset|network is unreachable|i\/o timeout|context deadline exceeded|tls handshake timeout|client\.timeout exceeded)\b|\btls: |\bx509: |": (?:unexpected )?EOF\b/i;

/** The `detail.code` an aweb service may refuse with, as a fixed table: the
 *  code is remote text, so it is named only when the table lists it or the
 *  WHOLE string is one short snake_case word; anything else is the generic
 *  SERVICE_REFUSED (awebai/oats-aweb#202). */
export const SERVICE_DETAIL_CODES = new Set(["service_url_mismatch", "awid_team_not_found", "awid_team_controller_mismatch", "awid_team_missing_controller", "invalid_controller_signature", "invalid_controller_timestamp", "validation_error"]);
export const SERVICE_REFUSED = "service-refused";
const SERVICE_DETAIL_CODE_RE = /^[a-z][a-z0-9_]{0,47}$/;
export function serviceDetailCode(code) {
  return typeof code === "string" && (SERVICE_DETAIL_CODES.has(code) || SERVICE_DETAIL_CODE_RE.test(code)) ? code : SERVICE_REFUSED;
}

/** A key aw needs that is not on this machine, as aw words it: a BYOT team
 *  create without the namespace controller key ("no local controller key for
 *  --namespace D", or "load controller key for D: ..." when loading it fails),
 *  and an invite or register without the team key ("no team key for D/N",
 *  "local team controller key for N:D was not found"). Checked before
 *  anything else: these are the actionable causes. */
export const NAMESPACE_CONTROLLER_KEY_MISSING = "the namespace controller key for this namespace is not on this machine";
export const TEAM_KEY_MISSING = "the team key is not on this machine";
const LOCAL_KEY_CAUSES = [
  [/\bno local controller key for\b|\bload controller key for\b/i, NAMESPACE_CONTROLLER_KEY_MISSING],
  [/\bno team key for\b|\blocal team controller key for \S+ was not found\b/i, TEAM_KEY_MISSING],
];

/** The JSON object that `text` starts with, ignoring whatever follows it. */
export function leadingJsonObject(text) {
  let depth = 0, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(text.slice(0, i + 1));
  }
  throw new Error("unterminated JSON object");
}

/** aw's --json error code (`{"error":{"code":...}}` leading its stdout), only
 *  when AW_ERROR_CODES lists it. */
export function awErrorCode(stdout) {
  try {
    const code = leadingJsonObject(String(stdout ?? "").trim())?.error?.code;
    return AW_ERROR_CODES.has(code) ? code : undefined;
  } catch { return undefined; }
}

/** Whether aw's --json error envelope on stdout is a refusal of the alias because
 *  another member holds it: code `alias_conflict` (aw's name for the registry's
 *  `alias_active`), or AWID's `self_custody_reinit_unproven` as the reason of an
 *  `http_error` (aw awid/error_detail.go DescribeError). Only those two fields are
 *  read, never the message. */
export function awAliasRefusal(stdout) {
  try {
    const error = leadingJsonObject(String(stdout ?? "").trim())?.error;
    return error?.code === "alias_conflict" || (error?.code === "http_error" && error?.reason === "self_custody_reinit_unproven");
  } catch { return false; }
}

/** The cause of a failure with no HTTP status: a missing local key, else
 *  aw's allowlisted error code, else a network or TLS failure in its output,
 *  else that the output held none of these. */
export function withheldFailureCause({ stderr, stdout }) {
  const text = `${stderr ?? ""}\n${stdout ?? ""}`;
  const key = LOCAL_KEY_CAUSES.find(([re]) => re.test(text));
  if (key) return key[1];
  const code = awErrorCode(stdout);
  if (code) return `aw error ${code}`;
  if (NETWORK_FAILURE_RE.test(text)) return "the aweb service could not be reached: a network or TLS failure";
  return "no HTTP status, aw error code or network failure in its output";
}

/** A namespace domain as aw normalizes it before it uses or prints one
 *  (awconfig.NormalizeDomain): trimmed, lowercased, without one trailing dot. */
export function normalizeAwDomain(domain) {
  const lower = String(domain ?? "").trim().toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/** Whether `aw id team create --name <name> --namespace <domain> --json` was
 *  refused because the name is already held in the namespace under a team key
 *  that is not this machine's (awebai/oats-aweb#208). Read only from aw's --json
 *  error envelope, in exactly the two shapes aw 1.36.56 prints for it
 *  (ensureLocalTeamRegistered): "team <domain>/<name> is already pinned to
 *  <did:key>" under code `error`, and the registry's own 409 under code
 *  `http_error` ("create team at registry: ..."). A re-create with this
 *  machine's own key is not a refusal: aw answers it as created. */
export function teamNameTaken(stdout, domain, name) {
  domain = normalizeAwDomain(domain);
  let error;
  try { error = leadingJsonObject(String(stdout ?? "").trim())?.error; } catch { return false; }
  if (!error || typeof error.message !== "string") return false;
  if (error.code === "error") {
    const pinned = `team ${domain}/${name} is already pinned to did:key:`;
    return error.message.startsWith(pinned) && /^\S+$/.test(error.message.slice(pinned.length));
  }
  return error.code === "http_error" && error.http_status === 409 && error.message.startsWith("create team at registry: ");
}

/** Whether aw's --json answer to `aw id team show-server` is that no team-server record is
 *  published for `team` (aw 1.36.56 id_team_server.go:226-227: the registry's 404, a plain error). */
export function teamServerRecordMissing(stdout, team) {
  let error;
  try { error = leadingJsonObject(String(stdout ?? "").trim())?.error; } catch { return false; }
  return error?.code === "error" && error.message === `no team server record is published for ${team}`;
}
