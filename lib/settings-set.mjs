/**
 * lib/settings-set.mjs — `oats settings set|unset <capability> <key> [<value>]` (feature settings-set,
 * oats-project/oats#2122 KP-17): record one host setting of a capability in the deployment's own
 * oats-local.yaml, under `settings.<capability>.<key>`, without a hand edit.
 *
 * - **An operator's command.** It is refused (E_SETTINGS_OPERATOR_ONLY, nothing written) when the process
 *   carries an instance's identity, by the kernel's own evidence (lib/core.mjs instanceCaller): an instance
 *   variable, or a working directory inside a home. That is a GUARD against an agent changing a host
 *   setting by accident or as a convenience, not a security boundary: a process can shed both (unset the
 *   variables, change directory). A host's protection against its own agents is file permissions and the
 *   sandbox.
 * - **Never a secret.** A credential-shaped key is refused before anything is read (credentialShaped).
 * - **The kernel's one writer** (lib/local-edit.mjs editLocal, under the deployment's local lock): a YAML
 *   file keeps its comments, its other entries and their order; a file written as JSON stays JSON.
 * - **The resolver's own checks**, on the document as it would be written: the local schema (editLocal),
 *   the host layer's checks and the manifest's declared values (lib/resolve.mjs assertHostSettings,
 *   assertSettingValues), and the manifest's declared keys. Any refusal writes nothing.
 * - **The answer** `{ capability, key, previous, value, effective, changed, file }`: `previous` and `value`
 *   are the FILE's (null when it does not set the key), `effective` the host layer over the manifest
 *   default (the file's value, else the manifest default, else null): what a soul resolves for the key
 *   unless a committed payload of the workspace or of the soul sets it, which a hostOnly key's never does.
 */
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isMap } from "yaml";
import { oatsError } from "./errors.mjs";
import { writeFileAtomic } from "./write-file-atomic.mjs";
import { editLocal } from "./local-edit.mjs";
import { declaredSettings } from "./capability-contract.mjs";
import { assertHostSettings, assertSettingValues, manifestDefaultsPayload } from "./resolve.mjs";
import { REFUSED_TEXT, safeText } from "./refused-text.mjs";

function fail(code, message, details) { const e = oatsError(code, message, details); if (details !== undefined) e.details = details; return e; }
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => isObject(o) && Object.hasOwn(o, k);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A capability's name, as `--provider <capability>` takes it. */
export const SETTING_CAPABILITY_RE = /^[a-z][a-z0-9.-]{0,63}$/i;
/** A setting's key: one top-level key of the capability's payload (no dotted path). */
export const SETTING_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
/** A value given on the command line: one line of safe text. */
export const SETTING_VALUE_MAX = 1024;

const CREDENTIAL_WORDS = new Set(["secret", "token", "password", "passwd", "passphrase", "credential", "apikey", "privatekey", "auth"]);
const singular = (word) => (word.length > 1 && word.endsWith("s") && CREDENTIAL_WORDS.has(word.slice(0, -1)) ? word.slice(0, -1) : word);
/** Whether a key's name is credential-shaped, by its word parts: the key cut at `-`, `_`, `.` and at a
 *  step from a lower-case letter or a digit to a capital, case-insensitive. A word that is secret, token,
 *  password, passwd, passphrase, credential, apikey, privatekey or auth (or its plural), or two words in a
 *  row that are "api key" or "private key". So `authToken`, `api_key`, `clientSecret` and `tokens` are, and
 *  `author` and `authority` are not. → the word that makes it so, or null. */
