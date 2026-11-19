// E_LAUNCH_PREFERENCE_UNMATCHED (OATS 0.53.0, awebai/oats#989; the Desktop's side is awebai/oats#1015):
// `oats-local.yaml` `souls.launch` holds a key that names no soul, and the spawn names no launch. The dialog
// says it in the Desktop's words, and the kernel's message and fix are quoted under Details, each whole and
// through the display filter, with the kernel's name in front.
//
// The refusal's texts here are this file's own. No kernel sentence is copied: the kernel's real answer is
// read by test/desktop-launch-preference-unmatched-kernel.test.mjs, at the repository's root.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnApplyReason } from '../../client/spawn-apply-contract.mjs';
import { cliSpawnPreview } from '../../client/spawn-preview-cli.mjs';
import { DETAIL_WITHHELD } from '../../client/display-text.mjs';
import { cli as CLI } from './helpers/spawn-preview-fixture.mjs';

const CODE = 'E_LAUNCH_PREFERENCE_UNMATCHED';
const SAID = 'the file points "ghost" at a launch and no soul answers to that name', REMEDY = 'point the entry at a soul, then drop "ghost"';
const OPENS = 'This machine’s launch preferences name a soul this workspace doesn’t offer, so OATS won’t choose a launch for this soul. To spawn now, pick a harness above, or a launch configuration in Advanced. To fix it for every spawn, correct the preference (Details).';
const PRESSED = 'This machine’s launch preferences name a soul this workspace doesn’t offer, so OATS won’t choose a launch for this soul. To spawn now, pick a harness or a launch configuration for this spawn. To fix it for every spawn, correct the preference.';
const TABLE = 'A launch preference on this machine names a soul the workspace does not offer, and this spawn names no launch.';
const refusal = (message = SAID, fix = REMEDY) => ({ schemaVersion: 1, ok: false, error: { code: CODE, message,
  details: { soul: 'release-manager', from: 'local-default', at: 'oats-local.yaml#/souls/launch/*', keys: [{ key: 'ghost', at: 'oats-local.yaml#/souls/launch/ghost', value: 'fast', suggestions: [] }], ...(fix === null ? {} : { fix }) } } });
/** The kernel refuses while the spawn names no launch (no harness, no launch configuration), as it does.
 * Its answer is what the CLI prints: it reaches the dialog through the preview's own exec owner
 * (packages/client/spawn-preview-cli.mjs `cliSpawnPreview`), with a refusal on exit 1, so every reader between
 * the CLI's output and the screen is the shipped one. */
const kernelFor = (host, { answer = () => refusal(), refused = () => true } = {}) =>
  (cli, args) => cliSpawnPreview(cli, args, { env: {}, exec: (_bin, _argv, _options, done) => {
    const { target, choices } = args;
    const printed = refused() && !choices.launchConfig && !choices.harness ? answer() : host.kernel(host.kernelPreviewName(target.selector.soul, choices));
    done(printed.ok === false ? Object.assign(new Error('exit 1'), { code: 1 }) : null, JSON.stringify(printed));
  } });
