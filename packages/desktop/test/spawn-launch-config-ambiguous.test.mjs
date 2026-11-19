// E_LAUNCH_CONFIG_AMBIGUOUS (OATS 0.52.0, awebai/oats#917): the harness has several launch configurations
// here, none is the default, and the spawn names none. The refusal is hand-written from the documented
// shape at kernel head 881ecc1f (lib/launch-preference.mjs `launchConfigAmbiguous`, docs/desktop-cli-api.md):
// code, message ending with its command-line fix, details {harness, configurations, fix}. No kernel execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnProblem } from '../../client/spawn-messages.mjs';
import { spawnText } from '../renderer/spawn-words.mjs';
import { previewFailure } from '../../client/spawn-preview-contract.mjs';
import { spawnApplyReason, spawnApplyFailure, spawnApplyView } from '../../client/spawn-apply-contract.mjs';
import { NO_DEFAULT_CONFIG } from '../renderer/spawn-dialog.mjs';

const CODE = 'E_LAUNCH_CONFIG_AMBIGUOUS';
const FIX = 'name one with --launch-config <name> (or souls.launch in oats-local.yaml), or mark one default: true (oats launch-config set)';
const MESSAGE = `oats-local.yaml declares 2 claude launch configurations (personal, work) and none is default: true, and this launch names none; ${FIX}`;
const refusal = () => ({ schemaVersion: 1, ok: false, error: { code: CODE, message: MESSAGE, details: { harness: 'claude', configurations: ['personal', 'work'], fix: FIX } } });
const SENTENCE = 'This machine has more than one launch configuration for this soul’s harness, and none is the default. Choose one under Launch configuration in Advanced.';
const FIXED = 'More than one launch configuration is declared for this harness and none is the default.';
const configs = body => ({ selected: body.selector, configurations: [{ name: 'personal', harness: 'claude' }, { name: 'work', harness: 'claude' }] });

test('the sentence names the dialog\'s own control, at both stages; the kernel\'s message stays in Details', () => {
  for (const stage of ['preview', 'spawn']) {
    const problem = spawnProblem({ code: CODE, message: MESSAGE, fix: FIX }, stage);
    assert.equal(spawnText(problem, stage), SENTENCE); assert.equal(problem.code, CODE);
    assert.equal(problem.detail, `${CODE} · ${MESSAGE}`);
    assert.doesNotMatch(spawnText(problem, stage), /--launch-config|oats-local\.yaml|personal|work\b|couldn’t work out/);
  }
});
test('the code keeps its place where the kernel\'s message cannot travel', () => {
  // A preview refusal keeps the kernel's message and fix.
  assert.deepEqual(previewFailure(CODE, null, MESSAGE, FIX).reason, { code: CODE, message: MESSAGE, fix: FIX });
  // A message over the bound (many configuration names) keeps the code, with the fixed message.
  assert.deepEqual(previewFailure(CODE, null, `${MESSAGE} ${'x'.repeat(2048)}`, FIX).reason, { code: CODE, message: FIXED });
  assert.deepEqual(previewFailure(CODE).reason, { code: CODE, message: FIXED });
  // The apply's reason carries no kernel message: the code survives it, here and when the view is read again.
  assert.deepEqual(spawnApplyReason(CODE, MESSAGE), { code: CODE, message: FIXED });
  const view = spawnApplyFailure(CODE, { status: 'unavailable' });
  assert.deepEqual(spawnApplyView(JSON.parse(JSON.stringify(view))).reason, { code: CODE, message: FIXED });
  assert.equal(spawnText(spawnProblem(spawnApplyView(view).reason, 'spawn'), 'spawn'), SENTENCE);
});

/** The preview answers the refusal while no configuration is named on the harness `ambiguousOn` resolves to. */
const kernelFor = (host, ambiguous = choices => !choices.launchConfig && (choices.harness ?? 'claude') === 'claude') =>
  (_cli, { target, choices }) => ambiguous(choices) ? refusal() : host.kernel(host.kernelPreviewName(target.selector.soul, choices));

