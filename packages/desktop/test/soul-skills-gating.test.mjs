// The soul page's own skills: `inspect --soul --skills` (kernel feature soul-skills, `souls[0].skills`) through the
// server's one optional `skills` key, gated exactly as `instructions` is (remote-composed-gating.test.mjs). Locally,
// this computer's CLI advertising soul-skills is the gate; routed, that CLI must also advertise server-probe-features
// AND the roster row the server holds must have `probe.features` (an array) naming soul-skills. Unknown is not
// supported. The rosters are fixtures/remote-composed/ (README.md); a host that reports skills is built here from
// g-composes with its own list changed, since no fixture names soul-skills.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cliCapability } from '../../client/cli-adapter.mjs';
import { capabilityRequest } from '../server/capabilities.mjs';
import { createInspectCache } from '../../client/inspect-cache.mjs';
import { remoteWorkspace, remoteAgents } from '../../client/remote-roster.mjs';
import { skillsSupported, routedSkillsSupported, hostReportsSkills, hostComposes, SKILLS_FEATURE, COMPOSED_FEATURE, PROBE_FEATURES_FEATURE } from '../../client/composed-gate.mjs';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/remote-composed/${name}`, import.meta.url), 'utf8'));
const roster = fixture('roster.json').result.groups;
const captured = fixture('roster-captured.json').result.groups[0];
const group = id => structuredClone(roster.find(g => g.id === id));
/** A host that reports skills: g-composes (same target and souls) whose own list also names soul-skills. */
function skillsGroup(features = ['operations', 'observe-max-age', COMPOSED_FEATURE, PROBE_FEATURES_FEATURE, SKILLS_FEATURE]) {
  const g = group('g-composes'); g.probe.features = features; return g;
}
const BASE = ['operations', 'observe-max-age'];
const cliWith = features => ({ ok: true, operationsApi: 2, bin: '/b/oats', features: [...BASE, ...features], remote: ['operations', 'roster'] });
const NEW_CLI = cliWith([SKILLS_FEATURE, PROBE_FEATURES_FEATURE]);
/** Every host case: the reporting one is built; the fixtures' others do not name soul-skills (g-composes names only
 * the composed feature) or are unknown. */
const HOSTS = { present: skillsGroup, 'composes only': () => group('g-composes'), absent: () => group('g-other'), none: () => group('g-none'),
  'unknown (null)': () => group('g-older'), 'unknown (failed pull)': () => group('g-failed') };
const ROUTED = ['inspect', '--dir', '/srv/northwind', '--server', 'build', '--soul', 'release-manager', '--agents-root', '/srv/northwind/agents'];
const local = { id: '/w/northwind', scope: '/w/northwind' };
const localAgents = [{ name: 'release-manager', agentsRoot: '/w/northwind/agents' }];
const envelope = result => JSON.stringify({ schemaVersion: 1, ok: true, result });
const agentsOf = g => g.probe.ok ? remoteAgents(g) : [{ name: 'release-manager', agentsRoot: g.agentsRoot }];

/** One soul inspect through the server boundary and the real adapter: the argv the CLI would run. */
async function argvFor({ cli, workspace, agents, skills, instructions }) {
  const calls = [];
  const exec = (_bin, argv, _o, done) => { calls.push(argv); done(null, envelope({ subject: { kind: 'soul' } })); };
  const soul = agents[0];
  await capabilityRequest({ action: 'inspect', selector: { soul: soul.name, agentsRoot: soul.agentsRoot },
    ...(skills === undefined ? {} : { skills }), ...(instructions === undefined ? {} : { instructions }) },
  { workspace, cli, agents, instances: [], localCwd: '/l', invoke: (bin, options) => cliCapability(bin, options, { exec }) });
  assert.equal(calls.length, 1); return calls[0];
}

test('gate: the truth table (local/routed × this CLI’s features × the host’s probe.features)', () => {
  const clis = { old: cliWith([]), reports: cliWith([SKILLS_FEATURE]), relaysOnly: cliWith([PROBE_FEATURES_FEATURE]), both: NEW_CLI,
    composedOnly: cliWith([COMPOSED_FEATURE, PROBE_FEATURES_FEATURE]) };
  assert.deepEqual(Object.fromEntries(Object.entries(clis).map(([k, c]) => [k, [skillsSupported(c), routedSkillsSupported(c)]])),
    { old: [false, false], reports: [true, false], relaysOnly: [false, false], both: [true, true], composedOnly: [false, false] });
  for (const [cliName, cli] of Object.entries(clis)) for (const [host, make] of Object.entries(HOSTS))
    assert.equal(hostReportsSkills(cli, make()), cliName === 'both' && host === 'present', `${cliName} × ${host}`);
  // Only an array counts; a probe that failed never reports, whatever it lists; a missing key is unknown.
  for (const features of [SKILLS_FEATURE, { 0: SKILLS_FEATURE }, undefined, null, 1, true])
    assert.equal(hostReportsSkills(NEW_CLI, { probe: { ok: true, features } }), false, JSON.stringify(features));
  assert.equal(hostReportsSkills(NEW_CLI, { probe: { ok: true } }), false, 'no features key');
  assert.equal(hostReportsSkills(NEW_CLI, { probe: { ok: false, features: [SKILLS_FEATURE] } }), false);
  assert.equal(hostReportsSkills({ ...NEW_CLI, ok: false }, skillsGroup()), false, 'no usable CLI');
  assert.equal(skillsSupported({ ...NEW_CLI, ok: false }), false);
  for (const g of [null, undefined, {}, { probe: null }]) assert.equal(hostReportsSkills(NEW_CLI, g), false, JSON.stringify(g));
  assert.equal(hostReportsSkills(NEW_CLI, captured), false, 'the captured (older) host is unknown');
  // The two features are independent: a host that only composes does not report skills, and the other way round.
  const both = cliWith([COMPOSED_FEATURE, SKILLS_FEATURE, PROBE_FEATURES_FEATURE]);
  assert.deepEqual([hostComposes(both, group('g-composes')), hostReportsSkills(both, group('g-composes'))], [true, false]);
  const skillsOnly = skillsGroup(['operations', PROBE_FEATURES_FEATURE, SKILLS_FEATURE]);
  assert.deepEqual([hostComposes(both, skillsOnly), hostReportsSkills(both, skillsOnly)], [false, true]);
});

test('adapter: --skills only to a CLI advertising soul-skills, right after --instructions; never with --home or a run', async () => {
  const io = { calls: [], exec(_b, argv, _o, done) { io.calls.push(argv); done(null, envelope({})); } };
  const soulArgs = { action: 'inspect', context: '/w/northwind', soul: 'release-manager', agentsRoot: '/w/northwind/agents', localCwd: '/w/northwind' };
  const plain = ['inspect', '--dir', '/w/northwind', '--soul', 'release-manager', '--agents-root', '/w/northwind/agents'];
  await cliCapability('/b/oats', { ...soulArgs, skills: true, features: [SKILLS_FEATURE] }, io);
  for (const features of [[], undefined, [COMPOSED_FEATURE], ['observe-max-age']]) await cliCapability('/b/oats', { ...soulArgs, skills: true, features }, io);
  await cliCapability('/b/oats', { ...soulArgs, features: [SKILLS_FEATURE] }, io);
  await cliCapability('/b/oats', { ...soulArgs, instructions: true, skills: true, features: [COMPOSED_FEATURE, SKILLS_FEATURE] }, io);
  await cliCapability('/b/oats', { ...soulArgs, instructions: true, skills: true, features: [SKILLS_FEATURE] }, io);
  // Routed with --server it goes too (the server asks only for a host that reports skills).
  await cliCapability('/b/oats', { action: 'inspect', server: 'build', soul: 'release-manager', agentsRoot: '/srv/northwind/agents', localCwd: '/l', skills: true, features: [SKILLS_FEATURE] }, io);
  assert.deepEqual(io.calls, [[...plain, '--skills', '--json'], ...Array(4).fill([...plain, '--json']), [...plain, '--json'],
    [...plain, '--instructions', '--skills', '--json'], [...plain, '--skills', '--json'],
    ['inspect', '--server', 'build', '--soul', 'release-manager', '--agents-root', '/srv/northwind/agents', '--skills', '--json']]);
  for (const bad of [{ action: 'inspect', home: '/h', localCwd: '/h' }, { action: 'inspect', server: 'build', home: '/h', localCwd: '/l' },
    { action: 'run', home: '/h', localCwd: '/h', operation: 'knowledge:harvest' }, { action: 'inspect', context: '/w', localCwd: '/w' }])
    await assert.rejects(cliCapability('/b/oats', { ...bad, skills: true, features: [SKILLS_FEATURE] }, { exec: assert.fail }),
      { code: 'E_BAD_ARGS', message: 'Skills belong to a soul inspection' }, JSON.stringify(bad));
});

test('server: one optional boolean, a soul inspect only; sent locally when asked; the cache key includes it', async () => {
  const cli = cliWith([SKILLS_FEATURE]), instances = [{ instance: 'release-manager-1', home: '/h' }];
  const calls = [], invoke = async (_bin, options) => { calls.push(options); return JSON.parse(envelope({ subject: { kind: 'soul' } })); };
  const soul = { action: 'inspect', selector: { soul: 'release-manager', agentsRoot: '/w/northwind/agents' } };
  for (const bad of [{ ...soul, skills: 'yes' }, { ...soul, skills: 1 }, { action: 'inspect', selector: { home: '/h' }, skills: true },
    { action: 'run', selector: { home: '/h' }, operation: 'knowledge:x', skills: false }])
    await assert.rejects(capabilityRequest(bad, { workspace: local, cli, agents: localAgents, instances, localCwd: '/w/northwind', invoke }),
      { code: 'E_BAD_ARGS', message: 'Invalid skills flag' }, JSON.stringify(bad));
  assert.equal(calls.length, 0);
  const cache = createInspectCache(), ask = request => capabilityRequest(request, { workspace: local, cli, agents: localAgents, instances, localCwd: '/w/northwind', invoke, cache });
  await ask({ ...soul, skills: true });
  await ask(soul);
  assert.deepEqual(calls.map(c => c.skills === true), [true, false], 'two reads: the flag is part of the cache key');
  assert.equal(Object.hasOwn(calls[1], 'skills'), false, 'an unflagged read carries no skills option');
  await ask({ ...soul, skills: true });
  assert.equal(calls.length, 2, 'the flagged read is cached under its own key');
  // Locally, server-probe-features plays no part: soul-skills alone is the gate.
  assert.ok((await argvFor({ cli: cliWith([SKILLS_FEATURE]), workspace: local, agents: localAgents, skills: true })).includes('--skills'));
  assert.ok(!(await argvFor({ cli: cliWith([PROBE_FEATURES_FEATURE]), workspace: local, agents: localAgents, skills: true })).includes('--skills'));
});

test('server: a routed soul inspect carries --skills only for a host whose held row names soul-skills', async () => {
  for (const [host, make] of Object.entries(HOSTS)) {
    const g = make(), workspace = remoteWorkspace(g), agents = agentsOf(g);
    const flagged = await argvFor({ cli: NEW_CLI, workspace, agents, skills: true });
    const plain = await argvFor({ cli: NEW_CLI, workspace, agents });
    if (host === 'present') {
      assert.deepEqual(flagged, [...ROUTED, '--skills', '--json']);
      assert.deepEqual(plain, [...ROUTED, '--json']);
    } else assert.deepEqual(flagged, plain, `${host}: the ask is dropped, the read is today's`);
  }
  // The captured roster row (an older host) gets today's argv.
  const workspace = remoteWorkspace(structuredClone(captured)), agents = remoteAgents(structuredClone(captured));
  assert.deepEqual(await argvFor({ cli: NEW_CLI, workspace, agents, skills: true }), await argvFor({ cli: NEW_CLI, workspace, agents }));
  // Both asked of a host that reports both, through a CLI that routes both.
  const both = cliWith([COMPOSED_FEATURE, SKILLS_FEATURE, PROBE_FEATURES_FEATURE]), g = skillsGroup();
  assert.deepEqual(await argvFor({ cli: both, workspace: remoteWorkspace(g), agents: remoteAgents(g), instructions: true, skills: true }),
    [...ROUTED, '--instructions', '--skills', '--json']);
  // A host that composes but does not report skills keeps --instructions and drops --skills.
  assert.deepEqual(await argvFor({ cli: both, workspace: remoteWorkspace(group('g-composes')), agents: remoteAgents(group('g-composes')), instructions: true, skills: true }),
    [...ROUTED, '--instructions', '--json']);
  // A workspace object without its roster group (no held row) is unknown.
  const { group: _held, ...bare } = remoteWorkspace(g);
  assert.ok(!(await argvFor({ cli: NEW_CLI, workspace: bare, agents: remoteAgents(g), skills: true })).includes('--skills'));
});

