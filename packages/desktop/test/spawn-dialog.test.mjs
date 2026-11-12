// The spawn dialog on workspace model v2, mounted in the real Workspace view.
// Previews and applies go through the REAL preview boundary and apply broker,
// whose CLI calls return the kernel captures (test/fixtures/workspace-v2/f3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountSpawn, settle, deferred, kernel, checkoutSoul, catalogAgents, ROOT, DEPLOYMENT } from './helpers/spawn-dialog-host.mjs';
import { cli as CLI } from './helpers/spawn-preview-fixture.mjs';
import { creation } from './helpers/spawn-apply-fixture.mjs';
import { defaultSpawnChoices } from '../../client/spawn-preview-contract.mjs';
import * as spawn from '../renderer/views/spawn.mjs';

const last = u => u.previews().at(-1)?.choices;
const created = (name = 'preview-worktree-purpose') => kernel(name).result;
/** Put the created instance in the roster as the kernel would report it, then return its receipt. */
function applyThatRuns(u, preview = created()) {
  return () => {
    const d = preview.decision;
    u.setInstances([{ instance: d.instance, agent: 'release-manager', agentsRoot: ROOT, home: d.home, running: true, tmux: { session: 'oats', window: d.instance } }]);
    return { started: true, envelope: { schemaVersion: 1, ok: true, result: creation(preview) } };
  };
}

test('the session backend select offers tmux only: from the older-kernel f3 capture that lists herdr, and from a 0.31 CLI', async t => {
  for (const cli of [undefined, { ...structuredClone(CLI), sessionBackends: ['tmux'] }]) {
    const u = await mountSpawn(t, cli ? { cli } : {});
    await u.open(); u.q('.spawn-advanced').open = true;
    assert.deepEqual(CLI.sessionBackends, ['tmux', 'herdr'], 'the f3 capture is an older kernel');
    const select = u.q('.fbackend');
    assert.deepEqual([...select.options].map(o => o.value), ['', 'tmux']);
    assert.equal(select.options[0].textContent, 'Default · tmux');
    assert.doesNotMatch(u.q('.spawn-advanced').textContent, /herdr/i);
  }
});

test('defaultSpawnChoices (#855, 6b-2): what the dialog previews with no field touched, a fresh object each call', async t => {
  const u = await mountSpawn(t);
  await u.open();
  assert.ok(u.previews().length > 0, 'the dialog read a preview as it opened');
  assert.deepEqual(last(u), defaultSpawnChoices());
  const one = defaultSpawnChoices(), two = defaultSpawnChoices();
  assert.notEqual(one, two); one.model.kind = 'changed'; one.relation.kind = 'changed';
  assert.deepEqual(two, { model: { kind: 'inherit' }, relation: { kind: 'unrelated' } }, 'changing one changes no other');
});

test('the dialog shows what the kernel decided: name, harness, model and work — no toggles, placeholders or preview button', async t => {
  const u = await mountSpawn(t);
  const dialog = await u.open();
  const preview = created('preview-worktree-default');
  assert.equal(u.q('.spawn-name-result strong').textContent, preview.instance, 'the kernel names an instance with no purpose');
  assert.equal(u.q('.spawn-name-prefix').textContent, 'release-manager-', 'without spawn-name (the host\'s default) a typed name is a purpose');
  const trigger = u.q('.spawn-run .spawn-choice-trigger');
  assert.equal(trigger.querySelector('.runtime-badge').dataset.runtime, 'pi'); assert.equal(trigger.querySelector('.spawn-trigger-tag').textContent, 'default');
  assert.equal(trigger.getAttribute('aria-label'), 'Harness: Pi (default)');
  assert.equal(u.text('.spawn-model-default'), "Pi's default model"); assert.equal(u.text('.spawn-input-tag'), 'default');
  assert.equal(u.text('.spawn-run-hint'), 'Launches Pi with its own default model.');
  // Work lives in Developer settings, collapsed by default.
  const advanced = u.q('.spawn-advanced');
  assert.equal(advanced.open, false); assert.equal(advanced.querySelector('summary').firstChild.textContent, 'Developer settings');
  assert.ok(advanced.contains(u.q('.spawn-work')));
  assert.equal(u.q('.fbranch').placeholder, preview.branch); assert.equal(u.q('.fbase').placeholder, `HEAD · ${preview.base.oid.slice(0, 7)}`);
  assert.equal(u.text('.spawn-worktree-path code'), preview.worktree.slice(DEPLOYMENT.length + 1));
  // The relationship is in the main form, not in Developer settings.
  assert.equal(advanced.contains(u.q('.spawn-relationship')), false);
  assert.equal(u.q('.spawn-seg input:checked').value, 'unrelated'); assert.equal(u.q('.frelto').hidden, true);
  // Removed: capability toggles, K6 placeholders, the preview button, the soul-name prefix switch.
  assert.doesNotMatch(dialog.textContent, /Attach knowledge|Allow child spawns|Open PR|Available after|Preview invocation|Force native/i);
  // Board 6: the capabilities are the preview's facts (read-only), never a choice.
  assert.equal(dialog.querySelector('.spawn-preview :is(input, select, button, textarea)'), null, 'no capability toggles');
  // The checkboxes are the dialog's own choices: the worktree, the wake, and Run in background (#1579), a switch shown
  // only where the CLI lists instance-background (this one does not).
  assert.equal(dialog.querySelectorAll('input[type=checkbox]:not(.fworktree):not(.fwake-enabled):not(.fbackground)').length, 0);
  assert.equal(u.q('.spawn-background').hidden, true);
  assert.equal(u.q('.spawn-prefix-toggle'), null); assert.doesNotMatch(dialog.textContent, /Prefix with the soul name/);
  assert.equal(u.q('.fspawn').disabled, false); assert.equal(u.q('.fspawn').hidden, false, 'the shell must not rewrite the Spawn button');
  assert.equal(u.q('.fspawn').textContent, 'Spawn'); assert.ok(u.q('.fspawn').dataset.chord);
  assert.equal(u.previews().length, 1); assert.equal(u.spawns().length, 0, 'opening never prepares or applies');
});

test('typing a purpose asks the kernel again (latest intent only) and shows the name it will use', async t => {
  const u = await mountSpawn(t, { previewDelay: 20 });
  await u.open(); await new Promise(r => setTimeout(r, 40)); await settle();
  const before = u.previews().length;
  for (const value of ['a', 'ap', 'api-', 'api-v2']) { const el = u.q('.fpurpose'); el.value = value; el.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); }
  assert.match(u.text('.spawn-name-result'), /release-manager-api-v2/, 'the typed name shows at once');
  await new Promise(r => setTimeout(r, 60)); await settle();
  assert.equal(u.previews().length, before + 1, 'one read for the burst');
  assert.deepEqual(last(u), { purpose: 'api-v2', model: { kind: 'inherit' }, relation: { kind: 'unrelated' } });
  assert.equal(u.q('.spawn-name-result strong').textContent, created().instance);
});

test('an invalid name never reaches the kernel; it is explained next to the field', async t => {
  const u = await mountSpawn(t);
  await u.open(); const before = u.previews().length;
  await u.type('.fpurpose', 'bad name');
  assert.equal(u.previews().length, before); assert.ok(u.q('.spawn-name-result').classList.contains('err'));
  assert.match(u.text('.spawn-name-result'), /letters, digits and dashes/); assert.equal(u.q('.fspawn').disabled, true);
});

test('a taken derived name is the kernel\'s numbered one, and the dialog says why', async t => {
  const u = await mountSpawn(t, { previewName: () => 'preview-after-apply' });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  assert.equal(u.q('.spawn-name-result strong').textContent, 'release-manager-api-v2-2');
  assert.match(u.text('.spawn-name-result'), /taken, so the kernel numbered it/);
});

