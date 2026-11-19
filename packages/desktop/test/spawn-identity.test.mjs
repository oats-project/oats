// Messaging identity (decision 27) in the spawn dialog: the choice travels as
// `--provider <cap> identity.mode=… identity.resident=…` to the soul's
// messaging provider, gated on spawn-provider-payload, bound by the decision.
// Kernel captures: test/fixtures/workspace-v2/f3c (repo kernel against
// Northwind + one stand-in messaging package whose settings.identity is
// oats.aweb's, byte for byte — provenance.json `standIn`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { previewChoices, previewData, choiceArgv } from '../../client/spawn-preview-contract.mjs';
import { spawnApplyChoicesSupported } from '../../client/spawn-apply-contract.mjs';
import { createSpawnPreviewBoundary, createSpawnPreviewFlights } from '../../client/spawn-preview.mjs';
import { cliSpawnPreview } from '../../client/spawn-preview-cli.mjs';
import { mountSpawn, settle, ROOT } from './helpers/spawn-dialog-host.mjs';
import { cli as CLI, target, context, request } from './helpers/spawn-preview-fixture.mjs';

const f3c = name => JSON.parse(readFileSync(new URL(`./fixtures/workspace-v2/f3c/${name}.json`, import.meta.url), 'utf8'));
const provenance = f3c('provenance');
const GLOBAL = { provider: 'nw.messaging', mode: 'global', resident: 'ops' };
const previewFor = choices => choices.identity?.mode === 'global' ? 'preview-messaging-global' : choices.identity?.mode === 'local' ? 'preview-messaging-local' : 'preview-messaging-default';
const withoutPayload = () => ({ ...structuredClone(CLI), features: CLI.features.filter(f => f !== 'spawn-provider-payload') });

test('the stand-in copies oats.aweb\'s settings.identity byte for byte, on layer messaging, with no executables', () => {
  const real = JSON.parse(readFileSync(new URL('../../../mirrors/oats-aweb/oats.json', import.meta.url), 'utf8'));
  const { standIn } = provenance;
  assert.equal(real.layer, 'messaging');
  assert.equal(JSON.stringify(standIn.declaration), JSON.stringify(real.settings.identity));
  assert.equal(JSON.stringify(standIn.manifest.settings.identity), JSON.stringify(real.settings.identity));
  assert.equal(standIn.manifest.layer, 'messaging');
  for (const key of ['commands', 'hooks', 'command', 'binding']) assert.equal(Object.hasOwn(standIn.manifest, key), false, key);
  assert.equal(standIn.manifestSha256, createHash('sha256').update(JSON.stringify(standIn.manifest, null, 2) + '\n').digest('hex'));
  for (const [name, entry] of Object.entries(provenance.files)) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(`./fixtures/workspace-v2/f3c/${name}.json`, import.meta.url))).digest('hex'), entry.fixtureSha256, name);
    assert.equal(entry.kernel, provenance.kernel);
  }
});

test('identity choices: local, or global with a resident; anything else is refused', () => {
  assert.deepEqual(previewChoices({ identity: { provider: 'nw.messaging', mode: 'local' } }).identity, { provider: 'nw.messaging', mode: 'local' });
  assert.deepEqual(previewChoices({ identity: GLOBAL }).identity, GLOBAL);
  for (const bad of [{ provider: 'nw.messaging', mode: 'global' }, { provider: 'nw.messaging', mode: 'local', resident: 'ops' },
    { provider: '--dir', mode: 'local' }, { provider: 'nw.messaging', mode: 'team' }, { provider: 'nw.messaging', mode: 'global', resident: '-x' },
    { provider: 'nw.messaging', mode: 'global', resident: 'a b' }, { provider: 'nw.messaging', mode: 'local', scopes: ['mail.read'] }, 'local', null])
    assert.equal(previewChoices({ identity: bad }), null, JSON.stringify(bad));
});

test('the flags are the captured kernel argv: --provider <cap> identity.mode=…, then identity.resident=…', () => {
  for (const [name, identity] of [['preview-messaging-local', { provider: 'nw.messaging', mode: 'local' }], ['preview-messaging-global', GLOBAL], ['preview-messaging-default', undefined]]) {
    const captured = provenance.files[name].argv, from = captured.indexOf('--purpose'), to = captured.indexOf('--preview');
    assert.deepEqual(choiceArgv(previewChoices({ purpose: 'api-v2', ...(identity ? { identity } : {}) })), captured.slice(from, to), name);
  }
  const apply = provenance.files['apply-messaging-global'].argv;
  assert.deepEqual(choiceArgv(previewChoices({ purpose: 'api-v2', identity: GLOBAL })), apply.slice(apply.indexOf('--purpose'), apply.indexOf('--expect-decision')), 'preview and apply send the same choice');
});

