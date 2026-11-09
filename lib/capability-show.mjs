/**
 * lib/capability-show.mjs — `oats capabilities show` (feature capability-show, capabilityShowApi 1): what one
 * catalog row of `oats capabilities` ships — its inject text and each skill's files — and one file's text on
 * request, read at the row's commit through the read path a spawn uses. Contract: docs/desktop-cli-api.md
 * "`oats capabilities show`".
 *
 * - A member row is read from its member repository at the row's commit, a package row at the LOCKED commit,
 *   after the lock check a spawn makes (lockedCapability: the package's capability list there is the lock's).
 *   The package's full-tree digest is not recomputed: `oats sync` proved the lock's integrity over the tree of
 *   exactly that commit, and the commit id content-addresses the tree.
 * - Skills are the spawn's enumeration (capabilitySkills over enumerateSkills, lib/resolve.mjs); a skill's
 *   files are every regular file under its directory (listRemoteFiles), at most FILES_PER_SKILL.
 * - Every read goes through lib/remote.mjs at a full commit id: nothing reads a working clone and nothing is
 *   written outside the remote cache.
 * - Paths in the answers are POSIX and relative to the capability directory. `--file` reads only a path the
 *   show lists (the inject, a listed skill file): no other file of the capability is readable through it.
 *
 * - A manifest that declares `triggerSources` (#669) shows them exactly as declared, and the problems a trigger
 *   naming them would get (lib/trigger-sources.mjs) as `triggerSourceProblems`: a malformed declaration never
 *   refuses the show (containment), as it never refuses the capability.
 *
 * Every text is untrusted repository content; a consumer renders it as plain text or through a sanitising
 * renderer (the docs say so).
 */
import { posix } from "node:path";
import YAML from "yaml";
import { oatsError } from "./errors.mjs";
import { bindRemote } from "./packages.mjs";
import { FILE_BUDGET } from "./remote.mjs";
import { locatedContractWarnings } from "./capability-contract.mjs";
import { capabilitySkills, lockedCapability, lockedPackageCapabilities, manifestFilePath, memberRef, unsafeRelPath } from "./resolve.mjs";
import { memberRowByKey } from "./workspace.mjs";
import { sameRepo } from "./repo-moves.mjs";
import { triggerSourcesOf } from "./trigger-sources.mjs";

export const CAPABILITY_SHOW_API = 1;
/** A text is cut to at most this many UTF-8 bytes; binary detection examines this many + 3. */
export const TEXT_LIMIT = 262144;
/** A skill lists at most this many files (`filesTruncated` beyond). */
export const FILES_PER_SKILL = 200;
/** A skill's `description` is cut to at most this many UTF-8 bytes. */
export const DESCRIPTION_LIMIT = 1024;

function fail(code, message, details) {
  const e = oatsError(code, message, details);
  if (details !== undefined) e.details = details;
  return e;
}
const isOatsError = (e) => typeof e?.code === "string" && e.code.startsWith("E_");
const decoder = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const isContinuation = (byte) => (byte & 0xc0) === 0x80;

/** The cut of `bytes` at most `limit` long, on a code point boundary (bytes are valid UTF-8 there). */
function cutAt(bytes, limit) {
  if (bytes.length <= limit) return bytes.length;
  let cut = limit;
  while (cut > 0 && isContinuation(bytes[cut])) cut--;
  return cut;
}

/**
 * A file's bytes as the answers carry them: → { text, binary, truncated }. Binary when the examined bytes (the
 * first TEXT_LIMIT + 3) hold a NUL or are not valid UTF-8 (TextDecoder fatal, BOM kept); otherwise `text` is
 * the content cut to at most TEXT_LIMIT bytes on a code point boundary, `truncated` when cut. The examined
 * bytes include the whole code point that straddles the limit, so the cut is decided on the same bytes.
 */
