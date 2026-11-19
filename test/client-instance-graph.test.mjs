// The Graph's layout (packages/client/instance-graph.mjs, the Desktop UI rework, slice 6b): one shared model of who
// started whom and where it runs, for the Desktop now and the Terminal UI later. The Desktop's acceptance tests are
// packages/desktop/test/graph-slice6b.test.mjs; these pin the model's own rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { instanceGraph, graphStops, FIELD_KEY } from '../packages/client/instance-graph.mjs';
import { clientTerms } from '../packages/client/client-terms.mjs';
import { instanceId } from '../packages/client/instance-tree.mjs';

const terms = clientTerms({ name: 'Test', self: 'this test', selfInitial: 'This test', update: 'the test', thisMachine: 'This machine' });
const HERE = { id: '/w', machine: '', path: '/w', local: true, primary: true };
const POLARIS = { id: 'polaris:/w', machine: 'polaris', path: '/w', local: false };
const row = (instance, extra = {}) => {
  const server = extra.server ?? null;
  return { instance, agent: 'dev', home: `/h/${server ?? 'here'}/${instance}`, agentsRoot: '/r', running: true,
    createdAt: '2026-11-01T00:00:00.000Z', deployment: { id: server ? `${server}:/w` : '/w' }, ...(server ? { server } : {}), ...extra };
};
const outline = (column) => column.rows.map((r) => (r.kind === 'you' ? 'you' : `${'  '.repeat(r.depth)}${r.row.instance}`));

test('terms are required, as every shared table that names this machine', () => {
  assert.throws(() => instanceGraph([], [], { thisMachine: 'x' }), /terms must be/);
});

test('no deployments reported: one column, this machine, by its name when known', () => {
  const g = instanceGraph([row('a'), row('b', { parentInstance: 'a' })], [], terms, { here: 'falcon' });
  assert.deepEqual(g.columns.map((c) => [c.key, c.label, c.local]), [['here', 'falcon', true]]);
  assert.deepEqual(outline(g.columns[0]), ['a', '  b']);
  assert.equal(instanceGraph([row('a')], [], terms).columns[0].label, 'This machine');
});

test('two folders of one machine: a column each, one machine, and an edge between them that is not cross-machine', () => {
  // One column per deployment (the lead's decision for slice 6b), labelled by its machine and folder; both are this
  // computer, so a parent in one and its child in the other are on one machine.
  const g = instanceGraph([row('a'), row('b', { deployment: { id: '/v' }, parentInstance: 'a' })],
    [HERE, { id: '/v', machine: '', path: '/v', local: true }], terms, { here: 'falcon' });
  assert.deepEqual(g.columns.map((c) => [c.label, c.machine]), [['falcon · v', ':here'], ['falcon · w', ':here']]);
  assert.deepEqual(g.edges.map((e) => e.kind), ['column']);
  const b = g.columns[0].rows[0];
  assert.deepEqual([b.crossColumn, b.crossMachine], [true, false]);
  // Two folders of one registered machine: one machine too; a parent on this computer is another machine.
  const r = instanceGraph([row('lead'), row('x', { server: 'polaris', parentInstance: 'lead' }), row('y', { server: 'polaris', deployment: { id: 'polaris:/v' }, parentInstance: 'x' })],
    [HERE, POLARIS, { id: 'polaris:/v', machine: 'polaris', path: '/v', local: false }], terms);
  assert.deepEqual(r.edges.map((e) => [e.to.split('/').pop(), e.kind]).sort(), [['x', 'cross'], ['y', 'column']]);
});

test('the roster order at every level (newest spawn first); an untagged row joins the primary', () => {
  const g = instanceGraph([row('old', { createdAt: '2026-11-01T00:00:00Z' }), row('new', { createdAt: '2026-11-05T00:00:00Z' }),
    row('kid-old', { parentInstance: 'new', createdAt: '2026-11-06T00:00:00Z' }), row('kid-new', { parentInstance: 'new', createdAt: '2026-11-07T00:00:00Z' }),
    { ...row('pending'), deployment: undefined, createdAt: null }], [HERE, POLARIS], terms);
  assert.deepEqual(outline(g.columns[0]), ['new', '  kid-new', '  kid-old', 'old', 'pending']);
  assert.deepEqual(graphStops(g).map((list) => list.map((r) => r.row.instance)), [['new', 'kid-new', 'kid-old', 'old', 'pending'], []]);
});

