// A launch's --instance (renderer/launch-focus.mjs, D3 of #1665): the workspace's window selects the named
// instance's roster row as "show in roster" does, once a roster read of the --dir deployment lists it, and
// opens its terminal if observed running. It waits LAUNCH_FOCUS_PENDING_MS for a spawn still finishing, then says
// the name is not there. A person's choice, or a later launch's request, wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLaunchFocus, launchFocusMatch, launchFocusRequest, LAUNCH_FOCUS_PENDING_MS } from '../renderer/launch-focus.mjs';

const DEPLOYMENT = '/d/acme';
const row = (instance, extra = {}) => ({ instance, home: `/d/acme/agents/x/instances/${instance}`, deployment: { id: DEPLOYMENT, machine: 'This Mac', path: DEPLOYMENT }, ...extra });

/** A launch focus over fakes: its timers, the ownership ticket, the operator's generations, what it selected and said. */
function harness({ operator = { input: 0, pointer: 0 } } = {}) {
  const selected = [], opened = [], said = [], timers = new Map();
  let ticket = 0, serial = 0;
  const focus = createLaunchFocus({
    watch: () => { const mine = ticket; return () => mine === ticket; },
    operator: { input: () => operator.input, pointer: () => operator.pointer },
    select: async (r) => { selected.push(r.instance); return true; },
    open: async (r) => { opened.push(r.instance); return true; },
    notify: (text) => said.push(text),
    setTimer: (fn, ms) => { const id = ++serial; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    focus, selected, opened, said, timers, operator,
    choose: () => { ticket++; }, // a person's selection: the shell's selection-ownership ticket moves on
    expire: () => { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the pending bound is a named constant of about 30 s', () => {
  assert.equal(LAUNCH_FOCUS_PENDING_MS, 30_000);
});

test('launchFocusRequest: main\'s message, a validated name of a deployment or that the value was not one; nothing else', () => {
  assert.deepEqual(launchFocusRequest({ deployment: DEPLOYMENT, name: 'dev-2' }), { deployment: DEPLOYMENT, name: 'dev-2' });
  assert.deepEqual(launchFocusRequest({ invalid: true }), { invalid: true });
  for (const bad of [null, 'dev-2', {}, { name: 'dev-2' }, { deployment: DEPLOYMENT, name: 'Dev' }, { deployment: DEPLOYMENT, name: '<b>x</b>' },
    { deployment: 'relative', name: 'dev-2' }, { deployment: DEPLOYMENT, name: 'dev-2', extra: 1 }, { invalid: 'yes' }]) {
    assert.equal(launchFocusRequest(bad), null, JSON.stringify(bad));
  }
});

test('launchFocusMatch: only the --dir deployment\'s own rows count, a home still being set up included', () => {
  const name = 'dev-2', request = { deployment: DEPLOYMENT, name };
  assert.equal(launchFocusMatch([row('dev-1'), row(name)], request).row.instance, name);
  assert.equal(launchFocusMatch([row(name, { held: { kind: 'spawning' } })], request).row.instance, name, 'a spawning home is the instance');
  assert.deepEqual(launchFocusMatch([row('dev-1')], request), { none: true });
  assert.deepEqual(launchFocusMatch([], request), { none: true });
  assert.deepEqual(launchFocusMatch([row(name, { deployment: { id: '/d/other' } })], request), { none: true }, 'another deployment of the view');
  assert.deepEqual(launchFocusMatch([row(name, { server: 'srv-1' })], request), { none: true }, 'a remote row');
  assert.deepEqual(launchFocusMatch([row(name, { remote: true })], request), { none: true }, 'a remote row');
  assert.deepEqual(launchFocusMatch([row(name, { pendingSpawn: { pending: 'spawning' } })], request), { none: true }, 'a pending row only this window draws');
  assert.deepEqual(launchFocusMatch([row(name), row(name, { home: '/d/acme/agents/y/instances/dev-2' })], request), { many: true });
  assert.deepEqual(launchFocusMatch([row(name), row(name, { server: 'srv-1' })], request).row.instance, name, 'a remote row never adds a duplicate');
});

test('a known name is selected on the first roster read that lists it, and nothing more happens', async () => {
  const h = harness();
  h.focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
  h.focus.observe([row('dev-1'), row('dev-2')]);
  assert.deepEqual(h.selected, ['dev-2'], 'selected within the read that lists it');
  await settle();
  assert.deepEqual(h.selected, ['dev-2']);
  assert.deepEqual(h.said, []);
  assert.equal(h.timers.size, 0, 'the bound ends with the selection');
  h.focus.observe([row('dev-2')]);
  await settle();
  assert.deepEqual(h.selected, ['dev-2'], 'selected once');
  assert.equal(h.focus.pending(), false);
});

test('a spawn still finishing: the row appears on a later read within the bound, and is selected then', async () => {
  const h = harness();
  h.focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
  assert.deepEqual([...h.timers.values()].map((t) => t.ms), [LAUNCH_FOCUS_PENDING_MS]);
  h.focus.observe([row('dev-1')]);
  h.focus.observe([row('dev-1')]);
  assert.deepEqual(h.selected, []); assert.deepEqual(h.said, []);
  h.focus.observe([row('dev-1'), row('dev-2')]);
  await settle();
  assert.deepEqual(h.selected, ['dev-2']);
  assert.deepEqual(h.said, []);
});

test('a name the workspace never lists within the bound: nothing is selected, and the window says so', () => {
  const h = harness();
  h.focus.request({ deployment: DEPLOYMENT, name: 'dev-9' });
  h.focus.observe([row('dev-1')]);
  h.expire();
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.said, ['No instance dev-9 in this workspace.']);
  h.focus.observe([row('dev-9')]);
  assert.deepEqual(h.selected, [], 'past the bound, a late row is not followed');
});

test('an invalid value: nothing is selected, and the notice does not repeat it', () => {
  const h = harness();
  h.focus.request({ invalid: true });
  h.focus.observe([row('dev-1')]);
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.said, ['The instance named at launch isn\'t a valid instance name.']);
  assert.equal(h.focus.pending(), false);
});

test('an invalid value with no roster read in time is still said, once', () => {
  const h = harness();
  h.focus.request({ invalid: true });
  h.expire();
  h.focus.observe([row('dev-1')]);
  assert.deepEqual(h.said, ['The instance named at launch isn\'t a valid instance name.']);
});

test('a malformed message is ignored: it replaces nothing and says nothing', async () => {
  const h = harness();
  h.focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
  h.focus.request({ deployment: DEPLOYMENT, name: '<img src=x>' });
  h.focus.observe([row('dev-2')]);
  await settle();
  assert.deepEqual(h.selected, ['dev-2']);
  assert.deepEqual(h.said, []);
});

test('a name two rows of the deployment carry selects nothing and says so', () => {
  const h = harness();
  h.focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
  h.focus.observe([row('dev-2'), row('dev-2', { home: '/d/acme/agents/y/instances/dev-2' })]);
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.said, ['More than one instance in this workspace is named dev-2, so none was selected.']);
  assert.equal(h.focus.pending(), false);
});

