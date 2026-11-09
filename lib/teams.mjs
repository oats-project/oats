/**
 * Team model 3 (docs/design/2026-10-02-team-model-3.md, awebai/oats#484), pure.
 *
 * Where teams live:
 *   - the committed oats-workspace.yaml: SHARED teams `teams.<label> = { description?, team? }` (a shared
 *     team without `team` is declared but not yet created: unmapped); `defaultTeam: <label>`, the
 *     workspace's fallback default; `localTeams: true|false` (absent: false), whether deployments may
 *     declare their own teams; and `souls: { <pattern>: { default?, teams?: [labels] | "any" } }`;
 *   - the deployment's oats-local.yaml, only when the workspace says `localTeams: true` (or there is no
 *     workspace file: the standalone view): LOCAL teams `teams.<label> = { team, description? }` and
 *     `defaultTeam: <label>`. Otherwise they are refused (E_WORKSPACE_SCHEMA reason local-teams-closed).
 * A soul's key is its qualified name (teamKeyOf): `<package>/<soul>` or `<member>/<soul>`.
 *
 * Resolution: a `souls:` pattern is the soul's key, then `<member|package>/*`, then "*"; the most specific
 * one that exists gives the soul's teams outright (no merging), and the most specific one that sets a
 * `default` gives its default. Default, in order: that `default` (from "soul"); else the local
 * `defaultTeam` when local teams are allowed ("deployment"); else the workspace's `defaultTeam`
 * ("workspace"); else none. A soul's teams: its default, plus its pattern's `teams` ("any": every shared
 * team), plus every local team when local teams are allowed. A label in both files is
 * `team-label-collision` (the SHARED definition wins). Workspace labels are validated when the file is
 * read (lib/workspace.mjs); a local default no file declares is E_TEAM_UNKNOWN.
 *
 * Rows (docs/desktop-cli-api.md, Teams): TeamRow { label, team, default, from: shared|local, via }, `via`
 * ⊂ ["default", "workspace", "local"] in that order (why the soul may join it); the default first, then
 * by label. Reports carry unmapped rows (team null); OATS_TEAMS and instance.json carry mapped rows only.
 * DefaultTeam { label, team, from: soul|deployment|workspace } | null.
 */
import { oatsError } from "./errors.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v ? v : null);
const labelsOf = (v) => (Array.isArray(v) ? v.filter((l) => typeof l === "string") : []);
const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const pointerKey = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");
function fail(code, message, details) {
  const e = oatsError(code, message, details);
  e.details = details;
  return e;
}

export const LOCAL_FILE = "oats-local.yaml";
/** A provider team id, as both schemas' `teams.*.team` pattern: the kernel's SAFETY rule only (never
 *  `-`-led, so never an option; no whitespace or control characters; bounded). The messaging provider
 *  validates its own id shape. Keep equal to docs/oats-{local,workspace}.schema.json. */
export const TEAM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,255}$/;
/** What 0.30 removed, named by the schema problems that replace them. */
export const TEAM_MEMBERSHIP_MOVED = "a soul's teams are decided by souls: in oats-workspace.yaml (team model 3, OATS 0.38.0)";
export const BY_TEAM_REMOVED = "byTeam was removed in 0.30: a team's provider id is teams.<label>.team (oats-workspace.yaml for a shared team, oats-local.yaml for a local one)";

const UNMAPPED_FIX = "its owner runs `oats aweb setup`, then commits the id";
const CLOSED_FIX = "either (a) add `localTeams: true` to oats-workspace.yaml, or (b) commit the teams and defaultTeam in oats-workspace.yaml, then remove them from oats-local.yaml";

/**
 * The deployment's teams from the committed workspace and oats-local.yaml (either may be null; a null
 * workspace is the standalone view, which has no workspace rules).
 */
