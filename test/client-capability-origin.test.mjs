// Who made a capability (packages/client/capability-origin.mjs, the Desktop UI rework D24): "official" from the facts
// the kernel already reports, "by <source>" otherwise. Pinned acceptance: `slice3b official rule`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilityOrigin, ORIGIN_COPY, OATS_REPO_KEY } from '../packages/client/capability-origin.mjs';

const STATUS = {
  members: [{ key: 'github.com/awebai/oats', name: 'oats' }, { key: 'github.com/acme/agents', name: 'agents' }],
  packages: [
    { id: 'oats.okf', source: 'catalog:oats.okf' },
    { id: 'oats.framework', source: 'catalog:oats.framework' },
    { id: 'oats.apps', source: 'git:github.com/awebai/oats-apps@v1.0.0' },
    { id: 'acme.tools', source: 'git:https://forge.example/acme/tools.git@v0.4.0' },
  ],
};

test('slice3b official rule', () => {
  const table = [
    ['a package pinned from the catalog', { name: 'oats.okf', kind: 'package', package: 'oats.okf' }, { official: true, by: 'OATS', reason: 'catalog' }],
    ['a package capability whose id is not its package id (oats.core of oats.framework)', { name: 'oats.core', kind: 'package', package: 'oats.framework' }, { official: true, by: 'OATS', reason: 'catalog' }],
    ['an oats.-named package pinned by git: the name proves nothing', { name: 'oats.folio', kind: 'package', package: 'oats.apps' }, { official: false, by: 'oats-apps', reason: null }],
    ['a git package with a URL and .git', { name: 'tracker', kind: 'package', package: 'acme.tools' }, { official: false, by: 'tools', reason: null }],
    ['a package workspace status does not list', { name: 'lost', kind: 'package', package: 'acme.gone' }, { official: false, by: 'acme.gone', reason: null }],
    ['a member capability of the OATS repository, by its old key', { name: 'oats.build', kind: 'member', repoKey: 'github.com/awebai/oats' }, { official: true, by: 'OATS', reason: 'oats-repo' }],
    ['a member capability of the OATS repository, by its new key', { name: 'oats.build', kind: 'member', repoKey: OATS_REPO_KEY }, { official: true, by: 'OATS', reason: 'oats-repo' }],
    ['another member: by its name in workspace status', { name: 'notes', kind: 'member', repoKey: 'github.com/acme/agents' }, { official: false, by: 'agents', reason: null }],
    ['an oats.-named member capability of another repository', { name: 'oats.notes', kind: 'member', repoKey: 'github.com/acme/agents' }, { official: false, by: 'agents', reason: null }],
    ['an external capability', { name: 'ext', kind: 'external', repoKey: 'github.com/other/tools' }, { official: false, by: 'tools', reason: null }],
    ['an external capability from the OATS repository is still external', { name: 'ext', kind: 'external', repoKey: 'github.com/awebai/oats' }, { official: false, by: 'oats', reason: null }],
  ];
  for (const [what, row, want] of table) assert.deepEqual(capabilityOrigin(row, STATUS), want, what);
  // No status: nothing official can be claimed for a package.
  assert.deepEqual(capabilityOrigin({ name: 'oats.okf', kind: 'package', package: 'oats.okf' }, null), { official: false, by: 'oats.okf', reason: null });
  assert.deepEqual(ORIGIN_COPY.officialTitle, { catalog: 'Official: in the OATS catalog', 'oats-repo': 'Official: from the OATS repository' });
  assert.equal(ORIGIN_COPY.by('agents'), 'by agents');
});
