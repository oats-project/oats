// oats.okf 6.0: the instance proposes its own knowledge as a pull request
// (the 6.0 build spec in the repository's docs/design/). Nothing harvests
// on its behalf: `oats okf propose` clones the soul's owned bases (--plan), checks
// the instance's edits and prints the complete outgoing diff and a digest
// (--check), then publishes exactly that through the package's publication
// helper (--apply). The knowledge maintainer gates every merge.
//
// The source record is consistency, not authorship: any caller that can run
// the command can name a home. What bounds a proposal is the soul's owned
// nodes, OKF validation, the content screen and the maintainer's review.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import { fs, join, resolve, dirname, safePath, atomic, hash, cleanEnv, exec, fail } from './io.mjs';
import { settings, resolveNodes, gitTimeoutMs } from './config.mjs';
import { git as rawGit, gitEnv, preflightLocalRepository, unavailable, validateBase, ID_WARNING, unstampedWarning } from './stores.mjs';
import { consultSource } from './sources.mjs';
import { harvestPolicy } from './harvest-policy.mjs';
import { isBridgedMeta } from './okf-reindex.mjs';
import { prepareSubjectProposal, checkWriteSurface, generatedPath, proposalFindings, proposalVerdicts, verdictSection } from './write-surface.mjs';
// The proposer's own copy of the shared publication helper (okf-authoring),
// byte-identical to the maintainer's: the SAME screen and publication calls
// the 5.x harvest procedure made (screen, commit, create), moved here.
import { execute } from '../skills/okf-authoring/scripts/okf-publication.mjs';
/** The one seam to the helper: every call goes through `publication.execute`
 *  (a test records the exact inputs; production never replaces it). */
