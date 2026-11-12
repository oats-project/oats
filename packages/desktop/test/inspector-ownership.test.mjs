import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { createSoulInspector, INSPECTION_STALE_TITLE } from '../renderer/soul-inspector.mjs';
import { createReadinessView } from '../renderer/readiness-view.mjs';
import { cliStatus, cliHeldBack } from '../renderer/views/cli-status.mjs';
import { postJson, wsQuery, workspaceGeneration, currentWorkspace, setWorkspace, rowDeployment } from '../renderer/views/common.mjs';
import { runtimeState } from '../../client/instance-presentation.mjs';
import { createSoulMark } from '../renderer/identity-marks.mjs';
import { inspectData, inspectFacts, originText } from '../../client/inspect-contract.mjs';
import { createTeamsPanel, teamsOperations, soulTeams } from '../renderer/teams-panel.mjs';
import { ageText } from '../renderer/age-text.mjs';
import { homeInspection, capturedOperations, capturedRun } from './helpers/inspect-fixture.mjs';
import { iconElement } from '../renderer/shell-icons.mjs';
import { createDataState, skeletonBlock, skeleton, captureFocusState } from '../renderer/loading.mjs';
import { coreEntries, coreNote, whyElement, isCoreCapability } from '../renderer/capability-page.mjs';
import { desktopFacts } from '../../client/soul-facts.mjs';
import { layerLabel } from '../../client/capability-rows.mjs';
import { buildState } from '../renderer/soul-inspector.mjs';
import { createDeploymentScopeLine } from '../renderer/deployment-scope-line.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = (request, outcome, value) => outcome === 'resolve' ? request.resolve(value) : request.reject(new Error('obsolete request failed'));
// Operations run on a live home (a soul lists none, F7): the selections are instance homes.
const homeOf = root => `/team/${root}/agents/dev/instances/dev-${root}`;
const selection = root => ({ instance: { instance: `dev-${root}`, agentsRoot: `/team/${root}/agents`, home: homeOf(root) }, selector: { home: homeOf(root) } });
// Inspection on the workspace model (operationsApi 2, from the kernel capture):
// oats.okf's two captured operations (status view, reindex action), available as
// on a home. The inspector is read-only, so only provider operations await.
const inspection = root => homeInspection(homeOf(root), { instance: `dev-${root}`, soul: 'dev', instructions: { file: `${homeOf(root)}/AGENTS.md`, text: `${root}-instructions`, truncated: false, sources: [] }, operations: capturedOperations() });
function ui(api, factory = createSoulInspector) {
  const previousWorkspace = currentWorkspace(); setWorkspace('/team');
  const dom = new JSDOM('<body><main><aside></aside></main></body>');
  const el = dom.window.document.querySelector('aside');
  const calls = []; let compatible = true;
  const controller = factory(el, { available: () => compatible,
    ctx: { api: async (url, opts) => { const body = JSON.parse(opts.body); calls.push({ url, ...body }); return api(body); } } });
  const control = text => { const b = [...el.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(b, `button ${text}`); return b; };
  return { dom, el, controller, calls, control, click: text => control(text).click(),
    operation: name => [...el.querySelectorAll('[data-operation]')].find(b => b.dataset.operation === `knowledge:${name}`),
    status: () => el.querySelector('[role="status"]').textContent,
    setCompatible(value) { compatible = value; controller.syncAvailability(); },
    close() { controller.dispose(); dom.window.close(); setWorkspace(previousWorkspace); },
  };
}

async function operationDowngrade(outcome, factory = createSoulInspector) {
  const request = deferred();
  const view = ui(body => body.action === 'inspect' ? inspection('a') : request.promise, factory);
  try {
    await view.controller.show(selection('a'));
    const control = view.operation('status'); control.click();
    view.controller.syncAvailability();
    assert.equal(control.disabled, true, 'availability sync must preserve the operation pending lock');
    // A queued click cannot bypass the lock even if dispatched directly.
    control.dispatchEvent(new view.dom.window.Event('click'));
    assert.equal(view.calls.length, 2, 'pending operation must not dispatch twice');
    view.setCompatible(false);
    settle(request, outcome, capturedRun({ result: { summary: 'current view' } })); await tick();
    assert.equal(control.disabled, true, 'settlement must preserve CLI unavailability');
    assert.equal(view.operation('reindex').disabled, true);
    assert.equal(view.status(), outcome === 'resolve' ? 'Complete.' : 'obsolete request failed', 'current completion still reports its result');
    control.dispatchEvent(new view.dom.window.Event('click'));
    assert.equal(view.calls.length, 2, 'downgrade never reruns an operation');
    view.setCompatible(true);
    assert.equal(control.disabled, false, 'only a settled operation can unlock on CLI recovery');
    assert.equal(view.calls.length, 2, 'CLI recovery is not a rerun');
  } finally { view.close(); }
}

async function operationOverlap(outcome, factory = createSoulInspector) {
  const first = deferred(), second = deferred();
  const view = ui(body => body.action === 'inspect' ? inspection('a') : body.operation === 'knowledge:status' ? first.promise : second.promise, factory);
  try {
    await view.controller.show(selection('a'));
    const inspect = view.operation('status'), digest = view.operation('reindex');
    inspect.click(); digest.click(); view.controller.syncAvailability();
    assert.ok(inspect.disabled && digest.disabled, 'each overlapping operation keeps its pending lock');
    const message = view.status();
    settle(first, outcome, capturedRun({ result: { summary: 'obsolete output' } })); await tick();
    assert.equal(view.status(), message, 'older operation cannot replace latest status on success or rejection');
    assert.equal(view.el.querySelector('.operation-output'), null, 'older operation cannot paint output');
    assert.equal(inspect.disabled, false, 'older operation releases only its own lock');
    assert.equal(digest.disabled, true, 'older settlement must not unlock a different pending operation');
    settle(second, outcome, capturedRun({ operation: 'knowledge:reindex', result: { currentDigest: true } })); await tick();
    assert.equal(view.status(), outcome === 'resolve' ? 'Complete.' : 'obsolete request failed');
    if (outcome === 'resolve') assert.match(view.el.querySelector('.operation-output pre').textContent, /"currentDigest": true/);
    assert.equal(digest.disabled, false, 'latest operation releases its own lock');
    assert.deepEqual(view.calls.filter(c => c.action === 'run').map(c => c.operation), ['knowledge:status', 'knowledge:reindex'], 'no incidental rerun');
  } finally { view.close(); }
}

async function operationInvalidation(outcome, boundary, factory = createSoulInspector) {
  const first = deferred(), second = deferred(); let runs = 0;
  const view = ui(body => body.action === 'inspect' ? inspection(body.selector.home === selection('a').selector.home ? 'a' : 'b') : ++runs === 1 ? first.promise : second.promise, factory);
  try {
    await view.controller.show(selection('a'));
    const oldControl = view.operation('status'); oldControl.click();
    if (boundary === 'selection') {
      await view.controller.show(selection('b')); view.operation('status').click();
      oldControl.dispatchEvent(new view.dom.window.Event('click'));
      assert.equal(runs, 2, 'obsolete control must not dispatch against the new selection');
    } else {
      setWorkspace('/elsewhere'); setWorkspace('/team'); view.controller.syncAvailability();
    }
    const before = view.el.innerHTML;
    settle(first, outcome, capturedRun({ result: { summary: 'obsolete output' } })); await tick();
    assert.equal(view.el.innerHTML, before, 'invalidated operation must not paint, report errors or unlock current controls');
    if (boundary === 'selection') {
      assert.equal(view.operation('status').disabled, true);
      second.resolve(capturedRun({ result: { summary: 'B output' } })); await tick();
      assert.match(view.el.textContent, /B output/);
      assert.equal(view.operation('status').disabled, false);
      assert.deepEqual(view.calls.filter(c => c.action === 'run').map(c => c.selector), [selection('a').selector, selection('b').selector]);
    } else assert.equal(oldControl.disabled, true, 'workspace generation remains unavailable until fresh inspection');
  } finally { view.close(); }
}

for (const outcome of ['resolve', 'reject']) {
  test(`operation ${outcome} retains pending and downgraded CLI availability`, () => operationDowngrade(outcome));
  test(`overlapping operations own separate locks on ${outcome}`, () => operationOverlap(outcome));
  for (const boundary of ['selection', 'workspace']) {
    test(`operation ${outcome} respects ${boundary} ownership`, () => operationInvalidation(outcome, boundary));
  }
}

// Bounded mutation verification of these regressions only, entirely in memory.
// Never replace the live worktree module or launch an app to test a mutant.
function mutant(from, to) {
  const source = createSoulInspector.toString();
  assert.equal(source.split(from).length, 2, 'mutation targets exactly one production guard');
  return runInNewContext(`(${source.replace(from, to)})`, { postJson, wsQuery, workspaceGeneration, rowDeployment, runtimeState, createSoulMark, createReadinessView, cliStatus, cliHeldBack, iconElement, originText, createTeamsPanel, teamsOperations, soulTeams, ageText, inspectData, inspectFacts, createDataState, skeletonBlock, skeleton, captureFocusState, desktopFacts, coreEntries, coreNote, whyElement, isCoreCapability, layerLabel, buildState, INSPECTION_STALE_TITLE, createDeploymentScopeLine });
}
test('mutation: pending ownership is essential during availability sync', async () => {
  const factory = mutant('pendingOperations.has(control) || !available()', '!available()');
  await assert.rejects(operationDowngrade('resolve', factory), /availability sync must preserve/);
});
for (const outcome of ['resolve', 'reject']) {
  test(`mutation: unconditional operation unlock is detected on ${outcome}`, async () => {
    const factory = mutant('pendingOperations.delete(control); syncAvailability();', 'pendingOperations.delete(control); control.disabled = false;');
    await assert.rejects(operationDowngrade(outcome, factory), /settlement must preserve CLI unavailability/);
  });
  test(`mutation: latest operation status ownership is essential on ${outcome}`, async () => {
    const factory = mutant('ownsControl() && op === operationSerial', 'ownsControl()');
    await assert.rejects(operationOverlap(outcome, factory), /older operation cannot replace latest status/);
  });
  test(`mutation: workspace generation is essential on ${outcome}`, async () => {
    const factory = mutant(' && gen === workspaceGeneration()', '');
    await assert.rejects(operationInvalidation(outcome, 'workspace', factory), /invalidated operation must not paint/);
  });
}
