// #472: an add never drops a saved deployment that is missing at that moment (a volume not mounted
// yet). The served --dir set is only what validates now; the persisted open set (workspace-open.json)
// keeps every saved path and adds what was opened. Only an explicit remove drops a saved path. The
// add executor, the restore and the startup write run here as main.mjs wires them (source-pinned below).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  persistedOpenSet, commitOpenSet, startupOpenSet, stageDirs, restoreWorkspaceDirs, createAddExecutor, workspaceSuggestions,
} from '../workspace-registry.mjs';
import { createUnservedRefusal } from '../api-url.mjs';
import { workspaceNotServed } from '../renderer/deployment-header.mjs';

const [A, B, C] = ['/d/A', '/d/B', '/d/C'];
/** A disk whose deployments can go missing and come back (a volume unmounted, then mounted). */
function disk(...present) {
  const here = new Set(present);
  return { validate: path => (here.has(path) ? { id: path, path } : null), mount: path => here.add(path), unmount: path => here.delete(path) };
}

/** The add path as main.mjs wires it: stage the served set, commit both sets through commitOpenSet. */
function desktop({ saved, served, validate, ready = true, failWrite = false }) {
  let sets = { open: [...saved], served: [...served] };
  const writes = [], servers = [];
  const execute = createAddExecutor({
    getDirs: () => [...sets.served],
    stage: (dirs, path) => stageDirs(dirs, path, validate),
    commitDirs: dirs => { sets = commitOpenSet(sets, dirs, open => { if (failWrite) throw new Error('disk full'); writes.push(open); }); },
    replaceServer: async dirs => { servers.push(dirs); },
    refreshAdvertised: async () => true, probeVersion: async () => ({ ok: true }), isCompatible: () => true,
    advertises: async () => ready, delay: async () => {}, attempts: 2,
  });
  return { add: path => execute({ id: path, path }, () => true), sets: () => sets, writes, servers };
}

test('Juan-style: saved [A, B] with B missing, add C: persisted [A, B, C], served [A, C]', async () => {
  const d = disk(A, C); // B's volume is not mounted
  const raw = JSON.stringify([A, B]);
  // Startup: B is not served, and stays saved (nothing is written: the launch opened nothing new).
  const served = restoreWorkspaceDirs(A, raw, d.validate);
  assert.deepEqual(served, [A]);
  const startup = startupOpenSet(raw, served, d.validate);
  assert.deepEqual(startup, { open: [A, B], write: false });
  const x = desktop({ saved: startup.open, served, validate: d.validate });
  assert.equal((await x.add(C)).ok, true);
  assert.deepEqual(x.servers, [[A, C]], 'the server never starts on a missing deployment');
  assert.deepEqual(x.writes, [[A, B, C]], 'B is kept: only an explicit remove drops a saved deployment');
  assert.deepEqual(x.sets(), { open: [A, B, C], served: [A, C] });
});

test('B comes back: the next restore serves [A, B, C]', async () => {
  const d = disk(A, C);
  const x = desktop({ saved: [A, B], served: [A], validate: d.validate });
  await x.add(C);
  d.mount(B); // the volume is mounted again; the next launch reads what was persisted
  assert.deepEqual(restoreWorkspaceDirs(A, JSON.stringify(x.writes.at(-1)), d.validate), [A, B, C]);
});

test('a failed add leaves [A, B] persisted and the previous server restored', async () => {
  const d = disk(A, C);
  for (const failure of [{ ready: false }, { failWrite: true }]) {
    const x = desktop({ saved: [A, B], served: [A], validate: d.validate, ...failure });
    const result = await x.add(C);
    assert.equal(result.ok, false, JSON.stringify(failure));
    assert.deepEqual(x.writes, [], 'nothing persisted');
    assert.deepEqual(x.sets(), { open: [A, B], served: [A] }, 'both sets as they were');
    assert.deepEqual(x.servers.at(-1), [A], 'the previous server is restored');
  }
});

test('duplicates collapse: a saved path re-added, repeated entries, a served path already saved', async () => {
  assert.deepEqual(persistedOpenSet([A, B, A], [B, C, C]), [A, B, C]);
  assert.deepEqual(persistedOpenSet([A, B], [A, B]), [A, B], 'order is the saved order');
  const d = disk(A, B);
  const x = desktop({ saved: [A, B], served: [A, B], validate: d.validate });
  await x.add(B);
  assert.deepEqual(x.writes, [[A, B]]); assert.deepEqual(x.servers, [[A, B]]);
  assert.deepEqual(persistedOpenSet([A, 'relative', null, 7], [C]), [A, C], 'absolute paths only');
});

