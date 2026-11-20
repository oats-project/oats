import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTerminalOwnerBroker, installTerminalHandlers } from '../terminal-owner.mjs';
import { MAX_TERMINALS } from '../terminal-registry.mjs';
import { admitTerminalTarget } from '../terminal-target.mjs';
import { workspaceHash } from '../renderer/window-binding.mjs';
import { TERM_READY_MS, TERM_READY_BYTES, TERM_CLOSE_MS, HERDR_REMOVED, terminalHandle, terminalFailure } from '../../client/terminal-contract.mjs';

const url = 'file:///memory/renderer/index.html';
const drain = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  let now = 0, seq = 0, tokenSeq = 0, context = 'backend-1', gets = 0;
  const timers = new Map(), ptys = [], events = [], calls = [], handlers = new Map(), sends = new Map();
  const clock = { setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: now + ms }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const leases = new class extends Map { get(key) { gets++; return super.get(key); } }();
  const io = {
    admit(input) {
      if (options.admit) return options.admit(input);
      if (typeof input?.name !== 'string' || !input.name) throw new Error('bad fixture target');
      const spec = Object.freeze({ name: input.name, ...(input.remote ? { remote: Object.freeze({ serverId: 'memory' }) } : {}) });
      return { key: `${input.remote ? 'remote' : 'local'}:${input.name}`, spec };
    },
    async prepare(spec, control) { calls.push(['prepare', spec, control]); return options.prepare?.(spec, control); },
    create(spec, prepared, control) {
      calls.push(['create', spec]); if (options.create) return options.create(spec, prepared, control);
      const p = { writes: [], sizes: [], kills: 0, viewers: 0, data: null, exit: null };
      const pty = {
        onData(fn) { p.data = fn; return { dispose() { p.data = null; } }; },
        onExit(fn) { p.exit = fn; return { dispose() { p.exit = null; } }; },
        write(data) { p.writes.push(data); }, resize(...args) { p.sizes.push(args); },
        kill() { p.kills++; if (options.autoExit) p.exit?.({ exitCode: 0 }); },
      };
      ptys.push(p);
      return { pty, killViewer() { p.viewers++; if (options.cleanup) return options.cleanup(); } };
    },
    copyAttachments(items) { if (options.copyAttachments) return options.copyAttachments(items); return items.map(item => ({ ...item })); },
    async attachments(items, spec, control) { calls.push(['attachments', items, control]); return options.attachments?.(items, spec, control) || ['/memory/file']; },
  };
  const broker = createTerminalOwnerBroker({ rendererUrl: url, io, context: () => context, clock, leases,
    ...(options.admitFrame ? { admitFrame: options.admitFrame } : {}),
    token: options.token || (() => (++tokenSeq).toString(16).padStart(64, '0')) });
  installTerminalHandlers({ handle: (name, fn) => handlers.set(name, fn), on: (name, fn) => sends.set(name, fn) }, broker);
  function owner(name = 'owner', register = true) {
    const wc = new EventEmitter(); wc.name = name; wc.destroyed = false; wc.isDestroyed = () => wc.destroyed;
    wc.frame = () => ({ url, send: (channel, value) => events.push({ owner: name, channel, value }) });
    wc.mainFrame = wc.frame(); if (register) broker.register(wc); return wc;
  }
  const event = wc => ({ sender: wc, senderFrame: wc.mainFrame });
  const open = (wc, spec = { name: 'one' }) => handlers.get('term:open')(event(wc), spec);
  const ready = (wc, handle) => handlers.get('term:ready')(event(wc), handle);
  async function attached(wc, spec) { const result = await open(wc, spec); assert.equal(result.ok, true); assert.equal((await ready(wc, result.handle)).ok, true); return result.handle; }
  function navigate(wc) { wc.emit('did-start-navigation', { url, isSameDocument: false, isMainFrame: true }); wc.mainFrame = wc.frame(); wc.emit('did-finish-load'); }
  function tick(ms) {
    now += ms;
    while (true) {
      const due = [...timers].filter(([, t]) => t.at <= now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break; timers.delete(due[0]); due[1].fn();
    }
  }
  return { broker, owner, event, open, ready, attached, navigate, tick, ptys, events, calls, handlers, sends, timers,
    setContext: value => { context = value; }, resetGets: () => { gets = 0; }, gets: () => gets };
}

