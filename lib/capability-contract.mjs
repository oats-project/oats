/** The capability manifest's kernel contract, shared by every reader: workspace
 *  discovery (member capabilities, E_WORKSPACE_SCHEMA), package manifests
 *  (E_PACKAGE_MANIFEST), the resolver (payload values) and the kernel's own
 *  manifest loader. One rule set, so a manifest a workspace accepts is one the
 *  kernel can run.
 *
 *  Covers what the kernel enforces when it RUNS a capability, checked where the
 *  manifest is READ instead: the launch environment a capability may declare
 *  (names, namespaces), its hooks (approved events, an unknown one a warning unless
 *  required; declaration shape, `required` only on spawn and worktree, the script
 *  inside the capability), and a provider payload's value against the manifest's
 *  `settings.<key>.values`. Dependency-free. */

export const APPROVED_HOOKS = new Set(["soul-scaffold", "spawn", "retire", "launch", "worktree", "upgrade"]);
/** The events whose hook may be declared `required: true`: each has a moment
 *  that can fail closed (a spawn's transaction; `oats worktree add`, which
 *  removes the tree it made). Upgrade instead enforces its own adoption
 *  protocol independently of the `required` flag. */
export const REQUIRABLE_HOOKS = new Set(["spawn", "worktree"]);
export const PORTABLE_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const CAPABILITY_ENV_ID_RE = /^[a-z][a-z0-9]*\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
export const CORE_LAUNCH_ENV = new Set(["OATS_INSTANCE", "OATS_INSTANCE_HOME"]);
export const PROCESS_BOOTSTRAP_ENV = new Set([
  "PATH", "HOME", "SHELL", "TMPDIR", "TMP", "TEMP", "PWD", "OLDPWD", "SHLVL", "_",
  "ENV", "BASH_ENV", "BASHOPTS", "SHELLOPTS", "CDPATH", "IFS", "PROMPT_COMMAND", "PS4", "ZDOTDIR",
  "NODE_OPTIONS", "NODE_PATH", "_JAVA_OPTIONS", "GCONV_PATH", "GLIBC_TUNABLES", "ELECTRON_RUN_AS_NODE",
]);
/** The names the kernel sets for a module command itself: never read from the caller's environment,
 *  so never an entry, or under an entry's prefix, of a manifest's `readsEnvironment`. */