export function credentialShaped(key) {
  const words = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => singular(w.toLowerCase()));
  for (let i = 0; i < words.length; i++) {
    if (CREDENTIAL_WORDS.has(words[i])) return words[i];
    if ((words[i] === "api" || words[i] === "private") && singular(words[i + 1] ?? "") === "key") return `${words[i]} key`;
  }
  return null;
}
/** The refusal of a credential-shaped key: where a secret belongs. */
export function assertNotCredential(capability, key) {
  const word = credentialShaped(key);
  if (word) throw fail("E_BAD_ARGS", `oats settings never records a secret: the key ${JSON.stringify(key)} is credential-shaped (${JSON.stringify(word)}). A secret belongs in the capability's own setup command (for example \`oats aweb setup\`) or in the host's secret store, never in oats-local.yaml; nothing was written`, { capability, key, reason: "credential-key" });
}

/** The refusal of a run that carries an instance's identity (`caller`: lib/core.mjs instanceCaller), naming
 *  the evidence and the way out. `deployment` is where to run it from, when known. */
export function operatorOnly(caller, { verb, deployment = null, instance = null }) {
  const from = deployment ? `\`cd ${deployment} && oats settings ${verb} …\`` : `the deployment's directory (\`cd <deployment> && oats settings ${verb} …\`)`;
  const guard = "This is a guard against an agent changing a host setting by accident, not a security boundary; nothing was written";
  const who = instance ? `the home of ${instance} (${caller.home})` : `an instance home (${caller.home})`;
  if (caller.home && caller.by === "cwd") {
    return fail("E_SETTINGS_OPERATOR_ONLY", `oats settings ${verb} is an operator's command: this shell's working directory is inside ${who}, so it reads as that agent's: run it from outside any home, e.g. ${from} (--dir does not lift this: it says which deployment, not who is asking). ${guard}`,
      { evidence: "cwd", home: caller.home, ...(instance ? { instance } : {}) });
  }
  const variable = caller.home ? "OATS_INSTANCE_HOME" : caller.evidence;
  const carries = caller.home ? `OATS_INSTANCE_HOME, which names ${who}` : `${variable}, an instance's variable`;
  return fail("E_SETTINGS_OPERATOR_ONLY", `oats settings ${verb} is an operator's command: this process's environment carries ${carries}, so it reads as that agent's: run it from a shell outside any home, without the instance's variables, e.g. ${from} (--dir does not lift this: it says which deployment, not who is asking). ${guard}`,
    { evidence: "environment", variable, ...(caller.home ? { home: caller.home } : {}), ...(instance ? { instance } : {}) });
}

/** The value to store for the text a person gave, by what each source's manifest says of the key:
 *  1. a manifest that declares `values`: the declared value that matches the text (its own type);
 *  2. a manifest default that is a string: the text;
 *  3. a whole number or `true`/`false`: a number or a boolean, as a hand edit of the YAML reads;
 *  4. anything else: the text.
 *  The text is one line of safe text of at most SETTING_VALUE_MAX characters. */
export function settingValueOf(text, sources, key) {
  if (typeof text !== "string" || text === "" || [...text].length > SETTING_VALUE_MAX || REFUSED_TEXT.test(text)) {
    throw fail("E_BAD_ARGS", `oats settings set takes a value of 1 to ${SETTING_VALUE_MAX} characters on one line, with no control, bidi, invisible or tag character; nothing was written`, { key, reason: "value" });
  }
  for (const { manifest } of sources) {
    const declared = manifest?.settings?.[key];
    if (isObject(declared) && Array.isArray(declared.values)) {
      const match = declared.values.find((v) => String(v) === text);
      if (match !== undefined) return match;
    }
  }
  if (sources.some(({ manifest }) => typeof manifest?.settings?.[key]?.default === "string")) return text;
  if (/^-?(0|[1-9][0-9]{0,14})$/.test(text)) return Number(text);
  if (text === "true" || text === "false") return text === "true";
  return text;
}

/** `effective` for `key` with the file's payload `filePayload`: the file's value, else the default the
 *  sources' manifests agree on, else null. The host layer over the manifest default: a committed payload
 *  (oats-workspace.yaml's slot, a soul's) is not read here, and none can set a hostOnly key. */
