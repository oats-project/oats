/** The CLI's hot reads (awebai/oats#1630): the reads the Desktop, the TUI and agents' hooks run over and
 *  over load only the modules they use, never core.mjs; so does the warm reader's start (`oats reader --stdio`,
 *  lib/reader.mjs), which loads the reads itself. `bin/oats.mjs` asks hotRead for its argv before
 *  its imports; for a hot read, each of its import lines (`lib/<name>.mjs`) takes the leaves listed here
 *  for that name, the modules its names are defined in and re-exported from (hotImport). Every specifier
 *  is one string literal, here and in bin, so that a reader of the sources (test/client-boundary.test.mjs)
 *  sees every module the CLI can load. Every other command, and a
 *  hot read given anything but the words and flags listed here (help, an unknown flag, a missing value),
 *  imports every module as before.
 *
 *  A list must hold every module the read's code can reach, its error paths included. A line a read
 *  does not list, or a name its leaves do not export, is a tripwire (standIn): taking it is free, and
 *  any use of it throws a HotReadUnlisted defect that names the read, the line and the name.
 *  test/cli-hot-reads.test.mjs runs each read and pins the modules it must not load. Kernel-private,
 *  not exported from `./core`. Dependency-free. */

/** The dispatch's own modules: argv's `--flag=value` expansion, the flags each state-changing command defines,
 *  the deprecated-name warning, the typed failures, the resume feature, the inherited captured context's refusal. */
const DISPATCH = { argv: ["argv"], "command-flags": ["command-flags"], deprecation: ["deprecation"], errors: ["errors"], "session-resume-contract": ["session-resume-contract"], "captured-context": ["captured-context"] };
/** A read that lists its deployment (LISTS_ITS_DEPLOYMENT in bin/oats.mjs): the observer and the list. */
const LISTS = { "resolved-deployment": ["resolved-deployment"], deployments: ["deployments"] };
/** The deployment reads (status and workspace status): their call scope (lib/read-call.mjs: the remote budget,
 *  the read session, `--max-age`'s parse) and the local-input revision `--max-age` records. */
const OBSERVES = { "read-call": ["read-call"], "local-inputs": ["local-inputs"] };

const READS = {
  version: { ...DISPATCH, core: ["version"], version: ["version"], "kernel-features": ["kernel-features"], schedule: ["automation-api"], automations: ["automation-api"], "session-viewer": ["session-viewer"] },
  "session inspect": { ...DISPATCH, ...LISTS, "refused-text": ["refused-text"], core: ["session-inspect"] },
  status: { ...DISPATCH, ...LISTS, ...OBSERVES, "roster-read": ["roster-read"], "workspace-read": ["workspace-read"], core: ["instance-listing"], "status-words": ["status-words"] },
  "status --server": { ...DISPATCH, "status-words": ["status-words"], servers: ["servers"] },
  "workspace status": { ...DISPATCH, ...LISTS, ...OBSERVES, "workspace-read": ["workspace-read"] },
  "instance events": { ...DISPATCH, ...LISTS, core: ["agents-root"], "instance-events": ["instance-events"], "instance-lifecycle": ["instance-address"] },
  "instance waiting clear": { ...DISPATCH, ...LISTS, core: ["soul-listing", "agents-root"], "instance-events": ["instance-events"], "instance-lifecycle": ["instance-address"] },
  // The warm reader (lib/reader.mjs): bin's dispatch only. The reader imports the reads itself, PRELOAD included,
  // before its hello, never through this table (docs/design/2026-10-29-warm-reader.md D4).
  reader: { ...DISPATCH },
};

/** The leaves, each loaded by its own literal specifier. */
const LEAVES = {
  "agents-root": () => import("./agents-root.mjs"),
  argv: () => import("./argv.mjs"),
  "automation-api": () => import("./automation-api.mjs"),
  "captured-context": () => import("./captured-context.mjs"),
  "command-flags": () => import("./command-flags.mjs"),
  deployments: () => import("./deployments.mjs"),
  deprecation: () => import("./deprecation.mjs"),
  errors: () => import("./errors.mjs"),
  "instance-address": () => import("./instance-address.mjs"),
  "instance-events": () => import("./instance-events.mjs"),
  "instance-listing": () => import("./instance-listing.mjs"),
  "kernel-features": () => import("./kernel-features.mjs"),
  "local-inputs": () => import("./local-inputs.mjs"),
  "read-call": () => import("./read-call.mjs"),
  "refused-text": () => import("./refused-text.mjs"),
  "resolved-deployment": () => import("./resolved-deployment.mjs"),
  "roster-read": () => import("./roster-read.mjs"),
  servers: () => import("./servers.mjs"),
  "session-inspect": () => import("./session-inspect.mjs"),
  "session-resume-contract": () => import("./session-resume-contract.mjs"),
  "session-viewer": () => import("./session-viewer.mjs"),
  "soul-listing": () => import("./soul-listing.mjs"),
  "status-words": () => import("./status-words.mjs"),
  version: () => import("./version.mjs"),
  "workspace-read": () => import("./workspace-read.mjs"),
};

