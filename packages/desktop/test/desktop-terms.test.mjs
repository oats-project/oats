// The Desktop's own terms (renderer/desktop-terms.mjs) and the sentences the shared tables build from
// them. The tables of packages/client take a client's terms as an argument (#855, 1c); what the Desktop's
// operators read must be the strings they read before that, byte for byte. Each such sentence is written
// out here. That a second client's terms give none of these words is the root test's
// (test/client-terms.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DESKTOP_TERMS } from '../renderer/desktop-terms.mjs';
import { lifecycleReason, lifecycleFailure, undescribedAnswer, undescribedRefusal } from '../../client/lifecycle-contract.mjs';
import { workspaceFailure, workspaceGate, cliWorkspace } from '../../client/workspace-cli.mjs';
import { capabilityShowUnreadable } from '../../client/capability-show-contract.mjs';
import { deploymentReasonParts, deploymentReason } from '../../client/workspace-views.mjs';
import { deploymentLabelParts, deploymentLabel, machineLabels, machineLabelParts } from '../../client/deployment-label.mjs';
import { rosterSections } from '../../client/roster-sections.mjs';
import { deploymentUnavailableText } from '../../client/deployment-facts.mjs';

test("the Desktop's five terms", () => {
  assert.deepEqual({ ...DESKTOP_TERMS }, { name: 'Desktop', self: 'this Desktop', selfInitial: 'This Desktop', update: 'OATS Desktop', thisMachine: 'This Mac' });
  assert.equal(Object.isFrozen(DESKTOP_TERMS), true);
});

test("the sentences that name the Desktop are the Desktop's strings, byte for byte", async () => {
  const T = DESKTOP_TERMS;
  // lifecycle-contract.mjs
  assert.equal(lifecycleReason('E_LIFECYCLE_UNAVAILABLE', T).message, "This OATS can't stop or retire instances from Desktop. Update OATS.");
  assert.equal(lifecycleReason('E_PLAN_LIMIT', T).message, 'This would act on more instances than Desktop can show. Nothing was submitted.');
  assert.equal(lifecycleReason('E_CLI_OUTPUT_LIMIT', T).message, "OATS's answer was larger than Desktop reads safely.");
  assert.equal(lifecycleReason('E_CLI_PROTOCOL', T).message, "OATS answered in a form Desktop can't read.");
  assert.deepEqual(lifecycleFailure('E_PLAN_LIMIT', T, { target: null }), { lifecycleApi: 1, status: 'unavailable', target: null, planRef: null, plan: null, receipt: null,
    reason: { code: 'E_PLAN_LIMIT', message: 'This would act on more instances than Desktop can show. Nothing was submitted.' } });
  const undescribed = 'OATS answered with an error that Desktop has no description for.';
  assert.deepEqual(undescribedAnswer('E_LIFECYCLE_FAILED', T), { code: 'E_LIFECYCLE_FAILED', message: undescribed });
  assert.deepEqual(undescribedRefusal({ code: 'E_LIFECYCLE_FAILED', message: undescribed, detail: 'one line' }, T), { code: 'E_LIFECYCLE_FAILED', message: undescribed, detail: 'one line' });
  // workspace-cli.mjs
  const older = 'The installed OATS CLI is older than this Desktop (it does not advertise workspace-v2 and packages-no-approval). Update OATS and retry.';
  const old = { ok: true, bin: '/usr/local/bin/oats', workspaceApi: 1, features: [] };
  assert.deepEqual(workspaceFailure('E_WORKSPACE_FEATURE', T), { ok: false, reason: { code: 'E_WORKSPACE_FEATURE', message: older } });
  assert.equal(workspaceGate(old, T).reason.message, older);
  assert.equal((await cliWorkspace(old, { action: 'sync', context: '/w' }, T, { exec: assert.fail })).reason.message, older);
  // capability-show-contract.mjs
  assert.equal(capabilityShowUnreadable(T), "This Desktop can't read what this OATS version reports about the capability. Update OATS Desktop.");
  // workspace-views.mjs: the ssh step, the unreadable report, and this machine's label where none is given
  assert.deepEqual(deploymentReasonParts({ local: false, machine: 'devbox', sshHost: 'devbox.lan', probe: { ok: false, error: { code: 'E_SSH', message: 'Host key verification failed.' } } }, T), {
    short: 'ssh needs a prompt', detail: 'devbox needs ssh to connect without a prompt; run `ssh devbox.lan` once in a terminal.',
    fix: ['Run `ssh devbox.lan` once in a terminal and answer its prompt (a host key or a password).', 'Desktop tries again on its next read.'] });
  assert.equal(deploymentReason({ local: false, machine: 'devbox', probe: { ok: true }, identityStatus: 'invalid' }, T), "devbox reported a workspace this Desktop can't read.");
  assert.equal(deploymentReason({ local: true, identityStatus: 'invalid' }, T), "This Mac reported a workspace this Desktop can't read.");
  assert.equal(deploymentReason({ local: false, probe: { ok: true }, identityStatus: 'old' }, T), "This Mac's OATS is too old to report its workspace; update OATS there.");
  assert.deepEqual(deploymentReasonParts({ local: false, probe: { ok: true }, identityStatus: 'old' }, T).fix, ['Update OATS on This Mac.']);
  // deployment-label.mjs and roster-sections.mjs
  assert.deepEqual(deploymentLabelParts({ label: '~/Agents/oats' }, T), { machine: 'This Mac', path: '~/Agents/oats' });
  assert.equal(deploymentLabel({ label: '~/Agents/oats' }, T), 'This Mac · ~/Agents/oats');
  assert.equal(deploymentLabel(undefined, T), 'This Mac');
  const two = [{ id: 'a', path: '/a/oats' }, { id: 'b', path: '/b/oats-qa' }, { id: 'c', machine: 'devbox', path: '/c/web' }];
  assert.deepEqual([...machineLabels(two, T)], [['a', 'This Mac · oats'], ['b', 'This Mac · oats-qa'], ['c', 'devbox']]);
  assert.deepEqual([...machineLabelParts(two.slice(1), T)], [['b', { machine: 'This Mac', tail: '' }], ['c', { machine: 'devbox', tail: '' }]]);
  const rows = [{ instance: 'dev-1', agent: 'dev', home: '/b/oats-qa/agents/dev/instances/dev-1', deployment: { id: 'b' } }];
  assert.deepEqual(rosterSections(rows, rows, two.slice(1), T).map(s => [s.label, s.machine, s.tail]), [['This Mac', 'This Mac', '']]);
  // deployment-facts.mjs: a deployment whose kernel lacks a feature this client needs (#855, 1d)
  assert.equal(deploymentUnavailableText({ status: 'unavailable', reason: { code: 'E_DEPLOYMENT_FEATURE', feature: 'served-identity' } }, T),
    'The installed OATS CLI does not advertise served-identity, which the Desktop needs to show this deployment. Update OATS and retry.');
});

