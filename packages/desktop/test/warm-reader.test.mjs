import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createWarmReader } from '../../client/warm-reader.mjs';
import { cliDeploymentRead, DEPLOYMENT_READ_TIMEOUT, DEPLOYMENT_READ_MAX_BUFFER } from '../../client/deployment-read-cli.mjs';
import { withoutInstanceVariables, INSTANCE_VARIABLES } from '../../client/kernel-environment.mjs';
import { createDeploymentObserver } from '../../client/deployment-observer.mjs';

/* The warm reader's client rules (#1630): a stand-in `spawn` plays `oats reader --stdio` on the wire, a stand-in
   `exec` plays the CLI read it falls back to. What the CLI answers is marked (`/d/cli`), so a result says who answered. */
const D = '/d';
const FEATURES = ['workspace-v2', 'instance-modules', 'served-identity', 'packages-no-approval', 'observe-max-age', 'warm-reader'];
const cli = (over = {}) => ({ ok: true, bin: '/abs/oats', version: 'X', workspaceApi: 2, readerApi: 1, features: [...FEATURES], ...over });
const STATUS = { root: '/d/agents', agents: [] };
const HEADER = { schemaVersion: 1, ok: true, result: { workspaceStatusApi: 1 } };
const CLI_STATUS = { root: '/d/cli', agents: [] };
const CLI_HEADER = { schemaVersion: 1, ok: true, result: { workspaceStatusApi: 1, from: 'cli' } };
const FROM_CLI = { status: { ok: true, document: CLI_STATUS }, 'workspace-status': { ok: true, document: CLI_HEADER } };
const bg = (action = 'status') => ({ action, context: D, maxAge: 60 });
const argv = action => [...(action === 'status' ? ['status'] : ['workspace', 'status']), '--dir', D, '--max-age', '60', '--json'];
const LINE_LIMIT = DEPLOYMENT_READ_MAX_BUFFER + 64 * 1024;
const flush = async () => { for (let n = 0; n < 10; n++) await new Promise(done => setImmediate(done)); };
const track = promise => { const s = { done: false }; s.promise = promise.then(value => { s.done = true; s.value = value; return value; }); return s; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function fakeChild(bin, args, options) {
  const child = new EventEmitter();
  Object.assign(child, { bin, args, options, requests: [], finished: false, killed: false, exited: false });
  let pending = '';
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    pending += chunk;
    for (let at; (at = pending.indexOf('\n')) >= 0; pending = pending.slice(at + 1)) child.requests.push(JSON.parse(pending.slice(0, at)));
    callback();
  } });
  child.stdin.on('error', () => {});
  // stdin EOF makes the reader exit at once, answering nothing.
  child.stdin.on('finish', () => { child.finished = true; setImmediate(() => child.exit(0)); });
  child.stdout = new PassThrough();
  child.kill = () => { child.killed = true; setImmediate(() => child.exit(null, 'SIGTERM')); return true; };
  child.ended = () => child.finished || child.killed || child.stdin.destroyed;
  child.send = value => child.stdout.write(JSON.stringify(value) + '\n');
  child.hello = (over = {}) => child.send({ readerApi: 1, version: 'X', reads: ['status', 'workspace status'], ...over });
  child.answer = (request, answer, exit = 0) => child.send({ id: request.id, exit, answer });
  child.exit = (code = 0, signal = null) => {
    if (child.exited) return; child.exited = true;
    child.stdout.end(); child.emit('exit', code, signal); child.emit('close', code, signal);
  };
  return child;
}

