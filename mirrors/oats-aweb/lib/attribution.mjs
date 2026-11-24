// Human attribution (README, "Human attribution"): what aw says about the person an
// identity traces back to, read with `aw --identity-home <home> who --json` (P5 of
// oats docs/design/2026-11-21-human-ids-contract.md), and what the provider does with
// it. It is information: nothing here refuses a spawn or a start. The one decision
// that reads it is how a mint or a join is made (`--parent`, a kept pending home),
// and it reads only aw's `--json` fields, never its prose.
//
// - C1: the kernel's optional `attribution` in the served identity, from the
//   instance's own read (attributionFor).
// - C3: the deployment's record of each root's last verified nearest human, keyed by
//   the root's identity and key, never its label (observeRoot, the lineage record).
// - Signature pending: a mint aw stopped before membership, kept for the operator.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { leadingJsonObject } from "./aw-failure-cause.mjs";
import { versionAtLeast } from "./aw-floor.mjs";
import { didKeyOfSigningKey } from "./member-key.mjs";

/** Every `who` read is bounded at 5 s, run once, never retried. */
export const WHO_TIMEOUT_MS = 5000;
/** The kernel feature that serves `attribution` (`attributedHuman`); read at run time. */
export const SPAWN_ATTRIBUTION_FEATURE = "spawn-attribution";
/** The aw a host needs to mint or join from an adopted root (P4's `--parent`). */
export const AW_ATTRIBUTION = '1.36.59';
/** aw's code for a mint stopped before membership, waiting for an agent signature. */
export const SIGNATURE_PENDING_CODE = "native_agent_signature_pending";
export const ADOPTED_ROOT_AW_TOO_OLD = "E_ADOPTED_ROOT_AW_TOO_OLD";
export const CONNECT_CHAINED_INVITER = "E_CONNECT_CHAINED_INVITER";
export const README_ATTRIBUTION = 'README, "Human attribution"';
/** The README entry, under "Human attribution", for a home left by a mint an older
 *  provider recorded with no issuing key. */
export const README_OLDER_MINT = "A mint cut short under an older provider";
/** What retire's warning says when aw's record proves no signature can be pending
 *  (noSignatureCanBePending): the README's step 2 waits for these words. */
export const NO_SIGNATURE_PENDING_PROOF = "aw's record of the accept is this home key's and names no ID-tree issuer and no human, and aw holds no creator link for this home, so no signature can be pending for it";
export const UNKNOWN_ATTRIBUTION = Object.freeze({ mode: "unknown", human: null, parent: null });

/** A string aw gives that is copied, never interpreted: bounded, no control characters. */
const opaque = (v) => typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v) ? v : undefined;
/** A reason or code aw gives: one short machine word, else nothing. */
const word = (v) => typeof v === "string" && /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(v) ? v : undefined;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A read that gave no answer: carried forward by C1, `unavailable` in C2. */
const noAnswer = (reason) => ({ outcome: "unavailable", answered: false, id: null, humanId: null, parent: null, reason });

/** The structured fields of aw's `--json` error envelope on stdout: `code`,
 *  `httpStatus`, `reason`, each only when it is a machine word (a status a number).
 *  `error.message` is display text and never read. */
export function awErrorEnvelope(stdout) {
  let error;
  try { error = leadingJsonObject(String(stdout ?? "").trim())?.error; } catch { error = undefined; }
  if (!object(error)) return {};
  return {
    ...(word(error.code) ? { code: error.code } : {}),
    ...(Number.isInteger(error.http_status) ? { httpStatus: error.http_status } : {}),
    ...(word(error.reason) ? { reason: error.reason } : {}),
  };
}

/** The next link up from the identity in a verified chain (aw lists it root side
 *  first, ending with the identity itself), or null when the chain doesn't end with it. */