test('wire v2 refuses numeric/malformed handles and unknown failures are static', () => {
  for (const value of [1, null, {}, { id: 0, lease: 'a'.repeat(64) }, { id: 1, lease: 'short' }]) assert.equal(terminalHandle(value), null);
  const value = terminalHandle({ id: 1, lease: 'a'.repeat(64) }); assert.ok(Object.isFrozen(value));
  assert.equal(terminalFailure('secret raw process message').code, 'E_TERM_OPEN_FAILED');
  assert.equal(terminalFailure('E_TERM_CLOSE_PENDING').message, 'closing… not yet confirmed');
  assert.equal(terminalFailure('E_TERM_READY_TIMEOUT').message, 'terminal did not become ready; closed');
});

test('term:open refuses a Herdr session target with E_HERDR_REMOVED before any preparation or pty', async () => {
  const f = fixture({ admit: admitTerminalTarget }), a = f.owner('A');
  const sessionTarget = { backend: 'herdr', protocol: 20, socket: '/memory/herdr.sock', paneId: 'w1:pA', terminalId: 'term_ABC' };
  assert.deepEqual(await f.open(a, { sessionTarget }), { terminalApi: 2, ok: false, code: 'E_HERDR_REMOVED', message: HERDR_REMOVED });
  assert.equal((await f.open(a, { session: '=bad' })).code, 'E_TERM_BAD_ARGS');
  assert.deepEqual(f.calls, []); assert.equal(f.ptys.length, 0); assert.equal(f.broker.counts().slots, 0);
});

// #1488: main's admitFrame refuses a window whose hash names a workspace main no longer binds it to.
test('term:open refuses a frame admitFrame does not admit (or that throws) with E_TERM_FORBIDDEN_FRAME, before any admission or pty', async () => {
  for (const admitFrame of [() => false, () => 'yes', () => { throw new Error('gone'); }]) {
    const seen = [], f = fixture({ admitFrame: (e) => { seen.push(e); return admitFrame(e); }, admit: () => assert.fail('never admitted') }), a = f.owner('A');
    assert.deepEqual(await f.open(a), terminalFailure('E_TERM_FORBIDDEN_FRAME'));
    assert.equal(seen.length, 1); assert.equal(seen[0].sender, a, 'asked of the opening frame');
    assert.deepEqual(f.calls, []); assert.equal(f.ptys.length, 0); assert.equal(f.broker.counts().slots, 0);
  }
  const f = fixture({ admitFrame: () => true }), a = f.owner('A');
  assert.equal((await f.open(a)).ok, true, 'an admitted frame opens as before');
});

test('a remote preparation refused with E_HERDR_REMOVED returns that code and message, never E_TERM_OPEN_FAILED, and creates no pty', async () => {
  const f = fixture({ prepare: () => { throw Object.assign(new Error('kernel text'), { code: 'E_HERDR_REMOVED' }); } }), a = f.owner('A');
  assert.deepEqual(await f.open(a, { name: 'herdr-row', remote: true }), { terminalApi: 2, ok: false, code: 'E_HERDR_REMOVED', message: HERDR_REMOVED });
  assert.equal(f.ptys.length, 0); assert.equal(f.broker.counts().slots, 0);
});

test('a remote preparation keeps its transport, no-answer, no-ssh and gone codes through the broker, never E_TERM_OPEN_FAILED', async () => {
  for (const code of ['E_TERM_REMOTE_UNREACHABLE', 'E_TERM_REMOTE_GONE', 'E_TERM_REMOTE_NO_ANSWER', 'E_TERM_REMOTE_NO_SSH']) {
    const f = fixture({ prepare: () => { throw Object.assign(new Error('kernel text'), { code }); } }), a = f.owner('A');
    const result = await f.open(a, { name: 'remote-row', remote: true });
    assert.equal(result.code, code); assert.deepEqual(result, terminalFailure(code));
    assert.equal(f.ptys.length, 0); assert.equal(f.broker.counts().slots, 0);
  }
});

