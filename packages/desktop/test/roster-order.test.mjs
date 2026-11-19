// Two orders. The panel's list (awebai/oats#1083): running (`running === true`), then unknown (`null`, or anything
// not a boolean), then stopped (`false`); by name within each. One comparison, `byRuntimeState`
// (packages/client/instance-presentation.mjs), read by `panelInstances` (deployment-panel.mjs) and
// `rosterRank("status")` (instance-tree.mjs). The roster (Pepe, 2026-11-13, replacing #1262's name order): by spawn
// time (`createdAt`), newest first; a row without one after every row with one; then by name, ties broken by
// instanceId, whatever runs. `clusterInstances` ranks clusters (by their first root) and children that way, so a
// start or a stop moves nothing. Each is fed a row of each state in every input order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { byRuntimeState } from '../../client/instance-presentation.mjs';
import { panelInstances } from '../../client/deployment-panel.mjs';
import { clusterInstances, rosterRank } from '../../client/instance-tree.mjs';

/** Every order of `items`. */
const permutations = items => items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [item, ...rest]));
/** Names that sort against the states (stopped < unknown < running by name), so only the state can put a
 * running row first. */
const ONE = [['z-run', true], ['m-unknown', null], ['a-stopped', false]];
const TWO = [['z1-run', true], ['z2-run', true], ['m1-unknown', null], ['m2-unknown', 'yes'], ['a1-stopped', false], ['a2-stopped', false]];
const want = rows => rows.map(([instance]) => instance);
const row = ([instance, running]) => ({ instance, agentsRoot: '/d/agents', running });

const panelOrder = rows => panelInstances(rows, rows.map(() => ({}))).map(i => i.instance);
const clusterOrder = rows => clusterInstances(rows).map(c => c.instances[0].instance);
const statusOrder = rows => [...rows].sort(rosterRank('status')).map(i => i.instance);
/** A root with every row as its child: the order of children inside one cluster. */
const childOrder = rows => clusterInstances([{ instance: 'root', running: true }, ...rows.map(r => ({ ...r, parentInstance: 'root' }))])[0].instances.slice(1).map(i => i.instance);

for (const [what, order] of [['panelInstances', panelOrder], ['rosterRank("status")', statusOrder]]) {
  test(`${what}: running, then unknown, then stopped, whatever the input order`, () => {
    const one = permutations(ONE);
    assert.equal(one.length, 6);
    for (const input of one) assert.deepEqual(order(input.map(row)), want(ONE), JSON.stringify(input));
    // Two names per state: all 720 orders of the six rows.
    const two = permutations(TWO);
    assert.equal(two.length, 720);
    for (const input of two) assert.deepEqual(order(input.map(row)), want(TWO), JSON.stringify(input));
  });
}

/** The same rows by name: what the roster draws for rows with no spawn time, whatever runs. */
const byName = rows => [...rows].map(([instance]) => instance).sort((a, b) => a.localeCompare(b));
for (const [what, order] of [['clusterInstances: clusters', clusterOrder], ['clusterInstances: children of one root', childOrder]]) {
  test(`${what}: rows with no spawn time by name, whatever runs and whatever the input order`, () => {
    const one = permutations(ONE);
    for (const input of one) assert.deepEqual(order(input.map(row)), byName(ONE), JSON.stringify(input));
    const two = permutations(TWO);
    assert.equal(two.length, 720);
    for (const input of two) assert.deepEqual(order(input.map(row)), byName(TWO), JSON.stringify(input));
  });
}

test('the panel and rosterRank("status") give the same order for the same rows; the roster gives the name order', () => {
  for (const input of permutations(TWO)) {
    const panel = panelOrder(input.map(row));
    assert.deepEqual(statusOrder(input.map(row)), panel, JSON.stringify(input));
    assert.deepEqual(clusterOrder(input.map(row)), byName(TWO), JSON.stringify(input));
  }
});

test('the roster order is total: one name in two agents roots ranks by identity, the same whatever the input order', () => {
  const twins = [['dev', true, '/b/agents'], ['dev', false, '/a/agents'], ['dev', null, '/c/agents'], ['alpha', false, '/a/agents'], ['zulu', true, '/a/agents']]
    .map(([instance, running, agentsRoot]) => ({ instance, agentsRoot, home: `${agentsRoot}/${instance}`, running }));
  const roots = rows => clusterInstances(rows).map(c => `${c.instances[0].instance}@${c.instances[0].agentsRoot}`);
  const first = roots(twins);
  assert.deepEqual(first, ['alpha@/a/agents', 'dev@/a/agents', 'dev@/b/agents', 'dev@/c/agents', 'zulu@/a/agents']);
  for (const input of permutations(twins)) assert.deepEqual(roots(input), first, JSON.stringify(input.map(r => r.agentsRoot + r.instance)));
});