function chainParent(chain, id) {
  if (!Array.isArray(chain) || !id) return null;
  const ids = chain.map((link) => opaque(link?.id));
  if (ids.length < 2 || ids.some((v) => v === undefined) || ids[ids.length - 1] !== id) return null;
  return ids[ids.length - 2];
}

/** One `aw who --json` answer as an observation: `{outcome, answered, id, humanId,
 *  parent, reason}`. `answered` is false for `unavailable` (a value, not a failure)
 *  and for output that isn't an answer; an outcome aw names that isn't
 *  nearest_human, no_human or unavailable reads as `unknown`. */
export function whoObservation(text) {
  let doc;
  try { doc = JSON.parse(String(text ?? "").trim()); } catch { return noAnswer("aw who answered no JSON"); }
  if (!object(doc) || typeof doc.outcome !== "string") return noAnswer("aw who answered no outcome");
  const id = opaque(doc.id) ?? null, reason = word(doc.reason) ?? null;
  if (doc.outcome === "unavailable") return { ...noAnswer(reason ?? "unstated"), id };
  if (doc.outcome === "nearest_human") {
    const humanId = opaque(doc.human_id);
    if (!humanId) return noAnswer("aw who answered nearest_human with no usable human_id");
    return { outcome: "nearest_human", answered: true, id, humanId, parent: chainParent(doc.chain, id), reason };
  }
  return { outcome: doc.outcome === "no_human" ? "no_human" : "unknown", answered: true, id, humanId: null, parent: null, reason };
}

/** P5: `aw --identity-home <identityHome> who --json`, once, within `timeoutMs`.
 *  `runAw(args, timeoutMs)` returns aw's stdout or throws an error carrying
 *  `outcome` (how it ended) and `stdout`. Never throws: a home with no key, no time
 *  left, a non-zero exit, a timeout or output that isn't an answer is an unanswered
 *  read whose reason says which. */
export function readWho(runAw, identityHome, timeoutMs = WHO_TIMEOUT_MS) {
  // No key: no identity to read, and nothing this root could mint either.
  if (!existsSync(join(identityHome, "signing.key"))) return { ...noAnswer(`no aw identity at ${identityHome}`), noIdentity: true };
  if (!(timeoutMs > 0)) return noAnswer("no time left within the read's 5 s bound");
  let text;
  try { text = runAw(["--identity-home", identityHome, "who", "--json"], timeoutMs); }
  catch (e) {
    const { code } = awErrorEnvelope(e?.stdout);
    return noAnswer(`aw who ${e?.outcome || "failed"}${code ? `, error.code ${code}` : ""}`);
  }
  return whoObservation(text);
}

/** Whether `value` is an `attribution` the kernel can show. */
export function validAttribution(value) {
  if (!object(value) || !["human", "none", "unknown"].includes(value.mode)) return false;
  const human = value.human, parent = value.parent;
  if (human !== null && !(object(human) && opaque(human.id) && opaque(human.label))) return false;
  if (parent !== null && !(object(parent) && opaque(parent.id))) return false;
  return value.mode === "human" ? human !== null : human === null && parent === null;
}

/** C1: the served identity's `attribution` for an instance's own read. An answer
 *  replaces what was recorded; no answer carries `previous` forward, or unknown. */
export function attributionFor(observation, previous) {
  if (!observation?.answered) return validAttribution(previous) ? previous : { ...UNKNOWN_ATTRIBUTION };
  if (observation.outcome === "nearest_human") return { mode: "human", human: { id: observation.humanId, label: observation.humanId }, parent: observation.parent ? { id: observation.parent } : null };
  if (observation.outcome === "no_human") return { mode: "none", human: null, parent: null };
  return { ...UNKNOWN_ATTRIBUTION };
}

/** Whether a root's read says it is adopted (P4, item 4): nearest_human, or, when
 *  the read gave no answer, C3's record of it. */
export const adoptedRoot = (observation, record) => observation.answered ? observation.outcome === "nearest_human" : !!record;
/** Whether an inviter is chained (connect): nearest_human or no_human, or, when the
 *  read gave no answer, C3's record of it. */
