// Workspace views (#482): the kernel's matching rules (docs/desktop-cli-api.md, "Matching workspaces
// across machines" and "Matching teams across machines"), one case per rule, and the reason sentences.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readIdentity, attachment, viewId, deploymentReason, deploymentReasonParts, buildViews } from '../../client/workspace-views.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';
import { clientTerms } from '../../client/client-terms.mjs';

const KEY = 'github.com/awebai/oats';
const identity = (over = {}) => ({ key: KEY, ref: 'git:github.com/awebai/oats', keyFrom: 'workspace', standalone: false,
  defaultTeam: { label: 'default', team: 'aweb:oats' }, teams: { default: 'aweb:oats' }, teamsFrom: 'observed', ...over });
const attach = workspace => attachment(readIdentity(workspace).identity ?? null);
const dep = (id, workspace, { local = id.startsWith('/'), name } = {}) => {
  const read = readIdentity(workspace);
  return { id, local, name: name ?? (local ? id.split('/').pop() : undefined), attach: attachment(read.identity ?? null),
    teamLabel: read.identity?.defaultTeam?.label ?? null };
};
const WS = /^ws:[0-9a-f]{20}$/;

test('equal key and equal team: one view holding both deployments', () => {
  const views = buildViews([dep('/Users/alex/Agents/oats', identity()), dep('remote:devbox:a1', identity())]);
  assert.equal(views.length, 1);
  assert.match(views[0].id, WS);
  assert.deepEqual(views[0], { id: viewId(KEY, 'aweb:oats'), name: 'oats', key: KEY, team: 'aweb:oats', unattached: false,
    deployments: ['/Users/alex/Agents/oats', 'remote:devbox:a1'], primary: '/Users/alex/Agents/oats' });
});

test('the two spellings of a moved workspace are one view, under its first deployment\'s id and key', () => {
  const OLD = KEY, NEW = 'github.com/oats-project/oats';
  const moved = identity({ key: NEW, ref: `git:${NEW}` });
  const [view, ...rest] = buildViews([dep('/Users/me/OATS', identity(), { name: 'oats' }), dep('remote:devbox:a1', moved)]);
  assert.deepEqual(rest, [], 'one view, not two of one name');
  assert.deepEqual(view.deployments, ['/Users/me/OATS', 'remote:devbox:a1']);
  assert.deepEqual([view.id, view.key, view.name], [viewId(OLD, identity().defaultTeam.team), OLD, 'oats']);
  const [flipped] = buildViews([dep('/Users/me/OATS', moved, { name: 'oats' }), dep('remote:devbox:a1', identity())]);
  assert.deepEqual([flipped.id, flipped.key, flipped.deployments.length], [viewId(NEW, identity().defaultTeam.team), NEW, 2]);
});

test('inert: a set of one spelling keeps the view id and key it had; another repository of that name stays another view', () => {
  const [view] = buildViews([dep('/Users/me/OATS', identity()), dep('remote:devbox:a1', identity())]);
  assert.equal(view.id, viewId(KEY, identity().defaultTeam.team));
  const views = buildViews([dep('/Users/me/OATS', identity()), dep('remote:devbox:a1', identity({ key: 'github.com/acme/oats' }))]);
  assert.equal(views.length, 2);
});

test('keyFrom "member" is unresolved: never matched, unattached with its reason', () => {
  const member = identity({ keyFrom: 'member', key: 'github.com/example/oats-member' });
  assert.deepEqual(attach(member), { unattached: 'member' });
  const views = buildViews([dep('/a', member), dep('/b', identity({ key: 'github.com/example/oats-member' }))]);
  assert.deepEqual(views.map(v => [v.id, v.unattached]), [[viewId('github.com/example/oats-member', 'aweb:oats'), false], ['/a', true]]);
  assert.equal(deploymentReason({ local: true, identityStatus: 'identity', attach: attach(member) }, DESKTOP_TERMS),
    'This deployment\'s workspace reference names a member whose workspace isn\'t known yet; run oats sync there.');
});

