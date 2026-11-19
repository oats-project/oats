// OATS desktop — CLI locator/probe (Desktop CLI API v1).
//
// The app's ONLY path to lifecycle mutations is a compatible installed
// `oats` CLI (desktop-dist contract). This module finds it:
//
//   discovery order (first acceptable candidate wins):
//     1. persisted user-selected absolute executable
//     2. OATS_DESKTOP_OATS_BIN (test/development only)
//     3. the app process PATH
//     4. npm global-prefix candidates
//     5. login-shell `command -v oats` with a timeout
//
// Every candidate is canonicalized to an absolute executable and accepted
// ONLY if executable and `<bin> version --json` returns the v1 probe:
//   {"schemaVersion":1,"name":"@awebai/oats","version":"0.24.x","desktopApi":1}
// Desktop accepts desktopApi === 1 and a released semver at or above the floor
// (ACCEPT_RANGE.min). There is no ceiling: a CLI of a later minor than the
// client's own release (its TESTED BOUND, testedBound below) is accepted and
// flagged `aboveTested`, and the client then holds back every operation its
// allowlist does not name (above-tested.mjs, oats-project/oats#1879).
// API version — not source adjacency — is authoritative.
//
// Pure/injected: all process, fs and exec effects come through `io` so the
// discovery matrix and acceptance rules are unit-testable and
// mutation-checkable without a real CLI.
import { delimiter, isAbsolute, join } from "node:path";
import { harnessList } from "./harness-names.mjs";

export const DESKTOP_API = 1;
// The floor is hand-set: the first kernel the Desktop's feature gates let through (workspace-cli
// WORKSPACE_FEATURES, deployment-contract DEPLOYMENT_FEATURES); those gates stay the REAL gate.
//
// The upper bound is not spelled here, nor anywhere (oats-project/oats#1879, option 3). It is the
// TESTED BOUND: the minor of the client's own release version, which the caller passes in (the
// Desktop server its own manifest, packages/desktop/package.json; `oats tui` its kernel's
// package.json, which is the kernel it runs). Until 0.69.x it was an exclusive ceiling widened by
// hand at every minor, and every installed Desktop lost every action at each kernel minor until it
// was reinstalled. Now a CLI of a later minor or major is accepted with `aboveTested: true`, and
// only the operations above-tested.mjs allows stay on. The version-bump PR moves the bound with the
// manifests; nothing in release prep moves it by hand.
export const ACCEPT_RANGE = Object.freeze({ min: Object.freeze([0, 26, 0]) });
/** [major, minor] of a client's release version: the newest CLI minor it was tested with. A
 * prerelease or build of a release counts as that release (0.70.0-rc.1 tests 0.70). null for a value
 * that is not a version. */
export function testedBound(releaseVersion) {
  const v = parseSemver(releaseVersion);
  return v ? [v.nums[0], v.nums[1]] : null;
}
/** The bound as people read it: "X.Y". */
export const testedThroughText = (bound) => `${bound[0]}.${bound[1]}`;
/** The accepted range as humans read it, derived and never hand-spelled, so the probe rejection
 * reason, the backend's /api/cli and the degradation card can never disagree with what is enforced:
 * the floor, then the tested bound of `releaseVersion` (">=0.26.0, tested through 0.69"). */
export function acceptRangeText(releaseVersion) {
  const bound = testedBound(releaseVersion);
  return `>=${ACCEPT_RANGE.min.join(".")}${bound ? `, tested through ${testedThroughText(bound)}` : ""}`;
}
// The npm names of the oats CLI. `version --json` answers the first under either, until a later minor flips it.
export const PROBE_NAME = Object.freeze(["@awebai/oats", "@oats-project/oats"]);
// Spawn-time agent relations (--relation/--relative-to) AND the anchor
// qualifier (--relative-root, a later contract addition in the same
// unreleased feature) gate on ONE floor: the first release carrying BOTH.
// Older v1 CLIs IGNORE unknown spawn options and still succeed, so a
// pre-relations CLI would silently spawn an UNRELATED instance — and a
// hypothetical relations-only CLI would silently DISCARD --relative-root
// and link the wrong same-named anchor (review cbd5bb3 blocker). No
// released CLI carries relations without the qualifier (0.18.x releases to
// date predate both, and they merge together), so one floor covers the
// whole related-spawn surface; if the kernel ever ships them separately
// this must split into two probed capabilities. 0.18.5 released WITHOUT
// the feature, so the floor is the NEXT release — the first one containing
// feature/agent-relations. Confirmed at PR time (one-constant change).
export const RELATIONS_MIN = [0, 18, 6];

