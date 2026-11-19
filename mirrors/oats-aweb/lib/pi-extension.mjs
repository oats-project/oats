// The aweb skills a pi folder can load beside a home's own.
//
// OATS hands a home its skills through its capabilities only, so a pi folder
// that OATS homes use loads no aweb skills machine-wide:
// - @awebai/pi below 0.5.0 declares `"pi": {"skills": ["./skills"]}` next to
//   its extension, so a plain `pi install npm:@awebai/pi` makes pi load those
//   skills in every session that uses that pi folder. The extension's settings
//   entry filters them out with pi's object form,
//   {"source": "npm:@awebai/pi", "skills": []} (pi's docs/packages.md, "Select
//   package resources"). Checked with pi 1.3.0 and @awebai/pi 0.4.0: the
//   filtered entry still loads the extension and none of its skills, and a
//   later `pi install` or `pi update` of the package keeps the filter
//   (`pi install npm:@awebai/pi@latest` rewrites `source` and keeps `skills`).
//   @awebai/pi 0.5.0 declares `"skills": []` itself and bundles none, so the
//   filter is needed below 0.5.0 only.
// - @awebai/claude-skills (0.2.17 and later) ships those skills on their own,
//   `"pi": {"skills": ["./skills"]}`; listed in the folder unfiltered, pi
//   loads them in every session too.
import {closeSync, constants, fstatSync, openSync, readFileSync, readSync, realpathSync} from 'node:fs';
import {isAbsolute, join, sep} from 'node:path';
import {parseVersion, versionAtLeast} from './aw-floor.mjs';

export const PI_EXTENSION_PACKAGE = '@awebai/pi';
export const PI_EXTENSION = `npm:${PI_EXTENSION_PACKAGE}`;
/** The first @awebai/pi that bundles no skills: from it the filter is not needed. */
export const PI_EXTENSION_WITHOUT_SKILLS = '0.5.0';
export const PI_SKILLS_PACKAGE = 'npm:@awebai/claude-skills';

const MAX_FILE = 1 << 20;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const absolute = value => typeof value === 'string' && value !== '' && isAbsolute(value) && !value.includes('\0');
/** Whether `value` is `source`, with or without a version (`npm:@awebai/pi@0.4.0`). */
const sourceOf = (source, value) => typeof value === 'string' && (value === source || value.startsWith(`${source}@`));
const skillsFiltered = entry => Array.isArray(entry.skills) && entry.skills.length === 0;

// Opening never blocks (a FIFO at the path) and never follows a link swapped in
// after the path was resolved; the descriptor is then checked to be a file.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

/** JSON from `file`, read only when it resolves to a regular file inside
 *  `base` (no link out of it) of at most 1 MiB; undefined otherwise. A copy of
 *  oats.aweb-tasks's lib/claim-floors.mjs readJsonInside, since neither
 *  capability can import the other's files; test/pi-extension-skills.test.mjs
 *  holds the two version readers equal. */
