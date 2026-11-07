/** gh's native store is the custody. Never read it, inherit credential overrides,
 * request a token, or let a child-process error escape as renderer diagnostics. */
import { withoutControlToken } from "../client/control-environment.mjs";
import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { delimiter, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { hostName, loginName, object, PR_FIELDS, pullRequest, repoPath, branchName } from './renderer/forge-contract.mjs';
import { cliEnvironment } from '../client/cli-environment.mjs';

const nativeKeys = ['HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH',
  'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'DISPLAY', 'WAYLAND_DISPLAY', 'SECURITYSESSIONID', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'];
/** The allow-list, picked from what any program the Desktop starts gets (cli-environment.mjs):
 * of these names only PATH can hold what the Desktop's packaging added. */
export function forgeEnvironment(source = process.env, interactive = false) {
  const env = {}, user = cliEnvironment(source);
  for (const key of nativeKeys) if (typeof user[key] === 'string') env[key] = user[key];
  Object.assign(env, { GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', NO_COLOR: '1', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' });
  if (interactive) env.TERM = 'xterm-256color';
  else env.GH_PROMPT_DISABLED = '1';
  return env;
}
export function forgeProfile(env = forgeEnvironment()) {
  return createHash('sha256').update(JSON.stringify(['HOME', 'USERPROFILE', 'APPDATA', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']
    .map(k => [k, env[k] ?? null]))).digest('hex');
}
export function ghVersion(stdout) {
  const first = typeof stdout === 'string' ? stdout.split('\n')[0] : '';
  const match = /^gh version (2)\.(\d+)\.(\d+)(?: \([^\r\n]*\))?\r?$/.exec(first);
  if (!match || Number(match[2]) < 81 || !Number.isSafeInteger(Number(match[2])) || !Number.isSafeInteger(Number(match[3]))) return null;
  return `${match[1]}.${Number(match[2])}.${Number(match[3])}`;
}
const fail = code => ({ ok: false, code });
/** This private byte runner resolves, including spawn failures. Only projections
 * below are public. Each process has separate stdout/stderr and wall-time caps. */
export function createGhRunner({ launch = spawn, env = forgeEnvironment(), cwd = homedir() } = {}) {
  let active = 0;
  return function run(bin, argv, { timeout = 10_000, limit = 1024 * 1024 } = {}) {
    if (!isAbsolute(bin || '') || bin.includes('\0') || !Array.isArray(argv) || argv.some(a => typeof a !== 'string' || a.includes('\0'))) return Promise.resolve(fail('E_BAD_ARGS'));
    if (active >= 4) return Promise.resolve(fail('E_FORGE_BUSY'));
    if (!(timeout > 0)) return Promise.resolve(fail('E_GH_TIMEOUT'));
    active++;
    return new Promise(resolve => {
      let child, timer, finished = false, stopped = null, outBytes = 0, errBytes = 0;
      let out = [], err = [];
      const finish = (code, spawnError = false) => {
        if (finished) return; finished = true; clearTimeout(timer); active--;
        const result = stopped ? fail(stopped) : spawnError ? fail('E_GH_FAILED') : {
          ok: true, exitCode: Number.isInteger(code) ? code : -1,
          stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
        };
        out = []; err = []; resolve(result);
      };
      const stop = code => {
        if (finished || stopped) return; stopped = code; out = []; err = [];
        try { child.kill('SIGKILL'); } catch { /* owned child already exited */ }
      };
      try {
        child = launch(bin, argv, { shell: false, cwd, env: withoutControlToken(env), stdio: ['ignore', 'pipe', 'pipe'] });
        timer = setTimeout(() => stop('E_GH_TIMEOUT'), Math.min(timeout, 10_000));
        child.stdout.on('data', value => {
          if (finished || stopped) return; const chunk = Buffer.from(value); outBytes += chunk.length;
          if (outBytes > limit) stop('E_FORGE_LIMIT'); else out.push(chunk);
        });
        child.stderr.on('data', value => {
          if (finished || stopped) return; const chunk = Buffer.from(value); errBytes += chunk.length;
          if (errBytes > 16 * 1024) stop('E_FORGE_LIMIT'); else err.push(chunk);
        });
        child.once('error', () => finish(null, true));
        child.once('close', code => finish(code));
      } catch { finish(null, true); }
    });
  };
}
export function nativeGhCandidates(env = forgeEnvironment()) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return [...new Set([...String(env.PATH || '').split(delimiter).filter(isAbsolute).slice(0, 64).map(p => join(p, 'gh')),
    join(home, '.local', 'bin', 'gh'), '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/snap/bin/gh'])];
}
export function executableGh(path) {
  try {
    if (!isAbsolute(path) || path.includes('\0')) return null;
    const bin = realpathSync(path); accessSync(bin, constants.X_OK);
    const stat = statSync(bin); return stat.isFile() ? { bin, stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}` } : null;
  } catch { return null; }
}
export async function discoverGh({ run, env = forgeEnvironment(), candidates = nativeGhCandidates(env), executable = executableGh, now = () => performance.now() } = {}) {
  const deadline = now() + 5000; let found = false, reason = 'E_GH_MISSING'; const seen = new Set();
  for (const path of candidates.slice(0, 68)) {
    const file = executable(path); if (!file || seen.has(file.bin)) continue;
    found = true; seen.add(file.bin);
    const result = await run(file.bin, ['--version'], { timeout: Math.min(2000, deadline - now()), limit: 16 * 1024 });
    const version = result.ok && result.exitCode === 0 ? ghVersion(result.stdout) : null;
    if (version) return { ok: true, ...file, version, profile: forgeProfile(env) };
    reason = result.ok && result.exitCode === 0 ? 'E_GH_VERSION' : result.code || 'E_GH_FAILED';
    if (now() >= deadline) break;
  }
  return fail(found ? reason : 'E_GH_MISSING');
}
// The query itself is immutable, not supplied by a caller. Error text is reduced
// inside gh; even projected output is validated below. JSON status exits zero
// for invalid authentication, so its account states (not exit zero) are decisive.
export const STATUS_PROJECTION = '[.hosts | to_entries[] | {host:.key, accounts:[.value[] | {host,login,active,state,category:(if .state == "error" then (if ((.error // "") | startswith("HTTP 401:") or endswith("(HTTP 401)")) then "auth" else "unavailable" end) else null end)}]}]';
export async function ghStatus(cli, run, timeout = 10_000) {
  const result = await run(cli.bin, ['auth', 'status', '--active', '--json', 'hosts', '--jq', STATUS_PROJECTION], { timeout, limit: 64 * 1024 });
  if (!result.ok) return result;
  if (result.exitCode !== 0) return fail('E_GH_FAILED');
  let rows; try { rows = JSON.parse(result.stdout); } catch { return fail('E_GH_PROTOCOL'); }
  if (!Array.isArray(rows) || rows.length > 32) return fail(rows?.length > 32 ? 'E_FORGE_LIMIT' : 'E_GH_PROTOCOL');
  const hosts = new Map();
  for (const row of rows) {
    if (!object(row) || Object.keys(row).some(k => !['host', 'accounts'].includes(k)) || !hostName(row.host) || hosts.has(row.host)
      || !Array.isArray(row.accounts) || row.accounts.length !== 1) return fail('E_GH_PROTOCOL');
    const account = row.accounts[0];
    if (!object(account) || Object.keys(account).some(k => !['host', 'login', 'active', 'state', 'category'].includes(k))
      || account.host !== row.host || account.active !== true || (account.login !== '' && !loginName(account.login))
      || !['success', 'error', 'timeout'].includes(account.state)
      || ![null, 'auth', 'unavailable'].includes(account.category)
      || (account.state === 'success' && (!loginName(account.login) || account.category !== null))) return fail('E_GH_PROTOCOL');
    hosts.set(row.host, { login: account.login || null, status: account.state === 'success' ? 'candidate'
      : account.state === 'error' && account.category === 'auth' ? 'not-connected' : 'unavailable' });
  }
  return { ok: true, hosts };
}
export async function ghLogin(cli, host, expected, run, timeout = 10_000) {
  if (!hostName(host) || !loginName(expected)) return fail('E_GH_PROTOCOL');
  const result = await run(cli.bin, ['api', 'user', '--hostname', host, '--jq', '.login'], { timeout, limit: 1024 });
  if (!result.ok) return result;
  if (result.exitCode !== 0) return fail('E_GH_FAILED');
  const login = result.stdout.trim();
  return loginName(login) && login === expected ? { ok: true, login } : fail('E_CONNECTION_CHANGED');
}
/* W6: unresolved review threads. `gh pr view` has none, so one GraphQL read (the host's own gh
   auth, typed -F variables, no token anywhere). More than 100 threads, or anything unreadable,
   is null: a count is never partial or guessed. */
export const REVIEW_THREADS_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){totalCount pageInfo{hasNextPage} nodes{isResolved}}}}}';
export async function ghUnresolvedThreads(cli, { host, path, number }, run, timeout = 10_000) {
  if (!hostName(host) || !repoPath(path) || !Number.isSafeInteger(number) || number <= 0) return null;
  const [owner, name] = path.split('/');
  const result = await run(cli.bin, ['api', 'graphql', '--hostname', host, '-f', `query=${REVIEW_THREADS_QUERY}`,
    '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`], { timeout, limit: 256 * 1024 });
  if (!result.ok || result.exitCode !== 0) return null;
  let raw; try { raw = JSON.parse(result.stdout); } catch { return null; }
  const threads = raw?.data?.repository?.pullRequest?.reviewThreads;
  if (!threads || !Array.isArray(threads.nodes) || threads.pageInfo?.hasNextPage !== false || threads.nodes.length > 100
    || threads.totalCount !== threads.nodes.length || threads.nodes.some(n => typeof n?.isResolved !== 'boolean')) return null;
  return threads.nodes.filter(n => !n.isResolved).length;
}
export async function ghPullRequest(cli, { host, path, branch }, run, timeout = 10_000, { threads = false } = {}) {
  if (!hostName(host) || !repoPath(path) || !branchName(branch)) return fail('E_GH_PROTOCOL');
  const result = await run(cli.bin, ['pr', 'view', '--repo', `${host}/${path}`, '--json', PR_FIELDS, '--', branch], { timeout });
  if (!result.ok) return result;
  if (result.exitCode !== 0) {
    // Exact closed diagnostic, with no appended lines or arbitrary text. gh's
    // Go %q spelling is JSON-compatible for ordinary ref names.
    if (result.exitCode === 1 && result.stderr.trim() === `no pull requests found for branch ${JSON.stringify(branch)}` && !result.stdout.trim()) return { ok: true, data: null };
    return fail('E_GH_FAILED');
  }
  let raw; try { raw = JSON.parse(result.stdout); } catch { return fail('E_GH_PROTOCOL'); }
  const unresolvedThreads = threads && Number.isSafeInteger(raw?.number) ? await ghUnresolvedThreads(cli, { host, path, number: raw.number }, run, timeout) : null;
  const data = pullRequest({ ...raw, unresolvedThreads }, { host, path, branch });
  return data ? { ok: true, data } : fail('E_GH_PROTOCOL');
}