/** Details: the element's own text (the code, or `code · message`), then one line per kernel text. */
const details = u => { const p = u.q('.spawn-problem-detail'); return { own: [...p.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(''), lines: [...p.querySelectorAll('.spawn-problem-line')].map(n => n.textContent), children: [...p.children].map(n => `${n.tagName.toLowerCase()}.${n.className}`) }; };

test('Spawn dialog as it opens: the Desktop\'s sentence as the status and in the preview\'s place; Details hold the code, then the kernel\'s two texts under its name', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  const u = await host.mountSpawn(t, { kernel: kernelFor(host) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  // The whole sentence, in both places: the status wraps, it is not cut.
  assert.equal(u.q('.fstatus').textContent, OPENS); assert.equal(u.q('.fstatus').dataset.code, CODE); assert.ok(u.q('.fstatus').classList.contains('err'));
  assert.equal(u.text('.spawn-preview-failure'), OPENS);
  assert.doesNotMatch(u.dialog().textContent, /couldn’t work out this soul’s defaults/);
  // The sentence is the Desktop's: nothing of the kernel's texts is in it.
  assert.equal(u.q('.fstatus').textContent.includes('ghost'), false);
  // Details: closed until asked for; the code, then each kernel text on its own line, the lead before the first.
  assert.equal(u.q('.spawn-details-toggle').hidden, false); assert.equal(u.q('.spawn-problem-detail').hidden, true);
  assert.deepEqual(details(u), { own: CODE, lines: [`OATS says: ${SAID}`, REMEDY], children: ['span.spawn-problem-line', 'span.spawn-problem-line'] });
  u.q('.spawn-details-toggle').click();
  assert.equal(u.q('.spawn-problem-detail').hidden, false); assert.equal(u.q('.spawn-details-toggle').getAttribute('aria-expanded'), 'true');
  // A refused preview cannot be spawned.
  assert.equal(u.q('.fspawn').disabled, true);
  u.q('.fspawn').click(); await host.settle();
  assert.deepEqual(u.spawns(), []);
});

test('Spawn dialog: no text of the kernel\'s stands without its name, and each goes through the filter alone', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  const HIDDEN = 'token: abc123 was in the file';
  const rows = [
    [SAID, REMEDY, [`OATS says: ${SAID}`, REMEDY]],
    [HIDDEN, REMEDY, [DETAIL_WITHHELD, `OATS says: ${REMEDY}`]],
    [SAID, HIDDEN, [`OATS says: ${SAID}`, DETAIL_WITHHELD]],
    [HIDDEN, HIDDEN, [DETAIL_WITHHELD, DETAIL_WITHHELD]],
    // Several lines are one; markup is text; the remedy read twice is shown twice.
    [`first\nsecond ${REMEDY}`, REMEDY, [`OATS says: first second ${REMEDY}`, REMEDY]],
    ['<b>bold</b> <script>x</script>', '<i>it</i>', ['OATS says: <b>bold</b> <script>x</script>', '<i>it</i>']],
    // Each whole: a message and a fix at the kernel's bound are not cut.
    ['word '.repeat(204).trim(), 'step '.repeat(204).trim(), [`OATS says: ${'word '.repeat(204).trim()}`, 'step '.repeat(204).trim()]],
  ];
  for (const [message, fix, lines] of rows) {
    const u = await host.mountSpawn(t, { kernel: kernelFor(host, { answer: () => refusal(message, fix) }) });
    await u.open(); await u.type('.fpurpose', 'api-v2');
    assert.equal(u.q('.fstatus').textContent, OPENS, JSON.stringify(message).slice(0, 40));
    assert.deepEqual(details(u), { own: CODE, lines, children: lines.map(() => 'span.spawn-problem-line') }, JSON.stringify([message, fix]).slice(0, 60));
    assert.equal(u.q('.spawn-problem-detail b, .spawn-problem-detail i, .spawn-problem-detail script'), null, 'the lines are text');
  }
});

test('Spawn dialog: when the kernel\'s texts did not travel, the shorter sentence is read, so "(Details)" never points at Details with no kernel text', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  // No fix beside the message (a kernel that sends none): the message stays in Details as for any code.
  const noFix = await host.mountSpawn(t, { kernel: kernelFor(host, { answer: () => refusal(SAID, null) }) });
  await noFix.open(); await noFix.type('.fpurpose', 'api-v2');
  assert.equal(noFix.q('.fstatus').textContent, PRESSED); assert.equal(noFix.q('.fstatus').dataset.code, CODE);
  assert.equal(noFix.text('.spawn-preview-failure'), PRESSED);
  assert.deepEqual(details(noFix), { own: `${CODE} · ${SAID}`, lines: [], children: [] });
  // A message over the reader's bound: the code survives with the table's sentence, and no fix beside it. The
  // reader passes no blank message and none with a control character either (hostile input; no kernel sends one).
  for (const message of [`${SAID} ${'x'.repeat(2048)}`, '   ', `${SAID}\tmore`, `${SAID} \u001b[2J`]) {
    const u = await host.mountSpawn(t, { kernel: kernelFor(host, { answer: () => refusal(message, REMEDY) }) });
    await u.open(); await u.type('.fpurpose', 'api-v2');
    assert.equal(u.q('.fstatus').textContent, PRESSED, JSON.stringify(message).slice(0, 40)); assert.equal(u.q('.fstatus').dataset.code, CODE);
    assert.deepEqual(details(u), { own: `${CODE} · ${TABLE}`, lines: [], children: [] });
    assert.equal(u.q('.fspawn').disabled, true);
  }
});

