// Spec D: a remote the kernel could not read (E_REMOTE_UNREADABLE) no longer erases the roster. The shipped
// observeDeployment (server/oats-web.mjs, through packages/client/deployment-panel.mjs `failedEntry`) keeps the
// last observation, marked with the kernel's message and its bounded cause; other failures replace it as before,
// and panelData serves both fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { pendingEntry, failedEntry } from '../../client/deployment-panel.mjs';

// The server's own functions (observeDeployment) and the shared views it calls (panelData, deploymentPanel).
const source = readFileSync(new URL('../server/oats-web.mjs', import.meta.url), 'utf8') + readFileSync(new URL('../../client/panel-views.mjs', import.meta.url), 'utf8');
const fn = name => { const found = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`)); assert.ok(found, name); return found[0]; };

function server(result) {
  const context = {
    snapshot: { byWs: new Map() }, cliState: { probedAt: 1 }, admitted: new Set(['/d']), BACKGROUND_MAX_AGE: 60, observing: new Set(), beginObserving() {}, endObserving() {},
    soulCatalog: { prefetch() {} }, capabilityCatalog: { prefetch() {} }, deploymentObserver: { observe: async () => result() },
    // What a failed read becomes is the shared home's (deployment-panel.mjs), as the server imports it.
    pendingEntry, failedEntry, Date,
  };
  const run = runInNewContext(`${fn('observeDeployment')}\nobserveDeployment`, context);
  // Plain copies: values built in the sandbox carry its realm's prototypes.
  return { context, observe: async id => JSON.parse(JSON.stringify(await run(id))) };
}
const observed = { deployment: { status: 'observed', root: '/d/agents' }, instances: [{ instance: 'alpha', home: '/d/agents/a/instances/alpha', running: true }],
  generatedAt: '2026-10-01T09:00:00.000Z', observedAt: '2026-10-01T09:00:00.000Z' };
const unreadable = cause => ({ ok: false, reason: { code: 'E_REMOTE_UNREADABLE', message: 'the cache is locked by /x/index.lock; remove it', ...(cause ? { cause } : {}) } });

test('an unreadable remote keeps the last observation with the kernel message and its bounded cause', async () => {
  let reply = unreadable({ reason: 'cache' });
  const s = server(() => reply);
  s.context.snapshot.byWs.set('/d', observed);
  const kept = await s.observe('/d');
  assert.deepEqual(kept.instances, observed.instances); assert.equal(kept.observedAt, observed.observedAt, 'its age is the old observation');
  assert.equal(kept.deployment.status, 'observed');
  assert.equal(kept.error, 'the cache is locked by /x/index.lock; remove it');
  assert.deepEqual(kept.errorCause, { code: 'E_REMOTE_UNREADABLE', reason: 'cache' });
  s.context.snapshot.byWs.set('/d', kept);
  reply = unreadable(null);
  const again = await s.observe('/d');
  assert.equal(Object.hasOwn(again, 'errorCause'), false, 'a failure without a cause drops the old one');
  assert.equal(again.error, 'the cache is locked by /x/index.lock; remove it');
});

test('without an earlier observation, or for another failure, the read is unavailable as before (with the cause)', async () => {
  const s = server(() => unreadable({ reason: 'network', host: 'github.com' }));
  const none = await s.observe('/d');
  assert.equal(none.deployment.status, 'unavailable'); assert.deepEqual(none.instances, []);
  assert.deepEqual(none.deployment.reason.cause, { reason: 'network', host: 'github.com' });
  const t = server(() => ({ ok: false, reason: { code: 'E_WORKSPACE_SCHEMA', message: 'bad' } }));
  t.context.snapshot.byWs.set('/d', observed);
  const other = await t.observe('/d');
  assert.equal(other.deployment.status, 'unavailable', 'other failures are unchanged');
  const u = server(() => unreadable({ reason: 'cache' }));
  u.context.snapshot.byWs.set('/d', { deployment: { status: 'unavailable', reason: { code: 'E_X', message: 'x' } }, instances: [] });
  assert.equal((await u.observe('/d')).deployment.status, 'unavailable', 'nothing observed to keep');
});

test('panelData serves error, errorOrigin and errorCause for a local workspace only when the snapshot carries them', () => {
  // One deployment's panel is deploymentPanel (#482); a view's panel is its PRIMARY deployment's, spread whole.
  assert.match(fn('panelData'), /return \{\n\s*\.\.\.primary,/);
  const body = fn('deploymentPanel');
  // Whether a failure is kept is the shared home's one rule (deployment-facts.mjs keptFailure), asked of the entry; the
  // message is served beside who made it (#982).
  // The rows are the entry's, each stamped with the related-work gate's answer (related-work.mjs withRelatedWorkGate).
  assert.match(body, /const instances = \(observed\?\.instances \|\| \[\]\)\.map\(\(row\) => withRelatedWorkGate\(row, declared\)\), kept = keptFailure\(observed\);/);
  assert.match(body, /\.\.\.\(kept \? \{ error: kept\.message, \.\.\.\(kept\.origin \? \{ errorOrigin: kept\.origin \} : \{\}\) \} : \{\}\),/);
  assert.match(body, /observed\?\.errorCause \? \{ errorCause: observed\.errorCause \}/);
  assert.ok(body.indexOf('if (ws?.remote)') < body.indexOf('errorCause'), 'a remote panel returns before: unchanged');
});