test('never empty: an add always persists what it added; startup never writes an empty set', async () => {
  const d = disk(C);
  const x = desktop({ saved: [], served: ['/d/parent'], validate: d.validate }); // a first launch from a parent folder
  await x.add(C);
  assert.deepEqual(x.writes, [[C]]); assert.deepEqual(x.servers, [[C]]);
  // A first launch from a non-deployment: nothing saved, nothing served, nothing written.
  assert.deepEqual(startupOpenSet('[]', ['/d/parent'], d.validate), { open: [], write: false });
  // Every saved deployment missing, launched from a parent folder: kept as saved, not rewritten.
  assert.deepEqual(startupOpenSet(JSON.stringify([A, B]), ['/d/parent'], d.validate), { open: [A, B], write: false });
});

test('startup keeps a missing saved deployment: a launch on a new --dir writes saved ∪ served', () => {
  const d = disk(A, C);
  const raw = JSON.stringify([A, B]);
  const served = restoreWorkspaceDirs(C, raw, d.validate);
  assert.deepEqual(served, [C, A]);
  assert.deepEqual(startupOpenSet(raw, served, d.validate), { open: [A, B, C], write: true });
  // A launch on a saved deployment adds nothing: no write.
  assert.deepEqual(startupOpenSet(raw, restoreWorkspaceDirs(A, raw, d.validate), d.validate), { open: [A, B], write: false });
});

test('a kept saved entry that is not a deployment stays inert: never served, never "not served", never suggested', async () => {
  // A pre-#464 parent-folder entry, or a folder that stopped being a deployment: the Desktop cannot tell it
  // from an unmounted volume, so it is kept, and must have no effect.
  const parent = '/d/Agents', d = disk(A, C);
  const raw = JSON.stringify([A, parent]);
  const served = restoreWorkspaceDirs(A, raw, d.validate);
  assert.deepEqual(served, [A], 'never served');
  const x = desktop({ saved: startupOpenSet(raw, served, d.validate).open, served, validate: d.validate });
  await x.add(C);
  assert.deepEqual(x.servers, [[A, C]]); assert.deepEqual(x.writes, [[A, parent, C]], 'kept, not served');
  // The proxy's not-served refusal (and so Re-add) needs a deployment that validates: a read of the kept
  // entry is proxied like any unknown id, never answered as "not served".
  const known = new Set([A, parent, C]);
  const refusal = createUnservedRefusal({ body: workspaceNotServed,
    state: () => ({ allowedWs: new Set([A, C]), known: path => known.has(path) && !!d.validate(path) }) });
  assert.equal(refusal(`/api/panel?ws=${encodeURIComponent(parent)}`), null);
  d.unmount(C); assert.equal(refusal(`/api/panel?ws=${encodeURIComponent(C)}`), null, 'a missing one is inert the same way');
  d.mount(C); d.mount(B); known.add(B);
  assert.equal(refusal(`/api/panel?ws=${encodeURIComponent(B)}`)?.status, 404, 'a deployment that validates and is not served is reported');
  // The switcher offers the served set's known deployments, each validated: never the kept entry.
  assert.deepEqual(workspaceSuggestions({ knownPaths: [...served, parent], advertised: new Set(), validate: d.validate }).map(s => s.path), [A]);
});

test('main.mjs wires the two sets: the add commits through commitOpenSet, startup through startupOpenSet; the switcher and the refusal read the known set, validated', () => {
  const source = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
  assert.match(source, /const next = commitOpenSet\(\{ open: openDirs \}, dirs, \(open\) => saveWorkspaceDirs\(OPEN_WORKSPACES_FILE\(\), open\)\);\n\s*openDirs = next\.open;\n\s*workspaceDirs\.length = 0; workspaceDirs\.push\(\.\.\.next\.served\);/);
  assert.match(source, /const startupSet = startupOpenSet\(saved, workspaceDirs, wsValidate\);\n\s*openDirs = startupSet\.open;/);
  assert.match(source, /if \(serverHost\.owned\(\) && startupSet\.write\) saveWorkspaceDirs\(OPEN_WORKSPACES_FILE\(\), startupSet\.open\);/);
  assert.equal(source.match(/saveWorkspaceDirs\(/g).length, 3, 'no other writer of the open set than these two and a Remove (#1390)');
  assert.match(source, /const open = unsavedOpenSet\(openDirs, path\);\n\s*saveWorkspaceDirs\(OPEN_WORKSPACES_FILE\(\), open\);/, 'a Remove drops only its own saved entry');
  assert.match(source, /stage: \(dirs, path\) => stageDirs\(dirs, path, wsValidate\)/, 'the served set is staged from validated deployments only');
  assert.match(source, /knownPaths: \[\.\.\.knownDirs\]/, 'suggestions read every known path (a saved one not served included); workspaceSuggestions offers only those that validate (#518)');
  assert.match(source, /known: \(path\) => knownDirs\.has\(path\) && !!wsValidate\(path\)/, 'the refusal needs a deployment that validates');
});