test('Spawn dialog: Details stay as the person left them while nothing changed, and close when a line changes', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  let message = SAID, fix = REMEDY, version = 0;
  const u = await host.mountSpawn(t, { kernel: kernelFor(host, { answer: () => refusal(message, fix) }) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  // The CLI under the dialog changed: the preview for the choices on screen is read again.
  const again = async () => { const before = u.previews().length; await u.setCli({ ...structuredClone(CLI), version: `${CLI.version}-${++version}` }); await host.settle(30); assert.ok(u.previews().length > before, 'the preview was read again'); };
  u.q('.spawn-details-toggle').click();
  const status = u.q('.fstatus'), text = status.firstChild, line = u.q('.spawn-problem-line');
  // The same answer: the status is not written again (not re-announced), Details stay open, the same elements.
  await again();
  assert.equal(status.textContent, OPENS); assert.equal(status.firstChild, text); assert.equal(u.q('.spawn-problem-line'), line);
  assert.equal(u.q('.spawn-problem-detail').hidden, false); assert.equal(u.q('.spawn-details-toggle').getAttribute('aria-expanded'), 'true');
  // The kernel's fix changed and nothing else did: the lines count. They are drawn again and Details close, as for any new detail.
  fix = `${REMEDY} (again)`;
  await again();
  assert.equal(status.firstChild, text, 'the sentence did not change: it is not announced again');
  assert.deepEqual(details(u), { own: CODE, lines: [`OATS says: ${SAID}`, `${REMEDY} (again)`], children: ['span.spawn-problem-line', 'span.spawn-problem-line'] });
  assert.equal(u.q('.spawn-problem-detail').hidden, true); assert.equal(u.q('.spawn-details-toggle').getAttribute('aria-expanded'), 'false');
  assert.equal(u.q('.spawn-details-toggle').textContent, 'Details');
  // And the message.
  u.q('.spawn-details-toggle').click(); message = `${SAID}, still`;
  await again();
  assert.deepEqual(details(u).lines, [`OATS says: ${SAID}, still`, `${REMEDY} (again)`]);
  assert.equal(u.q('.spawn-problem-detail').hidden, true);
});

test('Spawn dialog: picking a harness, or a launch configuration, names the launch: the preview reads again and Spawn is enabled', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  const u = await host.mountSpawn(t, { kernel: kernelFor(host), configs: body => ({ selected: body.selector, configurations: [{ name: 'work', harness: 'claude' }] }) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  assert.equal(u.q('.fstatus').textContent, OPENS); assert.equal(u.q('.fspawn').disabled, true);
  await u.change('.fruntime', 'pi');
  assert.equal(u.previews().at(-1).choices.harness, 'pi');
  assert.equal(u.text('.fstatus'), 'Preview ready'); assert.equal(u.q('.fspawn').disabled, false);
  assert.deepEqual(details(u), { own: '', lines: [], children: [] }); assert.equal(u.q('.spawn-details-toggle').hidden, true);
  // Back to no launch named: the refusal stands again, with its lines.
  await u.change('.fruntime', '');
  assert.equal(u.q('.fstatus').textContent, OPENS); assert.deepEqual(details(u).lines, [`OATS says: ${SAID}`, REMEDY]);
  await u.change('.flaunch', 'work');
  assert.equal(u.previews().at(-1).choices.launchConfig, 'work');
  assert.equal(u.text('.fstatus'), 'Preview ready'); assert.equal(u.q('.fspawn').disabled, false);
});

test('at Spawn: the key appeared after the preview on screen settled; prepare\'s own read is refused, nothing is applied, and the dialog reads the preview again', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  let appeared = false;
  const u = await host.mountSpawn(t, { kernel: kernelFor(host, { refused: () => appeared }) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  assert.equal(u.text('.fstatus'), 'Preview ready');
  appeared = true;
  await u.spawn();
  assert.deepEqual(u.spawns().map(b => b.action), ['prepare']); assert.equal(u.applied.length, 0);
  // The press's own status is replaced at once by the preview's: the sentence that points at Details, and the kernel's texts there.
  assert.equal(u.q('.fstatus').textContent, OPENS); assert.equal(u.q('.fstatus').dataset.code, CODE);
  assert.deepEqual(details(u), { own: CODE, lines: [`OATS says: ${SAID}`, REMEDY], children: ['span.spawn-problem-line', 'span.spawn-problem-line'] });
});

test('at Spawn, in the background: the notice reads the shorter sentence, that nothing was created, and the code with the table\'s sentence as its detail', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  let appeared = false;
  const u = await host.mountSpawn(t, { jobs: true, kernel: kernelFor(host, { refused: () => appeared }) });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  appeared = true;
  u.q('.fspawn').click(); await host.settle(30);
  const note = u.notices.find(n => /launch preferences/.test(n.message));
  assert.ok(note, JSON.stringify(u.notices.map(n => n.message)));
  assert.equal(note.message, `${PRESSED} Nothing was created.`);
  assert.equal(note.options.detail, `${CODE} · ${TABLE}`);
  // No kernel text travels with a press: neither "above" nor "(Details)" is promised there, and none is shown.
  assert.doesNotMatch(note.message, /above|\(Details\)|ghost/); assert.doesNotMatch(note.options.detail, /ghost|OATS says/);
  assert.equal(u.applied.length, 0);
});

test('at Spawn: a dispatched spawn the kernel refuses with this code is an unknown outcome, as every kernel refusal there is', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  const u = await host.mountSpawn(t, { apply: () => ({ started: true, envelope: { schemaVersion: 1, ok: false, error: spawnApplyReason(CODE, SAID) } }) });
  await u.open(); await u.type('.fpurpose', 'api-v2'); await u.spawn();
  assert.equal(u.q('.fstatus').dataset.code, 'E_OUTCOME_UNKNOWN');
  assert.equal(u.text('.fstatus'), 'We couldn’t confirm whether the instance was created. Use Check result before spawning again.');
  assert.doesNotMatch(u.text('.fstatus'), /launch preferences/);
  assert.equal(u.q('.fspawn').textContent, 'Check result');
});

test('a spawn routed to a server shows the host\'s refusal as any host refusal: neither of the dialog\'s sentences, and no lines', async t => {
  const host = await import('./helpers/spawn-dialog-host.mjs');
  const facts = { server: 'build', label: 'Build host', group: 'build:1', reached: true, error: null, registered: true };
  const u = await host.mountSpawn(t, { servers: [{ id: 'build', label: 'Build host', sshHost: 'build.lan' }], teamMembers: { members: [], notReached: [], servers: [facts] },
    remote: () => { throw Object.assign(new Error(SAID), { code: CODE }); } });
  await u.open(); await u.type('.fpurpose', 'api-v2');
  await u.change('.fserver', 'build');
  await u.spawn();
  assert.equal(u.text('.fstatus'), `Couldn’t spawn on build: ${SAID}`); assert.equal(u.q('.fstatus').dataset.code, CODE);
  assert.deepEqual(details(u), { own: `${CODE} · ${SAID}`, lines: [], children: [] });
});