test('actual handlers: duplicate own target reuses; foreign target gets its own resource/lease, never the other id', async () => {
  const f = fixture(), a = f.owner('A'), b = f.owner('B');
  const [first, duplicate] = await Promise.all([f.open(a), f.open(a)]);
  assert.equal(first.status, 'opened'); assert.equal(duplicate.status, 'reused'); assert.deepEqual(first.handle, duplicate.handle);
  const foreign = await f.open(b); assert.notEqual(foreign.handle.id, first.handle.id); assert.notEqual(foreign.handle.lease, first.handle.lease);
  assert.equal(f.ptys.length, 2); assert.equal(f.broker.counts().slots, 2);
  await f.ready(a, first.handle); await f.ready(b, foreign.handle);
  f.ptys[0].data('A only'); f.ptys[1].data('B only');
  assert.deepEqual(f.events.map(e => [e.owner, e.value]), [['A', 'A only'], ['B', 'B only']]);
});

test('actual write/resize/close handlers deny foreign owner, numeric lane, same-url child and unregistered sender', async () => {
  const f = fixture(), a = f.owner('A'), b = f.owner('B'), unknown = f.owner('unknown', false), h = await f.attached(a);
  const bad = [f.event(b), f.event(unknown), { sender: a, senderFrame: { url } }, { sender: a, get senderFrame() { throw new Error('detached'); } }];
  for (const e of bad) {
    assert.equal(f.broker.write(e, h, 'bad').ok, false);
    assert.doesNotThrow(() => f.sends.get('term:write')(e, h, 'bad'));
    assert.doesNotThrow(() => f.sends.get('term:resize')(e, h, 90, 30));
    assert.equal((await f.handlers.get('term:close')(e, h)).ok, false);
  }
  f.sends.get('term:write')(f.event(a), h.id, 'numeric bypass');
  f.sends.get('term:resize')(f.event(a), h.id, 90, 30);
  assert.equal((await f.handlers.get('term:close')(f.event(a), h.id)).code, 'E_TERM_LEASE');
  assert.deepEqual(f.ptys[0].writes, []); assert.deepEqual(f.ptys[0].sizes, []); assert.equal(f.ptys[0].kills, 0);
  assert.equal(f.broker.counts().slots, 1);
});

test('hot path measured shape: exactly one lease Map.get per valid write, raw Ctrl/newline/non-ASCII preserved', async () => {
  const f = fixture(), a = f.owner(), h = await f.attached(a); f.resetGets();
  const targets = f.broker.resources()[0].owner.targets, get = targets.get.bind(targets);
  let targetGets = 0; targets.get = key => { targetGets++; return get(key); };
  for (let n = 0; n < 1000; n++) assert.equal(f.broker.write(f.event(a), h, '\x03\nλ').ok, true);
  assert.equal(f.gets(), 1000); assert.equal(targetGets, 0); assert.equal(f.ptys[0].writes.length, 1000);
  assert.equal(f.ptys[0].writes[999], '\x03\nλ');
  assert.equal(f.broker.write(f.event(a), h, 'x'.repeat(65537)).ok, false);
  assert.equal(f.broker.write(f.event(a), h, { toString() { throw new Error('must not coerce'); } }).ok, false);
  assert.equal(f.broker.resize(f.event(a), h, Infinity, 24).ok, false);
  assert.equal(f.broker.resize(f.event(a), h, 1, 1000).ok, true);
});