function effectiveOf(sources, filePayload, key) {
  if (own(filePayload, key)) return filePayload[key];
  const defaults = sources.map(({ manifest }) => manifestDefaultsPayload(manifest)).map((d) => (own(d, key) ? d[key] : null));
  return defaults.length && defaults.every((d) => same(d, defaults[0])) ? defaults[0] : null;
}

/** Remove the mapping at `path` of the document when it is empty and carries no comment. One that a
 *  person commented (above its key, beside it, or inside it, where the file's later comments also attach)
 *  stays, as an empty mapping: removing it would take those comments with it, and they are not the
 *  setting's. */
function dropEmptyMapping(doc, path) {
  const node = doc.getIn(path, true);
  if (!isMap(node) || node.items.length) return;
  const parent = path.length > 1 ? doc.getIn(path.slice(0, -1), true) : doc.contents;
  const pair = isMap(parent) ? parent.items.find((p) => (p.key?.value ?? p.key) === path.at(-1)) : null;
  if ([node.commentBefore, node.comment, pair?.key?.commentBefore, pair?.key?.comment].some(Boolean)) return;
  doc.deleteIn(path);
}

/**
 * Set (`value` given, as settingValueOf made it) or unset (`value` undefined) `settings.<capability>.<key>`
 * in the deployment's oats-local.yaml. `ctx`: { deployment, localPath }. `sources`: every catalog row that
 * carries the capability's name, `[{ manifest, layer, origin }]` (oats-local.yaml's payload reaches
 * whichever of them a soul resolves, so the edit passes every one's checks).
 * → { capability, key, previous, value, effective, changed, file }.
 */
export function editSetting(ctx, { capability, key, value, sources }) {
  const verb = value === undefined ? "unset" : "set";
  if (!SETTING_CAPABILITY_RE.test(String(capability))) throw fail("E_BAD_ARGS", `oats settings ${verb} needs a capability's name (got ${JSON.stringify(capability)}); nothing was written`, { capability });
  if (!SETTING_KEY_RE.test(String(key))) throw fail("E_BAD_ARGS", `oats settings ${verb} takes one top-level setting key of 1 to 128 letters, digits, dashes and underscores (got ${JSON.stringify(key)}); nothing was written`, { capability, key });
  assertNotCredential(capability, key);
  for (const { manifest, origin } of sources) {
    const declared = declaredSettings(manifest);
    if (!declared.includes(key)) {
      throw fail("E_BAD_ARGS", `${capability}${sources.length > 1 ? ` (${origin})` : ""} declares no setting ${JSON.stringify(key)}: ${declared.length ? `its settings are ${declared.join(", ")}` : "it declares no settings"}; nothing was written`, { capability, key, declared, ...(sources.length > 1 ? { origin } : {}) });
    }
  }
  let previous = null, stored = null, payloadNow = null;
  const { changed } = editLocal(ctx, { verb: `oats settings ${verb}` }, ({ doc, local }) => {
    const payload = isObject(local?.settings) && own(local.settings, capability) ? local.settings[capability] : undefined;
    if (payload !== undefined && !isObject(payload)) throw fail("E_WORKSPACE_SCHEMA", `${ctx.localPath}: settings.${capability} is not a mapping; nothing was written`, { path: `/settings/${capability}` });
    const held = own(payload, key);
    previous = held ? payload[key] : null;
    stored = verb === "set" ? value : null;
    payloadNow = payload ?? {};
    if (verb === "unset") {
      if (!held) return null;
      doc.deleteIn(["settings", capability, key]);
      // A mapping the unset emptied goes with it, unless a person's comment is attached to it.
      dropEmptyMapping(doc, ["settings", capability]);
      dropEmptyMapping(doc, ["settings"]);
    } else {
      if (held && same(payload[key], value)) return null;
      // An empty mapping on the way (one an unset left for its comments, or `{}` written by hand) is
      // written as a block again: the library reads `{}` as a flow mapping, and would write the new key
      // inside braces, on the mapping's own line.
      for (const path of [["settings"], ["settings", capability]]) {
        const node = doc.getIn(path, true);
        if (isMap(node) && !node.items.length) node.flow = false;
      }
      doc.setIn(["settings", capability, key], value);
    }
    return {
      // The document as it would be written, by the resolver's own checks of the host layer.
      check(next) {
        const after = isObject(next?.settings) && isObject(next.settings[capability]) ? next.settings[capability] : {};
        for (const { manifest, layer } of sources) {
          assertHostSettings(after, { capability, layer: layer ?? null, manifest });
          assertSettingValues(manifest, after, { capability, atOf: (k) => `oats-local.yaml#/settings/${capability}/${k}` });
        }
        payloadNow = after;
      },
    };
  });
  return { capability, key, previous, value: stored, effective: effectiveOf(sources, payloadNow, key), changed, file: ctx.localPath };
}