const MANIFEST_DEFAULT = { kind: 'manifest-default', at: 'oats.json#/settings/identity/default' }, SPAWN = { kind: 'spawn', at: '--provider nw.messaging' };
test('the projection names the messaging provider, the identity the decision binds, and where its mode came from (settingsOrigins)', () => {
  const t = { ...target };
  assert.deepEqual(previewData(f3c('preview-messaging-default').result, t).messaging, { provider: 'nw.messaging', identity: { mode: 'local', resident: null }, origin: MANIFEST_DEFAULT, join: null, joinDeclared: false });
  assert.deepEqual(previewData(f3c('preview-messaging-local').result, t).messaging, { provider: 'nw.messaging', identity: { mode: 'local', resident: null }, origin: SPAWN, join: null, joinDeclared: false });
  assert.deepEqual(previewData(f3c('preview-messaging-global').result, t).messaging, { provider: 'nw.messaging', identity: { mode: 'global', resident: 'ops' }, origin: SPAWN, join: null, joinDeclared: false });
  // A kernel without settings-origins reports no origin (and, before manifest defaults, no identity).
  const older = f3c('preview-messaging-default').result; delete older.settingsOrigins;
  delete older.decision.effective.providers['nw.messaging'].identity; delete older.settings['nw.messaging'].identity;
  assert.deepEqual(previewData(older, t).messaging, { provider: 'nw.messaging', identity: null, origin: null, join: null, joinDeclared: false });
  for (const [label, mutate] of [['origins not a record', v => { v.settingsOrigins = 'soul'; }], ['cap origins not a record', v => { v.settingsOrigins['nw.messaging'] = []; }],
    ['origin without at', v => { v.settingsOrigins['nw.messaging']['/identity/mode'] = { kind: 'soul' }; }],
    ['origin extra key', v => { v.settingsOrigins['nw.messaging']['/identity/mode'] = { ...MANIFEST_DEFAULT, value: 'local' }; }],
    ['empty kind', v => { v.settingsOrigins['nw.messaging']['/identity/mode'] = { kind: '', at: 'x' }; }],
    ['control characters', v => { v.settingsOrigins['nw.messaging']['/identity/mode'] = { kind: 'soul', at: 'soul.yaml\n#' }; }]]) {
    const v = f3c('preview-messaging-default').result; mutate(v); assert.equal(previewData(v, t), null, label);
  }
  for (const name of ['preview-messaging-default', 'preview-messaging-global']) {
    const once = previewData(f3c(name).result, t);
    assert.deepEqual(previewData(once, t), once, `${name}: the renderer's re-validation of the server projection keeps it`);
  }
  assert.notEqual(f3c('preview-messaging-global').result.decision.revision, f3c('preview-messaging-default').result.decision.revision, 'the identity is part of the decision');
  // The preview's settings must agree with what the decision binds; two messaging modules are not one provider.
  const tampered = f3c('preview-messaging-global').result; tampered.settings['nw.messaging'].identity.resident = 'someone-else';
  assert.equal(previewData(tampered, t), null);
  const twice = f3c('preview-messaging-default').result; twice.modules.push({ ...twice.modules.find(m => m.layer === 'messaging'), name: 'nw.other' });
  assert.equal(previewData(twice, t), null);
});

test('the boundary sends identity only when the CLI advertises spawn-provider-payload', async () => {
  let argv;
  const read = createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: (c, args) => cliSpawnPreview(c, args, { exec: (_bin, a, _o, done) => { argv = a; done(null, JSON.stringify(f3c('preview-messaging-global'))); } }) });
  const ok = await read(request({ purpose: 'api-v2', identity: GLOBAL }), context);
  assert.equal(ok.status, 'available'); assert.deepEqual(ok.data.messaging.identity, { mode: 'global', resident: 'ops' });
  assert.deepEqual(argv.slice(argv.indexOf('--purpose'), argv.indexOf('--json')),
    ['--purpose', 'api-v2', '--provider', 'nw.messaging', 'identity.mode=global', '--provider', 'nw.messaging', 'identity.resident=ops']);
  const older = () => { const c = context(); c.cli = withoutPayload(); return c; };
  let calls = 0;
  const refused = await createSpawnPreviewBoundary({ flights: createSpawnPreviewFlights(), invoke: () => { calls++; } })(request({ purpose: 'api-v2', identity: GLOBAL }), older);
  assert.equal(refused.reason.code, 'E_UNSUPPORTED_OPTION'); assert.equal(calls, 0);
  assert.equal(spawnApplyChoicesSupported(withoutPayload(), previewChoices({ identity: GLOBAL })), false);
  assert.equal(spawnApplyChoicesSupported(CLI, previewChoices({ identity: GLOBAL })), true);
});