export const chainedInviter = (observation, record) => observation.answered ? ["nearest_human", "no_human"].includes(observation.outcome) : !!record;
/** Whether a mint's issuing root is known not to be genuinely chainless (a kept
 *  pending home on an aw without the code): its read says chained, or C3 has a record. */
export const chainedIssuer = (observation, record) => (observation.answered && ["nearest_human", "no_human"].includes(observation.outcome)) || !!record;

// ---------------------------------------------------------------------------
// C3: each root's last verified nearest human, at the deployment.
//
// <deployment>/.oats-aweb/root-lineage.json, beside retired-certificates.json, and
// not in the root's own directory: a root restored from a backup taken before its
// adoption would bring back an old record with it, and that is the case the
// warning is for. An entry is {id, key, humanId, seenAt}: the root's identity as aw
// reads it, the did:key of its signing key, the human, and when it was read. Only a
// new nearest_human replaces one; nothing removes one. Writers serialise on a lock
// file beside it as the retired-certificates record's do; a write that can't take it
// within LOCK_WAIT_MS is skipped and said so (the next read records it again).

const LINEAGE_LOCK_WAIT_MS = 500;
/** Whether a read that failed `e` means there is nothing at `path` (README, "Human
 *  attribution"): only when the directory entry itself is absent. A dangling symlink
 *  reads ENOENT but is there, and anything there that can't be read is a problem,
 *  never "none". */
export function entryAbsent(e, path) {
  if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") return false;
  try { lstatSync(path); return false; }
  catch (l) { return l?.code === "ENOENT" || l?.code === "ENOTDIR"; }
}
export const lineageFile = (deployment) => join(deployment, ".oats-aweb", "root-lineage.json");
const validEntry = (e) => object(e) && !!opaque(e.id) && !!opaque(e.key) && !!opaque(e.humanId) && typeof e.seenAt === "string" && !Number.isNaN(Date.parse(e.seenAt));
function parseLineage(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { return null; }
  return object(doc) && doc.version === 1 && Array.isArray(doc.roots) && doc.roots.every(validEntry) ? doc.roots : null;
}

/** The record's entries; `problem` when it can't be read or is malformed (then none). */
export function readLineage(deployment) {
  let text;
  try { text = readFileSync(lineageFile(deployment), "utf8"); }
  catch (e) { return entryAbsent(e, lineageFile(deployment)) ? { entries: [] } : { entries: [], problem: "the record of adopted roots could not be read" }; }
  const entries = parseLineage(text);
  return entries ? { entries } : { entries: [], problem: "the record of adopted roots is malformed" };
}

/** The entry for a root's key and identity. A read that names no identity, or names
 *  the key itself (a did:key read), matches on the key. */
