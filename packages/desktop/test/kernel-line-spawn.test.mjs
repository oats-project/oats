// With an accepted kernel that does not advertise `packages-no-approval`, can a person reach the Spawn dialog's
// preview? No, and no one function says so: the answer crosses the server's snapshot and a view. This file follows
// the value from the kernel's probe to the dialog, through the shipped server process and the shipped Spawn view.
//
// The probe is the stand-in kernel's own (helpers/load-path-server.mjs) without that one feature word, at its own
// version, inside the accepted band. No released kernel inside the band lacks the word: the band's floor is the
// first kernel the Desktop's feature gates let through (kernel-line.test.mjs). So the version band says nothing
// here; what withholds the dialog is the gates, which stay the real gate. The probe still lists
// `spawn-preview-2`, so the dialog's own preview gate is open.
//
// The chain, each step read by the test below:
//   1. the kernel is accepted (cli-locator.mjs `acceptProbe`): nothing below is the answer of a missing CLI;
//   2. the deployment observer asks `deploymentReadGate` before any read (deployment-observer.mjs `admit`),
//      and the refusal becomes an unavailable entry that keeps nothing (deployment-panel.mjs `failedEntry`);
//      the souls read stops the same way (workspace-cli.mjs `workspaceGate`), so the kernel runs no read at all;
//   3. the server lists souls only for an observed deployment (oats-web.mjs `agentsData`): none;
//   4. the preview's boundary admits a soul only from that list (packages/client/spawn-preview.mjs
//      `admitSpawnSelection`): E_SOUL_UNKNOWN, before the kernel is asked;
//   5. the view opens the dialog only for a soul of that list (views/spawn.mjs `canLaunchSoul`): no card, no
//      Spawn control, and Quick Open's way in finds nothing. It says why in the client's own sentence.
// The stand-in kernel (helpers/load-path-server.mjs) answers every read it is asked, souls included, whatever
// the probe says. So what is missing below is withheld by the Desktop's gates alone, and the same server,
// request and view reach the kernel's preview once the probe is the helper's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { startLoadPathServer } from './helpers/load-path-server.mjs';
import { acceptProbe } from '../../client/cli-locator.mjs';
import { previewSupported } from '../../client/spawn-preview-contract.mjs';
import { deploymentUnavailableText } from '../../client/deployment-facts.mjs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';

const SOUL = 'release-manager'; // a soul the stand-in kernel lists as spawnable
const GATE = 'packages-no-approval';
const lacking = probe => ({ ...probe, features: probe.features.filter(name => name !== GATE) });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** The shipped Spawn view over the server's own answers; `settled` says when its first read has landed. */
async function mountView(s, settled) {
  const dom = new JSDOM('<!doctype html><html><body><div id=host></div></body></html>', { url: 'http://localhost' });
  const old = { document: globalThis.document, window: globalThis.window };
  globalThis.document = dom.window.document; globalThis.window = dom.window;
  const [view, cliStatus] = await Promise.all([import('../renderer/views/spawn.mjs'), import('../renderer/views/cli-status.mjs')]);
  const asked = []; // every request of the view, awaited before the page goes
  const ctx = { openTerminal() {}, openBrain() {}, api(path, opts) {
    const answer = opts?.method === 'POST' ? s.post(path, JSON.parse(opts.body || '{}')) : s.get(path);
    asked.push(answer); return answer;
  } };
  await cliStatus.refreshCli(ctx);
  view.mount(dom.window.document.getElementById('host'), ctx);
  const doc = dom.window.document;
  await s.until(async () => { await tick(); return settled(doc); });
  return { doc, view, cli: cliStatus.cliStatus(), async close() {
    view.unmount(); await Promise.allSettled(asked);
    dom.window.close(); globalThis.document = old.document; globalThis.window = old.window;
  } };
}

