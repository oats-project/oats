import { controlHeaders, TEST_CONTROL_TOKEN } from './control-auth.mjs';
import { checkControlRequest, controlRequestHeaders, loopbackHost } from '../../control-request.mjs';
// Workspace views (#482) over held observations, for the server tests: the shared views
// (packages/client/panel-views.mjs) called as the server calls them, with the server's own `held`
// cut out of server/oats-web.mjs, and Juan's deployments as fixtures.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as remote from '../../../client/remote-roster.mjs';
import { viewId } from '../../../client/workspace-views.mjs';
import * as shared from '../../../client/panel-views.mjs';
import { createRemoteIdentityStore } from '../../server/remote-identity.mjs';
import { DESKTOP_TERMS } from '../../renderer/desktop-terms.mjs';
/** The time a remote panel is made at: remotePanel reads no clock, its caller gives the time. */
const AT = '2026-10-11T12:00:00.000Z';

export const SOURCE = readFileSync(new URL('../../server/oats-web.mjs', import.meta.url), 'utf8');
export const between = (begin, end) => SOURCE.slice(SOURCE.indexOf(begin), SOURCE.indexOf(end));
/** The server's `held`: the one expression that names its own variables as what the shared views read.
 * It is run here over the fixture's values for those variables, so the mapping under test is the server's. */
export const HELD = SOURCE.slice(SOURCE.indexOf('const held = () => ({'), SOURCE.indexOf('\n});', SOURCE.indexOf('const held = () => ({')) + 5);
/** The shared functions a test reads, each with the arguments it had as a function of the server. */
export const VIEW_FUNCTIONS = ['deployments', 'viewModel', 'viewFor', 'deploymentFor', 'surfaceDeployment', 'viewForgeContext', 'isServed',
  'teamMembersFor', 'panelData', 'workspaceChoices', 'deploymentRows', 'machineScope'];
export const CLI = { ok: true, bin: '/oats', features: ['workspace-identity'], remote: ['roster'] };

/** The server's variables that `held` reads (and the handler's other free names), real by default. */
export function viewDeps(state = {}) {
  return { ctxs: [], snapshot: { byWs: new Map() }, remoteGroups: [], remote, cliState: CLI, observing: new Set(), remoteRead: null,
    remoteIdentities: createRemoteIdentityStore({ file: null }), rosterAnswered: true, rosterFailure: null, keptReadAt: new Map(), homedir: () => '/Users/juan', basename,
    DESKTOP_TERMS, ...state };
}
/** The twelve functions bound as the server calls them: `held()` first, the Desktop's terms where a function takes terms. */
function bound(held) {
  const T = DESKTOP_TERMS;
  return {
    deployments: () => shared.deployments(held()),
    viewModel: () => shared.viewModel(held(), T),
    viewFor: (wsId, model) => shared.viewFor(held(), wsId, T, model),
    deploymentFor: wsId => shared.deploymentFor(held(), wsId, T),
    surfaceDeployment: (wsId, request) => shared.surfaceDeployment(held(), wsId, request, T),
    viewForgeContext: wsId => shared.viewForgeContext(held(), wsId, T),
    isServed: id => shared.isServed(held(), id, T),
    teamMembersFor: wsId => shared.teamMembersFor(held(), wsId, T),
    panelData: wsId => shared.panelData(held(), wsId, T),
    workspaceChoices: model => shared.workspaceChoices(held(), T, model),
    deploymentRows: ws => shared.deploymentRows(held(), ws),
    machineScope: wsId => shared.machineScope(held(), wsId, T),
  };
}
export function loadViews(state = {}) {
  const deps = viewDeps(state);
  return bound(new Function(...Object.keys(deps), `${HELD}\nreturn held;`)(...Object.values(deps)));
}

export const OATS = 'github.com/awebai/oats', LAB = 'github.com/x/lab', TSM = 'github.com/GreaterSkies/tsm';
export const identity = (key = OATS, team = 'aweb:oats') => ({ key, ref: `git:${key}`, keyFrom: 'workspace', standalone: false,
  defaultTeam: { label: 'default', team }, teams: { default: team }, teamsFrom: 'observed' });
/** Juan's deployments: two local deployments of oats, a loose local one; altair (oats) and vega (lab) remotes. */
export const A = '/Users/juan/Agents/oats', B = '/Users/juan/awebai/oats-v2', L = '/Users/juan/loose';
export const R = 'remote:altair:a1', V = 'remote:vega:v1';
export const V_OATS = viewId(OATS, 'aweb:oats'), V_LAB = viewId(LAB, 'aweb:lab'), V_TSM = viewId(TSM, 'gs:tsm');
export const row = (deployment, name, extra = {}) => ({ instance: name, agent: 'dev', agentsRoot: `${deployment}/agents`,
  home: `${deployment}/agents/dev/instances/${name}`, running: true, createdAt: '2026-10-01T00:00:00.000Z',
  identity: { alias: name, team: 'aweb:oats' }, team: null, tmux: { session: 'oats', window: name }, ...extra });