test('Spawn dialog: the refusal reads as the sentence; the first entry reads "No default: choose one"; Spawn is disabled while it stands', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  const u = await host.mountSpawn(t, { configs, kernel: kernelFor(host) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  assert.equal(u.text('.fstatus'), SENTENCE); assert.equal(u.q('.fstatus').dataset.code, CODE);
  assert.equal(u.text('.spawn-problem-detail'), `${CODE} · ${MESSAGE}`);
  assert.equal(u.text('.spawn-preview-failure'), SENTENCE);
  assert.doesNotMatch(u.dialog().textContent, /couldn’t work out this soul’s defaults/);
  const select = u.q('.flaunch');
  assert.deepEqual([...select.options].map(o => o.textContent), [NO_DEFAULT_CONFIG, 'personal · Claude Code', 'work · Claude Code']);
  assert.equal(NO_DEFAULT_CONFIG, 'No default: choose one');
  // The entry stays the selected one, and selectable: it is the state the dialog is in.
  assert.equal(select.value, ''); assert.equal(select.options[0].disabled, false);
  assert.equal(u.q('.fspawn').disabled, true);
  u.q('.fspawn').click(); await host.settle();
  assert.deepEqual(u.spawns(), []);
  // No new choice: neither the bare harness nor "make default" is offered here.
  assert.equal([...select.options].some(o => /none|bare/i.test(o.value)), false);
});
test('Spawn dialog: picking a configuration brings "Default" back, reads the preview again and enables Spawn; another harness reads "Default" too', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  const u = await host.mountSpawn(t, { configs, kernel: kernelFor(host) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  const select = u.q('.flaunch'), first = () => select.options[0].textContent;
  assert.equal(first(), NO_DEFAULT_CONFIG);
  const before = u.previews().length;
  await u.change('.flaunch', 'work');
  assert.equal(u.previews().at(-1).choices.launchConfig, 'work'); assert.ok(u.previews().length > before);
  assert.match(first(), /^Default/); assert.doesNotMatch(first(), /No default/);
  assert.equal(u.text('.fstatus'), 'Preview ready'); assert.equal(u.q('.fspawn').disabled, false);
  // Back to no configuration: the refusal stands again.
  await u.change('.flaunch', '');
  assert.equal(first(), NO_DEFAULT_CONFIG); assert.equal(u.q('.fspawn').disabled, true); assert.equal(u.text('.fstatus'), SENTENCE);
  // Another harness has no such ambiguity: the entry reads Default as soon as the choices are no longer the refused ones.
  await u.change('.fruntime', 'pi');
  assert.match(first(), /^Default/); assert.equal(u.q('.fspawn').disabled, false);
  assert.doesNotMatch(u.text('.fstatus'), /more than one launch configuration/);
});
test('Spawn dialog: the label follows the answer for the choices on screen, not a refusal of other choices', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  const gate = host.deferred(); let hold = false;
  const u = await host.mountSpawn(t, { configs, kernel: kernelFor(host), previewGate: () => hold ? gate.promise : undefined });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  assert.equal(u.q('.flaunch').options[0].textContent, NO_DEFAULT_CONFIG);
  hold = true; await u.change('.flaunch', 'work'); // its preview is still in the air
  assert.doesNotMatch(u.q('.flaunch').options[0].textContent, /No default/);
  gate.resolve(); await host.settle(20);
  assert.match(u.q('.flaunch').options[0].textContent, /^Default/);
});

test('at Spawn: the file changed since the preview, prepare\'s own read is refused: the same sentence, and nothing was applied', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  let changed = false;
  const u = await host.mountSpawn(t, { configs, kernel: kernelFor(host, () => changed) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  assert.equal(u.text('.fstatus'), 'Preview ready');
  changed = true; // a second configuration was declared after the preview on screen was read
  await u.spawn();
  assert.equal(u.text('.fstatus'), SENTENCE); assert.equal(u.q('.fstatus').dataset.code, CODE);
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare']);
  assert.equal(u.applied.length, 0);
});
test('at Spawn, in the background: the notice says the sentence and that nothing was created', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  let changed = false;
  const u = await host.mountSpawn(t, { jobs: true, configs, kernel: kernelFor(host, () => changed) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  changed = true;
  u.q('.fspawn').click(); await host.settle(30);
  const note = u.notices.find(n => /launch configuration/.test(n.message));
  assert.ok(note, JSON.stringify(u.notices.map(n => n.message)));
  assert.equal(note.message, `${SENTENCE} Nothing was created.`);
  assert.equal(u.applied.length, 0);
});
test('at Spawn: a refusal from the apply\'s own CLI call is an unknown outcome, as every kernel refusal there is (the broker\'s rule)', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  // What cliSpawnApply hands the broker for this refusal: dispatched, the code kept, the fixed message.
  const u = await host.mountSpawn(t, { configs: b => ({ selected: b.selector, configurations: [] }),
    apply: () => ({ started: true, envelope: { schemaVersion: 1, ok: false, error: spawnApplyReason(CODE, MESSAGE) } }) });
  await u.open(); await u.type('.fpurpose', 'api-v2'); await u.spawn();
  assert.equal(u.q('.fstatus').dataset.code, 'E_OUTCOME_UNKNOWN');
  assert.equal(u.text('.fstatus'), 'We couldn’t confirm whether the instance was created. Use Check result before spawning again.');
  assert.doesNotMatch(u.text('.fstatus'), /launch configuration/);
  assert.equal(u.q('.fspawn').textContent, 'Check result');
});

test('a spawn routed to a server shows the host\'s refusal as any host refusal, never the dialog\'s sentence', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  const facts = { server: 'build', label: 'Build host', group: 'build:1', reached: true, error: null, registered: true };
  // The server route answers a host refusal with its message (cut at 300 characters) and its code.
  const sent = MESSAGE.slice(0, 300);
  const u = await host.mountSpawn(t, { servers: [{ id: 'build', label: 'Build host', sshHost: 'build.lan' }], teamMembers: { members: [], notReached: [], servers: [facts] },
    remote: () => { throw Object.assign(new Error(sent), { code: CODE }); } });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  await u.change('.fserver', 'build');
  // No preview is read here for a routed spawn, and no configuration is listed.
  assert.equal(u.q('.flaunch').options[0].textContent, 'Default');
  await u.spawn();
  assert.equal(u.text('.fstatus'), `Couldn’t spawn on build: ${sent}`);
  assert.doesNotMatch(u.text('.fstatus'), /Choose one under Launch configuration/);
  assert.equal(u.q('.fstatus').dataset.code, CODE);
  assert.equal(u.text('.spawn-problem-detail'), `${CODE} · ${sent}`);
  assert.equal(u.q('.flaunch').options[0].textContent, 'Default');
});