test('hooks exist before FIRST remote await: same-url navigation rejects old completion and holds reservation until settlement', async () => {
  const gate = deferred(), f = fixture({ prepare: () => gate.promise }), a = f.owner();
  const oldEvent = f.event(a), pending = f.handlers.get('term:open')(oldEvent, { name: 'remote', remote: true });
  await drain(); assert.equal(a.listenerCount('did-start-navigation'), 1); assert.equal(f.broker.counts().slots, 1);
  const control = f.calls.find(c => c[0] === 'prepare')[2];
  f.navigate(a); assert.equal(control.signal.aborted, true); assert.equal(f.broker.counts().slots, 1);
  gate.resolve({}); assert.equal((await pending).code, 'E_TERM_CONTEXT_CHANGED');
  assert.equal(f.ptys.length, 0); assert.equal(f.broker.counts().slots, 0);
  assert.equal((await f.open(a)).ok, true);
});

test('same-url old frame and crashed owner cannot write; child/in-place workspace navigation does not revoke the current document', async () => {
  const f = fixture(), a = f.owner(), h = await f.attached(a), oldEvent = f.event(a);
  a.emit('did-start-navigation', { url, isSameDocument: false, isMainFrame: false });
  // An in-place workspace switch (#481) rewrites the hash: the document, and its terminals, stay.
  a.mainFrame.url = `${url}${workspaceHash('/w')}`; a.emit('did-start-navigation', { url: a.mainFrame.url, isSameDocument: true, isMainFrame: true });
  // Any other hash is not the app's renderer: refused, not ignored, while it is shown.
  const bound = a.mainFrame.url; a.mainFrame.url = `${url}#section`;
  assert.equal(f.broker.write(f.event(a), h, 'foreign hash').ok, false);
  a.mainFrame.url = bound;
  assert.equal(f.broker.write(f.event(a), h, 'still owner').ok, true);
  f.navigate(a); assert.equal(f.broker.write(oldEvent, h, 'stale').ok, false);
  assert.equal(f.broker.write(f.event(a), h, 'same WC new epoch').ok, false);
  const fresh = await f.attached(a, { name: 'fresh' }); a.emit('render-process-gone');
  assert.equal(f.broker.write(f.event(a), fresh, 'crashed').ok, false);
  assert.deepEqual(f.ptys[0].writes, ['still owner']);
});

test('global cap includes revoked preparations across owners and backend families, until real settlement', async () => {
  const gate = deferred(), f = fixture({ prepare: () => gate.promise }), a = f.owner('A'), b = f.owner('B');
  const pending = Array.from({ length: MAX_TERMINALS }, (_, n) => f.open(n % 2 ? a : b, { name: `r${n}`, remote: true }));
  await drain(); assert.equal(f.calls.filter(c => c[0] === 'prepare').length, MAX_TERMINALS);
  f.navigate(a); f.navigate(b);
  assert.equal((await f.open(a, { name: 'local' })).code, 'E_TERM_CAP'); assert.equal(f.broker.counts().slots, MAX_TERMINALS);
  gate.resolve({}); for (const result of await Promise.all(pending)) assert.equal(result.code, 'E_TERM_CONTEXT_CHANGED');
  assert.equal(f.broker.counts().slots, 0); assert.equal(f.ptys.length, 0);
});

test('more than the old limit of 20 terminals open: the 21st gets its own pty and slot', async () => {
  const f = fixture(), a = f.owner('A');
  for (let n = 1; n <= 21; n++) assert.equal((await f.open(a, { name: `t${n}` })).status, 'opened');
  assert.equal(f.broker.counts().slots, 21); assert.equal(f.ptys.length, 21);
});

test('the ceiling refuses a local and a remote open before any preparation or pty; a confirmed close frees one place', async () => {
  const f = fixture({ autoExit: true }), a = f.owner('A'), b = f.owner('B'), handles = [];
  for (let n = 0; n < MAX_TERMINALS; n++) handles.push(await f.attached(n % 2 ? a : b, { name: `t${n}`, remote: n % 4 === 0 }));
  const calls = f.calls.length, ptys = f.ptys.length;
  for (const spec of [{ name: 'over' }, { name: 'over', remote: true }]) assert.deepEqual(await f.open(a, spec), terminalFailure('E_TERM_CAP'));
  assert.equal(f.calls.length, calls); assert.equal(f.ptys.length, ptys); assert.equal(f.broker.counts().slots, MAX_TERMINALS);
  assert.equal((await f.handlers.get('term:close')(f.event(b), handles[0])).status, 'closed');
  assert.equal(f.broker.counts().slots, MAX_TERMINALS - 1);
  assert.equal((await f.open(a, { name: 'over' })).status, 'opened'); assert.equal(f.broker.counts().slots, MAX_TERMINALS);
  assert.equal((await f.open(a, { name: 'again' })).code, 'E_TERM_CAP');
});

