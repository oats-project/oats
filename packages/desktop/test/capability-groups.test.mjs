// The shared repository groups (packages/client/capability-rows.mjs groupCapabilities), which the Terminal UI still
// draws. The Desktop's Capabilities tab lists every capability as one flat list since the UI rework's slice 3b: its
// repository pills and group headings are gone (capabilities-rows.test.mjs pins the list).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalog from '../renderer/workspace-catalog.mjs';
import { groupCapabilities, capabilitySections, memberNames } from '../../client/capability-rows.mjs';

const HOST = 'github.com/acme/agents';
const STATUS = { workspace: { key: HOST }, members: [
  { key: HOST, name: 'agents', status: 'confirmed' }, { key: 'github.com/acme/zeta', name: 'zeta', status: 'confirmed' }, { key: 'github.com/acme/alpha', name: 'alpha', status: 'confirmed' }] };
const row = (name, kind, repoKey, extra = {}) => ({ name, kind, repoKey, origin: `${kind} ${repoKey}`, ...extra });
const ROWS = [
  row('z-one', 'member', 'github.com/acme/zeta'), row('ext-a', 'external', 'github.com/other/tools'),
  row('a-one', 'member', 'github.com/acme/alpha'), row('a-two', 'member', 'github.com/acme/alpha'),
  row('h-one', 'member', HOST), row('ext-b', 'external', 'github.com/third/kit'),
  { name: 'pkg', kind: 'package', package: 'p', version: '1.0.0', origin: 'package p v1.0.0' },
];

test('repository groups follow the Souls tab order: the host first, then members by name, one "external" group last', () => {
  const names = memberNames(STATUS);
  const groups = groupCapabilities(capabilitySections(ROWS).workspace, names, HOST);
  assert.deepEqual(groups.map(g => [g.key, g.name, g.note, g.rows.map(r => r.name)]), [
    [`member:${HOST}`, 'agents', 'member repo · host', ['h-one']],
    ['member:github.com/acme/alpha', 'alpha', 'member repo', ['a-one', 'a-two']],
    ['member:github.com/acme/zeta', 'zeta', 'member repo', ['z-one']],
    ['external', 'external', 'not in a member repo', ['ext-a', 'ext-b']],
  ]);
  // Without a reported host nothing is called the host.
  assert.deepEqual(groupCapabilities(capabilitySections(ROWS).workspace, names, null).map(g => g.name), ['agents', 'alpha', 'zeta', 'external']);
  assert.ok(groupCapabilities(capabilitySections(ROWS).workspace, names, null).every(g => !g.note.includes('host')));
});

test('the Desktop draws no repository pills, section jump or group headings on Capabilities any more', () => {
  for (const gone of ['renderRepoPills', 'repoChoices', 'filterCapabilities', 'renderCapabilitySections', 'syncCapabilityNav', 'rovePill', 'renderCapabilities']) assert.equal(catalog[gone], undefined, gone);
  assert.doesNotMatch(catalog.catalogCSS, /catalog-pills|capability-nav|catalog-group|catalog-tile/);
});