test('a null key is an unusable reference: unattached, the reason shows the ref', () => {
  const bad = identity({ key: null, keyFrom: null, ref: 'git:not a repo' });
  assert.deepEqual(attach(bad), { unattached: 'invalid-ref' });
  assert.deepEqual(attach(identity({ key: null })), { unattached: 'invalid-ref' }, 'a null key never matches, whatever keyFrom says');
  assert.deepEqual(buildViews([dep('/a', bad)]), [{ id: '/a', name: 'a', key: null, team: null, unattached: true, deployments: ['/a'], primary: '/a' }]);
  assert.equal(deploymentReason({ local: true, identityStatus: 'identity', attach: attach(bad), ref: 'git:not a repo' }, DESKTOP_TERMS),
    'This deployment\'s workspace reference (git:not a repo) isn\'t valid; fix oats-local.yaml.');
  assert.equal(deploymentReason({ local: true, identityStatus: 'identity', attach: attach(bad), ref: null }, DESKTOP_TERMS),
    'This deployment\'s workspace reference isn\'t valid; fix oats-local.yaml.');
});

test('standalone:false, teamsFrom "local", null default team: unknown, never matched, "run oats sync there"', () => {
  for (const defaultTeam of [null, { label: 'default', team: null }]) {
    const unknown = identity({ teamsFrom: 'local', defaultTeam });
    assert.deepEqual(attach(unknown), { unattached: 'unknown-team' });
    const views = buildViews([dep('/a', unknown), dep('/b', identity({ teamsFrom: 'local', defaultTeam, standalone: true }))]);
    assert.equal(views.find(v => v.deployments.includes('/a')).unattached, true);
    assert.equal(deploymentReason({ local: true, identityStatus: 'identity', attach: attach(unknown) }, DESKTOP_TERMS),
      'This host hasn\'t observed its workspace yet; run oats sync there.');
  }
  // A non-null default team (a locally mapped team) matches normally.
  assert.deepEqual(attach(identity({ teamsFrom: 'local' })), { key: KEY, team: 'aweb:oats', unmapped: false });
  assert.equal(buildViews([dep('/a', identity({ teamsFrom: 'local' })), dep('/b', identity())]).length, 1);
});

test('standalone:true, teamsFrom "local", null team: attached as unmapped, matches only unmapped, with the standalone note', () => {
  const standalone = identity({ standalone: true, teamsFrom: 'local', defaultTeam: null, teams: {} });
  assert.deepEqual(attach(standalone), { key: KEY, team: null, unmapped: true, note: 'standalone' });
  const views = buildViews([dep('/a', standalone), dep('remote:devbox:a1', identity({ defaultTeam: { label: 'default', team: null } })),
    dep('/c', identity())]);
  assert.deepEqual(views.map(v => v.deployments), [['/a', 'remote:devbox:a1'], ['/c']], 'unmapped joins unmapped, never the mapped team');
  assert.equal(deploymentReason({ local: true, attach: { unattached: 'standalone' } }, DESKTOP_TERMS), 'Teams are local only on this host (standalone).');
});

test('teamsFrom observed or cache, null team: unmapped matches only unmapped (never a mapped team)', () => {
  for (const teamsFrom of ['observed', 'cache']) {
    const unmapped = identity({ teamsFrom, defaultTeam: { label: 'default', team: null }, teams: { default: null } });
    assert.deepEqual(attach(unmapped), { key: KEY, team: null, unmapped: true });
    const views = buildViews([dep('/a', unmapped), dep('/b', identity({ teamsFrom })), dep('/c', identity({ teamsFrom: 'cache', defaultTeam: null }))]);
    assert.deepEqual(views.map(v => [v.team, v.deployments]), [[null, ['/a', '/c']], ['aweb:oats', ['/b']]]);
  }
});

