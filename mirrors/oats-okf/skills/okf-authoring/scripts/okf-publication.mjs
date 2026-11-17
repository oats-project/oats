#!/usr/bin/env node
// Publication gate, not a sandbox: callers still have their native credentials.
// Never forward Git/gh stderr, matched values, or raw remote response text.
import fs from 'node:fs';
import { resolve, join, dirname, isAbsolute } from 'node:path';
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
function env({ gh = false } = {}) {
  return tokenEnv({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k))),
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' }, tokenFile, { gh });
}
// oats.okf 6.2: the deployment's proposer credential, a GitHub token in a file
// (setting github-token-file, or --token-file here). When one is named, every
// remote git call and every gh call of this process tree is given that token:
// ambient credential helpers are cleared, gh's stored login and inherited
// token variables are not consulted, the host's askpass (core.askPass) is
// switched off, so a file that yields no token is an authentication failure
// and never another credential, and SSH, git:// and plain HTTP are refused,
// so no SSH key stands in (a local repository stays readable). Git is NOT isolated from the host's own
// configuration: a netrc, an http.extraHeader or a URL rewrite there answers
// before any helper is asked. tokenEnv resets http.extraHeader, unscoped and
// for https://github.com/, and hostGate refuses every publishing command
// while one of the three exists; a read (a fetch) is not refused. The file is read at each
// use, so a rotated token needs no restart. The token never reaches an
// argument, an error or a log: git asks this script (`git-credential`, for
// https://github.com only), and gh gets it in its own child environment.
// Without one, nothing here changes: the caller's native credentials apply.
let tokenFile;
const SELF = fileURLToPath(import.meta.url);
const credentialError = (reason) => Object.assign(new Error('E_CREDENTIAL'), { code: 'E_CREDENTIAL', diagnostic: { phase: 'credential', reason } });
/** The token in `file`: one printable-ASCII word, at most 4 KiB with its
 *  line end. A mounted secret is a symlink, so links are followed. */
