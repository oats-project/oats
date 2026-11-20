// Scope travels with each action (#482): a workspace view can hold several deployments, and every
// request about ONE instance is addressed to that row's deployment (`row.deployment.id`), never to the
// view on screen. The server resolves those routes only by exact deployment id (a view id is refused:
// test/deployment-scope.test.mjs); this file pins the renderer side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as common from '../renderer/views/common.mjs';
import { instanceActionTarget, sameInstanceActionTarget, spawnOpenDescriptor } from '../renderer/instance-action-target.mjs';
import { instanceDeployment } from '../renderer/context-panel.mjs';

const VIEW = 'ws:0123456789abcdef0123';
const row = (deployment, extra = {}) => ({ instance: 'dev-1', agent: 'dev', agentsRoot: `${deployment}/agents`, home: `${deployment}/agents/dev/instances/dev-1`,
  createdAt: '2026-10-02T09:00:00.000Z', deployment: { id: deployment, machine: 'This Mac', path: deployment }, ...extra });
const withView = (fn) => { const prev = common.currentWorkspace(); try { common.setWorkspace(VIEW); return fn(); } finally { common.setWorkspace(prev); } };

test('rowDeployment: a tagged row is addressed to its deployment; an untagged row to the selected workspace', () => withView(() => {
  assert.equal(common.rowDeployment(row('/Users/alex/example/oats-qa')), '/Users/alex/example/oats-qa');
  assert.equal(common.rowDeployment({ instance: 'x', deployment: { id: 'remote:devbox:3f2a00000000' } }), 'remote:devbox:3f2a00000000');
  assert.equal(common.rowDeployment({ instance: 'x' }), VIEW, 'a row served before views belonged to the selected (deployment) workspace');
  assert.equal(common.rowDeployment({ instance: 'x', deployment: { id: '' } }), VIEW);
}));

test('instanceApiPath: the start/restart family goes to the row\'s deployment, not the view', () => withView(() => {
  const local = row('/Users/alex/example/oats-qa');
  for (const kind of ['start', 'restart']) {
    const url = new URL(common.instanceApiPath(kind, local), 'http://127.0.0.1');
    assert.equal(url.searchParams.get('ws'), '/Users/alex/example/oats-qa', kind);
    assert.equal(url.searchParams.get('home'), local.home, kind);
  }
  const remote = row('/srv/web', { server: 'devbox', deployment: { id: 'remote:devbox:3f2a00000000', machine: 'devbox', path: '/srv/web' } });
  const url = new URL(common.instanceApiPath('start', remote), 'http://127.0.0.1');
  assert.deepEqual([url.searchParams.get('ws'), url.searchParams.get('server')], ['remote:devbox:3f2a00000000', 'devbox']);
  assert.equal(common.instanceApiPath('restart', 'solo'), `/api/restart/solo?ws=${encodeURIComponent(VIEW)}`, 'a bare name keeps the selected workspace');
}));

test('instance action targets: owned by the view, addressed to the row\'s deployment; descriptors round-trip it', () => {
  const r = row('/Users/alex/example/oats-qa');
  const target = instanceActionTarget(VIEW, r, { requireBirth: true });
  assert.equal(target.workspace, VIEW);
  assert.equal(target.deployment, '/Users/alex/example/oats-qa');
  assert.equal(sameInstanceActionTarget(target, r, VIEW), true);
  assert.equal(sameInstanceActionTarget(target, { ...r, deployment: { id: '/Users/alex/Agents/oats' } }, VIEW), false, 'the same home in another deployment is another target');
  const descriptor = spawnOpenDescriptor({ kind: 'open-instance', target, connectionEpoch: 0 });
  assert.equal(descriptor.target.deployment, '/Users/alex/example/oats-qa');
  assert.equal(instanceActionTarget('/w', { ...r, deployment: undefined }).deployment, '/w', 'an untagged row: the workspace is its deployment');
});

test('the context panel addresses its instance sections to the instance\'s deployment', () => {
  assert.equal(instanceDeployment({ workspace: VIEW, instance: row('/Users/alex/Agents/oats') }), '/Users/alex/Agents/oats');
  assert.equal(instanceDeployment({ workspace: VIEW, instance: { instance: 'x' } }), VIEW);
  assert.equal(instanceDeployment({ workspace: VIEW, instance: null }), VIEW);
});