function harness({ onStale, env } = {}) {
  const children = [];
  const spawn = (bin, args, options) => { const child = fakeChild(bin, args, options); children.push(child); return child; };
  const reader = createWarmReader(onStale ? { spawn, onStale } : { spawn });
  const calls = [];
  const io = { exec(bin, args, _options, callback) { calls.push(args); callback(null, JSON.stringify(args[0] === 'status' ? CLI_STATUS : CLI_HEADER)); } };
  if (env) io.env = env;
  const read = (action = 'status', record = cli(), options = bg(action)) => reader.read(record, options, io);
  return { reader, children, calls, io, read, last: () => children.at(-1), state: () => reader.status().state };
}
/** A trusted reader: the read that starts it (the CLI's), then its hello. */
async function ready(h, record = cli(), hello = {}) {
  await h.read('status', record); h.last().hello({ version: record.version, ...hello }); await flush();
  return h.last();
}
/** A background read written to the reader: { read, request }. */
async function ask(h, action = 'status', record = cli()) {
  const before = h.last().requests.length;
  const read = track(h.read(action, record)); await flush();
  assert.equal(h.last().requests.length, before + 1, 'the read was written to the reader');
  return { read, request: h.last().requests.at(-1) };
}
/** A counted failure: the reader exits with a read in flight. */
async function failInFlight(h) {
  const { read } = await ask(h); h.last().exit(1); await flush();
  assert.deepEqual(await read.promise, FROM_CLI.status, 'the in-flight read is the CLI\'s');
}

// Rule 1, start: only when the probe lists `warm-reader` AND readerApi === 1; otherwise every read is the CLI's.
for (const [name, record] of [['no warm-reader feature', cli({ features: FEATURES.filter(f => f !== 'warm-reader') })], ['readerApi absent', cli({ readerApi: undefined })], ['readerApi 2', cli({ readerApi: 2 })]]) test(`start: ${name} never spawns; every read is the CLI's`, async () => {
  const h = harness();
  for (const action of ['status', 'workspace-status', 'status']) assert.deepEqual(await h.read(action, record), FROM_CLI[action]);
  await flush();
  assert.equal(h.children.length, 0); assert.equal(h.calls.length, 3);
});