test('a provider the soul does not resolve is the kernel\'s refusal, said plainly', async t => {
  const u = await mountSpawn(t, { kernel: () => f3c('preview-provider-unknown') });
  await u.open(); await u.type('.fpurpose', 'api-v2'); await settle();
  assert.equal(u.q('.fstatus').dataset.code, 'E_CAPABILITY_MISSING'); assert.doesNotMatch(u.text('.fstatus'), /E_[A-Z]/);
  assert.equal(u.q('.fspawn').disabled, true);
});

async function dialog(t, options = {}) {
  const u = await mountSpawn(t, { kernel: (_c, { choices }) => f3c(previewFor(choices)), ...options });
  await u.open(); await u.type('.fpurpose', 'api-v2'); u.q('.spawn-advanced').open = true; await settle();
  return u;
}

// The captured probe from the same kernel advertises settings-origins; f3's older probe does not.
const ORIGINS_CLI = () => { assert.ok(f3c('version').features.includes('settings-origins')); return { ...structuredClone(CLI), features: [...CLI.features, 'settings-origins'] }; };
test('Advanced offers the identity once the preview reports a messaging provider; with settings-origins the Default names the manifest default', async t => {
  const u = await dialog(t, { cli: ORIGINS_CLI() });
  assert.equal(u.q('.spawn-identity').hidden, false);
  assert.equal(u.q('.fidentity').options[0].textContent, 'Default · local');
  assert.equal(u.text('.spawn-identity-hint'), "Messaging through nw.messaging: gets its own team identity. This is the provider's default (oats.json#/settings/identity/default).");
  assert.match(u.text('.spawn-advanced > summary small'), / · identity · /);
  assert.equal(u.q('.fresident').closest('label').hidden, true);
  assert.equal(Object.hasOwn(u.previews().at(-1).choices, 'identity'), false, 'the default sends nothing');
});

test('global needs a resident; the choice is previewed, bound and applied by value', async t => {
  const applied = [];
  const u = await dialog(t, { apply: args => { applied.push(args);
    return { started: true, envelope: f3c('apply-messaging-global') }; } });
  await u.change('.fidentity', 'global'); await settle();
  assert.equal(u.q('.fresident').closest('label').hidden, false);
  assert.equal(u.text('.spawn-identity-hint'), 'Type the resident this instance acts as.');
  assert.equal(u.q('.fspawn').disabled, true, 'global without a resident cannot spawn');
  assert.equal(u.previews().some(p => p.choices.identity?.mode === 'global'), false, 'nothing incomplete is previewed');
  await u.type('.fresident', 'ops'); await settle();
  assert.deepEqual(u.previews().at(-1).choices.identity, GLOBAL);
  assert.equal(u.text('.spawn-identity-hint'), 'Messaging through nw.messaging: acts as the resident ops through a session grant.');
  assert.equal(u.q('.fspawn').disabled, false);
  await u.spawn(); await settle();
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply']);
  assert.deepEqual(u.spawns()[0].choices.identity, GLOBAL);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].decision.revision, f3c('preview-messaging-global').result.decision.revision, 'bound to the decision that carries the identity');
  const captured = provenance.files['apply-messaging-global'].argv;
  assert.deepEqual(choiceArgv(applied[0].choices), captured.slice(captured.indexOf('--purpose'), captured.indexOf('--expect-decision')), 'the kernel argv the capture ran');
  assert.match(u.text('.fstatus'), /^Created release-manager-api-v2/);
  // What the kernel recorded in the new home.
  assert.deepEqual(f3c('apply-messaging-global-instance').providers['nw.messaging'].identity, { mode: 'global', resident: 'ops' });
});

test('without spawn-provider-payload the identity is never offered or sent', async t => {
  const u = await dialog(t, { cli: withoutPayload() });
  assert.equal(u.q('.spawn-identity').hidden, true);
  assert.doesNotMatch(u.text('.spawn-advanced > summary small'), /identity/);
  u.q('.fidentity').value = 'local'; u.q('.fidentity').dispatchEvent(new u.dom.window.Event('change', { bubbles: true })); await settle();
  assert.ok(u.previews().every(p => !Object.hasOwn(p.choices, 'identity')));
});

