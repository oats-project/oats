// An instance's colour (#1421 §2): the dot's rule (instance-dot.mjs) and its stylesheet, the backend boundary
// (server/instance-color.mjs) over `oats instance color`, its argv (cli-adapter.mjs cliInstanceColor), and the name
// and colour dialog (instance-color-dialog.mjs). The contrast of every colour on every fill a dot is drawn on is
// theme-contrast.test.mjs's (GRAPHIC_PAIRS), in every theme and the host fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { dotColor, paintDotColor } from '../renderer/instance-dot.mjs';
import { createInstanceColorBoundary, instanceColorOutcome, INSTANCE_COLOR_FEATURE } from '../server/instance-color.mjs';
import { cliInstanceColor } from '../../client/cli-adapter.mjs';
import { kernelMade } from '../../client/kernel-made.mjs';
import { GRAPHIC_PAIRS, SOUL_TONES } from '../renderer/contrast-inventory.mjs';
import { deriveHostTokens } from '../renderer/host-theme.mjs';
import { createInstanceColorDialog, instanceColorCSS, checkNote, saveOutcome, COLOR_CHOICES } from '../renderer/instance-color-dialog.mjs';
import { SOUL_COLORS } from '../../client/soul-colors.mjs';
import { paletteRows, createPalette } from '../renderer/palette.mjs';
import { projectActivePanel, activeSignature } from '../renderer/active-observation.mjs';

const renderer = new URL('../renderer/', import.meta.url);
const shellCss = readFileSync(new URL('shell.css', renderer), 'utf8');
const themeCss = readFileSync(new URL('theme.css', renderer), 'utf8');
const graph = readFileSync(new URL('views/graph.mjs', renderer), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick(); }

// ── the dot ──────────────────────────────────────────────────────────────────────────────────────────

test('the dot carries the colour only while running or stopped, and only a palette name', () => {
  assert.equal(dotColor({ color: 'sage' }, 'running'), 'sage');
  assert.equal(dotColor({ color: 'sage' }, 'stopped'), 'sage');
  assert.equal(dotColor({ color: 'sage' }, 'unknown'), null, 'unknown keeps the warning dot');
  assert.equal(dotColor({ color: null }, 'running'), null, 'no colour: today\'s look');
  for (const bad of ['red', 'SAGE', '#fff', 'var(--x)', 1, {}]) assert.equal(dotColor({ color: bad }, 'running'), null, String(bad));
  const dom = new JSDOM('<span></span>'), dot = dom.window.document.querySelector('span');
  paintDotColor(dot, { color: 'clay' }, 'running'); assert.equal(dot.dataset.instanceColor, 'clay');
  paintDotColor(dot, { color: 'clay' }, 'unknown'); assert.equal(dot.hasAttribute('data-instance-color'), false);
  paintDotColor(dot, { color: 'olive' }, 'stopped'); assert.equal(dot.dataset.instanceColor, 'olive');
  paintDotColor(dot, {}, 'stopped'); assert.equal(dot.hasAttribute('data-instance-color'), false);
  paintDotColor(null, { color: 'olive' }, 'running'); // nothing to paint: no throw
});

test('the stylesheet: each colour is its --instance-<colour>; running fills, stopped rings; no raw colour, no opacity', () => {
  for (const c of SOUL_COLORS) assert.match(shellCss, new RegExp(`\\[data-instance-color="${c}"\\] \\{ --instance-color: var\\(--instance-${c}\\); \\}`), c);
  assert.match(shellCss, /\.ctx-dot\.on\[data-instance-color\] \{ border-color: var\(--instance-color\); background: var\(--instance-color\); \}/);
  assert.match(shellCss, /\.ctx-dot\.off\[data-instance-color\] \{ border-color: var\(--instance-color\); \}/);
  assert.match(shellCss, /\.tab-dot\.on\[data-instance-color\] \{ background: var\(--instance-color\); \}/);
  assert.match(shellCss, /\.tab-dot\.off\[data-instance-color\] \{ border-color: var\(--instance-color\); \}/);
  // The Graph's nodes (slice 6b) draw the roster's own dot (.ctx-dot), painted by the one rule.
  assert.match(graph, /d\.className = `ctx-dot \$\{state === "running" \? "on" : state === "stopped" \? "off" : "unknown"\}`; paintDotColor\(d, row, state\);/);
  const rules = [...shellCss.matchAll(/[^}]*data-instance-color[^{]*\{[^}]*\}/g)].map(m => m[0]).join('\n') + instanceColorCSS;
  assert.doesNotMatch(rules.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgb\(|opacity/i);
});

