// A real `server/oats-web.mjs` process driven by a scripted fake `oats` CLI, for
// tests of the load path (parallel cycle, held catalogs, inspect cache, focus
// reprobe, --max-age). The fake answers every verb from the desktop-facts kernel
// capture retargeted to a temp deployment and logs every call TWICE: at start
// (id, verb, argv) and at end. A verb listed in the config's `gated` set blocks
// after its start line until the test releases that call (`release(id)`) or
// un-gates the verb (`open(verb)`), so every ordering a test asserts — "souls
// started with the roster reads", "the roster was published before souls
// landed", "two identical inspections were one kernel run" — is CONTROLLED,
// never timed: there are no delays, wall-clock waits or margins here. Cycles
// are driven the same way: the test blurs the window once (30 s cadence, out
// of reach: a run takes seconds, and `until` gives up before the server's own
// timer could add a cycle — a pathological run times out rather than
// miscounting) and flips focus to run one prompt cycle when it wants one; the
// cadence itself is proven with fake timers in test/refresh-loop.test.mjs.
// The config is re-read on every invocation and every poll, so the probe, the
// feature list and the gated set can change mid-run.
// Nothing here touches tmux state: PATH holds no tmux, so the liveness child
// cannot read the seat's target. With `tmux: true` a fake tmux stands on PATH
// instead: it records the environment it was started with and answers as a
// server that is not running. With `recordEnvironment: true` the fake oats
// logs the environment of each call too.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBackend } from './backend-server.mjs';

const FIXTURES = fileURLToPath(new URL('../fixtures/workspace-v2/desktop-facts/', import.meta.url));
export const FIXTURE_DEPLOYMENT = '/fixture/base/northwind-workspace';
/** The observation stamp the fake reports whenever it is asked with --max-age (a kernel that
 * declares observe-max-age always reports one; without the flag it reports none). */
export const FAKE_OBSERVED_AT = '2026-01-01T00:00:00.000Z';

const FAKE = `#!${process.execPath}
import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const [scriptDir, log] = [process.env.FAKE_SCRIPT_DIR, process.env.FAKE_LOG];
const config = () => JSON.parse(readFileSync(scriptDir + '/config.json', 'utf8')); // written atomically (rename) by the helper
const a = process.argv.slice(2);
const verb = a[0] === 'workspace' && a[1] === 'status' ? 'workspace-status' : a[0] === 'operation' ? 'operation-run'
  : a[0] === 'capabilities' && a[1] === 'show' ? 'capability-show' : a[0];
const id = randomUUID(), start = Date.now();
const cfg = config();
const dir = a.includes('--dir') ? a[a.indexOf('--dir') + 1] : cfg.deployment;
const fixture = name => JSON.parse(readFileSync(scriptDir + '/' + name + '.json', 'utf8').replaceAll(${JSON.stringify(FIXTURE_DEPLOYMENT)}, dir));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const observation = () => a.includes('--max-age') ? { observation: { observedAt: ${JSON.stringify(FAKE_OBSERVED_AT)}, reused: a[a.indexOf('--max-age') + 1] !== '0' } } : {};
appendFileSync(log, JSON.stringify({ id, verb, argv: a, start, phase: 'start', ...(cfg.recordEnvironment ? { env: process.env } : {}) }) + '\\n');
// Gated: hold after the start line until released by id, or until the verb is no longer gated.
while ((config().gated || []).includes(verb) && !existsSync(scriptDir + '/go/' + id)) await sleep(5);
let out;
if (verb === 'version') out = config().version;
else if (verb === 'status') out = (cfg.emptyDirs || []).includes(dir)
  // An empty deployment, as the kernel answers it: no souls, no instances, the workspace reachable.
  ? { root: dir + '/agents', agents: [], ...observation(), workspace: { reachable: true } }
  : { ...fixture('status'), ...observation() };
else if (verb === 'workspace-status' || verb === 'souls' || verb === 'capabilities') { const d = fixture(verb); d.result = { ...d.result, ...observation() }; out = d; }
else if (verb === 'inspect') {
  const d = fixture(a.includes('--home') ? 'inspect-home' : 'inspect-soul');
  if (a.includes('--home')) { const home = a[a.indexOf('--home') + 1]; d.result.subject.home = home; d.result.instance.home = home; }
  d.result = { ...d.result, ...observation() }; out = d;
}
else if (verb === 'capability-show') out = cfg.capabilityShow ?? { schemaVersion: 1, ok: false, error: { code: 'E_UNKNOWN_COMMAND', message: 'fake: no capabilityShow answer' } }; // the config's envelope, as given
else if (verb === 'server') out = config().roster ?? { schemaVersion: 1, ok: true, result: { groups: [], servers: [] } }; // the config's roster answer, read when the call answers
// A start or a restart that worked (the route answers it 200 only for an instance its rule finds stopped: tmux: true).
else if (verb === 'session' && (a[1] === 'start' || a[1] === 'restart')) out = { schemaVersion: 1, ok: true, result: { launched: true } };
else if (verb === 'operation-run') out = { schemaVersion: 1, ok: true, result: { operationsApi: 2, operation: a[2], ok: true } };
else out = { schemaVersion: 1, ok: false, error: { code: 'E_UNKNOWN_COMMAND', message: 'fake: ' + a.join(' ') } };
appendFileSync(log, JSON.stringify({ id, phase: 'end', end: Date.now() }) + '\\n');
process.stdout.write(JSON.stringify(out));
process.exit(out?.ok === false ? 1 : 0);
`;

