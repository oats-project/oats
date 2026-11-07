import { controlFetch as fetch } from './helpers/control-auth.mjs';
// The load path against the shipped server and a scripted fake kernel (helpers/load-path-server.mjs):
// the roster never waits on souls, the held catalogs answer without a kernel run, identical
// inspections coalesce, an unchanged focus reprobe cancels and wipes nothing, every answer carries
// observedAt and refreshing, and --max-age travels only when the kernel declares observe-max-age.
// Every ordering here is CONTROLLED by gates on the fake kernel's calls, never timed: no delays,
// no wall-clock margins. Cycles are run on demand by flipping window focus (the server is blurred
// for the whole test, so its own 30 s cadence never interferes); the cadence and the blur back-off
// are proven with fake timers in refresh-loop.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startLoadPathServer, FAKE_OBSERVED_AT } from './helpers/load-path-server.mjs';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const of = (calls, verb) => calls.filter(c => c.verb === verb);
const ended = (calls, verb) => of(calls, verb).filter(c => c.end !== null);
const maxAge = call => { const i = call.argv.indexOf('--max-age'); return i < 0 ? null : call.argv[i + 1]; };
const soulSelector = agents => { const a = agents.find(x => x.name === 'release-manager'); return { soul: a.name, agentsRoot: a.agentsRoot }; };
const ROSTER = ['status', 'workspace-status'];

/** Run one observation cycle now (focus return = one prompt cycle) with the roster reads gated; resolve once it
 * has been published: the roster reads were released and the panel is no longer refreshing. */
async function cycle(s, { before = () => {} } = {}) {
  const statusStarts = of(s.calls(), 'status').length;
  await s.post('/api/window-state', { focused: true });
  await s.started('status', statusStarts + 1); await s.started('workspace-status', statusStarts + 1);
  await before();
  for (const verb of ROSTER) await s.releaseAll(verb);
  await s.until(async () => { const p = await s.panel(); return p.deployment?.status === 'observed' && !p.refreshing ? p : null; });
  await s.post('/api/window-state', { focused: false });
}