// ── Every call site passes the terms ──────────────────────────────────────────
// A table throws without terms, so a call site that forgot them fails when it runs. Not every call site
// runs in a test, so the sources are read: wherever a shipped Desktop module names a table that takes
// terms, it is an import or a call that passes DESKTOP_TERMS. Passing the function along (`invoke =
// cliWorkspace`) or binding the terms in a module of its own would hide what a call site passes.

const TABLES = ['lifecycleReason', 'lifecycleFailure', 'undescribedAnswer', 'undescribedRefusal', 'workspaceFailure', 'workspaceGate', 'cliWorkspace', 'capabilityShowUnreadable',
  'deploymentReasonParts', 'deploymentReason', 'deploymentLabelParts', 'deploymentLabel', 'machineLabels', 'machineLabelParts', 'rosterSections',
  // 1d: the sentence for a deployment that is not observed, and the views that reach a sentence or a label
  // (packages/client/panel-views.mjs): each passes the terms it is given on to the tables above.
  'deploymentUnavailableText', 'deploymentUnavailableParts', 'deploymentInfo', 'viewModel', 'viewFor', 'deploymentFor', 'surfaceDeployment', 'viewForgeContext', 'isServed',
  'teamMembersFor', 'machineScope', 'panelData', 'workspaceChoices',
  // 5a: the lifecycle boundary words every reason with the terms it is made with (packages/client/instance-lifecycle.mjs),
  // and the confirmation every plan and answer (packages/client/lifecycle-confirmation.mjs).
  'createLifecycleBoundary', 'createLifecycleConfirmation', 'planView', 'outcomeView', 'unavailableView', 'applyRunningSentence',
  // 5a-2: the start rule (packages/client/session-start.mjs; its gate, start-gate.mjs). Its `startInstance` is not read here: the renderer's
  // context has a handler of that name (shell.mjs `startInstance: instance => …`), which is no call of the rule;
  // the rule's own refuses a call without terms, and the start route's tests run it with DESKTOP_TERMS.
  'startGate',
  // 6a: the soul catalog moved to the shared home (packages/client/soul-catalog.mjs) and takes the terms its default
  // kernel read words refusals with; the backend makes it with the Desktop's.
  'createSoulCatalog',
  // 7a: the capability catalog moved to the shared home (packages/client/capability-catalog.mjs) and takes the terms the same way.
  'createCapabilityCatalog',
  // 6a: a soul's facts (packages/client/soul-facts.mjs): the kernel's lines of a launch problem are said with the terms.
  'soulFacts'];