export const READS_RESERVED_PREFIXES = ["OATS_", "OAS_", "PI_"];
export const PROCESS_BOOTSTRAP_PREFIXES = [
  "NODE_", "LD_", "DYLD_", "PYTHON", "PERL", "RUBY", "JAVA_", "JDK_JAVA_",
  "DOTNET_", "COMPlus_", "COREHOST_", "LUA_", "PHP_", "ELECTRON_", "GLIBC_",
];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const pointerKey = (k) => String(k).replace(/~/g, "~0").replace(/\//g, "~1");

/** A hook's script, the first word of its command: relative to the capability root and inside it. */
export function hookScriptEscapes(command) {
  const script = String(command).trim().split(/\s+/)[0] || "";
  return script.startsWith("/") || script.startsWith("~") || /^[A-Za-z]:[\\/]/.test(script) || script.split(/[\\/]/).includes("..");
}

/** Every contract problem of one manifest → [{ pointer, message }] (empty when it is sound).
 *  The problems of `manifestContract`, for a reader that has no warning channel. */
export function manifestContractProblems(m) {
  return manifestContract(m).problems;
}

/** One manifest against the kernel contract → { problems, warnings }, each
 *  [{ pointer, message }] (warnings also carry `code`). A problem refuses the
 *  manifest; a warning names what this kernel ignores in a manifest it accepts.
 *  Messages name the capability; `pointer` is the JSON pointer inside oats.json.
 *
 *  An unknown hook event is forward-tolerant (0.49.0): a newer kernel's event
 *  declared as a command, `{ command }` or `{ command, required: false }` is a
 *  warning and never runs here, so the next new event does not drop every
 *  capability that adopts it on an older host. Declared `required: true`, it
 *  stays refused: skipping a hook its author declared essential is fail-open.
 *  The declaration's shape and its script are checked as for a known event. */
export function manifestContract(m) {
  const problems = [];
  const warnings = [];
  const id = m?.capability;
  const bad = (pointer, message) => problems.push({ pointer, message: `capability ${id} ${message}` });

  if (m.environmentNamespaces !== undefined && (!Array.isArray(m.environmentNamespaces) || m.environmentNamespaces.some((ns) => typeof ns !== "string"))) {
    bad("/environmentNamespaces", "manifest environmentNamespaces must be an array of prefixes");
  }
  if (m.environment !== undefined) {
    if (!Array.isArray(m.environment) || m.environment.some((name) => typeof name !== "string")) {
      bad("/environment", "manifest environment must be an array of exact variable names");
    } else if (new Set(m.environment).size !== m.environment.length) {
      bad("/environment", "manifest environment contains duplicate names");
    } else if (m.environment.length) {
      const vendor = CAPABILITY_ENV_ID_RE.test(id) ? id.match(/^([a-z][a-z0-9]*)\./)?.[1] : undefined;
      if (!vendor) bad("/capability", "must use a lowercase dotted ID (vendor.name) without package or path syntax to declare launch environment");
      else {
        const extra = Array.isArray(m.environmentNamespaces) ? m.environmentNamespaces.filter((ns) => typeof ns === "string") : [];
        extra.forEach((ns, i) => {
          if (!/^[A-Z][A-Z0-9]*_$/.test(ns)) bad(`/environmentNamespaces/${i}`, `manifest environmentNamespaces entry ${JSON.stringify(ns)} must be an uppercase prefix ending in an underscore`);
          else if (ns === "OATS_" || ns === "PI_AGENT_" || PROCESS_BOOTSTRAP_PREFIXES.some((reserved) => ns.startsWith(reserved) || reserved.startsWith(ns))) bad(`/environmentNamespaces/${i}`, `manifest environmentNamespaces entry ${ns} is a reserved namespace`);
        });
        const allowed = [`${vendor.toUpperCase()}_`, ...extra];
        m.environment.forEach((name, i) => {
          const at = `/environment/${i}`;
          if (!PORTABLE_ENV_NAME_RE.test(name)) bad(at, `manifest environment name ${JSON.stringify(name)} is invalid`);
          else if (CORE_LAUNCH_ENV.has(name) || name.startsWith("OATS_") || name.startsWith("PI_AGENT_")) bad(at, `manifest environment name ${name} collides with a reserved core variable`);
          else if (PROCESS_BOOTSTRAP_ENV.has(name) || PROCESS_BOOTSTRAP_PREFIXES.some((reserved) => name.startsWith(reserved))) bad(at, `manifest environment name ${name} collides with a reserved process bootstrap variable`);
          else if (!allowed.some((ns) => name.startsWith(ns))) bad(at, `manifest environment name ${name} is outside its ${allowed.join(", ")} namespace${allowed.length > 1 ? "s" : ""} (declare another in environmentNamespaces)`);
        });
      }
    }
  }

  // What the capability's module commands may read from the environment of whoever runs them
  // outside a launch: exact names, and prefixes ending in an underscore. It says nothing of what
  // the capability may set (environment, environmentNamespaces above).
  if (m.readsEnvironment !== undefined) {
    if (!Array.isArray(m.readsEnvironment) || m.readsEnvironment.some((entry) => typeof entry !== "string")) {
      bad("/readsEnvironment", "manifest readsEnvironment must be an array of variable names and of prefixes ending in an underscore");
    } else if (new Set(m.readsEnvironment).size !== m.readsEnvironment.length) {
      bad("/readsEnvironment", "manifest readsEnvironment contains duplicate entries");
    } else {
      m.readsEnvironment.forEach((entry, i) => {
        const said = (why) => bad(`/readsEnvironment/${i}`, `manifest readsEnvironment entry ${JSON.stringify(entry)} ${why}`);
        if (/^_+$/.test(entry) || /^[A-Za-z0-9]_$/.test(entry)) said("is too wide: a prefix has at least two characters before its underscore");
        else if (!PORTABLE_ENV_NAME_RE.test(entry) || /^[0-9]/.test(entry)) said("is not a variable name or a prefix");
        else if (READS_RESERVED_PREFIXES.some((reserved) => entry.startsWith(reserved))) said("is reserved: the kernel sets the OATS_, OAS_ and PI_ names itself");
      });
    }
  }

  if (m.hooks !== undefined && !isObject(m.hooks)) bad("/hooks", "manifest hooks must be an object of event → command");
  const hooks = isObject(m.hooks) ? Object.entries(m.hooks) : [];
  // A hook's launch environment is claimed under the capability's dotted vendor
  // component; an undotted id has none, so its hooks cannot run.
  if (hooks.length && !/^[a-z][a-z0-9]*\./.test(String(id))) bad("/hooks", "declares hooks but its id has no dotted lowercase vendor component (e.g. acme.tool); only a dotted id can carry hooks");
  for (const [event, value] of hooks) {
    const at = `/hooks/${pointerKey(event)}`;
    const known = APPROVED_HOOKS.has(event);
    const sound = problems.length;
    const extraKeys = isObject(value) ? Object.keys(value).filter((k) => !["command", "required", "inputs"].includes(k)) : [];
    const command = typeof value === "string" ? value : isObject(value) && typeof value.command === "string" ? value.command : undefined;
    if (command === undefined || !command.trim() || extraKeys.length) { bad(at, `hook "${event}" must be a command string or { command, required, inputs }${extraKeys.length ? ` (unknown: ${extraKeys.join(", ")})` : ""}`); continue; }
    if (isObject(value) && value.required !== undefined && typeof value.required !== "boolean") bad(`${at}/required`, `hook "${event}": "required" must be a boolean`);
    // An unknown event its author declared essential cannot be skipped.
    else if (!known && isObject(value) && value.required === true) bad(at, `declares unsupported hook "${event}" (${[...APPROVED_HOOKS].join(", ")})`);
    // Upgrade has its own adoption protocol; the other events outside spawn
    // and worktree have no transaction where `required` can fail closed.
    else if (known && isObject(value) && value.required === true && !REQUIRABLE_HOOKS.has(event)) bad(`${at}/required`, `hook "${event}" cannot be required — only the spawn and worktree hooks are enforced (upgrade uses its adoption protocol; retire, launch and soul-scaffold run outside a transaction that can fail closed)`);
    if (hookScriptEscapes(command)) bad(isObject(value) ? `${at}/command` : at, `hook "${event}" script ${JSON.stringify(command.trim().split(/\s+/)[0])} escapes the capability directory; a hook script is a path inside it`);
    if (!known && problems.length === sound) warnings.push({ code: "hook-event-unsupported", pointer: at, message: `capability ${id} declares hook "${event}", which this kernel does not run; it is ignored (this kernel runs ${[...APPROVED_HOOKS].join(", ")})` });
  }

  if (m.retirement !== undefined) {
    if (!isObject(m.retirement) || !isObject(m.retirement.disposable)) bad("/retirement", "manifest retirement must contain a disposable map");
    else {
      const unknown = Object.keys(m.retirement).filter((key) => key !== "disposable");
      const scopes = Object.keys(m.retirement.disposable).filter((key) => !["home", "work"].includes(key));
      if (unknown.length || scopes.length) bad("/retirement", `manifest retirement has unsupported keys: ${[...unknown, ...scopes].join(", ")}`);
      for (const scope of ["home", "work"]) {
        const roots = m.retirement.disposable[scope];
        if (roots === undefined) continue;
        const at = `/retirement/disposable/${scope}`;
        if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) { bad(at, `manifest retirement.disposable.${scope} must be an array of relative roots`); continue; }
        if (scope === "work") {
          const sound = [];
          roots.forEach((root, i) => {
            if (disposableWorkRootProblem(root)) { bad(`${at}/${i}`, `manifest retirement.disposable.work entry ${JSON.stringify(root)} must be a relative path under work/ with no empty, "." or ".." segment`); return; }
            const normalized = normalizeDisposableWorkRoot(root);
            const other = sound.find((r) => disposableWorkRootsOverlap(r.normalized, normalized));
            if (other) bad(`${at}/${i}`, `manifest retirement.disposable.work entry ${JSON.stringify(root)} overlaps entry ${JSON.stringify(other.root)}: the same root, or one inside the other`);
            else sound.push({ root, normalized });
          });
          continue;
        }
        roots.forEach((root, i) => {
          const problem = disposableHomeRootProblem(root);
          if (problem === "shape") bad(`${at}/${i}`, `manifest retirement.disposable.home entry ${JSON.stringify(root)} must name one hidden top-level home entry (".name", or ".prefix-*")`);
          else if (problem === "kernel-owned") bad(`${at}/${i}`, `manifest retirement.disposable.home entry ${JSON.stringify(root)} covers a kernel-owned home entry`);
        });
      }
    }
  }
  return { problems, warnings };
}

