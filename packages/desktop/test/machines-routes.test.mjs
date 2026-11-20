// #517: the window's machine scope (its key, deployment and messaging) and the HTTP routes over
// server/machines.mjs, through the shipped handler and the shared views.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMachines } from '../server/machines.mjs';
import { machinesGated } from '../../client/machine-contract.mjs';
import { loadServer, loadViews, alexState, identity, observed, A, L, V_OATS, V_LAB, OATS } from './helpers/workspace-views-fixture.mjs';

const GATED = { ok: true, bin: '/oats', features: ['workspace-identity', 'servers-per-workspace', 'server-connect', 'capability-route'], remote: ['roster'] };
const withAweb = state => {
  const a = state.snapshot.byWs.get(A);
  a.deployment.workspaceStatus = { ...a.deployment.workspaceStatus, defaults: { slots: { messaging: { name: 'oats.aweb', from: 'package' } }, capabilities: [] } };
  return state;
};

test('machine scope: a matched view\'s key, its primary local deployment and that deployment\'s messaging slot', () => {
  const { state } = alexState();
  const views = loadViews(withAweb(state));
  assert.deepEqual(views.machineScope(V_OATS), { key: OATS, deployment: A, messaging: 'oats.aweb' });
  assert.deepEqual(views.machineScope(A), { key: OATS, deployment: A, messaging: 'oats.aweb' }, 'a deployment id answers its view');
});

test('machine scope: no local deployment, or a key that is not the workspace\'s, offers no machine and says which', () => {
  const { state } = alexState();
  const views = loadViews(state);
  assert.deepEqual(views.machineScope(V_LAB), { key: null, deployment: null, messaging: null, reason: 'no-local' }, 'laptop\'s lab view is remote only');
  const member = alexState();
  member.state.snapshot.byWs.set(L, observed(L, { reachable: true, ...identity('github.com/x/member'), keyFrom: 'member' }, []));
  assert.deepEqual(loadViews(member.state).machineScope(L), { key: null, deployment: L, messaging: null, reason: 'no-key' });
  assert.equal(views.machineScope('ws:nosuch'), null);
});

function adapterOf(rows) {
  const calls = [];
  const ok = result => ({ schemaVersion: 1, ok: true, result });
  return { calls,
    cliServers: async () => { calls.push(['list']); return ok({ servers: rows }); },
    cliServerCheck: async (bin, id) => { calls.push(['check', id]); return ok({ id, remote: { version: '0.39.0' }, workspaceReachable: true }); },
    cliServerRemove: async (bin, id) => { calls.push(['remove', id]); return ok({ removed: id, remoteInstancesStillTracked: [] }); },
    cliServerConnect: async (bin, args) => { calls.push(['connect', args]); return ok({ id: args.id, ready: false, steps: [{ step: 'ssh', status: 'ok' }] }); },
    cliAwebConnect: async (bin, args) => { calls.push(['aweb', args]); return ok({ server: args.id, ready: true, steps: [] }); },
  };
}
async function serve(cli, rows) {
  const { state } = alexState();
  const adapter = adapterOf(rows);
  const requests = [];
  const machines = createMachines({ adapter, cli: () => cli, backfill: false });
  const { request } = await loadServer({ ...withAweb(state), cliState: cli }, { machines, machinesGated, adapter, remoteLoop: { request: () => { requests.push(1); } } });
  return { request, adapter, requests };
}
const ROWS = [{ id: 'devbox-oats', sshHost: 'devbox', workspace: '/home/alex/oats', workspaceKey: OATS }, { id: 'laptop-lab', sshHost: 'laptop', workspace: '/srv/lab', workspaceKey: 'github.com/x/lab' }];

test('GET /api/servers: gated, the window\'s machines only; ungated, today\'s list unchanged', async () => {
  const gated = await serve(GATED, ROWS);
  const answer = await gated.request({ url: `/api/servers?ws=${encodeURIComponent(V_OATS)}` });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.servers.map(s => s.id), ['devbox-oats']);
  assert.equal(answer.body.aweb, true); assert.equal(answer.body.deployment, A);
  assert.equal((await gated.request({ url: '/api/servers?ws=ws:nosuch' })).body.code, 'E_WORKSPACE_UNKNOWN');
  const lab = await gated.request({ url: `/api/servers?ws=${encodeURIComponent(V_LAB)}` });
  assert.deepEqual(lab.body.servers, []); assert.match(lab.body.reason, /no deployment on this computer/);
  const old = await serve({ ...GATED, features: ['workspace-identity'] }, ROWS);
  const all = await old.request({ url: '/api/servers' });
  assert.deepEqual(all.body, { servers: [{ id: 'devbox-oats', label: 'devbox-oats', sshHost: 'devbox', workspace: '/home/alex/oats' }, { id: 'laptop-lab', label: 'laptop-lab', sshHost: 'laptop', workspace: '/srv/lab' }] });
});

test('POST check / remove / connect: addressed to the window, admitted by key; a change re-reads the remote roster', async () => {
  const { request, adapter, requests } = await serve(GATED, ROWS);
  const ws = `?ws=${encodeURIComponent(V_OATS)}`;
  const checked = await request({ url: `/api/server-check${ws}`, method: 'POST', body: { id: 'devbox-oats' } });
  assert.deepEqual(checked.body, { id: 'devbox-oats', check: { reachable: true, version: '0.39.0', error: null } });
  const other = await request({ url: `/api/server-remove${ws}`, method: 'POST', body: { id: 'laptop-lab' } });
  assert.deepEqual([other.status, other.body.code], [400, 'E_SERVER_OTHER_WORKSPACE']);
  const connected = await request({ url: `/api/server-connect${ws}`, method: 'POST', body: { phase: 'connect', id: 'devbox-oats', host: 'devbox', folder: '~/Agents/oats', installOats: true } });
  assert.equal(connected.body.ok, true); assert.equal(connected.body.result.steps[0].step, 'ssh');
  assert.deepEqual(adapter.calls.find(c => c[0] === 'connect')[1], { id: 'devbox-oats', host: 'devbox', folder: '~/Agents/oats', installOats: true, workspaceDir: A });
  assert.equal(requests.length, 1, 'connect answered: the remote roster is read now');
  const removed = await request({ url: `/api/server-remove${ws}`, method: 'POST', body: { id: 'devbox-oats' } });
  assert.equal(removed.body.ok, true); assert.equal(requests.length, 2);
  const noWs = await request({ url: '/api/server-check', method: 'POST', body: { id: 'devbox-oats' } });
  assert.equal(noWs.status, 400);
  const foreign = await request({ url: `/api/server-check${ws}`, method: 'POST', body: { id: 'devbox-oats' }, headers: { host: '127.0.0.1:4820', origin: 'https://evil.example' } });
  assert.equal(foreign.status, 403, 'the existing Origin guard');
});

test('POST connect with the gates off is refused (409) and nothing runs', async () => {
  const { request, adapter } = await serve({ ...GATED, features: ['workspace-identity'] }, ROWS);
  const r = await request({ url: `/api/server-connect?ws=${encodeURIComponent(V_OATS)}`, method: 'POST', body: { phase: 'connect', id: 'a', host: 'a', folder: '~/a' } });
  assert.deepEqual([r.status, r.body.code], [409, 'E_FEATURE']);
  assert.deepEqual(adapter.calls, []);
});