const ROOT = new URL('../', import.meta.url);
function shippedModules(dir = '') {
  const out = [];
  for (const entry of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!['node_modules', 'test', 'dist', 'vendor', 'scripts', 'assets', 'docs'].includes(entry.name)) out.push(...shippedModules(`${dir}${entry.name}/`)); }
    else if (/\.(mjs|cjs)$/.test(entry.name) && !/^build-|^electron-builder|harness/.test(entry.name)) out.push(`${dir}${entry.name}`);
  }
  return out;
}
/** The arguments of the call whose `(` is at `open`, as text; strings and templates are skipped over. */
function argumentsAt(source, open) {
  let depth = 0, quote = null;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (--depth === 0) return source.slice(open + 1, i); }
  }
  throw new Error('a call that does not close');
}
/** The source with its comments blanked (line breaks kept), so a name in a comment is not a use. Strings,
 * templates and regular expressions are copied as they are, and the code inside a template's `${…}` is
 * read as code. A `/` starts a regular expression where a value cannot stand before it. */
function withoutComments(source) {
  let out = '', i = 0, last = '';
  const copy = to => { out += source.slice(i, to); i = to; };
  /** Code from `i`: to the end, or to the `}` that closes a template's `${` (left for the caller). */
  function code(inTemplate) {
    let depth = 0;
    while (i < source.length) {
      const c = source[i], next = source[i + 1];
      if (c === '/' && next === '/') { const end = source.indexOf('\n', i), to = end < 0 ? source.length : end; out += ' '.repeat(to - i); i = to; continue; }
      if (c === '/' && next === '*') { const end = source.indexOf('*/', i + 2), to = end < 0 ? source.length : end + 2; out += source.slice(i, to).replace(/[^\n]/g, ' '); i = to; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1; while (j < source.length && source[j] !== c && source[j] !== '\n') j += source[j] === '\\' ? 2 : 1;
        copy(j + 1); last = c; continue;
      }
      if (c === '`') { copy(i + 1); template(); last = '`'; continue; }
      if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new)$/.test(out.slice(-12).trimEnd()))) {
        let j = i + 1, set = false;
        while (j < source.length && (set || source[j] !== '/') && source[j] !== '\n') { if (source[j] === '\\') j++; else if (source[j] === '[') set = true; else if (source[j] === ']') set = false; j++; }
        copy(j + 1); last = '/'; continue;
      }
      if (inTemplate && c === '}' && depth === 0) return;
      if (c === '{') depth++; else if (c === '}') depth--;
      if (!/\s/.test(c)) last = c;
      out += c; i++;
    }
  }
  /** A template's text from after its backtick, through its closing one. */
  function template() {
    while (i < source.length) {
      const c = source[i];
      if (c === '\\') { copy(i + 2); continue; }
      if (c === '`') { copy(i + 1); return; }
      if (c === '$' && source[i + 1] === '{') { copy(i + 2); last = '{'; code(true); copy(i + 1); continue; }
      out += c; i++;
    }
  }
  code(false);
  return out;
}
/** Every place a source names a table, outside comments: `{ name, line, kind, args }`, kind 'import' | 'call' | 'other'. */
function tableUses(source) {
  const code = withoutComments(source), uses = [];
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(${TABLES.join('|')})(?![\\w$])`, 'g'))) {
    const line = code.slice(0, m.index).split('\n').length, before = code.slice(0, m.index);
    // Inside the braces of an import clause: `import { a, b` with no `}` yet.
    if (/(?:^|\n)[ \t]*import\s*\{[^}]*$/.test(before)) { uses.push({ name: m[1], line, kind: 'import' }); continue; }
    const after = m.index + m[1].length;
    if (code[after] === '(') uses.push({ name: m[1], line, kind: 'call', args: argumentsAt(code, after) });
    else uses.push({ name: m[1], line, kind: 'other' });
  }
  return uses;
}

test('every shipped Desktop module that calls a table that takes terms passes DESKTOP_TERMS, at the call', (t) => {
  const problems = [], callers = new Map();
  for (const path of shippedModules()) {
    const source = readFileSync(new URL(path, ROOT), 'utf8');
    for (const use of tableUses(source)) {
      if (use.kind === 'import') continue;
      if (use.kind !== 'call') { problems.push(`${path}:${use.line}: ${use.name} is passed along, not called: the terms it gets are not visible here`); continue; }
      callers.set(path, (callers.get(path) ?? 0) + 1);
      if (!/(^|[^\w$.])DESKTOP_TERMS(?![\w$.])/.test(use.args)) problems.push(`${path}:${use.line}: ${use.name}(…) does not pass DESKTOP_TERMS`);
    }
  }
  assert.deepEqual(problems, []);
  // Not vacuous: the reader found the call sites, in main, the backend and the page.
  assert.deepEqual([...callers.keys()].sort(), ['main.mjs', 'renderer/capability-contents.mjs', 'renderer/computer-teams.mjs', 'renderer/deployment-scope-line.mjs',
    'renderer/deployment-tabs.mjs', 'renderer/deployments-page.mjs', 'renderer/lifecycle-dialog.mjs', 'renderer/palette.mjs', 'renderer/shell.mjs',
    'renderer/soul-inspector.mjs', 'renderer/spawn-deployment-field.mjs', 'renderer/start-instance.mjs', 'renderer/views/hierarchy.mjs', 'renderer/views/spawn.mjs', 'renderer/workspace-discovery.mjs',
    'server/capability-show.mjs', 'server/oats-web.mjs', 'server/workspace-sync.mjs']);
  const calls = [...callers.values()].reduce((a, b) => a + b, 0);
  assert.ok(calls >= 48, `the call sites were read (${calls})`);
  t.diagnostic(`${calls} calls in ${callers.size} modules: ${[...callers].map(([path, n]) => `${path} ${n}`).join(', ')}`);
});

test('the reader of call sites refuses what it is there to refuse', () => {
  const kinds = source => tableUses(source).map(use => [use.kind, use.kind === 'call' ? /(^|[^\w$.])DESKTOP_TERMS(?![\w$.])/.test(use.args) : null]);
  assert.deepEqual(kinds("import { lifecycleReason } from '../../client/lifecycle-contract.mjs';\nsay(lifecycleReason(code, DESKTOP_TERMS).message);"), [['import', null], ['call', true]]);
  assert.deepEqual(kinds("import {\n  cliWorkspace, workspaceGate,\n} from '../../client/workspace-cli.mjs';"), [['import', null], ['import', null]]);
  assert.deepEqual(kinds('const reason = lifecycleReason(code);'), [['call', false]], 'a call without the terms');
  assert.deepEqual(kinds('const reason = deploymentReason({ local: true,\n  machine: label(d) });'), [['call', false]], 'on two lines');
  assert.deepEqual(kinds('const label = deploymentLabel(d, { ...DESKTOP_TERMS });'), [['call', false]], 'a spread of the terms is not the terms (the table would refuse it too)');
  assert.deepEqual(kinds("const label = deploymentLabel(d, OTHER.DESKTOP_TERMS) + deploymentLabel(d, 'DESKTOP_TERMS');").map(([, passes]) => passes), [false, true],
    'a property of that name is not the terms; a string of that name is read as code, a limit of this reader');
  assert.deepEqual(kinds('function make({ invoke = cliWorkspace } = {}) {}'), [['other', null]], 'the function passed along');
  assert.deepEqual(kinds('export { lifecycleReason };'), [['other', null]], 're-exported');
  assert.deepEqual(kinds('/** cliWorkspace drops it otherwise.\n   (packages/client: rosterSections) */\n// see lifecycleReason\nrun(); // through cliWorkspace'), [], 'comments');
  assert.deepEqual(kinds("const quoted = /['\"`]\\/\\/ [/*]/.test(x) ? lifecycleReason(code) : 1; // lifecycleReason"), [['call', false]], 'a regular expression holding quotes and slashes hides nothing after it');
  assert.deepEqual(kinds("const url = 'http://x'; const half = a / 2; const r = deploymentLabel(d); /* deploymentLabel */"), [['call', false]], 'a // inside a string, and a division');
  assert.deepEqual(kinds('const t = `a ${`b // ${deploymentLabel(d)} */` + x} // c`; machineLabels(list, DESKTOP_TERMS); // machineLabels'), [['call', false], ['call', true]], 'a template in a template: its code is read, its text is not a comment');
});

test('one module says the terms: no other shipped Desktop module makes terms or keeps a machine label of its own', () => {
  for (const path of shippedModules()) {
    const source = readFileSync(new URL(path, ROOT), 'utf8');
    if (path !== 'renderer/desktop-terms.mjs') assert.doesNotMatch(source, /\bclientTerms\b/, `${path} makes terms: the Desktop's are renderer/desktop-terms.mjs`);
    assert.doesNotMatch(source, /\bTHIS_MACHINE\b|\bCAPABILITY_SHOW_UNREADABLE\b/, `${path} names a constant the shared home no longer has`);
  }
});