// The tokens as theme.css writes them, per built-in theme (dark is the base the others override).
const tokensOf = block => new Map([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6}(?:[0-9a-f]{2})?)\b/gi)].map(m => [m[1], m[2].toLowerCase()]));
const dark = tokensOf(themeCss.match(/:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1]);
const over = name => { const m = new Map(dark); for (const [k, v] of tokensOf(themeCss.match(new RegExp(`\\[data-theme="${name}"\\] \\{([\\s\\S]*?)\\n\\}`))[1])) m.set(k, v); return m; };
const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('the contrast inventory holds every colour, as a graphic (3:1), on every fill a dot is drawn on; built in, it is the soul\'s -fg', () => {
  for (const tone of SOUL_TONES) for (const bg of ['bg', 'surface', 'surface-2', 'sel']) {
    assert.ok(GRAPHIC_PAIRS.some(([fg, b]) => fg === `instance-${tone}` && b === bg), `${tone} on ${bg}`);
  }
  assert.deepEqual([...SOUL_TONES], [...SOUL_COLORS], 'the tones are the palette');
  for (const [name, palette] of [['dark', dark], ['light', over('light')], ['solarized', over('solarized')]]) {
    for (const tone of SOUL_TONES) assert.equal(palette.get(`instance-${tone}`), palette.get(`soul-${tone}-fg`), `${name} ${tone}`);
  }
});

test('This computer: a mid-tone host palette moves the instance colours until they hold 3:1 on every fill; the soul pairs stay calibrated', () => {
  const background = '#4a4a4a', white = '#ffffff';
  const colors = { background, canvas: background, foreground: white, accent: white, brightForeground: white, selection: '#666666',
    ansi: [background, ...Array(15).fill(white)] };
  const overrides = deriveHostTokens(colors, 'dark', token => dark.get(token));
  assert.ok(overrides, 'the palette is accepted');
  const palette = new Map(dark); for (const [k, v] of Object.entries(overrides)) palette.set(k.slice(2), v);
  assert.ok(ratio(dark.get('instance-sand'), palette.get('sel')) < 3, 'the base sand alone would fail on the selected row (the review\'s case)');
  for (const tone of SOUL_TONES) for (const bg of ['bg', 'surface', 'surface-2', 'sel']) {
    assert.ok(ratio(palette.get(`instance-${tone}`), palette.get(bg)) >= 3, `${tone} on --${bg}: ${ratio(palette.get(`instance-${tone}`), palette.get(bg)).toFixed(2)}`);
  }
  for (const tone of SOUL_TONES) for (const part of ['bg', 'fg']) assert.equal(`--soul-${tone}-${part}` in overrides, false, `--soul-${tone}-${part} is not imported`);
  const unstyled = deriveHostTokens(colors, 'dark', token => (token.startsWith('instance-') ? undefined : dark.get(token)));
  assert.ok(unstyled && !('--instance-sand' in unstyled), 'no base value for it: left alone');
});

