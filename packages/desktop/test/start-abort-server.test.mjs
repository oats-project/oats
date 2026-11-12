// A client never ends a start. Main's api proxy gives up on a start or restart at its deadline (and gave up
// at 20 s before it had one of its own): this runs the shipped server over a scripted fake kernel
// (helpers/load-path-server.mjs) and aborts the request while the CLI call is in flight. The call is held
// at a gate, so every step is controlled, never timed: it is still running after the client has gone, it
// ends only when the test lets it, by its own exit, and the route goes on after it.
// The fake kernel has no signal handler: a signalled call would die at its gate and never log its end.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startLoadPathServer } from './helpers/load-path-server.mjs';

const of = (calls, verb) => calls.filter(c => c.verb === verb);
const maxAge = call => { const i = call.argv.indexOf('--max-age'); return i < 0 ? null : call.argv[i + 1]; };

test('a start and a restart whose request is aborted while the CLI call is in flight: the call is not signalled, ends by itself, and the route goes on after it', async () => {
  // The fake tmux, alone on PATH, answers that no server runs, so the seat is observed stopped and the start rule
  // (packages/client/start-gate.mjs) lets both acts reach the kernel; without a tmux its state is not known.
  const s = await startLoadPathServer({ gated: ['session'], probe: v => ({ ...v, features: [...v.features, 'observe-max-age'] }), tmux: true, env: ({ dir }) => ({ PATH: dir }) });
  try {
    await s.post('/api/window-state', { focused: false }); // no cycle of the server's own during the test
    assert.ok((await s.post('/api/cli/reprobe', {})).features.includes('session-restart'));
    const panel = await s.until(async () => { const p = await s.panel(); return p.deployment?.status === 'observed' && !p.refreshing ? p : null; });
    const { instance, home, running } = panel.instances[0];
    assert.equal(running, false, 'the seat is observed stopped');
    let sessions = 0;
    for (const kind of ['start', 'restart']) {
      const abort = new AbortController();
      const request = s.request(`/api/${kind}/${instance}${s.ws}&home=${encodeURIComponent(home)}`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: abort.signal });
      // The CLI call is in flight: started, and waiting at its gate.
      const call = (await s.started('session', ++sessions)).at(-1);
      assert.deepEqual(call.argv.slice(0, 4), ['session', kind, '--home', home]);
      assert.equal(call.end, null);
      const statusBefore = of(s.calls(), 'status').length;

      // The client gives up, as main's proxy does at its deadline.
      abort.abort();
      await assert.rejects(request, { name: 'AbortError' });
      // The server goes on serving after the connection has closed, and the call is still in flight.
      for (let n = 0; n < 5; n++) assert.equal((await s.request(`/api/version`)).ok, true);
      assert.deepEqual(s.pending('session').map(c => c.id), [call.id], `${kind}: the call is still running after the abort`);
      assert.equal(of(s.calls(), 'status').length, statusBefore, `${kind}: the route has not gone past the call`);

      // It ends only now, by its own exit: a signalled call would never log its end.
      s.release(call.id);
      await s.until(() => s.calls().find(c => c.id === call.id).end !== null);
      // The route was still awaiting it: what follows the call in the route (a mutation's live observation) runs.
      const after = await s.until(() => { const c = of(s.calls(), 'status'); return c.length > statusBefore ? c.at(-1) : null; });
      assert.equal(maxAge(after), '0', `${kind}: the mutation's follow-up observation, after the client had gone`);
      await s.until(async () => { const p = await s.panel(); return p.deployment?.status === 'observed' && !p.refreshing; });
    }
    assert.equal(of(s.calls(), 'session').length, 2, 'one CLI call for each act, none repeated');
    assert.equal((await s.request(`/api/version`)).ok, true, 'answering a closed connection did not hurt the server');
  } finally { await s.stop(); }
});