// Rule 1: spawned as spawn(cli.bin, ['reader','--stdio'], { env: withoutInstanceVariables(io.env ?? process.env), stdio, shell: false }).
test('start: binary, argv, environment without instance variables, stdio and no shell', async () => {
  const env = { KEEP: '1', OATS_DESKTOP_TOKEN: 'fixture-control-token-not-for-reader', ...Object.fromEntries(INSTANCE_VARIABLES.map(name => [name, '/foreign'])) };
  const h = harness({ env });
  await h.read();
  assert.equal(h.children.length, 1);
  const { bin, args, options } = h.last();
  assert.equal(bin, '/abs/oats'); assert.deepEqual(args, ['reader', '--stdio']);
  assert.deepEqual(options, { env: { KEEP: '1' }, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
  assert.equal(env.OATS_INSTANCE_HOME, '/foreign', 'the caller environment is not changed');
  const plain = harness(); await plain.read();
  assert.deepEqual(plain.last().options.env, withoutInstanceVariables(process.env), 'no io.env: the process environment, cleaned');
});

// Rule 1: the reader starts from the CLI read's own launch. A relative or empty PATH entry makes the CLI's
// interpreter depend on each read's deployment (its cwd); one reader cannot follow that, so the CLI answers.
for (const PATH of ['relbin:/usr/bin', '/usr/bin::/bin', ':/usr/bin', '/usr/bin:', '']) test(`start: PATH ${JSON.stringify(PATH)} never spawns; reads of two deployments are the CLI's`, async () => {
  const h = harness({ env: { PATH } });
  for (const context of ['/d', '/e']) for (const action of ['status', 'workspace-status']) assert.deepEqual(await h.read(action, cli(), { action, context, maxAge: 60 }), FROM_CLI[action]);
  await flush();
  assert.equal(h.children.length, 0); assert.equal(h.calls.length, 4);
  assert.deepEqual(h.reader.status(), { state: 'off', code: 'E_READER_PATH' });
});
test('start: an absolute PATH, or none (the system\'s default search), starts the reader', async () => {
  for (const env of [{ PATH: '/usr/local/bin:/usr/bin' }, {}]) {
    const h = harness({ env }); await h.read();
    assert.equal(h.children.length, 1, JSON.stringify(env));
  }
});

// Rule 1: reads before the hello go to the CLI (the read that starts it included); after it, background reads go to the reader.
test('start: the starting read and reads before the hello are the CLI\'s; after the hello the reader answers', async () => {
  const h = harness();
  assert.deepEqual(await h.read(), FROM_CLI.status, 'the read that starts it is answered by the CLI');
  assert.equal(h.children.length, 1); assert.equal(h.state(), 'starting');
  assert.deepEqual(await h.read('workspace-status'), FROM_CLI['workspace-status']);
  assert.equal(h.children.length, 1); assert.equal(h.last().requests.length, 0, 'nothing written before the hello');
  h.last().hello(); await flush();
  assert.equal(h.state(), 'ready');
  const { read, request } = await ask(h);
  assert.deepEqual(request.argv, argv('status')); assert.ok(Object.hasOwn(request, 'id'));
  h.last().answer(request, STATUS);
  assert.deepEqual(await read.promise, { ok: true, document: STATUS });
  assert.equal(h.calls.length, 2);
});

// Rule 2, trust: a wrong hello ends the reader, state mismatch, the CLI answers, and no reader starts again under that record.
for (const [name, hello] of [['another version', { version: 'Y' }], ['readerApi 2', { readerApi: 2 }], ['reads missing', { reads: undefined }],
  ['reads a string', { reads: 'status' }], ['reads not all strings', { reads: ['status', 2] }], ['reads naming neither read', { reads: ['sync'] }]]) test(`trust: hello with ${name} is a mismatch, without retries`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  const child = await ready(h, cli(), hello); await flush();
  assert.ok(child.finished, 'stdin closed'); assert.equal(h.state(), 'mismatch');
  assert.deepEqual(await h.read(), FROM_CLI.status);
  t.mock.timers.tick(10 * 60_000);
  assert.deepEqual(await h.read('workspace-status'), FROM_CLI['workspace-status']); await flush();
  assert.equal(h.children.length, 1, 'no new reader under the same record'); assert.equal(child.requests.length, 0);
});

// Rule 2: a hello listing only 'status' keeps the reader for status reads; workspace-status reads are the CLI's.
test('trust: a hello listing only status serves status reads and leaves workspace status to the CLI', async () => {
  const h = harness();
  const child = await ready(h, cli(), { reads: ['status'] });
  assert.equal(child.ended(), false);
  const { read, request } = await ask(h);
  child.answer(request, STATUS); assert.deepEqual(await read.promise, { ok: true, document: STATUS });
  assert.deepEqual(await h.read('workspace-status'), FROM_CLI['workspace-status']); await flush();
  assert.equal(child.requests.length, 1); assert.equal(h.children.length, 1);
});

// Rule 3, binding: the reader belongs to its record's gate-relevant content; another record ends it and starts its own.
for (const [name, over] of [['version', { version: 'Y' }], ['bin', { bin: '/abs/oats2' }]]) test(`binding: a read under another ${name} ends the old reader and starts one for the new record`, async () => {
  const h = harness();
  const first = await ready(h);
  // A diagnostic difference is the same record: the same reader answers.
  const same = track(h.read('status', { ...cli(), probedAt: 123, tried: ['/x'], source: 'path' })); await flush();
  assert.equal(first.requests.length, 1); first.answer(first.requests[0], STATUS);
  assert.deepEqual(await same.promise, { ok: true, document: STATUS });
  const next = cli(over);
  assert.deepEqual(await h.read('status', next), FROM_CLI.status); await flush();
  assert.ok(first.finished, 'the old reader is ended');
  assert.equal(h.children.length, 2, 'a reader for the new record starts');
  assert.equal(h.last().bin, next.bin);
  h.last().hello({ version: next.version }); await flush();
  const { read, request } = await ask(h, 'status', next);
  h.last().answer(request, STATUS); assert.deepEqual(await read.promise, { ok: true, document: STATUS });
  assert.equal(first.requests.length, 1, 'nothing more to the old reader');
});

// Rule 3: mismatch resets when the record changes.
test('binding: a mismatch is forgotten under a new record', async () => {
  const h = harness();
  await ready(h, cli(), { version: 'Z' }); await flush();
  assert.equal(h.state(), 'mismatch');
  await h.read('status', cli({ version: 'Y' })); await flush();
  assert.equal(h.children.length, 2);
  h.last().hello({ version: 'Y' }); await flush();
  assert.equal(h.state(), 'ready');
});

// Rule 4, routing: only background reads (maxAge > 0 with observe-max-age) go to the reader.
test('routing: maxAge 0 and no maxAge are the CLI\'s even while a trusted reader runs', async () => {
  const h = harness();
  const child = await ready(h);
  for (const action of ['status', 'workspace-status']) {
    assert.deepEqual(await h.read(action, cli(), { action, context: D, maxAge: 0 }), FROM_CLI[action]);
    assert.deepEqual(await h.read(action, cli(), { action, context: D }), FROM_CLI[action]);
  }
  await flush();
  assert.equal(child.requests.length, 0, 'no request written'); assert.equal(h.calls.length, 5);
});
test('routing: without observe-max-age a maxAge read is not background and nothing is written', async () => {
  const record = cli({ features: FEATURES.filter(f => f !== 'observe-max-age') });
  const h = harness();
  for (let n = 0; n < 3; n++) assert.deepEqual(await h.read('status', record), FROM_CLI.status);
  for (const child of h.children) { child.hello(); }
  await flush();
  assert.deepEqual(await h.read('status', record), FROM_CLI.status); await flush();
  assert.equal(h.children.reduce((sum, child) => sum + child.requests.length, 0), 0);
});
test('routing: the request argv is exactly the CLI\'s for both reads', async () => {
  const h = harness();
  const child = await ready(h);
  for (const [action, document] of [['status', STATUS], ['workspace-status', HEADER]]) {
    const { read, request } = await ask(h, action);
    assert.deepEqual(request.argv, argv(action));
    child.answer(request, document); assert.deepEqual(await read.promise, { ok: true, document });
  }
});

// Rule 5, refusals: UNSUPPORTED and BAD_REQUEST answer that read through the CLI and keep the reader.
for (const code of ['E_READER_UNSUPPORTED', 'E_READER_BAD_REQUEST']) test(`refusal ${code}: the CLI answers that read, the same reader the next`, async () => {
  const h = harness();
  const child = await ready(h);
  const first = await ask(h);
  child.send({ id: first.request.id, refused: { code, message: 'no' } }); await flush();
  assert.deepEqual(await first.read.promise, FROM_CLI.status);
  assert.deepEqual(h.calls.at(-1), argv('status'), 'the CLI ran the same read');
  const second = await ask(h);
  child.answer(second.request, STATUS);
  assert.deepEqual(await second.read.promise, { ok: true, document: STATUS });
  assert.equal(h.children.length, 1); assert.equal(child.ended(), false);
});

// Rule 5: STALE sends every in-flight read to the CLI, calls onStale once, is no failure, and no reader starts until it settles.
test('refusal E_READER_STALE: in-flight reads are the CLI\'s, onStale once, a fresh reader only after it settles, no backoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const settle = deferred(); let staleCalls = 0;
  const h = harness({ onStale: () => { staleCalls++; return settle.promise; } });
  const child = await ready(h);
  const a = await ask(h), b = await ask(h, 'workspace-status');
  child.send({ id: a.request.id, refused: { code: 'E_READER_STALE', message: 'install changed' } });
  await flush(); child.exit(0); await flush();
  assert.deepEqual(await a.read.promise, FROM_CLI.status);
  assert.deepEqual(await b.read.promise, FROM_CLI['workspace-status']);
  assert.equal(staleCalls, 1);
  assert.equal(h.reader.status().code, 'E_READER_STALE');
  assert.deepEqual(await h.read(), FROM_CLI.status); await flush();
  assert.equal(h.children.length, 1, 'no new reader while onStale is pending');
  settle.resolve(); await flush();
  await h.read(); await flush();
  assert.equal(h.children.length, 2, 'the next background read starts a fresh reader, with no time passed');
  assert.equal(staleCalls, 1);
});
test('refusal E_READER_STALE without onStale leaves the record on the CLI', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  const child = await ready(h);
  const a = await ask(h);
  child.send({ id: a.request.id, refused: { code: 'E_READER_STALE', message: 'install changed' } });
  await flush(); child.exit(0); await flush();
  assert.deepEqual(await a.read.promise, FROM_CLI.status);
  t.mock.timers.tick(10 * 60_000);
  assert.deepEqual(await h.read(), FROM_CLI.status); await flush();
  assert.equal(h.children.length, 1);
});