export const publication = { execute };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const DIR = /^(\d{4}-\d{2}-\d{2})-(.+)$/;
const MAX_FILE = 4 * 1024 * 1024, MAX_NOTES = 100, MAX_TOTAL = 16 * 1024 * 1024;
const IDENTITY = ['-c', 'user.name=OKF harvest', '-c', 'user.email=okf@localhost', '-c', 'author.name=OKF harvest', '-c', 'author.email=okf@localhost',
  '-c', 'committer.name=OKF harvest', '-c', 'committer.email=okf@localhost', '-c', 'commit.gpgSign=false'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha256 = bytes => hash(bytes);
const present = p => { try { fs.lstatSync(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const failWith = (code, message, result) => { throw Object.assign(new Error(message), { code, ...(result ? { result } : {}) }); };
const parseJson = (bytes, label) => { try { return JSON.parse(bytes); } catch { return fail('E_SOURCE', `${label} is not readable JSON`); } };

// ------------------------------------------------------------ safe reads
// Every component below a trusted directory is checked; neither a symlinked
// note directory nor a FIFO is a file to read. Descriptor checks close a leaf
// replacement race. Consistency, not a UID sandbox.
function readWithin(root, path, code = 'E_SOURCE') {
  const rel = relative(root, path);
  if (!rel || isAbsolute(rel) || rel.split(sep).some(p => !p || p === '..' || p === '.')) fail(code, 'a source file escapes its directory');
  let at = root;
  for (const part of [null, ...rel.split(sep)]) {
    if (part !== null) at = join(at, part);
    const st = fs.lstatSync(at);
    if (st.isSymbolicLink() || (at !== path && !st.isDirectory())) fail(code, 'a source path contains a symlink or non-directory');
  }
  const before = fs.lstatSync(path);
  if (!before.isFile() || before.size > MAX_FILE) fail(code, 'a source file is not regular or exceeds 4 MiB');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino || st.size > MAX_FILE) fail(code, 'a source file changed while opening');
    const bytes = Buffer.alloc(st.size + 1);
    let n = 0, count;
    while (n < bytes.length && (count = fs.readSync(fd, bytes, n, bytes.length - n, null)) > 0) n += count;
    if (n !== st.size) fail(code, 'a source file changed while reading');
    return bytes.subarray(0, n);
  } finally { fs.closeSync(fd); }
}
const soulName = text => /^name:\s*['"]?([^'"\s#]+)/m.exec(text)?.[1] ?? null;
// A key position, never a word boundary (`oats.okf-harvest:` is a capability id).
const OPTED_OUT = /(?:^|[{,])[ \t]*(?:harvest|publish)[ \t]*:[ \t]*['"]?off['"]?[ \t]*(?:[,}#]|$)/m;

// ------------------------------------------------------------ the source
/** The home a proposal is read from: a live instance home, or the operator's
 *  recovery form (a retirement recovery directory, the one holding
 *  recovery.json). → { form, home, root, record, soul, decl, bindings, ... }. */
export function resolveSource(home, env = process.env) {
  home = safePath(resolve(home));
  let st; try { st = fs.lstatSync(home); } catch { fail('E_SOURCE', `${home} is not a directory: run oats okf propose from your instance home, or give --home <instance home | retirement recovery>`); }
  if (!st.isDirectory()) fail('E_SOURCE', `${home} is not a directory`);
  let form = 'live', root = home, manifest = null;
  if (present(join(home, 'recovery.json'))) {
    form = 'recovery';
    manifest = parseJson(readWithin(home, join(home, 'recovery.json')), 'retirement recovery manifest');
    if (manifest?.version !== 1 || manifest.phase !== 'complete' || typeof manifest.instance !== 'string' || typeof manifest.sourceHome !== 'string') fail('E_SOURCE', 'the retirement recovery is not a completed version 1 recovery of one instance');
    if (manifest.afterHooks !== undefined && (!object(manifest.afterHooks) || typeof manifest.afterHooks.home !== 'boolean')) fail('E_SOURCE', 'the retirement recovery has an invalid afterHooks receipt');
    root = join(home, ...(manifest.afterHooks?.home ? ['after-hooks', 'home'] : ['home']));
  }
  if (!present(join(root, 'instance.json'))) fail('E_SOURCE', `${form === 'live' ? home : 'the recovery copy'} has no instance record (instance.json): run oats okf propose from your instance home, or give --home <instance home | retirement recovery directory>`);
  const record = parseJson(readWithin(root, join(root, 'instance.json')), 'the instance record');
  if (!object(record) || typeof record.instance !== 'string' || !NAME.test(record.instance) || typeof record.createdAt !== 'string' || !record.createdAt || typeof record.home !== 'string') fail('E_SOURCE', 'the instance record names no instance, home or createdAt');
  if (record.kind === 'capability') fail('E_SOURCE', 'a service instance keeps no knowledge to propose');
  if (form === 'live') {
    let recorded; try { recorded = fs.realpathSync(record.home); } catch { recorded = record.home; }
    if (recorded !== fs.realpathSync(home)) fail('E_SOURCE', `the instance record names another home (${record.home}); for a retirement recovery give the recovery directory that holds recovery.json`);
  } else if (record.instance !== manifest.instance || record.home !== manifest.sourceHome) fail('E_SOURCE', 'the recovery copy\'s record does not match its retirement manifest');
  // The spawn-recorded duty, as `oats okf status` answers it. A LIVE home
  // without one (5.0/5.1) is refused; a recovery copy without one (a retired
  // 4.x or 5.0/5.1 seat) is decided below as 5.8's harvest spawn hook decided it.
  let policy;
  try { policy = harvestPolicy(root); } catch (e) { fail('E_SOURCE', `${e.message}`); }
  if (policy.harvest === 'unknown' && form === 'live') fail('E_SOURCE', 'this home has no spawn-recorded knowledge duty (okf-harvest-policy.json): it was spawned by oats.okf 5.0/5.1 or earlier; respawn it with the current oats.okf (`oats instance upgrade` keeps the duty unknown); nothing was cloned');
  // The soul: as recorded at spawn, and as the kernel dispatched it (OATS_SOUL).
  const souls = [];
  if (typeof record.soulDir === 'string' && isAbsolute(record.soulDir) && present(join(record.soulDir, 'soul.yaml'))) souls.push(['recorded', record.soulDir]);
  if (env.OATS_SOUL && isAbsolute(env.OATS_SOUL) && present(join(env.OATS_SOUL, 'soul.yaml'))) souls.push(['dispatched', env.OATS_SOUL]);
  if (!souls.length) fail('E_SOURCE', 'neither the recorded soul nor the dispatched soul (OATS_SOUL) has a readable soul.yaml');
  const texts = souls.map(([which, dir]) => [which, readWithin(fs.realpathSync(dir), join(fs.realpathSync(dir), 'soul.yaml')).toString('utf8')]);
  const names = new Set(texts.map(([, t]) => soulName(t)));
  if (names.size !== 1 || names.has(null)) fail('E_SOURCE', 'the soul given (--soul, or the instance\'s own) is not the soul this home\'s record was spawned from');
  const soul = [...names][0];
  // Bound to the record's own identity too, so an unreadable recorded soul
  // never lets another dispatched soul through: the record's agent is the
  // soul's name (a package soul's agent is <package>--<soul>).
  const agent = typeof record.agent === 'string' ? record.agent : null;
  if (!agent || (agent !== soul && !agent.endsWith(`--${soul}`))) fail('E_SOURCE', `the soul given (${soul}) is not the soul this home's record was spawned from (${agent ?? 'no agent recorded'})`);
  if (policy.harvest === 'off' || texts.some(([, t]) => OPTED_OUT.test(t))) fail('E_OPTED_OUT', `the soul ${soul} opts out (knowledge: { harvest: off } or { publish: off }): its instances never publish knowledge`);
  const legacyKeysIgnored = policy.harvest === 'unknown' ? retiredAdmission(record, texts.find(([which]) => which === 'recorded')?.[1], soul) : [];
  const { decl, bindings } = consultSource(root);
  const capabilities = [record.capabilities, record.capabilityRuntime].flatMap(l => Array.isArray(l) ? l : []);
  const tasksProvider = capabilities.find(c => c?.layer === 'tasks')?.id ?? null;
  const messaging = capabilities.some(c => c?.layer === 'messaging');
  const proposer = form === 'live'
    ? { form, instance: record.instance, alias: messaging ? record.instance : null }
    : { form, instance: typeof env.OATS_INSTANCE === 'string' && NAME.test(env.OATS_INSTANCE) ? env.OATS_INSTANCE : null, alias: null };
  return { form, home, root, record, soul, decl, bindings, tasksProvider: typeof tasksProvider === 'string' ? tasksProvider : null, proposer, legacyKeysIgnored };
}

/** A retired seat with no spawn-recorded duty (spawned on 4.x or 5.0/5.1),
 *  admitted as 5.8's harvest spawn hook admitted it (oats-okf#125, #128),
 *  which the 6.0 operator form keeps: the opt-out was already decided from the
 *  recorded soul.yaml text (no host setting masks it); any other soul
 *  `harvest`/`publish` value refuses; the record's removed 4.x keys are judged
 *  by their RECORDED origin. A manifest default was nobody's decision; a
 *  soul-origin key or one with no recorded origin fails closed; a host, spawn or
 *  workspace key was the deployment's consent to 4.x's own machinery and is
 *  ignored on a retired source. → the ignored keys. */
function retiredAdmission(record, soulText, soul) {
  if (typeof soulText !== 'string') fail('E_SOURCE', `the retired seat has no spawn-recorded duty and its recorded soul (soulDir) is not readable, so whether ${soul} opts out cannot be established`);
  // A KEY at a line start or after `{`/`,` in a flow mapping; never the bare word.
  if (/(?:^|[{,])[ \t]*(?:harvest|publish)[ \t]*:/m.test(soulText)) fail('E_SOURCE', `the recorded soul ${soul} declares a harvest or publish value other than off, which no version of oats.okf accepts as a decision; fix the soul's reviewed source (only knowledge: { harvest: off } is valid)`);
  const okf = record.providers?.['oats.okf'];
  if (!object(okf)) fail('E_SOURCE', `the retired seat ${record.instance} has no oats.okf knowledge slot in its record`);
  const origins = [record.capabilities, record.capabilityRuntime].flatMap(l => Array.isArray(l) ? l : []).find(c => c?.id === 'oats.okf')?.settingsOrigins;
  const ignored = [];
  for (const key of ['harvest', 'harvest-runtime', 'harvest-model'].filter(k => Object.hasOwn(okf, k))) {
    const kind = origins?.[`/${key}`]?.kind;
    if (kind === 'manifest-default') continue;
    if (key === 'harvest' && okf.harvest === 'off' && kind === 'soul') fail('E_OPTED_OUT', `the soul ${soul} opts out (recorded soul-origin harvest: off): its instances never publish knowledge`);
    if (typeof kind !== 'string') fail('E_SOURCE', `the record of retired seat ${record.instance} sets oats.okf ${key} with no recorded origin, so whether its soul opts out cannot be established`);
    if (kind === 'soul') fail('E_SOURCE', `the record of retired seat ${record.instance} sets oats.okf ${key} from soul, a setting removed in oats.okf 5.0 that no version accepts as a decision; fix the soul's reviewed source`);
    ignored.push(key);
  }
  return ignored;
}

/** The owned Git bases, and the owned directory bases skipped with a reason. */
function ownedBases(source) {
  // okf 6.0: a version-2 soul owns no node; it proposes to the bound Git bases
  // with the subject layout (plan keeps only those).
  if (source.decl.version === 2) {
    const git = [], skipped = [];
    for (const [alias, base] of Object.entries(source.bindings.bases)) {
      if (base.kind !== 'git') skipped.push({ alias, reason: `directory base ${alias} is unsupported for proposals: convert it to a Git base or edit it in a reviewed change` });
      else git.push({ alias, base, nodes: [] });
    }
    if (!git.length) fail('E_UNSUPPORTED', skipped.map(s => s.reason).join('; ') || 'no Git base is bound');
    return { git, skipped };
  }
  const aliases = [...new Set(source.decl.owns.map(ref => ref.split('/')[0]))];
  const git = [], skipped = [];
  for (const alias of aliases) {
    const base = source.bindings.bases[alias];
    if (!base) fail('E_CONFIG', `owned node base ${alias} is not bound in the bindings file`);
    if (base.kind !== 'git') skipped.push({ alias, reason: `directory base ${alias} is unsupported for proposals: convert it to a Git base or edit it in a reviewed change` });
    else git.push({ alias, base, nodes: source.decl.owns.filter(ref => ref.startsWith(`${alias}/`)).map(ref => ref.split('/')[1]) });
  }
  if (!git.length) fail('E_UNSUPPORTED', skipped.map(s => s.reason).join('; ') || 'the soul owns no node');
  return { git, skipped };
}

// ------------------------------------------------------------ the proposal directory
const proposalsRoot = source => join(source.root, 'proposals');
function findProposal(source, slug) {
  const dir = proposalsRoot(source);
  let names; try { names = fs.readdirSync(dir); } catch { names = []; }
  return names.filter(n => DIR.exec(n)?.[2] === slug).map(n => join(dir, n));
}
function proposalDir(source, slug) {
  const found = findProposal(source, slug);
  if (!found.length) fail('E_USAGE', `no proposal ${slug}: run oats okf propose --plan --slug ${slug} first`);
  if (found.length > 1) fail('E_PROPOSAL_EXISTS', `more than one proposal directory has slug ${slug}; remove the stale one`);
  return found[0];
}
function readPlan(dir) {
  const plan = parseJson(readWithin(dir, join(dir, 'plan.json'), 'E_PROPOSAL_FORMAT'), 'plan.json');
  const bad = () => fail('E_PROPOSAL_FORMAT', 'plan.json is not an oats okf propose plan; never edit it; remove the proposal directory and plan again');
  if (plan?.version !== 1 || !Array.isArray(plan.bases) || !plan.bases.length || plan.bases.length > 64) bad();
  // Every value reaches Git or a path: an alias is a plain name, the accepted
  // commit a full object id (never an option or a revision expression).
  const seen = new Set();
  for (const b of plan.bases) {
    if (!object(b) || Object.keys(b).some(k => !['alias', 'accepted'].includes(k)) || typeof b.alias !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(b.alias)
      || seen.has(b.alias) || typeof b.accepted !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(b.accepted)) bad();
    seen.add(b.alias);
  }
  return plan;
}

export const SKELETON = `# OKF proposal: <one-line claim>

## What
<!-- Each claim, one concept per file in an owned node of the clone, and the node it lands in. -->

## Why
<!-- Why it outlives this task: what a future instance would decide or do differently. -->

## Evidence
<!-- What was observed and when, with task refs; accepted concepts confirmed, refined or contradicted, cited alias/node/concept.md@<oid>. No home, machine or account paths. -->

## Backing notes
<!-- One line per note: - notes/<file>.md -->
`;
const stripComments = text => text.replace(/<!--[\s\S]*?-->/g, '');

// 5.x proposals did not prescribe a heading level or list grammar. Normalize
// explicit note references anywhere in the proposal, plus list entries under
// Backing notes. Unparseable note-bearing text is a format refusal, never an
// empty evidence list (the oats.okf 5.8 note-locator rules).
export function backingNotes(task) {
  const notes = new Set();
  const formatError = () => fail('E_PROPOSAL_FORMAT', 'unrecognized backing-note reference; reformat as a Backing notes list with one literal `- notes/<path>.md` entry per note');
  let inSection = false;
  for (const line of String(task).split(/\r?\n/)) {
    if (/^Source:/.test(line)) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) inSection = /^Backing notes\s*:?$/i.test(heading[2]);
    const entry = inSection && /^\s*[-*+]\s+(.+?)\s*$/.exec(line)?.[1];
    if (entry && (entry.match(/notes\//g) || []).length <= 1 && /^(?:`[^`]+`|notes\/.*\.md|notes\/\S+|\/\S+)$/.test(entry)) {
      notes.add(entry.replace(/^`(.*)`$/, '$1')); continue;
    }
    let consumed = 0;
    for (const match of line.matchAll(/notes\//g)) {
      const start = match.index;
      if (start < consumed) continue;
      const before = start ? line[start - 1] : '';
      let end, note;
      if (['`', '"', "'", '[', '('].includes(before)) {
        const closing = before === '[' ? ']' : before === '(' ? ')' : before;
        end = line.indexOf(closing, start);
        if (end < 0) formatError();
        note = line.slice(start, end);
        if (before === '(' && /[\s()]/.test(note)) formatError();
        const following = line.slice(end + 1);
        if (following && !/^(?:\s|[.,;!?:)\]]+(?:\s|$))/.test(following)) formatError();
        consumed = end + 1;
      } else if (!before || /\s/.test(before)) {
        const token = /^[^\s`"'<>\[\]()]+/.exec(line.slice(start))?.[0];
        if (!token) formatError();
        end = start + token.length;
        if (end < line.length && !/\s/.test(line[end])) formatError();
        note = token.replace(/[.,;!?:]+$/, '');
        consumed = end;
      } else formatError();
      if (!note.endsWith('.md')) formatError();
      notes.add(note);
    }
  }
  return [...notes];
}
// The provenance block's note grammar (oats.okf-maintenance parses it strictly).
// oats.okf 5.8's safeNote, unchanged: any filename under notes/ ending .md (a
// space or parentheses included), no backslash or control character, no
// empty, parent or hidden segment, at most 512 characters.
const safeNote = note => note.length <= 512 && /^notes\/.+\.md$/.test(note) && !/[\\\x00-\x1f\x7f]/.test(note) && note.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('.'));

/** proposal.md → { claim, bytes, body, notes } or E_PROPOSAL_FORMAT. */
function readProposal(dir) {
  let bytes;
  try { bytes = readWithin(dir, join(dir, 'proposal.md'), 'E_PROPOSAL_FORMAT'); }
  catch (e) { fail('E_PROPOSAL_FORMAT', `proposal.md is missing or unreadable (${e.message})`); }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('E_PROPOSAL_FORMAT', 'proposal.md is not UTF-8'); }
  const shown = stripComments(text);
  const lines = shown.split(/\r?\n/);
  const first = lines.find(l => l.trim());
  const claim = /^# OKF proposal:[ \t]*(.+?)\s*$/.exec(first ?? '')?.[1];
  if (!claim || claim.includes('<one-line claim>')) fail('E_PROPOSAL_FORMAT', 'proposal.md must start with `# OKF proposal: <your one-line claim>`');
  if (claim.length > 200) fail('E_PROPOSAL_FORMAT', 'the one-line claim is longer than 200 characters');
  if (/^```(?:okf-proposal|okf-harvest)\b/m.test(shown)) fail('E_PROPOSAL_FORMAT', 'proposal.md must not carry a provenance block: the command writes it');
  for (const section of ['What', 'Why', 'Evidence']) {
    const at = lines.flatMap((l, i) => new RegExp(`^##[ \\t]+${section}[ \\t]*$`).test(l) ? [i] : []);
    if (at.length !== 1) fail('E_PROPOSAL_FORMAT', `proposal.md needs exactly one \`## ${section}\` section`);
    const next = lines.findIndex((l, i) => i > at[0] && /^#{1,2}[ \t]/.test(l));
    if (!lines.slice(at[0] + 1, next < 0 ? undefined : next).some(l => l.trim())) fail('E_PROPOSAL_FORMAT', `the \`## ${section}\` section is empty`);
  }
  const notes = backingNotes(shown);
  if (notes.length > MAX_NOTES) fail('E_PROPOSAL_FORMAT', `proposal.md names more than ${MAX_NOTES} backing notes`);
  for (const note of notes) if (!safeNote(note)) fail('E_PROPOSAL_FORMAT', `backing note ${JSON.stringify(note).slice(0, 120)} is not a notes/<path>.md (no backslash or control character, no empty, hidden or parent segment)`);
  return { claim, bytes, body: shown.replace(/\n{3,}/g, '\n\n').trim() + '\n', notes };
}

/** Hash the named notes; a missing or unreadable one is dropped from evidence
 *  with a warning (E_NOTE), never hashed silently. */
function evidence(source, notes) {
  const out = [], warnings = [];
  let total = 0;
  for (const note of notes) {
    let bytes;
    try { bytes = readWithin(source.root, join(source.root, note), 'E_NOTE'); }
    catch (e) { out.push({ note }); warnings.push(`E_NOTE: ${note} is ${e.code === 'ENOENT' ? 'missing' : 'unreadable (a symlink, not a regular file, or over 4 MiB)'}: dropped from evidence, listed without a hash`); continue; }
    total += bytes.length;
    if (total > MAX_TOTAL) fail('E_PROPOSAL_FORMAT', 'the named notes exceed 16 MiB');
    out.push({ note, sha256: sha256(bytes) });
  }
  return { evidence: out, warnings };
}

// ------------------------------------------------------------ Git
/** Every Git call on a proposal clone. Git's own output (stderr from a
 *  filter, a hook-like helper, a path) never crosses into an error: a failure
 *  is E_GIT naming only the subcommand. Typed refusals pass through. */
function git(cwd, args, opts) {
  try { return rawGit(cwd, args, opts); }
  catch (e) {
    if (/^E_[A-Z_]+$/.test(e?.code || '') && e.code !== 'E_COMMAND') throw e;
    const sub = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '-c')[0];
    fail('E_GIT', `git ${/^[a-z-]{1,32}$/.test(sub ?? '') ? sub : '(command)'} failed on a proposal clone${Number.isInteger(e?.status) ? ` (exit ${e.status})` : ''}; Git's own output is withheld, as it may carry private content: inspect the clone by hand (git status) or plan a new proposal; nothing was pushed`);
  }
}
/** The planned clone, as plan made it: real directories from the proposal
 *  directory down (no symlink component), a self-contained `.git` directory
 *  (no gitfile, symlinked or shared gitdir), and Git agreeing on both. Checked
 *  before any Git read or write, so no mutation is redirected elsewhere. */
function ownClone(dir, clone, alias) {
  const bad = why => fail('E_PROPOSAL_FORMAT', `the clone of ${alias} is not the one plan made (${why}); never move or link it: plan a new proposal`);
  for (const p of [dirname(dir), dir, join(dir, 'work'), clone, join(clone, '.git')]) {
    let st; try { st = fs.lstatSync(p); } catch { bad(`${relative(dir, p) || 'the proposal directory'} is missing`); }
    if (!st.isDirectory()) bad(`${relative(dir, p) || 'the proposal directory'} is a symlink or not a directory`);
  }
  // Git's writable state stays inside the clone: no symlink and no hard link
  // anywhere under .git (refs, logs, objects, config, info…; plan clones with
  // --no-hardlinks), no shared or alternate object store.
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const at = join(d, e.name), shown = `.git/${relative(join(clone, '.git'), at)}`;
      if (e.isSymbolicLink()) bad(`${shown} is a symlink`);
      if (e.isDirectory()) walk(at);
      else if (fs.lstatSync(at).nlink !== 1) bad(`${shown} is hard-linked elsewhere`);
    }
  };
  walk(join(clone, '.git'));
  for (const f of ['commondir', 'objects/info/alternates', 'objects/info/http-alternates']) if (present(join(clone, '.git', f))) bad(`its .git shares another repository (${f})`);
  const real = fs.realpathSync(clone);
  let top, gitDir;
  try { top = git(clone, ['rev-parse', '--show-toplevel']); gitDir = git(clone, ['rev-parse', '--absolute-git-dir']); } catch { bad('Git cannot read it'); }
  if (fs.realpathSync(top) !== real || fs.realpathSync(gitDir) !== join(real, '.git')) bad('Git resolves it elsewhere');
}
// The clone itself: its failure is classified by unavailable() (no detail).
const gitRemote = (cwd, args) => rawGit(cwd, args, { timeout: gitTimeoutMs() });
function withIndex(clone, fn) {
  const scratch = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'okf-propose-'));
  try { return fn({ ...cleanEnv(), GIT_INDEX_FILE: join(scratch, 'index') }, scratch); }
  finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
/** The tree the clone's working files would publish, without touching its index. */
function workingTree(clone, accepted) {
  return withIndex(clone, env => {
    git(clone, ['read-tree', accepted], { env });
    git(clone, ['add', '-A', '--', '.'], { env });
    return git(clone, ['write-tree'], { env });
  });
}
function changes(clone, accepted, treeId) {
  const raw = git(clone, ['diff-tree', '-r', '-z', '--no-renames', `${accepted}^{tree}`, treeId], { trim: false });
  const parts = raw.split('\0'), out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])/.exec(parts[i]);
    if (!m) fail('E_SCOPE', 'unreadable tree difference');
    out.push({ oldMode: m[1], mode: m[2], status: m[3], path: parts[i + 1] });
  }
  return out;
}
const baseFile = (base, p) => base.root === '.' ? p : `${base.root}/${p}`;
/** The owned node paths in the accepted okf-base.json, after resolveNodes. */
function surface(clone, accepted, owned, decl, bindings) {
  let meta;
  try { meta = JSON.parse(git(clone, ['show', `${accepted}:${baseFile(owned.base, 'okf-base.json')}`])); }
  catch { fail('E_CONFIG', `base ${owned.alias}: no readable okf-base.json at the accepted commit`); }
  if (!object(meta?.nodes) || meta.id !== owned.base.id) fail('E_CONFIG', `base ${owned.alias}: okf-base.json does not match the bound base identity`);
  const refs = owned.nodes.map(node => `${owned.alias}/${node}`);
  if (decl.version !== 2) resolveNodes({ owner: decl.owner, owns: refs, reads: [] }, bindings, { [owned.alias]: { nodes: meta.nodes } });
  const paths = owned.nodes.map(node => meta.nodes[node].path);
  const others = Object.entries(meta.nodes).filter(([node]) => !owned.nodes.includes(node)).map(([node, spec]) => ({ node, path: spec.path }));
  // okf 6.0: the subject layout, decided by the ACCEPTED okf-base.json.
  const subjects = isBridgedMeta(meta);
  const shown = subjects && decl.version === 2
    ? ['claims/', 'new subjects/system/ and subjects/project/ files', 'status: superseded on a concept it supersedes', 'the generated indexes (regenerated by --check)'].map(x => owned.base.root === '.' ? x : `${owned.base.root}/${x}`)
    : [...paths.map(p => `${baseFile(owned.base, p)}/`), baseFile(owned.base, 'index.md'), ...(subjects ? ['the generated indexes (regenerated by --check)'] : [])];
  return { paths, others, nodes: refs, subjects, shown, ownedNodes: Object.fromEntries(owned.nodes.map(node => [node, meta.nodes[node].path])) };
}
const baseRel = (base, p) => base.root === '.' ? p : p.slice(base.root.length + 1);
/** Root containment, hidden paths and file modes: every proposal, any layout. */
function checkFiles(owned, list) {
  for (const c of list) {
    const shown = JSON.stringify(c.path).slice(0, 200);
    if (owned.base.root !== '.' && !c.path.startsWith(`${owned.base.root}/`)) fail('E_SCOPE', `${shown} is outside base ${owned.alias}'s root`);
    if (baseRel(owned.base, c.path).split('/').some(p => p.startsWith('.'))) fail('E_SCOPE', `${shown}: hidden paths are not knowledge`);
    if (c.status !== 'D' && c.mode !== '100644') fail('E_SCOPE', `${shown}: only regular, non-executable Markdown files may be proposed`);
  }
}
/** Node ownership (a version-1 soul); checkFiles has already judged root
 *  containment, hidden paths and modes. */
function checkScope(owned, scope, list) {
  for (const c of list) {
    const shown = JSON.stringify(c.path).slice(0, 200);
    const rel = baseRel(owned.base, c.path);
    if (rel === 'index.md') continue;
    const other = scope.others.find(n => rel === n.path || rel.startsWith(`${n.path}/`));
    if (other) fail('E_OWNER', `${shown} is in node ${owned.alias}/${other.node}, which this soul does not own; leave that claim for the node's owner`);
    if (!scope.paths.some(p => rel.startsWith(`${p}/`))) fail('E_SCOPE', `${shown} is outside the write surface: the owned nodes (${scope.paths.join(', ')}) and the base root index.md`);
    if (!rel.endsWith('.md')) fail('E_SCOPE', `${shown} is not a Markdown concept`);
  }
}
/** The tree's exact bytes in `out`: every blob as stored (git cat-file
 *  --batch), never through a checkout, so no smudge filter, working-tree
 *  encoding or ident expansion can show the validator something other than
 *  what would be published. */
function rawTree(clone, treeId, out) {
  const listing = git(clone, ['ls-tree', '-r', '-z', '--full-tree', treeId], { trim: false, maxBuffer: 64 * 1024 * 1024 });
  const entries = [];
  for (const rec of listing.split('\0').filter(Boolean)) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(rec);
    if (!m) fail('E_GIT', 'git ls-tree answered an unreadable entry for the proposed tree');
    const [, mode, type, oid, path] = m;
    if (type !== 'blob') continue;
    if (path.split('/').some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) fail('E_VALIDATION', `the proposed tree has an unsafe path ${JSON.stringify(path).slice(0, 200)}`);
    entries.push({ mode, oid, path });
  }
  if (!entries.length) return;
  const r = spawnSync('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-C', clone, 'cat-file', '--batch'],
    { input: entries.map(e => e.oid).join('\n') + '\n', env: gitEnv(), maxBuffer: 512 * 1024 * 1024 });
  if (r.error || r.status !== 0) fail('E_GIT', `git cat-file failed on a proposal clone${Number.isInteger(r.status) ? ` (exit ${r.status})` : ''}; Git's own output is withheld`);
  let at = 0;
  for (const e of entries) {
    const nl = r.stdout.indexOf(10, at), header = r.stdout.subarray(at, nl).toString('utf8');
    const size = Number(/^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1]);
    if (nl < 0 || !Number.isSafeInteger(size)) fail('E_GIT', 'git cat-file answered an unreadable object for the proposed tree');
    const bytes = r.stdout.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    const file = join(out, ...e.path.split('/'));
    fs.mkdirSync(dirname(file), { recursive: true });
    if (e.mode === '120000') fs.symlinkSync(bytes.toString('utf8'), file);
    else fs.writeFileSync(file, bytes, { mode: e.mode === '100755' ? 0o755 : 0o644 });
  }
}
/** A reader of the accepted commit's stored bytes by repository path: null
 *  only for a path the accepted tree has no file at (its full listing, read
 *  once); a blob that cannot be read, whatever its size, is refused (E_GIT),
 *  never taken for an absent file. */
export function acceptedReader(clone, accepted) {
  let entries = null;
  return path => {
    if (!entries) {
      entries = new Map();
      const listing = git(clone, ['ls-tree', '-r', '-z', '--full-tree', '-l', accepted], { trim: false, maxBuffer: 64 * 1024 * 1024 });
      for (const rec of listing.split('\0').filter(Boolean)) {
        const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(-|\d+)\t(.+)$/s.exec(rec);
        if (!m) fail('E_GIT', 'git ls-tree answered an unreadable entry for the accepted tree');
        if (m[2] === 'blob') entries.set(m[5], { oid: m[3], size: Number(m[4]) });
      }
    }
    const e = entries.get(path);
    if (!e) return null;
    return git(clone, ['cat-file', 'blob', e.oid], { trim: false, maxBuffer: e.size + 1024 });
  };
}
/** The proposal's tree once the subject layout is prepared on its stored
 *  bytes (not the checkout: no smudge or ident expansion reaches about: or a
 *  generated index): `prepare(baseDir)` edits a raw copy of `treeId`, its
 *  changed files enter a new tree byte for byte (no filters), and are copied
 *  back into the clone for the proposer to see. → the new tree id. */
function preparedTree(clone, owned, treeId, prepare) {
  return withIndex(clone, (env, scratch) => {
    const out = join(scratch, 'tree');
    fs.mkdirSync(out);
    rawTree(clone, treeId, out);
    const base = owned.base.root === '.' ? out : join(out, owned.base.root);
    const { about, regenerated } = prepare(base);
    const touched = [...new Set([...about, ...regenerated])];
    if (!touched.length) return treeId;
    git(clone, ['read-tree', treeId], { env });
    const records = [];
    for (const p of touched) {
      const file = join(base, ...p.split('/')), full = baseFile(owned.base, p);
      if (fs.existsSync(file)) records.push(`100644 ${git(clone, ['hash-object', '-w', '--no-filters', '--', file], { env })}\t${full}`);
      else records.push(`0 ${'0'.repeat(treeId.length)}\t${full}`);
    }
    git(clone, ['update-index', '-z', '--index-info'], { env, input: records.join('\0') + '\0' });
    const prepared = git(clone, ['write-tree'], { env });
    // Back into the clone in its working-tree form: Git checks the prepared
    // blobs out (smudge, encoding and its own path checks), so the next
    // --check or --apply cleans them back to the same stored bytes.
    const cloneBase = owned.base.root === '.' ? clone : join(clone, owned.base.root);
    const kept = touched.filter(p => fs.existsSync(join(base, ...p.split('/'))));
    if (kept.length) git(clone, ['checkout-index', '-f', '-z', '--stdin'], { env, input: kept.map(p => baseFile(owned.base, p)).join('\0') + '\0' });
    for (const p of touched.filter(x => !kept.includes(x))) { const there = join(cloneBase, ...p.split('/')); if (fs.lstatSync(there, { throwIfNoEntry: false })?.isFile()) fs.rmSync(there); }
    return prepared;
  });
}
/** Validate the proposed tree's stored bytes; `inspect(baseDir)` first runs
 *  any other check that must see the same frozen bytes (the subject layout's
 *  write surface and verdict lanes), its refusal unwrapped. */
function validateTree(clone, owned, treeId, allow, inspect) {
  withIndex(clone, (env, scratch) => {
    const out = join(scratch, 'tree');
    fs.mkdirSync(out);
    rawTree(clone, treeId, out);
    if (inspect) inspect(owned.base.root === '.' ? out : join(out, owned.base.root));
    try { validateBase(owned.base.root === '.' ? out : join(out, owned.base.root), owned.base, allow ? { allow } : {}); }
    catch (e) { fail('E_VALIDATION', `base ${owned.alias}: the proposed tree is not a valid OKF base (okf-validate --strict): ${e.message.replaceAll(out, '<clone>')}`); }
  });
}

// ------------------------------------------------------------ outgoing texts
/** The v3 provenance block. A soul declared by subjects (okf.json version 2:
 *  no owner/owns/reads) writes source.subjects, owner null and no nodes. */
export function provenance(source, bases, ev) {
  const decl = source.decl, owns = decl.owns ?? [], subjects = Array.isArray(decl.subjects) ? { subjects: [...decl.subjects] } : {};
  return {
    version: 3,
    source: {
      soul: source.soul, owner: decl.owner ?? null, instance: source.record.instance, incarnation: source.record.createdAt, ...subjects,
      ownedNodes: owns, readNodes: (decl.reads ?? []).filter(r => !owns.includes(r)),
      bases: bases.map(b => ({ alias: b.alias, id: b.base.id, kind: 'git', root: b.base.root, repository: b.base.pr.repository })),
    },
    evidence: ev,
    tasks: { provider: source.tasksProvider, refs: [] },
    proposer: source.proposer,
  };
}
const commitText = (source, proposal) => `okf-proposal: ${proposal.claim}\n\nSource: instance ${source.record.instance}, soul ${source.soul}\n`;
const prBody = (proposal, block, candidates = '') => `${proposal.body}${candidates ? `\n${candidates}` : ''}\n\`\`\`okf-proposal\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
function termsFile() {
  const file = settings()['screen-terms-file'];
  if (file === undefined) return undefined;
  if (typeof file !== 'string' || !isAbsolute(file) || resolve(file) !== file) fail('E_CONFIG', 'screen-terms-file must be a normalized absolute path');
  return file;
}
/** Run one helper command in process; its refusals keep their codes. */
function runHelper(command, options) {
  try { return publication.execute(command, { ...options }); }
  catch (e) {
    const code = /^E_[A-Z_]+$/.test(e.code || '') ? e.code : 'E_PUBLICATION';
    const result = { ...(e.findings ? { findings: e.findings } : {}), ...(e.diagnostic ? { diagnostic: e.diagnostic } : {}) };
    failWith(code, code === 'E_CONTENT_REFUSED' ? 'the content screen refused the outgoing content (findings name locations only; nothing left this host)' : code === 'E_CONTENT_INPUT' ? 'the content screen could not read an input (an outgoing text or the host terms file)' : `the publication helper refused (${code})`, result);
  }
}

/** Everything --check verifies and --apply re-verifies. Writes only the
 *  outgoing texts under the proposal directory; nothing remote. */
function prepare(source, dir, plan) {
  const proposal = readProposal(dir);
  const { evidence: ev, warnings } = evidence(source, proposal.notes);
  const { git: bases } = ownedBases(source);
  const terms = termsFile();
  const outgoing = join(dir, 'outgoing');
  fs.mkdirSync(outgoing, { recursive: true, mode: 0o700 });
  const message = commitText(source, proposal);
  const results = [], checked = [], verdicts = [];
  for (const entry of plan.bases) {
    const owned = bases.find(b => b.alias === entry.alias);
    if (!owned) fail('E_SOURCE', `the plan's base ${entry.alias} is no longer an owned Git base; plan a new proposal`);
    const clone = join(dir, 'work', entry.alias);
    ownClone(dir, clone, entry.alias);
    const accepted = entry.accepted;
    if (git(clone, ['cat-file', '-t', accepted]) !== 'commit') fail('E_PROPOSAL_FORMAT', `plan.json's accepted commit for ${entry.alias} is not a commit in its clone; plan a new proposal`);
    const scope = surface(clone, accepted, owned, source.decl, source.bindings);
    if (source.decl.version === 2 && !scope.subjects) fail('E_CONFIG', `base ${owned.alias} has no subject layout; declare owns/reads (version 1) or bridge the base (release note §7.2)`);
    let treeId = workingTree(clone, accepted), list = changes(clone, accepted, treeId);
    if (!list.length) { results.push({ alias: entry.alias, clone, accepted, tree: treeId, changed: [] }); continue; }
    checkFiles(owned, list);
    let allow, inspect, unstamped = 0;
    if (scope.subjects) {
      // okf 6.0, the subject layout (spec §3): a version-1 soul's new claims get
      // about: from legacy-nodes, every generated index is regenerated, then the
      // write surface, the proposal's own ids and the verdict lanes.
      const rel = l => l.map(c => ({ path: baseRel(owned.base, c.path), status: c.status }));
      treeId = preparedTree(clone, owned, treeId, base => prepareSubjectProposal({ root: base, decl: source.decl, ownedNodes: scope.ownedNodes, changes: rel(list) }));
      list = changes(clone, accepted, treeId);
      checkFiles(owned, list);
      if (source.decl.version !== 2) checkScope(owned, scope, list.filter(c => !generatedPath(baseRel(owned.base, c.path))));
      // The write surface and the verdict lanes judge stored bytes on both
      // sides (the accepted blob, the proposed tree's blob), never a checkout:
      // a smudge or ident expansion in the clone changes neither.
      const readAccepted = acceptedReader(clone, accepted), before = p => readAccepted(baseFile(owned.base, p));
      const changed = rel(list);
      inspect = proposed => {
        checkWriteSurface({ root: proposed, decl: source.decl, ownedNodes: scope.ownedNodes, changes: changed, before });
        verdicts.push(...proposalVerdicts(proposed, changed).map(v => ({ ...v, path: baseFile(owned.base, v.path) })));
      };
      // okf 6.0.2 (#138): a claims/ concept the base already holds without id
      // (merged without the maintainer's stamp) does not refuse the proposal;
      // it is reported as the readers report it, W_ID_MISSING. 6.0.3 (#140):
      // so is an old-node concept merged the same way (a version-1 proposal).
      allow = findings => {
        const rest = proposalFindings(findings, changed), kept = rest.filter(f => !ID_WARNING.test(f));
        unstamped = rest.length - kept.length;
        return kept;
      };
    } else checkScope(owned, scope, list);
    validateTree(clone, owned, treeId, allow, inspect);
    if (unstamped) warnings.push(unstampedWarning(unstamped, `${entry.alias}@${accepted.slice(0, 12)}`));
    // What the clone's files stage to now: --apply refuses if they move
    // before it stages the checked tree (which, prepared on stored bytes, may
    // differ from it under a clean filter).
    const staged = scope.subjects ? workingTree(clone, accepted) : treeId;
    checked.push({ entry, owned, clone, accepted, treeId, list, staged });
  }
  const block = provenance(source, source.decl.version === 2 ? bases.filter(b => plan.bases.some(e => e.alias === b.alias)) : bases, ev), body = prBody(proposal, block, verdictSection(verdicts));
  for (const { entry, owned, clone, accepted, treeId, list, staged } of checked) {
    // outgoing/ keeps a readable copy; the screen reads this invocation's own
    // private copy, so a concurrent --check cannot swap the bytes it screens.
    const commitFile = join(outgoing, `${entry.alias}-commit.txt`), bodyFile = join(outgoing, `${entry.alias}-pr.md`);
    atomic(commitFile, message); atomic(bodyFile, body);
    // A throwaway commit of exactly what would be pushed: the helper screens
    // the full outgoing history, the commit text and the PR body.
    const probe = git(clone, [...IDENTITY, 'commit-tree', treeId, '-p', accepted], { input: message });
    const scratch = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'okf-propose-texts-'));
    try {
      const own = [join(scratch, `${entry.alias}-commit.txt`), join(scratch, `${entry.alias}-pr.md`)];
      fs.writeFileSync(own[0], message, { mode: 0o600 }); fs.writeFileSync(own[1], body, { mode: 0o600 });
      runHelper('screen', { repo: clone, base: accepted, head: probe, 'text-file': own, ...(terms ? { 'terms-file': terms } : {}) });
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
    const diff = git(clone, ['diff', '--no-color', '--no-renames', '--no-ext-diff', '--text', '--no-textconv', accepted, probe], { trim: false, maxBuffer: 64 * 1024 * 1024 });
    results.push({ alias: entry.alias, clone, accepted, tree: treeId, staged, owned, changed: list.map(c => `${c.status} ${c.path}`), diff, commitFile, bodyFile });
  }
  if (!results.some(r => r.changed.length)) fail('E_USAGE', 'nothing to propose: no owned base changed. If nothing passed the promotion test, record that in log.md and remove the proposal directory');
  // The digest binds every byte --apply publishes: the trees, the proposal,
  // the evidence, and the generated commit text and PR body themselves.
  const digest = hash({ version: 2, bases: results.map(r => ({ alias: r.alias, accepted: r.accepted, tree: r.tree })), proposal: sha256(proposal.bytes), evidence: ev,
    commitText: sha256(Buffer.from(message)), prBody: sha256(Buffer.from(body)) });
  return { proposal, evidence: ev, warnings, body, message, results, digest, terms };
}