export function decodeText(bytes, limit = TEXT_LIMIT) {
  const head = bytes.subarray(0, limit + 3);
  const binary = { text: null, binary: true, truncated: false };
  if (head.includes(0)) return binary;
  // A file longer than the examined bytes may continue a valid sequence they end inside of: `stream` accepts
  // such an incomplete tail, and still refuses every invalid byte among them.
  try { decoder().decode(head, { stream: bytes.length > head.length }); }
  catch { return binary; }
  const cut = cutAt(bytes, limit);
  return { text: decoder().decode(bytes.subarray(0, cut)), binary: false, truncated: cut < bytes.length };
}

/** `text` cut to at most `limit` UTF-8 bytes on a code point boundary. */
export function cutUtf8(text, limit) {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= limit ? text : bytes.subarray(0, cutAt(bytes, limit)).toString("utf8");
}

/** Codepoint order of two strings: the order of their UTF-8 bytes, which a skill's files are listed in. */
export const compareCodepoints = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

const FRONT_MATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;
/** The `description` of a SKILL.md's leading `---` YAML front matter (a string only), cut to DESCRIPTION_LIMIT
 *  bytes; null when there is no front matter, it does not parse, or the key is absent or not a string. */
export function skillDescription(text) {
  if (typeof text !== "string") return null;
  const m = FRONT_MATTER_RE.exec(text.replace(/^\uFEFF/, ""));
  if (!m) return null;
  let data;
  try { data = YAML.parse(m[1] ?? "", { logLevel: "error" }); } catch { return null; }
  if (data === null || typeof data !== "object" || Array.isArray(data) || typeof data.description !== "string") return null;
  return cutUtf8(data.description, DESCRIPTION_LIMIT);
}

/** A `--file` path no listing could hold (lib/resolve.mjs unsafeRelPath): absolute, empty, a `.`/`..`/`.git`
 *  component (any case), an empty component, a trailing slash, a backslash or a NUL. */
export const unsafeFilePath = unsafeRelPath;

/** The text a SKILL.md's description is parsed from: the whole readable file (its front matter may run past the
 *  display cut), null when the file is binary by decodeText's rule. */
function skillText(bytes) {
  if (decodeText(bytes).binary) return null;
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}
/** A SKILL.md is read for its description up to this many bytes, the remote read budget (FILE_BUDGET). */
export const SKILL_DOC_BUDGET = FILE_BUDGET;
/** A SKILL.md's description from its bytes (`size`: the file's size): null for a file over SKILL_DOC_BUDGET, which
 *  is not read whole, or a binary one. `capabilities show` and `inspect --soul --skills` both describe by it. */
export function skillDocDescription(bytes, size = bytes.length) {
  return size > SKILL_DOC_BUDGET ? null : skillDescription(skillText(bytes));
}

/** The catalog row a show reads: rows named `name`, narrowed by `--member <repoKey>` (a member row of that
 *  repository) or `--package <id>` (that package's row). 0 → E_CAPABILITY_UNKNOWN; >1 → E_CAPABILITY_AMBIGUOUS. */
export function selectCapabilityRow(rows, name, { member = null, package: pkg = null } = {}) {
  let matches = rows.filter((r) => r.name === name);
  if (member !== null) matches = matches.filter((r) => r.kind === "member" && sameRepo(r.repoKey, member));
  if (pkg !== null) matches = matches.filter((r) => r.kind === "package" && r.package === pkg);
  const selector = member !== null ? { member } : pkg !== null ? { package: pkg } : {};
  if (matches.length === 0) {
    const where = member !== null ? ` from member ${member}` : pkg !== null ? ` from package ${pkg}` : "";
    throw fail("E_CAPABILITY_UNKNOWN", `no capability ${JSON.stringify(name)}${where} in this workspace's catalog (\`oats capabilities\` lists them; a package's capabilities appear after \`oats sync\`)`, { name, ...selector });
  }
  if (matches.length > 1) {
    const candidates = matches.map((r) => (r.kind === "package" ? { kind: r.kind, package: r.package, origin: r.origin } : { kind: r.kind, repoKey: r.repoKey, origin: r.origin }));
    throw fail("E_CAPABILITY_AMBIGUOUS", `${matches.length} capabilities are named ${JSON.stringify(name)} (${candidates.map((c) => c.origin).join("; ")}): choose one with --member <repoKey> or --package <id>`, { name, candidates });
  }
  return matches[0];
}