test('same work only where the host declares the feature, and only on a drawn edge', () => {
  const g = instanceGraph([row('lead'), row('flagged', { parentInstance: 'lead', sameWork: true, sameWorkKnown: true }),
    row('ungated', { parentInstance: 'lead', sameWork: true }), row('orphan', { parentInstance: 'gone', sameWork: true, sameWorkKnown: true })], [HERE], terms);
  const by = (name) => g.columns[0].rows.find((r) => r.row?.instance === name);
  assert.equal(by('flagged').sameWork, true);
  assert.equal(by('ungated').sameWork, false, 'a host that does not declare the feature: no flag read');
  assert.equal(by('orphan').sameWork, false, 'no parent drawn: nothing to be the same work as');
  assert.equal(by('orphan').recordedParent, 'gone');
  assert.deepEqual(g.edges.filter((e) => e.sameWork).map((e) => e.to), [instanceId(by('flagged').row)]);
});

test('You: an attributed human and no recorded parent; a malformed label is no human', () => {
  const g = instanceGraph([row('mine', { attributedHuman: 'Joan' }), row('child', { parentInstance: 'mine', attributedHuman: 'Joan' }),
    row('blank', { attributedHuman: '   ' }), row('bad', { attributedHuman: 'x\ny' }), row('loose')], [HERE], terms);
  assert.deepEqual(outline(g.columns[0]), ['you', '  mine', '    child', 'bad', 'blank', 'loose']);
  assert.deepEqual(g.edges.filter((e) => e.kind === 'you').map((e) => e.from), ['you:/w']);
});

test('a parentInstance cycle is cut once, at its first row in the roster order: every row drawn once', () => {
  const g = instanceGraph([row('a', { parentInstance: 'c', createdAt: '2026-11-03T00:00:00Z' }), row('b', { parentInstance: 'a', createdAt: '2026-11-02T00:00:00Z' }),
    row('c', { parentInstance: 'b', createdAt: '2026-11-01T00:00:00Z' }), row('self', { parentInstance: 'self' })], [HERE], terms);
  assert.deepEqual(outline(g.columns[0]), ['self', 'a', '  b', '    c']);
  assert.equal(g.columns[0].rows.find((r) => r.row.instance === 'a').parent, null, 'the cut row is a root');
  assert.equal(g.edges.length, 2);
});

test('names resolve within a column first: a twin elsewhere is never a guess', () => {
  // A parent name its own column has is that column's, even when another machine has the same name.
  const g = instanceGraph([row('lead'), row('lead', { server: 'polaris' }), row('dev', { parentInstance: 'lead' })], [HERE, POLARIS], terms);
  assert.deepEqual(g.edges.map((e) => [e.from, e.kind]), [['/h/here/lead', 'started']]);
  // Two rows of one column share the name (two agents roots): no edge, the row is a root.
  const twins = instanceGraph([row('lead', { agentsRoot: '/r1' }), row('lead', { agentsRoot: '/r2', home: '/h/here2/lead' }), row('dev', { parentInstance: 'lead', agentsRoot: '/r3' })], [HERE], terms);
  assert.equal(twins.edges.length, 0);
});

test('a field: every agent in one tree; a cross-machine edge keeps its kind; labels name each column', () => {
  const g = instanceGraph([row('lead'), row('far', { server: 'polaris', parentInstance: 'lead' })], [HERE, POLARIS], terms, { mode: 'field', here: 'falcon' });
  assert.equal(g.mode, 'field');
  assert.deepEqual(g.columns.map((c) => c.key), [FIELD_KEY]);
  assert.deepEqual(outline(g.columns[0]), ['lead', '  far']);
  assert.deepEqual(g.columns[0].rows.map((r) => r.machine), ['falcon', 'polaris']);
  assert.deepEqual(g.edges.map((e) => e.kind), ['cross']);
  assert.deepEqual([...g.labels], [['/w', 'falcon'], ['polaris:/w', 'polaris']]);
  assert.equal(instanceGraph([], [], terms, { mode: 'nonsense' }).mode, 'columns');
});