test('an accepted kernel without packages-no-approval never reaches the Spawn dialog’s preview: the server lists no soul, the boundary knows none, the view offers none', async () => {
  let current; // the helper's own probe, of a kernel the Desktop serves whole
  const s = await startLoadPathServer({ probe: own => { current = own; return lacking(own); } });
  const refusedProbe = lacking(current);
  assert.equal(current.features.includes(GATE), true, 'the helper’s own probe has the word'); assert.equal(refusedProbe.features.includes(GATE), false);
  assert.equal(acceptProbe(refusedProbe, '0.69.17').ok, true, 'inside the accepted band');
  let mounted = null;
  try {
    const reads = () => s.calls().filter(call => !['version', 'server'].includes(call.verb)).map(call => call.verb);
    const preview = () => s.post(`/api/workspace-spawn-preview${s.ws}`, { action: 'preview', selector: { soul: SOUL, agentsRoot: `${s.deployment}/agents` }, choices: {} });
    const panelWhen = settled => s.until(async () => { const panel = await s.panel(); return settled(panel.deployment?.status) ? panel : null; });
    const use = async version => { s.reconfigure(config => { config.version = version; }); return s.post('/api/cli/reprobe', {}); };
    /** Steps 1 to 4, as the server answers them while the kernel without the word is the accepted one. `settled` says
     * which state of the deployment's entry is this kernel's own verdict. */
    const refused = async (when, settled) => {
      const cli = await s.until(async () => { const status = await s.get('/api/cli'); return status.probedAt ? status : null; });
      assert.equal(cli.ok, true, when); assert.equal(cli.version, refusedProbe.version, when);
      assert.equal(cli.features.includes(GATE), false, when);
      assert.equal(previewSupported(cli), true, `${when}: the preview's own gate is open, so it is not what stops the dialog`);
      const panel = await panelWhen(settled);
      assert.equal(panel.deployment.status, 'unavailable', when);
      assert.equal(panel.deployment.reason.code, 'E_DEPLOYMENT_FEATURE', when); assert.equal(panel.deployment.reason.feature, GATE, when);
      assert.deepEqual(panel.instances, [], when);
      const listed = await s.agents();
      assert.deepEqual(listed.agents, [], `${when}: no soul is listed`); assert.equal(Object.hasOwn(listed, 'catalog'), false, `${when}: nor a catalog to say why`);
      const answer = await preview();
      assert.equal(answer.status, 'unavailable', when); assert.equal(answer.reason.code, 'E_SOUL_UNKNOWN', when); assert.equal(answer.data, null, when);
      return panel;
    };

    const panel = await refused('from a cold start', status => status && status !== 'pending');

    // Step 5: the view, given what the server answers.
    mounted = await mountView(s, doc => doc.querySelector('.empty'));
    assert.equal(mounted.cli.ok, true, 'the view holds an accepted kernel: it is not the missing-CLI state'); assert.equal(mounted.cli.features.includes(GATE), false);
    const sentence = mounted.doc.querySelector('.empty').textContent;
    assert.equal(sentence, deploymentUnavailableText(panel.deployment, DESKTOP_TERMS));
    assert.ok(sentence.includes(GATE) && sentence.includes('Update OATS'), 'it names what is missing and asks for an update');
    assert.equal(mounted.doc.querySelectorAll('.soul-card, .soul-spawn').length, 0, 'no card and no Spawn control');
    const missed = [];
    mounted.view.preselectSpawn({ name: SOUL, agentsRoot: `${s.deployment}/agents`, onMiss: count => missed.push(count) });
    await tick();
    assert.deepEqual(missed, [0], 'Quick Open’s way into the dialog finds no such soul');
    assert.equal(mounted.doc.querySelector('.spawn-modal'), null);
    await mounted.close(); mounted = null;
    assert.deepEqual(reads(), [], 'so far the kernel was asked for its probe and the machines it knows, and for no read of the deployment');

    // The control: the helper's own probe, and the same server, request and view reach the kernel's preview.
    assert.equal((await use(current)).version, current.version);
    await s.until(async () => (await s.agents()).agents.some(agent => agent.name === SOUL));
    await preview();
    assert.ok(s.calls().some(call => call.verb === 'spawn' && call.argv.includes('--preview') && call.argv.includes(SOUL)), 'the kernel was asked for the preview');
    mounted = await mountView(s, doc => doc.querySelector('.soul-spawn'));
    const offered = [...mounted.doc.querySelectorAll('.soul-spawn')].find(button => button.getAttribute('aria-label') === `Spawn ${SOUL}`);
    assert.ok(offered && !offered.disabled, 'the view offers Spawn for the soul');
    offered.click(); await tick();
    assert.ok(mounted.doc.querySelector('.spawn-modal'), 'and its dialog opens');
    await mounted.close(); mounted = null;

    // Back to the kernel without the word with an observation held: nothing of it is kept.
    assert.equal((await use(refusedProbe)).features.includes(GATE), false);
    // The entry published before this kernel's cycle is the earlier kernel's, observed; this kernel's is the next one.
    await refused('after a kernel the Desktop serves', status => status !== 'observed');
  } finally { await mounted?.close(); await s.stop(); }
});
