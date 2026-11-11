#!/usr/bin/env node
// Publication gate, not a sandbox: callers still have their native credentials.
// Never forward Git/gh stderr, matched values, or raw remote response text.
import fs from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { screenBytes, screenText } from './okf-content-screen.mjs';

const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX = 16 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function invalid(location, rule = 'input-utf8-or-limit', code = 'E_CONTENT_INPUT') {
  throw Object.assign(new Error(code), { code, findings: [{ location, line: 1, rule }] });
}
function inspectBytes(bytes, location, options) {
  try { return screenBytes(bytes, location, options); }
  catch { invalid(location); }
}
const oid = value => { if (!OID.test(value || '')) fail('E_OID'); return value; };
// Native credentials stay available; inherited Git selectors, external diff,
// replacement objects, hooks and interactive prompts cannot change the gate.
function env() {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k))),
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
}
// Nullable fields mean the OS supplied no usable exit/signal, not invented
// process outcomes. Never serialize an Error, raw tool bytes, or a free string.
const SIGNALS = new Set(['SIGABRT', 'SIGALRM', 'SIGBREAK', 'SIGBUS', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGUSR1', 'SIGUSR2', 'SIGXCPU', 'SIGXFSZ']);
const CAUSES = [
  [/terminal prompts disabled|could not read Username/i, 'auth-required'],
  [/Authentication failed|Permission denied \(publickey\)/i, 'auth-denied'],
  [/Could not resolve host/i, 'host-unresolved'],
  [/connection (?:refused|timed out)/i, 'connection-failed'],
];
export function uncertaintyDiagnostic(result = {}, elapsedMs = 0) {
  const diagnostic = {
    phase: 'push',
    exitCode: Number.isSafeInteger(result.status) ? result.status : null,
    signal: SIGNALS.has(result.signal) ? result.signal : null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    elapsedMs: Number.isFinite(elapsedMs) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(elapsedMs))) : 0,
  };
  if (result.error || result.signal || result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : typeof result.stderr === 'string' ? result.stderr : '';
    // Remote-controlled lines never supply a cause, even if they copy a client
    // phrase. Stdout is deliberately not an input to this classification.
    const lines = stderr.split('\n').map(line => line.trimStart());
    // Protocol ERR/report-status diagnostics can quote remote payloads with
    // unprefixed continuation lines. Exclude the whole tail, including unpack
    // failures, malformed remote status and other protocol-error renderers.
    const remoteError = lines.findIndex(line => /^(?:fatal|error|warning):\s+(?:remote\b|unable to parse remote unpack status:|protocol error:)/i.test(line));
    const clientLines = (remoteError < 0 ? lines : lines.slice(0, remoteError))
      .filter(line => !/^remote:/i.test(line));
    const cause = CAUSES.find(([pattern]) => clientLines.some(line => pattern.test(line)))?.[1];
    if (cause) diagnostic.cause = cause;
  }
  return diagnostic;
}
function uncertain(code, diagnostic) {
  throw Object.assign(new Error(code), { code, diagnostic: diagnostic ?? uncertaintyDiagnostic() });
}
function run(command, args, { cwd, input, optional = false, indexFile, publication = false } = {}) {
  const childEnv = env();
  // Only an internally-created private reconciliation index supplies this.
  // Inherited GIT_INDEX_FILE was already removed by env().
  if (indexFile) childEnv.GIT_INDEX_FILE = indexFile;
  if (publication) childEnv.LC_ALL = 'C';
  const started = performance.now();
  const r = spawnSync(command, args, { cwd, input, env: childEnv, timeout: 60000, maxBuffer: MAX });
  const diagnostic = publication ? uncertaintyDiagnostic(r, performance.now() - started) : undefined;
  if (r.error || r.signal || r.status !== 0) {
    if (optional && !r.error && !r.signal && r.status === 1) return null;
    const code = command === 'git' ? 'E_GIT' : 'E_GH';
    if (publication) uncertain(code, diagnostic);
    fail(code);
  }
  return publication ? { stdout: r.stdout, diagnostic } : r.stdout;
}
export function git(repo, args, options = {}) {
  return run('git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'push.pushOption=', ...args], { cwd: repo, ...options });
}
const text = bytes => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('E_CONTENT_INPUT'); } };
const lines = bytes => text(bytes).trim().split('\n').filter(Boolean);
function guardRepo(repo) {
  if (text(git(repo, ['rev-parse', '--is-shallow-repository'])).trim() !== 'false') fail('E_HISTORY');
  const grafts = text(git(repo, ['rev-parse', '--git-path', 'info/grafts'])).trim();
  if (fs.existsSync(resolve(repo, grafts))) fail('E_HISTORY');
  if (text(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/replace/'])).trim()) fail('E_HISTORY');
}
function object(repo, id, type) {
  oid(id);
  if (text(git(repo, ['cat-file', '-t', id])).trim() !== type) fail('E_OBJECT_TYPE');
  const size = Number(text(git(repo, ['cat-file', '-s', id])).trim());
  if (!Number.isSafeInteger(size) || size > 4 * 1024 * 1024) invalid(`object ${id}`);
  return git(repo, ['cat-file', type, id]);
}
function tree(repo, head) {
  const records = text(git(repo, ['ls-tree', '-r', '-t', '-z', '--full-tree', head])).split('\0').filter(Boolean);
  if (records.length > 50000) fail('E_LIMIT');
  return records.map((row, i) => {
    const m = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!m) fail('E_TREE');
    return { mode: m[1], type: m[2], id: oid(m[3]), path: m[4], ordinal: i + 1 };
  });
}
function inspectEntries(repo, head, entries, introduced, scanned, terms = []) {
  const findings = [];
  for (const entry of entries) {
    const location = `commit ${head} tree-entry ${entry.ordinal}`;
    findings.push(...screenText(entry.path, location, { terms }));
    if (entry.type === 'tree' && entry.mode === '040000') continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) invalid(location, 'input-tree-mode', 'E_TREE');
    if (introduced && !introduced.has(entry.id)) continue;
    if (scanned.has(entry.id)) continue;
    scanned.add(entry.id);
    // Opaque commit/blob labels cannot echo a sensitive filename.
    findings.push(...inspectBytes(object(repo, entry.id, 'blob'), `commit ${head} blob ${entry.id}`, { terms }));
  }
  return findings;
}
function forkPoint(repo, base, head) {
  const result = git(repo, ['merge-base', '--all', oid(base), oid(head)], { optional: true });
  if (result === null) fail('E_HISTORY');
  const forks = lines(result);
  if (forks.length !== 1) fail('E_HISTORY');
  const fork = oid(forks[0]);
  git(repo, ['merge-base', '--is-ancestor', fork, base]);
  return fork;
}
export function screenRange(repo, base, head, terms = []) {
  guardRepo(repo); oid(base); oid(head);
  object(repo, base, 'commit'); object(repo, head, 'commit');
  // The accepted tip may advance independently after the PR was opened. Scan
  // the PR's whole introduced history from its unique fork, not from that tip.
  const fork = forkPoint(repo, base, head);
  const commits = lines(git(repo, ['rev-list', '--reverse', head, `^${fork}`, '--']));
  if (commits.length > 4096) fail('E_LIMIT');
  const introduced = new Set(lines(git(repo, ['rev-list', '--objects', '--no-object-names', head, `^${fork}`, '--'])));
  if (introduced.size > 50000) fail('E_LIMIT');
  const baseline = new Set(tree(repo, fork).map(e => `${e.mode}\0${e.id}\0${e.path}`));
  const findings = [], scanned = new Set();
  for (const id of commits) {
    const raw = object(repo, id, 'commit');
    // Include headers, not only the message: an identity can disclose too.
    findings.push(...inspectBytes(raw, `commit ${id}`, { commit: true, terms }));
    const changed = tree(repo, id).filter(e => !baseline.has(`${e.mode}\0${e.id}\0${e.path}`));
    // Reused accepted blobs at a new path/mode are checked too. Unchanged
    // repository code outside a KB root need not be a text-only OKF bundle.
    findings.push(...inspectEntries(repo, id, changed, null, scanned, terms));
  }
  return findings;
}
export function screenTree(repo, head, root = '.', terms = []) {
  guardRepo(repo); oid(head); object(repo, head, 'commit');
  if (root !== '.' && (!/^[A-Za-z0-9_./-]+$/.test(root) || root.split('/').some(s => !s || s === '.' || s === '..'))) fail('E_ROOT');
  const entries = tree(repo, head).filter(e => root === '.' || e.path.startsWith(root + '/'));
  if (!entries.length) fail('E_EMPTY');
  return inspectEntries(repo, head, entries, null, new Set(), terms);
}
function checked(findings) {
  if (findings.length) throw Object.assign(new Error('E_CONTENT_REFUSED'), { code: 'E_CONTENT_REFUSED', findings });
}
function readText(file, label, options) {
  return readBytes(file, label, bytes => checked(inspectBytes(bytes, label, options)));
}
function readBytes(file, label, check) {
  let bytes;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > 4 * 1024 * 1024) fail('E_CONTENT_INPUT');
      bytes = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  } catch { invalid(label, 'input-file'); }
  check(bytes);
  return bytes; // Immutable snapshot sent to gh on stdin, never reread by gh.
}
// oats.okf 6.0: the host's own deny list (setting screen-terms-file), one term
// per line, matched case-insensitively. It only adds refusals; a term is never
// echoed. An unreadable or malformed file refuses as input, never as no terms.
function loadTerms(file) {
  if (file === undefined) return [];
  if (!file.startsWith('/')) invalid('host terms file', 'input-file');
  const bytes = readBytes(file, 'host terms file', () => {});
  let terms;
  try {
    terms = text(bytes).split(/\r\n|\r|\n/).map(line => line.trim()).filter(Boolean);
    screenText('', 'host terms file', { terms });
  } catch { invalid('host terms file'); }
  return terms;
}
const PREFIXES = ['okf-proposal', 'okf-harvest'];
const LABELS = {
  'okf-proposal': { version: 3, description: 'OKF knowledge proposal PR (oats.okf)' },
  'okf-harvest': { version: 2, description: 'OKF harvest PR (oats.okf)' },
};
function ref(branch, publishing = true, terms = []) {
  if (typeof branch !== 'string' || !/^(?:okf-proposal|okf-harvest|okf)\//.test(branch)) fail('E_BRANCH');
  // An existing unsafe name is a cleanup target, not permission to publish it.
  if (publishing) checked(screenText(branch, 'publication ref', { terms }));
  run('git', ['check-ref-format', `refs/heads/${branch}`]);
  return `refs/heads/${branch}`;
}
function baseRef(branch) {
  if (typeof branch !== 'string' || branch.startsWith('-')) fail('E_BRANCH');
  run('git', ['check-ref-format', `refs/heads/${branch}`]);
  return `refs/heads/${branch}`;
}
function remoteGuard(o) {
  if (!o.remote || /[\r\n\0]/.test(o.remote)) fail('E_REMOTE');
  const configured = text(git(o.repo, ['config', '--get-all', 'remote.origin.url'])).trimEnd();
  if (configured !== o.remote) fail('E_REMOTE');
  if (git(o.repo, ['config', '--get-all', 'remote.origin.pushurl'], { optional: true }) !== null) fail('E_REMOTE');
  const rewrites = git(o.repo, ['config', '--local', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'], { optional: true });
  if (rewrites !== null) fail('E_REMOTE');
}
function tip(o, reference) {
  const rows = lines(git(o.repo, ['ls-remote', '--refs', 'origin', reference]));
  if (!rows.length) return null;
  if (rows.length !== 1) fail('E_REMOTE');
  const [id, name] = rows[0].split('\t');
  if (name !== reference) fail('E_REMOTE');
  return oid(id);
}
function verifyBase(o, movedCode = 'E_BASE_MOVED') {
  remoteGuard(o);
  if (tip(o, baseRef(o['base-branch'])) !== oid(o.base)) fail(movedCode);
}
export function screenedPush(o, head, expected, branch) {
  oid(head); if (expected !== '') oid(expected);
  const reference = ref(branch, true, o.terms);
  if (reference === baseRef(o['base-branch'])) fail('E_BRANCH');
  verifyBase(o);
  if (tip(o, reference) !== (expected || null)) fail('E_HEAD_MOVED');
  checked(screenRange(o.repo, o.base, head, o.terms));
  // Recheck after screening; the exact lease arbitrates the remote head race.
  verifyBase(o);
  let output;
  try {
    output = git(o.repo, ['push', '--porcelain', '--no-signed', '--no-follow-tags', '--recurse-submodules=no',
      `--force-with-lease=${reference}:${expected}`, 'origin', `${head}:${reference}`], { publication: true });
  } catch (error) { uncertain('E_PUSH_UNCERTAIN', error?.diagnostic); }
  const status = text(output.stdout).split('\n').find(row => row.split('\t')[1] === `${head}:${reference}`)?.split('\t')[0];
  if (expected === '' && status !== '*') fail('E_CREATE_NOT_CONFIRMED');
  const actual = tip(o, reference);
  if (actual !== head) uncertain('E_PUSH_UNCERTAIN', { ...output.diagnostic, phase: actual === null ? 'readback-absent' : 'readback-other' });
  return head;
}
function github(o) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(o.github || '')) fail('E_GITHUB');
  if (o.pr !== undefined && !/^[1-9][0-9]*$/.test(o.pr)) fail('E_PR');
}
function gh(o, args, input) { github(o); return run('gh', args, { input }); }
function view(o, { states = ['OPEN'], publishing = true } = {}) {
  let p;
  try { p = JSON.parse(text(gh(o, ['pr', 'view', o.pr, '--repo', o.github, '--json', 'state,headRefOid,headRefName,baseRefName,isCrossRepository,title,body']))); }
  catch { fail('E_PR_READ'); }
  if (!states.includes(p.state) || p.isCrossRepository !== false || p.baseRefName !== o['base-branch']) fail('E_PR_STATE');
  if (p.headRefOid !== oid(o.head)) fail('E_HEAD_MOVED');
  ref(p.headRefName, publishing);
  return p;
}
function confirmPr(o, state, branch) {
  try {
    const p = view(o, { states: [state], publishing: false });
    if (p.headRefName !== branch) fail('E_PR_STATE');
  } catch { fail('E_PR_UNCERTAIN'); }
}
// One provenance block per body: ```okf-harvest (versions 1 and 2) or, from
// oats.okf 6.0, ```okf-proposal (version 3). The fence and version must agree.
function provenance(body) {
  const blocks = [...body.matchAll(/^```(okf-harvest|okf-proposal)\s*\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) fail('E_PROVENANCE');
  let value;
  try { value = JSON.parse(blocks[0][2]); } catch { fail('E_PROVENANCE'); }
  if (!value || typeof value !== 'object' || (blocks[0][1] === 'okf-proposal') !== (value.version === 3)) fail('E_PROVENANCE');
  return value;
}
function prText(p) {
  checked([...screenText(p.title, 'PR title'), ...screenText(p.body, 'PR body')]);
}
const sameEntry = (a, b) => a === b || !!a && !!b && a.type === b.type && a.mode === b.mode && a.id === b.id;
const fileMap = entries => new Map(entries.filter(e => e.type !== 'tree').map(e => [e.path, e]));
function reconcileTree(o, staged) {
  const fork = forkPoint(o.repo, o.base, o.head);
  if (fork === o.base) return staged;
  const acceptedEntries = tree(o.repo, o.base), accepted = fileMap(acceptedEntries);
  const beforeEntries = tree(o.repo, fork), proposedEntries = tree(o.repo, staged);
  const before = fileMap(beforeEntries), proposed = fileMap(proposedEntries);
  // Git's index cannot faithfully apply an explicit empty-subtree delta once
  // other entries change. Refuse rather than silently omit that staged intent.
  const emptyDirectories = entries => {
    const parents = new Set(entries.filter(e => e.path.includes('/')).map(e => e.path.slice(0, e.path.lastIndexOf('/'))));
    return new Set(entries.filter(e => e.type === 'tree' && !parents.has(e.path)).map(e => e.path));
  };
  const oldEmpty = emptyDirectories(beforeEntries), proposedEmpty = emptyDirectories(proposedEntries);
  if (oldEmpty.size !== proposedEmpty.size || [...oldEmpty].some(path => !proposedEmpty.has(path))) fail('E_REWRITE_CONFLICT');
  const expected = new Map(accepted), updates = [];
  const scratch = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'okf-reconcile-'));
  const indexFile = join(scratch, 'index');
  try {
    // Never touch the maintainer's index or working files. The private index
    // starts from the CURRENT accepted tree, not the old PR checkout.
    git(o.repo, ['read-tree', o.base], { indexFile });
    const acceptedTree = text(git(o.repo, ['rev-parse', `${o.base}^{tree}`])).trim();
    if (text(git(o.repo, ['write-tree'], { indexFile })).trim() !== acceptedTree) fail('E_REWRITE_CONFLICT');
    for (const path of new Set([...before.keys(), ...proposed.keys()])) {
      const old = before.get(path), ours = accepted.get(path), theirs = proposed.get(path);
      if (sameEntry(old, theirs)) continue; // no PR delta: retain accepted state
      let merged;
      if (sameEntry(old, ours)) merged = theirs;
      else if (sameEntry(ours, theirs)) merged = ours;
      else {
        if (!old || !ours || !theirs) fail('E_REWRITE_CONFLICT');
        if ([old, ours, theirs].some(e => e.type !== 'blob' || !['100644', '100755'].includes(e.mode))) fail('E_REWRITE_CONFLICT');
        const mode = theirs.mode === old.mode ? ours.mode : ours.mode === old.mode || ours.mode === theirs.mode ? theirs.mode : null;
        if (!mode) fail('E_REWRITE_CONFLICT');
        let id;
        if (theirs.id === old.id) id = ours.id;
        else if (ours.id === old.id || ours.id === theirs.id) id = theirs.id;
        else {
          // merge-file is longstanding Git plumbing: no worktree checkout,
          // hooks, custom merge drivers, or newer merge-tree/apply flags.
          const files = [ours, old, theirs].map((e, i) => {
            const bytes = object(o.repo, e.id, 'blob');
            if (bytes.includes(0)) fail('E_REWRITE_CONFLICT');
            text(bytes); // strict UTF-8, but do not screen the old rejected data
            const file = join(scratch, `input-${i}`);
            fs.writeFileSync(file, bytes, { mode: 0o600 });
            return file;
          });
          let bytes;
          try { bytes = git(o.repo, ['merge-file', '-p', ...files]); }
          catch { fail('E_REWRITE_CONFLICT'); }
          id = oid(text(git(o.repo, ['hash-object', '-w', '--stdin'], { input: bytes })).trim());
        }
        merged = { ...theirs, mode, id };
      }
      if (merged) expected.set(path, merged); else expected.delete(path);
      if (!sameEntry(ours, merged)) updates.push(`${merged ? `${merged.mode} ${merged.id}` : `0 ${'0'.repeat(o.base.length)}`}\t${path}\0`);
    }
    // update-index can resolve a file/directory collision by dropping an entry.
    // Refuse the conflict first, and verify the resulting map afterwards.
    const root = { children: new Map(), file: false };
    for (const path of expected.keys()) {
      let node = root;
      for (const part of path.split('/')) {
        if (node.file) fail('E_REWRITE_CONFLICT');
        if (!node.children.has(part)) node.children.set(part, { children: new Map(), file: false });
        node = node.children.get(part);
      }
      if (node.children.size) fail('E_REWRITE_CONFLICT');
      node.file = true;
    }
    if (updates.length) git(o.repo, ['update-index', '-z', '--index-info'], { indexFile, input: updates.join('') });
    const result = oid(text(git(o.repo, ['write-tree'], { indexFile })).trim());
    const resultEntries = tree(o.repo, result), actual = fileMap(resultEntries);
    if (actual.size !== expected.size || [...expected].some(([path, e]) => !sameEntry(e, actual.get(path)))) fail('E_REWRITE_CONFLICT');
    const resultDirectories = new Set(resultEntries.filter(e => e.type === 'tree').map(e => e.path));
    const nonemptyDirectories = new Set(acceptedEntries.filter(e => e.path.includes('/')).map(e => e.path.slice(0, e.path.lastIndexOf('/'))));
    for (const e of acceptedEntries) {
      if (e.type === 'tree' && !nonemptyDirectories.has(e.path) && !resultDirectories.has(e.path)) fail('E_REWRITE_CONFLICT');
    }
    return result;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
function commitFromIndex(o, message, parent = o.base, reconcile = false) {
  guardRepo(o.repo);
  if (text(git(o.repo, ['rev-parse', 'HEAD'])).trim() !== o.head) fail('E_HEAD_MOVED');
  const staged = oid(text(git(o.repo, ['write-tree'])).trim());
  const treeId = reconcile ? reconcileTree(o, staged) : staged;
  return commitFromTree(o, treeId, message, parent);
}
function commitFromTree(o, treeId, message, parent = o.base) {
  // Reparent, never append to the contaminated PR head. Disable inherited
  // author/committer selectors and signing; identity is fixed package text.
  if (!text(message).trim()) fail('E_COMMIT_MESSAGE');
  return oid(text(git(o.repo, ['-c', 'user.name=OKF harvest', '-c', 'user.email=okf@localhost',
    '-c', 'author.name=OKF harvest', '-c', 'author.email=okf@localhost',
    '-c', 'committer.name=OKF harvest', '-c', 'committer.email=okf@localhost',
    '-c', 'commit.gpgSign=false', 'commit-tree', treeId, '-p', oid(parent)], { input: message })).trim());
}
// A pre-push accepted-tip move is recovered inside create, a bounded number of
// times. Nothing has left the host before the push, so the proposal's delta is
// replayed onto the new tip and screened again. The bound is a constant, not
// an option. Refusals keep E_BASE_MOVED with fixed diagnostic constants only.
const RECOVERIES = 3;
function unrecovered(attempts, reason) {
  throw Object.assign(new Error('E_BASE_MOVED'), { code: 'E_BASE_MOVED', diagnostic: { phase: 'recover', attempts, reason } });
}
function recoverBase(o, attempts) {
  remoteGuard(o);
  const reference = baseRef(o['base-branch']), old = { base: oid(o.base), head: oid(o.head) };
  let tipId;
  try {
    // The one network read the recovery adds. No tags, submodules or automatic
    // maintenance; the empty refmap stops configured fetch destinations from
    // writing any local ref (only the CAS below moves one). FETCH_HEAD names
    // exactly the tip this fetch made local.
    git(o.repo, ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--quiet', '--no-tags',
      '--no-recurse-submodules', '--refmap=', 'origin', reference]);
    tipId = oid(text(git(o.repo, ['rev-parse', '--verify', '--quiet', 'FETCH_HEAD^{commit}'])).trim());
  } catch { unrecovered(attempts, 'fetch-failed'); }
  guardRepo(o.repo);
  object(o.repo, tipId, 'commit');
  // A rewritten accepted branch is not something to replay onto.
  if (git(o.repo, ['merge-base', '--is-ancestor', old.base, tipId], { optional: true }) === null) unrecovered(attempts, 'not-fast-forward');
  // oats.okf 6.0: a guarded file (the base's okf-base.json: node ownership and
  // paths) that changed on the accepted branch invalidates the scope the
  // proposer checked; the delta is never replayed past it.
  if (o['guard-file']) {
    const blob = at => { const id = git(o.repo, ['rev-parse', '--verify', '--quiet', `${at}:${o['guard-file']}`], { optional: true }); return id === null ? null : text(id).trim(); };
    if (blob(old.base) !== blob(tipId)) unrecovered(attempts, 'guarded-file-changed');
  }
  const staged = oid(text(git(o.repo, ['rev-parse', `${old.head}^{tree}`])).trim());
  let treeId;
  try { treeId = reconcileTree({ ...o, base: tipId, head: old.head }, staged); }
  catch (error) { if (error?.code === 'E_REWRITE_CONFLICT') unrecovered(attempts, 'conflict'); throw error; }
  if (treeId === text(git(o.repo, ['rev-parse', `${tipId}^{tree}`])).trim()) unrecovered(attempts, 'nothing-to-publish');
  // The original message, byte for byte: everything after the header block.
  const raw = object(o.repo, old.head, 'commit'), split = raw.indexOf('\n\n');
  const head = commitFromTree(o, treeId, split < 0 ? Buffer.alloc(0) : raw.subarray(split + 2), tipId);
  try { git(o.repo, ['update-ref', ref(o.branch), head, old.head]); }
  catch { fail('E_HEAD_MOVED'); }
  o.base = tipId; o.head = head;
}
function verdict(bytes, head, allowed) {
  let v;
  try {
    const blocks = [...text(bytes).matchAll(/^```okf-review\s*\n([\s\S]*?)^```\s*$/gm)];
    if (blocks.length !== 1) fail('E_VERDICT');
    v = JSON.parse(blocks[0][1]);
  } catch { fail('E_VERDICT'); }
  if (v.headSha !== head || !allowed.includes(v.verdict)) fail('E_VERDICT');
}
function comment(o, bytes) {
  gh(o, ['pr', 'comment', o.pr, '--repo', o.github, '--body-file', '-'], bytes);
}
export function execute(command, o) {
  o.terms = loadTerms(o['terms-file']);
  if (command === 'screen-text') {
    if (!o['text-file']?.length) fail('E_USAGE');
    for (const [i, file] of o['text-file'].entries()) readText(file, `outward file ${i + 1}`, { terms: o.terms });
    return { files: o['text-file'].length };
  }
  if (command === 'screen-tree') {
    checked(screenTree(o.repo, o.head, o.root, o.terms)); return { head: o.head };
  }
  if (command === 'screen') {
    checked(screenRange(o.repo, o.base, o.head, o.terms));
    for (const [i, file] of (o['text-file'] || []).entries()) readText(file, `outward file ${i + 1}`, { terms: o.terms });
    return { head: o.head };
  }
  if (command === 'commit') {
    if (oid(o.head) !== oid(o.base)) fail('E_HISTORY');
    const reference = ref(o.branch, true, o.terms);
    if (text(git(o.repo, ['symbolic-ref', 'HEAD'])).trim() !== reference) fail('E_BRANCH');
    const message = readText(o['commit-file'], 'commit text', { commit: true, terms: o.terms });
    const head = commitFromIndex(o, message);
    checked(screenRange(o.repo, o.base, head, o.terms));
    git(o.repo, ['update-ref', reference, head, o.head]);
    return { head, status: 'committed' };
  }
  if (command === 'create') {
    github(o);
    // A canonical repository-relative path, as a base root is bound (any
    // legal segment, a space included); never absolute, parent, .git or NUL.
    const g = o['guard-file'];
    if (g !== undefined && (typeof g !== 'string' || !g || g.startsWith('/') || g.includes('\\') || g.includes('\0')
      || g.split('/').some(x => !x || x === '.' || x === '..' || x.toLowerCase() === '.git'))) fail('E_USAGE');
    // okf-proposal/ (6.0, v3 body) or okf-harvest/ (5.x, v2 body), through 6.x.
    const prefix = PREFIXES.find(name => o.branch?.startsWith(`${name}/`));
    if (!prefix) fail('E_BRANCH');
    const label = prefix, kind = LABELS[prefix];
    const body = readText(o['body-file'], 'PR body', { terms: o.terms });
    const p = provenance(text(body)); if (p.version !== kind.version) fail('E_PROVENANCE');
    let head, recovered = 0;
    for (;;) {
      // Every E_BASE_MOVED from screenedPush is decided before its push.
      try { head = screenedPush(o, o.head, '', o.branch); break; }
      catch (error) { if (error?.code !== 'E_BASE_MOVED') throw error; }
      if (recovered === RECOVERIES) unrecovered(recovered, 'retries-exhausted');
      recoverBase(o, ++recovered);
    }
    gh(o, ['label', 'create', label, '--repo', o.github, '--force', '--color', '0E8A16', '--description', kind.description]);
    try {
      verifyBase(o);
      if (tip(o, ref(o.branch)) !== head) fail('E_HEAD_MOVED');
    } catch { fail('E_PR_UNCERTAIN'); }
    const url = text(gh(o, ['pr', 'create', '--repo', o.github, '--base', o['base-branch'], '--head', o.branch,
      '--label', label, '--title', 'OKF knowledge proposal', '--body-file', '-'], body)).trim();
    if (!url.startsWith(`https://github.com/${o.github}/pull/`) || !/\/pull\/[1-9][0-9]*$/.test(url)) fail('E_PR_UNCERTAIN');
    confirmPr({ ...o, pr: url.split('/').at(-1) }, 'OPEN', o.branch);
    return { head, base: o.base, recovered, branch: o.branch, url, status: 'created' };
  }
  remoteGuard(o);
  const closing = command === 'close' || command === 'close-unsafe';
  const p = view(o, { publishing: !closing });
  if (command === 'rewrite' || command === 'amend-legacy') {
    // A rewrite keeps the PR's own provenance version: v2 (a 5.x harvest) or v3 (6.0).
    const existing = provenance(p.body).version;
    const version = command === 'rewrite' ? ([2, 3].includes(existing) ? existing : 2) : 1;
    if (existing !== version) fail('E_LEGACY_REMOVAL');
    const body = readText(o['body-file'], 'PR body');
    if (provenance(text(body)).version !== version) fail('E_PROVENANCE');
    const message = readText(o['commit-file'], 'replacement commit text', { commit: true });
    verifyBase(o);
    guardRepo(o.repo);
    // A legacy amendment cannot reparent the delivered head, and appending
    // accepted changes is not an authorized substitute for v2 replacement.
    if (version === 1 && forkPoint(o.repo, o.base, o.head) !== o.base) fail('E_REWRITE_REQUIRED');
    if (version !== 1 && git(o.repo, ['merge-base', '--is-ancestor', o.head, o.base], { optional: true }) !== null) fail('E_HISTORY');
    const head = commitFromIndex(o, message, version === 1 ? o.head : o.base, version !== 1);
    if (version === 1) {
      // Preserve 4.x completion ancestry, but never offer an append-only
      // removal: even a one-line deletion requires close-and-route instead.
      const after = new Map(tree(o.repo, head).map(e => [e.path, e]));
      for (const before of tree(o.repo, o.head)) {
        const remaining = after.get(before.path);
        if (!remaining || remaining.type !== before.type || remaining.mode !== before.mode) fail('E_LEGACY_REMOVAL');
      }
      const stats = text(git(o.repo, ['diff', '--no-renames', '--numstat', o.head, head, '--']));
      if (stats.split('\n').filter(Boolean).some(row => row.split('\t')[1] !== '0')) fail('E_LEGACY_REMOVAL');
    }
    screenedPush(o, head, o.head, p.headRefName);
    // A previous verdict is invalid for this head. Do not merge here.
    confirmPr({ ...o, head }, 'OPEN', p.headRefName);
    gh(o, ['pr', 'edit', o.pr, '--repo', o.github, '--title', 'OKF knowledge proposal', '--body-file', '-'], body);
    confirmPr({ ...o, head }, 'OPEN', p.headRefName);
    return { head, branch: p.headRefName, status: 'rewritten-review-required' };
  }
  const body = readText(o['verdict-file'], 'maintainer verdict');
  if (command === 'merge') {
    verdict(body, o.head, ['merge', 'amend+merge']); prText(p);
    verifyBase(o, 'E_REWRITE_REQUIRED'); guardRepo(o.repo);
    // Never submit a divergent hosted squash using an approximate local merge
    // as its screen. Attributes, rename handling and algorithms may differ.
    // V2 must publish an exact screened replacement and receive a fresh
    // verdict; a behind legacy PR closes for re-proposal without reparenting.
    if (forkPoint(o.repo, o.base, o.head) !== o.base) fail('E_REWRITE_REQUIRED');
    const screenedTree = oid(text(git(o.repo, ['rev-parse', `${o.head}^{tree}`])).trim());
    checked(screenRange(o.repo, o.base, o.head));
    const confirmScreenedTree = () => {
      verifyBase(o, 'E_REWRITE_REQUIRED');
      if (oid(text(git(o.repo, ['rev-parse', `${o.head}^{tree}`])).trim()) !== screenedTree) fail('E_HEAD_MOVED');
    };
    confirmScreenedTree(); view(o); comment(o, body); view(o); confirmScreenedTree();
    const mergeBody = Buffer.from(`Reviewed OKF head: ${o.head}\n`);
    gh(o, ['pr', 'merge', o.pr, '--repo', o.github, '--squash', '--match-head-commit', o.head,
      '--subject', 'OKF knowledge proposal', '--body-file', '-'], mergeBody);
    return { head: o.head, status: 'merge-submitted' };
  }
  if (command === 'close' || command === 'close-unsafe') {
    verdict(body, o.head, ['close']);
    if (command === 'close-unsafe') {
      const reference = ref(p.headRefName, false);
      if (reference === baseRef(o['base-branch']) || tip(o, reference) !== o.head) fail('E_HEAD_MOVED');
    }
    // Closing refuses the input; never republish the unsafe input in a verdict.
    comment(o, body); view(o, { publishing: false });
    gh(o, ['pr', 'close', o.pr, '--repo', o.github]);
    confirmPr(o, 'CLOSED', p.headRefName);
    if (command === 'close-unsafe') {
      remoteGuard(o); const reference = ref(p.headRefName, false);
      if (reference === baseRef(o['base-branch']) || tip(o, reference) !== o.head) fail('E_HEAD_MOVED');
      let output;
      try { output = git(o.repo, ['push', '--porcelain', '--no-signed', '--no-follow-tags', '--recurse-submodules=no',
        `--force-with-lease=${reference}:${o.head}`, 'origin', `:${reference}`], { publication: true }); }
      catch (error) { uncertain('E_DELETE_UNCERTAIN', error?.diagnostic); }
      if (tip(o, reference) !== null) uncertain('E_DELETE_UNCERTAIN', { ...output.diagnostic, phase: 'readback-other' });
    }
    return { head: o.head, status: command === 'close-unsafe' ? 'closed-branch-deleted-pull-ref-remains' : 'closed' };
  }
  fail('E_USAGE');
}
const FLAGS = {
  'screen-text': ['text-file', 'terms-file'],
  'screen-tree': ['repo', 'head', 'root', 'terms-file'],
  screen: ['repo', 'base', 'head', 'text-file', 'terms-file'],
  commit: ['repo', 'base', 'head', 'branch', 'commit-file', 'terms-file'],
  create: ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'branch', 'body-file', 'terms-file', 'guard-file'],
  rewrite: ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'pr', 'body-file', 'commit-file'],
  'amend-legacy': ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'pr', 'body-file', 'commit-file'],
  merge: ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'pr', 'verdict-file'],
  close: ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'pr', 'verdict-file'],
  'close-unsafe': ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'pr', 'verdict-file'],
};
function parse(args) {
  const [command, ...argv] = args, allowed = FLAGS[command]; if (!allowed) fail('E_USAGE');
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].slice(2), value = argv[i + 1];
    if (!argv[i].startsWith('--') || !allowed.includes(key) || !value || value.startsWith('--')) fail('E_USAGE');
    if (key === 'text-file') (o[key] ??= []).push(value);
    else { if (Object.hasOwn(o, key)) fail('E_USAGE'); o[key] = value; }
  }
  for (const key of allowed) if (!['root', 'text-file', 'terms-file', 'guard-file'].includes(key) && !o[key]) fail('E_USAGE');
  if (o.repo) o.repo = resolve(o.repo); return { command, o };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 2 || process.argv.includes('--help')) {
    for (const [command, flags] of Object.entries(FLAGS)) console.log(`okf-publication.mjs ${command} ${flags.map(f => `--${f} VALUE`).join(' ')}`);
  } else {
    try {
      const { command, o } = parse(process.argv.slice(2));
      console.log(JSON.stringify({ ok: true, ...execute(command, o) }));
    } catch (e) {
      const code = /^E_[A-Z_]+$/.test(e.code || '') ? e.code : 'E_PUBLICATION';
      console.log(JSON.stringify({ ok: false, code, ...(e.findings ? { findings: e.findings } : {}), ...(e.diagnostic ? { diagnostic: e.diagnostic } : {}) }));
      process.exitCode = code === 'E_CONTENT_REFUSED' ? 1 : 2;
    }
  }
}