test('server: a CLI without server-probe-features never routes it', async () => {
  const g = skillsGroup(), workspace = remoteWorkspace(g), agents = remoteAgents(g);
  for (const cli of [cliWith([]), cliWith([SKILLS_FEATURE]), cliWith([PROBE_FEATURES_FEATURE])])
    assert.deepEqual(await argvFor({ cli, workspace, agents, skills: true }), await argvFor({ cli, workspace, agents }), JSON.stringify(cli.features));
  // A remote workspace with no held row at all, through a CLI that reports skills but does not relay host features.
  const calls = [], invoke = async (_bin, options) => { calls.push(options); return JSON.parse(envelope({ subject: { kind: 'soul' } })); };
  const remote = { id: 'remote:builder', scope: '/remote/member', remote: true, server: 'builder', registrationPresent: true };
  await capabilityRequest({ action: 'inspect', selector: { soul: 'dev', agentsRoot: '/remote/member/agents' }, skills: true },
    { workspace: remote, cli: cliWith([SKILLS_FEATURE]), agents: [{ name: 'dev', agentsRoot: '/remote/member/agents' }], instances: [], localCwd: '/l', invoke });
  assert.equal(Object.hasOwn(calls[0], 'skills'), false, 'the host’s features are not held: never routed');
  // The flag stays validated as before, routed too.
  await assert.rejects(capabilityRequest({ action: 'inspect', selector: { soul: 'release-manager', agentsRoot: g.agentsRoot }, skills: 'yes' },
    { workspace, cli: NEW_CLI, agents, instances: [], localCwd: '/l', invoke: assert.fail }), { code: 'E_BAD_ARGS', message: 'Invalid skills flag' });
});