export function readToken(file) {
  if (typeof file !== 'string' || !file.startsWith('/') || /[\0\r\n']/.test(file)) throw credentialError('path');
  let bytes;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw credentialError('not-a-file');
    if (st.size > 4096) throw credentialError('malformed');
    bytes = fs.readFileSync(file);
  } catch (e) { throw e?.code === 'E_CREDENTIAL' ? e : credentialError(e?.code === 'ENOENT' ? 'missing' : 'unreadable'); }
  const token = bytes.toString('latin1').replace(/\r?\n$/, '');
  if (!token) throw credentialError('empty');
  if (!/^[\x21-\x7e]{1,2048}$/.test(token)) throw credentialError('malformed');
  return token;
}
const INHERITED = /^(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|GIT_ASKPASS|SSH_ASKPASS|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\d+|GIT_CONFIG_VALUE_\d+|OKF_GITHUB_TOKEN_FILE)$/;
/** `base` as a child's environment when `file` names the token: for git, the
 *  configuration that makes this script the only credential source; with
 *  `gh: true`, the token itself, for that one gh child (read here, so a bad
 *  file refuses before gh starts; git reads it through the helper, and a bad
 *  file there is an authentication failure). `file` absent: `base`. */
export function tokenEnv(base, file, { gh = false } = {}) {
  if (file === undefined || file === null) return base;
  if (/'/.test(process.execPath) || /'/.test(SELF)) throw credentialError('helper-path');
  const config = [['core.askPass', ''], ['http.extraHeader', ''], ['http.https://github.com/.extraHeader', ''], ['credential.helper', ''], ['credential.https://github.com.helper', `!'${process.execPath}' '${SELF}' git-credential`],
    ['credential.https://github.com.useHttpPath', 'false'], ['protocol.ssh.allow', 'never'], ['protocol.git.allow', 'never'], ['protocol.http.allow', 'never']];
  const out = Object.fromEntries(Object.entries(base).filter(([k]) => !INHERITED.test(k)));
  out.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], i) => { out[`GIT_CONFIG_KEY_${i}`] = key; out[`GIT_CONFIG_VALUE_${i}`] = value; });
  out.OKF_GITHUB_TOKEN_FILE = file; out.GIT_TERMINAL_PROMPT = '0';
  if (gh) out.GH_TOKEN = readToken(file);
  return out;
}
/** git's credential helper protocol, `get` only, https://github.com only. */
function gitCredential(action) {
  if (action !== 'get') return;
  const asked = Object.fromEntries(fs.readFileSync(0, 'utf8').split('\n').filter(Boolean).map(row => { const i = row.indexOf('='); return [row.slice(0, i), row.slice(i + 1)]; }));
  if (asked.protocol !== 'https' || asked.host !== 'github.com') return;
  let token; try { token = readToken(process.env.OKF_GITHUB_TOKEN_FILE); } catch { return; }
  process.stdout.write(`username=x-access-token\npassword=${token}\n`);
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
  const childEnv = env({ gh: command === 'gh' });
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
  } catch (error) { if (error?.code === 'E_CREDENTIAL') throw error; uncertain('E_PUSH_UNCERTAIN', error?.diagnostic); }
  const status = text(output.stdout).split('\n').find(row => row.split('\t')[1] === `${head}:${reference}`)?.split('\t')[0];
  if (expected === '' && status !== '*') fail('E_CREATE_NOT_CONFIRMED');
  // The push ran: a readback that cannot be made leaves the remote unknown,
  // never a bare Git error that names no publication.
  let actual;
  try { actual = tip(o, reference); }
  catch { uncertain('E_PUSH_UNCERTAIN', { ...output.diagnostic, phase: 'readback-failed' }); }
  if (actual !== head) uncertain('E_PUSH_UNCERTAIN', { ...output.diagnostic, phase: actual === null ? 'readback-absent' : 'readback-other' });
  return head;
}
function github(o) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(o.github || '')) fail('E_GITHUB');
  if (o.pr !== undefined && !/^[1-9][0-9]*$/.test(o.pr)) fail('E_PR');
}
function gh(o, args, input) { github(o); return run('gh', args, { input }); }
// The one gh precondition a publication can decide before its push: gh is on
// this host, can read the repository, and GitHub states that its credential
// may push there (the label and the PR need write). Read-only. An explicit
// `true` passes; an absent or unknown answer establishes nothing, with one
// further route for a GitHub App installation token (below), which GitHub
// never answers `true`. It is gh's credential for github.com that is judged,
// on both routes: every call names that host, so a GH_HOST or a gh signed in
// elsewhere cannot answer one question for another credential. With a token
// file (github-token-file, --token-file) it is that file's token that is
// judged: gh gets it in its own environment, and the installation route's
// request carries it straight from the file, so gh's stored login never
// answers for it.
// The REST field, not GraphQL's viewerPermission, which is null for a GitHub
// App. A bounded check: it cannot tell whether a narrowly scoped token may
// open a PR. The reason is a fixed constant; gh's output is never forwarded.
export function publishPreflight(o) {
  github(o);
  const unavailable = reason => { throw Object.assign(new Error('E_GH_UNAVAILABLE'), { code: 'E_GH_UNAVAILABLE', diagnostic: { phase: 'preflight', reason } }); };
  const ghEnv = env({ gh: true });
  const r = spawnSync('gh', ['api', '--hostname', 'github.com', `repos/${o.github}`, '--jq', '.permissions.push'], { env: ghEnv, timeout: 60000, maxBuffer: MAX });
  if (r.error?.code === 'ENOENT') unavailable('gh-absent');
  if (r.error || r.signal || r.status !== 0) unavailable('gh-failed');
  let push;
  try { push = text(r.stdout).trim(); } catch { unavailable('gh-failed'); }
  if (push === 'true') return;
  // A GitHub App installation token is not a user: for it GitHub reports the
  // repository's `permissions` all false, or leaves them out, whatever the
  // installation was granted, so the answer above says nothing about it.
  // Only an installation token may list the installation's repositories, and
  // for one the write question is put to GitHub itself (below). Every other
  // credential is judged as before, and an unknown answer still refuses.
  const listed = spawnSync('gh', ['api', '--hostname', 'github.com', 'installation/repositories?per_page=1', '--jq', '.total_count'], { env: ghEnv, timeout: 60000, maxBuffer: MAX });
  let installation = false;
  try { installation = !listed.error && !listed.signal && listed.status === 0 && /^\d+$/.test(text(listed.stdout).trim()); } catch { /* not an installation's answer */ }
  if (!installation) unavailable(push === 'false' ? 'no-write-permission' : 'gh-failed');
  const answer = acceptsPush(o);
  if (answer !== 'accepted') unavailable(answer === 'refused' ? 'installation-cannot-push' : 'installation-check-failed');
}
// Whether GitHub accepts a push to the repository from GH'S credential, the
// one the installation answer was about. It asks GitHub for the push
// advertisement, the authenticated request every HTTPS push starts with and
// the one where GitHub authorizes it: 200 with the advertisement where the
// credential may push, 401 or 403 where it may not, 404 where it does not
// show the credential the repository at all. Nothing is sent. Git is
// not involved, so nothing of the host's (Git configuration, a template, a
// URL rewrite, a netrc, an askpass, an SSH key, a proxy variable) can answer
// for the installation: gh prints its token for github.com on a pipe (with a
// token file, the file is read instead and gh is not asked), and a
// Node child with an empty environment reads it on stdin and makes the one
// request, following no redirect. The token is never an argument and nothing
// either child prints is forwarded. A host that reaches github.com only
// through a proxy therefore reads as "could not check".
// → 'accepted' | 'refused' (GitHub said no to the credential) | 'unknown'
// (a timeout, a network error, no token from gh, any other answer: could not
// check). Only 'accepted' passes.
const ADVERTISEMENT = `
let token = ''; for await (const chunk of process.stdin) token += chunk;
let code = 4;
try {
  const r = await fetch(process.argv[1], { redirect: 'manual', signal: AbortSignal.timeout(45000),
    headers: { 'user-agent': 'git/2.0 (oats-okf preflight)', authorization: 'Basic ' + Buffer.from('x-access-token:' + token).toString('base64') } });
  if (r.status === 200 && r.headers.get('content-type') === 'application/x-git-receive-pack-advertisement') code = 0;
  else if (r.status === 401 || r.status === 403 || r.status === 404) code = 3;
} catch { /* could not check */ }
process.exit(code);
`;
export function receivePack(url, token) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', ADVERTISEMENT, url], { input: token, env: {}, timeout: 60000, maxBuffer: MAX });
  if (r.error || r.signal) return 'unknown';
  return r.status === 0 ? 'accepted' : r.status === 3 ? 'refused' : 'unknown';
}
/** What on this host answers GitHub before Git asks the package's credential
 *  helper, so that Git would act with another credential, or elsewhere, and
 *  not with the token file's: a netrc entry for github.com, and in the system
 *  or user Git configuration an authorization header or a rewrite of
 *  https://github.com/ URLs. Included files are followed. A conditional
 *  include (includeIf) depends on the repository Git runs in, so its
 *  condition is taken as true and the file it names is read the same way.
 *  → { routes, unread }: what was found, and what could not be read. Names
 *  kinds and scopes only, never a value (a header or a rewritten URL can
 *  hold a credential). */