// Rule 6, failures: each kind sends in-flight reads to the CLI and holds the next spawn back 1 s.
const failures = {
  'exit without answering': async h => { await failInFlight(h); },
  'hello timeout': async (h, t) => {
    t.mock.timers.tick(DEPLOYMENT_READ_TIMEOUT - 1); await flush();
    assert.equal(h.last().ended(), false); assert.equal(h.state(), 'starting');
    t.mock.timers.tick(1); await flush();
    assert.ok(h.last().ended(), 'the silent reader is ended');
  },
  'request timeout': async (h, t) => {
    const { read } = await ask(h);
    t.mock.timers.tick(DEPLOYMENT_READ_TIMEOUT); await flush();
    assert.deepEqual(await read.promise, FROM_CLI.status); assert.ok(h.last().ended());
  },
  'E_READER_DEFECT': async h => {
    const { read, request } = await ask(h);
    h.last().send({ id: request.id, refused: { code: 'E_READER_DEFECT', message: 'bug' } });
    await flush(); h.last().exit(1); await flush();
    assert.deepEqual(await read.promise, FROM_CLI.status);
    assert.equal(h.reader.status().code, 'E_READER_DEFECT');
  },
};
for (const [name, fail] of Object.entries(failures)) test(`failure: ${name} is counted and backs off 1 s`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  if (name === 'hello timeout') await h.read(); else await ready(h);
  await fail(h, t);
  assert.equal(h.state(), 'backoff');
  assert.deepEqual(await h.read(), FROM_CLI.status); await flush();
  assert.equal(h.children.length, 1, 'no spawn during the backoff');
  t.mock.timers.tick(1000);
  await h.read(); await flush();
  assert.equal(h.children.length, 2);
});

