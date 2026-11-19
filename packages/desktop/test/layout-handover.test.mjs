// The layout a workspace takes with it in a take-over (renderer/layout-handover.mjs): main refuses a
// descriptor whole unless it is the closed shape within its bounds, the window it comes from describes only
// its terminals of that workspace, and the window that takes it lays out what it could open again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validLayout, describeLayout, composeLayout, MAX_HANDED_TERMINALS } from '../renderer/layout-handover.mjs';
import { MAX_SPLIT_GROUPS } from '../renderer/split-layout.mjs';

const A = 'ws:aaaaaaaaaaaaaaaaaaaa';
const ref = (instance, extra = {}) => ({ instance, home: `/d/agents/${instance}`, ...extra });
const good = () => ({
  terminals: [ref('a'), ref('b', { server: 'build', agentsRoot: '/d/agents' }), ref('c')],
  split: { orientation: 'row', focused: 1, groups: [{ tabs: [0, 2], active: 2, weight: 2 }, { tabs: [1], active: 1 }] },
  active: 1,
});

test('a descriptor in the closed shape is accepted, a flat one included', () => {
  assert.equal(validLayout(good()), true);
  assert.equal(validLayout({ terminals: [ref('a')], split: null, active: null }), true);
  assert.equal(validLayout({ terminals: [{ instance: 'a' }], split: null, active: 0 }), true, 'only the instance name is required');
});

test('anything off the shape or past a bound is refused whole', () => {
  const variants = [
    null, 'x', [], { ...good(), extra: 1 }, { terminals: good().terminals, active: null }, { terminals: good().terminals, split: null },
    { ...good(), terminals: [] },
    { ...good(), split: null, terminals: Array.from({ length: MAX_HANDED_TERMINALS + 1 }, (_, i) => ref(`i${i}`)) },
    { ...good(), terminals: [ref('a'), { home: '/d/x' }, ref('c')] },
    { ...good(), terminals: [ref('a'), { instance: 'b', colour: 'red' }, ref('c')] },
    { ...good(), terminals: [ref('a'), { instance: 'b\nc' }, ref('c')] },
    { ...good(), terminals: [ref('a'), { instance: 'b ' }, ref('c')] },
    { ...good(), terminals: [ref('a'), { instance: 'x'.repeat(1025) }, ref('c')] },
    { ...good(), terminals: [ref('a'), { instance: 'b', home: '/'.repeat(4097) }, ref('c')] },
    { ...good(), terminals: [ref('a'), { instance: 7 }, ref('c')] },
    { ...good(), active: 3 }, { ...good(), active: -1 }, { ...good(), active: 1.5 }, { ...good(), active: '1' },
    { ...good(), split: { ...good().split, orientation: 'diagonal' } },
    { ...good(), split: { ...good().split, focused: 2 } },
    { ...good(), split: { ...good().split, groups: [{ tabs: [0, 1, 2], active: 0 }] } },
    { ...good(), split: { ...good().split, groups: Array.from({ length: MAX_SPLIT_GROUPS + 1 }, () => ({ tabs: [], active: null })) } },
    { ...good(), split: { ...good().split, groups: [{ tabs: [0, 2], active: 2 }, { tabs: [2], active: 2 }] } },
    { ...good(), split: { ...good().split, groups: [{ tabs: [0, 3], active: 0 }, { tabs: [1], active: 1 }] } },
    { ...good(), split: { ...good().split, groups: [{ tabs: [0, 2], active: 1 }, { tabs: [1], active: 1 }] } },
    { ...good(), split: { ...good().split, groups: [{ tabs: [0, 2], active: 2, weight: 0 }, { tabs: [1], active: 1 }] } },
    { ...good(), split: { ...good().split, groups: [{ tabs: [0, 2], active: 2, weight: Infinity }, { tabs: [1], active: 1 }] } },
    { ...good(), split: { ...good().split, groups: [{ tabs: [0, 2], active: 2, size: 1 }, { tabs: [1], active: 1 }] } },
    { ...good(), split: { ...good().split, extra: true } },
    Object.assign(Object.create({ inherited: true }), good()),
  ];
  for (const variant of variants) assert.equal(validLayout(variant), false, JSON.stringify(variant));
});