test('a failed create gives its place back: one below the ceiling, the open after a failure still succeeds', async () => {
  const pty = () => ({ onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }), write() {}, resize() {}, kill() {} });
  const f = fixture({ create: spec => { if (spec.name === 'broken') throw new Error('no pty'); return { pty: pty() }; } }), a = f.owner('A');
  for (let n = 0; n < MAX_TERMINALS - 1; n++) assert.equal((await f.open(a, { name: `t${n}` })).ok, true);
  assert.equal((await f.open(a, { name: 'broken' })).code, 'E_TERM_OPEN_FAILED'); assert.equal(f.broker.counts().slots, MAX_TERMINALS - 1);
  assert.equal((await f.open(a, { name: 'last' })).ok, true); assert.equal(f.broker.counts().slots, MAX_TERMINALS);
  assert.equal((await f.open(a, { name: 'over' })).code, 'E_TERM_CAP');
});

test('preparation success AND rejection after context replacement are stale; live direct viewers survive', async () => {
  for (const reject of [false, true]) for (const notify of [false, true]) {
    const gate = deferred(), f = fixture({ prepare: () => gate.promise }), a = f.owner();
    const h = await f.attached(a), pending = f.open(a, { name: 'remote', remote: true }); await drain();
    f.setContext('backend-2'); if (notify) f.broker.invalidatePreparations();
    if (reject) gate.reject(new Error('secret host path')); else gate.resolve({});
    assert.equal((await pending).code, 'E_TERM_CONTEXT_CHANGED');
    assert.equal(f.broker.write(f.event(a), h, 'direct survives').ok, true);
    assert.equal(f.ptys[0].kills, 0); assert.equal(f.broker.counts().slots, 1);
  }
});

test('ready handshake retains ordered early data AND early exit, inside one slot', async () => {
  const f = fixture(), a = f.owner(), opened = await f.open(a), p = f.ptys[0];
  p.data('one'); p.data('two'); p.exit({ exitCode: 7 }); await drain();
  assert.deepEqual(f.events, []); assert.equal(f.broker.counts().slots, 1);
  assert.equal(f.broker.write(f.event(a), opened.handle, 'too early').code, 'E_TERM_NOT_READY');
  assert.equal((await f.ready(a, opened.handle)).ok, true);
  assert.deepEqual(f.events.slice(0, 2).map(e => e.value), ['one', 'two']);
  assert.equal(f.events[2].value.status, 'ended'); assert.equal(f.events[2].value.exitCode, 7);
  assert.equal(f.events[2].value.cleanupPending, false); assert.equal(f.broker.counts().slots, 0);
});

test('ready FIFO byte overflow and5s deadline revoke input, emit literal typed failures and hold uncertain cleanup', async () => {
  for (const overflow of [false, true]) {
    const f = fixture(), a = f.owner(), opened = await f.open(a), p = f.ptys[0];
    if (overflow) p.data('λ'.repeat(TERM_READY_BYTES / 2 + 1)); else f.tick(TERM_READY_MS);
    await drain();
    const code = overflow ? 'E_TERM_OUTPUT_LIMIT' : 'E_TERM_READY_TIMEOUT';
    assert.equal((await f.ready(a, opened.handle)).code, code);
    assert.equal(f.events[0].value.reason.code, code); assert.equal(f.events[0].value.cleanupPending, true);
    assert.equal(f.broker.counts().slots, 1); assert.equal(p.kills, 1); assert.equal(f.broker.write(f.event(a), opened.handle, 'bad').ok, false);
    p.exit({ exitCode: 0 }); await drain(); assert.equal(f.broker.counts().slots, 0);
  }
});

