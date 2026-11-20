// The look inside a folder the operator picked that is not a deployment (#461): its direct children
// that hold a regular oats-local.yaml, bounded and never parsed. Nothing is looked at unasked: the
// switcher's own suggestions come from this computer's deployments list (#1390).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentsInside, PICK_SCAN_LIMIT } from '../../client/workspace-admission.mjs';
import { pickedFolderChoices } from '../workspace-registry.mjs';

const listing = (names, { links = [] } = {}) => (_dir, limit) => {
  const entries = [...names.map((name) => ({ name, isDirectory: true })), ...links.map((name) => ({ name, isDirectory: false }))];
  return { entries: entries.slice(0, limit), limited: entries.length > limit };
};

test('deploymentsInside: the direct children holding a deployment, sorted; links, files and others are not offered', () => {
  const deployments = new Set(['/h/work/oats', '/h/work/aweb', '/h/work/web', '/h/work/linked']);
  const found = deploymentsInside('/h/work', { list: listing(['web', 'notes', 'oats', 'aweb'], { links: ['linked'] }), isDeployment: (p) => deployments.has(p) });
  assert.deepEqual(found, { paths: ['/h/work/aweb', '/h/work/oats', '/h/work/web'], limited: false });
});

test('deploymentsInside: at most PICK_SCAN_LIMIT entries are read; an unreadable or missing folder offers nothing', () => {
  const names = Array.from({ length: PICK_SCAN_LIMIT + 5 }, (_, i) => `d${String(i).padStart(3, '0')}`);
  const found = deploymentsInside('/h/work', { list: listing(names), isDeployment: () => true });
  assert.equal(found.paths.length, PICK_SCAN_LIMIT); assert.equal(found.limited, true);
  assert.deepEqual(deploymentsInside('/h/work', { list: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, isDeployment: () => true }),
    { paths: [], limited: false });
  assert.deepEqual(deploymentsInside('/h/work', { list: listing(['a']), isDeployment: () => { throw new Error('EACCES'); } }), { paths: [], limited: false });
});

test('a picked parent folder still offers the deployments inside it, through the same scan', () => {
  const answer = pickedFolderChoices('/h/work', { list: listing(['web', 'oats']), isDeployment: (p) => p !== '/h/work' && p.startsWith('/h/work/') });
  assert.deepEqual(answer.choices.map((c) => [c.path, c.kind]), [['/h/work/oats', 'inside'], ['/h/work/web', 'inside']]);
});
