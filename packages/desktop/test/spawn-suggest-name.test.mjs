// The suggested name (feature spawn-suggest-name, awebai/oats#1421 §3 "The Desktop's use of it"): the contract's
// `naming`, the suggest read's argv and task file, its lane (one per workspace, the newer ending the older), the main
// proxy's body limit, and the spawn dialog: when it asks, what the field shows, and Spawn with and without a suggestion.
// The kernel is a fixture shaped like #1437's answers; no harness is ever called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { cliSpawnPreview } from '../../client/spawn-preview-cli.mjs';
import { createSpawnPreview, createSpawnPreviewFlights, createSpawnSuggestBoundary } from '../../client/spawn-preview.mjs';
import { namingOf, previewData, previewChoices, suggestSupported, suggestTask, NAMING_REASONS } from '../../client/spawn-preview-contract.mjs';
import { taskWords, namingKey, numberedWords, numberedLine, SUGGEST_DEBOUNCE_MS, SUGGEST_MIN_WORDS } from '../../client/spawn-naming.mjs';
import { proxySpawnPreview } from '../spawn-preview-proxy.mjs';
import { cli, target, selector, context, kernel, deferred, tick, DEPLOYMENT, ROOT } from './helpers/spawn-preview-fixture.mjs';
import { mountSpawn, settle, kernelPreviewName } from './helpers/spawn-dialog-host.mjs';
import { creation } from './helpers/spawn-apply-fixture.mjs';

const SUGGEST_CLI = { ...structuredClone(cli), features: [...cli.features, 'spawn-suggest-name'] };
const envelope = v => ({ schemaVersion: 1, ok: true, result: v });
const DEFAULT = kernel('preview-worktree-default').result; // numbered: release-manager-1
/** The kernel's preview of `--name <name>`: the numbered capture with its name, home and branch renamed. */
const named = name => JSON.parse(JSON.stringify(DEFAULT).replaceAll(DEFAULT.instance, name));
const suggestedNaming = { source: 'suggested', ms: 2310, harness: 'pi', model: null };
const numberedNaming = reason => ({ source: 'numbered', reason, message: 'pi exited with 1', ms: 20000 });
const plain = () => previewChoices({});
const suggestContext = () => ({ ...context(), cli: structuredClone(SUGGEST_CLI) });
const suggestRequest = (task = 'Write the release notes for 0.70', choices = {}) => ({ action: 'suggest', selector, choices, task });

// ── the contract
test('naming: suggested and numbered are projected, the kernel\'s message never; anything else refuses the preview', () => {
  assert.deepEqual(namingOf(suggestedNaming), suggestedNaming);
  assert.deepEqual(namingOf({ ...suggestedNaming, model: 'haiku', message: 'x' }), { ...suggestedNaming, model: 'haiku' });
  for (const reason of NAMING_REASONS) assert.deepEqual(namingOf(numberedNaming(reason)), { source: 'numbered', reason, ms: 20000 });
  assert.deepEqual(NAMING_REASONS, ['no-task', 'unsupported-harness', 'timeout', 'harness-failed', 'invalid-reply']);
  for (const bad of [null, {}, { ...suggestedNaming, source: 'auto' }, { ...suggestedNaming, ms: -1 }, { ...suggestedNaming, ms: 1.5 }, { ...suggestedNaming, harness: '' },
    { ...suggestedNaming, model: '' }, { ...suggestedNaming, model: 'a\nb' }, numberedNaming('nope'), { source: 'numbered', ms: 1 }]) assert.equal(namingOf(bad), null, JSON.stringify(bad));
  const data = previewData({ ...named('release-notes-manager'), naming: suggestedNaming }, target);
  assert.deepEqual(data.naming, suggestedNaming); assert.equal(data.instance, 'release-notes-manager');
  assert.equal(previewData({ ...DEFAULT, naming: { source: 'auto' } }, target), null, 'a malformed naming refuses the preview');
  assert.equal(Object.hasOwn(previewData(DEFAULT, target), 'naming'), false, 'a plain preview has none');
});

test('the gate needs spawn-suggest-name and spawn-name; the task is the apply\'s: never blank, at most 32 KiB', () => {
  assert.equal(suggestSupported(cli), false); assert.equal(suggestSupported(SUGGEST_CLI), true);
  assert.equal(suggestSupported({ ...SUGGEST_CLI, features: SUGGEST_CLI.features.filter(f => f !== 'spawn-name') }), false);
  assert.equal(suggestTask('fix login'), true);
  for (const bad of ['', '   \n', 'a\0b', 'x'.repeat(32769), 'é'.repeat(16385), 7, null]) assert.equal(suggestTask(bad), false);
  assert.equal(suggestTask('x'.repeat(32768)), true);
});