test('the palette: each instance row carries its colour by the dot rule, and its dot draws it', async t => {
  const roster = [
    { instance: 'a', home: '/h/a', agent: 'dev', agentsRoot: '/h', running: true, color: 'sage' },
    { instance: 'b', home: '/h/b', agent: 'dev', agentsRoot: '/h', running: false, color: 'clay' },
    { instance: 'c', home: '/h/c', agent: 'dev', agentsRoot: '/h', running: null, color: 'olive' },
    { instance: 'd', home: '/h/d', agent: 'dev', agentsRoot: '/h', running: true, color: 'red' },
  ];
  const rows = paletteRows(roster, [], '', { openTerminal() {} });
  assert.deepEqual(rows.map(r => [r.label, r.state, r.color]), [['a', 'running', 'sage'], ['b', 'stopped', 'clay'], ['c', 'unknown', null], ['d', 'running', null]]);
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' }); t.after(() => dom.window.close());
  const picker = createPalette({ loadInstances: async () => roster, openTerminal() {}, doc: dom.window.document }); t.after(() => picker.close());
  await picker.open();
  const dots = [...dom.window.document.querySelectorAll('.ctx-dot')].map(d => [d.className, d.dataset.instanceColor ?? null]);
  assert.deepEqual(dots, [['ctx-dot on', 'sage'], ['ctx-dot off', 'clay'], ['ctx-dot unknown', null], ['ctx-dot on', null]]);
});

test('the overview: the panel projection keeps the colour (a palette name only), and a colour change changes its signature', () => {
  const panel = color => ({ workspace: { id: 'team' }, instances: [{ instance: 'dev-1', home: '/h/dev-1', agentsRoot: '/h', running: true, ...(color === undefined ? {} : { color }) }] });
  const projected = projectActivePanel(panel('sage'));
  assert.equal(dotColor(projected.instances[0], 'running'), 'sage');
  assert.notEqual(activeSignature(projectActivePanel(panel('sage'))), activeSignature(projectActivePanel(panel('clay'))), 'a new colour redraws the canvas');
  assert.equal(Object.hasOwn(projectActivePanel(panel('red')).instances[0], 'color'), false, 'anything else is no colour');
  assert.equal(Object.hasOwn(projectActivePanel(panel(undefined)).instances[0], 'color'), false);
});

// ── the backend boundary ───────────────────────────────────────────────────────────────────────────────

const LOCAL = { id: 'team', scope: '/fixture/team' };
const REMOTE = { id: 'remote:box', scope: '/fixture/team', remote: true, server: 'box', group: { server: 'box', probe: { ok: true, features: ['instance-color'] } } };
const row = { instance: 'dev-1', home: '/fixture/team/agents/dev/instances/dev-1' };
const cli = (...features) => ({ ok: true, bin: '/fixture/oats', features: [INSTANCE_COLOR_FEATURE, ...features] });
function boundary(envelope = { schemaVersion: 1, ok: true, result: { instanceColorApi: 1, instance: 'dev-1', home: row.home, color: 'sage', changed: true } }) {
  const calls = [];
  const request = createInstanceColorBoundary({ invoke: async (bin, args, io) => { calls.push({ bin, args, io }); return typeof envelope === 'function' ? envelope() : envelope; } });
  return { calls, request };
}
const context = (over = {}) => () => ({ workspace: LOCAL, cli: cli(), instances: [row], localCwd: '/fixture/cwd', ...over });

test('boundary: exactly { instance, home, color } or { instance, home, check: true }; anything else runs nothing', async () => {
  const { calls, request } = boundary();
  for (const bad of [null, [], { instance: 'dev-1', home: row.home }, { instance: 'dev-1', home: row.home, color: 'red' },
    { instance: 'dev-1', home: row.home, color: 'sage', extra: 1 }, { instance: 'dev-1', home: 'relative', color: 'sage' },
    { instance: '../x', home: row.home, color: 'sage' }, { instance: 'dev-1', home: row.home, check: 'yes' }]) {
    assert.equal((await request(bad, context())).reason.code, 'E_BAD_ARGS', JSON.stringify(bad));
  }
  assert.equal(calls.length, 0);
});