export function lineageEntryFor(entries, { id, key }) {
  if (!key) return undefined;
  return entries.find((e) => e.key === key && (!id || id === key || e.id === id));
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Records `entry`, replacing the one with the same identity and key and keeping
 *  every other: a verified observation is never evicted (C3). Never throws:
 *  returns `{cause}` when nothing was written. */
export function recordLineage(deployment, entry, { lockWaitMs = LINEAGE_LOCK_WAIT_MS } = {}) {
  if (!validEntry(entry)) return { cause: "the observation is not one the record holds" };
  const file = lineageFile(deployment), dir = join(deployment, ".oats-aweb"), lock = `${file}.lock`, tmp = join(dir, `.root-lineage.${process.pid}.tmp`);
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); const { mode } = statSync(dir); if (mode & 0o077) chmodSync(dir, mode & 0o700); }
  catch { return { cause: "the record's directory could not be prepared" }; }
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try { closeSync(openSync(lock, "wx", 0o600)); break; }
    catch (e) { if (e?.code !== "EEXIST") return { cause: "the record's lock could not be taken" }; }
    if (Date.now() >= deadline) return { cause: `another writer holds the record's lock (if none is running, remove ${lock})` };
    sleep(20);
  }
  try {
    // Only a record that isn't there is an empty one: an existing record that can't be
    // read or parsed is left as it is, never replaced by a partial one.
    let text;
    try { text = readFileSync(file, "utf8"); }
    catch (e) { if (!entryAbsent(e, file)) return { cause: `the existing record ${file} could not be read, and is left as it is: move it aside to record roots again` }; }
    const entries = text === undefined ? [] : parseLineage(text);
    if (!entries) return { cause: `the existing record ${file} is malformed, and is left as it is: move it aside to record roots again` };
    const merged = [...entries.filter((e) => !(e.key === entry.key && e.id === entry.id)), { id: entry.id, key: entry.key, humanId: entry.humanId, seenAt: entry.seenAt }];
    writeFileSync(tmp, `${JSON.stringify({ version: 1, roots: merged }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return {};
  } catch { return { cause: "the record could not be written" }; }
  finally {
    try { unlinkSync(tmp); } catch { /* renamed, or never written */ }
    try { unlinkSync(lock); } catch { /* best effort */ }
  }
}

/** The did:key of `<identityHome>/signing.key`, or undefined. */
export function signingDidKey(identityHome) {
  const read = signingKeyRead(identityHome);
  return read.did;
}
/** `<identityHome>/signing.key` read: `{did}`, `{missing: true}` when there is none,
 *  or `{unreadable: true}` when it is there and can't be read or parsed. */
export function signingKeyRead(identityHome) {
  let text;
  try { text = readFileSync(join(identityHome, "signing.key"), "utf8"); }
  catch (e) { return entryAbsent(e, join(identityHome, "signing.key")) ? { missing: true } : { unreadable: true }; }
  try { const did = didKeyOfSigningKey(text); return did ? { did } : { unreadable: true }; } catch { return { unreadable: true }; }
}

/** C3's warning for a root with a record that now reads unknown or no_human, or undefined. */
export function lineageWarning({ name, observation, record }) {
  if (!record || !observation.answered || observation.outcome === "nearest_human") return undefined;
  return `attribution-lineage-missing — root ${name} was verified to ${record.humanId} (${record.seenAt}) and now reads ${observation.outcome} (${observation.reason || "no reason"}): what it mints is attributed to nobody; the way out is a new root (${README_ATTRIBUTION})`;
}

/** One bounded P5 read of a root (`<rootDir>/.aw`), with C3: a nearest_human answer
 *  is recorded at `deployment` (when it is known), and the record's warning given.
 *  Never throws and never refuses: `notes` says what couldn't be read or written. */
export function observeRoot({ runAw, rootDir, deployment, timeoutMs = WHO_TIMEOUT_MS, now = () => new Date(), name = rootDir }) {
  const identityHome = join(rootDir, ".aw");
  const observation = readWho(runAw, identityHome, timeoutMs);
  const key = signingDidKey(identityHome), notes = [];
  let entries = [], lineageRead = false;
  if (deployment && key) { const read = readLineage(deployment); entries = read.entries; lineageRead = !read.problem; if (read.problem) notes.push(`${read.problem} (${lineageFile(deployment)})`); }
  let record = lineageEntryFor(entries, { id: observation.id, key });
  if (deployment && key && observation.answered && observation.outcome === "nearest_human" && observation.id) {
    record = { id: observation.id, key, humanId: observation.humanId, seenAt: now().toISOString() };
    const { cause } = recordLineage(deployment, record);
    if (cause) notes.push(`root ${name}'s adoption was not recorded: ${cause}`);
  }
  // `lineageRead`: whether C3's record store was resolved and read (a store that isn't
  // there yet counts as read): only then does no `record` show the root has none.
  return { observation, record, key, lineageRead, warning: lineageWarning({ name, observation, record }), notes };
}