export function teamModel(workspace, local, { workspaceKey = null } = {}) {
  const shared = new Map(), localTeams = new Map();
  for (const [label, def] of Object.entries(isObject(workspace?.teams) ? workspace.teams : {})) {
    shared.set(label, { label, team: str(def?.team), description: str(def?.description), from: "shared",
      at: `${workspaceKey ? `${workspaceKey}:` : ""}oats-workspace.yaml#/teams/${pointerKey(label)}` });
  }
  for (const [label, def] of Object.entries(isObject(local?.teams) ? local.teams : {})) {
    localTeams.set(label, { label, team: str(def?.team), description: str(def?.description), from: "local", at: `${LOCAL_FILE}#/teams/${pointerKey(label)}` });
  }
  const standalone = !isObject(workspace);
  const allowed = standalone || workspace.localTeams === true;
  const localKeys = ["teams", "defaultTeam"].filter((k) => isObject(local) && Object.hasOwn(local, k));
  return {
    shared, local: localTeams,
    labels: new Map([...localTeams, ...shared]), // the committed definition wins a collision
    // true | false (the workspace's answer), null in the standalone view.
    localTeams: standalone ? null : allowed,
    // The oats-local.yaml keys the workspace refuses (local-teams-closed); [] when allowed.
    closedKeys: allowed ? [] : localKeys,
    localDefault: allowed ? str(local?.defaultTeam) : null,
    workspaceDefault: standalone ? null : str(workspace.defaultTeam),
    souls: !standalone && isObject(workspace.souls) ? workspace.souls : {},
    soulsAt: `${workspaceKey ? `${workspaceKey}:` : ""}oats-workspace.yaml#/souls`,
  };
}

/** The key a soul has in oats-local.yaml souls.launch: its bare name, or `<package>/<soul>` for a package soul. */
export function soulKeyOf(soulEntry) {
  return typeof soulEntry?.package === "string" && typeof soulEntry.qualifiedName === "string" ? soulEntry.qualifiedName : soulEntry.name;
}
/** A member's name: the last segment of its repo key, without `.git` (`souls.disabled` and team keys use it). */
export function memberNameOf(key) {
  return String(key).split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") || String(key);
}
/** A soul's key in the workspace's `souls:` (team model 3): `<package>/<soul>` for a package soul,
 *  `<member>/<soul>` for any other (its repository's name), as `souls.disabled` qualifies it. */
export function teamKeyOf(soulEntry) {
  if (typeof soulEntry?.package === "string") return typeof soulEntry.qualifiedName === "string" ? soulEntry.qualifiedName : `${soulEntry.package}/${soulEntry.name}`;
  return `${memberNameOf(soulEntry?.repoKey ?? "")}/${soulEntry?.name}`;
}

/**
 * What a team model v2 oats-local.yaml (`souls.teams`, `souls.default`) gave each soul, as the workspace
 * `souls:` that gives the same (0.38.0's removed-key refusal prints it): "*" keeps `souls.teams["*"]`; each
 * soul named gets its default and "*" ∪ its own list, since patterns never merge. A bare (member) soul
 * name becomes `<member>/<soul>`, for the operator to qualify. → { souls } | null when neither key is set.
 */
export function soulsReplacement(local) {
  const teams = isObject(local?.souls?.teams) ? local.souls.teams : null, defaults = isObject(local?.souls?.default) ? local.souls.default : null;
  if (teams === null && defaults === null) return null;
  const star = labelsOf(teams?.["*"]);
  const souls = {};
  if (star.length) souls["*"] = { teams: star };
  const named = [...Object.keys(teams ?? {}), ...Object.keys(defaults ?? {})].filter((k, i, a) => k !== "*" && a.indexOf(k) === i);
  for (const k of named) {
    const def = str(defaults?.[k]);
    const list = [...star, ...labelsOf(teams?.[k])].filter((l, i, a) => a.indexOf(l) === i);
    souls[k.includes("/") ? k : `<member>/${k}`] = { ...(def !== null ? { default: def } : {}), teams: list };
  }
  return { souls };
}

/** Every discovered soul's key (teamKeyOf): confirmed members' (and a standalone view's own), external and
 *  package souls. The typo guard (`team-soul-unknown`) checks the workspace's `souls:` keys against it. */