export function hostRoutes(childEnv = env()) {
  const env = childEnv;
  const routes = new Set(), unread = new Set(), hub = 'https://github.com/';
  const touches = url => { const u = String(url).toLowerCase(); return hub.startsWith(u) || u.startsWith('https://github.com'); };
  if (env.HOME) {
    // curl matches the host without regard to case, and accepts it quoted.
    try { if (/(?:^|\s)(?:machine\s+"?github\.com"?|default)(?:\s|$)/i.test(fs.readFileSync(join(env.HOME, '.netrc'), 'utf8'))) routes.add('a netrc entry that answers for github.com (.netrc in this user\'s home)'); }
    catch { /* absent, or not readable by this user: then Git's curl cannot read it either, and it is no route */ }
  }
  const KEYS = '^(url\\..*\\.(insteadof|pushinsteadof)|http\\.(.*\\.)?extraheader|includeif\\..*\\.path)$';
  const seen = new Set();
  const scan = (source, scope, depth) => {
    let out;
    const r = spawnSync('git', ['config', ...source, '--includes', '--show-origin', '-z', '--get-regexp', KEYS], { env, encoding: 'utf8', timeout: 60000, maxBuffer: MAX });
    if (!r.error && !r.signal && (r.status === 0 || r.status === 1)) out = r.stdout;
    else { unread.add(depth ? `a file the ${scope} Git configuration conditionally includes` : `the ${scope} Git configuration`); return; }
    const fields = out.split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const origin = fields[i], record = fields[i + 1], cut = record.indexOf('\n'), key = cut < 0 ? record : record.slice(0, cut), value = cut < 0 ? '' : record.slice(cut + 1);
      if (/^includeif\./i.test(key)) {
        // As Git resolves it: ~/ against the home, a relative path against the including file.
        const from = origin.startsWith('file:') ? origin.slice(5) : null;
        const path = value.startsWith('~/') && env.HOME ? join(env.HOME, value.slice(2)) : isAbsolute(value) ? value : from ? resolve(dirname(from), value) : null;
        if (path === null || depth >= 8) { unread.add(`a file the ${scope} Git configuration conditionally includes`); continue; }
        if (seen.has(path) || !fs.existsSync(path)) continue;   // Git ignores an include that is not there
        seen.add(path); scan(['--file', path], scope, depth + 1); continue;
      }
      if (/^url\./i.test(key)) { if (touches(value)) routes.add(`a rewrite of https://github.com/ URLs (url.<base>.insteadOf or pushInsteadOf) in the ${scope} Git configuration`); continue; }
      // Git lets * stand for a host label, so a wildcard host may be github.com.
      const scoped = /^http\.(.*)\.extraheader$/i.exec(key);
      if ((!scoped || touches(scoped[1]) || scoped[1].includes('*')) && /^\s*authorization\s*:/i.test(value)) routes.add(`an authorization header (http.extraHeader) in the ${scope} Git configuration`);
    }
  };
  scan(['--system'], 'system', 0); scan(['--global'], 'user', 0);
  return { routes: [...routes], unread: [...unread] };
}