test('a checkout soul offers a worktree instead: --work worktree, and the kernel\'s worktree decision is shown', async t => {
  const u = await mountSpawn(t, { agents: [...catalogAgents(), checkoutSoul()] });
  await u.open('platform-reviewer'); await u.type('.fpurpose', 'review');
  const plain = created('preview-checkout-default');
  assert.match(u.text('.spawn-work-text'), /Works directly in the checkout at/); assert.equal(u.text('.spawn-work-text code'), plain.repo);
  assert.equal(u.q('.spawn-use-worktree').hidden, false); assert.equal(u.q('.spawn-joined').hidden, true);
  await u.change('.fworktree', true);
  assert.equal(last(u).work, 'worktree');
  const asWorktree = created('preview-checkout-as-worktree');
  assert.equal(u.q('.spawn-joined').hidden, false); assert.equal(u.q('.fbranch').placeholder, asWorktree.branch);
  assert.equal(u.text('.spawn-work-text'), '');
});

test('a directory soul says where it works and offers no worktree', async t => {
  const u = await mountSpawn(t);
  await u.open('support-triager');
  assert.equal(u.text('.spawn-work-text'), 'Works in its own folder, not tied to one repository: free to work across repos as its task needs');
  assert.equal(u.q('.spawn-use-worktree').hidden, true); assert.equal(u.q('.spawn-joined').hidden, true);
});