test('a person\'s selection while pending drops it: a later read never moves the view, and nothing is said', () => {
  const h = harness();
  h.focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
  h.focus.observe([row('dev-1')]);
  h.choose();
  h.focus.observe([row('dev-1'), row('dev-2', { running: true })]);
  h.expire();
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.said, []);
  assert.equal(h.focus.pending(), false);
});

test('a person\'s input or pointer press while pending drops it too (never a yank)', () => {
  for (const key of ['input', 'pointer']) {
    const h = harness();
    h.focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
    h.focus.observe([row('dev-1')]);
    h.operator[key]++;
    h.focus.observe([row('dev-2', { running: true })]);
    h.expire();
    assert.deepEqual(h.selected, [], key); assert.deepEqual(h.opened, [], key); assert.deepEqual(h.said, [], key);
  }
});

test('the person\'s ticket is taken at the first roster read: the window binding itself before it drops nothing', async () => {
  const h = harness();
  h.focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
  h.choose(); // the window claims its workspace while it starts: before any roster read
  h.focus.observe([row('dev-2')]);
  await settle();
  assert.deepEqual(h.selected, ['dev-2']);
});

test('a later launch\'s --instance replaces a pending one, and its bound starts again', async () => {
  const h = harness();
  h.focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
  h.focus.observe([row('dev-1')]);
  h.focus.request({ deployment: DEPLOYMENT, name: 'dev-3' });
  assert.equal(h.timers.size, 1, 'one bound: the earlier one is cleared');
  h.focus.observe([row('dev-2', { running: true }), row('dev-3', { running: true })]);
  await settle();
  assert.deepEqual(h.opened, ['dev-3']);
  assert.deepEqual(h.selected, []);
  assert.deepEqual(h.said, []);
});

test('a select that fails, rejecting or throwing, changes nothing more and says nothing', async () => {
  for (const select of [async () => { throw new Error('gone'); }, () => { throw new Error('gone'); }]) {
    const said = [];
    const focus = createLaunchFocus({ watch: () => () => true, select,
      notify: (text) => said.push(text), setTimer: () => 1, clearTimer: () => {} });
    focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
    focus.observe([row('dev-2')]);
    await settle();
    assert.deepEqual(said, []);
    assert.equal(focus.pending(), false);
  }
});

test('dispose clears the bound: nothing is said after the page goes', () => {
  const h = harness();
  h.focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
  h.focus.dispose();
  assert.equal(h.timers.size, 0);
  h.focus.observe([row('dev-2')]);
  assert.deepEqual(h.selected, []);
});


test('running rows open; stopped, never launched and unknown rows select only', async () => {
  for (const running of [true, false, null, undefined, 'true']) {
    const h = harness();
    h.focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
    h.focus.observe([row('dev-2', { running })]);
    await settle();
    assert.deepEqual(h.opened, running === true ? ['dev-2'] : []);
    assert.deepEqual(h.selected, running === true ? [] : ['dev-2']);
    assert.equal(h.focus.pending(), false);
  }
});

test('the first observed row consumes the request: appears running opens, appears stopped then starts never opens', async () => {
  for (const running of [true, false]) {
    const h = harness();
    h.focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
    h.focus.observe([]);
    h.focus.observe([row('dev-2', { running })]);
    h.focus.observe([row('dev-2', { running: true })]);
    await settle();
    assert.deepEqual(h.opened, running ? ['dev-2'] : []);
    assert.deepEqual(h.selected, running ? [] : ['dev-2']);
  }
});

test('later launches, operator input and disposal invalidate an in-flight open', () => {
  for (const action of ['launch', 'input', 'pointer', 'dispose']) {
    const h = harness();
    const validity = [];
    const focus = createLaunchFocus({ watch: () => () => true,
      operator: { input: () => h.operator.input, pointer: () => h.operator.pointer },
      select() {}, open: (_row, valid) => validity.push(valid), notify() {},
      setTimer: () => 1, clearTimer() {} });
    focus.request({ deployment: DEPLOYMENT, name: 'dev-2' });
    focus.observe([row('dev-2', { running: true })]);
    assert.equal(validity[0](), true);
    if (action === 'launch') focus.request({ deployment: DEPLOYMENT, name: 'dev-3' });
    else if (action === 'dispose') focus.dispose();
    else h.operator[action]++;
    assert.equal(validity[0](), false, action);
    focus.dispose();
  }
});