export const observed = (id, ws, rows) => ({
  deployment: { status: 'observed', root: `${id}/agents`, workspace: { name: basename(id) },
    workspaceStatus: { clones: [{ key: `clone:${basename(id)}`, path: `${id}/clone` }] },
    reachable: ws === undefined ? null : ws, withheld: [], souls: [{ name: 'dev' }], catalog: { souls: [] }, catalogKey: 'k' },
  instances: rows, generatedAt: `2026-10-02T09:00:0${basename(id).length % 10}.000Z`, observedAt: '2026-10-02T08:59:00.000Z' });
export const unavailable = () => ({ deployment: { status: 'unavailable', reason: { code: 'E_CLI_FAILED', message: 'boom' } }, instances: [],
  generatedAt: '2026-10-02T09:00:00.000Z' });
export const remoteRow = (name, root, extra = {}) => ({ instance: name, agent: 'dev', agentsRoot: `${root}/agents`, home: `${root}/agents/dev/instances/${name}`,
  running: true, savedRoute: false, addressable: true, missingRemotely: false, createdAt: null, identity: { alias: name, team: 'aweb:oats' }, ...extra });
export const group = (id, server, root, ws, instances = [], extra = {}) => ({ id, server, label: server, registrationPresent: true,
  target: { sshHost: `${server}.lan`, workspace: root }, probe: { ok: true }, agentsRoot: `${root}/agents`,
  workspace: ws === null ? null : { reachable: true, ...ws }, souls: [], instances, retireFailures: [], ...extra });

/** Juan's state: `{ altair, vega, state }`, `state` ready for loadViews / viewDeps (overrides win). */
export function juanState(over = {}) {
  const altair = group('altair:a1', 'altair', '/home/juan/oats', identity(), [remoteRow('far-a', '/home/juan/oats')]);
  const vega = group('vega:v1', 'vega', '/srv/lab', identity(LAB, 'aweb:lab'), [remoteRow('lab-a', '/srv/lab', { identity: { alias: 'lab-a', team: 'aweb:lab' } })]);
  const remoteGroups = over.remoteGroups ?? [altair, vega];
  const byWs = new Map([
    [A, observed(A, { reachable: true, ...identity() }, [row(A, 'dev-a'), row(A, 'idle', { running: false })])],
    [B, observed(B, { reachable: true, ...identity() }, [row(B, 'dev-b')])],
    [L, unavailable()],
    ...remoteGroups.map(g => [`remote:${g.id}`, remote.remotePanel(g, AT)]),
  ]);
  return { altair, vega, state: { ctxs: [A, B, L], snapshot: { byWs }, remoteGroups, ...over } };
}
export function juan(over = {}) {
  const { altair, vega, state } = juanState(over);
  return { altair, vega, views: loadViews(state) };
}
export const tag = (id, machine, path) => ({ id, machine, path });

/* The shipped HTTP handler over the shared views, the server's `held`, the instance lookup and the error shaping. */
export const FINDINST_BLOCK = between('/* OATSWEB_FINDINST_BEGIN', '/* OATSWEB_FINDINST_END */');
export const SPAWNERR_BLOCK = between('function spawnErrorPayload(e)', '/* OATSWEB_SPAWNERR_END */');
export const HANDLER = between('const send = (res, code, body, type', '\n// No upgrade transport');
/** `{ views, request }`: `request({ url, method, body, headers })` resolves `{ status, headers, body }`.
 * `extra` supplies the handler's other free names (doubles); the views' state comes from `state`. */
export async function loadServer(state = {}, extra = {}) {
  const { EventEmitter } = await import('node:events');
  // The handler names the shared functions as the server imports them; `held` is the server's own, over these values.
  const deps = { checkControlRequest, controlRequestHeaders, loopbackHost, controlToken: TEST_CONTROL_TOKEN, ...viewDeps(state), ...shared, createServer: fn => fn, ...extra };
  const { server, held } = new Function(...Object.keys(deps),
    `${HELD}\n${FINDINST_BLOCK}\n${SPAWNERR_BLOCK}\n${HANDLER}\nreturn { server, held };`)(...Object.values(deps));
  const views = bound(held);
  async function request({ url, method = 'GET', body, headers = { host: '127.0.0.1:4820', origin: 'http://127.0.0.1:4820' } }) {
    const req = new EventEmitter(); Object.assign(req, { url, method, headers: controlHeaders(headers) }); let result;
    const res = { writeHead(status, h) { result = { status, headers: h }; }, end(text) { result.body = JSON.parse(text); } };
    const done = server(req, res);
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
    req.emit('end'); await done; return result;
  }
  return { views, request };
}