// The installation route's one request and the host scan, replaceable in tests only.
export const probes = { receivePack, hostRoutes };
// With a token file, nothing that publishes starts while the host can answer
// GitHub in the token's place: Git would push with that credential, or
// elsewhere, after a check that judged the token. Fixed kinds only.
function hostGate() {
  const { routes, unread } = probes.hostRoutes(env());
  if (routes.length || unread.length) throw Object.assign(new Error('E_HOST_CREDENTIAL'), { code: 'E_HOST_CREDENTIAL', diagnostic: { phase: 'host', routes, unread } });
}
const PUBLISHES = new Set(['preflight', 'create', 'rewrite', 'amend-legacy', 'merge', 'close', 'close-unsafe']);

function acceptsPush(o) {
  try {
    let token;
    if (tokenFile !== undefined) token = readToken(tokenFile);
    else {
      const r = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com'], { env: env(), timeout: 60000, maxBuffer: MAX });
      if (r.error || r.signal || r.status !== 0) return 'unknown';
      token = text(r.stdout).trim();
    }
    if (!/^[\x21-\x7e]{1,4096}$/.test(token)) return 'unknown';
    const answer = probes.receivePack(`https://github.com/${o.github}.git/info/refs?service=git-receive-pack`, token);
    return answer === 'accepted' || answer === 'refused' ? answer : 'unknown';
  } catch { return 'unknown'; }
}
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
// oats.okf 6.1: the squash commit names the proposer. A proposal's commit
// ends in a trailer block (Proposed-by, and where the proposer's home recorded
// them Proposer-identity, Attributed-human, Published-by); the accepted
// history would otherwise hold only the merging account. Copied from the
// reviewed head's own message, one row per key, never from the PR body. They
// are the proposer's own statement, not proof.
const CARRIED = ['Proposed-by', 'Proposer-identity', 'Attributed-human', 'Published-by'];
const UNPRINTABLE = /[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069\u200B\u2060\uFEFF\u{E0000}-\u{E007F}]/u;
function proposerTrailers(o) {
  const raw = text(object(o.repo, o.head, 'commit')), split = raw.indexOf('\n\n');
  const block = (split < 0 ? '' : raw.slice(split + 2)).trimEnd().split('\n\n').at(-1).split('\n');
  return CARRIED.flatMap(key => {
    const rows = block.filter(row => row.startsWith(`${key}: `));
    return rows.length === 1 && [...rows[0]].length <= 300 && !UNPRINTABLE.test(rows[0]) ? rows : [];
  });
}
function comment(o, bytes) {
  gh(o, ['pr', 'comment', o.pr, '--repo', o.github, '--body-file', '-'], bytes);
}
export function execute(command, o) {
  tokenFile = o['token-file'];
  if (tokenFile !== undefined) readToken(tokenFile);
  if (tokenFile !== undefined && PUBLISHES.has(command)) hostGate();
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
  if (command === 'preflight') { publishPreflight(o); return { github: o.github, status: 'gh-available' }; }
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
    // Before the push: a host that cannot open the PR publishes nothing.
    publishPreflight(o);
    let head, recovered = 0;
    for (;;) {
      // Every E_BASE_MOVED from screenedPush is decided before its push.
      try { head = screenedPush(o, o.head, '', o.branch); break; }
      catch (error) { if (error?.code !== 'E_BASE_MOVED') throw error; }
      if (recovered === RECOVERIES) unrecovered(recovered, 'retries-exhausted');
      recoverBase(o, ++recovered);
    }
    // The push is confirmed: every failure from here names what it published.
    try {
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
    } catch (error) { throw Object.assign(error, { published: { branch: o.branch, head } }); }
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
    // Built and screened before the verdict comment: a refusal publishes nothing.
    const mergeText = `Reviewed OKF head: ${o.head}\n\n${[`Proposal: https://github.com/${o.github}/pull/${o.pr}`, ...proposerTrailers(o)].join('\n')}\n`;
    checked(screenText(mergeText, 'merge commit text', { commit: true }));
    const mergeBody = Buffer.from(mergeText);
    const confirmScreenedTree = () => {
      verifyBase(o, 'E_REWRITE_REQUIRED');
      if (oid(text(git(o.repo, ['rev-parse', `${o.head}^{tree}`])).trim()) !== screenedTree) fail('E_HEAD_MOVED');
    };
    confirmScreenedTree(); view(o); comment(o, body); view(o); confirmScreenedTree();
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
      catch (error) { if (error?.code === 'E_CREDENTIAL') throw error; uncertain('E_DELETE_UNCERTAIN', error?.diagnostic); }
      let left;
      try { left = tip(o, reference); }
      catch { uncertain('E_DELETE_UNCERTAIN', { ...output.diagnostic, phase: 'readback-failed' }); }
      if (left !== null) uncertain('E_DELETE_UNCERTAIN', { ...output.diagnostic, phase: 'readback-other' });
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
  preflight: ['github', 'token-file'],
  create: ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'branch', 'body-file', 'terms-file', 'guard-file', 'token-file'],
  rewrite: ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'pr', 'body-file', 'commit-file', 'token-file'],
  'amend-legacy': ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'pr', 'body-file', 'commit-file', 'token-file'],
  merge: ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'pr', 'verdict-file', 'token-file'],
  close: ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'pr', 'verdict-file', 'token-file'],
  'close-unsafe': ['repo', 'remote', 'github', 'base', 'base-branch', 'head', 'pr', 'verdict-file', 'token-file'],
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
  for (const key of allowed) if (!['root', 'text-file', 'terms-file', 'guard-file', 'token-file'].includes(key) && !o[key]) fail('E_USAGE');
  if (o.repo) o.repo = resolve(o.repo); return { command, o };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'git-credential') gitCredential(process.argv[3]);
  else if (process.argv.length === 2 || process.argv.includes('--help')) {
    for (const [command, flags] of Object.entries(FLAGS)) console.log(`okf-publication.mjs ${command} ${flags.map(f => `--${f} VALUE`).join(' ')}`);
  } else {
    try {
      const { command, o } = parse(process.argv.slice(2));
      console.log(JSON.stringify({ ok: true, ...execute(command, o) }));
    } catch (e) {
      const code = /^E_[A-Z_]+$/.test(e.code || '') ? e.code : 'E_PUBLICATION';
      console.log(JSON.stringify({ ok: false, code, ...(e.findings ? { findings: e.findings } : {}), ...(e.diagnostic ? { diagnostic: e.diagnostic } : {}), ...(e.published ? { published: e.published } : {}) }));
      process.exitCode = code === 'E_CONTENT_REFUSED' ? 1 : 2;
    }
  }
}