test('close2s gives pending, never releases before onExit, never repeats detach signal', async () => {
  const f = fixture(), a = f.owner(), h = await f.attached(a), close = f.handlers.get('term:close')(f.event(a), h);
  await drain(); assert.equal(f.broker.counts().slots, 1); assert.equal(f.ptys[0].kills, 1);
  assert.equal((await f.open(a)).code, 'E_TERM_CLOSING');
  f.tick(TERM_CLOSE_MS); assert.equal((await close).message, 'closing… not yet confirmed');
  const again = f.handlers.get('term:close')(f.event(a), h); f.ptys[0].exit({ exitCode: 0 });
  assert.equal((await again).status, 'closed'); assert.equal(f.ptys[0].kills, 1); assert.equal(f.broker.counts().slots, 0);
});

test('uncertain viewer cleanup quarantines even an exited PTY; explicit close may confirm it without another signal', async () => {
  let uncertain = true;
  const f = fixture({ autoExit: true, cleanup: () => { if (uncertain) throw new Error('unknown'); } }), a = f.owner(), h = await f.attached(a);
  const closing = f.broker.close(f.event(a), h); await drain(); f.tick(TERM_CLOSE_MS);
  assert.equal((await closing).code, 'E_TERM_CLOSE_PENDING'); assert.equal(f.broker.counts().slots, 1);
  assert.equal(f.events.at(-1).value.cleanupPending, true);
  uncertain = false; assert.equal((await f.broker.close(f.event(a), h)).ok, true);
  assert.equal(f.ptys[0].kills, 1); assert.equal(f.broker.counts().slots, 0);
});

test('internal rekey rotates lease A→B→A; old source close/navigation cannot kill new owner, output follows new subscription', async () => {
  const f = fixture(), a = f.owner('A'), b = f.owner('B'), first = await f.attached(a), resource = f.broker.resources()[0];
  const next = f.broker.rekey(resource, b); assert.equal(next.ok, true); assert.equal(next.handle.id, first.id); assert.notEqual(next.handle.lease, first.lease);
  assert.equal(f.broker.write(f.event(b), first, 'stolen old lease').ok, false);
  assert.equal((await f.broker.close(f.event(a), first)).code, 'E_TERM_LEASE');
  f.navigate(a); assert.equal(f.ptys[0].kills, 0);
  f.ptys[0].data('for B'); assert.equal(f.events.length, 0); assert.equal((await f.ready(b, next.handle)).ok, true);
  assert.equal(f.events[0].owner, 'B'); assert.equal(f.events[0].channel, `term:data:${next.handle.lease}`);
  const back = f.broker.rekey(resource, a); assert.equal(back.ok, true); assert.notEqual(back.handle.lease, first.lease);
  await f.ready(a, back.handle);
  assert.equal(f.broker.write(f.event(a), first, 'ABA').ok, false);
  assert.equal(f.broker.write(f.event(b), next.handle, 'stale B').ok, false);
  assert.equal(f.broker.write(f.event(a), back.handle, 'current').ok, true);
  assert.deepEqual(f.ptys[0].writes, ['current']); assert.equal(f.ptys.length, 1);
});

test('global4 attachment batches/per-lease1; interrupted completions withhold paths and block rekey until settlement', async () => {
  const gate = deferred(), f = fixture({ autoExit: true, attachments: () => gate.promise }), a = f.owner('A'), b = f.owner('B');
  const hs = []; for (let i = 0; i < 5; i++) hs.push(await f.attached(a, { name: `${i}` }));
  const pending = hs.slice(0, 4).map(h => f.broker.attachments(f.event(a), h, [{ path: '/memory/file' }]));
  await drain(); assert.equal(f.broker.counts().batches, 4);
  assert.equal((await f.broker.attachments(f.event(a), hs[0], [])).code, 'E_TERM_BUSY');
  assert.equal((await f.broker.attachments(f.event(a), hs[4], [])).code, 'E_TERM_BUSY');
  assert.equal(f.broker.rekey(f.broker.resources()[0], b).code, 'E_TERM_BUSY');
  f.navigate(a); await drain(); assert.equal(f.broker.counts().slots, 4, 'in-flight batches keep their old resource slots');
  gate.resolve(['/memory/private-result']);
  for (const result of await Promise.all(pending)) { assert.equal(result.code, 'E_TERM_ATTACHMENT_INTERRUPTED'); assert.equal('paths' in result, false); }
  assert.deepEqual(f.broker.counts(), { slots: 0, batches: 0 });
});