test('an old host (no key field) and no report at all: unattached', () => {
  assert.deepEqual(readIdentity({ reachable: true }), { status: 'old' });
  assert.deepEqual(readIdentity({ reachable: false, code: 'E_X', message: 'm' }), { status: 'old' });
  for (const none of [null, undefined, 'x', 3, []]) assert.deepEqual(readIdentity(none), { status: 'none' });
  assert.deepEqual(attachment(null), { unattached: 'no-report' });
  assert.deepEqual(buildViews([dep('remote:old:1', { reachable: true }), dep('remote:none:1', null)]).map(v => [v.id, v.unattached]),
    [['remote:old:1', true], ['remote:none:1', true]]);
  assert.deepEqual(buildViews([{ id: '/x', local: true, name: 'x' }]).map(v => v.id), ['/x'], 'no attachment at all is unattached');
});

test('Alex\'s two local deployments of one workspace: one view, two deployments, primary the first local', () => {
  const views = buildViews([dep('remote:devbox:a1', identity()), dep('/Users/alex/Agents/oats', identity()),
    dep('/Users/alex/example/oats-qa', identity())]);
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].deployments, ['remote:devbox:a1', '/Users/alex/Agents/oats', '/Users/alex/example/oats-qa']);
  assert.equal(views[0].primary, '/Users/alex/Agents/oats', 'the first LOCAL deployment, even after a remote one');
  assert.equal(views[0].name, 'oats', 'the name is the first local deployment\'s');
  assert.equal(buildViews([dep('remote:devbox:a1', identity())])[0].primary, 'remote:devbox:a1', 'with no local, the first');
  assert.equal(buildViews([dep('remote:devbox:a1', identity())])[0].name, 'oats', 'a remote-only view is named by its key\'s last segment');
});

test('the same key with another team is another workspace: two views, names say which team', () => {
  const views = buildViews([dep('/a', identity()), dep('/b', identity({ defaultTeam: { label: 'ops', team: 'aweb:ops' } }))]);
  assert.deepEqual(views.map(v => [v.name, v.team]), [['a · default', 'aweb:oats'], ['b · ops', 'aweb:ops']]);
  assert.notEqual(views[0].id, views[1].id);
  // Equal labels: the team id says which.
  const same = buildViews([dep('/a', identity()), dep('/b', identity({ defaultTeam: { label: 'default', team: 'aweb:other' } }))]);
  assert.deepEqual(same.map(v => v.name), ['a · aweb:oats', 'b · aweb:other']);
  // The unmapped one is "unmapped".
  const unmapped = buildViews([dep('/a', identity()), dep('/b', identity({ defaultTeam: { label: 'default', team: null } }))]);
  assert.deepEqual(unmapped.map(v => v.name), ['a · aweb:oats', 'b · unmapped'], 'both labels are "default": the mapped one says its id');
  const otherLabel = buildViews([dep('/a', identity()), dep('/b', identity({ defaultTeam: { label: 'scratch', team: null } }))]);
  assert.deepEqual(otherLabel.map(v => v.name), ['a · default', 'b · unmapped']);
  // Different keys never get a suffix.
  assert.deepEqual(buildViews([dep('/a', identity()), dep('/b', identity({ key: 'github.com/x/y' }))]).map(v => v.name), ['a', 'b']);
});

test('ref is never compared: the same key under different refs is one view', () => {
  const views = buildViews([dep('/a', identity({ ref: 'git:github.com/awebai/oats' })), dep('/b', identity({ ref: 'git@github.com:awebai/oats.git' })),
    dep('remote:devbox:a1', identity({ ref: 'https://github.com/awebai/oats.git' }))]);
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].deployments, ['/a', '/b', 'remote:devbox:a1']);
});