// Rule 6: backoff 1 s, 2 s, 4 s, 8 s; after 5 consecutive failures, given-up until the record changes.
test('failure: backoff doubles, gives up after 5, and a record change resets it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  await ready(h); await failInFlight(h);
  for (const wait of [1000, 2000, 4000, 8000]) {
    const spawned = h.children.length;
    t.mock.timers.tick(wait - 1); await h.read(); await flush();
    assert.equal(h.children.length, spawned, `no spawn before ${wait} ms`);
    t.mock.timers.tick(1); await h.read(); await flush();
    assert.equal(h.children.length, spawned + 1, `a spawn at ${wait} ms`);
    h.last().hello(); await flush();
    await failInFlight(h);
  }
  assert.equal(h.state(), 'given-up');
  t.mock.timers.tick(60 * 60_000);
  assert.deepEqual(await h.read(), FROM_CLI.status); await flush();
  assert.equal(h.children.length, 5, 'no spawn at all once given up');
  await h.read('status', cli({ version: 'Y' })); await flush();
  assert.equal(h.children.length, 6, 'a new record starts afresh');
});
test('failure: an answer resets the consecutive count', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  await ready(h); await failInFlight(h);
  for (const wait of [1000, 2000, 4000]) { t.mock.timers.tick(wait); await h.read(); h.last().hello(); await flush(); await failInFlight(h); }
  t.mock.timers.tick(8000); await h.read(); h.last().hello(); await flush();
  assert.equal(h.children.length, 5);
  const { read, request } = await ask(h);
  h.last().answer(request, STATUS); assert.deepEqual(await read.promise, { ok: true, document: STATUS });
  await failInFlight(h);
  assert.equal(h.state(), 'backoff', 'one failure after an answer, not a give-up');
  t.mock.timers.tick(1000); await h.read(); await flush();
  assert.equal(h.children.length, 6, 'the backoff starts again at 1 s');
});