test('a kernel refusal is said plainly, its remedy is kept verbatim behind Details, and Spawn stays disabled', async t => {
  const refusal = kernel('preview-clone-missing');
  const u = await mountSpawn(t, { kernel: () => refusal });
  await u.open();
  assert.equal(u.text('.fstatus'), 'This soul’s repository isn’t cloned on this machine yet. Clone it, then try again — Details shows how.');
  assert.equal(u.q('.fstatus').dataset.code, 'E_CLONE_MISSING'); assert.doesNotMatch(u.text('.fstatus'), /E_[A-Z]|`|\//, 'no codes, commands or paths in the sentence');
  assert.equal(u.q('.spawn-problem-detail').hidden, true);
  u.q('.spawn-details-toggle').click();
  assert.equal(u.q('.spawn-problem-detail').hidden, false); assert.equal(u.q('.spawn-details-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(u.text('.spawn-problem-detail'), `E_CLONE_MISSING · ${refusal.error.message}`, "the kernel's remedy is kept verbatim behind Details");
  assert.ok(u.q('.fstatus').classList.contains('err')); assert.equal(u.q('.fspawn').disabled, true);
});

for (const outcome of ['success', 'rejection']) test(`an older preview settling late (${outcome}) never replaces the newer one`, async t => {
  const first = deferred(); let n = 0;
  const u = await mountSpawn(t, { previewGate: () => ++n === 1 ? first.promise : undefined });
  await u.open();
  await u.type('.fpurpose', 'api-v2');
  if (outcome === 'success') first.resolve(); else first.reject(Object.assign(new Error('late'), { code: 'E_CLI_FAILED' }));
  await settle(20);
  assert.equal(u.q('.spawn-name-result strong').textContent, created().instance);
  assert.equal(u.text('.fstatus'), 'Preview ready', 'the newer read\'s own status, nothing from the late one'); assert.equal(u.q('.fspawn').disabled, false);
});

for (const outcome of ['success', 'rejection']) test(`a preview settling (${outcome}) after the dialog was replaced touches nothing`, async t => {
  const gate = deferred(); let hold = true;
  const u = await mountSpawn(t, { previewGate: () => hold ? gate.promise : undefined });
  const old = await u.open();
  hold = false; u.q('.fcancel').click(); await settle();
  const current = await u.open('support-triager');
  if (outcome === 'success') gate.resolve(); else gate.reject(new Error('late'));
  await settle(20);
  assert.equal(u.dialog(), current); assert.equal(old.isConnected, false);
  assert.equal(u.text('.spawn-work-text'), 'Works in its own folder, not tied to one repository: free to work across repos as its task needs'); assert.equal(u.text('.fstatus'), 'Preview ready');
});

test('Spawn is one click: prepare, then apply of the decision on screen; the terminal opens once the exact instance runs', async t => {
  let u; u = await mountSpawn(t, { apply: args => applyThatRuns(u)(args) });
  await u.open(); await u.type('.fpurpose', 'api-v2'); await u.type('.ftask', 'Cut 3.2');
  await u.spawn();
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply']);
  const [prepare, apply] = u.spawns();
  assert.deepEqual(prepare.choices, { purpose: 'api-v2', model: { kind: 'inherit' }, relation: { kind: 'unrelated' } }); assert.equal(prepare.task, 'Cut 3.2');
  assert.deepEqual(Object.keys(apply).sort(), ['action', 'spawnRef'], 'the renderer never sends a key, decision or task at apply');
  assert.equal(u.applied.length, 1); assert.equal(u.applied[0].decision.revision, created().decision.revision);
  assert.equal(u.opens.length, 1); assert.deepEqual(u.opens[0].ref, { instance: created().instance, home: created().decision.home, agentsRoot: ROOT });
  assert.equal(u.dialog(), null, 'the dialog closes on handoff'); assert.equal(u.notified.length, 1);
});

test('if the kernel decides differently at Spawn time, nothing is applied until the operator has seen the new values', async t => {
  let drift = false;
  const u = await mountSpawn(t, { previewName: (soul, choices) => drift ? 'preview-after-apply' : 'preview-worktree-purpose' });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  drift = true; await u.spawn();
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare']); assert.equal(u.applied.length, 0);
  assert.equal(u.q('.spawn-name-result strong').textContent, 'release-manager-api-v2-2');
  assert.match(u.text('.fstatus'), /changed since you last looked/);
  await u.spawn();
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'prepare', 'apply']); assert.equal(u.applied.length, 1);
  assert.equal(u.applied[0].decision.instance, 'release-manager-api-v2-2');
});

test('a stale apply (kernel E_DECISION_STALE) creates nothing, says so and reads the current values again', async t => {
  const u = await mountSpawn(t, { apply: () => ({ started: true, envelope: kernel('apply-stale') }) });
  await u.open(); await u.type('.fpurpose', 'api-v2'); const before = u.previews().length;
  await u.spawn();
  assert.equal(u.q('.fstatus').dataset.code, 'E_DECISION_STALE'); assert.match(u.text('.fstatus'), /Nothing was created/);
  assert.doesNotMatch(u.text('.fstatus'), /E_[A-Z]|[0-9a-f]{24}/); assert.equal(u.opens.length, 0);
  assert.ok(u.previews().length > before, 're-read after a stale refusal'); assert.equal(u.q('.fspawn').textContent, 'Spawn');
});

test('#1246 D1: a press 90 s after its preview prepares from the held answer; a drift the kernel finds at apply reads as drifted and the values are read again', async t => {
  let time = 0, atApply = null, u;
  u = await mountSpawn(t, { previewNow: () => time, spawnGate: body => { if (body.action === 'apply') atApply = u.kernelPreviews(); },
    apply: () => ({ started: true, envelope: kernel('apply-stale') }) });
  await u.open(); await u.type('.fpurpose', 'api-v2'); await settle(10);
  const reads = u.kernelPreviews(), shown = u.previews().length;
  time += 90_000; // past the dialog's 60 s, within PREPARE_REUSE_MS
  await u.spawn();
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply']);
  assert.equal(atApply, reads, 'prepare took the held preview: no kernel preview between the press and the apply');
  assert.equal(u.q('.fstatus').dataset.code, 'E_DECISION_STALE');
  assert.equal(u.text('.fstatus'), 'Something changed before the spawn went through. Nothing was created — check the updated values and press Spawn again.');
  assert.ok(u.previews().length > shown, 'the values are read again'); assert.equal(u.q('.fspawn').textContent, 'Spawn');
  assert.equal(u.opens.length, 0);
});

test('an unknown outcome offers Check result on the SAME intent; the retry reuses the key and the kernel replays', async t => {
  let n = 0, u;
  u = await mountSpawn(t, { apply: args => ++n === 1 ? { started: true, envelope: { schemaVersion: 1, ok: false, error: { code: 'E_CLI_TIMEOUT', message: 'x' } } }
    : applyThatRuns(u, { ...created(), })(args) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  await u.spawn();
  assert.equal(u.q('.fspawn').textContent, 'Check result'); assert.match(u.text('.fstatus'), /couldn’t confirm whether the instance was created/); assert.equal(u.q('.fstatus').dataset.code, 'E_OUTCOME_UNKNOWN');
  assert.equal(u.q('.fspawn').disabled, false);
  await u.spawn();
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply', 'result', 'apply']);
  assert.equal(u.applied.length, 2); assert.equal(u.applied[0].key, u.applied[1].key, 'never a replacement key');
  assert.equal(u.opens.length, 1);
});

test('decision A: a backend restart after the press (E_INTENT_EXPIRED) reads unknown with Check result, never “Nothing was created”', async t => {
  let u;
  u = await mountSpawn(t, { spawnGate: body => { if (body.action === 'apply') u.restartBroker(); } });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  await u.spawn();
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply']); assert.equal(u.applied.length, 0, 'the new broker applied nothing');
  assert.equal(u.q('.fstatus').dataset.code, 'E_INTENT_EXPIRED');
  assert.equal(u.text('.fstatus'), 'This spawn request expired. Check the instance list before spawning again.');
  assert.doesNotMatch(u.text('.fstatus'), /Nothing was created/);
  assert.equal(u.q('.fspawn').textContent, 'Check result'); assert.equal(u.q('.fspawn').disabled, false);
  // Check result asks on the same reference, and the record is still gone: still unknown, nothing applied.
  await u.spawn();
  assert.equal(u.spawns().at(-1).spawnRef, u.spawns()[1].spawnRef); assert.ok(u.spawns().slice(2).every(b => b.action !== 'prepare'));
  assert.equal(u.applied.length, 0); assert.equal(u.q('.fstatus').dataset.code, 'E_INTENT_EXPIRED');
  assert.equal(u.q('.fspawn').textContent, 'Check result'); assert.equal(u.opens.length, 0);
});

for (const outcome of ['success', 'rejection']) test(`closing during an in-flight spawn (${outcome}): the late result opens nothing and leaves a newer dialog alone`, async t => {
  const gate = deferred(); let hold = false, u;
  u = await mountSpawn(t, { spawnGate: body => hold && body.action === 'apply' ? gate.promise : undefined, apply: args => applyThatRuns(u)(args) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  hold = true; u.q('.fspawn').click(); await settle();
  const old = u.dialog();
  u.q('.fcancel').click(); await settle();
  const current = await u.open('support-triager'); await u.type('.ftask', 'newer');
  if (outcome === 'success') gate.resolve(); else gate.reject(new Error('late'));
  await settle(30);
  assert.equal(u.dialog(), current); assert.equal(u.q('.ftask').value, 'newer'); assert.equal(u.text('.fstatus'), 'Preview ready');
  assert.equal(old.querySelector('.fstatus').textContent, 'Spawning…', 'the closed dialog does not even take the late response');
  assert.deepEqual(u.opens, []);
  const before = u.spawns().length;
  old.querySelector('.fspawn').dispatchEvent(new u.dom.window.Event('click')); await settle(20);
  assert.equal(u.spawns().length, before, "the old dialog's Spawn cannot act on the current one");
});
test('closing the dialog while the new instance is still starting: the terminal is not opened when it appears', async t => {
  let u, polls = 0;
  u = await mountSpawn(t, {
    apply: () => ({ started: true, envelope: { schemaVersion: 1, ok: true, result: creation(created()) } }),
    sleep: async () => {
      if (++polls !== 1) return;
      u.dialog().querySelector('.fcancel').click(); // the operator closes while the roster catches up
      const d = created().decision;
      u.setInstances([{ instance: d.instance, agent: 'release-manager', agentsRoot: ROOT, home: d.home, running: true, tmux: { session: 'oats', window: d.instance } }]);
    } });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  await u.spawn(); await settle(30);
  assert.equal(polls >= 1, true); assert.deepEqual(u.opens, [], 'a closed dialog never hands off'); assert.equal(u.notified.length, 0);
});

test('Ctrl/Cmd+Enter spawns from the dialog; plain Enter in the instruction is text', async t => {
  let u; u = await mountSpawn(t, { apply: args => applyThatRuns(u)(args) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  const ta = u.q('.ftask'); ta.focus();
  ta.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle();
  assert.equal(u.spawns().length, 0);
  ta.dispatchEvent(new u.dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })); await settle(20);
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply']);
});

test('Run on an execution server: no local preview; the remote spawn carries the typed fields', async t => {
  const remote = [];
  const u = await mountSpawn(t, { servers: [{ id: 'build', label: 'Build host', sshHost: 'build.lan' }], remote: body => { remote.push(body); return { instance: 'release-manager-api-v2', server: 'build' }; } });
  await u.open(); await u.type('.fpurpose', 'api-v2'); const before = u.previews().length;
  u.q('.spawn-advanced').open = true;
  await u.change('.fserver', 'build');
  assert.equal(u.previews().length, before, 'defaults are decided on the execution host');
  assert.equal(u.text('.spawn-name-result'), 'Named by build when it spawns.'); assert.match(u.text('.spawn-run-hint'), /decided on build/);
  await u.spawn();
  assert.equal(remote.length, 1); assert.equal(remote[0].serverId, 'build'); assert.equal(remote[0].purpose, 'api-v2');
  assert.equal(u.spawns().filter(b => b?.action).length, 0, 'never the local prepare/apply');
});

// awebai/oats#1490: a spawn on another machine takes the exact name as a local one does where this computer's CLI
// advertises spawn-name and relays what each host is (server-probe-features), and the host's roster row names spawn-name.
// Anything less (an older OATS on either side, a host whose features are unknown) is today's purpose with its prefix.
const HOST = { id: 'build', label: 'Build host', sshHost: 'build.lan' };
const hostFacts = (features) => ({ members: [], notReached: [], servers: [{ server: 'build', label: 'Build host', group: 'build:k1', deployment: 'remote:build:k1', reached: true, error: null, registered: true, features }] });
const RELAYING = { ...structuredClone(CLI), features: [...CLI.features, 'server-probe-features'] };

test('a spawn on a server whose host advertises spawn-name is named as a local one: no prefix, the final name, sent as name alone', async t => {
  const remote = [];
  const u = await mountSpawn(t, { spawnName: true, cli: RELAYING, servers: [HOST], teamMembers: hostFacts(['spawn-preview-2', 'spawn-name']),
    remote: body => { remote.push(body); return { instance: 'api-v2', server: 'build' }; } });
  await u.open(); u.q('.spawn-advanced').open = true;
  await u.change('.fserver', 'build'); const before = u.previews().length;
  assert.ok(u.q('.spawn-name-input').classList.contains('unprefixed'), 'no <soul>- prefix');
  assert.equal(u.q('.fpurpose').placeholder, 'e.g. pricing-page-lead');
  assert.equal(u.text('.spawn-name-result'), 'Named by build when it spawns.', 'neither this CLI nor the host names it from its task');
  await u.type('.fpurpose', 'API-v2');
  assert.equal(u.text('.spawn-name-result'), 'Instance name: api-v2', 'lowercased, nothing appended');
  assert.equal(u.previews().length, before, 'still decided on the host: no local preview');
  await u.spawn();
  assert.equal(remote.length, 1); assert.equal(remote[0].serverId, 'build');
  assert.equal(remote[0].name, 'api-v2'); assert.equal(Object.hasOwn(remote[0], 'purpose'), false, 'never a purpose beside the name');
});

test('a remote spawn with typed pricing-page-lead sends name: "pricing-page-lead"', async t => {
  const remote = [];
  const u = await mountSpawn(t, { spawnName: true, cli: RELAYING, servers: [HOST], teamMembers: hostFacts(['spawn-preview-2', 'spawn-name']),
    remote: body => { remote.push(body); return { instance: body.name, server: 'build' }; } });
  await u.open(); u.q('.spawn-advanced').open = true;
  await u.change('.fserver', 'build');
  await u.type('.fpurpose', 'pricing-page-lead');
  assert.equal(u.text('.spawn-name-result'), 'Instance name: pricing-page-lead');
  await u.spawn();
  assert.equal(remote.length, 1); assert.equal(remote[0].name, 'pricing-page-lead');
});

test('a spawn on a server is a purpose with its prefix, as before, unless both sides are known to take an exact name', async t => {
  for (const [why, opts] of [
    ['the host does not advertise spawn-name', { spawnName: true, cli: RELAYING, teamMembers: hostFacts(['spawn-preview-2']) }],
    ['the host\'s features are unknown', { spawnName: true, cli: RELAYING, teamMembers: hostFacts(null) }],
    ['no roster row for the host', { spawnName: true, cli: RELAYING }],
    ['this computer\'s CLI does not relay host features', { spawnName: true, teamMembers: hostFacts(['spawn-name']) }],
    ['this computer\'s CLI has no spawn-name', { cli: RELAYING, teamMembers: hostFacts(['spawn-name']) }],
  ]) {
    const remote = [];
    const u = await mountSpawn(t, { ...opts, servers: [HOST], remote: body => { remote.push(body); return { instance: 'release-manager-api-v2', server: 'build' }; } });
    await u.open(); u.q('.spawn-advanced').open = true;
    await u.change('.fserver', 'build'); await u.type('.fpurpose', 'api-v2');
    assert.equal(u.q('.spawn-name-input').classList.contains('unprefixed'), false, why);
    assert.equal(u.q('.fpurpose').placeholder, 'purpose, e.g. api-v2', why);
    assert.equal(u.text('.spawn-name-result'), 'Named by build when it spawns.', why);
    await u.spawn();
    assert.equal(remote[0].purpose, 'api-v2', why); assert.equal(Object.hasOwn(remote[0], 'name'), false, why);
  }
});

test('a soul listed from a server finds its host the same way: a host with spawn-name takes the exact name', async t => {
  const remote = [];
  const agents = [{ name: 'builder', description: 'Builds on the host', kind: 'persistent', work: 'worktree', agentsRoot: '/srv/team/agents', server: 'build', repoName: 'team' }];
  const u = await mountSpawn(t, { agents, spawnName: true, cli: RELAYING, teamMembers: hostFacts(['spawn-name']),
    remote: body => { remote.push(body); return { instance: 'nightly', server: 'build' }; } });
  await u.open('builder'); await settle(20);
  assert.ok(u.q('.spawn-name-input').classList.contains('unprefixed'));
  await u.type('.fpurpose', 'nightly');
  assert.equal(u.text('.spawn-name-result'), 'Instance name: nightly');
  await u.spawn();
  assert.equal(remote[0].name, 'nightly'); assert.equal(Object.hasOwn(remote[0], 'purpose'), false);
  assert.equal(u.previews().length, 0, 'still no local preview for a remote soul');
});

test('the host\'s name refusal is said next to the Name field, as a local one is; nothing is created and an edit clears it', async t => {
  const message = 'instance name "api-v2" is taken';
  const u = await mountSpawn(t, { spawnName: true, cli: RELAYING, servers: [HOST], teamMembers: hostFacts(['spawn-name']),
    remote: () => { throw Object.assign(new Error(message), { code: 'E_INSTANCE_NAME_TAKEN' }); } });
  await u.open(); u.q('.spawn-advanced').open = true;
  await u.change('.fserver', 'build'); await u.type('.fpurpose', 'api-v2');
  await u.spawn();
  assert.ok(u.q('.spawn-name-result').classList.contains('err'));
  assert.equal(u.text('.spawn-name-result'), 'An instance with this name already exists. Choose another name.');
  assert.equal(u.text('.fstatus'), `Couldn’t spawn on build: ${message}`); assert.equal(u.q('.fstatus').dataset.code, 'E_INSTANCE_NAME_TAKEN');
  assert.equal(u.q('.fspawn').textContent, 'Spawn', 'nothing was created: Spawn is offered again');
  await u.type('.fpurpose', 'api-v3');
  assert.equal(u.q('.spawn-name-result').classList.contains('err'), false); assert.equal(u.text('.spawn-name-result'), 'Instance name: api-v3');
});

test('a host\'s late name refusal speaks only for the name it refused: a name edited meanwhile is not marked taken', async t => {
  const reply = deferred();
  const u = await mountSpawn(t, { spawnName: true, cli: RELAYING, servers: [HOST], teamMembers: hostFacts(['spawn-name']), remote: () => reply.promise });
  await u.open(); u.q('.spawn-advanced').open = true;
  await u.change('.fserver', 'build'); await u.type('.fpurpose', 'api-v2');
  const pressed = u.spawn();
  await u.type('.fpurpose', 'api-v3');
  reply.reject(Object.assign(new Error('instance name "api-v2" is taken'), { code: 'E_INSTANCE_NAME_TAKEN' })); await pressed; await settle();
  assert.equal(u.q('.fstatus').dataset.code, 'E_INSTANCE_NAME_TAKEN', 'the footer reports the refusal');
  assert.equal(u.q('.spawn-name-result').classList.contains('err'), false); assert.equal(u.text('.spawn-name-result'), 'Instance name: api-v3');
  await u.type('.fpurpose', 'api-v2');
  assert.equal(u.q('.spawn-name-result').classList.contains('err'), false, 'an edit clears it, as for a local refusal');
});

test('model suggestions follow the kernel\'s harness; "the harness\'s own default" is the native-default choice', async t => {
  const asked = [];
  const u = await mountSpawn(t, { models: body => { asked.push(body.harness); return { models: [{ id: 'anthropic/claude-sonnet', label: 'Sonnet' }] }; } });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  assert.deepEqual(asked, ['pi'], 'asked for the harness the kernel resolved');
  u.q('.spawn-model-controls .spawn-choice-trigger').click(); await settle();
  const labels = [...u.doc.querySelectorAll('#spawn-model-choices button')].map(b => b.textContent);
  assert.ok(labels.some(l => l.startsWith('Sonnet'))); assert.ok(labels.includes("The harness's own default"));
  [...u.doc.querySelectorAll('#spawn-model-choices button')].find(b => b.textContent === "The harness's own default").click(); await settle();
  assert.deepEqual(last(u).model, { kind: 'native-default' });
  assert.equal(u.q('.spawn-name-result strong').textContent, created('preview-native-default').instance);
  assert.equal(u.text('.spawn-input-tag'), 'chosen');
});

test('choosing a harness re-reads the kernel and swaps the suggestions', async t => {
  const asked = [];
  const u = await mountSpawn(t, { models: body => { asked.push(body.harness); return { models: [] }; } });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  u.q('.spawn-run .spawn-choice-trigger').click(); await settle();
  [...u.doc.querySelectorAll('#spawn-runtime-choices button')].find(b => b.textContent.includes('Claude Code')).click(); await settle();
  assert.equal(last(u).harness, 'claude'); assert.equal(asked.at(-1), 'claude');
  assert.match(u.q('.spawn-run .spawn-choice-trigger').textContent, /Claude Code/);
});

test('a launch configuration is listed for this soul and sent only when chosen', async t => {
  const u = await mountSpawn(t, { configs: body => ({ selected: body.selector, configurations: [{ name: 'fast', runtime: 'claude' }] }) });
  await u.open();
  assert.deepEqual([...u.q('.flaunch').options].map(o => o.value), ['', 'fast']);
  assert.equal(Object.hasOwn(last(u), 'launchConfig'), false);
  await u.change('.flaunch', 'fast'); assert.equal(last(u).launchConfig, 'fast');
});

test('the harness, model and launch hints describe the preview for the harness, model and configuration on screen only: kept while another field reads, blank while their own change reads (desktop/loading-states item 9)', async t => {
  const gate = deferred(); let hold = false;
  const u = await mountSpawn(t, { previewGate: () => hold ? gate.promise : undefined });
  await u.open();
  assert.equal(u.text('.spawn-run-hint'), 'Launches Pi with its own default model.'); assert.equal(u.text('.spawn-model-default'), "Pi's default model");
  assert.equal(u.q('.spawn-run .spawn-choice-trigger .spawn-trigger-tag')?.textContent, 'default');
  hold = true; await u.change('.fyolo', 'true'); // another field: the launch facts on screen still describe this harness and model
  assert.equal(u.text('.spawn-run-hint'), 'Launches Pi with its own default model.', 'no blink while an unrelated field reads');
  assert.equal(u.text('.spawn-model-default'), "Pi's default model"); assert.equal(u.text('.spawn-input-tag'), 'default');
  await u.change('.fruntime', 'claude'); // the harness itself: the previous preview is for another launch
  assert.equal(u.text('.spawn-run-hint'), '', 'no launch sentence from the previous harness');
  assert.equal(u.text('.spawn-model-default'), ''); assert.equal(u.text('.spawn-input-tag'), '');
  assert.equal(u.q('.spawn-run .spawn-choice-trigger .spawn-trigger-tag'), null, 'no "default" tag from the previous preview');
  await u.change('.fruntime', ''); // back to the default harness: the settled preview speaks for it again
  assert.equal(u.q('.spawn-run .spawn-choice-trigger').getAttribute('aria-label'), 'Harness: Pi (default)');
  assert.equal(u.text('.spawn-model-default'), "Pi's default model");
  gate.resolve(); await settle(20);
  assert.equal(u.text('.spawn-run-hint'), 'Launches Pi with its own default model.', 'the hint stands with the matching preview');
  assert.equal(u.text('.spawn-model-default'), "Pi's default model"); assert.equal(u.text('.spawn-input-tag'), 'default');
});

test('permissions default to what the kernel reports and are sent only when chosen', async t => {
  const u = await mountSpawn(t);
  await u.open(); await u.type('.fpurpose', 'api-v2');
  assert.equal(u.q('.fyolo').options[0].textContent, "Default · harness's policy");
  await u.change('.fyolo', 'true'); assert.equal(last(u).yolo, true);
});

test('relationship: Child of reveals the instance picker and sends the exact anchor', async t => {
  const u = await mountSpawn(t);
  await u.open(); await u.type('.fpurpose', 'api-v2');
  u.q('.spawn-seg input[value=child]').click(); await settle();
  assert.equal(u.q('.frelto').hidden, false); assert.equal(u.q('.fspawn').disabled, true, 'a relation needs its instance');
  await u.change('.frelto', 'release-manager-race');
  assert.deepEqual(last(u).relation, { kind: 'child', anchor: { instance: 'release-manager-race', agent: 'release-manager', agentsRoot: ROOT, server: null } });
  assert.match(u.text('.freldesc'), /child of release-manager-race/);
});

test('choosing another soul keeps the typed name and instruction', async t => {
  const u = await mountSpawn(t);
  await u.open(); await u.type('.fpurpose', 'api-v2'); await u.type('.ftask', 'keep me');
  [...u.doc.querySelectorAll('.spawn-choice')].find(b => b.dataset.agent === 'support-triager').click(); await settle();
  assert.equal(u.q('.spawn-choice[aria-selected=true]').dataset.agent, 'support-triager');
  assert.equal(u.q('.fpurpose').value, 'api-v2'); assert.equal(u.q('.ftask').value, 'keep me');
  assert.equal(u.doc.activeElement, u.q('.ftask'), 'a pick goes on to the first field, the Opening instruction (Spec E)');
});

// The name (decided 2026-10-20): optional and the form's last field (the Opening instruction is its first); with spawn-name a typed name goes as
// --name exactly as typed, lowercased, nothing appended (decided 2026-11-12); an older kernel keeps --purpose with the prefix shown.
test('the name is optional and the last field, before Developer settings, the Opening instruction the first; no prefix switch', async t => {
  const u = await mountSpawn(t, { spawnName: true });
  await u.open();
  const fields = [...u.q('.spawn-form-body').children].filter(c => !c.classList.contains('workspace-sr-only'));
  const at = cls => fields.findIndex(f => f.classList.contains(cls) || f.querySelector(`:scope > .${cls}`));
  assert.equal(fields[0], u.q('.ftask').closest('.spawn-field'), 'the Opening instruction is the first field');
  assert.equal(fields[at('spawn-name') + 1], u.q('.spawn-advanced'), 'right before Developer settings');
  assert.equal(at('spawn-name'), fields.length - 2, 'the last field');
  const label = u.q('.spawn-name > label');
  assert.equal(label.htmlFor, 'spawn-purpose'); assert.equal(label.firstChild.textContent, 'Name '); assert.equal(label.querySelector('small').textContent, '· optional');
  assert.equal(u.q('.spawn-prefix-toggle'), null); assert.equal(u.q('.fprefix'), null);
  assert.ok(u.q('.spawn-name-input').classList.contains('unprefixed'), 'no <soul>- prefix where the name goes as --name');
  assert.equal(u.q('.fpurpose').placeholder, 'e.g. pricing-page-lead');
});

test('with spawn-name: empty is numbered by the kernel; a typed name goes as --name exactly as typed (lowercased), with no soul role', async t => {
  // The kernel answers the f3 --name capture with the name it was asked for.
  const answer = choices => { const k = kernel('preview-name'); if (choices.name) { k.result.instance = choices.name; k.result.decision.instance = choices.name; } return choices.name ? k : kernel('preview-worktree-default'); };
  const agents = [...catalogAgents(), { ...catalogAgents().find(a => a.name === 'release-manager'), name: 'oats-desktop-expert', description: 'Leads the Desktop.' }];
  const u = await mountSpawn(t, { spawnName: true, agents, kernel: (_c, { choices }) => answer(choices) });
  await u.open('oats-desktop-expert'); await settle(20);
  assert.equal(u.text('.spawn-name-result'), 'Left empty, the kernel numbers it.', 'only what is true now, never the preview\'s number');
  assert.deepEqual(last(u), { model: { kind: 'inherit' }, relation: { kind: 'unrelated' } }, 'nothing sent for an empty name');
  await u.type('.fpurpose', 'desktop-improvements');
  assert.deepEqual(last(u), { name: 'desktop-improvements', model: { kind: 'inherit' }, relation: { kind: 'unrelated' } });
  assert.equal(u.text('.spawn-name-result'), 'Instance name: desktop-improvements'); assert.equal(u.q('.spawn-name-result strong').textContent, 'desktop-improvements');
  // --name is used exactly as given (the kernel slugs a purpose, not a name): what is typed is lowercased first.
  await u.type('.fpurpose', 'Pricing-Page-Lead');
  assert.equal(last(u).name, 'pricing-page-lead'); assert.equal(u.q('.spawn-name-result strong').textContent, 'pricing-page-lead');
  assert.equal(u.q('.fpurpose').value, 'Pricing-Page-Lead', 'the field keeps what was typed');
  // A name that already ends in the soul's role, or is its role, is as typed too.
  for (const typed of ['desktop-improvements-expert', 'expert']) { await u.type('.fpurpose', typed); assert.equal(last(u).name, typed); }
  assert.equal(last(u).purpose, undefined, 'this dialog no longer sends --purpose here');
  await u.type('.fpurpose', ''); await settle(20);
  assert.equal(u.text('.spawn-name-result'), 'Left empty, the kernel numbers it.');
});

test('with spawn-name the 64-character cap runs on the typed name itself; a kernel refusal shows at the field', async t => {
  const u = await mountSpawn(t, { spawnName: true, kernel: (_c, { choices }) => choices.name === 'api-gateway' ? kernel('preview-name-taken') : kernel('preview-worktree-default') });
  await u.open(); await settle(20);
  const before = u.previews().length;
  await u.type('.fpurpose', 'a'.repeat(65)); await settle(20);
  assert.match(u.text('.spawn-name-result'), /^Instance names are at most 64 characters\. Shorten the name\.$/); assert.equal(u.q('.fspawn').disabled, true);
  assert.equal(u.previews().length, before, 'never sent');
  await u.type('.fpurpose', 'a'.repeat(64)); await settle(20);
  assert.equal(last(u).name, 'a'.repeat(64), 'room for the whole typed name: nothing is appended');
  // The kernel's own refusal of a name taken in the deployment (the f3 capture's E_INSTANCE_NAME_TAKEN), beside the field.
  await u.type('.fpurpose', 'api-gateway'); await settle(20);
  assert.deepEqual(last(u), { name: 'api-gateway', model: { kind: 'inherit' }, relation: { kind: 'unrelated' } });
  assert.equal(u.text('.spawn-name-result'), 'An instance with this name already exists. Choose another name.');
  assert.equal(u.text('.fstatus'), '', 'said once, next to the name');
  assert.ok(u.q('.spawn-name-result').classList.contains('err')); assert.equal(u.q('.fspawn').disabled, true);
});

test('a restored draft of { name: "pricing-page-lead" } puts pricing-page-lead back in the field and sends it unchanged', async t => {
  const u = await mountSpawn(t, { spawnName: true });
  spawn.preselectSpawn({ name: 'release-manager', agentsRoot: ROOT, draft: { layout: 'scoped', restore: { choices: { name: 'pricing-page-lead' } } } }); await settle(20);
  assert.equal(u.q('.fpurpose').value, 'pricing-page-lead');
  assert.equal(last(u).name, 'pricing-page-lead');
});

test('an older kernel without spawn-name keeps --purpose, the <soul>- prefix shown and today\'s hint', async t => {
  const u = await mountSpawn(t);
  await u.open(); await settle(20);
  assert.equal(u.q('.spawn-name-input').classList.contains('unprefixed'), false); assert.equal(u.text('.spawn-name-prefix'), 'release-manager-');
  assert.equal(u.q('.fpurpose').placeholder, 'purpose, e.g. api-v2');
  assert.match(u.text('.spawn-name-result'), /^Instance name: /, 'the numbered name as today, not the spawn-name hint');
  await u.type('.fpurpose', 'api-v2');
  assert.deepEqual(last(u), { purpose: 'api-v2', model: { kind: 'inherit' }, relation: { kind: 'unrelated' } });
  assert.equal(u.q('.spawn-prefix-toggle'), null);
});

test('the CLI going away closes the dialog; a retained Spawn click never dispatches; only a newly opened dialog can spawn', async t => {
  let u; u = await mountSpawn(t, { apply: args => applyThatRuns(u)(args) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  const stale = u.q('.fspawn');
  await u.setCli({ ok: false, probedAt: 2, tried: [] }); await settle(20);
  assert.equal(u.dialog(), null, 'closed on the unavailable transition');
  stale.dispatchEvent(new u.dom.window.Event('click')); await settle(20);
  assert.equal(u.spawns().length, 0);
  await u.setCli(structuredClone(CLI)); await settle(20);
  stale.dispatchEvent(new u.dom.window.Event('click')); await settle(20);
  assert.equal(u.spawns().length, 0, 're-verification cannot revive a closed dialog');
  await u.open(); await u.type('.fpurpose', 'api-v2'); await u.spawn();
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare', 'apply']);
});

test('a CLI without the confirmed-apply fence can preview but never spawn', async t => {
  const u = await mountSpawn(t, { cli: { ...structuredClone(CLI), features: CLI.features.filter(f => f !== 'spawn-apply-2') } });
  await u.open();
  assert.equal(u.q('.fspawn').disabled, true); assert.equal(u.previews().length, 1);
  u.q('.fspawn').dispatchEvent(new u.dom.window.Event('click')); await settle();
  assert.equal(u.spawns().length, 0);
});

test('relation picker: hostile roster paths and descriptions stay inert text; colliding root tags stay distinguishable', async t => {
  const evilRoot = `/tmp/x"><img src=x onerror=alert(1)>/agents`;
  const agents = catalogAgents().map(a => a.name === 'release-manager' ? { ...a, description: '<img src=x onerror=alert(1)>" onpointerenter="window.__pwned=1' } : a);
  const u = await mountSpawn(t, { agents, instances: [
    { instance: 'dev-1', agent: 'dev', agentsRoot: '/a/project/agents', home: '/a/project/agents/dev/instances/dev-1', running: true },
    { instance: 'dev-1', agent: 'dev', agentsRoot: '/b/project/agents', home: '/b/project/agents/dev/instances/dev-1', running: true },
    { instance: 'evil', agent: 'dev', agentsRoot: evilRoot, home: `${evilRoot}/dev/instances/evil`, running: false },
  ] });
  const dialog = await u.open();
  assert.equal(dialog.querySelector('img'), null);
  assert.ok(![...dialog.querySelectorAll('*')].some(el => [...el.attributes].some(at => at.name.startsWith('on'))));
  const options = [...u.q('.frelto').options];
  assert.equal(options.find(o => o.value === 'evil').dataset.root, evilRoot, 'the root is kept byte-for-byte as data');
  assert.match(options.find(o => o.value === 'evil').textContent, /^evil.*\(stopped\)$/);
  const labels = options.filter(o => o.value === 'dev-1').map(o => o.textContent);
  assert.equal(labels.length, 2); assert.notEqual(labels[0], labels[1]);
});

test('roster refreshes while the dialog is open keep the typed name, instruction and open settings', async t => {
  const u = await mountSpawn(t);
  const dialog = await u.open(); await u.type('.fpurpose', 'api-v2'); await u.type('.ftask', 'typed'); u.q('.spawn-advanced').open = true;
  for (const poll of u.polls) poll(); await settle(20);
  assert.equal(u.dialog(), dialog); assert.equal(u.q('.fpurpose').value, 'api-v2'); assert.equal(u.q('.ftask').value, 'typed'); assert.equal(u.q('.spawn-advanced').open, true);
});

test('a remote soul stays pinned to its host: no local preview, launch-config or model probes', async t => {
  const remote = [];
  const agents = [{ name: 'builder', description: 'Builds on the host', kind: 'persistent', work: 'worktree', agentsRoot: '/srv/team/agents', server: 'build', repoName: 'team' }];
  const u = await mountSpawn(t, { agents, remote: body => { remote.push(body); return { instance: 'builder-1', server: 'build' }; } });
  await u.open('builder');
  assert.equal(u.q('.fserver').value, 'build'); assert.equal(u.q('.fserver').disabled, true);
  assert.equal(u.previews().length, 0); assert.equal(u.calls.filter(c => ['/api/models', '/api/launch-configs'].some(p => c.path.startsWith(p))).length, 0);
  assert.equal(u.text('.spawn-name-result'), 'Named by build when it spawns.');
  await u.spawn(); assert.equal(remote[0].serverId, 'build'); assert.equal(remote[0].agentsRoot, '/srv/team/agents');
});

test('a created instance whose wake schedule was not saved stays created: View schedules, never a second spawn', async t => {
  const u = await mountSpawn(t, { apply: () => ({ started: true, envelope: { schemaVersion: 1, ok: true,
    result: creation(created(), { launched: false, wake: { requested: true, saved: false, error: { code: 'E_SCHEDULE', message: 'PRIVATE scheduler text' } } }) } }) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  u.q('.spawn-advanced').open = true; u.q('.fwake-enabled').checked = true; u.q('.fwake-enabled').dispatchEvent(new u.dom.window.Event('change', { bubbles: true }));
  u.q('.fwake-message').value = 'check in'; await settle();
  await u.spawn();
  assert.equal(u.spawns().at(0).wake.message, 'check in');
  assert.ok(u.dialog().querySelector('.guarded-schedules')); assert.equal(u.q('.fspawn').textContent, 'Created'); assert.equal(u.q('.fspawn').disabled, true);
  // Its own footer item before the Cancel/Created group, so the group never grows past the footer.
  assert.equal(u.q('.guarded-schedules').parentElement, u.q('.spawn-footer')); assert.equal(u.q('.guarded-schedules').nextElementSibling, u.q('.spawn-actions'));
  assert.doesNotMatch(u.text('.fstatus'), /PRIVATE/); assert.match(u.text('.fstatus'), /wake schedule was not saved/);
  await u.spawn(); assert.equal(u.applied.length, 1);
});

test('a soul name with selector metacharacters opens as data, is refused by the preview boundary, and survives roster refreshes', async t => {
  const evil = 'a"]b[x=1\\';
  const u = await mountSpawn(t, { agents: [...catalogAgents(), { name: evil, description: '', kind: 'persistent', work: 'worktree', agentsRoot: ROOT, repoName: 'northwind' }] });
  const dialog = await u.open(evil);
  assert.equal(u.q('.spawn-choice[aria-selected=true]').dataset.agent, evil);
  assert.equal(u.previews().at(-1).selector.soul, evil, 'the exact name is sent as data');
  assert.equal(u.q('.fstatus').dataset.code, 'E_BAD_ARGS', 'the boundary refuses a non-kernel soul name'); assert.doesNotMatch(u.text('.fstatus'), /E_[A-Z]/); assert.equal(u.q('.fspawn').disabled, true);
  await u.type('.ftask', 'typed'); for (const poll of u.polls) poll(); await settle(20);
  assert.equal(u.dialog(), dialog); assert.equal(u.q('.ftask').value, 'typed');
});

test('the soul chooser is titled Souls, with the count beside it and the search below', async t => {
  const u = await mountSpawn(t); await u.open();
  const chooser = u.q('.spawn-chooser'), head = chooser.firstElementChild;
  assert.equal(head.className, 'spawn-chooser-head'); assert.equal(u.text('.spawn-chooser-title'), 'Souls');
  assert.equal(chooser.getAttribute('aria-labelledby'), u.q('.spawn-chooser-title').id);
  assert.match(head.querySelector('.spawn-search-count').textContent, /^\d+ of \d+$/);
  assert.equal(head.nextElementSibling.className, 'spawn-search-label');
});

function luminance(hex) {
  assert.match(hex, /^#[0-9a-f]{6}$/i);
  const channels = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
for (const theme of ['light', 'solarized', 'dark']) test(`${theme}: every spawn dialog text meets computed-token AA on its own surface, with no opacity`, async t => {
  const u = await mountSpawn(t, { cli: { ...structuredClone(CLI), features: [...CLI.features, 'spawn-name'] } });
  const { readFileSync } = await import('node:fs');
  const style = u.doc.createElement('style'); style.textContent = readFileSync(new URL('../renderer/theme.css', import.meta.url), 'utf8'); u.doc.head.append(style);
  u.doc.documentElement.dataset.theme = theme;
  const dialog = await u.open(); await u.type('.fpurpose', 'api-v2'); u.q('.spawn-advanced').open = true;
  // Show a problem so the status, Details toggle and detail box are all rendered.
  u.q('.fstatus').textContent = 'x'; u.q('.fstatus').classList.add('err'); u.q('.spawn-details-toggle').hidden = false; u.q('.spawn-problem-detail').hidden = false;
  // A kernel text quoted in Details (a line of its own, #1015).
  u.q('.spawn-problem-detail').append(Object.assign(u.doc.createElement('span'), { className: 'spawn-problem-line', textContent: 'OATS says: x' }));
  u.q('.spawn-run .spawn-choice-trigger').click(); await settle();
  const view = u.dom.window, root = view.getComputedStyle(u.doc.documentElement);
  for (const [selector, surfaceSelector, fg, bg] of [
    ['.spawn-choice[aria-selected=true] strong', '.spawn-choice[aria-selected=true]', 'fg', 'sel'],
    ['.spawn-choice[aria-selected=true] small', '.spawn-choice[aria-selected=true]', 'muted', 'sel'],
    ['.spawn-name > label', '.spawn-dialog', 'muted', 'surface'], ['.spawn-relationship > legend', '.spawn-dialog', 'muted', 'surface'],
    ['.spawn-name-prefix', '.spawn-name-input', 'muted', 'surface'],
    ['.spawn-name-result strong', '.spawn-dialog', 'fg', 'surface'],
    ['.spawn-hint', '.spawn-dialog', 'muted', 'surface'],
    ['.spawn-model-default', '.spawn-dialog', 'fg', 'surface'],
    ['.spawn-input-tag', '.spawn-input-tag', 'muted', 'chip-bg'],
    ['.spawn-run .spawn-trigger-tag', '.spawn-run .spawn-trigger-tag', 'muted', 'chip-bg'],
    ['.spawn-choice-menu [aria-selected=true]', '.spawn-choice-menu [aria-selected=true]', 'fg', 'sel'],
    ['.spawn-seg input:checked + span', '.spawn-seg input:checked + span', 'accent', 'sel'], // the selected segment: brand tint (shared control rule 1)
    ['.spawn-seg input:not(:checked) + span', '.spawn-seg', 'muted', 'surface'],
    ['.spawn-advanced > summary', '.spawn-advanced', 'fg', 'surface-2'],
    ['.spawn-advanced > summary small', '.spawn-advanced', 'muted', 'surface-2'],
    // Spec E: the section keys' quiet hints, on the dialog and in Developer settings' summary.
    ['.spawn-name > label kbd.spawn-key-hint', '.spawn-dialog', 'muted', 'surface'], ['.spawn-relationship > legend kbd.spawn-key-hint', '.spawn-dialog', 'muted', 'surface'],
    ['.spawn-advanced > summary kbd.spawn-key-hint', '.spawn-advanced', 'muted', 'surface-2'],
    ['.spawn-joined-from', '.spawn-joined-from', 'muted', 'surface-2'],
    ['.spawn-chooser-title', '.spawn-dialog', 'fg', 'surface'], ['.spawn-search-count', '.spawn-dialog', 'muted', 'surface'],
    ['.spawn-details-toggle', '.spawn-footer', 'muted', 'surface'], ['.spawn-problem-detail', '.spawn-problem-detail', 'muted', 'surface-2'],
    ['.spawn-problem-line', '.spawn-problem-detail', 'muted', 'surface-2'],
    ['.fstatus.err', '.spawn-footer', 'danger', 'surface'],
    ['.ftask', '.ftask', 'fg', 'surface'], ['.fspawn', '.fspawn', 'primary-fg', 'primary-bg'],
  ]) {
    const element = u.doc.querySelector(`.spawn-dialog ${selector}`) || u.doc.querySelector(selector), surface = u.doc.querySelector(`.spawn-dialog ${surfaceSelector}`) || u.doc.querySelector(surfaceSelector);
    assert.ok(element && surface, selector);
    assert.equal(view.getComputedStyle(element).color, `var(--${fg})`, selector);
    assert.match(view.getComputedStyle(surface).background || view.getComputedStyle(surface).backgroundColor, new RegExp(`var\\(--${bg}\\)`), surfaceSelector);
    const f = luminance(root.getPropertyValue(`--${fg}`).trim()), b = luminance(root.getPropertyValue(`--${bg}`).trim());
    assert.ok((Math.max(f, b) + .05) / (Math.min(f, b) + .05) >= 4.5, `${theme} ${selector}: ${fg} on ${bg}`);
    for (let parent = element; parent; parent = parent.parentElement) assert.equal(view.getComputedStyle(parent).opacity, '1', selector);
  }
  assert.ok(dialog.isConnected);
});

test('a name longer than the kernel cap (#159) is refused at the field before any preview: a purpose\'s derived name', async t => {
  const u = await mountSpawn(t);
  await u.open(); await settle(20);
  const before = u.previews().length;
  // A purpose (no spawn-name): the kernel names <soul>-<purpose>, so the purpose may use 64 - "release-manager-".length.
  const room = 64 - 'release-manager-'.length;
  await u.type('.fpurpose', 'a'.repeat(room + 1)); await settle(20);
  assert.match(u.text('.spawn-name-result'), /at most 64 characters/); assert.equal(u.q('.fspawn').disabled, true);
  assert.equal(u.previews().length, before, 'never sent');
  await u.type('.fpurpose', 'a'.repeat(room)); await settle(400);
  assert.doesNotMatch(u.text('.spawn-name-result'), /at most 64/); assert.ok(u.previews().length > before, 'the longest derived name is previewed');
});

// Spec 02: "Where to run".
const buildFacts = (extra = {}) => ({ server: 'build', label: 'Build host', group: 'build:1', reached: true, error: null, registered: true, ...extra });
test('Where to run: "This computer" first, then each server by label (and id when it differs); an unreached or unregistered server is disabled with why, never for its souls', async t => {
  const u = await mountSpawn(t, {
    servers: [{ id: 'build', label: 'Build host', sshHost: 'build.lan' }, { id: 'same', label: 'same', sshHost: 's' }, { id: 'down', label: 'Down box', sshHost: 'd' },
      { id: 'bare', label: 'Bare box', sshHost: 'b' }, { id: 'moved', label: 'Moved box', sshHost: 'm' }],
    teamMembers: { members: [], notReached: [], servers: [buildFacts(), buildFacts({ server: 'same', label: 'same', group: 'same:1' }),
      buildFacts({ server: 'down', label: 'Down box', group: 'down:1', reached: false, error: 'ssh failed' }),
      buildFacts({ server: 'bare', label: 'Bare box', group: 'bare:1' }),
      buildFacts({ server: 'moved', label: 'Moved box', group: 'moved:old', registered: false })] } });
  await u.open();
  // A primary decision: at the form's top level, directly above Relationship (whose picker depends on it), not in Developer settings.
  const place = u.q('.spawn-place');
  assert.equal(place.querySelector('.spawn-label-text').textContent, 'Where to run');
  assert.equal(place.contains(u.q('.fserver')), true); assert.equal(place.contains(u.q('.spawn-server-hint')), true);
  assert.equal(u.q('.spawn-advanced').contains(place), false);
  assert.equal(place.nextElementSibling, u.q('.spawn-relationship'));
  assert.deepEqual([...u.q('.fserver').options].map(o => [o.textContent, o.disabled]), [
    ['This computer', false], ['Build host (build)', false], ['same', false],
    ['Down box (not reached)', true], ['Bare box (bare)', false], ['Moved box (not registered)', true]]);
});

test('a refused remote spawn says the refusal in OATS\'s own words (a soul the host doesn\'t offer), with the code behind Details', async t => {
  const message = 'no soul "release-manager" among the confirmed members, external souls or package souls of this workspace';
  const u = await mountSpawn(t, { servers: [{ id: 'build', label: 'Build host', sshHost: 'build.lan' }], teamMembers: { members: [], notReached: [], servers: [buildFacts()] },
    remote: () => { throw Object.assign(new Error(message), { code: 'E_SOUL_UNKNOWN' }); } });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  await u.change('.fserver', 'build');
  await u.spawn();
  assert.equal(u.text('.fstatus'), `Couldn’t spawn on build: ${message}`);
  assert.equal(u.q('.fstatus').dataset.code, 'E_SOUL_UNKNOWN'); assert.ok(u.q('.fstatus').classList.contains('err'));
  assert.equal(u.text('.spawn-problem-detail'), `E_SOUL_UNKNOWN · ${message}`);
});

test('Where to run a server: the hint says so, the relation picker lists only that server\'s rows, and the relation travels with the remote spawn', async t => {
  const remote = [];
  const farRow = { instance: 'far-lead', agent: 'release-manager', agentsRoot: '/srv/agents', home: '/srv/agents/release-manager/instances/far-lead', server: 'build', running: true, addressable: true };
  const u = await mountSpawn(t, { servers: [{ id: 'build', label: 'Build host', sshHost: 'build.lan' }], teamMembers: { members: [], notReached: [], servers: [buildFacts()] },
    serverPanels: { 'remote:build:1': [farRow] }, remote: body => { remote.push(body); return { instance: 'release-manager-api-v2', server: 'build' }; } });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  const local = [...u.q('.frelto').options].map(o => o.value).filter(Boolean);
  u.q('.spawn-advanced').open = true;
  await u.change('.fserver', 'build');
  assert.equal(u.text('.spawn-server-hint'), "Runs on Build host. Its teams and defaults come from that machine's workspace.");
  assert.deepEqual([...u.q('.frelto').options].map(o => o.value).filter(Boolean), ['far-lead'], 'never this computer\'s rows: relations do not cross machines');
  const child = [...u.doc.querySelectorAll('.spawn-dialog .frelation input')].find(i => i.value === 'child'); child.checked = true; child.dispatchEvent(new u.dom.window.Event('change', { bubbles: true })); await settle();
  await u.change('.frelto', 'far-lead');
  await u.spawn();
  assert.equal(remote.length, 1);
  assert.deepEqual([remote[0].serverId, remote[0].relation, remote[0].relativeTo, remote[0].relativeRoot], ['build', 'child', 'far-lead', '/srv/agents']);
  await u.change('.fserver', '');
  assert.equal(u.text('.spawn-server-hint'), '');
  assert.deepEqual([...u.q('.frelto').options].map(o => o.value).filter(Boolean), local, 'back on this computer: its own rows again');
});

test('Where to run a server: while its rows are still being read, a relation picked on this computer cannot be sent to it', async t => {
  const gate = deferred(), remote = [];
  const farRow = { instance: 'far-lead', agent: 'release-manager', agentsRoot: '/srv/agents', home: '/srv/agents/release-manager/instances/far-lead', server: 'build', running: true, addressable: true };
  const u = await mountSpawn(t, { servers: [{ id: 'build', label: 'Build host', sshHost: 'build.lan' }], teamMembers: { members: [], notReached: [], servers: [buildFacts()] },
    serverPanels: { 'remote:build:1': [farRow] }, serverPanelGate: gate.promise, remote: body => { remote.push(body); return { instance: 'x', server: 'build' }; } });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  const child = [...u.doc.querySelectorAll('.spawn-dialog .frelation input')].find(i => i.value === 'child'); child.checked = true; child.dispatchEvent(new u.dom.window.Event('change', { bubbles: true })); await settle();
  const localPick = [...u.q('.frelto').options].find(o => o.value);
  await u.change('.frelto', localPick.value);
  u.q('.spawn-advanced').open = true;
  await u.change('.fserver', 'build');
  assert.equal(u.q('.fspawn').disabled, true, 'the picker still holds this computer\'s rows: nothing may be sent');
  u.q('.fspawn').click(); await settle(); assert.equal(remote.length, 0);
  gate.resolve(); await settle();
  assert.deepEqual([...u.q('.frelto').options].map(o => o.value).filter(Boolean), ['far-lead']);
  assert.equal(u.q('.frelto').value, '', 'a local pick does not carry over'); assert.equal(u.q('.fspawn').disabled, true, 'a relation still needs a pick');
  await u.change('.frelto', 'far-lead'); assert.equal(u.q('.fspawn').disabled, false);
});

// #802: the in-dialog local path (the view harness) follows a pending apply like the background store does.
test('#802: an apply that answers pending is followed with result until it completes, in the dialog too', async t => {
  const gate = deferred(); let u;
  u = await mountSpawn(t, { brokerTimer: fn => { setImmediate(fn); return () => {}; }, apply: async args => { await gate.promise; return applyThatRuns(u)(args); } });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  u.q('.fspawn').click(); await settle(); await settle();
  assert.match(u.text('.fstatus'), /Spawning…/); assert.ok(u.spawns().some(b => b.action === 'result'), 'it reads result while pending');
  gate.resolve(); for (let i = 0; i < 20 && u.opens.length === 0; i++) await settle();
  assert.equal(u.applied.length, 1, 'never applied twice'); assert.equal(u.opens.length, 1);
});
for (const [code, words] of [['E_INTERRUPTED', /^The spawn of release-manager-api-v2 was interrupted while its worktree was being set up, and was rolled back\. Nothing was created\./],
  ['E_REQUIRED_HOOK_FAILED', /^A capability couldn’t set up the worktree for release-manager-api-v2, so the spawn was rolled back\. Nothing was created\./]]) {
  test(`#802: ${code} reads rolled back in the dialog with worktree-event, and today's unknown without it`, async t => {
    for (const feature of [true, false]) {
      const c = structuredClone(CLI); if (feature) c.features = [...c.features, 'worktree-event'];
      const u = await mountSpawn(t, { cli: c, apply: () => ({ started: true, envelope: { schemaVersion: 1, ok: false, error: { code, message: 'nw-setup failed (log: /x.log)' } } }) });
      await u.open(); await u.type('.fpurpose', 'api-v2'); await u.spawn();
      if (feature) { assert.match(u.text('.fstatus'), words); assert.equal(u.q('.fspawn').textContent, 'Spawn'); }
      else assert.equal(u.q('.fstatus').dataset.code, 'E_OUTCOME_UNKNOWN');
      u.close?.();
    }
  });
}
test('#802 review: past its deadline a pending spawn reads Outcome unknown in the dialog, with Check result', async t => {
  let clock = 1000; const realNow = Date.now; Date.now = () => clock; t.after(() => { Date.now = realNow; });
  const u = await mountSpawn(t, { apply: () => new Promise(() => {}), brokerTimer: fn => { setImmediate(() => { clock += 100000; fn(); }); return () => {}; } });
  await u.open(); await u.type('.fpurpose', 'api-v2'); await u.spawn(); await settle();
  assert.equal(u.q('.fstatus').dataset.code, 'E_OUTCOME_UNKNOWN');
  assert.match(u.text('.fstatus'), /couldn’t confirm whether the instance was created/);
  assert.equal(u.text('.fspawn'), 'Check result');
});