test('view ids: ws: + hex, stable, never a deployment id; an unattached view keeps its deployment id', () => {
  assert.match(viewId(KEY, 'aweb:oats'), WS);
  assert.equal(viewId(KEY, 'aweb:oats'), viewId(KEY, 'aweb:oats'));
  assert.notEqual(viewId(KEY, 'aweb:oats'), viewId(KEY, null));
  assert.notEqual(viewId(KEY, null), viewId(KEY, 'null'));
  const input = [dep('/Users/alex/Agents/oats', identity()), dep('remote:devbox:a1', identity({ key: 'github.com/x/web' })), dep('/loose', null)];
  const views = buildViews(input);
  assert.deepEqual(buildViews(input), views, 'the same deployments give the same views');
  const deploymentIds = new Set(input.map(d => d.id));
  for (const v of views.filter(v => !v.unattached)) { assert.match(v.id, WS); assert.ok(!deploymentIds.has(v.id)); }
  assert.deepEqual(views.filter(v => v.unattached).map(v => [v.id, v.deployments, v.primary]), [['/loose', ['/loose'], '/loose']]);
  assert.deepEqual(views.map(v => v.unattached), [false, false, true], 'attached views first, then the unattached ones');
});

test('readIdentity copies a valid identity and rejects every malformed shape as invalid', () => {
  const source = identity();
  const read = readIdentity({ reachable: true, ...source });
  assert.equal(read.status, 'identity');
  assert.deepEqual(read.identity, source, 'reachability fields are not part of the identity');
  source.teams.default = 'changed'; source.defaultTeam.team = 'changed';
  assert.equal(read.identity.teams.default, 'aweb:oats', 'a copy, not the reported object');
  assert.equal(read.identity.defaultTeam.team, 'aweb:oats');
  assert.deepEqual(readIdentity({ key: KEY, keyFrom: 'workspace', standalone: false, teamsFrom: 'cache' }).identity,
    { key: KEY, ref: null, keyFrom: 'workspace', standalone: false, teamsFrom: 'cache', defaultTeam: null, teams: {} }, 'absent optional fields read as null / {}');
  const malformed = [
    { key: '' }, { key: 3 }, { key: 'a\0b' }, { key: 'x'.repeat(2049) }, { ref: 7 }, { ref: '' },
    { keyFrom: 'bogus' }, { standalone: 'false' }, { standalone: undefined }, { teamsFrom: 'remote' }, { teamsFrom: undefined },
    { defaultTeam: 'default' }, { defaultTeam: { team: 'aweb:oats' } }, { defaultTeam: { label: '', team: null } }, { defaultTeam: { label: 'd', team: 4 } },
    { teams: [] }, { teams: null }, { teams: { default: 5 } }, { teams: { default: '' } },
    { teams: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`t${i}`, null])) },
  ];
  for (const over of malformed) assert.deepEqual(readIdentity(identity(over)), { status: 'invalid' }, JSON.stringify(over).slice(0, 80));
  assert.equal(readIdentity(identity({ teams: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`t${i}`, null])) })).status, 'identity');
});

const remoteReason = (over = {}) => deploymentReason({ local: false, machine: 'devbox', sshHost: 'devbox.lan', probe: { ok: true },
  identityStatus: 'identity', attach: attach(identity()), cliReadsRemotes: true, ...over }, DESKTOP_TERMS);