// Rule 7, request timeout: counted from when the request becomes the oldest unanswered one.
test('timeout: the deadline runs from becoming the oldest unanswered request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  const child = await ready(h);
  const first = track(h.read()), second = track(h.read('workspace-status')); await flush();
  t.mock.timers.tick(20_000); await flush();
  child.answer(child.requests[0], STATUS); await flush();
  assert.deepEqual(await first.promise, { ok: true, document: STATUS });
  t.mock.timers.tick(10_000); await flush();
  assert.equal(second.done, false, 'not timed out at 30 s'); assert.equal(child.ended(), false);
  t.mock.timers.tick(19_999); await flush();
  assert.equal(second.done, false, 'not timed out at 49.999 s');
  t.mock.timers.tick(1); await flush();
  assert.deepEqual(await second.promise, FROM_CLI['workspace-status'], 'timed out at 50 s, answered by the CLI');
  assert.ok(child.ended()); assert.equal(h.state(), 'backoff');
});

// Rule 8, death mid-request: in-flight reads resolve with the CLI's answer, never as a failure to the caller.
test('death: every in-flight read resolves with the CLI\'s answer', async () => {
  const h = harness();
  const child = await ready(h);
  const a = await ask(h), b = await ask(h, 'workspace-status');
  child.exit(null, 'SIGKILL'); await flush();
  assert.deepEqual(await a.read.promise, FROM_CLI.status);
  assert.deepEqual(await b.read.promise, FROM_CLI['workspace-status']);
  assert.deepEqual(h.calls.slice(-2).sort(), [argv('status'), argv('workspace-status')].sort());
});

// Rule 9, oversize: a line over DEPLOYMENT_READ_MAX_BUFFER + 64 KiB ends the reader (counted); just under is answered.
const paddedLine = (id, bytes) => {
  const head = `{"id":${JSON.stringify(id)},"exit":0,"answer":${JSON.stringify(STATUS)}`;
  return head + ' '.repeat(bytes - head.length - 1) + '}';
};
test('oversize: a line just under the bound is parsed and answered', async () => {
  const h = harness();
  const child = await ready(h);
  const { read, request } = await ask(h);
  const line = paddedLine(request.id, LINE_LIMIT - 1); assert.equal(Buffer.byteLength(line), LINE_LIMIT - 1);
  child.stdout.write(line + '\n'); await flush();
  assert.deepEqual(await read.promise, { ok: true, document: STATUS });
  assert.equal(h.calls.length, 1); assert.equal(child.ended(), false);
});
test('oversize: a line over the bound, before any newline, ends the reader and the CLI answers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const h = harness();
  const child = await ready(h);
  const { read, request } = await ask(h);
  child.stdout.write(paddedLine(request.id, LINE_LIMIT + 1)); await flush();
  assert.deepEqual(await read.promise, FROM_CLI.status);
  assert.ok(child.ended()); assert.equal(h.state(), 'backoff', 'a counted failure');
  await h.read(); await flush(); assert.equal(h.children.length, 1);
});

// Rule 10, same validation as the CLI path: the reader's result is cliDeploymentRead's for the same JSON and exit; stderr never shows.
const ENVELOPE = { schemaVersion: 1, ok: false, error: { code: 'E_X', message: 'm' } };
const REMOTE = { schemaVersion: 1, ok: false, error: { code: 'E_REMOTE_UNREADABLE', message: 'remote unreadable', details: { url: 'https://github.com/awebai/oats.git', reason: 'cache', stage: 'fetch', secret: 'withheld' } } };
const SECRET = 'READER-STDERR-SECRET';
for (const [action, answer, exit, name] of [
  ['status', STATUS, 0, 'good status'], ['workspace-status', HEADER, 0, 'good workspace status'],
  ['status', ENVELOPE, 1, 'kernel error, status'], ['workspace-status', ENVELOPE, 1, 'kernel error, workspace status'],
  ['workspace-status', REMOTE, 1, 'E_REMOTE_UNREADABLE with details'], ['status', STATUS, 1, 'status with a nonzero exit'],
  ['status', 'text', 0, 'a string'], ['status', [STATUS], 0, 'an array'], ['status', null, 0, 'null'], ['status', 7, 0, 'a number'],
  ['status', { root: 'relative', agents: [] }, 0, 'status with a relative root'], ['status', { root: '/d/agents' }, 0, 'status without agents'],
  ['status', HEADER, 0, 'the workspace family for status'], ['workspace-status', STATUS, 0, 'the status family for workspace status'],
]) test(`validation: ${name} (exit ${exit}) is what the CLI route gives`, async () => {
  const expected = await cliDeploymentRead(cli(), bg(action), { exec: (_b, _a, _o, callback) => callback(exit ? { code: exit } : null, JSON.stringify(answer)) });
  const h = harness();
  const child = await ready(h);
  const { read, request } = await ask(h, action);
  child.send({ id: request.id, exit, answer, stderr: SECRET });
  const result = await read.promise;
  assert.deepEqual(result, expected);
  assert.equal(h.calls.length, 1, 'the reader answered, not the CLI');
  assert.equal(JSON.stringify(result).includes(SECRET), false, 'stderr never appears');
});