test('byRuntimeState is a total order whatever `running` holds: anything not a boolean is unknown', () => {
  const values = [true, false, null, undefined, 'true', 'false', 1, 0, {}, []];
  const rows = values.flatMap((running, i) => [{ instance: `x${i}`, running }, { instance: `y${i}`, running }]);
  const sign = (a, b) => Math.sign(byRuntimeState(a, b));
  for (const a of rows) {
    assert.equal(sign(a, a), 0);
    for (const b of rows) {
      assert.equal(sign(a, b) + sign(b, a), 0, `${a.instance} ${b.instance}`);
      for (const c of rows) if (sign(a, b) <= 0 && sign(b, c) <= 0) assert.ok(sign(a, c) <= 0, `${a.instance} ${b.instance} ${c.instance}`);
    }
  }
  const sorted = [...rows].sort(byRuntimeState);
  assert.deepEqual(sorted.slice(0, 2).map(r => r.running), [true, true]);
  assert.deepEqual(sorted.slice(-2).map(r => r.running), [false, false]);
  assert.ok(sorted.slice(2, -2).every(r => typeof r.running !== 'boolean'), 'every non-boolean stands between them');
});

/** Rows spawned at the given minutes of one day, named so that the name order is the reverse of the spawn order
 * and running against it: only `createdAt` can give the expected order. */
const at = minute => `2026-11-13T10:${String(minute).padStart(2, '0')}:00.000Z`;
const SPAWNED = [['a-old', false, at(1)], ['m-mid', null, at(5)], ['z-new', true, at(9)]];
const spawned = ([instance, running, createdAt]) => ({ instance, agentsRoot: '/d/agents', running, createdAt });
const NEWEST_FIRST = ['z-new', 'm-mid', 'a-old'];

for (const [what, order] of [['clusterInstances: clusters', clusterOrder], ['clusterInstances: children of one root', childOrder]]) {
  test(`${what}: by spawn time, newest first, whatever runs and whatever the input order`, () => {
    for (const input of permutations(SPAWNED)) assert.deepEqual(order(input.map(spawned)), NEWEST_FIRST, JSON.stringify(input));
  });
}

test('the roster puts rows with no readable spawn time after every row with one, those by name', () => {
  const rows = [...SPAWNED.map(spawned), ...[['b-none', undefined], ['c-bad', 'not a time'], ['a-null', null], ['d-number', 5]]
    .map(([instance, createdAt]) => ({ instance, agentsRoot: '/d/agents', running: true, createdAt }))];
  for (const input of permutations(rows.slice(1))) {
    assert.deepEqual(clusterOrder([rows[0], ...input]), [...NEWEST_FIRST, 'a-null', 'b-none', 'c-bad', 'd-number'], JSON.stringify(input.map(r => r.instance)));
  }
});

test('the roster orders rows spawned at the same time by name, then by identity', () => {
  const same = at(3);
  const rows = [['zulu', '/a/agents'], ['dev', '/b/agents'], ['dev', '/a/agents'], ['alpha', '/a/agents']]
    .map(([instance, agentsRoot]) => ({ instance, agentsRoot, home: `${agentsRoot}/${instance}`, createdAt: same }));
  const roots = list => clusterInstances(list).map(c => `${c.instances[0].instance}@${c.instances[0].agentsRoot}`);
  for (const input of permutations(rows)) assert.deepEqual(roots(input), ['alpha@/a/agents', 'dev@/a/agents', 'dev@/b/agents', 'zulu@/a/agents']);
});

test('a bundle sits by its root\'s spawn time: a newer child does not move it, and the child is listed newest first', () => {
  const rows = [
    { instance: 'lead', createdAt: at(1) },
    { instance: 'solo', createdAt: at(4) },
    { instance: 'helper-a', parentInstance: 'lead', createdAt: at(2) },
    { instance: 'helper-z', parentInstance: 'lead', createdAt: at(8) },
  ].map(r => ({ ...r, agentsRoot: '/d/agents' }));
  for (const input of permutations(rows)) {
    assert.deepEqual(clusterInstances(input).map(c => c.instances.map(i => i.instance)), [['solo'], ['lead', 'helper-z', 'helper-a']], JSON.stringify(input.map(r => r.instance)));
  }
});