// ---------------------------------------------------------------------------
// Signature pending: a mint aw stopped before membership (contract §3, §4).

/** aw's files that hold a pending invite selection and any prepared request. */
export const PENDING_MINT_FILES = Object.freeze(["hosted-invite-creation.json", "pending-hosted-accept"]);

/** Whether a failed mint stopped as signature pending, from aw's exit and envelope:
 *  aw's code; or, on an aw without it (below 1.36.59, rc.3 included), the generic
 *  code `error` after aw wrote the member's key, from an issuing root that isn't
 *  genuinely chainless. `{code}` (the code, or null for the fallback) or undefined. */
export function signaturePendingStop({ status, stdout, keyWritten, chained, awVersion }) {
  if (status !== 1) return undefined;
  const { code } = awErrorEnvelope(stdout);
  if (code === SIGNATURE_PENDING_CODE) return { code };
  if (code === "error" && keyWritten && chained && !versionAtLeast(awVersion, AW_ATTRIBUTION)) return { code: null };
  return undefined;
}

const PENDING_RECORD_MAX_BYTES = 1 << 20;
const PENDING_MARKER_BODY = "pending hosted accept\n";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const readBounded = (path, max) => {
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > max) throw new Error("too large");
  return text;
};

/** What binds aw's pending mint in `identityHome` (hosted-invite-creation.json, as aw
 *  1.36.58 and 1.36.59 write and validate it): `selection`, a digest of the invite
 *  selection's token_hash (never the hash itself), `request`, the prepared id_tree
 *  request's id, and `did`, the key the record names. `{selection: null, request: null,
 *  did: null}` with no record; `{unreadable}` when it is there and isn't one aw accepts. */
export function pendingMintBinding(identityHome) {
  let text;
  try { text = readBounded(join(identityHome, PENDING_MINT_FILES[0]), PENDING_RECORD_MAX_BYTES); }
  catch (e) { return entryAbsent(e, join(identityHome, PENDING_MINT_FILES[0])) ? { selection: null, request: null, did: null } : { unreadable: "aw's pending invite record could not be read" }; }
  let doc;
  try { doc = JSON.parse(text); } catch { return { unreadable: "aw's pending invite record is not JSON" }; }
  const tokenHash = object(doc) ? doc.token_hash : undefined, request = object(doc?.id_tree) ? doc.id_tree.request_id : undefined;
  if (!opaque(tokenHash) || typeof request !== "string" || !UUID_RE.test(request) || typeof doc.did_key !== "string" || !/^did:key:z[1-9A-HJ-NP-Za-km-z]{1,128}$/.test(doc.did_key)) return { unreadable: "aw's pending invite record is not one aw accepts" };
  return { selection: createHash("sha256").update(`oats-aweb pending selection\0${tokenHash}`).digest("hex"), request: request.toLowerCase(), did: doc.did_key };
}

/** aw's user state, found as aw finds it: os.UserHomeDir() ($HOME on Unix) joined with
 *  `.config/aw`, with no environment override (awconfig/state.go:10-16,26-33, the same
 *  at aw 1.36.58 and 1.36.59). */
export const awUserStateDir = (userHome) => join(userHome, ".config", "aw");
const CREATOR_LINK_MAX_BYTES = 1 << 20;