test('boundary: only a row this computer holds, in a known workspace; a remote one only when addressable', async () => {
  const { calls, request } = boundary();
  assert.deepEqual((await request({ ...row, color: 'sage' }, context({ workspace: null }))).reason.code, 'E_WORKSPACE_UNKNOWN');
  assert.deepEqual((await request({ ...row, color: 'sage' }, context({ instances: [] }))).reason.code, 'E_SNAPSHOT_UNKNOWN');
  assert.deepEqual((await request({ ...row, color: 'sage' }, context({ instances: [{ ...row, home: '/elsewhere' }] }))).reason.code, 'E_SNAPSHOT_UNKNOWN', 'name and home together');
  const remoteRow = { ...row, server: 'box', addressable: false };
  assert.deepEqual((await request({ ...row, color: 'sage' }, context({ workspace: REMOTE, cli: cli('server-probe-features'), instances: [remoteRow] }))).status, 'not-run');
  assert.equal(calls.length, 0);
});

test('boundary: the gate is the feature, said as where it is missing; a check runs nothing', async () => {
  const { calls, request } = boundary();
  const local = await request({ ...row, color: 'sage' }, context({ cli: { ok: true, bin: '/fixture/oats', features: [] } }));
  assert.deepEqual(local, { status: 'not-run', reason: { code: 'E_INSTANCE_COLOR_UNAVAILABLE', message: "This OATS can't set an instance's colour.", details: { where: 'local' } } });
  const remoteRow = { ...row, server: 'box', addressable: true };
  const host = { ...REMOTE, group: { server: 'box', probe: { ok: true, features: [] } } };
  assert.deepEqual((await request({ ...row, check: true }, context({ workspace: host, cli: cli('server-probe-features'), instances: [remoteRow] }))).reason.details, { where: 'server' });
  assert.deepEqual((await request({ ...row, check: true }, context({ workspace: REMOTE, cli: cli(), instances: [remoteRow] }))).reason.details, { where: 'local' }, 'this CLI must relay the hosts\' features: this computer\'s to update');
  const relaysOnly = { ok: true, bin: '/fixture/oats', features: ['server-probe-features'] };
  assert.deepEqual((await request({ ...row, check: true }, context({ workspace: REMOTE, cli: relaysOnly, instances: [remoteRow] }))).reason.details, { where: 'local' }, 'the host advertises it: never blamed for this computer\'s CLI');
  assert.deepEqual(await request({ ...row, check: true }, context()), { status: 'ok', instance: 'dev-1', check: true });
  assert.deepEqual(await request({ ...row, check: true }, context({ workspace: REMOTE, cli: cli('server-probe-features'), instances: [remoteRow] })), { status: 'ok', instance: 'dev-1', check: true });
  assert.equal(calls.length, 0);
});

test('boundary: a write runs the verb in the workspace, or routed with --server for a remote row, and decodes the answer', async () => {
  const { calls, request } = boundary();
  assert.deepEqual(await request({ ...row, color: 'sage' }, context()), { status: 'ok', instance: 'dev-1', color: 'sage', changed: true });
  assert.deepEqual(calls[0], { bin: '/fixture/oats', args: { instance: 'dev-1', home: row.home, color: 'sage', context: '/fixture/team' }, io: {} });
  const remoteRow = { ...row, server: 'box', addressable: true };
  await request({ ...row, color: null }, context({ workspace: REMOTE, cli: cli('server-probe-features'), instances: [remoteRow] }));
  assert.deepEqual(calls[1], { bin: '/fixture/oats', args: { instance: 'dev-1', home: row.home, color: null, server: 'box' }, io: { cwd: '/fixture/cwd' } });
});

test('boundary: one write per home at a time; another window\'s second is refused without running', async () => {
  let release; const held = new Promise(r => { release = r; });
  const { calls, request } = boundary(() => held.then(() => ({ schemaVersion: 1, ok: true, result: { instanceColorApi: 1, instance: 'dev-1', home: row.home, color: 'sage', changed: true } })));
  const first = request({ ...row, color: 'sage' }, context());
  assert.equal((await request({ ...row, color: 'clay' }, context())).reason.code, 'E_BUSY');
  release(); assert.equal((await first).status, 'ok');
  assert.equal((await request({ ...row, color: 'clay' }, context())).status, 'ok', 'free again');
  assert.equal(calls.length, 2);
});