/**
 * Where a catalog row is read from: → { name, kind, repoKey, package, version, commit, ref, dir, manifest,
 * missingCode }. A member row from discovery (its capability path and manifest, the member's ref); a package
 * row from its manifests at the locked commit, after the spawn's lock check (E_PACKAGE_INTEGRITY).
 */
export async function capabilitySource(row, { discovery, lock, catalog = null, remote, remoteOptions }) {
  if (row.kind === "package") {
    const entry = lock?.packages?.[row.package];
    if (!entry) throw fail("E_CAPABILITY_UNKNOWN", `package ${row.package} is not in the lock — run \`oats sync\``, { name: row.name, package: row.package });
    const { ref, capabilities } = await lockedPackageCapabilities(row.package, entry, { catalog, remote, remoteOptions });
    const cap = lockedCapability(row.name, row.package, entry, capabilities);
    return { name: row.name, kind: "package", repoKey: remote.parseRepoRef(ref).key, package: row.package, version: entry.version, commit: entry.commit, ref, dir: cap.dir, manifest: cap.manifest, missingCode: "E_PACKAGE_MANIFEST" };
  }
  const cap = memberRowByKey(discovery.members, row.repoKey)?.capabilities.find((c) => c.name === row.name);
  if (!cap) throw fail("E_CAPABILITY_UNKNOWN", `no capability ${JSON.stringify(row.name)} in member ${row.repoKey}`, { name: row.name, member: row.repoKey });
  return { name: row.name, kind: "member", repoKey: row.repoKey, package: null, version: null, commit: row.commit, ref: memberRef(discovery, remote, row.repoKey), dir: cap.path, manifest: cap.manifest, missingCode: "E_CAPABILITY_MISSING" };
}

const problemOf = (e, path) => ({ code: e.code, message: e.message, path });

/** What a source lists, without reading any file's content: → { inject: { path (null when unsafe), safe } | null,
 *  skills: [{ name, path, files: [{ path, bytes }] | null, filesTruncated }] | null, problems }. */
async function listing(source, { remote, remoteOptions }) {
  const r = bindRemote(remote, remoteOptions);
  const { ref, commit, dir, manifest, missingCode } = source;
  const problems = [];
  let inject = null;
  if (typeof manifest.inject === "string" && manifest.inject) {
    const path = manifestFilePath(manifest.inject);
    // An unsafe declared path is never put in a `path` field (every path in the answers is safe): null, and the
    // raw value only inside the problem's message.
    inject = { path, safe: path !== null };
    if (!path) problems.push({ code: missingCode, message: `${source.name} declares inject ${JSON.stringify(manifest.inject)}, which is not a relative path inside the capability`, path: null });
  }
  const { skills: found, problem } = await capabilitySkills({ ref, commit, dir, manifest, remote, remoteOptions, missingCode });
  if (!found) problems.push(problemOf(problem, null));
  const skills = found && [];
  for (const skill of found ?? []) {
    // A skill whose files cannot be listed has `files: null` (and a problem): never "listed nothing".
    // Only the listed files' sizes are learned: nothing past FILES_PER_SKILL is fetched (#409).
    let listed = null;
    try { listed = await r.listRemoteFiles(ref, commit, posix.join(dir, skill.path), { limit: FILES_PER_SKILL }); }
    catch (e) { if (!isOatsError(e)) throw e; problems.push(problemOf(e, skill.path)); }
    skills.push({ name: skill.name, path: skill.path, files: listed && listed.files.map((f) => ({ path: `${skill.path}/${f.path}`, bytes: f.size })), filesTruncated: listed !== null && listed.total > FILES_PER_SKILL });
  }
  return { inject, skills, problems };
}