/** Each hot read's form: its words (`<name>`: an instance name), the switches and the value flags it
 *  takes, and the value flags it requires. */
const FORMS = [
  { read: "version", words: ["version"], switches: ["--json"] },
  { read: "version", words: ["--version"], switches: ["--json"] },
  { read: "version", words: ["-v"], switches: ["--json"] },
  { read: "session inspect", words: ["session", "inspect"], switches: ["--json"], values: ["--home"] },
  { read: "status", words: ["status"], switches: ["--json", "--team", "--verbose"], values: ["--dir", "--max-age"] },
  { read: "status --server", words: ["status"], switches: ["--json"], values: ["--server"], requires: ["--server"] },
  { read: "workspace status", words: ["workspace", "status"], switches: ["--json"], values: ["--dir", "--max-age"] },
  { read: "instance events", words: ["instance", "events", "<name>"], switches: ["--json"], values: ["--home", "--dir", "--limit", "--since"] },
  { read: "instance waiting clear", words: ["instance", "waiting", "clear"], switches: ["--json"], values: ["--producer", "--reason", "--message", "--home", "--dir"] },
  { read: "reader", words: ["reader"], switches: ["--stdio"] },
];

function matches(form, argv) {
  if (argv.length < form.words.length) return false;
  if (form.words.some((w, i) => (w === "<name>" ? !argv[i] || argv[i].startsWith("-") : argv[i] !== w))) return false;
  const given = new Set();
  for (let i = form.words.length; i < argv.length; i++) {
    const a = argv[i], eq = a.indexOf("=");
    if (form.switches.includes(a)) continue;
    const name = a.startsWith("--") && eq > 2 ? a.slice(0, eq) : a;
    if (!form.values?.includes(name)) return false;
    if (name === a) { if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) return false; i++; }
    given.add(name);
  }
  return (form.requires ?? []).every((f) => given.has(f));
}

/** argv's hot read, { form, lines: { <name>: [leaf names] } }, or null for any other command. Help is
 *  never one: the dispatch answers usage for `-h` or `--help` anywhere in argv as it expands it, a flag's
 *  value included (`--dir -h`, `--dir=-h`), and usage reads beyond any hot read's names. */
export function hotRead(argv) {
  if (argv.some((a) => /(^|=)(-h|--help)$/.test(a))) return null;
  const form = FORMS.find((f) => matches(f, argv));
  return form ? { form: form.read, lines: READS[form.read] } : null;
}

/** The leaves a hot read loads in place of bin's import line of `lib/<name>.mjs` (or of `yaml`). */
export function hotLeaves(read, name) {
  return read.lines[name] ?? [];
}

/** What bin's import line of `name` answers in a hot read: its leaves, loaded in order (standIn). */
export async function hotImport(read, name) {
  const modules = [];
  for (const leaf of hotLeaves(read, name)) modules.push(await LEAVES[leaf]());
  return standIn(read, name, modules);
}

/** A hot read's use of a name it does not list: a mistake in this table, never an answer. Its name is on
 *  the prototype, so the kernel reports it as the defect it is (errors.mjs isDefect). */
export class HotReadUnlisted extends Error {}
HotReadUnlisted.prototype.name = "HotReadUnlisted";

/** What an import line answers in a hot read: the one leaf's namespace (read live), or the names of its
 *  leaves together, behind a proxy that answers any other name with a tripwire. `then` is never one: an
 *  `await` asks for it, and its absence is what makes the answer no promise. */
export function standIn(read, line, modules) {
  const target = modules.length === 1 ? modules[0] : Object.assign(Object.create(null), ...modules);
  return new Proxy(target, { get: (t, name) => (name in t ? t[name] : name === "then" ? undefined : tripwire(read, line, name)) });
}

function tripwire(read, line, name) {
  const fail = () => {
    throw new HotReadUnlisted(`oats ${read.form} is a hot read, and it used ${String(name)} of ${line === "yaml" ? line : `lib/${line}.mjs`}, which lib/hot-reads.mjs does not list for it: list the module that defines ${String(name)} under that line in the read's entry in lib/hot-reads.mjs`);
  };
  // A function target, so that a call and `new` reach their traps too.
  return new Proxy(function unlisted() {}, { get: fail, set: fail, has: fail, ownKeys: fail, apply: fail, construct: fail, getOwnPropertyDescriptor: fail, defineProperty: fail, deleteProperty: fail, getPrototypeOf: fail });
}