test('reasons: one plain sentence per case, null for a live matched deployment', () => {
  assert.equal(remoteReason(), null);
  assert.equal(deploymentReason({ local: true, identityStatus: 'identity', attach: attach(identity()) }, DESKTOP_TERMS), null);
  assert.equal(remoteReason({ probe: { ok: false, error: { code: 'E_SSH', message: 'ssh to devbox.lan failed: Permission denied (publickey)' } } }),
    'devbox needs ssh to connect without a prompt; run `ssh devbox.lan` once in a terminal.');
  assert.equal(remoteReason({ sshHost: undefined, probe: { ok: false, error: { code: 'E_SSH', message: 'refused' } } }),
    'devbox needs ssh to connect without a prompt; run `ssh devbox` once in a terminal.', 'without an ssh host, the machine');
  for (const error of [{ code: 'E_SSH', message: 'ssh to devbox.lan failed: Connection timed out' }, { code: 'E_SSH', message: 'ssh to devbox.lan timed out: no answer within 20 s' },
    { code: 'E_CLI_TIMEOUT', message: 'x' }, { code: 'E_SSH', message: 'Operation timeout' }]) {
    assert.equal(remoteReason({ probe: { ok: false, error } }), 'devbox timed out; it is tried again on the next read.', error.code);
  }
  assert.equal(remoteReason({ probe: { ok: false, error: { code: 'E_REMOTE_INCOMPATIBLE', message: 'm' } } }), 'devbox was not reached (E_REMOTE_INCOMPATIBLE).');
  assert.equal(remoteReason({ probe: { ok: false } }), 'devbox was not reached.');
  assert.equal(remoteReason({ rosterError: 'no roster answer' }), 'devbox was not reached: no roster answer');
  assert.equal(remoteReason({ identityStatus: 'old', attach: attachment(null) }), 'devbox\'s OATS is too old to report its workspace; update OATS there.');
  assert.equal(remoteReason({ identityStatus: 'none', attach: attachment(null) }), 'devbox reports no workspace for this deployment.');
  assert.equal(remoteReason({ attach: attach(identity({ keyFrom: 'member' })) }),
    'This deployment\'s workspace reference names a member whose workspace isn\'t known yet; run oats sync there.');
  assert.equal(remoteReason({ attach: attach(identity({ key: null })), ref: 'git:bad' }),
    'This deployment\'s workspace reference (git:bad) isn\'t valid; fix oats-local.yaml.');
  assert.equal(remoteReason({ attach: attach(identity({ teamsFrom: 'local', defaultTeam: null })) }),
    'This host hasn\'t observed its workspace yet; run oats sync there.');
  assert.equal(deploymentReason({ local: false, attach: { unattached: 'standalone' } }, DESKTOP_TERMS), 'Teams are local only on this host (standalone).');
  assert.equal(remoteReason({ cliReadsRemotes: false, probe: { ok: false, error: { code: 'E_SSH' } } }),
    'This computer\'s OATS can\'t read other machines; update OATS here.', 'the local CLI comes first');
  assert.equal(remoteReason({ identityStatus: 'feature', attach: attachment(null) }),
    'This computer\'s OATS is too old to read other machines\' workspaces; update OATS here.');
  assert.equal(deploymentReason({ local: true, identityStatus: 'feature', attach: attachment(null) }, DESKTOP_TERMS),
    'This computer\'s OATS is too old to report its workspace; update OATS here.');
  assert.equal(deploymentReason({ local: true, unavailable: 'E_CLI_FAILED: boom', identityStatus: 'none', attach: attachment(null) }, DESKTOP_TERMS), 'E_CLI_FAILED: boom');
  for (const identityStatus of ['old', 'none']) {
    assert.equal(deploymentReason({ local: true, identityStatus, attach: attachment(null) }, DESKTOP_TERMS), 'This deployment reports no workspace identity.', identityStatus);
  }
  assert.equal(deploymentReason({ local: true, identityStatus: 'invalid', attach: attachment(null) }, DESKTOP_TERMS), "This Mac reported a workspace this Desktop can't read.");
  assert.equal(remoteReason({ identityStatus: 'invalid', attach: attachment(null) }), 'devbox reported a workspace this Desktop can\'t read.');
});