test('launch configurations of an instance are read in its deployment while ownership stays with the view', async () => {
  const { window } = new JSDOM('<div id="host"></div>');
  const paths = [];
  const ctx = { api: async (path) => { paths.push(path); return { configurations: [], context: null }; } };
  const { launchConfigFields } = await import('../renderer/launch-config-fields.mjs');
  const prev = common.currentWorkspace();
  try {
    common.setWorkspace(VIEW);
    const fields = launchConfigFields(window.document.getElementById('host'), { ctx, selector: () => ({ home: '/d2/agents/dev/instances/dev-1' }), choices: () => ({}), deployment: '/d2' });
    await fields.load();
    assert.ok(paths.length > 0);
    for (const p of paths) assert.equal(new URL(p, 'http://127.0.0.1').searchParams.get('ws'), '/d2', p);
    fields.dispose();
  } finally { common.setWorkspace(prev); }
});

// The instance-addressed route families, and the renderer modules that address them. Each such request
// must take its workspace from the row (rowDeployment / a target's deployment / instanceDeployment), never
// from currentWorkspace() or wsQuery(), which name the view on screen.
const INSTANCE_ROUTES = /\/api\/(?:instance-(?:git|forge|lifecycle|events|review-threads)|workspace-readiness|start\/|restart\/)/;
const source = (path) => readFileSync(new URL(`../renderer/${path}`, import.meta.url), 'utf8');

test('source pin: no instance-addressed route is composed with the view selector anywhere in the renderer', () => {
  const files = [...readdirSync(new URL('../renderer/', import.meta.url)).filter(f => f.endsWith('.mjs')),
    ...readdirSync(new URL('../renderer/views/', import.meta.url)).filter(f => f.endsWith('.mjs')).map(f => `views/${f}`),
    // The renderer modules that moved to the shared home (packages/client); `source` resolves from renderer/.
    ...readdirSync(new URL('../../client/', import.meta.url)).filter(f => f.endsWith('.mjs')).map(f => `../../client/${f}`)];
  for (const file of files) {
    for (const [index, line] of source(file).split('\n').entries()) {
      if (!INSTANCE_ROUTES.test(line)) continue;
      assert.doesNotMatch(line, /wsQuery\(|currentWorkspace\(\)/, `${file}:${index + 1} addresses an instance route with the view on screen`);
    }
  }
});

test('source pin: each instance-addressed call site takes the row\'s deployment', () => {
  const pins = [
    ['instance-pr-action.mjs', /\?ws=\$\{encodeURIComponent\(target\.deployment\)\}/],
    ['instance-pr-action.mjs', /gitTarget\(\{ \.\.\.target, workspace: target\.deployment \}\)/],
    ['shell.mjs', /lifecycleDialog\.open\(\{ operation, instance, workspace: rowDeployment\(instance\) \}\)/],
    ['context-panel.mjs', /const deployment = instanceDeployment\(context\);/],
    ['views/hierarchy.mjs', /const selection = row => \(\{ workspace: rowDeployment\(row\),/],
    ['soul-inspector.mjs', /selection\?\.instance \? `\?ws=\$\{encodeURIComponent\(rowDeployment\(selection\.instance\)\)\}`/],
    ['soul-inspector.mjs', /id: ref \? rowDeployment\(ref\) : w\.primary \|\| w\.id/],
    ['start-instance.mjs', /deployment: rowDeployment\(instance\)/],
    ['start-instance.mjs', /instanceApiPath\(restart \? "restart" : "start", instance\)/],
    ['views/schedules.mjs', /\/api\/capabilities\$\{deploymentQuery\(\)\}/],
    ['views/schedules.mjs', /\/api\/schedules\$\{mutationQuery\(operation\)\}/],
  ];
  for (const [file, pattern] of pins) assert.match(source(file), pattern, file);
  // The context panel's three instance sections all receive the deployment, not the view.
  assert.equal((source('context-panel.mjs').match(/workspace: deployment, instance: context\.instance, key: context\.key/g) || []).length, 3);
});