test('when the dialog asks, and how it says a numbered name', () => {
  assert.equal(SUGGEST_DEBOUNCE_MS, 300); assert.equal(SUGGEST_MIN_WORDS, 7);
  assert.equal(taskWords('fix the login'), 3); assert.equal(taskWords('  fix   login \n'), 2);
  assert.equal(taskWords('- -- fix → login'), 2, 'a run without a letter or a digit is no word');
  assert.equal(taskWords('réparer la connexion'), 3); assert.equal(taskWords(''), 0);
  assert.notEqual(namingKey(selector, 'a'), namingKey(selector, 'a ')); assert.notEqual(namingKey(selector, 'a'), namingKey({ ...selector, agentsRoot: '/other' }, 'a'));
  assert.deepEqual(NAMING_REASONS.map(r => numberedWords(r, 'claude')), ['there is no task to name it from', "Claude Code doesn't suggest names",
    'naming took longer than 20 seconds', "Claude Code couldn't be asked for a name", 'Claude Code gave no usable name']);
  assert.equal(numberedWords('unsupported-harness', 'codex'), "Codex doesn't suggest names");
  assert.equal(numberedLine('release-manager-3', 'timeout', 'pi'), 'Named release-manager-3: naming took longer than 20 seconds.');
});

// ── the CLI adapter
test('a suggest read: --suggest-name and the task in a private --task-file, removed after', async () => {
  let seen;
  const result = await cliSpawnPreview(SUGGEST_CLI, { target, choices: plain(), task: 'Write the release notes' }, { env: {}, exec: (bin, argv, opts, cb) => {
    const file = argv[argv.indexOf('--task-file') + 1];
    seen = { argv, file, text: readFileSync(file, 'utf8'), signal: opts.signal };
    cb(null, JSON.stringify(envelope({ ...named('release-notes-manager'), naming: suggestedNaming })));
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(seen.argv, ['spawn', 'release-manager', '--dir', DEPLOYMENT, '--agents-root', ROOT, '--preview', '--suggest-name', '--task-file', seen.file, '--json']);
  assert.equal(seen.text, 'Write the release notes'); assert.equal(seen.signal, undefined);
  assert.equal(existsSync(seen.file), false, 'the task file is gone');
});

test('a suggest read never takes a name or a purpose, needs the feature, and sends no blank task', async () => {
  let calls = 0; const exec = () => { calls++; };
  assert.equal((await cliSpawnPreview(cli, { target, choices: plain(), task: 'fix login' }, { exec })).error.code, 'E_PREVIEW_UNAVAILABLE');
  for (const choices of [previewChoices({ name: 'x-manager' }), previewChoices({ purpose: 'x' })]) assert.equal((await cliSpawnPreview(SUGGEST_CLI, { target, choices, task: 'fix login' }, { exec })).error.code, 'E_BAD_ARGS');
  for (const task of ['', '  ', 42]) assert.equal((await cliSpawnPreview(SUGGEST_CLI, { target, choices: plain(), task }, { exec })).error.code, 'E_BAD_ARGS');
  assert.equal((await cliSpawnPreview(SUGGEST_CLI, { target, choices: plain(), task: 'fix login', signal: 'stop' }, { exec })).error.code, 'E_BAD_ARGS');
  assert.equal(calls, 0);
});

test('ended by its signal: the CLI gets it, the read answers E_SUPERSEDED and the task file goes', async () => {
  const stop = new AbortController(); let seen;
  const pending = cliSpawnPreview(SUGGEST_CLI, { target, choices: plain(), task: 'fix login', signal: stop.signal }, { env: {}, exec: (bin, argv, opts, cb) => {
    seen = { file: argv[argv.indexOf('--task-file') + 1], opts };
    opts.signal.addEventListener('abort', () => cb(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' })));
  } });
  assert.equal(seen.opts.signal, stop.signal, 'execFile ends the CLI on abort (SIGTERM ends the kernel\'s naming call with it)');
  assert.equal(existsSync(seen.file), true);
  stop.abort();
  assert.equal((await pending).error.code, 'E_SUPERSEDED'); assert.equal(existsSync(seen.file), false);
  let calls = 0;
  assert.equal((await cliSpawnPreview(SUGGEST_CLI, { target, choices: plain(), task: 'fix login', signal: AbortSignal.abort() }, { exec: () => { calls++; } })).error.code, 'E_SUPERSEDED');
  assert.equal(calls, 0, 'an ended read runs nothing');
});

test('the task file goes on a failed and on a thrown read too', async () => {
  for (const exec of [(b, argv, o, cb) => { seen.push(argv[argv.indexOf('--task-file') + 1]); cb(Object.assign(new Error('x'), { killed: true })); },
    (b, argv) => { seen.push(argv[argv.indexOf('--task-file') + 1]); throw new Error('spawn failed'); }]) {
    var seen = [];
    const result = await cliSpawnPreview(SUGGEST_CLI, { target, choices: plain(), task: 'fix login' }, { env: {}, exec });
    assert.equal(result.ok, false); assert.equal(existsSync(seen[0]), false);
  }
});

// ── the suggest lane
test('one suggest read per workspace: a newer one ends the older, which answers E_SUPERSEDED', async () => {
  const gates = [], signals = [];
  const suggest = createSpawnSuggestBoundary({ flights: createSpawnPreviewFlights(), invoke: async (_cli, args) => {
    signals.push(args.signal); const d = deferred(); gates.push(d);
    args.signal.addEventListener('abort', () => d.resolve({ schemaVersion: 1, ok: false, error: { code: 'E_SUPERSEDED', message: 'A newer naming request replaced this one.' } }));
    return d.promise;
  } });
  const first = suggest(suggestRequest('Write the release notes'), suggestContext); await tick();
  const second = suggest(suggestRequest('Write the release notes for 0.70'), suggestContext); await tick();
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  gates[1].resolve(envelope({ ...named('release-notes-manager'), naming: suggestedNaming }));
  assert.equal((await first).reason.code, 'E_SUPERSEDED');
  const answer = await second;
  assert.equal(answer.status, 'available'); assert.deepEqual(answer.data.naming, suggestedNaming); assert.equal(answer.data.instance, 'release-notes-manager');
});

test('a suggested answer is held as the --name preview it is: the dialog\'s next read and prepare take it', async () => {
  let reads = 0;
  const preview = createSpawnPreview({ invoke: async (_cli, args) => {
    reads++;
    return args.task !== undefined ? envelope({ ...named('release-notes-manager'), naming: suggestedNaming }) : envelope(args.choices.name ? named(args.choices.name) : DEFAULT);
  } });
  const answer = await preview.suggest(suggestRequest(), suggestContext);
  assert.equal(answer.data.naming.source, 'suggested'); assert.equal(reads, 1);
  const held = await preview.read({ action: 'preview', selector, choices: { name: 'release-notes-manager' } }, suggestContext);
  assert.equal(reads, 1, 'no second kernel read'); assert.equal(held.data.instance, 'release-notes-manager'); assert.equal(Object.hasOwn(held.data, 'naming'), false);
  await preview.prepareRead({ action: 'preview', selector, choices: { name: 'release-notes-manager' } }, suggestContext); assert.equal(reads, 1);
  // A numbered answer holds nothing: its name is no --name preview.
  const numbered = createSpawnPreview({ invoke: async (_cli, args) => { reads++; return envelope(args.task !== undefined ? { ...DEFAULT, naming: numberedNaming('timeout') } : DEFAULT); } });
  reads = 0; await numbered.suggest(suggestRequest(), suggestContext); await numbered.read({ action: 'preview', selector, choices: {} }, suggestContext);
  assert.equal(reads, 2);
});

test('the suggest lane refuses what is not a suggest read, and an answer without naming', async () => {
  const flights = createSpawnPreviewFlights();
  const suggest = createSpawnSuggestBoundary({ flights, invoke: async () => envelope(DEFAULT) });
  assert.equal((await suggest(suggestRequest(), suggestContext)).reason.code, 'E_CLI_PROTOCOL');
  for (const request of [{ ...suggestRequest(), action: 'preview' }, { ...suggestRequest(), extra: 1 }, suggestRequest(''), suggestRequest('x', { name: 'x-manager' }), suggestRequest('x', { purpose: 'x' })]) {
    assert.equal((await suggest(request, suggestContext)).reason.code, 'E_BAD_ARGS', JSON.stringify(request));
  }
  assert.equal((await suggest(suggestRequest(), context)).reason.code, 'E_UNSUPPORTED_OPTION', 'a CLI without the feature');
  const preview = createSpawnPreview({ invoke: async () => envelope(DEFAULT) });
  assert.equal((await preview.read(suggestRequest(), suggestContext)).reason.code, 'E_BAD_ARGS', 'the preview read takes no task');
});

test('the suggest lane is outside the previews\' two slots', async () => {
  const held = deferred();
  const preview = createSpawnPreview({ invoke: async (_cli, args) => args.task !== undefined ? envelope({ ...DEFAULT, naming: numberedNaming('invalid-reply') }) : held.promise });
  const reads = [preview.read({ action: 'preview', selector, choices: {} }, suggestContext), preview.read({ action: 'preview', selector, choices: { purpose: 'b' } }, suggestContext)];
  await tick();
  assert.equal((await preview.read({ action: 'preview', selector, choices: { purpose: 'c' } }, suggestContext)).reason.code, 'E_BUSY');
  assert.equal((await preview.suggest(suggestRequest(), suggestContext)).data.naming.reason, 'invalid-reply');
  held.resolve(envelope(DEFAULT)); await Promise.all(reads);
});

// ── the main proxy and the route
test('the main proxy lets a suggest read carry its task (64 KiB); a preview stays at 16 KiB', async () => {
  const renderer = 'file:///fixture/index.html', frame = { url: renderer }, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } };
  const connection = { base: 'http://localhost:4820', wsId: 'northwind', allowedWs: new Set(['northwind']), epoch: 0, transition: false };
  let fetched = 0;
  const deps = { rendererURL: renderer, connection: () => connection, fetch: async () => { fetched++; return { ok: true, status: 200, text: async () => JSON.stringify({ spawnPreviewViewApi: 1, status: 'available', target, data: { ...named('release-notes-manager'), naming: suggestedNaming }, reason: null }) }; } };
  const suggestBody = JSON.stringify(suggestRequest('x'.repeat(30000)));
  const answer = await proxySpawnPreview(event, '/api/workspace-spawn-preview?ws=northwind', { method: 'POST', body: suggestBody }, deps);
  assert.equal(fetched, 1); assert.equal(answer.body.data.naming.source, 'suggested');
  const big = JSON.stringify({ action: 'preview', selector, choices: {}, pad: 'x'.repeat(16384) });
  assert.equal((await proxySpawnPreview(event, '/api/workspace-spawn-preview?ws=northwind', { method: 'POST', body: big }, deps)).body.reason.code, 'E_BAD_ARGS');
  assert.equal((await proxySpawnPreview(event, '/api/workspace-spawn-preview?ws=northwind', { method: 'POST', body: JSON.stringify(suggestRequest('x'.repeat(65536))) }, deps)).body.reason.code, 'E_BAD_ARGS');
  assert.equal(fetched, 1);
  const server = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8');
  assert.match(server, /readStrictBody\(req, 65536, true\);\n(?:\s*\/\/.*\n)*\s*const suggest = request\.action === 'suggest' \|\| request\.action === 'suggest-name';\n\s*if \(!suggest && bytes > 16384\) throw/, 'the route: 64 KiB for a suggest or suggest-name read, 16 KiB for a preview');
  assert.match(server, /if \(suggest\) return send\(res, 200, await spawnPreview\.suggest\(request, getContext\)\);\n\s*return send\(res, 200, await spawnPreview\.read\(request, getContext\)\);/);
  assert.match(readFileSync(new URL('../../client/spawn-preview.mjs', import.meta.url), 'utf8'), /suggest: createSpawnSuggestBoundary\(\{ invoke, cache, maxAge, flights, exec \}\),/, 'the suggest lane shares the preview\'s cache and clock');
});

test('the main proxy refuses a body over 64 KiB before it parses it', async t => {
  const renderer = 'file:///fixture/index.html', frame = { url: renderer }, event = { senderFrame: frame, sender: { mainFrame: frame, isDestroyed: () => false } };
  const connection = { base: 'http://localhost:4820', wsId: 'northwind', allowedWs: new Set(['northwind']), epoch: 0, transition: false };
  const deps = { rendererURL: renderer, connection: () => connection, fetch: () => assert.fail('never sent') };
  const parse = JSON.parse, parsed = [];
  JSON.parse = (text, ...rest) => { parsed.push(typeof text === 'string' ? text.length : null); return parse(text, ...rest); };
  t.after(() => { JSON.parse = parse; });
  for (const body of [JSON.stringify(suggestRequest('x'.repeat(65536))), '{' + ' '.repeat(65536) + '}', 'x'.repeat(10 * 1024 * 1024)]) {
    parsed.length = 0;
    const answer = await proxySpawnPreview(event, '/api/workspace-spawn-preview?ws=northwind', { method: 'POST', body }, deps);
    assert.equal(answer.body.reason.code, 'E_BAD_ARGS');
    assert.equal(parsed.some(n => n === body.length), false, `a ${body.length}-character body is never parsed`);
  }
});

// ── the dialog
/** A kernel for the dialog: suggest reads answer `suggest(task)`; `--name` previews the named capture (or a taken
 * refusal); everything else the f3 captures. `gate(task)` holds a suggest read. */
function namingKernel({ suggest = task => ({ source: 'suggested', name: /again/.test(task) ? 'release-notes-again-manager' : 'release-notes-manager' }), taken = new Set(), gate } = {}) {
  const asked = [];
  const invoke = async (_cli, args) => {
    if (args.task !== undefined) {
      asked.push({ task: args.task, choices: args.choices });
      await gate?.(args.task, args.signal);
      if (args.signal?.aborted) return { schemaVersion: 1, ok: false, error: { code: 'E_SUPERSEDED', message: 'superseded' } };
      const n = suggest(args.task);
      return n.source === 'suggested' ? envelope({ ...named(n.name), naming: suggestedNaming }) : envelope({ ...DEFAULT, naming: numberedNaming(n.reason) });
    }
    if (args.choices.name) return taken.has(args.choices.name) ? { schemaVersion: 1, ok: false, error: { code: 'E_INSTANCE_NAME_TAKEN', message: `${args.choices.name} is taken` } } : envelope(named(args.choices.name));
    return kernel(kernelPreviewName(args.target.selector.soul, args.choices));
  };
  return { invoke, asked };
}
const apply = args => ({ started: true, envelope: { schemaVersion: 1, ok: true, result: creation(args.choices.name ? named(args.choices.name) : DEFAULT) } });
async function dialog(t, k = namingKernel(), options = {}) {
  const u = await mountSpawn(t, { cli: SUGGEST_CLI, spawnName: true, kernel: k.invoke, apply, suggestDelay: 5, jobs: true, ...options });
  await u.open();
  return u;
}
// Typed tasks long enough to be named while typed (SUGGEST_MIN_WORDS, seven words); 'fix login' stays short: Spawn asks whatever the length.
const NOTES = 'Write the release notes for the next version', BUDGET = 'Review the budget now for the next quarter';
const pause = async () => { await new Promise(r => setTimeout(r, 15)); await settle(); };
const lastPreview = u => u.previews().filter(b => b.action === 'preview').at(-1);

test('untouched and empty: the help says the instance is named from its task; nothing is asked before typing', async t => {
  const k = namingKernel(), u = await dialog(t, k);
  assert.equal(u.text('.spawn-name-result'), 'Left empty, the instance is named from its task.');
  assert.equal(u.q('.fpurpose').placeholder, 'e.g. pricing-page-lead');
  assert.match(u.text('.spawn-preview'), /named from its task/, 'the preview\'s Name says so too');
  assert.doesNotMatch(u.text('.spawn-preview'), new RegExp(`${DEFAULT.instance}\\b`), 'nor the numbered name\'s home or branch, which Spawn would not create');
  await pause(); assert.equal(k.asked.length, 0, 'nothing runs before the person types, nor on a timer');
  await u.type('.ftask', 'release notes'); await pause();
  assert.equal(k.asked.length, 0, 'two words: no call while typing');
});

test('more than six words: six ask nothing while typing, the seventh asks once', async t => {
  const k = namingKernel(), u = await dialog(t, k);
  await u.type('.ftask', 'Write the release notes for version'); await pause();
  assert.equal(k.asked.length, 0, 'six words: no call');
  await u.type('.ftask', 'Write the release notes for version two'); await pause();
  assert.deepEqual(k.asked.map(a => a.task), ['Write the release notes for version two'], 'seven words: one call');
  await pause(); assert.equal(k.asked.length, 1, 'and no other, on no timer of its own');
  assert.equal(u.q('.fpurpose').placeholder, 'release-notes-manager');
});

test('seven words while typing: one call for the burst, the suggested name alone is the placeholder, and the preview binds it', async t => {
  const k = namingKernel(), u = await dialog(t, k);
  for (const text of NOTES.split(' ').map((_, i, words) => words.slice(0, i + 1).join(' '))) { const el = u.q('.ftask'); el.value = text; el.dispatchEvent(new u.dom.window.Event('input', { bubbles: true })); }
  await pause();
  assert.deepEqual(k.asked.map(a => a.task), [NOTES], 'one call for the burst, after the debounce');
  assert.equal(Object.hasOwn(k.asked[0].choices, 'name') || Object.hasOwn(k.asked[0].choices, 'purpose'), false);
  assert.equal(u.q('.fpurpose').placeholder, 'release-notes-manager');
  assert.equal(u.q('.fpurpose').value, '', 'the field stays empty');
  assert.equal(u.text('.spawn-name-result'), 'Instance name: release-notes-manager (from the task)');
  assert.equal(lastPreview(u).choices.name, 'release-notes-manager', 'the dialog\'s preview is the --name preview');
  assert.match(u.text('.spawn-preview'), /release-notes-manager/);
  // Another text: the suggestion no longer speaks for it, at once.
  const el = u.q('.ftask'); el.value = 'Write the release notes for the next version again'; el.dispatchEvent(new u.dom.window.Event('input', { bubbles: true }));
  assert.equal(u.q('.fpurpose').placeholder, 'e.g. pricing-page-lead');
  assert.equal(u.text('.spawn-name-result'), 'Left empty, the instance is named from its task.');
  await pause(); assert.equal(k.asked.length, 2); assert.equal(u.q('.fpurpose').placeholder, 'release-notes-again-manager');
  // Back to the first text: the answer is remembered, no second call for it.
  await u.type('.ftask', NOTES); await pause();
  assert.equal(k.asked.length, 2); assert.equal(u.q('.fpurpose').placeholder, 'release-notes-manager');
});

test('a newer text supersedes the call in the air: only the latest text\'s answer is shown', async t => {
  const holds = new Map();
  const k = namingKernel({ suggest: task => ({ source: 'suggested', name: task.includes('budget') ? 'budget-review-manager' : 'release-notes-manager' }),
    gate: (task, signal) => new Promise(resolve => { holds.set(task, resolve); signal?.addEventListener('abort', resolve); }) });
  const u = await dialog(t, k);
  await u.type('.ftask', NOTES); await pause();
  await u.type('.ftask', BUDGET); await pause();
  assert.equal(k.asked.length, 2);
  holds.get(BUDGET)(); await settle(); await pause();
  assert.equal(u.q('.fpurpose').placeholder, 'budget-review-manager');
  holds.get(NOTES)?.(); await settle();
  assert.equal(u.q('.fpurpose').placeholder, 'budget-review-manager', 'the superseded answer is dropped');
});

test('typing in the name field replaces the suggestion and stops suggestions for this dialog', async t => {
  const k = namingKernel(), u = await dialog(t, k);
  await u.type('.fpurpose', 'x'); await u.type('.fpurpose', '');
  assert.equal(u.text('.spawn-name-result'), 'Left empty, the kernel numbers it.');
  await u.type('.ftask', NOTES); await pause();
  assert.equal(k.asked.length, 0);
  await u.spawn(); await settle(20);
  assert.equal(k.asked.length, 0, 'Spawn asks for no name either');
  assert.equal(Object.hasOwn(u.applied.at(-1).choices, 'name'), false, 'numbered');
  assert.equal(u.notices.some(n => /^Named /.test(n.message)), false, 'and says nothing about naming');
});

test('Spawn with the suggestion for this text: no further call, the apply passes --name', async t => {
  const k = namingKernel(), u = await dialog(t, k);
  await u.type('.ftask', NOTES); await pause();
  await u.spawn(); await settle(20);
  assert.equal(k.asked.length, 1);
  assert.equal(u.applied.at(-1).choices.name, 'release-notes-manager');
  assert.equal(u.applied.at(-1).task, NOTES);
});

test('Spawn with no suggestion yet: "Naming…", one call whatever the length, then the suggested name', async t => {
  const hold = deferred();
  const k = namingKernel({ suggest: () => ({ source: 'suggested', name: 'login-fix-manager' }), gate: () => hold.promise });
  const u = await dialog(t, k);
  await u.type('.ftask', 'fix login'); await pause();
  assert.equal(k.asked.length, 0, 'two words: no live call');
  u.q('.fspawn').click(); await settle();
  assert.equal(u.text('.fstatus'), 'Naming…'); assert.equal(u.q('.fspawn').disabled, true);
  assert.deepEqual(k.asked.map(a => a.task), ['fix login']);
  hold.resolve(); await settle(30);
  assert.equal(u.applied.at(-1).choices.name, 'login-fix-manager');
});

test('Spawn while the live call for the same text is in the air joins it: one call', async t => {
  const hold = deferred();
  const k = namingKernel({ gate: () => hold.promise }), u = await dialog(t, k);
  await u.type('.ftask', NOTES); await pause();
  u.q('.fspawn').click(); await settle();
  assert.equal(k.asked.length, 1);
  hold.resolve(); await settle(30);
  assert.equal(k.asked.length, 1); assert.equal(u.applied.at(-1).choices.name, 'release-notes-manager');
});

test('numbered: it spawns the numbered name and says why, in the Desktop\'s words', async t => {
  const k = namingKernel({ suggest: () => ({ source: 'numbered', reason: 'timeout' }) }), u = await dialog(t, k);
  await u.type('.ftask', NOTES); await pause();
  assert.equal(k.asked.length, 1); assert.equal(u.q('.fpurpose').placeholder, 'e.g. pricing-page-lead');
  await u.spawn(); await settle(30);
  assert.equal(k.asked.length, 2, 'a numbered answer does not short-cut Spawn: one more call');
  assert.equal(Object.hasOwn(u.applied.at(-1).choices, 'name'), false);
  assert.ok(u.notices.some(n => n.message === `Named ${DEFAULT.instance}: naming took longer than 20 seconds.`), JSON.stringify(u.notices));
  assert.doesNotMatch(JSON.stringify(u.notices), /exited with/, 'the kernel\'s message is never shown');
});

test('an empty task makes no call: numbered, and the dialog says there was no task', async t => {
  const k = namingKernel(), u = await dialog(t, k);
  await u.spawn(); await settle(30);
  assert.equal(k.asked.length, 0);
  assert.equal(Object.hasOwn(u.applied.at(-1).choices, 'name'), false);
  assert.ok(u.notices.some(n => n.message === `Named ${DEFAULT.instance}: there is no task to name it from.`), JSON.stringify(u.notices));
});

test('a suggested name taken since: forgotten, and Spawn names again (the kernel gives the next one)', async t => {
  const taken = new Set();
  let n = 0;
  const k = namingKernel({ taken, suggest: () => ({ source: 'suggested', name: n++ ? 'release-notes-manager-2' : 'release-notes-manager' }) });
  const u = await dialog(t, k);
  // Taken between the suggestion and its --name preview: the preview refuses it.
  taken.add('release-notes-manager');
  await u.type('.ftask', NOTES); await pause(); await settle();
  assert.equal(u.q('.fpurpose').placeholder, 'e.g. pricing-page-lead', 'forgotten');
  assert.equal(u.q('.spawn-name-result').classList.contains('err'), false, 'never said as a refusal of a name the person typed');
  await u.spawn(); await settle(40);
  assert.equal(k.asked.length, 2, 'one more call');
  assert.equal(u.applied.at(-1).choices.name, 'release-notes-manager-2');
});

test('Reopen brings a suggested name back as the suggestion for its text, the field empty', async t => {
  const refused = () => ({ started: false, envelope: { schemaVersion: 1, ok: false, error: { code: 'E_HARNESS_UNAVAILABLE', message: 'pi is not installed' } } });
  const k = namingKernel(), u = await dialog(t, k, { apply: refused });
  await u.type('.ftask', NOTES); await pause();
  await u.spawn(); await settle(30);
  const offer = u.notices.find(n => n.options?.buttons?.some(b => b.label === 'Reopen spawn'));
  assert.ok(offer, JSON.stringify(u.notices.map(n => n.message)));
  await offer.options.buttons[0].activate(); await settle(20);
  const draft = u.reopened.at(-1).draft;
  assert.deepEqual(draft.restore.naming, { task: NOTES, name: 'release-notes-manager' });
  assert.equal(Object.hasOwn(draft.restore.choices, 'name'), false, 'never as typed'); assert.equal(draft.nameTouched, false);
  assert.equal(u.q('.fpurpose').value, ''); assert.equal(u.q('.ftask').value, NOTES);
  assert.equal(u.q('.fpurpose').placeholder, 'release-notes-manager');
  assert.equal(k.asked.length, 1, 'no new call');
});

test('Reopen keeps a typed-then-emptied name field touched', async t => {
  const refused = () => ({ started: false, envelope: { schemaVersion: 1, ok: false, error: { code: 'E_HARNESS_UNAVAILABLE', message: 'pi is not installed' } } });
  const k = namingKernel(), u = await dialog(t, k, { apply: refused });
  await u.type('.fpurpose', 'x'); await u.type('.fpurpose', ''); await u.type('.ftask', NOTES);
  await u.spawn(); await settle(30);
  await u.notices.find(n => n.options?.buttons?.some(b => b.label === 'Reopen spawn')).options.buttons[0].activate(); await settle(20);
  assert.equal(u.reopened.at(-1).draft.nameTouched, true);
  assert.equal(u.text('.spawn-name-result'), 'Left empty, the kernel numbers it.');
  await u.type('.ftask', `${NOTES} now`); await pause();
  assert.equal(k.asked.length, 0);
});

test('without the feature the dialog is today\'s: no call, and an empty name is numbered', async t => {
  const k = namingKernel(), u = await mountSpawn(t, { cli, spawnName: true, kernel: k.invoke, apply, suggestDelay: 5, jobs: true });
  await u.open();
  assert.equal(u.text('.spawn-name-result'), 'Left empty, the kernel numbers it.');
  await u.type('.ftask', NOTES); await pause(); await u.spawn(); await settle(20);
  assert.equal(k.asked.length, 0); assert.equal(Object.hasOwn(u.applied.at(-1).choices, 'name'), false);
  assert.equal(u.notices.some(n => /^Named /.test(n.message)), false);
});

test('a name taken at prepare (after the handoff): refused with Reopen, and the reopened dialog names again with one call', async t => {
  let now = 0, n = 0;
  const taken = new Set();
  const k = namingKernel({ taken, suggest: () => ({ source: 'suggested', name: n++ ? 'release-notes-manager-2' : 'release-notes-manager' }) });
  const u = await dialog(t, k, { previewNow: () => now });
  await u.type('.ftask', NOTES); await pause(); await settle();
  assert.equal(lastPreview(u).choices.name, 'release-notes-manager', 'the named preview settled');
  taken.add('release-notes-manager'); now += 300001; // past prepare's reuse window: prepare asks the kernel again
  await u.spawn(); await settle(30);
  assert.equal(k.asked.length, 1, 'the background job has no naming of its own');
  assert.equal(u.applied.length, 0, 'nothing applied');
  const offer = u.notices.find(x => x.options?.buttons?.some(b => b.label === 'Reopen spawn'));
  assert.ok(offer, JSON.stringify(u.notices.map(x => x.message)));
  await offer.options.buttons[0].activate(); await settle(30);
  assert.equal(u.q('.fpurpose').placeholder, 'e.g. pricing-page-lead', 'the reopened dialog forgot the taken name');
  await u.spawn(); await settle(40);
  assert.equal(k.asked.length, 2, 'one fresh naming call');
  assert.equal(u.applied.at(-1).choices.name, 'release-notes-manager-2');
});

test('a numbered outcome belongs to its press: a press dropped by an edit, then a new press, names again', async t => {
  let hold = null;
  const k = namingKernel({ suggest: () => ({ source: 'numbered', reason: 'timeout' }) });
  const u = await dialog(t, k, { previewGate: async body => { if (body.action === 'preview' && hold) await hold.promise; } });
  await u.type('.ftask', 'fix login'); await settle();
  hold = deferred();
  await u.type('.fmodel', 'model-one');
  u.q('.fspawn').click(); await settle(20);
  assert.equal(k.asked.length, 1, 'the press named first');
  assert.equal(u.applied.length, 0, 'and waits for the preview of its choices');
  await u.type('.fmodel', 'model-two'); // drops the press
  const h = hold; hold = null; h.resolve(); await settle(20);
  assert.equal(u.applied.length, 0, 'the dropped press never spawns');
  u.q('.fspawn').click(); await settle(30);
  assert.equal(k.asked.length, 2, 'the new press makes its own naming call');
  assert.equal(u.applied.length, 1);
});