test('reason parts: a short label for headings and the switcher, the full sentence, and the fix as plain steps (UI spec)', () => {
  const ssh = deploymentReasonParts({ local: false, machine: 'devbox', sshHost: 'devbox.lan', probe: { ok: false, error: { code: 'E_SSH', message: 'Host key verification failed.' } } }, DESKTOP_TERMS);
  assert.deepEqual(ssh, { short: 'ssh needs a prompt', detail: 'devbox needs ssh to connect without a prompt; run `ssh devbox.lan` once in a terminal.',
    fix: ['Run `ssh devbox.lan` once in a terminal and answer its prompt (a host key or a password).', 'Desktop tries again on its next read.'] });
  assert.deepEqual(deploymentReasonParts({ local: false, machine: 'build', probe: { ok: true }, identityStatus: 'old' }, DESKTOP_TERMS),
    { short: 'OATS too old to report its workspace', detail: 'build\'s OATS is too old to report its workspace; update OATS there.', fix: ['Update OATS on build.'] });
  assert.deepEqual(deploymentReasonParts({ local: false, machine: 'laptop', probe: { ok: false, error: { code: 'E_SSH', message: 'Connection timed out' } } }, DESKTOP_TERMS).fix, [], 'a timeout has no step: its sentence says what happens next');
  assert.deepEqual(deploymentReasonParts({ local: true, attach: { unattached: 'member' } }, DESKTOP_TERMS).fix, ['Run `oats sync` in this deployment.']);
  assert.deepEqual(deploymentReasonParts({ local: false, machine: 'devbox', probe: { ok: true }, identityStatus: 'identity', attach: { unattached: 'unknown-team' } }, DESKTOP_TERMS).fix, ['Run `oats sync` on devbox.']);
  assert.equal(deploymentReasonParts({ local: true, identityStatus: 'identity', attach: { key: 'k', team: 't' } }, DESKTOP_TERMS), null);
  // The steps carry every fact the sentence has (a heading with steps shows only them): the invalid reference.
  assert.deepEqual(deploymentReasonParts({ local: true, attach: { unattached: 'invalid-ref' }, ref: 'git:x' }, DESKTOP_TERMS).fix, ['Fix the workspace reference (`git:x`) in its oats-local.yaml.']);
  assert.deepEqual(deploymentReasonParts({ local: true, attach: { unattached: 'invalid-ref' }, ref: null }, DESKTOP_TERMS).fix, ['Fix the workspace reference in its oats-local.yaml.']);
  // A failed re-read of this computer's deployment (the last observation kept): the kernel's message, first.
  assert.deepEqual(deploymentReasonParts({ local: true, identityStatus: 'identity', attach: { key: 'k', team: 't' }, readError: 'the cache is locked' }, DESKTOP_TERMS),
    { short: 'Last read failed', headline: 'This deployment\'s last read failed: the cache is locked. It shows what was last observed.', lead: null, sentence: null,
      detail: 'This deployment\'s last read failed: the cache is locked. It shows what was last observed.', fix: [] });
  // Every reason the sentence form gives has a short label (never a heading without words).
  for (const d of [{ local: true, unavailable: 'Reading…' }, { local: true, identityStatus: 'feature' }, { local: false, cliReadsRemotes: false },
    { local: false, rosterError: 'boom' }, { local: false, probe: { ok: false, error: { code: 'E_X' } } }, { local: true, identityStatus: 'invalid' },
    { local: true, attach: { unattached: 'invalid-ref' }, ref: 'git:x' }, { local: true, attach: { unattached: 'standalone' } }, { local: true, readError: 'boom' }]) {
    const parts = deploymentReasonParts(d, DESKTOP_TERMS);
    assert.ok(parts.short && parts.detail && Array.isArray(parts.fix), JSON.stringify(d));
    assert.equal(deploymentReason(d, DESKTOP_TERMS), parts.detail);
  }
});

