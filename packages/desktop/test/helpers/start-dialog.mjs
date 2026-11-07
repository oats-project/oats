import { controlHeaders } from './control-auth.mjs';
// The Start and Restart dialog over a scripted server, and the shipped HTTP handler over doubles, for the
// tests of the bare-harness choice (start-bare-harness.test.mjs) and of the sentence for a refused start
// (start-refusal-sentence.test.mjs). No kernel sentence is written here: SAID and LONG are texts of the tests' own.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
import { spawnApplyFailure } from '../../../client/spawn-apply-contract.mjs';
import { displayLine } from '../../../client/display-text.mjs';
import { launchConfigRequest } from '../../server/launch-configs.mjs';
import { createInstanceStarter } from '../../renderer/start-instance.mjs';
import { currentWorkspace, setWorkspace, httpError } from '../../renderer/views/common.mjs';
import { SPAWNERR_BLOCK, HANDLER } from './workspace-views-fixture.mjs';
import { deploymentDoubles } from './deployment-doubles.mjs';

export const CODE = 'E_LAUNCH_CONFIG_AMBIGUOUS', OTHER_CODE = 'E_LAUNCH_CONFIG_UNKNOWN';
export const LABEL = 'No launch configuration (the harness as installed)';
export const BARE_LINE = "Runs the harness itself, with no configuration's executable, arguments or environment.";
export const SENTENCE = 'More than one launch configuration is declared for the chosen harness, and none is the default. Choose one under Launch configuration, or choose "No launch configuration" to run the harness as installed.';
export const PREVIEW_ONLY = 'Preview only. No agent was started or stopped.';
/** The refusal's message in these tests: a text of their own, never the kernel's sentence. */
export const SAID = 'a text of this test: two configurations stand for that harness';
export const LONG = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' '); // well over 300 characters, inside the display bound
export const envelope = result => ({ schemaVersion: 1, ok: true, result });
export const refusal = (code, message) => ({ schemaVersion: 1, ok: false, error: { code, message } });
export const tick = () => new Promise(resolve => setImmediate(resolve));
export const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

export const HERE = { ok: true, bin: '/installed/oats', features: ['session-start', 'session-restart', 'launch-config', 'server-probe-features'], remote: ['session-start', 'session-restart', 'launch-config'] };
export const workspace = { id: '/team', scope: '/team' };
export const agents = [{ name: 'dev', agentsRoot: '/team/agents' }];
export const home = '/team/agents/dev/instances/dev-one';
export const instances = [{ home, agentsRoot: '/team/agents', savedRoute: true, addressable: true }];
/** A server's workspace, as the server holds it: its roster group beside it. */
export const onServer = probe => ({ ...workspace, remote: true, server: 'host', registrationPresent: true, group: { probe } });

/* ── The shipped HTTP handler, with the launch configurations' kernel call and the routed spawn as doubles ── */

export function http({ invoke = assert.fail, spawnAgent = assert.fail } = {}) {
  const spawnErrorPayload = new Function(`${SPAWNERR_BLOCK}\nreturn spawnErrorPayload;`)();
  const deps = { createServer: fn => fn, ...deploymentDoubles(() => [workspace]), cliState: HERE, ctxs: ['/team'], homedir: () => '/home/person',
    agentsData: () => ({ agents }), deploymentRows: () => instances, spawnPreview: { cache: { invalidate() {} } }, spawnErrorPayload, displayLine, spawnAgent, spawnApplyFailure,
    launchConfigRequest: (request, context) => launchConfigRequest(request, { ...context, invoke }) };
  const handler = new Function(...Object.keys(deps), `${HANDLER}\nreturn server;`)(...Object.values(deps));
  return async ({ url = '/api/launch-configs?ws=%2Fteam', body }) => {
    const req = new EventEmitter(); Object.assign(req, { url, method: 'POST', headers: controlHeaders({ host: 'localhost:4820', origin: 'http://localhost:4820' }) }); let result;
    const res = { writeHead(status) { result = { status }; }, end(text) { result.body = JSON.parse(text); } };
    const done = handler(req, res); req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); await done; return result;
  };
}

/* ── The dialog ── */

export const PERSONAL = { name: 'personal', harness: 'codex', source: '/team' };
/** One dialog over a scripted server. `respond.start` / `respond.preview` answer or throw; `list` is the list answer,
 * or a function of the how-manieth list read (from 1) that answers it, for a list read again after a save or a remove. */
export function dialog({ restart = false, server, list = { context: '/team', configurations: [PERSONAL], noneKnown: true }, start, preview } = {}) {
  const previous = currentWorkspace(); setWorkspace('/team');
  const dom = new JSDOM('<body><button>Open</button></body>'), doc = dom.window.document, calls = [];
  const instance = { instance: 'dev-one', home, agentsRoot: '/team/agents', runtime: 'claude', harness: 'claude', running: restart, ...(server ? { server, addressable: true } : {}) };
  const ctx = { api: async (path, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path, body });
    if (path === '/api/cli') return HERE;
    if (path.startsWith('/api/panel')) return { instances: [instance] };
    if (path === '/api/models') return { models: [] };
    if (path.startsWith('/api/launch-configs')) {
      if (body.action === 'list') return typeof list === 'function' ? list(calls.filter(call => call.body?.action === 'list').length) : list;
      if (body.action === 'set' || body.action === 'remove') return {};
      return preview ? preview(body) : { command: 'the-command', ok: true };
    }
    if (path.startsWith(`/api/${restart ? 'restart' : 'start'}/`)) return start ? start(body) : { instance: instance.instance, home };
    throw new Error(`Unexpected request: ${path}`);
  }, openTerminal: () => {} };
  const modal = createInstanceStarter(doc, ctx, { waitForReady: async () => true })(instance, { restart });
  const q = selector => modal.querySelector(selector);
  const select = q('.launch-config-select'), harness = q('.start-runtime');
  const choose = (element, value) => { element.value = value; element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); element.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  return { dom, doc, modal, q, calls, select, harness, choose,
    options: () => [...select.options].map(option => [option.value, option.textContent]),
    submit: async () => { q('form').dispatchEvent(new dom.window.Event('submit', { cancelable: true })); await settle(); },
    preview: async () => { q('.launch-preview').click(); await settle(); },
    started: () => calls.find(call => call.path.startsWith(`/api/${restart ? 'restart' : 'start'}/`))?.body,
    previewed: () => calls.filter(call => call.body?.action === 'preview').at(-1)?.body,
    close() { setWorkspace(previous); dom.window.close(); } };
}
/** Each place a dialog stands: a start and a restart, of an instance here and of a server's. */
export const PLACES = [false, true].flatMap(restart => [undefined, 'host'].map(server => [`${restart ? 'Restart' : 'Start'}, ${server ? 'a server\'s instance' : 'an instance here'}`, { restart, server }]));
/** A refusal as the shell's transport throws it (views/common.mjs httpError), from the route's body. */
export const refuse = (code, message) => () => { throw httpError({ status: 409, body: { error: message, code } }, '/api/the-route'); };
/** The same refusal as the page's own transport gives it: a response that is not ok, with the route's body. */
export const refuseAsResponse = (code, message) => () => ({ ok: false, status: 409, json: async () => ({ error: message, code }) });
/** A preview answered by the shipped handler over a kernel that refuses with `code` and `message`, as the page's transport receives it. */
export const previewThroughRoute = (code, message) => async body => { const answer = await http({ invoke: async () => refusal(code, message) })({ body }); return { ok: false, status: answer.status, json: async () => answer.body }; };