/** A manifest's contract warnings as a command reports them: [{ code, capability, path, message }],
 *  `path` the warning's JSON pointer under `at`, where the manifest is read
 *  (`<repoKey>:<dir>/oats.json` for a member's, `package:<id>:<dir>/oats.json` for a package's,
 *  a file path for a home's module copy). Empty for a manifest with none. */
export function locatedContractWarnings(manifest, at) {
  return manifestContract(manifest).warnings.map((w) => ({ code: w.code, capability: manifest.capability, path: `${at}#${w.pointer}`, message: w.message }));
}

/** Contract warnings as the spawn and its preview carry them, among their other warning strings:
 *  each message clipped to CONTRACT_WARNING_TEXT characters, and at most CONTRACT_WARNING_LINES of
 *  them, then one line naming how many more (inspect lists every one, unclipped). A hook event's
 *  name is unbounded; the Desktop reads a spawn's warnings as at most 512 strings of at most 4096
 *  characters, and refuses the whole receipt past that. */
export const CONTRACT_WARNING_TEXT = 1000;
export const CONTRACT_WARNING_LINES = 32;
export function contractWarningMessages(warnings) {
  const clip = (text) => (text.length > CONTRACT_WARNING_TEXT ? `${text.slice(0, CONTRACT_WARNING_TEXT - 1)}…` : text);
  const shown = warnings.length > CONTRACT_WARNING_LINES ? warnings.slice(0, CONTRACT_WARNING_LINES - 1) : warnings;
  const more = warnings.length - shown.length;
  return [...shown.map((w) => clip(w.message)), ...(more ? [`${more} more hook events this kernel does not run are ignored (oats inspect lists every one)`] : [])];
}