/* ── #982: a kept failure's reason sets the kernel's words apart, and its message is one display line in every form ── */
test("a kept failure's reason: the kernel's words after the client's sentence and the speaker's lead, a message with no speaker inside the sentence as before", () => {
  const OWN = "This deployment's last read failed. It shows what was last observed.";
  const parts = (readError, readErrorOrigin) => deploymentReasonParts({ local: true, identityStatus: 'identity', attach: { key: 'k', team: 't' }, readError, ...(readErrorOrigin === undefined ? {} : { readErrorOrigin }) }, DESKTOP_TERMS);
  const hostile = ['wipe \x1b[2J the screen', 'bell\u0007', 'token: abc123', 'https://user:pw@example.invalid/x'], nothing = ['', '   ', ' \n\t '];
  // The six forms.
  assert.deepEqual(parts('the cache is locked', 'kernel'), { short: 'Last read failed', headline: OWN, lead: 'OATS says:', sentence: 'the cache is locked',
    detail: `${OWN} OATS says: the cache is locked`, fix: [] });
  for (const message of hostile) assert.deepEqual(parts(message, 'kernel'), { short: 'Last read failed', headline: OWN, lead: null, sentence: '[withheld]', detail: `${OWN} [withheld]`, fix: [] }, JSON.stringify(message));
  for (const message of nothing) assert.deepEqual(parts(message, 'kernel'), { short: 'Last read failed', headline: OWN, lead: null, sentence: null, detail: OWN, fix: [] }, JSON.stringify(message));
  const inside = line => `This deployment's last read failed: ${line}. It shows what was last observed.`;
  assert.deepEqual(parts('the cache is locked'), { short: 'Last read failed', headline: inside('the cache is locked'), lead: null, sentence: null, detail: inside('the cache is locked'), fix: [] });
  for (const message of hostile) assert.deepEqual(parts(message), { short: 'Last read failed', headline: inside('[withheld]'), lead: null, sentence: null, detail: inside('[withheld]'), fix: [] }, JSON.stringify(message));
  for (const message of nothing) assert.deepEqual(parts(message), { short: 'Last read failed', headline: OWN, lead: null, sentence: null, detail: OWN, fix: [] }, JSON.stringify(message));
  // The detail is the parts that are there, joined by one space, in every form; and the one-line reason is the detail.
  for (const origin of ['kernel', undefined]) for (const message of ['the cache is locked', ...hostile, ...nothing]) {
    const p = parts(message, origin);
    assert.equal(p.detail, [p.headline, p.lead, p.sentence].filter(part => part !== null).join(' '), `${origin}: ${JSON.stringify(message)}`);
    assert.equal(deploymentReason({ local: true, readError: message, readErrorOrigin: origin }, DESKTOP_TERMS), p.detail);
    assert.doesNotMatch(p.detail, /[\u0000-\u001f\u007f]/, 'no control character of the message is in the reason');
  }
  // A message is one line: line breaks fold, and a long one is cut by the filter, whoever made it.
  assert.equal(parts('first\nsecond\tthird', 'kernel').sentence, 'first second third');
  assert.equal(parts('first\nsecond', undefined).detail, inside('first second'));
  // Only the one value names the kernel: anything else is a message with no speaker, never under "OATS says:".
  for (const origin of [null, '', 'Kernel', 'terminal-probe', 'roster-read', true, 1, {}, ['kernel'], '__proto__']) {
    assert.equal(parts('the cache is locked', origin).detail, inside('the cache is locked'), JSON.stringify(origin));
  }
  // A message that carries a speaker's words is still only a message.
  assert.equal(parts('OATS says: all is well').detail, inside('OATS says: all is well'));
  // That a failure is kept does not depend on its text: a string, whatever it holds. No string, no kept failure.
  for (const none of [undefined, null, 0, false, {}, ['x']]) assert.equal(parts(none, 'kernel'), null, JSON.stringify(none));
  // The lead is the shared home's for any client: it names OATS, not the client.
  const TUI = clientTerms({ name: 'oats tui', self: 'oats tui', selfInitial: 'oats tui', update: 'OATS', thisMachine: 'This machine' });
  assert.deepEqual(deploymentReasonParts({ local: true, readError: 'the cache is locked', readErrorOrigin: 'kernel' }, TUI), parts('the cache is locked', 'kernel'));
});