/** Whether aw holds a creator link for `identityHome` (or the key `did`): an invite aw
 *  retained in `<user state>/team-invites` (awconfig/team_invites.go:133-146 at aw
 *  1.36.59, aweb b9c015732; :88-101 at 1.36.58) whose `id_child` names this home as
 *  `child_home`, by path or realpath, or this key as `child_did_key` (:21-29; :19-27).
 *  aw saves one before a creator exchange writes anything into the child:
 *  `accept-invite --parent` (1.36.59 invite_condition.go:140, before identity.yaml at
 *  :147, written at :160-170) and `init --join-from` from an adopted root (1.36.58
 *  id_team.go:1761-1765). Its invites are the directory's non-directory `*.json`
 *  entries, read as aw reads them (team_invites.go:237): it skips everything else,
 *  its `<id>.lock` files among them (1.36.59 :81-86, kept after every local-invite
 *  accept) and the `.tmp.*` names of its atomic writes (internal/atomicfile:134, then
 *  a rename). A link that a kill leaves only under a temp name was cut before
 *  prepareInviteChildIdentity ran, so no identity.yaml, request or chain of that
 *  exchange can exist, and noSignatureCanBePending's other checks keep anything
 *  past it. Fail closed: an absent directory (no entry) shows none; one that can't
 *  be listed, or any invite that can't be read as aw writes it, shows nothing.
 *  Undefined when it shows none, else why. */
function creatorLinkHeld(identityHome, did, userHome) {
  if (typeof userHome !== "string" || !isAbsolute(userHome)) return "aw's user state can't be located (no absolute HOME)";
  const dir = join(awUserStateDir(userHome), "team-invites");
  try { lstatSync(dir); } catch (e) { return entryAbsent(e, dir) ? undefined : "aw's retained invites can't be looked at"; }
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return "aw's retained invites can't be listed"; }
  let homeReal;
  try { homeReal = realpathSync(identityHome); } catch { homeReal = undefined; }
  const isThisHome = (p) => {
    if (typeof p !== "string" || !p) return false;
    if (resolve(p) === resolve(identityHome)) return true;
    try { return homeReal !== undefined && realpathSync(p) === homeReal; } catch { return false; }
  };
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory() || !name.endsWith(".json")) continue;
    let doc;
    try { doc = JSON.parse(readBounded(join(dir, name), CREATOR_LINK_MAX_BYTES)); }
    catch { return `aw's retained invite ${name} can't be read as one aw writes`; }
    if (!object(doc)) return `aw's retained invite ${name} is not one aw writes`;
    const link = doc.id_child;
    if (link === undefined || link === null) continue;
    if (!object(link) || !(link.child_home === undefined || typeof link.child_home === "string") || !(link.child_did_key === undefined || typeof link.child_did_key === "string")) {
      return `aw's retained invite ${name} is not one aw writes`;
    }
    if ((link.child_did_key && link.child_did_key === did) || isThisHome(link.child_home)) return `aw holds a creator link for this home (${name})`;
  }
  return undefined;
}

/** Whether aw's record of the accept in `identityHome` shows that no signature can be
 *  pending for it (README, "Human attribution", "A mint cut short under an older
 *  provider"). One bounded read of the record, as aw writes it with its own encoder:
 *  it must parse, its top level and its `id_tree` must be objects, every field read
 *  here must be absent or have aw's type at 1.36.58 and 1.36.59, its `did_key`
 *  must be this home's own key, and it must name no ID-tree issuer (`id_tree.domain`
 *  absent or empty) and no human (`for_human` absent or null). aw prepares no request
 *  for such an invite (aw 1.36.58 cli/go/cmd/aw/hosted_invite_creation.go:94,114;
 *  1.36.59, aweb b9c015732, :247-249,:279-281,:292, where a human with no issuer is
 *  aw's `human_required` refusal, invite_condition.go:55-60). 1.36.59 also saves the
 *  record before its preview (:220-224), with no issuer or human yet: a kill there
 *  has sent nothing but that read and prepared no request, which is #240's case;
 *  the issuer and human are saved before any request (id_team.go:2000-2008,
 *  team_invite_accept.go:267-268). A record cut short by a kill or an IO error
 *  doesn't parse, so it shows nothing. The hosted record isn't the only exchange:
 *  `accept-invite --parent` saves it before a creator exchange of its own (1.36.59
 *  id_team.go:2000-2008, team_invite_accept.go:249-251, invite_condition.go:107-150), whose
 *  outgoing request aw keeps in `<identity-home>/requests`
 *  (cli/go/awconfig/id_request_store.go:41-42) and whose chain it installs at
 *  `<identity-home>/id-chain.json` (id_chain_install.go:25). Any trace of that
 *  exchange (those, or `identity.yaml`), or one that can't be looked at, shows
 *  nothing; so does a creator link aw holds for this home in its user state
 *  (`creatorLinkHeld`). It decides retention rule (c) (`pendingMintRetention`), and
 *  retire's warning quotes it. `{proven: true}`, else `{why}`. */