test('cold cycle, held catalogs, coalescing and the focus no-op (kernel without observe-max-age)', async () => {
  const s = await startLoadPathServer({ gated: ['status', 'workspace-status', 'souls', 'capabilities', 'inspect'] });
  try {
    await s.post('/api/window-state', { focused: false }); // the server's own cadence (30 s blurred) is out of reach; cycles run on demand
    const probe = await s.post('/api/cli/reprobe', {});
    assert.equal(probe.ok, true, JSON.stringify(probe));
    assert.equal(probe.features.includes('observe-max-age'), false);
    // The cold cycle dispatches the roster reads, souls and capabilities together: all four have started while none has finished.
    for (const verb of [...ROSTER, 'souls', 'capabilities']) await s.started(verb);
    let calls = s.calls();
    for (const verb of [...ROSTER, 'souls', 'capabilities']) assert.deepEqual([of(calls, verb).length, ended(calls, verb).length], [1, 0], `${verb} started with the roster reads and is still running`);
    // The roster is published as soon as ITS reads land: souls and capabilities are still at their gates.
    for (const verb of ROSTER) await s.releaseAll(verb);
    const observed = await s.until(async () => { const p = await s.panel(); return p.deployment?.status === 'observed' ? p : null; });
    assert.equal(observed.instances.length, 1); assert.match(observed.observedAt, ISO); assert.equal(typeof observed.refreshing, 'boolean');
    calls = s.calls();
    assert.deepEqual([ended(calls, 'souls').length, ended(calls, 'capabilities').length], [0, 0], 'the roster never waited on souls or capabilities');
    const agentsWhilePending = await s.agents();
    assert.deepEqual([agentsWhilePending.agents.length, agentsWhilePending.refreshing, agentsWhilePending.observedAt], [0, true, null], 'the catalog is still coming');
    await s.releaseAll('souls');
    const agents = await s.until(async () => { const a = await s.agents(); return a.agents.length ? a : null; });
    assert.deepEqual([agents.agents.length, agents.refreshing], [9, false]); assert.match(agents.observedAt, ISO);
    assert.equal(of(s.calls(), 'status').length, 1, 'the catalog reached the published entry without a second cycle');
    // The capabilities table was read at admission, before anyone asked; a request while it flies joins that read.
    const asked = s.post(`/api/workspace-sync${s.ws}`, { action: 'read' });
    await s.releaseAll('capabilities');
    const caps = await asked;
    assert.deepEqual([caps.status, caps.capabilities.capabilities.length, caps.reason, caps.refreshing], ['ok', 10, null, false]); assert.match(caps.observedAt, ISO);
    assert.equal(of(s.calls(), 'capabilities').length, 1, 'the request joined the admission read: one oats capabilities');
    const again = await s.post(`/api/workspace-sync${s.ws}`, { action: 'read' }); // gated: a kernel run here could not have answered
    assert.equal(again.status, 'ok'); assert.equal(of(s.calls(), 'capabilities').length, 1, 'a repeat read is the held table, not a kernel run');
    const forced = s.post(`/api/workspace-sync${s.ws}`, { action: 'read', refresh: true });
    await s.started('capabilities', 2); await s.releaseAll('capabilities');
    assert.equal((await forced).status, 'ok'); assert.equal(maxAge(of(s.calls(), 'capabilities')[1]), null, 'refresh:true is a live read; no --max-age without the feature');
    // Inspect: two concurrent identical requests → one kernel run; a repeat is served from the cache; refresh bypasses it.
    const selector = soulSelector(agents.agents);
    const pair = Promise.all([s.post(`/api/capabilities${s.ws}`, { action: 'inspect', selector }), s.post(`/api/capabilities${s.ws}`, { action: 'inspect', selector })]);
    await s.started('inspect'); await s.releaseAll('inspect');
    const [a, b] = await pair;
    assert.equal(a.subject.soul, 'release-manager'); assert.deepEqual(a.subject, b.subject);
    assert.match(a.observedAt, ISO); assert.equal(a.refreshing, false);
    assert.equal(of(s.calls(), 'inspect').length, 1, 'concurrent identical inspections coalesce: both answered, one kernel run');
    const hit = await s.post(`/api/capabilities${s.ws}`, { action: 'inspect', selector }); // gated: a miss could not have answered
    assert.equal(hit.subject.soul, 'release-manager'); assert.equal(of(s.calls(), 'inspect').length, 1, 'a repeat inspect is a cache hit');
    const live = s.post(`/api/capabilities${s.ws}`, { action: 'inspect', selector, refresh: true });
    await s.started('inspect', 2); await s.releaseAll('inspect'); await live;
    assert.equal(of(s.calls(), 'inspect').length, 2, 'refresh:true bypasses the cache');
    const home = observed.instances[0].home;
    const homes = Promise.all([s.post(`/api/capabilities${s.ws}`, { action: 'inspect', selector: { home } }), s.post(`/api/capabilities${s.ws}`, { action: 'inspect', selector: { home } })]);
    await s.started('inspect', 3); await s.releaseAll('inspect'); await homes;
    const homeReads = of(s.calls(), 'inspect').filter(x => x.argv.includes('--home'));
    assert.equal(homeReads.length, 1, 'selecting an instance runs inspect --home once, not twice');
    assert.equal(homeReads[0].argv[homeReads[0].argv.indexOf('--home') + 1], home);
    assert.equal(of(s.calls(), 'operation-run').length, 0);
    // A second cycle over an unchanged workspace re-reads neither catalog.
    await cycle(s);
    assert.deepEqual([of(s.calls(), 'status').length, of(s.calls(), 'souls').length, of(s.calls(), 'capabilities').length], [2, 1, 2], 'an unchanged workspace never re-reads souls or capabilities');
    // Focus reprobe with an unchanged probe WHILE an observation is in flight: nothing is cancelled, nothing wiped.
    let during;
    await cycle(s, { before: async () => {
      assert.equal((await s.panel()).refreshing, true, 'an observation is in flight (its roster reads wait at their gates)');
      during = await s.post('/api/cli/reprobe', {});
      assert.equal(during.ok, true); assert.ok(during.probedAt > probe.probedAt, 'the probe ran and its diagnostics were refreshed');
      assert.deepEqual([of(s.calls(), 'status').length, s.pending('status').length], [3, 1], 'the in-flight status read is the same one: the reprobe did not cancel and restart it');
    } });
    const panel = await s.panel();
    assert.equal(panel.deployment.status, 'observed', 'the in-flight observation was published, not revoked');
    assert.deepEqual([of(s.calls(), 'status').length, of(s.calls(), 'souls').length, of(s.calls(), 'capabilities').length], [3, 1, 2], 'exactly one status read for the prompt cycle; the catalogs were not wiped by an unchanged probe');
    assert.equal((await s.agents()).agents.length, 9);
    // The window-state body is strict.
    for (const body of [{}, { focused: 'yes' }, null, [], { focused: true, extra: 1 }]) assert.equal((await s.post('/api/window-state', body)).code, 'E_BAD_ARGS', JSON.stringify(body));
    assert.equal((await fetch(`${s.base}/api/window-state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' })).status, 400);
    assert.deepEqual(await s.post('/api/window-state', { focused: false }), { focused: false });
  } finally { await s.stop(); }
});

test('a souls catalog landing BEFORE the roster reads is adopted into the entry that gets published; a changed probe (version) still invalidates and re-reads every catalog', async () => {
  const s = await startLoadPathServer({ gated: ['status', 'workspace-status', 'souls'] });
  try {
    await s.post('/api/window-state', { focused: false });
    await s.post('/api/cli/reprobe', {});
    for (const verb of [...ROSTER, 'souls']) await s.started(verb);
    await s.releaseAll('souls'); // souls lands while the roster reads are still at their gates: unbound, to be adopted at settle
    for (const verb of ROSTER) await s.releaseAll(verb);
    const first = await s.until(async () => { const p = await s.panel(); return p.deployment?.status === 'observed' ? p : null; });
    const agents = await s.agents();
    assert.deepEqual([agents.agents.length, agents.refreshing, first.deployment.status], [9, false, 'observed'], 'the first published entry already carries the catalog');
    assert.deepEqual([of(s.calls(), 'souls').length, of(s.calls(), 'capabilities').length, of(s.calls(), 'status').length], [1, 1, 1]);
    // A changed probe is a different CLI: everything held was read with the previous one.
    s.reconfigure(cfg => { cfg.version.version = '0.29.3'; });
    const probe = await s.post('/api/cli/reprobe', {});
    assert.equal(probe.version, '0.29.3');
    // The forgotten capabilities table is prefetched with the new admission's roster reads; the souls key carries the
    // CLI version, so the catalog is re-read once the roster reads bind the new key.
    for (const verb of ROSTER) await s.started(verb, 2);
    await s.started('capabilities', 2);
    for (const verb of ROSTER) await s.releaseAll(verb);
    await s.started('souls', 2); await s.releaseAll('souls');
    await s.until(async () => { const a = await s.agents(); return a.agents.length === 9 && !a.refreshing; });
    assert.deepEqual([of(s.calls(), 'souls').length, of(s.calls(), 'capabilities').length], [2, 2]);
  } finally { await s.stop(); }
});

test('with observe-max-age declared: admission and refresh observe live (0), the prompt cycle and cache misses reuse (60); observedAt is the kernel\'s; a mutation drops held inspections and observes live', async () => {
  // The fake tmux, alone on PATH, answers that no server runs, so the seat is observed stopped and the start rule
  // (packages/client/start-gate.mjs) lets its start reach the kernel; without a tmux its state is not known.
  const s = await startLoadPathServer({ probe: v => ({ ...v, features: [...v.features, 'observe-max-age'] }), tmux: true, env: ({ dir }) => ({ PATH: dir }) });
  try {
    await s.post('/api/window-state', { focused: false });
    const probe = await s.post('/api/cli/reprobe', {});
    assert.ok(probe.features.includes('observe-max-age'));
    const panel = await s.until(async () => { const p = await s.panel(); return p.deployment?.status === 'observed' ? p : null; });
    const agents = await s.until(async () => { const a = await s.agents(); return a.agents.length ? a : null; });
    await s.until(() => ended(s.calls(), 'capabilities').length >= 1);
    // Admission: every read of the first cycle is live.
    for (const verb of ['status', 'workspace-status', 'souls', 'capabilities']) assert.equal(maxAge(of(s.calls(), verb)[0]), '0', `${verb} at admission`);
    assert.equal(panel.observedAt, FAKE_OBSERVED_AT, '/api/panel carries the kernel\'s observation time');
    assert.equal(agents.observedAt, FAKE_OBSERVED_AT, '/api/agents too');
    const caps = await s.until(async () => { const c = await s.post(`/api/workspace-sync${s.ws}`, { action: 'read' }); return c.status === 'ok' ? c : null; });
    assert.equal(caps.observedAt, FAKE_OBSERVED_AT);
    // A user refresh is live; an inspect miss reuses; an inspect refresh is live.
    await s.post(`/api/workspace-sync${s.ws}`, { action: 'read', refresh: true });
    assert.equal(maxAge(of(s.calls(), 'capabilities').at(-1)), '0');
    const selector = soulSelector(agents.agents);
    const inspected = await s.post(`/api/capabilities${s.ws}`, { action: 'inspect', selector });
    assert.equal(maxAge(of(s.calls(), 'inspect').at(-1)), '60'); assert.equal(inspected.observedAt, FAKE_OBSERVED_AT);
    await s.post(`/api/capabilities${s.ws}`, { action: 'inspect', selector, refresh: true });
    assert.equal(maxAge(of(s.calls(), 'inspect').at(-1)), '0');
    // The focus prompt cycle (like every background cycle) reuses.
    await s.post('/api/window-state', { focused: true });
    await s.until(() => ended(s.calls(), 'status').length >= 2 && ended(s.calls(), 'workspace-status').length >= 2);
    await s.post('/api/window-state', { focused: false });
    assert.equal(maxAge(of(s.calls(), 'status')[1]), '60'); assert.equal(maxAge(of(s.calls(), 'workspace-status')[1]), '60');
    // A mutation through the backend (session start) drops the deployment's held inspections and observes live.
    const home = panel.instances[0].home;
    await s.post(`/api/capabilities${s.ws}`, { action: 'inspect', selector: { home } });
    await s.post(`/api/capabilities${s.ws}`, { action: 'inspect', selector: { home } });
    const homeReads = () => of(s.calls(), 'inspect').filter(x => x.argv.includes('--home')).length;
    assert.equal(homeReads(), 1, 'the repeat is a hit');
    const statusCount = of(s.calls(), 'status').length;
    assert.equal(panel.instances[0].running, false, 'the seat is observed stopped');
    const started = await fetch(`${s.base}/api/start/${panel.instances[0].instance}${s.ws}&home=${encodeURIComponent(home)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual([started.status, await started.json()], [200, { launched: true }], 'the start reached the kernel and worked: a refusal is no start');
    await s.until(() => ended(s.calls(), 'status').length > statusCount);
    assert.equal(maxAge(of(s.calls(), 'status').at(-1)), '0', 'a mutation\'s follow-up observation is live');
    await s.post(`/api/capabilities${s.ws}`, { action: 'inspect', selector: { home } });
    assert.equal(homeReads(), 2, 'the mutation invalidated the held inspection: the next inspect --home is a kernel run');
  } finally { await s.stop(); }
});