// A structured clone keeps an array's holes, and `every` skips them: each index is checked, a hole's too.
test('a terminals array with holes is refused, as is a split group\'s', () => {
  const sparse = [ref('a'), ref('b'), ref('c')]; delete sparse[1];
  const variants = [
    { terminals: new Array(3), split: null, active: null },
    { terminals: [, { instance: 'a' }], split: null, active: 0 }, // eslint-disable-line no-sparse-arrays
    { ...good(), terminals: sparse },
    { ...good(), split: { ...good().split, groups: [{ tabs: [0, , 2], active: 2 }, { tabs: [1], active: 1 }] } }, // eslint-disable-line no-sparse-arrays
  ];
  for (const variant of variants) assert.equal(validLayout(structuredClone(variant)), false, String(variant.terminals.length));
});

test('describe: the workspace\'s terminal tabs only, in strip order, with their split and active tab', () => {
  const tabs = new Map([
    [1, { kind: 'terminal', workspace: A, instanceRef: { instance: 'a', home: '/d/agents/a', running: true } }],
    [2, { kind: 'file', workspace: A }],
    [3, { kind: 'terminal', workspace: 'ws:other0000000000000', instanceRef: { instance: 'z' } }],
    [4, { kind: 'terminal', workspace: A, instanceRef: { instance: 'b', home: '/d/agents/b', server: 'build' } }],
    [5, { kind: 'brain', workspace: A }],
  ]);
  const split = { orientation: 'col', nextId: 4, focusedGroup: 3, groups: [{ id: 1, tabs: [1], activeTab: 1, weight: 3 }, { id: 3, tabs: [4], activeTab: 4 }] };
  const layout = describeLayout(tabs, split, 4, A);
  assert.deepEqual(layout, {
    terminals: [{ instance: 'a', home: '/d/agents/a' }, { instance: 'b', home: '/d/agents/b', server: 'build' }],
    split: { orientation: 'col', focused: 1, groups: [{ tabs: [0], active: 0, weight: 3 }, { tabs: [1], active: 1 }] },
    active: 1,
  });
  assert.equal(validLayout(layout), true, 'what a window describes is what main accepts');
  assert.equal(describeLayout(new Map([[2, { kind: 'file', workspace: A }]]), null, 2, A), null, 'no terminal: nothing to hand over');
  assert.equal(describeLayout(tabs, null, 2, A).active, null, 'a file tab active: no terminal is');
});

test('compose: the split of what opened again, every group kept, the active tab where it can be', () => {
  const ids = [11, null, 13];
  const { split, activeTab } = composeLayout(good(), (i) => ids[i]);
  assert.deepEqual(split, { orientation: 'row', nextId: 3, focusedGroup: 2,
    groups: [{ id: 1, tabs: [11, 13], activeTab: 13, weight: 2 }, { id: 2, tabs: [], activeTab: null }] });
  assert.equal(activeTab, null, 'the active terminal did not open, and the focused group is empty');
  const all = composeLayout(good(), (i) => [11, 12, 13][i]);
  assert.equal(all.activeTab, 12);
  const flat = composeLayout({ terminals: [ref('a'), ref('b')], split: null, active: null }, (i) => [null, 22][i]);
  assert.deepEqual(flat, { split: null, activeTab: 22 }, 'with no active one, the first that opened');
  const loose = composeLayout({ ...good(), split: { orientation: 'row', focused: 0, groups: [{ tabs: [0], active: 0 }, { tabs: [], active: null }] } }, (i) => [11, 12, 13][i]);
  assert.deepEqual(loose.split.groups[0].tabs, [11, 12, 13], 'a terminal no group named joins the focused group');
});