export function noSignatureCanBePending(identityHome, { userHome = process.env.HOME } = {}) {
  const key = signingKeyRead(identityHome);
  if (!key.did) return { why: key.missing ? "this home has no key" : "this home's key can't be read" };
  const file = join(identityHome, PENDING_MINT_FILES[0]);
  let text;
  try { text = readBounded(file, PENDING_RECORD_MAX_BYTES); }
  catch (e) { return { why: entryAbsent(e, file) ? "aw's pending invite record isn't there" : "aw's pending invite record could not be read" }; }
  let doc;
  try { doc = JSON.parse(text); } catch { return { why: "aw's pending invite record is not JSON (it may have been cut short)" }; }
  if (!object(doc) || !object(doc.id_tree)) return { why: "aw's pending invite record is not one aw writes" };
  const tree = doc.id_tree;
  // Every field aw decodes, by its type in aw's structs at both tags (Go takes null
  // for any of them); a value of another type is a record aw rejects.
  const typed = (v, type) => v === undefined || v === null || (type === "object" ? object(v) : typeof v === type);
  const fields = (o, spec) => Object.entries(spec).every(([k, type]) => typed(o[k], type));
  if (!opaque(doc.token_hash) || typeof tree.request_id !== "string" || !UUID_RE.test(tree.request_id) || typeof doc.did_key !== "string"
    || !fields(doc, { accept_attempted: "boolean", for_human: "string", membership_chain: "object", issuer_creation_started: "boolean", aweb_url: "string", alias: "string", address: "string", scope: "string", no_address: "boolean", stable_id: "string", invite_id: "string", team_id: "string", request_ready: "boolean", response_json: "string" })
    || !fields(tree, { invitation_id: "string", mode: "string", domain: "string", parent: "object", native_chain_header: "string", response_fields_present: "boolean", response_json: "string" })) {
    return { why: "aw's pending invite record is not one aw writes" };
  }
  if (doc.did_key !== key.did) return { why: "aw's pending invite record names another key" };
  if (tree.domain !== undefined && tree.domain !== "") return { why: "aw's record names an ID-tree issuer" };
  if (typeof doc.for_human === "string") return { why: "aw's record names a human" };
  for (const name of ["requests", "id-chain.json", "identity.yaml"]) {
    try { lstatSync(join(identityHome, name)); return { why: `this home holds ${name}, so a creator exchange may be pending` }; }
    catch (e) { if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") return { why: `${name} in this home can't be looked at` }; }
  }
  const link = creatorLinkHeld(identityHome, key.did, userHome);
  if (link) return { why: link };
  return { proven: true };
}

/** Which of aw's pending-mint files are in `identityHome`. One that can't be looked
 *  at (anything but "not there") counts as there: retention fails closed. */
export function pendingMintFilesIn(identityHome) {
  return PENDING_MINT_FILES.filter((name) => {
    try { lstatSync(join(identityHome, name)); return true; }
    catch (e) { return !(e?.code === "ENOENT" || e?.code === "ENOTDIR"); }
  });
}

/** Whether aw's pending files in `identityHome` are the exact mint recorded as
 *  `{did, binding}` at its signature-pending stop: `{exact: true}`, or `{cause}`
 *  saying how they aren't (or can't be shown to be). */
function exactPendingMint(identityHome, present, { did, binding, invalid }) {
  if (invalid) return { cause: "the provider's record of this signature-pending mint is malformed" };
  if (!did) return { cause: "the key aw kept could not be read when the mint stopped" };
  if (binding?.unreadable) return { cause: "aw's pending invite record could not be read when the mint stopped" };
  const key = signingKeyRead(identityHome);
  if (!key.did) return { cause: key.missing ? "the key aw kept is gone while its pending files stay" : "the key aw kept can't be read now" };
  if (key.did !== did) return { cause: "the home holds another key while aw's pending files stay" };
  if (["identity.yaml", "workspace.yaml"].some((name) => existsSync(join(identityHome, name)))) return { cause: "the home holds an identity while aw's pending files stay" };
  if (present.includes(PENDING_MINT_FILES[1])) {
    let body;
    try { body = readBounded(join(identityHome, PENDING_MINT_FILES[1]), 256); } catch { body = null; }
    if (body !== PENDING_MARKER_BODY) return { cause: "aw's pending-accept marker can't be read or is malformed" };
  }
  const now = pendingMintBinding(identityHome);
  if (now.unreadable) return { cause: now.unreadable };
  if (now.did !== null && now.did !== did) return { cause: "aw's pending invite record names another key" };
  if (binding?.selection && (now.selection !== binding.selection || now.request !== binding.request)) {
    return { cause: now.selection === null ? "aw's pending invite record is gone while its pending-accept marker stays" : "aw's pending invite record now names another invite or request" };
  }
  // A stop recorded before aw wrote its invite record (aw 1.36.58 can stop between the
  // key and the record) binds no invite: a record that appears later may be another.
  if (!binding?.selection && now.selection !== null) return { cause: "aw's pending invite record appeared after the mint stopped, so it may be another invite's" };
  return { exact: true };
}

/** Retire's one retention decision for a recorded mint (README, "Human attribution";
 *  fail closed). It settles the mint, `{settle: true}`, only on positive evidence that
 *  keeping it is wrong: (a) aw holds no pending mint in `identityHome` (none of its
 *  pending files is there), or (b) no signature-pending stop was recorded and the
 *  issuing root is genuinely chainless (`issuerChainless()`: P5 reads unknown /
 *  legacy_no_chain, with no C3 record), aw's #240 behaviour, answered as
 *  `{settle: true, chainlessIssuer: true}`: the one settle retire's choke point lets
 *  through while aw's pending files are in that home; or (c) no stop was recorded,
 *  the record is an older provider's with no issuer binding (`unbound`), and aw's own
 *  record proves no signature can be pending, `{settle, chainlessIssuer, proven}`. Otherwise the home is
 *  kept: `{keep: "signature-pending"}` for the exact recorded mint, else
 *  `{keep: "mint-outcome-unknown", cause}`. `signaturePending` is the recorded stop,
 *  undefined when none was recorded. */
export function pendingMintRetention(identityHome, { signaturePending, issuerChainless, unbound = false, userHome = process.env.HOME }) {
  const present = pendingMintFilesIn(identityHome);
  if (!present.length) return { settle: true };
  if (!signaturePending) {
    if (issuerChainless()) return { settle: true, chainlessIssuer: true };
    // A record from an older provider binds no issuer (`unbound`): aw's own record of
    // the accept decides, as #240 settled it, only when it proves no signature can be
    // pending (`noSignatureCanBePending`); anything it doesn't show keeps the home.
    if (unbound) {
      const proof = noSignatureCanBePending(identityHome, { userHome });
      if (proof.proven) return { settle: true, chainlessIssuer: true, proven: true };
      return { keep: "mint-outcome-unknown", cause: "its record, from an older provider, names no issuing key", unproven: proof.why };
    }
    return { keep: "mint-outcome-unknown", cause: "its issuing root isn't shown to be that same root, genuinely chainless" };
  }
  const match = exactPendingMint(identityHome, present, signaturePending);
  return match.exact ? { keep: "signature-pending" } : { keep: "mint-outcome-unknown", cause: match.cause };
}