test('stale attachment rejection does not leak raw exception; no dispatch if copy step revokes ownership', async () => {
  const gate = deferred(), f = fixture({ attachments: () => gate.promise }), a = f.owner(), h = await f.attached(a);
  const pending = f.broker.attachments(f.event(a), h, []); f.navigate(a); gate.reject(new Error('private path'));
  const result = await pending; assert.equal(result.code, 'E_TERM_ATTACHMENT_INTERRUPTED'); assert.ok(!JSON.stringify(result).includes('private path'));
  let owner; const g = fixture({ copyAttachments() { g.navigate(owner); return []; } }); owner = g.owner(); const gh = await g.attached(owner);
  assert.equal((await g.broker.attachments(g.event(owner), gh, [])).code, 'E_TERM_ATTACHMENT_INTERRUPTED');
  assert.equal(g.calls.filter(c => c[0] === 'attachments').length, 0);
});

test('document epoch separately refuses close of an old closing lease after same-WC reload', async () => {
  const f = fixture(), a = f.owner(), h = await f.attached(a); f.navigate(a);
  const result = f.broker.close(f.event(a), h); await drain(); f.tick(TERM_CLOSE_MS);
  assert.equal((await result).code, 'E_TERM_LEASE'); assert.equal(f.ptys[0].kills, 1);
});

test('30s preparation deadline aborts without releasing unsettled work or creating after a late success', async () => {
  const gate = deferred(), f = fixture({ prepare: () => gate.promise }), a = f.owner();
  const pending = f.open(a, { name: 'remote', remote: true }); await drain(); f.tick(30000);
  assert.equal(f.calls.find(c => c[0] === 'prepare')[2].signal.aborted, true);
  assert.equal(f.broker.counts().slots, 1); gate.resolve({});
  assert.equal((await pending).code, 'E_TERM_PREPARE_TIMEOUT'); assert.equal(f.ptys.length, 0); assert.equal(f.broker.counts().slots, 0);
});

test('partial-create uncertain cleanup retains its reservation instead of an orphaning release', async () => {
  let cleanups = 0;
  const f = fixture({ create() { throw Object.assign(new Error('private native detail'), { terminalCleanup() { cleanups++; throw new Error('uncertain'); } }); } });
  const result = await f.open(f.owner()); await drain();
  assert.equal(result.code, 'E_TERM_OPEN_FAILED'); assert.equal(JSON.stringify(result).includes('private native'), false);
  assert.equal(cleanups, 1); assert.equal(f.broker.counts().slots, 1);
});

test('conflicting lease cannot overwrite the prior resource or release its key', async () => {
  const f = fixture({ token: () => 'a'.repeat(64) }), a = f.owner(), h = await f.attached(a);
  assert.equal((await f.open(a, { name: 'another' })).code, 'E_TERM_OPEN_FAILED');
  assert.equal(f.ptys.length, 1); assert.equal(f.broker.counts().slots, 1);
  assert.equal(f.broker.write(f.event(a), h, 'original').ok, true);
});

test('rekey collision does not evict another receiver resource; old post-exit callbacks cannot release a successor', async () => {
  const f = fixture({ autoExit: true }), a = f.owner('A'), b = f.owner('B'), h = await f.attached(a), bh = await f.attached(b);
  const r = f.broker.resources()[0]; assert.equal(f.broker.rekey(r, b).code, 'E_TERM_BUSY');
  assert.equal(f.broker.write(f.event(b), bh, 'B intact').ok, true);
  const oldExit = f.ptys[0].exit, oldData = f.ptys[0].data;
  assert.equal((await f.broker.close(f.event(a), h)).ok, true);
  const successor = await f.attached(a); oldExit({ exitCode: 0 }); oldData('late stale output'); await drain();
  assert.equal(f.broker.counts().slots, 2); assert.equal(f.broker.write(f.event(a), successor, 'successor').ok, true);
  assert.equal(f.events.some(e => e.value === 'late stale output'), false);
});