// Rule 11, stop(): closes the reader's stdin, state stopped, later reads are the CLI's without a spawn.
test('stop: closes stdin, stopped, and every later read is the CLI\'s', async () => {
  const h = harness();
  const child = await ready(h);
  h.reader.stop(); await flush();
  assert.ok(child.finished, 'stdin finished'); assert.equal(h.state(), 'stopped');
  assert.deepEqual(await h.read(), FROM_CLI.status);
  assert.deepEqual(await h.read('status', cli({ version: 'Y' })), FROM_CLI.status); await flush();
  assert.equal(h.children.length, 1); assert.equal(child.requests.length, 0);
});
test('stop before any start: no spawn ever', async () => {
  const h = harness();
  h.reader.stop();
  assert.deepEqual(await h.read(), FROM_CLI.status); await flush();
  assert.equal(h.children.length, 0); assert.equal(h.state(), 'stopped');
});

// Binding through the observer (deployment-observer.mjs), as a client composes them: the record a read runs under is
// the probe's whole gate-relevant identity, so a probe change in a field the reads do not gate on (an API integer)
// still ends the reader and forgets a mismatch, and a change of diagnostics alone keeps it.
test('binding through the observer: a changed probe field ends a trusted reader and resets a mismatch; diagnostics keep it', async () => {
  const h = harness();
  const state = { deployment: D, revision: 1, cli: { ...cli(), probedAt: 1, tried: [] } };
  const observer = createDeploymentObserver({ getContext: id => (id === D ? state : null), read: (record, options) => h.reader.read(record, options, h.io) });
  const observe = async () => { await observer.observe(D, { maxAge: 60 }); await flush(); };
  await observe();
  assert.equal(h.children.length, 1);
  h.last().hello(); await flush();
  assert.equal(h.state(), 'ready');
  // A no-change reprobe: the diagnostics move in place, the revision does not.
  Object.assign(state.cli, { probedAt: 2, tried: [{ path: '/x' }] });
  const kept = track(observer.observe(D, { maxAge: 60 })); await flush();
  for (const request of h.last().requests) h.last().answer(request, request.argv[0] === 'status' ? STATUS : HEADER);
  await kept.promise;
  assert.equal(h.children.length, 1, 'diagnostics are no probe change'); assert.equal(h.last().ended(), false);
  // A real probe change: a new API integer, and the revision moves as reprobeCli moves it.
  const trusted = h.last();
  state.cli = { ...state.cli, operationsApi: 2 }; state.revision++;
  await observe();
  assert.ok(trusted.ended(), 'the reader of the old record is ended');
  assert.equal(h.children.length, 2, 'a reader starts for the new record');
  // A mismatch under that record, then another probe change: forgotten, a fresh reader starts.
  h.last().hello({ version: 'Y' }); await flush();
  assert.equal(h.state(), 'mismatch');
  await observe();
  assert.equal(h.children.length, 2, 'no retry under the same record');
  state.cli = { ...state.cli, remote: ['roster'] }; state.revision++;
  await observe();
  assert.equal(h.children.length, 3, 'a new record forgets the mismatch');
});
