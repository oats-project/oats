// Retry on a remote window reads the servers again (#1117): POST /api/remote-roster/refresh runs the
// remote roster read the background loop runs (`oats server roster --json`) now, or joins the one in
// flight, and answers once its result is what /api/panel serves. The route against the shipped server
// and the scripted fake kernel (helpers/load-path-server.mjs): every ordering is CONTROLLED by a gate
// on the fake's `server` calls, never timed, and the window is blurred for the whole test, so the
// loop's own cadence (30 s) never adds a read. The join against the server's read itself, whose reads
// the test settles one by one: over HTTP nothing shows that a second request has arrived.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startLoadPathServer } from './helpers/load-path-server.mjs';

const reads = s => s.calls().filter(c => c.verb === 'server');
/** A remote group as `oats server roster --json` answers it: reached (with one instance) or not. */
const group = (reached) => ({
  id: 'garnet:3f2a00000000', server: 'garnet', label: 'garnet', registrationPresent: true,
  target: { sshHost: 'garnet-host', workspace: '/srv/acme', oatsPath: 'oats' },
  probe: reached ? { ok: true, features: null } : { ok: false, error: { code: 'E_SSH', message: 'ssh to garnet-host timed out: no answer within 20 s' } },
  agentsRoot: '/srv/acme/agents', workspace: null, souls: [], retireFailures: [],
  instances: reached ? [{ server: 'garnet', instance: 'dev-a', agent: 'dev', home: '/srv/acme/agents/dev/instances/dev-a', agentsRoot: '/srv/acme/agents',
    harness: 'claude', backend: null, running: true, retirePending: false, rollbackIncomplete: false, savedRoute: false, addressable: true, missingRemotely: false }] : [],
});
const roster = (reached) => ({ schemaVersion: 1, ok: true, result: { groups: [group(reached)], bounds: { budgetMs: 45000, perTargetTimeoutMs: 20000, elapsedMs: 1 } } });
const PANEL = `/api/panel?ws=${encodeURIComponent('remote:garnet:3f2a00000000')}`;

/** A server whose first roster read (at start) has answered that garnet could not be reached. */
async function unreached(t) {
  const s = await startLoadPathServer({ gated: ['server'] });
  t.after(() => s.stop());
  await s.post('/api/window-state', { focused: false });
  s.reconfigure(c => { c.roster = roster(false); });
  await s.started('server', 1); await s.releaseAll('server');
  await s.until(async () => ((await s.get(PANEL)).error ? true : null));
  return s;
}

test('Retry reads the servers again: the refresh starts a roster read, answers once it has landed, and the panel then serves its result', async t => {
  const s = await unreached(t);
  assert.equal(reads(s).length, 1);
  s.reconfigure(c => { c.roster = roster(true); });
  let answered = false;
  const refresh = s.post('/api/remote-roster/refresh', {}).then(body => { answered = true; return body; });
  const [, second] = await s.started('server', 2);
  assert.deepEqual(second.argv, ['server', 'roster', '--json'], 'the read the background loop runs');
  assert.equal(answered, false, 'the refresh waits for the read');
  await s.releaseAll('server');
  assert.deepEqual(await refresh, { refreshed: true });
  const panel = await s.get(PANEL);
  assert.equal(panel.error, null, 'the server is reached now');
  assert.deepEqual(panel.instances.map(i => [i.instance, i.running]), [['dev-a', true]]);
  assert.equal(reads(s).length, 2, 'one read per Retry');
});

/** The server's roster read itself (oats-web.mjs, the OATSWEB_REMOTEREAD block), over a fake adapter whose
 * reads the test settles one by one: `reads` holds each read's deferred, `taken` each outcome taken. */
function remoteRead({ rosterAsk = () => null } = {}) {
  const src = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  const block = src.match(/\/\* OATSWEB_REMOTEREAD_BEGIN[^*]*\*\/([\s\S]*?)\/\* OATSWEB_REMOTEREAD_END \*\//)[1];
  const reads = [], taken = [];
  const adapter = { cliRemoteRoster: (...args) => { let settle; const promise = new Promise(resolve => { settle = resolve; }); reads.push(Object.assign(settle, { bin: args[0], args })); return promise; } };
  const make = new Function('adapter', 'cliReadsRemotes', 'takeRosterOutcome', 'rosterAsk',
    `let remoteRead = null, cliState = { ok: true, bin: 'oats' };\n${block}\nreturn { refresh: refreshRemoteSnapshot, accept: (cli) => { cliState = cli; } };`);
  const { refresh, accept } = make(adapter, () => true, outcome => taken.push(outcome), rosterAsk);
  return { refresh, accept, reads, taken };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('Retry during an in-flight roster read joins it: no second read, and both answer when that read lands, with its outcome held', async () => {
  const r = remoteRead();
  let loopDone = false, retryDone = false;
  const loop = r.refresh().then(() => { loopDone = true; }); // the background loop's read
  await flush();
  assert.equal(r.reads.length, 1);
  const retry = r.refresh().then(() => { retryDone = true; }); // a Retry while it runs
  await flush();
  assert.equal(r.reads.length, 1, 'the Retry joined the read in flight');
  assert.deepEqual([loopDone, retryDone], [false, false], 'both wait for it');
  r.reads[0](roster(true));
  await Promise.all([loop, retry]);
  assert.deepEqual(r.taken, [{ envelope: roster(true) }], 'its outcome is held before either answers');
  // Once it has landed, the next Retry reads again.
  const next = r.refresh();
  await flush();
  assert.equal(r.reads.length, 2);
  r.reads[1](roster(false)); await next;
  assert.deepEqual(r.taken.at(-1), { envelope: roster(false) });
});

test('a Retry joined to a read under a kernel record that is no longer accepted answers only once the read under the accepted one has landed', async () => {
  const r = remoteRead();
  const loop = r.refresh(); // read under the record accepted when it started
  await flush();
  r.accept({ ok: true, bin: 'oats-new' }); // another CLI is accepted while it runs
  let retryDone = false;
  const retry = r.refresh().then(() => { retryDone = true; });
  r.reads[0](roster(false)); // the old read lands: its answer is dropped
  await flush();
  assert.deepEqual(r.reads.map(read => read.bin), ['oats', 'oats-new'], 'the read runs again, under the accepted CLI');
  assert.deepEqual(r.taken, [], 'nothing was held from the dropped read');
  assert.equal(retryDone, false, 'the Retry waits for the read under the accepted CLI');
  r.reads[1](roster(true));
  await Promise.all([loop, retry]);
  assert.deepEqual(r.taken, [{ envelope: roster(true) }]);
  assert.equal(r.reads.length, 2, 'one read at a time: no third');
});

test('the read asks for what rosterAsk names at the time it starts (#1124): the keys reach the adapter, the outcome carries what was asked', async () => {
  let asking = { keys: ['github.com/awebai/oats'], keyOf: () => null };
  const r = remoteRead({ rosterAsk: () => asking });
  const first = r.refresh();
  await flush();
  assert.deepEqual(r.reads[0].args, ['oats', { workspaceKeys: ['github.com/awebai/oats'] }]);
  r.reads[0](roster(true)); await first;
  assert.deepEqual(r.taken, [{ envelope: roster(true), asked: asking }]);
  // Nothing to ask: the read is the unfiltered one, called as before.
  asking = null;
  const second = r.refresh();
  await flush();
  assert.deepEqual(r.reads[1].args, ['oats']);
  r.reads[1](roster(false)); await second;
  assert.deepEqual(r.taken.at(-1), { envelope: roster(false) });
});