// ------------------------------------------------------------ the three steps
/** Open okf-proposal and okf-harvest PRs on the base: duplicate candidates,
 *  informative only. Best effort: gh absent or failing never refuses a plan. */
function duplicates(base) {
  const out = [];
  for (const label of ['okf-proposal', 'okf-harvest']) {
    try {
      const rows = JSON.parse(exec('gh', ['pr', 'list', '--repo', base.pr.repository, '--label', label, '--state', 'open', '--limit', '100', '--json', 'number,title,url'], { timeout: 30000 }));
      for (const r of Array.isArray(rows) ? rows : []) out.push({ label, number: r.number, title: String(r.title ?? '').slice(0, 200), url: String(r.url ?? '') });
    } catch { return { unavailable: 'gh pr list failed or gh is absent: open proposals could not be listed; check them by hand' }; }
  }
  return out;
}

export function plan(source, slug) {
  if (findProposal(source, slug).length) fail('E_PROPOSAL_EXISTS', `a proposal with slug ${slug} already exists under proposals/; choose another slug, or remove the old directory once it is no longer needed`);
  const { git: bases, skipped } = ownedBases(source);
  const date = new Date().toISOString().slice(0, 10);
  const parent = proposalsRoot(source), dir = join(parent, `${date}-${slug}`);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(join(parent, `.plan-${slug}-`));
  try {
    const rows = [], noLayout = [];
    for (const owned of bases) {
      const clone = join(staging, 'work', owned.alias);
      fs.mkdirSync(dirname(clone), { recursive: true, mode: 0o700 });
      preflightLocalRepository(owned.base, owned.alias, { detail: false });
      try { gitRemote(dirname(clone), ['clone', '--quiet', '--no-tags', '--no-hardlinks', '--single-branch', '--branch', owned.base.acceptedBranch, '--', owned.base.repository, clone]); }
      catch (e) { unavailable(owned.base, owned.alias, 'clone', e, { detail: false }); }
      const accepted = git(clone, ['rev-parse', '--verify', `refs/remotes/origin/${owned.base.acceptedBranch}^{commit}`]);
      const scope = surface(clone, accepted, owned, source.decl, source.bindings);
      if (source.decl.version === 2 && !scope.subjects) { fs.rmSync(clone, { recursive: true, force: true }); noLayout.push(owned.alias); continue; }
      rows.push({ alias: owned.alias, accepted, root: owned.base.root, nodes: scope.nodes, ...(scope.subjects ? { layout: 'subjects' } : {}), surface: scope.shown, duplicates: duplicates(owned.base) });
    }
    if (!rows.length) fail('E_CONFIG', `${noLayout.length > 1 ? `bases ${noLayout.join(', ')} have` : `base ${noLayout[0]} has`} no subject layout; declare owns/reads (version 1) or bridge the base (release note §7.2)`);
    atomic(join(staging, 'proposal.md'), SKELETON);
    atomic(join(staging, 'plan.json'), JSON.stringify({ version: 1, slug, form: source.form, bases: rows.map(({ alias, accepted }) => ({ alias, accepted })) }, null, 2) + '\n');
    fs.renameSync(staging, dir);
    return { proposal: dir, form: source.form, source: { instance: source.record.instance, soul: source.soul, owner: source.decl.owner }, ...(source.legacyKeysIgnored.length ? { legacyKeysIgnored: source.legacyKeysIgnored } : {}),
      bases: rows.map(r => ({ ...r, clone: join(dir, 'work', r.alias) })), skipped,
      next: `write the knowledge in each clone (${source.decl.version === 2 ? 'claims/, with about: [<kind>/<slug>] on each claim and no id' : 'owned nodes and the base root index.md only'}), fill ${join(dir, 'proposal.md')}, then oats okf propose --check --slug ${slug}` };
  } catch (e) { fs.rmSync(staging, { recursive: true, force: true }); throw e; }
}