test('shutdown revokes every owner and pending work without freeing unconfirmed resources', async () => {
  const gate = deferred(), f = fixture({ prepare: () => gate.promise }), a = f.owner(), h = await f.attached(a);
  const pending = f.open(a, { name: 'remote', remote: true }); await drain(); f.broker.dispose();
  assert.equal(f.broker.write(f.event(a), h, 'shutdown').ok, false); assert.equal(f.broker.counts().slots, 2);
  gate.resolve({}); assert.equal((await pending).code, 'E_TERM_CONTEXT_CHANGED'); assert.equal(f.broker.counts().slots, 1);
  f.ptys[0].exit({ exitCode: 0 }); await drain(); assert.equal(f.broker.counts().slots, 0);
});

// The agent view's answer (the Opus whole read, 2026-11-20): main reads the viewer pane's mode first and never types into
// a pane in a mode (tmux copy mode, where q is cancel: "q1: Yes" would reach the agent as "1: Yes").
test('term:answer types only into a pane in no mode; in a mode, or unknown, nothing is typed (E_TERM_IN_MODE)', async () => {
  let mode = false;
  const inModeFor = { value: () => Promise.resolve(mode) };
  const f = fixture({ create() {
    const p = { writes: [], sizes: [], kills: 0, viewers: 0, data: null, exit: null };
    f.ptys.push(p);
    return { pty: { onData(fn) { p.data = fn; return { dispose() {} }; }, onExit(fn) { p.exit = fn; return { dispose() {} }; },
      write(d) { p.writes.push(d); }, resize() {}, kill() {} }, killViewer() {}, inMode: () => inModeFor.value() };
  } });
  const a = f.owner('A'), b = f.owner('B'), h = await f.attached(a), answer = (e, ...args) => f.handlers.get('term:answer')(e, ...args);
  assert.deepEqual(await answer(f.event(a), h, 'q1: Yes, one clean commit'), { terminalApi: 2, ok: true, status: 'sent' });
  mode = true;
  assert.equal((await answer(f.event(a), h, 'q1: No')).code, 'E_TERM_IN_MODE');
  inModeFor.value = () => Promise.reject(new Error('tmux gone'));
  assert.equal((await answer(f.event(a), h, 'q1: No')).code, 'E_TERM_IN_MODE', 'a mode that cannot be read is not ruled out');
  inModeFor.value = () => Promise.resolve(false);
  for (const bad of ['', 'q1: Yes\r', 'q1: Yes\n', 'q1: \x1b[A', 'x'.repeat(513), 42]) assert.equal((await answer(f.event(a), h, bad)).code, 'E_TERM_BAD_ARGS');
  assert.equal((await answer(f.event(b), h, 'q1: No')).ok, false, 'another window never types');
  assert.equal((await answer(f.event(a), h.id, 'q1: No')).code, 'E_TERM_LEASE');
  // The lease ends while the mode is read: nothing is typed.
  let release; inModeFor.value = () => new Promise(r => { release = r; });
  const late = answer(f.event(a), h, 'q1: Late'); await drain();
  f.navigate(a); release(false);
  assert.equal((await late).ok, false);
  assert.deepEqual(f.ptys[0].writes, ['q1: Yes, one clean commit']);
});

test('term:answer on a terminal with no mode reader (a remote viewer) types as write does', async () => {
  const f = fixture(), a = f.owner('A'), h = await f.attached(a);
  assert.equal((await f.handlers.get('term:answer')(f.event(a), h, 'q1: Yes')).status, 'sent');
  assert.deepEqual(f.ptys[0].writes, ['q1: Yes']);
});