/** The trace of this deployment's settings changes: `<deployment>/.agents/events/settings.jsonl`, beside the
 *  homes' event files. */
export const settingsTracePath = (deployment) => join(deployment, ".agents", "events", "settings.jsonl");
/** The trace keeps its last TRACE_MAX_LINES lines: when a line takes it past that, the oldest are dropped. */
export const TRACE_MAX_LINES = 1000;

/** Append one changed write to the trace: `{ at, verb, capability, key, previous, value }`, one JSON line,
 *  every text bounded and made safe (traceValue). The file is private to its user (0600) and bounded
 *  (TRACE_MAX_LINES). Nothing reads it: it is for a person, or a later client, and no digest covers it (it
 *  is in no home). It is in the deployment's events directory, which the agents of the same user can write
 *  (a sandboxed session is allowed that one directory), so it is a trace and not an audit record. The open
 *  never follows a link at the file's name and writes only a regular file with one name, as an event row's
 *  does (lib/instance-events.mjs). Throws with why: the caller turns that into a warning, never a failed set. */
export function appendSettingsTrace(deployment, { at, verb, capability, key, previous, value }) {
  const path = settingsTracePath(deployment);
  mkdirSync(join(deployment, ".agents", "events"), { recursive: true });
  const line = `${JSON.stringify({ at, verb, capability, key, previous: traceValue(previous), value: traceValue(value) })}\n`;
  let fd;
  try { fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0), 0o600); }
  catch (e) { throw e?.code === "ELOOP" ? new Error("the trace is a symbolic link, which is never written through") : e; }
  let text;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("the trace is not a regular file");
    if (stat.nlink > 1) throw new Error("the trace has a second name (a hard link), so a line would be written into another file too");
    if ((stat.mode & 0o777) !== 0o600) fchmodSync(fd, 0o600);
    writeSync(fd, line);
    // The whole file, from its start, through the descriptor that was checked (an append leaves the
    // descriptor's own position at the end).
    const bytes = Buffer.alloc(fstatSync(fd).size);
    let got = 0;
    while (got < bytes.length) { const n = readSync(fd, bytes, got, bytes.length - got, got); if (n === 0) break; got += n; }
    text = bytes.subarray(0, got).toString("utf8");
  } finally { closeSync(fd); }
  const lines = text.split("\n").filter(Boolean);
  // Past the bound, the file is replaced by its newest lines (a sibling temporary file, renamed in).
  if (lines.length > TRACE_MAX_LINES) writeFileAtomic(path, `${lines.slice(-TRACE_MAX_LINES).join("\n")}\n`, { mode: 0o600 });
}

/** A value as the trace holds it: a scalar as it is, a text cut to 500 characters and made safe, anything
 *  else its JSON, cut the same way. */
export function traceValue(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  return safeText(typeof value === "string" ? value : JSON.stringify(value), 500);
}