export function discoveredTeamKeys(discovery) {
  const keys = new Set();
  for (const m of discovery?.members || []) if (m.confirmed || (discovery.standalone === true && m.key === discovery.key)) for (const s of m.souls || []) keys.add(teamKeyOf(s));
  for (const x of discovery?.external || []) if (x?.soul) keys.add(teamKeyOf({ ...x.soul, repoKey: x.soul.repoKey ?? x.key }));
  for (const s of discovery?.packageSouls || []) keys.add(teamKeyOf(s));
  return keys;
}

/** The `souls:` patterns that apply to `key`, most specific first. */
const patternsOf = (key) => (key === "*" ? ["*"] : [key, `${key.slice(0, key.lastIndexOf("/"))}/*`, "*"]);

const unknown = (label, at) => fail("E_TEAM_UNKNOWN", `team ${JSON.stringify(label)} is not declared (${at}): declare it with \`oats teams add\`, or in oats-workspace.yaml teams: for a shared team`, { label, at });
const closedMessage = (keys) => `${LOCAL_FILE} declares ${keys.join(", ")}, but oats-workspace.yaml does not allow local teams (localTeams: true): ${CLOSED_FIX}`;
/** Whether `e` refuses a soul's TEAMS (an undeclared label, or local teams the workspace does not allow):
 *  readiness reports it as a team item, a home falls back to its recorded teams. */
export const isTeamRefusal = (e) => e?.code === "E_TEAM_UNKNOWN" || (e?.code === "E_WORKSPACE_SCHEMA" && e?.details?.reason === "local-teams-closed");
/** Whether `e` refuses oats-local.yaml for the team keys 0.38.0 removed (`souls.teams` / `souls.default`):
 *  a reader that otherwise falls back to a home's recorded teams must answer it instead. */
export const isRemovedTeamKeys = (e) => e?.code === "E_WORKSPACE_SCHEMA" && Array.isArray(e?.details?.problems)
  && e.details.problems.some((p) => p?.reason === "removed-key" && /^\/souls\/(teams|default)$/.test(p.path));
/** The refusal of local teams the workspace does not allow (E_WORKSPACE_SCHEMA reason local-teams-closed). */
export const localTeamsClosed = (keys, { verb = null } = {}) => fail("E_WORKSPACE_SCHEMA",
  verb ? `${verb} writes ${keys.join(", ")} in ${LOCAL_FILE}, but oats-workspace.yaml does not allow local teams (localTeams: true): ${CLOSED_FIX}` : closedMessage(keys),
  { reason: "local-teams-closed", path: LOCAL_FILE, keys: [...keys] });

/**
 * One soul's teams here (key "*": what the "*" pattern gives).
 * → { key, match, defaultMatch, defaultTeam: DefaultTeam | null, teams: [TeamRow] }; `match` / `defaultMatch`
 * are the `souls:` keys its teams / its default come from (null: none). Throws E_WORKSPACE_SCHEMA
 * (local-teams-closed) / E_TEAM_UNKNOWN.
 */
export function soulTeams(model, key) {
  if (model.closedKeys.length) throw localTeamsClosed(model.closedKeys);
  const patterns = patternsOf(key);
  const match = patterns.find((p) => isObject(model.souls[p])) ?? null;
  const defaultMatch = patterns.find((p) => isObject(model.souls[p]) && typeof model.souls[p].default === "string") ?? null;
  if (model.localDefault !== null && !model.labels.has(model.localDefault)) throw unknown(model.localDefault, `${LOCAL_FILE}#/defaultTeam`);
  const [defaultLabel, from] = defaultMatch !== null ? [model.souls[defaultMatch].default, "soul"]
    : model.localDefault !== null ? [model.localDefault, "deployment"]
    : model.workspaceDefault !== null ? [model.workspaceDefault, "workspace"] : [null, null];
  const via = new Map();
  const add = (label, why) => { if (!model.labels.has(label)) return; const v = via.get(label) ?? []; if (!v.includes(why)) v.push(why); via.set(label, v); };
  if (defaultLabel !== null) add(defaultLabel, "default");
  const listed = match === null ? [] : model.souls[match].teams === "any" ? [...model.shared.keys()] : labelsOf(model.souls[match].teams);
  for (const l of listed) add(l, "workspace");
  if (model.localTeams !== false) for (const l of model.local.keys()) add(l, "local");
  const teams = [...via].map(([label, v]) => {
    const d = model.labels.get(label);
    return { label, team: d.team, default: label === defaultLabel, from: d.from, via: v };
  }).sort((a, b) => (b.default - a.default) || byCodepoint(a.label, b.label));
  const defaultTeam = defaultLabel === null || !model.labels.has(defaultLabel) ? null : { label: defaultLabel, team: model.labels.get(defaultLabel).team, from };
  return { key, match, defaultMatch, defaultTeam, teams };
}