test('a soul without a messaging provider shows no identity field', async t => {
  const u = await mountSpawn(t); // the F3 Northwind captures: messaging: none
  await u.open(); await u.type('.fpurpose', 'api-v2'); u.q('.spawn-advanced').open = true; await settle();
  assert.equal(u.q('.spawn-identity').hidden, true);
  assert.equal(u.previews().at(-1).choices.identity, undefined);
  assert.equal(typeof ROOT, 'string');
});

test('without settings-origins the Default option asserts no mode, even when the payload carries one', async t => {
  const u = await dialog(t); assert.equal(CLI.features.includes('settings-origins'), false);
  assert.equal(u.q('.fidentity').options[0].textContent, 'Default');
  assert.equal(u.text('.spawn-identity-hint'), 'Messaging through nw.messaging: gets its own team identity.');
});
test('another origin is named as the kernel reports it; an unknown kind is shown as sent', async t => {
  for (const [kind, at, label, hint] of [['soul', 'soul.yaml#/messaging', 'Default · local — from the soul', 'Set by the soul (soul.yaml#/messaging).'],
    ['future-layer', 'somewhere.yaml#/x', 'Default · local — from future-layer', 'Set by future-layer (somewhere.yaml#/x).']]) {
    const variant = () => { const d = f3c('preview-messaging-default'); d.result.settingsOrigins['nw.messaging']['/identity/mode'] = { kind, at }; return d; };
    const u = await dialog(t, { cli: ORIGINS_CLI(), kernel: (_c, { choices }) => choices.identity ? f3c(previewFor(choices)) : variant() });
    assert.equal(u.q('.fidentity').options[0].textContent, label, kind);
    assert.equal(u.text('.spawn-identity-hint'), `Messaging through nw.messaging: gets its own team identity. ${hint}`, kind);
    u.close?.();
  }
});
test('no identity reported (a kernel before manifest defaults): plain Default, and the hint names no mode', async t => {
  const older = () => { const d = f3c('preview-messaging-default'), r = d.result; delete r.settingsOrigins['nw.messaging']['/identity/mode'];
    delete r.decision.effective.providers['nw.messaging'].identity; delete r.settings['nw.messaging'].identity; return d; };
  const u = await dialog(t, { cli: ORIGINS_CLI(), kernel: (_c, { choices }) => choices.identity ? f3c(previewFor(choices)) : older() });
  assert.equal(u.q('.fidentity').options[0].textContent, 'Default');
  assert.equal(u.text('.spawn-identity-hint'), "Messaging through nw.messaging: the provider's own default identity.");
});
test('a chosen identity leaves the Default option plain; a spawn-set origin adds nothing to the hint', async t => {
  const u = await dialog(t, { cli: ORIGINS_CLI() });
  await u.change('.fidentity', 'local'); await settle();
  assert.equal(u.q('.fidentity').options[0].textContent, 'Default');
  assert.equal(u.text('.spawn-identity-hint'), 'Messaging through nw.messaging: gets its own team identity.');
});
test('a bound global resident is shown from the bound identity, with or without settings-origins', async t => {
  const soulGlobal = () => { const d = f3c('preview-messaging-default'), r = d.result, identity = { mode: 'global', resident: 'ops' };
    r.decision.effective.providers['nw.messaging'].identity = identity; r.settings['nw.messaging'].identity = { ...identity };
    r.settingsOrigins['nw.messaging']['/identity/mode'] = { kind: 'soul', at: 'soul.yaml#/messaging' }; return d; };
  for (const [cli, label] of [[CLI, 'Default · global as ops'], [ORIGINS_CLI(), 'Default · global as ops — from the soul']]) {
    const u = await dialog(t, { cli, kernel: (_c, { choices }) => choices.identity ? f3c(previewFor(choices)) : soulGlobal() });
    assert.equal(u.q('.fidentity').options[0].textContent, label);
    assert.match(u.text('.spawn-identity-hint'), /^Messaging through nw\.messaging: acts as the resident ops through a session grant\./);
  }
});
test("the renderer re-validates the server's messaging projection exactly: origin is required and nothing else rides along", () => {
  const t = { ...target }, once = previewData(f3c('preview-messaging-default').result, t);
  const { origin, ...withoutOrigin } = once.messaging; assert.deepEqual(origin, MANIFEST_DEFAULT);
  assert.equal(previewData({ ...once, messaging: withoutOrigin }, t), null, 'origin missing');
  assert.equal(previewData({ ...once, messaging: { ...once.messaging, at: 'x' } }, t), null, 'extra key');
  assert.equal(previewData({ ...once, messaging: { ...once.messaging, origin: { kind: 'soul' } } }, t), null, 'malformed origin');
  assert.deepEqual(previewData({ ...once, messaging: { ...once.messaging, origin: null } }, t).messaging.origin, null, 'no origin reported');
});