test('outcome: only an error the CLI printed is a refusal; the adapter\'s own, or a wrong answer, is unknown', () => {
  const asked = { instance: 'dev-1' };
  assert.deepEqual(instanceColorOutcome({ ok: false, error: kernelMade({ code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired' }) }, asked),
    { status: 'refused', reason: { code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired' } });
  assert.deepEqual(instanceColorOutcome({ ok: false, error: { code: 'E_INSTANCE_RETIRING', message: 'forged' } }, asked), { status: 'unknown', reason: { code: 'E_OUTCOME_UNKNOWN' } }, 'unmarked: not the kernel\'s');
  assert.deepEqual(instanceColorOutcome({ ok: false, error: { code: 'E_CLI_TIMEOUT' } }, asked), { status: 'unknown', reason: { code: 'E_CLI_TIMEOUT' } });
  assert.equal(instanceColorOutcome({ ok: true, result: { instanceColorApi: 1, instance: 'other', color: 'sage', changed: true } }, asked).status, 'unknown', 'another instance');
  assert.equal(instanceColorOutcome({ ok: true, result: { instanceColorApi: 1, instance: 'dev-1', color: 'red', changed: true } }, asked).status, 'unknown', 'not a palette name');
  assert.equal(instanceColorOutcome({ ok: true, result: { instanceColorApi: 2, instance: 'dev-1', color: 'sage', changed: true } }, asked).status, 'unknown');
});

test('cliInstanceColor: argv only, the colour or --clear, --home and --dir or --server, --json; refuses bad arguments without running', async () => {
  const runs = [];
  const exec = (bin, argv, opts, done) => { runs.push({ bin, argv, cwd: opts.cwd, shell: opts.shell, timeout: opts.timeout });
    done(null, JSON.stringify({ schemaVersion: 1, ok: true, result: { instanceColorApi: 1 } })); };
  await cliInstanceColor('/fixture/oats', { instance: 'dev-1', home: '/h/dev-1', context: '/fixture/team', color: 'sage' }, { exec });
  await cliInstanceColor('/fixture/oats', { instance: 'dev-1', home: '/h/dev-1', server: 'box', color: null }, { exec, cwd: '/fixture/cwd' });
  assert.deepEqual(runs, [
    { bin: '/fixture/oats', argv: ['instance', 'color', 'dev-1', 'sage', '--home', '/h/dev-1', '--dir', '/fixture/team', '--json'], cwd: '/fixture/team', shell: false, timeout: 30000 },
    { bin: '/fixture/oats', argv: ['instance', 'color', 'dev-1', '--clear', '--home', '/h/dev-1', '--server', 'box', '--json'], cwd: '/fixture/cwd', shell: false, timeout: 45000 },
  ]);
  const never = () => assert.fail('must not run');
  for (const bad of [{ instance: '-x', home: '/h', context: '/c', color: 'sage' }, { instance: 'a', home: 'h', context: '/c', color: 'sage' },
    { instance: 'a', home: '/h', context: '/c', color: 'red' }, { instance: 'a', home: '/h', server: 'Bad Host', color: 'sage' }, { instance: 'a', home: '/h', context: 'c', color: 'sage' }]) {
    assert.equal((await cliInstanceColor('/fixture/oats', bad, { exec: never })).error.code, 'E_BAD_ARGS', JSON.stringify(bad));
  }
  assert.equal((await cliInstanceColor('oats', { instance: 'a', home: '/h', context: '/c', color: 'sage' }, { exec: never })).error.code, 'E_BAD_ARGS', 'an absolute binary');
});

// ── the dialog ─────────────────────────────────────────────────────────────────────────────────────────

const words = { refused: "Couldn't set dev-1's colour." };
test('the dialog\'s sentences: a check answers a note or none; a write answers Saved., the kernel\'s refusal, the server\'s reason, or unknown', () => {
  const remoteRow = { ...row, server: 'box', repoName: 'Build box' };
  assert.equal(checkNote({ status: 'ok', instance: 'dev-1', check: true }, row), null);
  assert.equal(checkNote({ status: 'not-run', reason: { code: 'E_INSTANCE_COLOR_UNAVAILABLE', details: { where: 'local' } } }, row), 'Setting a colour needs OATS 0.67.0 or later.');
  assert.equal(checkNote({ status: 'not-run', reason: { code: 'E_INSTANCE_COLOR_UNAVAILABLE', details: { where: 'server' } } }, remoteRow), "Build box's OATS can't set colours yet.");
  assert.equal(checkNote({ status: 'not-run', reason: { code: 'E_SNAPSHOT_UNKNOWN', message: "This computer's roster no longer lists this instance." } }, row), "This computer's roster no longer lists this instance.");
  assert.equal(checkNote(null, row), "Couldn't find out whether this colour can be set.");
  assert.deepEqual(saveOutcome({ status: 'ok', instance: 'dev-1', color: 'mauve', changed: true }, row), { color: 'mauve', text: 'Saved.' });
  assert.deepEqual(saveOutcome({ status: 'ok', instance: 'dev-1', color: null, changed: false }, row), { color: null, text: 'Saved.' });
  assert.deepEqual(saveOutcome({ status: 'refused', reason: { code: 'E_LIFECYCLE_BUSY', message: 'A stop of dev-1 is running.' } }, row), { text: `${words.refused}\nOATS says: A stop of dev-1 is running.` });
  assert.deepEqual(saveOutcome({ status: 'not-run', reason: { code: 'E_BUSY', message: "Another window is changing this instance's colour. Try again." } }, row),
    { text: `${words.refused}\nAnother window is changing this instance's colour. Try again.` });
  assert.deepEqual(saveOutcome({ status: 'unknown', reason: { code: 'E_CLI_TIMEOUT' } }, row), { text: "It is not known whether dev-1's colour was saved." });
  assert.deepEqual(saveOutcome({ status: 'ok', instance: 'other', color: 'sage' }, row), { text: "It is not known whether dev-1's colour was saved." });
});

function mountDialog(t, { answer = body => (body.check ? { status: 'ok', instance: 'dev-1', check: true } : { status: 'ok', instance: 'dev-1', color: body.color, changed: true }) } = {}) {
  const dom = new JSDOM('<!doctype html><body><button id="opener">open</button></body>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  const sent = [], listeners = new Set();
  let generation = 0;
  const dialog = createInstanceColorDialog({ doc, request: async (r, body) => { sent.push(body); return typeof answer === 'function' ? answer(body) : answer; },
    generation: () => generation, subscribeWorkspace: fn => { listeners.add(fn); return () => listeners.delete(fn); } });
  t.after(() => { dialog.dispose(); dom.window.close(); });
  const opener = doc.getElementById('opener'); opener.focus();
  const q = s => doc.querySelector(s), all = s => [...doc.querySelectorAll(s)];
  const key = (el, k) => { const e = new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
  const pressed = () => all('.instance-color-swatch').filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.color);
  const switchWorkspace = () => { generation++; for (const fn of listeners) fn(); };
  return { dom, doc, dialog, sent, opener, q, all, key, pressed, switchWorkspace };
}

test('dialog: the name as text under its label, one labelled group of seven toggle buttons, the current one pressed, focus on it', async t => {
  const u = mountDialog(t);
  assert.equal(u.dialog.open({ ...row, color: 'slate' }), true);
  const dialog = u.q('[role=dialog]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true'); assert.equal(u.doc.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Name and colour');
  assert.equal(u.q('.instance-color-name').textContent, 'dev-1'); assert.equal(u.q('.instance-color-name').tagName, 'P', 'text, not an input');
  assert.equal(u.doc.getElementById(u.q('.instance-color-name').getAttribute('aria-labelledby')).textContent, 'Name');
  const group = u.q('[role=group]'); assert.equal(u.doc.getElementById(group.getAttribute('aria-labelledby')).textContent, 'Colour');
  assert.deepEqual(u.all('.instance-color-swatch').map(b => b.textContent), ['None', 'Sand', 'Sage', 'Slate', 'Mauve', 'Clay', 'Olive']);
  assert.equal(COLOR_CHOICES.length, 7);
  assert.deepEqual(u.pressed(), ['slate']);
  assert.equal(u.doc.activeElement, u.q('[data-color=slate]'), 'focus on the pressed swatch');
  assert.deepEqual(u.all('.instance-color-swatch').map(b => b.tabIndex), [-1, -1, -1, 0, -1, -1, -1], 'one tab stop');
  assert.equal(u.q('[data-color=slate]').getAttribute('aria-disabled'), 'true', 'until the check answers');
  await settle();
  assert.deepEqual(u.sent, [{ instance: 'dev-1', home: row.home, check: true }]);
  assert.equal(u.q('[data-color=slate]').hasAttribute('aria-disabled'), false);
});

test('dialog: arrows move focus and apply nothing; a press applies at once and the answer sets the pressed swatch', async t => {
  const u = mountDialog(t);
  u.dialog.open({ ...row, color: null }); await settle();
  assert.deepEqual(u.pressed(), ['none']);
  u.key(u.doc.activeElement, 'ArrowRight'); u.key(u.doc.activeElement, 'ArrowRight');
  assert.equal(u.doc.activeElement, u.q('[data-color=sage]')); assert.equal(u.doc.activeElement.tabIndex, 0);
  u.key(u.doc.activeElement, 'End'); assert.equal(u.doc.activeElement, u.q('[data-color=olive]'));
  u.key(u.doc.activeElement, 'ArrowRight'); assert.equal(u.doc.activeElement, u.q('[data-color=none]'), 'wraps');
  u.key(u.doc.activeElement, 'ArrowLeft'); u.key(u.doc.activeElement, 'Home'); u.key(u.doc.activeElement, 'ArrowDown');
  assert.equal(u.sent.length, 1, 'only the check: no arrow applied anything');
  u.q('[data-color=mauve]').click();
  assert.equal(u.q('[role=status]').textContent, 'Saving…');
  await settle();
  assert.deepEqual(u.sent.at(-1), { instance: 'dev-1', home: row.home, color: 'mauve' });
  assert.deepEqual(u.pressed(), ['mauve']); assert.equal(u.q('[role=status]').textContent, 'Saved.');
  assert.equal(u.q('.lifecycle-mark .instance-color-chip').dataset.instanceColor, 'mauve', 'the mark shows it');
  u.q('[data-color=none]').click(); await settle();
  assert.deepEqual(u.sent.at(-1), { instance: 'dev-1', home: row.home, color: null }); assert.deepEqual(u.pressed(), ['none']);
  assert.ok(u.q('[role=dialog]'), 'it stays open');
});

test('dialog: one request at a time; presses while one runs are the latest intent, and only the last answer speaks', async t => {
  const pending = [];
  const u = mountDialog(t, { answer: body => (body.check ? { status: 'ok', instance: 'dev-1', check: true }
    : new Promise(r => pending.push(() => r({ status: 'ok', instance: 'dev-1', color: body.color, changed: true })))) });
  u.dialog.open({ ...row, color: null }); await settle();
  u.q('[data-color=sand]').click(); u.q('[data-color=sage]').click(); u.q('[data-color=clay]').click();
  await settle();
  assert.deepEqual(u.sent.slice(1), [{ instance: 'dev-1', home: row.home, color: 'sand' }], 'one in flight');
  pending.shift()(); await settle();
  assert.deepEqual(u.pressed(), ['sand'], 'sand is saved: the pressed swatch, though a newer press follows');
  assert.deepEqual(u.sent.slice(1).map(b => b.color), ['sand', 'clay'], 'then the latest intent alone');
  assert.equal(u.q('[role=status]').textContent, 'Saving…', 'sand\'s words are not said: clay runs');
  pending.shift()(); await settle();
  assert.deepEqual(u.pressed(), ['clay']); assert.equal(u.q('[role=status]').textContent, 'Saved.');
});

test('dialog: a superseded answer still sets the saved colour; a refusal of the latest leaves that colour pressed', async t => {
  const pending = [];
  const u = mountDialog(t, { answer: body => (body.check ? { status: 'ok', instance: 'dev-1', check: true } : new Promise(r => pending.push(r))) });
  u.dialog.open({ ...row, color: null }); await settle();
  u.q('[data-color=sand]').click(); u.q('[data-color=clay]').click(); await settle();
  pending.shift()({ status: 'ok', instance: 'dev-1', color: 'sand', changed: true }); await settle();
  assert.deepEqual(u.sent.slice(1).map(b => b.color), ['sand', 'clay']);
  pending.shift()({ status: 'refused', reason: { code: 'E_LIFECYCLE_BUSY', message: 'A stop is running.' } }); await settle();
  assert.deepEqual(u.pressed(), ['sand'], 'Sand was saved: it is the pressed swatch');
  assert.equal(u.q('[role=status] > span:last-child').innerHTML, "Couldn't set dev-1's colour.<br>OATS says: A stop is running.");
});

test('dialog: a refusal is said under the kernel\'s name and the pressed swatch stays; the feature missing disables with its note', async t => {
  const u = mountDialog(t, { answer: body => (body.check ? { status: 'ok', instance: 'dev-1', check: true }
    : { status: 'refused', reason: { code: 'E_INSTANCE_RETIRING', message: 'dev-1 is being retired.' } }) });
  u.dialog.open({ ...row, color: 'sand' }); await settle();
  u.q('[data-color=olive]').click(); await settle();
  assert.deepEqual(u.pressed(), ['sand']);
  assert.equal(u.q('[role=status] > span:last-child').innerHTML, "Couldn't set dev-1's colour.<br>OATS says: dev-1 is being retired.");
  const v = mountDialog(t, { answer: { status: 'not-run', reason: { code: 'E_INSTANCE_COLOR_UNAVAILABLE', details: { where: 'local' } } } });
  v.dialog.open({ ...row, color: null }); await settle();
  const note = v.q('.lifecycle-note');
  assert.equal(note.textContent, 'Setting a colour needs OATS 0.67.0 or later.'); assert.equal(note.hidden, false);
  for (const b of v.all('.instance-color-swatch')) { assert.equal(b.getAttribute('aria-disabled'), 'true'); assert.equal(b.getAttribute('aria-describedby'), note.id); }
  v.q('[data-color=sage]').click(); await settle();
  assert.equal(v.sent.length, 1, 'a disabled swatch sends nothing');
});

test('dialog: a held home asks nothing and says the row\'s held line; Escape and Close return focus to the opener; a workspace change closes it', async t => {
  const u = mountDialog(t);
  u.dialog.open(row, { held: 'dev-1 is being retired.' }); await settle();
  assert.equal(u.sent.length, 0, 'no check for a held home');
  assert.equal(u.q('.lifecycle-note').textContent, 'dev-1 is being retired.');
  assert.ok(u.all('.instance-color-swatch').every(b => b.getAttribute('aria-disabled') === 'true'));
  u.key(u.doc.activeElement, 'Escape');
  assert.equal(u.q('[role=dialog]'), null); assert.equal(u.doc.activeElement, u.opener);
  u.opener.focus(); u.dialog.open(row); await settle();
  u.q('.lifecycle-close').click();
  assert.equal(u.q('[role=dialog]'), null); assert.equal(u.doc.activeElement, u.opener);
  u.dialog.open(row); u.switchWorkspace();
  assert.equal(u.q('[role=dialog]'), null, 'closed, its answer paints nothing');
});

test('dialog: Tab has two stops, the group and Close, and stays in the dialog', async t => {
  const u = mountDialog(t);
  u.dialog.open({ ...row, color: 'sage' }); await settle();
  const close = u.q('.lifecycle-close'), sage = u.q('[data-color=sage]');
  close.focus(); const e = u.key(close, 'Tab');
  assert.equal(e.defaultPrevented, true); assert.equal(u.doc.activeElement, sage);
});