/** `retirement.disposable.home`: provider-owned top-level entries of an instance
 *  home that retirement neither fingerprints nor copies to recovery. An entry is
 *  one hidden top-level name (`.aw`) or a prefix (`.aweb-identity-*`: every
 *  top-level name starting with the text before `*`). No separator, no
 *  traversal, no other glob, and nothing that covers a name the kernel owns in
 *  a home. The published schema (docs/capability-manifest.schema.json) states
 *  the same grammar. */
const DISPOSABLE_HOME_EXACT_RE = /^\.[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const DISPOSABLE_HOME_PREFIX_RE = /^\.[A-Za-z0-9_][A-Za-z0-9._-]*-\*$/;
/** The top-level entries the KERNEL writes in an instance home, as a
 *  declaration may not cover them: these exact names, and every exact name
 *  starting with one of these prefixes (the events log; the stop, restart and
 *  start receipts and locks; the rollback marker; AGENTS.md backups; the
 *  attachments directory; the instance colour, `.oats-color.json`; the background record, `.oats-background.json`; the same-work flag, `.oats-same-work.json`). This is the one list: a new kernel-written top-level
 *  home entry MUST be added here and to the `not` patterns of
 *  `retirement.disposable.home` in docs/capability-manifest.schema.json. A
 *  prefix declaration can reach none of them except through `.oats-`, which is
 *  refused whole; `.oats-<provider>` as an exact name stays declarable. */
const KERNEL_HOME_NAMES = new Set([".oats", ".agents", ".claude"]);
const KERNEL_HOME_NAME_PREFIXES = [".oats-events", ".oats-stop", ".oats-restart", ".oats-rollback", ".oats-agents-md", ".oats-start", ".oats-attachments", ".oats-color", ".oats-background", ".oats-same-work"];

/** Why `root` is not a declarable home entry: "shape" (not one hidden top-level
 *  name or prefix), "kernel-owned", or undefined when it is sound. */
export function disposableHomeRootProblem(root) {
  if (typeof root !== "string") return "shape";
  if (DISPOSABLE_HOME_PREFIX_RE.test(root)) return root.startsWith(".oats-") ? "kernel-owned" : undefined;
  if (!DISPOSABLE_HOME_EXACT_RE.test(root)) return "shape";
  return KERNEL_HOME_NAMES.has(root) || KERNEL_HOME_NAME_PREFIXES.some((prefix) => root.startsWith(prefix)) ? "kernel-owned" : undefined;
}

/** Whether the declared `root` (already sound) covers the top-level home entry `name`. */
export function disposableHomeRootMatches(root, name) {
  return root.endsWith("*") ? name.startsWith(root.slice(0, -1)) : name === root;
}

/** `retirement.disposable.work`: roots under an instance's work/ that a
 *  capability generates. The grammar is the one spawn applies where it records
 *  the roots (lib/core.mjs retirementDisposableRoots), so a manifest this
 *  accepts is one spawn records: a backslash reads as `/`, one leading `./` and
 *  one trailing `/` are dropped, and what is left is non-empty with no empty,
 *  `.` or `..` segment. An absolute path is refused as any host's spawn refuses
 *  it, a Windows one (`C:/x`) included: a manifest is read on every host. Spawn
 *  alone refuses a root that is a symlink in the work, or roots of different
 *  capabilities that overlap. The published schema
 *  (docs/capability-manifest.schema.json) states the same grammar. */
const ABSOLUTE_PATH_RE = /^(?:[/\\]|[A-Za-z]:[/\\])/;

/** Why `root` is not a declarable work root: "absolute", "segment" (empty
 *  after normalization, or an empty, "." or ".." segment), "shape" (not a
 *  non-empty string), or undefined when it is sound. */
export function disposableWorkRootProblem(root) {
  if (typeof root !== "string" || !root) return "shape";
  if (ABSOLUTE_PATH_RE.test(root)) return "absolute";
  const normalized = normalizeDisposableWorkRoot(root);
  return !normalized || normalized.split("/").some((part) => !part || part === "." || part === "..") ? "segment" : undefined;
}

/** A work root as spawn records it. */
function normalizeDisposableWorkRoot(root) {
  return root.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

/** Whether two normalized work roots overlap: the same root, or one inside the other. */
function disposableWorkRootsOverlap(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** The setting keys a manifest declares (`settings.<key>`), sorted: names only, never their
 *  descriptions or defaults. The spawn preview and inspect expose them so a client can gate
 *  a choice on a declared key (e.g. a messaging provider's `join`). */
export function declaredSettings(manifest) {
  return isObject(manifest?.settings) ? Object.keys(manifest.settings).sort() : [];
}

/** Top-level payload keys whose value is outside the manifest's `settings.<key>.values`
 *  → [{ key, value, values }]. A conditional `requires` row reads these values, so a
 *  misspelled one would silently skip every row instead of failing. */
export function settingValueProblems(manifest, payload) {
  const out = [];
  if (!isObject(manifest?.settings) || !isObject(payload)) return out;
  for (const [key, decl] of Object.entries(manifest.settings)) {
    if (!isObject(decl) || !Array.isArray(decl.values) || !Object.hasOwn(payload, key) || payload[key] === undefined) continue;
    if (!decl.values.some((v) => String(v) === String(payload[key]))) out.push({ key, value: payload[key], values: decl.values });
  }
  return out;
}