const FAKE_TMUX = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(new URL('./tmux-calls.jsonl', import.meta.url), JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n');
process.stderr.write('no server running on /nonexistent/tmux-socket\\n');
process.exit(1);
`;

/** The rows of a JSON-lines log a fake appends to while a test polls it. Only lines ended by '\n'
 * are parsed: a reader can meet an append under way (one appendFileSync of a large row is not
 * atomic to a reader), and its unterminated tail is "not yet", seen on a later poll. A terminated
 * line that does not parse still throws: that is a bug in the fake, not a race. */
export function loggedRows(file) {
  const text = readFileSync(file, 'utf8');
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
}


/** Boot a server for one temp deployment. `probe` mutates the fixture probe (e.g. adds a feature);
 * `gated` names the verbs whose calls block until the test releases them; `extra` registers that
 * many more deployments (`deployments`, each its own --dir, in order); `empty` lists the indexes
 * (into `deployments`) whose `status` is an empty deployment's answer. `env` is given the directory
 * that holds the fakes (`dir`) and returns names laid over the server's environment;
 * `recordEnvironment` and `tmux` are described at the top. */
export async function startLoadPathServer({ probe = v => v, gated = [], extra = 0, empty = [], env = () => ({}), recordEnvironment = false, tmux = false, tokenFile = null } = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'oats-load-path-')));
  const deployment = join(temp, 'workspace'); mkdirSync(join(deployment, 'agents'), { recursive: true });
  writeFileSync(join(deployment, 'oats-local.yaml'), 'workspace: fixture\n');
  // The fixture seat's home exists on disk so privileged routes that verify it (session start) admit it.
  mkdirSync(join(deployment, 'agents', 'release-manager', 'instances', 'release-manager-facts'), { recursive: true });
  const deployments = [deployment];
  for (let n = 2; n <= extra + 1; n++) {
    const dir = join(temp, `workspace-${n}`); mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'oats-local.yaml'), 'workspace: fixture\n'); deployments.push(dir);
  }
  const script = join(temp, 'script'); mkdirSync(join(script, 'go'), { recursive: true });
  for (const name of ['status', 'workspace-status', 'souls', 'capabilities', 'inspect-soul', 'inspect-home']) writeFileSync(join(script, `${name}.json`), readFileSync(join(FIXTURES, `${name}.json`)));
  const version = probe(JSON.parse(readFileSync(join(FIXTURES, 'version.json'), 'utf8')));
  const config = { version, gated: [...gated], deployment, emptyDirs: empty.map(index => deployments[index]), recordEnvironment };
  // Atomic: fakes read the config at every start and every gate poll; a truncate-then-write would let one read it half-written.
  const writeConfig = () => { writeFileSync(join(script, 'config.json.tmp'), JSON.stringify(config)); renameSync(join(script, 'config.json.tmp'), join(script, 'config.json')); };
  writeConfig();
  const log = join(temp, 'calls.jsonl'); writeFileSync(log, '');
  const fake = join(temp, 'oats'); writeFileSync(fake, FAKE, { mode: 0o700 });
  const tmuxLog = join(temp, 'tmux-calls.jsonl'); writeFileSync(tmuxLog, '');
  if (tmux) writeFileSync(join(temp, 'tmux'), FAKE_TMUX, { mode: 0o700 });
  writeFileSync(join(temp, 'package.json'), '{"type":"module"}'); // the extensionless fake is ESM whatever the temp path
  // The server, started as every test starts it (helpers/backend-server.mjs): a fresh credential, a private
  // socket, and `request` (fetch-shaped, authorized) over it. `tokenFile(deployment)` names a --token-file instead of fd 3.
  const server = await startBackend({ dirs: deployments, detached: true, tokenFile: tokenFile ? tokenFile(deployment) : null,
    env: { ...process.env, OATS_DESKTOP_OATS_BIN: fake, FAKE_SCRIPT_DIR: script, FAKE_LOG: log, PATH: '/nonexistent', SHELL: '/bin/false',
      OATS_INSTANCE_HOME: undefined, OATS_INSTANCE: undefined, OATS_DEPLOYMENT: undefined, ...env({ dir: temp }) } });
  const { request } = server;
  const stderr = server.stderr;
  const ws = `?ws=${encodeURIComponent(deployment)}`;
  const get = async path => (await request(path)).json();
  const post = async (path, body) => (await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  /** Every call so far, in start order: { id, verb, argv, start, end } with `end` null while it runs (or waits at its gate);
   * `env` too under `recordEnvironment`. */
  const calls = () => {
    const byId = new Map();
    for (const row of loggedRows(log)) {
      if (row.phase === 'start') byId.set(row.id, { id: row.id, verb: row.verb, argv: row.argv, start: row.start, end: null, ...(row.env ? { env: row.env } : {}) });
      else if (byId.has(row.id)) byId.get(row.id).end = row.end;
    }
    return [...byId.values()];
  };
  const until = async (test, { timeout = 30_000, every = 25 } = {}) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await test();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting: ${test.toString().slice(0, 120)}`);
      await new Promise(resolve => setTimeout(resolve, every));
    }
  };
  const pending = verb => calls().filter(c => c.verb === verb && c.end === null);
  const release = id => writeFileSync(join(script, 'go', id), '');
  return {
    deployment, deployments, ws, get, post, calls, until, config, pending, release,
    /** fetch-shaped and authorized, over the server's socket: `(path, { method, headers, body, signal })`. */
    request,
    /** One request with exactly the headers given (no credential unless given). */
    raw: server.raw,
    secret: server.secret,
    /** The directory that holds the fakes, as `env` was given it. */
    dir: temp,
    /** Every start of the fake tmux so far: { argv, env }. */
    tmuxCalls: () => loggedRows(tmuxLog),
    /** The HTTP status and body of a GET, for refusals. */
    async getStatus(path) { const response = await request(path); return { status: response.status, body: await response.json() }; },
    /** Change the fake's config for every invocation from now on. */
    reconfigure(change) { change(config); writeConfig(); },
    /** Wait until `count` calls of `verb` have STARTED (they may be waiting at their gate). */
    started: (verb, count = 1) => until(() => { const c = calls().filter(x => x.verb === verb); return c.length >= count ? c : null; }),
    /** Let every call of `verb` waiting at its gate finish; resolves once they have all ended. */
    async releaseAll(verb) { const ids = pending(verb).map(c => c.id); for (const id of ids) release(id); await until(() => ids.every(id => calls().find(c => c.id === id)?.end !== null)); },
    /** Stop gating `verb`: waiting calls finish, later ones run through. */
    open(verb) { config.gated = config.gated.filter(v => v !== verb); writeConfig(); },
    gate(verb) { if (!config.gated.includes(verb)) config.gated.push(verb); writeConfig(); },
    panel: () => get(`/api/panel${ws}`),
    agents: () => get(`/api/agents${ws}`),
    stderr: () => stderr(),
    async stop() {
      await server.stop();
      rmSync(temp, { recursive: true, force: true });
    },
  };
}