/** TeamRows as the reports carry them (unmapped included). A row a home recorded before team model 3 has
 *  no `via`, and is reported as recorded (its eligibility is not guessed). */
export const reportRows = (teams) => (teams || []).map(({ label, team, default: d, from, via }) => ({ label, team, default: d, from, ...(Array.isArray(via) ? { via: [...via] } : {}) }));
/** TeamRows as OATS_TEAMS and instance.json carry them: mapped only. */
export const envRows = (teams) => reportRows(teams).filter((r) => r.team !== null);

/** Every reference to `label` in oats-local.yaml, in written order (`oats teams remove` refuses on any). */
export function teamReferences(model, label) {
  return model.localDefault === label ? ["defaultTeam"] : [];
}

const collisionProblem = (label, shared, local) => ({
  code: "team-label-collision", label, severity: "warning",
  shared: { team: shared.team, description: shared.description, at: shared.at },
  local: { team: local.team, description: local.description, at: local.at },
  message: `team ${label} is declared in both oats-workspace.yaml (shared) and oats-local.yaml (local); the shared definition wins`,
  fix: "rename the local label in oats-local.yaml",
});
/** Where another default is chosen: where this one comes from (`t` is soulTeams' answer). */
const otherDefault = (t) => t.defaultTeam?.from === "soul" ? `in the souls: entry ${t.defaultMatch} of oats-workspace.yaml`
  : t.defaultTeam?.from === "workspace" ? "defaultTeam in oats-workspace.yaml" : "with `oats teams default`";
const unmappedProblem = (d, t) => d.label === t.defaultTeam?.label
  ? { code: "team-unmapped", label: d.label, default: true, severity: "failure", at: d.at, message: `the default team ${d.label} has no provider id yet`,
    fix: `${UNMAPPED_FIX}; or choose another ${t.defaultTeam.from === "workspace" ? "" : "default "}${otherDefault(t)}` }
  : { code: "team-unmapped", label: d.label, default: false, severity: "warning", at: d.at, message: `shared team ${d.label} has no provider id yet`, fix: UNMAPPED_FIX };
/** No default: committed in the workspace file, or recorded here where local teams are allowed (the standalone
 *  view has only the local way). */
const unconfiguredProblem = (model) => ({ code: "E_TEAM_UNCONFIGURED", severity: "failure", message: "no teams configured: run `oats aweb setup`",
  fix: model.localTeams === null ? "run `oats aweb setup` (it creates the teams and sets the default), or `oats teams add <label> --team <id>`"
    : `run \`oats aweb setup\` to create a team, then commit it in oats-workspace.yaml as defaultTeam (or as a soul's default in souls:)${model.localTeams ? ", or record it here with `oats teams add <label> --team <id>`" : ""}` });
const refusalProblem = (e) => ({ code: e.code, ...e.details, severity: "failure", message: e.message,
  fix: "declare the team (`oats teams add`), or choose another default (`oats teams default`)" });
const soulUnknownProblem = (key, at) => ({ code: "team-soul-unknown", severity: "warning", key, at,
  message: `souls: ${key} names no soul of this workspace (a pattern is "*" or <member|package>/*)`, fix: "correct the key to a soul's qualified name (oats souls lists them), or remove it" });
