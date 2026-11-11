// #1879 acceptance 4 (inventory): every POST (route, action) the server accepts, every operation main runs
// the CLI for, and every module that executes the CLI is classified in packages/client/above-tested.mjs as
// read, allowlisted or held back. An unclassified one fails here, so a new operation cannot land without a
// decision; and at run time an unclassified one is held back anyway (deny by default).
//
// Like inventory.test.mjs, the sources are read, never trusted to describe themselves:
// - the routes are the `/api/…` names the shipped handler compares its path with (its GET-only routes
//   are proven GET-only: a POST to one answers 404 and runs nothing);
// - every POST route reaches the gate before anything else: with the gate refusing every operation, a POST
//   to each route answers the refusal (a boundary the handler reached instead would be a missing name);
// - the actions are the ones each route's own validator accepts, read from that validator;
// - the modules are those whose code (comments stripped) starts a process or runs the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServer, juanState, A, HANDLER } from './helpers/workspace-views-fixture.mjs';
import { OPERATIONS, CLI_MODULES, READS } from '../../client/above-tested.mjs';
import { FORGE_EPOCH_HEADER, validForgeEpoch } from '../forge-proxy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const CLASSES = ['read', 'allowed', 'held'];

/** Each quoted word in `text`. */
const words = (text) => [...text.matchAll(/(["'])([a-z][a-z:-]*)\1/g)].map((m) => m[2]);
/** The actions a validator compares its request's action with: `x.action === 'a'`, `['a', 'b'].includes(x.action)`. */
function comparedActions(source) {
  const subject = String.raw`(?<![\w.])(?:(?:request|v|r|body)\??\.)?action`;
  return [
    ...[...source.matchAll(new RegExp(String.raw`${subject}\s*[!=]==\s*(["'])([a-z][a-z:-]*)\1`, 'g'))].map((m) => m[2]),
    ...[...source.matchAll(new RegExp(String.raw`\[([^\]]*)\]\.includes\(\s*${subject}\s*\)`, 'g'))].flatMap((m) => words(m[1])),
  ];
}
/** The quoted words of the list literal a named constant holds (`NAME = [ … ]`, `NAME = Object.freeze([ … ])`, `name = [ … ]` as a default). */
function listed(source, name) {
  const m = source.match(new RegExp(String.raw`\b${name}\s*=\s*(?:Object\.freeze\()?\[([^\]]*)\]`));
  assert.ok(m, `${name} is a list literal`);
  return words(m[1]);
}

// Where each route's accepted actions are decided. A route the handler serves that is not here, and not one of
// ROUTE_LEVEL, fails: add the validator that decides its actions.
const ACTIONS_FROM = {
  '/api/spawn': () => [...comparedActions(read('packages/client/spawn-apply-contract.mjs')),
    // A body with no action is the execution-server spawn (oats-web.mjs, heldBack(…, 'execution-server')).
    ...words(HANDLER.match(/heldBack\(path, Object\.hasOwn\(body, 'action'\) \? body\.action : ('[a-z-]+')\)/)?.[1] ?? '')],
  '/api/workspace-spawn-preview': () => [...comparedActions(read('packages/client/spawn-preview.mjs')),
    ...comparedActions(read('packages/client/spawn-preview-contract.mjs'))],
  '/api/instance-lifecycle': () => comparedActions(read('packages/client/instance-lifecycle.mjs')),
  '/api/instance-git': () => comparedActions(read('packages/desktop/server/instance-git.mjs')),
  '/api/instance-events': () => comparedActions(read('packages/client/instance-events-contract.mjs')),
  '/api/workspace-readiness': () => comparedActions(read('packages/desktop/server/readiness.mjs')),
  '/api/workspace-sync': () => comparedActions(read('packages/desktop/server/workspace-sync.mjs')),
  '/api/capabilities': () => [...listed(read('packages/client/inspect-boundary.mjs'), 'actions'),
    ...comparedActions(read('packages/desktop/server/capability-show.mjs'))],
  '/api/launch-configs': () => comparedActions(read('packages/desktop/server/launch-configs.mjs')),
  '/api/workspace-teams': () => listed(read('packages/desktop/server/teams.mjs'), 'TEAM_ACTIONS'),
  '/api/workspace-soul-teams': () => listed(read('packages/desktop/server/teams.mjs'), 'SOUL_ACTIONS'),
  '/api/instance-review-threads': () => comparedActions(read('packages/desktop/server/forge.mjs')),
  '/api/automations': () => {
    const m = read('packages/client/cli-adapter.mjs').match(/AUTOMATION_VERBS = Object\.freeze\(\{([^}]*)\}\)/);
    assert.ok(m, 'AUTOMATION_VERBS is an object literal of lists');
    return [...m[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)].flatMap(([, kind, verbs]) => words(verbs).map((verb) => `${kind}:${verb}`));
  },
};
// Routes whose request names no action: the route is the operation.
const ROUTE_LEVEL = ['/api/forge-connections', '/api/instance-forge', '/api/forge-roster', '/api/instance-color',
  '/api/instance-background', '/api/schedules', '/api/models', '/api/server-check', '/api/server-remove',
  '/api/server-connect', '/api/server-forget', '/api/window-state', '/api/windows', '/api/remote-roster/refresh',
  '/api/cli/reprobe', '/api/start', '/api/restart', '/api/retire'];

/** How the handler `source` routes: each route it compares its path with (`path === '…'`, `[…].includes(path)`),
 * each family it matches (`path.match(/^\/api\/<route>\/…/)`, `/^\/api\/(a|b)\/…/`: `/api/a` and `/api/b`), and
 * every other use of `path` in its code that is none of these, nor the gate's own (an argument of heldBack,
 * unclassifiedRoute or postRouteClassified, its declaration). Such a use is a way of routing this test cannot
 * read, and fails it: write the route in one of the forms above. */
function handlerRouting(source) {
  const text = code(source), routes = new Map(), unread = [];
  for (const m of text.matchAll(/path\s*===\s*(["'])(\/api\/[^"']+)\1/g)) routes.set(m[2], 'route');
  for (const m of text.matchAll(/\[([^\]]*)\]\.includes\(path\)/g)) for (const r of m[1].matchAll(/["'](\/api\/[^"']+)["']/g)) routes.set(r[1], 'route');
  for (const m of text.matchAll(/path\.match\(\/((?:\\.|[^/\\\n])+)\//g)) {
    const alternatives = m[1].match(/^\^\\\/api\\\/\(([a-z|-]+)\)\\\//), single = m[1].match(/^\^\\\/api\\\/([a-z-]+(?:\\\/[a-z-]+)*)\\\//);
    if (alternatives) for (const r of alternatives[1].split('|')) routes.set(`/api/${r}`, 'family');
    else if (single) routes.set(`/api/${single[1].replace(/\\\//g, '/')}`, 'family');
    else unread.push(`path.match(/${m[1]}/)`);
  }
  for (const m of text.matchAll(/(?<![\w.$"'`])path(?![\w$"'`])/g)) { // the variable, not a string "path"
    const before = text.slice(Math.max(0, m.index - 40), m.index), after = text.slice(m.index + 4, m.index + 44);
    const read = /^\s*[!=]==\s*["']\/api\//.test(after) || (/\.includes\($/.test(before) && /^\)/.test(after))
      || /^\.match\(\/\^\\\/api\\\//.test(after) || /\b(heldBack|unclassifiedRoute|postRouteClassified)\(\s*$/.test(before)
      || /^\s*=\s*url\.pathname;/.test(after) || (/unclassifiedRoute = \($/.test(before) && /^\) =>/.test(after));
    if (!read) unread.push(`${before.slice(-20)}path${after.slice(0, 20)}`.replace(/\s+/g, ' '));
  }
  return { routes, unread };
}
const handlerRoutes = () => handlerRouting(HANDLER).routes;
// The bodies of routes that check theirs before the gate (a refusal there runs nothing either).
const BODY = { '/api/window-state': { focused: true }, '/api/windows': { views: [null] } };
const GET_ONLY = ['/api/version', '/api/panel', '/api/agents', '/api/team-members', '/api/servers', '/api/cli', '/api/file', '/api/brain'];
const postRoutes = () => [...handlerRoutes().keys()].filter((r) => !GET_ONLY.includes(r)).sort();
/** The classified POST operations, grouped by route: route → the actions named (null for the route itself). */
function classifiedPosts() {
  const byRoute = new Map();
  for (const key of Object.keys(OPERATIONS).filter((k) => k.startsWith('POST '))) {
    const [, route, action = null] = key.split(' ');
    byRoute.set(route, [...(byRoute.get(route) ?? []), action]);
  }
  return byRoute;
}
const sorted = (list) => [...new Set(list)].sort();

test('acceptance (inventory): every classification names a known class and why', () => {
  for (const [operation, entry] of Object.entries(OPERATIONS)) {
    assert.ok(CLASSES.includes(entry.class), `${operation}: ${entry.class}`);
    assert.equal(typeof entry.reason, 'string', operation);
    assert.ok(entry.reason.length > 0, operation);
    if (entry.class === 'read') assert.ok(Object.hasOwn(READS, entry.read), `${operation} names a read of the set`);
    assert.match(operation, /^(POST \/api\/[a-z/-]+( [a-z][a-z:-]*)?|main [a-z-]+( [a-z-]+)?)$/, operation);
  }
  for (const [module, entry] of Object.entries(CLI_MODULES)) assert.ok(CLASSES.includes(entry.class), `${module}: ${entry.class}`);
});

test('acceptance (inventory): every route the handler serves by POST is classified, and nothing else is', () => {
  assert.deepEqual(handlerRouting(HANDLER).unread, [], 'the handler routes only in the forms this test reads');
  assert.deepEqual(postRoutes(), [...classifiedPosts().keys()].sort());
  assert.deepEqual(postRoutes(), sorted([...Object.keys(ACTIONS_FROM), ...ROUTE_LEVEL]), 'each POST route says where its actions are decided');
});

test('acceptance (inventory): a route added in a form the test reads is found, and one in any other form fails it', () => {
  const branch = (match) => `\n    const pm = ${match};\n    if (pm && req.method === "POST") return send(res, 200, await probe(pm[1]));\n`;
  const at = HANDLER.indexOf('    const hm = path.match(');
  const added = (text) => HANDLER.slice(0, at) + text + HANDLER.slice(at);
  // A second family, as the instance routes are written: found, so the route comparison above fails until it is classified.
  const family = handlerRouting(added(branch('path.match(/^\\/api\\/inventory-probe\\/([A-Za-z0-9._-]+)$/)')));
  assert.equal(family.routes.get('/api/inventory-probe'), 'family');
  assert.deepEqual(family.unread, []);
  assert.notDeepEqual([...family.routes.keys()].filter((r) => !GET_ONLY.includes(r)).sort(), [...classifiedPosts().keys()].sort());
  // A literal route and a list: found.
  assert.equal(handlerRouting(added('    if (path === "/api/inventory-probe" && req.method === "POST") return send(res, 200, {});\n')).routes.get('/api/inventory-probe'), 'route');
  // Any other way of routing on the path: not read, and reported.
  for (const form of ['path.startsWith("/api/inventory-probe/")', 'ROUTES[path]', '/^\\/api\\/probe/.test(path)', 'path == "/api/inventory-probe"', 'path.match(/^\\/v2\\/(x)$/)']) {
    assert.notDeepEqual(handlerRouting(added(`    if (${form}) return send(res, 200, {});\n`)).unread, [], form);
  }
});

test("acceptance (inventory): the handler's GET-only routes run nothing for a POST", async () => {
  const { request } = await loadServer(juanState().state);
  const routes = handlerRoutes();
  for (const route of GET_ONLY) {
    const answer = await request({ url: `${route}${routes.get(route) === 'family' ? '/dev' : ''}?ws=${encodeURIComponent(A)}`, method: 'POST', body: {} });
    assert.equal(answer.status, 404, `${route}: ${JSON.stringify(answer.body)}`);
  }
});

test('acceptance (inventory): every POST route asks the gate first, with its route and action, before anything runs', async () => {
  const asked = [];
  const refusal = { code: 'gate', message: 'gate' };
  // The forge routes check their epoch header first (a refusal that runs nothing): give them a valid one.
  // The instance-record routes name their boundary before the gate (a reference, not a call): doubles that
  // would record a call.
  const ran = [];
  const boundary = (name) => async () => { ran.push(name); return {}; };
  const { request } = await loadServer(juanState().state, { FORGE_EPOCH_HEADER, validForgeEpoch, MAX_WINDOW_VIEWS: 16,
    instanceColorRequest: boundary('instance-color'), instanceColorNotRun: boundary('instance-color'),
    instanceBackgroundRequest: boundary('instance-background'), instanceBackgroundNotRun: boundary('instance-background'),
    aboveTestedRefusal: (cli, operation) => { asked.push(operation); return refusal; } });
  const missed = [];
  for (const route of postRoutes()) {
    asked.length = 0;
    // Each URL as the route takes it (a forget takes no query: one is refused, and runs nothing, before the gate).
    const url = ['/api/start', '/api/restart', '/api/retire'].includes(route) ? `${route}/dev-a?ws=${encodeURIComponent(A)}`
      : route === '/api/server-forget' ? route : `${route}?ws=${encodeURIComponent(A)}`;
    const answer = await request({ url, method: 'POST', body: BODY[route] ?? { action: 'list', kind: 'trigger' } });
    const gated = answer.status === 409 && answer.body?.code === 'gate' && asked.length === 1
      && (asked[0] === `POST ${route}` || asked[0].startsWith(`POST ${route} `));
    if (!gated) missed.push(`${route}: ${answer.status} ${JSON.stringify(answer.body)}, asked ${JSON.stringify(asked)}`);
  }
  assert.deepEqual(missed, []);
  assert.deepEqual(ran, []);
});

test("acceptance (inventory): each POST route's accepted actions are exactly its classified ones", () => {
  const classified = classifiedPosts();
  for (const [route, from] of Object.entries(ACTIONS_FROM)) {
    const accepted = sorted(from());
    assert.ok(accepted.length > 0, `${route}: its validator's actions were found`);
    assert.deepEqual(accepted, sorted(classified.get(route) ?? []), `${route}: classified ${JSON.stringify(classified.get(route))}`);
  }
  for (const route of ROUTE_LEVEL) assert.deepEqual(classified.get(route), [null], `${route} is classified as a whole`);
});

test("acceptance (inventory): each deployments-list verb main runs is classified", () => {
  const verbs = [...read('packages/client/deployment-list-cli.mjs').matchAll(/case '([a-z]+)':/g)].map((m) => m[1]);
  assert.ok(verbs.length > 0);
  const named = Object.keys(OPERATIONS).filter((k) => k.startsWith('main deployments ')).map((k) => k.slice('main deployments '.length));
  assert.deepEqual(sorted(verbs), sorted(named));
  // Main asks the gate with each of these names where it runs them.
  const main = read('packages/desktop/main.mjs');
  assert.match(main, /mainRefusal\(cli, `main deployments \$\{/);
  assert.match(main, /mainRefusal\(cli, "main workspace onboard"\)/);
  assert.match(read('packages/desktop/session-resume-launch.mjs'), /aboveTestedRefusal\(probe, "main session-resume"\)/);
});

/** The code of `source` with its comments taken out (strings kept: a `//` in a URL is not a comment). */
function code(source) {
  let out = '', i = 0, quote = null;
  while (i < source.length) {
    const c = source[i], next = source[i + 1];
    if (quote) { out += c; if (c === '\\') { out += next ?? ''; i += 2; continue; } if (c === quote) quote = null; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if (c === '/' && next === '/') { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    out += c; i++;
  }
  return out;
}
// A module that executes the CLI: it starts a process, or calls a runner, an exec or a probe it was handed.
const EXECUTES = /child_process|\bexecFile\w*|\bio\.exec\b|\brunJson\b|\brunTerminalCommand\b|(?<![.\w])(?:spawn|probe|exec)\s*\(/;
const SCANNED = ['packages/client', 'packages/desktop', 'packages/desktop/server'];

test('acceptance (inventory): every module that executes the CLI is classified, and every classified module still does', () => {
  const found = [];
  for (const dir of SCANNED) {
    for (const name of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith('.mjs')).sort()) {
      const path = relative(ROOT, join(ROOT, dir, name));
      if (EXECUTES.test(code(read(path)))) found.push(path);
    }
  }
  assert.ok(found.length >= 20, `found ${found.length}`);
  assert.deepEqual(found.sort(), Object.keys(CLI_MODULES).sort());
});