function readJsonInside(base, file) {
  let fd;
  try {
    const root = realpathSync(base), real = realpathSync(file);
    if (real !== root && !real.startsWith(root + sep)) return undefined;
    fd = openSync(real, OPEN_FLAGS);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_FILE) return undefined;
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) { const n = readSync(fd, buf, read, st.size - read, read); if (!n) break; read += n; }
    return JSON.parse(buf.subarray(0, read).toString('utf8'));
  } catch { return undefined; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

/** The @awebai/pi version pi installed for `agentDir`: pi puts a user-scope npm
 *  package in <agentDir>/npm/node_modules/<name> (pi 1.3.0
 *  getManagedNpmInstallPath), and its package.json holds the version. pi's
 *  older global-npm location and a project-scope install are not read.
 *  undefined when unreadable, misnamed or not semver. A copy of oats.aweb-tasks's
 *  lib/claim-floors.mjs piExtensionVersion (see readJsonInside). */
export function piExtensionVersion(agentDir) {
  if (!agentDir) return undefined;
  const base = join(agentDir, 'npm', 'node_modules');
  const doc = readJsonInside(base, join(base, ...PI_EXTENSION_PACKAGE.split('/'), 'package.json'));
  return doc?.name === PI_EXTENSION_PACKAGE && parseVersion(doc.version) ? doc.version : undefined;
}

/** The pi folder of the home's recorded launch, for a pi home only: its literal
 *  PI_CODING_AGENT_DIR (absolute, or under ~, which pi expands against HOME),
 *  else HOME's .pi/agent when the launch sets none. Unknown (undefined) for
 *  any other value, such as a {fromEnv} reference, for a home that is not on
 *  pi, or when the home has no launch record. */
export function recordedPiAgentDir(home, env = process.env) {
  let doc;
  try { doc = JSON.parse(readFileSync(join(home, 'instance.json'), 'utf8')); } catch { return undefined; }
  if (!object(doc?.launch)) return undefined;
  const meta = object(doc.capabilityMeta?.['oats.aweb']) ? doc.capabilityMeta['oats.aweb'] : {};
  if ((doc.launch.harness ?? doc.harness ?? meta.runtime) !== 'pi') return undefined;
  const launchEnv = object(doc.launch.env) ? doc.launch.env : {};
  const userHome = absolute(env.HOME) ? env.HOME : undefined;
  if (!Object.hasOwn(launchEnv, 'PI_CODING_AGENT_DIR')) return userHome && join(userHome, '.pi', 'agent');
  const dir = launchEnv.PI_CODING_AGENT_DIR;
  if (typeof dir === 'string' && /^~(?=$|\/)/.test(dir)) return userHome && join(userHome, dir.slice(1));
  return absolute(dir) ? dir : undefined;
}

/** The first entry of `agentDir`'s settings.json that lists `source` without
 *  `"skills": []`, as `{file, entry}`: a plain string, with or without a
 *  version, or an object whose `source` is one. undefined for a missing,
 *  unreadable or malformed file, or one with no such entry. Only that file is
 *  read, never a project's .pi/settings.json. */
function unfilteredEntry(agentDir, source) {
  if (!agentDir) return undefined;
  const file = join(agentDir, 'settings.json');
  let doc;
  try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
  if (!object(doc) || !Array.isArray(doc.packages)) return undefined;
  const entry = doc.packages.find(e => sourceOf(source, e) || (object(e) && sourceOf(source, e.source) && !skillsFiltered(e)));
  return entry === undefined ? undefined : {file, entry};
}

/** The pi-extension-skills-loaded warning for `agentDir`, or nothing: the
 *  folder's settings.json lists the aweb extension as a plain string or as an
 *  object without `"skills": []`, and the @awebai/pi installed there is below
 *  0.5.0 or its version is unknown (piExtensionVersion). A missing, unreadable
 *  or malformed file, or one that does not list the extension, says nothing. */
export function piExtensionSkillsWarning(agentDir) {
  const found = unfilteredEntry(agentDir, PI_EXTENSION);
  if (!found) return undefined;
  if (versionAtLeast(piExtensionVersion(agentDir), PI_EXTENSION_WITHOUT_SKILLS)) return undefined;
  const {file, entry} = found;
  const edit = typeof entry === 'string' ? `replace the entry ${JSON.stringify(entry)} with ${JSON.stringify({source: entry, skills: []})}` : `set "skills": [] in the entry whose "source" is ${JSON.stringify(entry.source)}`;
  return {code: 'pi-extension-skills-loaded', message: `pi loads the skills bundled with the aweb pi extension in every session that uses ${agentDir}: its settings.json lists ${JSON.stringify(PI_EXTENSION)} without a skills filter, and OATS gives a home its skills through its capabilities only. In ${file}, ${edit}, keeping the other entries (the extension still loads, and pi install and pi update keep the filter), or update ${PI_EXTENSION_PACKAGE} to ${PI_EXTENSION_WITHOUT_SKILLS} or later, which bundles no skills`};
}

/** The pi-skills-package-loaded warning for `agentDir`, or nothing: the
 *  folder's settings.json lists @awebai/claude-skills as a plain string or as
 *  an object without `"skills": []`, whatever the extension's version. Silent
 *  as piExtensionSkillsWarning is. */
export function piSkillsPackageWarning(agentDir) {
  const found = unfilteredEntry(agentDir, PI_SKILLS_PACKAGE);
  if (!found) return undefined;
  const {file, entry} = found;
  const edit = typeof entry === 'string' ? `remove the entry ${JSON.stringify(entry)}, or replace it with ${JSON.stringify({source: entry, skills: []})}` : `remove the entry whose "source" is ${JSON.stringify(entry.source)}, or set "skills": [] in it`;
  return {code: 'pi-skills-package-loaded', message: `pi loads the aweb skills of @awebai/claude-skills in every session that uses ${agentDir}: its settings.json lists ${JSON.stringify(PI_SKILLS_PACKAGE)} without a skills filter, and OATS gives a home its skills through its capabilities only. In ${file}, ${edit}, keeping the other entries`};
}