/** local-teams-closed as a problem (oats teams, readiness, doctor): the refusal's facts, never thrown. */
export const localTeamsClosedProblem = (keys) => ({ code: "E_WORKSPACE_SCHEMA", severity: "failure", condition: "local-teams-closed", path: LOCAL_FILE, keys: [...keys],
  message: closedMessage(keys), fix: CLOSED_FIX });

/**
 * Readiness problems. Without `key`: the deployment's (`oats teams`): collisions, unmapped shared teams
 * (a failure when it is the default a soul without a souls: default gets), an unknown local default.
 * With `key`: only what concerns that soul (`default` marks ITS default). Local teams the workspace does
 * not allow are the one problem either way. `messaging`: a messaging layer is active, so no default is
 * E_TEAM_UNCONFIGURED. `soulKeys` (discoveredTeamKeys; null when the souls are not known): a `souls:` key
 * that is neither a pattern nor one of them is `team-soul-unknown` (a typo guard, either way).
 */
export function teamProblems(model, { key = null, messaging = false, soulKeys = null } = {}) {
  if (model.closedKeys.length) return [localTeamsClosedProblem(model.closedKeys)];
  const problems = [];
  // An undeclared local default is reported; the rest is judged as if it were not set.
  if (model.localDefault !== null && !model.labels.has(model.localDefault)) problems.push(refusalProblem(unknown(model.localDefault, `${LOCAL_FILE}#/defaultTeam`)));
  const t = soulTeams(problems.length ? { ...model, localDefault: null } : model, key ?? "*");
  const labels = key !== null ? t.teams.map((r) => r.label) : [...model.labels.keys()].sort(byCodepoint);
  for (const label of labels) if (model.shared.has(label) && model.local.has(label)) problems.push(collisionProblem(label, model.shared.get(label), model.local.get(label)));
  for (const label of labels) { const d = model.labels.get(label); if (d.team === null) problems.push(unmappedProblem(d, t)); }
  if (messaging && t.defaultTeam === null && model.localDefault === null) problems.push(unconfiguredProblem(model));
  if (soulKeys !== null) for (const k of Object.keys(model.souls).sort(byCodepoint)) {
    if (k !== "*" && !k.endsWith("/*") && !soulKeys.has(k)) problems.push(soulUnknownProblem(k, `${model.soulsAt}/${pointerKey(k)}`));
  }
  return problems;
}

/**
 * The provider environment (docs/desktop-cli-api.md, The provider environment) from a soul's teams
 * `{ defaultTeam, teams, source: "live"|"recorded" }`, or null when they are not known. A name that
 * does not apply is `undefined`, so a child process never inherits an ambient value. The pre-0.30
 * names are always unset.
 */
export function teamsEnv(t) {
  const known = isObject(t) && Array.isArray(t.teams);
  const d = known && isObject(t.defaultTeam) ? t.defaultTeam : null;
  return {
    OATS_DEFAULT_TEAM: d?.label ?? undefined,
    OATS_DEFAULT_TEAM_ID: d?.team ?? undefined,
    OATS_DEFAULT_TEAM_FROM: d?.from ?? undefined,
    OATS_TEAMS: known ? JSON.stringify(envRows(t.teams)) : undefined,
    OATS_TEAMS_SOURCE: known && (t.source === "live" || t.source === "recorded") ? t.source : undefined,
    OATS_TEAM_LABEL: undefined, OATS_TEAM_LABELS: undefined, OATS_TEAM_ID: undefined,
  };
}

/** A home's spawn-time teams (instance.json `teams` / `defaultTeam`) → { teams, defaultTeam }; teams null
 *  when the home recorded none in this shape (spawned before 0.30: its teams are unknown, never guessed). */
export function recordedTeams(meta) {
  const rows = Array.isArray(meta?.teams) && meta.teams.every((r) => isObject(r) && typeof r.label === "string" && typeof r.default === "boolean") ? meta.teams : null;
  const d = isObject(meta?.defaultTeam) && typeof meta.defaultTeam.label === "string" ? meta.defaultTeam : null;
  return { teams: rows, defaultTeam: rows ? d : null };
}
