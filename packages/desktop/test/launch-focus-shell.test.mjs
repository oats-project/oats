// The shell's side of a launch's --instance (D3 of #1665): main's ask (onLaunchFocus) becomes a request of the
// shipped launch focus; running rows open through the ordinary terminal opener, without input focus.
// Other rows select only. Nothing starts and there is no roster read of its own. The shipped shell.mjs
// lines run in a vm over fakes that record every call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createLaunchFocus } from '../renderer/launch-focus.mjs';
import { instanceActionTarget } from '../renderer/instance-action-target.mjs';

const source = readFileSync(new URL('../renderer/shell.mjs', import.meta.url), 'utf8');
const between = (from, to) => { const a = source.indexOf(from), b = source.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return source.slice(a, b); };
const creation = between("// A launch's --instance (launch-focus.mjs): its row is selected", '// Persistent recursive instance tree');
const subscription = between('// A launch asks this window to select an instance', '/** Another window took `workspace` over.');
const row = (instance, extra = {}) => ({ instance, agent: 'x', agentsRoot: '/d/acme/agents', home: `/d/acme/agents/x/instances/${instance}`, deployment: { id: '/d/acme' }, ...extra });

const fn = (name) => { const found = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`)); assert.ok(found, name); return found[0]; };

/** The shipped launch focus, its subscription and showInRoster, over fakes: `rows` are the rows painted now (their
 * list elements too), `shown` the newest read's record, `gen` the roster generation. Every selection, roster read
 * and forbidden act is recorded. */
function shell({ shown = null, rows = shown?.instances ?? [], gen = shown?.gen ?? 0, workspace = 'ws:acme' } = {}) {
  const calls = [];
  let subscriber = null, ticket = 0, pointer = 0;
  const forbidden = (name) => () => { throw new Error(`${name} must not run for a launch's --instance`); };
  const element = (i) => ({ dataset: { treeInstance: i.home } });
  const c = {
    createLaunchFocus, instanceActionTarget, calls,
    tabOpenIntents: { watch: () => { const mine = ticket; return () => mine === ticket; }, invalidate: () => { ticket++; } },
    operator: { input: () => 0, pointer: () => pointer },
    notifications: { notify: (text) => calls.push(['notify', text]) },
    window: { addEventListener() {} },
    desktopBridge: { onLaunchFocus: (fn) => { subscriber = fn; } },
    shownRoster: shown, contextRosterGen: gen, contextWorkspace: workspace, contextInstances: rows,
    currentWorkspace: () => workspace,
    contextRosterEl: { querySelector: () => ({ querySelectorAll: () => c.contextInstances.map(element) }) },
    refreshContextRoster: async () => { calls.push(['read']); },
    backgroundPlacement: () => new Set(), backgroundShown: () => false, backgroundOpen: new Set(),
    rosterParentId: () => null, collapsedInstances: new Set(), collapseKey: (ws, id) => `${ws}\n${id}`,
    instanceId: (i) => i.home, renderContextRoster() {},
    setRovingRow: (_list, target) => calls.push(['select', target.dataset.treeInstance.split('/').at(-1)]),
    heldHome: (row) => row.held, shownRows: rows => rows, rosterStale: false, contextDeployments: [], rowStale: row => row.stale, canAddressRemote: row => row.addressable !== false,
    alert: text => calls.push(['error', text]),
    openTerminalTab: (row, options) => { calls.push(['open', row.instance, options]); ticket++; }, openInstanceStart: forbidden('openInstanceStart'), api: forbidden('api'),
  };
  runInNewContext(`${fn('showInRoster')}\n${creation}\n${subscription}\nglobalThis.launchFocus = launchFocus;`, c);
  // A person's choice is a press that selects something: both generations move on.
  return { c, ask: (m) => subscriber(m), choose: () => { pointer++; ticket++; } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("second launch on a window already showing the row: selected at once through showInRoster, and nothing else", async () => {
  const s = shell({ shown: { gen: 3, ws: 'ws:acme', instances: [row('dev-1'), row('dev-2')] } });
  s.ask({ deployment: '/d/acme', name: 'dev-2' });
  await settle();
  assert.deepEqual(s.c.calls, [['select', 'dev-2']]);
});

test('first launch: the ask waits for the first roster read, which selects the row', async () => {
  const s = shell();
  s.ask({ deployment: '/d/acme', name: 'dev-2' });
  assert.equal(s.c.launchFocus.pending(), true);
  s.c.contextInstances = [row('dev-2')]; // the first read's rows, painted
  s.c.launchFocus.observe(s.c.contextInstances);
  await settle();
  assert.deepEqual(s.c.calls, [['select', 'dev-2']]);
});

test('rows of another workspace do not answer an ask', async () => {
  const s = shell({ shown: { gen: 3, ws: 'ws:other', instances: [row('dev-2')] } });
  s.ask({ deployment: '/d/acme', name: 'dev-2' });
  await settle();
  assert.deepEqual(s.c.calls, []);
  assert.equal(s.c.launchFocus.pending(), true);
});

test('an invalid value is said in the window as text, without the value', async () => {
  const s = shell({ shown: { gen: 3, ws: 'ws:acme', instances: [row('dev-1')] } });
  s.ask({ invalid: true });
  assert.deepEqual(s.c.calls, [['notify', "The instance named at launch isn't a valid instance name."]]);
});

test("a person's selection before the next read drops a pending ask", async () => {
  const s = shell();
  s.ask({ deployment: '/d/acme', name: 'dev-2' });
  s.c.launchFocus.observe([row('dev-1')]);
  s.choose();
  s.c.launchFocus.observe([row('dev-2')]);
  await settle();
  assert.deepEqual(s.c.calls, []);
});

test("an earlier visit's rows never answer an ask: back on a workspace whose new read has not landed, nothing is selected or read", async () => {
  // Shown A with dev-2, switched away and back: the switch moved the roster generation on and cleared the rows.
  const s = shell({ shown: { gen: 1, ws: 'ws:acme', instances: [row('dev-2')] }, rows: [], gen: 2 });
  s.ask({ deployment: '/d/acme', name: 'dev-2' });
  await settle();
  assert.deepEqual(s.c.calls, [], 'no selection and no roster read of its own');
  assert.equal(s.c.launchFocus.pending(), true, 'it waits for the new read');
  s.choose(); // the person picks something else before that read lands
  s.c.contextInstances = [row('dev-2')];
  s.c.launchFocus.observe(s.c.contextInstances);
  await settle();
  assert.deepEqual(s.c.calls, [], "the person's choice won");
});

test('the launch selects only rows painted now: a row the window does not show is not read for, and nothing is selected later', async () => {
  const s = shell({ rows: [] });
  s.ask({ deployment: '/d/acme', name: 'dev-2' });
  s.c.launchFocus.observe([row('dev-2')]); // a read lists it, but those rows are not the ones painted
  await settle();
  assert.deepEqual(s.c.calls, [], 'showInRoster read nothing and selected nothing');
});

test('the shell feeds the launch focus only observed reads of this computer\'s rows, after the paint', () => {
  const read = between('async function refreshContextRoster(', '\n/** #1237: close every terminal tab');
  const paint = read.indexOf('renderContextRoster(contextInstances);\n  }\n'), feed = read.indexOf('if (!reportedFailure && !panel.workspace?.remote) launchFocus.observe(contextInstances);');
  assert.ok(paint > 0 && feed > paint, 'observed after the rows are painted');
  assert.equal(read.split('launchFocus.').length - 1, 1, 'one place');
});


test('first and second launch select then open a running row through the click opener with no focus request', async () => {
  for (const first of [true, false]) {
    const rows = [row('dev-2', { running: true })];
    const s = shell(first ? { rows } : { shown: { gen: 3, ws: 'ws:acme', instances: rows } });
    s.ask({ deployment: '/d/acme', name: 'dev-2' });
    if (first) s.c.launchFocus.observe(rows);
    await settle();
    assert.deepEqual(s.c.calls.map(call => call.slice(0, 2)), [['select', 'dev-2'], ['open', 'dev-2']]);
    const opts = s.c.calls[1][2];
    assert.equal(opts.focusContent, false);
    assert.equal(opts.followed, true, 'reuse painted roster; no additional resolution read');
    assert.deepEqual(opts.expected, instanceActionTarget('ws:acme', rows[0]));
    assert.equal(opts.valid(), true, 'our own selection does not cancel the open');
    s.choose();
    assert.equal(opts.valid(), false, 'operator activity cancels it');
  }
});

test('held, stale and unavailable running rows select only', async () => {
  for (const extra of [{ held: { kind: 'retiring' } }, { stale: true }, { addressable: false }]) {
    const s = shell({ shown: { gen: 3, ws: 'ws:acme', instances: [row('dev-2', { running: true, ...extra })] } });
    s.ask({ deployment: '/d/acme', name: 'dev-2' });
    await settle();
    assert.deepEqual(s.c.calls, [['select', 'dev-2']]);
  }
});

test('a newer choice between selection and opening prevents the open', async () => {
  const s = shell({ shown: { gen: 3, ws: 'ws:acme', instances: [row('dev-2', { running: true })] } });
  s.ask({ deployment: '/d/acme', name: 'dev-2' });
  s.choose();
  await settle();
  assert.deepEqual(s.c.calls, [['select', 'dev-2']]);
});

test('current failed opens report the click error; stale success and rejection have no later effect', async () => {
  for (const stale of [false, true]) for (const rejects of [false, true]) {
    const s = shell({ shown: { gen: 3, ws: 'ws:acme', instances: [row('dev-2', { running: true })] } });
    let finish;
    s.c.openTerminalTab = () => new Promise((resolve, reject) => { finish = () => rejects ? reject(new Error('session gone')) : resolve(); });
    s.ask({ deployment: '/d/acme', name: 'dev-2' });
    await settle();
    if (stale) s.choose();
    finish();
    await settle();
    assert.deepEqual(s.c.calls, [['select', 'dev-2'], ...(!stale && rejects ? [['error', 'session gone']] : [])]);
  }
});