/** Whether an ACCEPTED v1 CLI version also supports spawn-time relations. */
export function supportsRelations(version) {
  const v = parseSemver(version);
  return !!v && !v.prerelease && cmp(v.nums, RELATIONS_MIN) >= 0;
}

/** Fail-closed gate for RELATED spawns (invariant-bearing, importable so the
 * regression exercises this exact layer): returns an Error to THROW when a
 * relation/anchor was requested but the accepted CLI predates relation
 * support, else null. */
export function relationSupportError(cliState, { relation, relativeTo } = {}) {
  // "unrelated" (or empty) is the DEFAULT, not a related spawn — the adapter
  // normalizes it to absence (spawnArgv) and forwards no flags, so it must
  // keep working across the full accepted v1 range (review 9425d6a). A
  // supplied relativeTo still gates: the adapter rejects the mismatched pair.
  const rel = relation === "unrelated" || relation === "" ? undefined : relation;
  if (!rel && !relativeTo) return null;
  if (cliState?.ok && supportsRelations(cliState.version)) return null;
  const err = new Error(`spawn-time relations require oats >= ${RELATIONS_MIN.join(".")} — installed ${cliState?.version || "none"} would silently spawn an unrelated instance`);
  err.code = "cli-no-relations";
  return err;
}

// ---- acceptance --------------------------------------------------------