const header = (source) => ({ capabilityShowApi: CAPABILITY_SHOW_API, name: source.name, kind: source.kind });
/** What the capability declares and this kernel ignores (an unknown hook event), where its manifest is read. */
const contractWarnings = (source) => locatedContractWarnings(source.manifest, source.kind === "package" ? `package:${source.package}:${source.dir}/oats.json` : `${source.repoKey}:${source.dir}/oats.json`);

/** The trigger sources a manifest declares, as declared, and their use-time problems: added keys, each only when
 *  there is something to say. */
function triggerSourceKeys(manifest) {
  if (manifest?.triggerSources === undefined) return {};
  const { problems } = triggerSourcesOf(manifest);
  return { triggerSources: manifest.triggerSources, ...(problems.length ? { triggerSourceProblems: problems } : {}) };
}

/** The show answer (capabilityShowApi 1): the inject with its text, each skill with its description and files. */
export async function capabilityShow(source, { remote, remoteOptions }) {
  const r = bindRemote(remote, remoteOptions);
  const { ref, commit, dir } = source;
  const listed = await listing(source, { remote, remoteOptions });
  const problems = [...listed.problems];
  let inject = null;
  if (listed.inject) {
    inject = { path: listed.inject.path, bytes: null, text: null, binary: false, truncated: false };
    if (listed.inject.safe) {
      try { const { bytes, size } = await r.readRemoteFile(ref, commit, posix.join(dir, inject.path)); inject = { path: inject.path, bytes: size, ...decodeText(bytes) }; }
      catch (e) { if (!isOatsError(e)) throw e; problems.push(problemOf(e, inject.path)); }
    }
  }
  let skills = null;
  if (listed.skills) {
    skills = [];
    for (const skill of listed.skills) {
      let description = null;
      try {
        const { bytes, size } = await r.readRemoteFile(ref, commit, posix.join(dir, skill.path, "SKILL.md"));
        description = skillDocDescription(bytes, size);
      } catch (e) { if (!isOatsError(e)) throw e; }
      skills.push({ name: skill.name, path: skill.path, description, files: skill.files, filesTruncated: skill.filesTruncated });
    }
  }
  return { ...header(source), repoKey: source.repoKey, package: source.package, version: source.version, commit, path: dir, inject, skills, problems, warnings: contractWarnings(source), ...triggerSourceKeys(source.manifest) };
}

/** The `--file` answer: one file the show lists (the inject, or a listed skill file), at the row's commit.
 *  E_CAPABILITY_FILE_UNSAFE for a path no listing could hold; E_CAPABILITY_FILE_UNKNOWN for one it does not
 *  list; the remote's own refusal (E_REMOTE_FILE_OVERSIZE, …) for one it lists but cannot read. */
export async function capabilityFile(source, path, { remote, remoteOptions }) {
  if (unsafeFilePath(path)) throw fail("E_CAPABILITY_FILE_UNSAFE", `${JSON.stringify(path)} is not a relative path inside the capability`, { path });
  const listed = await listing(source, { remote, remoteOptions });
  const known = (listed.inject?.safe && listed.inject.path === path) || (listed.skills ?? []).some((s) => (s.files ?? []).some((f) => f.path === path));
  if (!known) throw fail("E_CAPABILITY_FILE_UNKNOWN", `${path} is not a file \`oats capabilities show ${source.name}\` lists (the inject, or a skill's files)`, { path, name: source.name });
  const { bytes, size } = await bindRemote(remote, remoteOptions).readRemoteFile(source.ref, source.commit, posix.join(source.dir, path));
  return { ...header(source), commit: source.commit, file: { path, bytes: size, ...decodeText(bytes) }, warnings: contractWarnings(source) };
}