export function check(source, slug) {
  const dir = proposalDir(source, slug), p = prepare(source, dir, readPlan(dir));
  return { proposal: dir, digest: p.digest, warnings: p.warnings, evidence: p.evidence,
    bases: p.results.filter(r => r.changed.length).map(r => ({ alias: r.alias, accepted: r.accepted, changed: r.changed, diff: r.diff })),
    unchanged: p.results.filter(r => !r.changed.length).map(r => r.alias),
    commitText: p.message, prBody: p.body,
    next: `read the complete outgoing diff, commit text and PR body above once as a reviewer would (knowledge-theory's reject list; no personal data, secrets or private paths), then oats okf propose --apply --slug ${slug} --digest ${p.digest}` };
}

export function apply(source, slug, expected) {
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) fail('E_USAGE', '--apply needs --digest <the 64-hex digest --check printed>');
  const dir = proposalDir(source, slug);
  const p = prepare(source, dir, readPlan(dir));
  if (p.digest !== expected) fail('E_DIGEST', 'the clone, proposal.md, a named note or the generated commit text or PR body changed since --check (or the digest is not the one it printed): run --check again and read its diff before --apply');
  // The publish directory is the attempt marker: one attempt per proposal.
  const publish = join(dir, 'publish');
  try { fs.mkdirSync(publish, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') fail('E_PROPOSAL_EXISTS', `this proposal was already applied or attempted (see ${publish}); never retry it: plan a new proposal if knowledge is still missing`); throw e; }
  const published = [];
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  for (const r of p.results.filter(x => x.changed.length)) {
    const branch = `okf-proposal/${stamp}-${randomUUID()}`;
    const report = join(publish, `${r.alias}-result.json`);
    // The digest bound these exact texts in memory: snapshot them into this
    // attempt's own directory (a concurrent --check rewrites outgoing/).
    const commitFile = join(publish, `${r.alias}-commit.txt`), bodyFile = join(publish, `${r.alias}-pr.md`);
    atomic(commitFile, p.message); atomic(bodyFile, p.body);
    try {
      git(r.clone, ['update-ref', `refs/heads/${branch}`, r.accepted, '']);
      git(r.clone, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      // The checked tree is staged as is (the helper commits the index); the
      // clone's files must still stage to what --check saw.
      if (workingTree(r.clone, r.accepted) !== r.staged) fail('E_DIGEST', `base ${r.alias}: the clone changed after the digest was checked; nothing was pushed`);
      git(r.clone, ['read-tree', r.tree]);
      if (git(r.clone, ['write-tree']) !== r.tree) fail('E_DIGEST', `base ${r.alias}: the staged tree is not the checked one; nothing was pushed`);
      const terms = p.terms ? { 'terms-file': p.terms } : {};
      const committed = runHelper('commit', { repo: r.clone, base: r.accepted, head: r.accepted, branch, 'commit-file': commitFile, ...terms });
      // The helper commits the clone's index, which another process could have
      // changed since the comparison above: the commit object is immutable, so
      // its tree must be the digest-bound one before anything leaves the host.
      if (!/^[0-9a-f]{40,64}$/.test(committed?.head ?? '') || git(r.clone, ['rev-parse', '--verify', `${committed.head}^{tree}`]) !== r.tree) fail('E_DIGEST', `base ${r.alias}: the committed tree is not the one --check showed (the clone's index changed during --apply); nothing was pushed`);
      const created = runHelper('create', { repo: r.clone, remote: r.owned.base.repository, github: r.owned.base.pr.repository, base: r.accepted,
        'base-branch': r.owned.base.acceptedBranch, head: committed.head, branch, 'body-file': bodyFile, 'guard-file': baseFile(r.owned.base, 'okf-base.json'), ...terms });
      const row = { alias: r.alias, url: created.url, head: created.head, branch: created.branch, base: created.base, recovered: created.recovered };
      atomic(report, JSON.stringify({ ok: true, ...row }, null, 2) + '\n');
      published.push(row);
    } catch (e) {
      const code = /^E_[A-Z_]+$/.test(e.code || '') ? e.code : 'E_PUBLICATION';
      const safe = { ok: false, alias: r.alias, code, ...(e.result?.findings ? { findings: e.result.findings } : {}), ...(e.result?.diagnostic ? { diagnostic: e.result.diagnostic } : {}) };
      try { atomic(report, JSON.stringify(safe, null, 2) + '\n'); } catch { /* the error below still reports */ }
      failWith(code, `publication of base ${r.alias} stopped (${code}); ${published.length ? `already opened: ${published.map(x => x.url).join(', ')}; ` : ''}the clone, the commit text, the PR body and the safe result are retained in the proposal directory. Do not retry: report it${['E_PUSH_UNCERTAIN', 'E_PR_UNCERTAIN', 'E_GH'].includes(code) ? '; a remote branch or PR may exist, never assume it does not' : ''}`,
        { published, failed: safe, proposal: dir });
    }
  }
  atomic(join(dir, 'published.json'), JSON.stringify({ version: 1, prs: published }, null, 2) + '\n');
  return { proposal: dir, prs: published, warnings: p.warnings,
    next: 'record each PR URL in log.md and go back to work; the knowledge maintainer reviews it (the proposal-review trigger), you never shepherd it' };
}

// ------------------------------------------------------------ text
export function render(step, r) {
  if (step === 'plan') return [`proposal ${r.proposal} (${r.form})`,
    ...r.bases.flatMap(b => [`base ${b.alias}: clone ${b.clone} at ${b.accepted.slice(0, 12)}`, `  write surface: ${b.surface.join(', ')}`,
      `  open proposals (duplicate candidates): ${Array.isArray(b.duplicates) ? (b.duplicates.map(d => `#${d.number} [${d.label}] ${d.title}`).join('; ') || 'none') : b.duplicates.unavailable}`]),
    ...r.skipped.map(s => `skipped: ${s.reason}`), `next: ${r.next}`].join('\n');
  if (step === 'check') return [`proposal ${r.proposal}`, ...r.warnings.map(w => `warning: ${w}`),
    ...r.bases.flatMap(b => [`===== base ${b.alias} (onto ${b.accepted.slice(0, 12)}): ${b.changed.length} changed`, ...b.changed.map(c => `  ${c}`), '----- diff', b.diff.trimEnd()]),
    ...(r.unchanged.length ? [`unchanged: ${r.unchanged.join(', ')} (no PR)`] : []),
    '===== commit text', r.commitText.trimEnd(), '===== PR body (title: OKF knowledge proposal)', r.prBody.trimEnd(), `===== digest ${r.digest}`, `next: ${r.next}`].join('\n');
  return [`proposal ${r.proposal}`, ...r.warnings.map(w => `warning: ${w}`), ...r.prs.map(x => `opened ${x.url} (${x.branch} at ${x.head.slice(0, 12)}, onto ${x.base.slice(0, 12)}, base-move recoveries ${x.recovered})`), `next: ${r.next}`].join('\n');
}

/** `oats okf propose --plan | --check | --apply --slug S [--digest D]`. */
export function propose(home, flags, env = process.env) {
  const steps = ['plan', 'check', 'apply'].filter(s => flags[s]);
  if (steps.length !== 1) fail('E_USAGE', 'give exactly one of --plan, --check or --apply');
  const [step] = steps;
  if (typeof flags.slug !== 'string' || !SLUG.test(flags.slug)) fail('E_USAGE', '--slug must be lowercase letters, digits and inner dashes (at most 64), naming this proposal');
  if (step !== 'apply' && flags.digest !== undefined) fail('E_USAGE', '--digest belongs to --apply');
  const source = resolveSource(home, env);
  const result = step === 'plan' ? plan(source, flags.slug) : step === 'check' ? check(source, flags.slug) : apply(source, flags.slug, flags.digest);
  return { result, text: render(step, result) };
}