export function parseSemver(v) {
  // Capture prerelease presence: semver precedence puts 0.18.0-rc.1 BELOW
  // 0.18.0, so a prerelease of the minimum version is OUTSIDE >=0.18.0.
  const m = String(v || "").match(/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: !!m[4] };
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Accept/reject one probe payload against the client's own release version (`testedVersion`,
 * required: see ACCEPT_RANGE). Returns:
 *   { ok: true }                                             a CLI of the tested minor or older, down to the floor;
 *   { ok: true, aboveTested: true, testedThrough: "X.Y" }    a released CLI of a later minor or major;
 *   { ok: false, reason }                                    refused, and { ok: false, reason, newerApi: true }
 *                                                            when the payload's sole failure is a desktopApi
 *                                                            above this client's: the Desktop is the older of the
 *                                                            two (views/cli-status.mjs reads the flag, never the
 *                                                            reason's words).
 * Without a tested version it refuses: a caller that forgot it never falls back to "no bound". */
export function acceptProbe(payload, testedVersion) {
  const bound = testedBound(testedVersion);
  if (!bound) return { ok: false, reason: "no tested client version given: the probe is not judged without one" };
  if (!payload || typeof payload !== "object") return { ok: false, reason: "no probe payload" };
  if (payload.schemaVersion !== 1) return { ok: false, reason: `unexpected schemaVersion ${payload.schemaVersion}` };
  if (!PROBE_NAME.includes(payload.name)) return { ok: false, reason: `not the oats CLI (name: ${payload.name || "missing"}, not ${PROBE_NAME.join(" or ")})` };
  if (payload.desktopApi !== DESKTOP_API) {
    // Another API, newer than this client's: the client is the older (the card's older-Desktop branch). Only an
    // integer counts; every other check already passed.
    const newer = Number.isSafeInteger(payload.desktopApi) && payload.desktopApi > DESKTOP_API;
    return { ok: false, reason: `desktopApi ${payload.desktopApi ?? "missing"} (need ${DESKTOP_API})`, ...(newer ? { newerApi: true } : {}) };
  }
  const v = parseSemver(payload.version);
  if (!v) return { ok: false, reason: `unparsable version "${payload.version}"` };
  const range = acceptRangeText(testedVersion);
  // Prerelease policy: prereleases are NOT accepted. Precedence-wise
  // 0.18.0-rc.1 < 0.18.0 (below the minimum), and a prerelease of any
  // version is not a released CLI — Desktop pairs with released kernels only,
  // above its tested bound as below it.
  if (v.prerelease) return { ok: false, reason: `prerelease version ${payload.version} not accepted (need a released ${range})` };
  if (cmp(v.nums, ACCEPT_RANGE.min) < 0) return { ok: false, reason: `version ${payload.version} outside ${range}` };
  if (v.nums[0] > bound[0] || (v.nums[0] === bound[0] && v.nums[1] > bound[1])) return { ok: true, aboveTested: true, testedThrough: testedThroughText(bound) };
  return { ok: true };
}

/** stdout must be exactly one JSON document (the CLI contract). */
export function parseProbeStdout(stdout) {
  try {
    const doc = JSON.parse(String(stdout));
    return doc && typeof doc === "object" ? doc : null;
  } catch { return null; }
}

// ---- discovery -----------------------------------------------------------

/**
 * Candidate absolute paths as LAZY thunks in contract order, each tagged
 * with its source. Sources are evaluated only when discovery reaches them
 * (review 53a20c7: the npm-prefix and login-shell helpers cost seconds —
 * they must not run when an earlier candidate already wins) and each
 * expensive source is invoked AT MOST ONCE.
 * io = {
 *   persisted: () => string|null            — user-chosen absolute path
 *   env: Record<string,string|undefined>    — process env
 *   isExecutableFile: (p) => boolean        — X_OK regular file
 *   npmGlobalBin: () => string|null|Promise — npm prefix -g /bin (slow)
 *   loginShellWhich: () => string|null|Promise — login-shell command -v (slow)
 * }
 */
export function candidateSources(io) {
  const abs = (p) => (typeof p === "string" && p && isAbsolute(p) ? p : null);
  const sources = [
    { source: "persisted", paths: () => [abs(io.persisted?.())] },
    // test/development only — never documented for end users
    { source: "env", paths: () => [abs(io.env?.OATS_DESKTOP_OATS_BIN)] },
    { source: "path", paths: () => String(io.env?.PATH || "").split(delimiter).filter(Boolean).map((dir) => abs(join(dir, "oats"))) },
    { source: "npm-global", paths: async () => { const bin = await io.npmGlobalBin?.(); return [abs(bin && join(bin, "oats"))]; } },
    { source: "login-shell", paths: async () => [abs(await io.loginShellWhich?.())] },
  ];
  return sources;
}

/** Eager candidate list — for tests/diagnostics only (evaluates everything). */
export async function candidates(io) {
  const out = [];
  for (const s of candidateSources(io)) {
    for (const p of await s.paths()) if (p) out.push({ path: p, source: s.source });
  }
  return out;
}

/**
 * The kernel record of an ACCEPTED probe payload: what every gate of this home reads (`bin`, `version`,
 * the API integers, `features`, `remote`). A field is kept only in the form its gate reads: a list
 * when the payload has a list, an API integer only at the value that is gated on. `discover` answers
 * this for the candidate that wins. A client that probes one known kernel reads the answer with
 * `parseProbeStdout`, accepts it with `acceptProbe`, and makes its record with this: it does not
 * call `acceptProbe` itself, so a payload that was not accepted must not reach it.
 */
export function cliRecord(payload, { bin, source }) {
  return { ok: true, bin, source, version: payload.version,
    ...(harnessList(payload) ? { harnesses: harnessList(payload) } : {}),
    ...(Array.isArray(payload.sessionBackends) ? { sessionBackends: payload.sessionBackends } : {}),
    ...(Array.isArray(payload.launchOptions) ? { launchOptions: payload.launchOptions } : {}),
    ...([1, 2].includes(payload.scheduleApi) ? { scheduleApi: payload.scheduleApi } : {}),
    ...(payload.operationsApi === 2 ? { operationsApi: 2 } : {}),
    ...(payload.lifecycleApi === 1 ? { lifecycleApi: 1 } : {}),
    ...(payload.readinessApi === 2 ? { readinessApi: 2 } : {}),
    ...(payload.spawnPreviewApi === 2 ? { spawnPreviewApi: 2 } : {}),
    ...(payload.spawnApplyApi === 1 ? { spawnApplyApi: 1 } : {}),
    ...(payload.eventsApi === 2 ? { eventsApi: 2 } : {}),
    ...(payload.scheduleHistoryApi === 3 ? { scheduleHistoryApi: 3 } : {}),
    ...(payload.workspaceApi === 2 ? { workspaceApi: 2 } : {}),
    ...(payload.automationsApi === 1 ? { automationsApi: 1 } : {}),
    ...(payload.capabilityShowApi === 1 ? { capabilityShowApi: 1 } : {}),
    ...(payload.readerApi === 1 ? { readerApi: 1 } : {}),
    ...(Array.isArray(payload.features) ? { features: payload.features } : {}),
    ...(typeof payload.sessionViewer?.prefixScroll === "boolean" ? { sessionViewer: { prefixScroll: payload.sessionViewer.prefixScroll } } : {}),
    ...(Array.isArray(payload.remote) ? { remote: payload.remote } : {}) };
}

/**
 * Discover the first acceptable CLI. `probe(path)` runs `<path> version
 * --json` (execFile, absolute binary, no shell) and resolves { stdout } on
 * CLEAN exit — it must REJECT on nonzero exit or timeout even when stdout
 * looks valid (review 53a20c7: a binary that prints a plausible probe and
 * then fails/hangs must never become the mutation binary). Sources are
 * evaluated lazily: expensive helpers never run once a candidate wins.
 * `io.testedVersion` is the client's own release version (acceptProbe): required, and without it
 * every candidate is refused.
 * Returns:
 *   { ok:true,  bin, source, version, aboveTested?, testedThrough? }  — the cliRecord, flagged when the
 *                                                    CLI is of a later minor than the tested bound
 *   { ok:false, tried: [{path, source, reason}] }   — stable diagnostics; an entry whose probe was
 *                                                    refused only for a newer desktopApi also has
 *                                                    `version` and `newerApi: true` (acceptProbe)
 */
export async function discover(io, probe) {
  const tried = [];
  const seen = new Set();
  for (const src of candidateSources(io)) {
    let paths = [];
    try { paths = (await src.paths()).filter(Boolean); }
    catch { continue; /* source itself failed — e.g. npm missing */ }
    for (const raw of paths) {
      let path = raw;
      try { path = io.canonicalize ? io.canonicalize(path) : path; } catch { /* keep as-is */ }
      if (seen.has(path)) continue;
      seen.add(path);
      if (!io.isExecutableFile(path)) { tried.push({ path, source: src.source, reason: "not an executable file" }); continue; }
      let payload = null;
      try {
        const r = await probe(path);
        payload = parseProbeStdout(r.stdout);
      } catch (e) {
        // Probe REJECTED (nonzero exit, timeout, spawn failure) — the
        // candidate is out even if it printed a plausible payload first.
        tried.push({ path, source: src.source, reason: `probe failed: ${String(e.message || e).slice(0, 120)}` });
        continue;
      }
      const a = acceptProbe(payload, io.testedVersion);
      if (a.ok) return { ...cliRecord(payload, { bin: path, source: src.source }), ...(a.aboveTested === true ? { aboveTested: true, testedThrough: a.testedThrough } : {}) };
      tried.push({ path, source: src.source, reason: a.reason, version: payload?.version, ...(a.newerApi === true ? { newerApi: true } : {}) });
    }
  }
  return { ok: false, tried };
}

/** Remote routing arrived within API v1; older accepted CLIs lack it. */
export function requireRemoteSupport(cli, operation) {
  // Array.isArray, not optional chaining alone: String.prototype.includes
  // would let a probe answering remote: "spawn" (a string) pass a gate that
  // exists to fail closed (servers review N1).
  if (!Array.isArray(cli?.remote) || !cli.remote.includes(operation)) throw Object.assign(new Error(`installed oats ${cli?.version || "unknown"} does not support remote ${operation}; update the CLI`), { code: "unsupported-remote-operation" });
}
