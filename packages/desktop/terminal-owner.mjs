// Main-only terminal resource custody. No Electron/native process dependency.
// The composition root supplies validated target admission and bounded I/O.
import { randomBytes } from 'node:crypto';
import { MAX_TERMINALS } from './terminal-registry.mjs';
import { trustedRendererUrl } from './renderer/window-binding.mjs';
import {
  terminalFailure as fail, terminalSuccess as ok, terminalHandle, terminalGeometry,
  TERM_WRITE_BYTES, TERM_READY_BYTES, TERM_READY_MS, TERM_CLOSE_MS, TERM_PREPARE_MS, TERM_ATTACHMENTS_MAX,
} from '../client/terminal-contract.mjs';

const own = Symbol('desktop terminal owner');
const validHandle = h => !!h && typeof h === 'object' && !Array.isArray(h)
  && Number.isSafeInteger(h.id) && h.id > 0 && typeof h.lease === 'string' && /^[a-f0-9]{64}$/.test(h.lease);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

/** All owner registration/rekey calls are main-internal, NOT IPC methods.
 * io.admit(input) -> {key, spec}, copied/frozen, throws on invalid input
 *   (E_TERM_BAD_ARGS; an error coded E_HERDR_REMOVED keeps its code).
 * io.prepare(spec, {signal,current,context}) -> bounded promise (remote only).
 * io.create(spec, prepared, {current}) -> synchronous {pty,killViewer,inMode?}. inMode() -> promise of true while the
 *   viewer's pane is in a mode (tmux copy mode), false when not; absent, or a throw, is unknown (never a mode).
 * An uncertain failed create must throw with private terminalCleanup callback.
 * killViewer resolves only when cleanup is confirmed; rejection means uncertain.
 * admitFrame(event) -> true when the opening frame may open terminals at all (main: its window still shows
 *   the workspace its hash names); anything else, a throw included, refuses the open with E_TERM_FORBIDDEN_FRAME.
 */
export function createTerminalOwnerBroker({ rendererUrl, io, context = () => '', admitFrame = () => true,
  token = () => randomBytes(32).toString('hex'), clock = { setTimeout, clearTimeout },
  leases = new Map(),
}) {
  const records = new Set(), owners = new Set();
  let nextId = 1, batches = 0, stopped = false;
  const handle = r => Object.freeze({ id: r.id, lease: r.lease });
  const timer = (fn, ms) => { const t = clock.setTimeout(fn, ms); t?.unref?.(); return t; };
  const clear = t => { if (t !== null) clock.clearTimeout(t); };
  const trustedUrl = url => trustedRendererUrl(url, rendererUrl);
  function liveOwner(o) {
    try { return !!o && owners.has(o) && o.admitted && !stopped && !o.wc.isDestroyed()
      && o.frame === o.wc.mainFrame && !o.frame.detached && trustedUrl(o.frame.url); } catch { return false; }
  }
  function principal(e) {
    try {
      const o = e?.sender?.[own];
      return liveOwner(o) && e.senderFrame === o.frame && e.senderFrame === e.sender.mainFrame ? o : null;
    } catch { return null; }
  }
  const current = r => records.has(r) && liveOwner(r.owner) && r.wc === r.owner.wc && r.epoch === r.owner.epoch;
  const preparingCurrent = r => current(r) && !r.closing && !r.abort.signal.aborted
    && r.owner.targets.get(r.key) === r && (!r.spec.remote || (r.context !== null && r.context === context()));
  function emit(r, kind, value) {
    if (!current(r)) return false;
    try { r.owner.frame.send(`term:${kind}:${r.lease}`, value); return true; }
    catch { revoke(r.owner.wc); return false; }
  }
  function emitExit(r) {
    const pending = r.acquiring || !r.exited || !r.cleaned || !!r.attaching;
    const receipt = pending ? 'pending' : 'confirmed';
    if (r.exitSent === receipt) return;
    r.exitSent = receipt;
    emit(r, 'exit', { terminalApi: 2, status: pending ? 'closing' : r.closing ? 'closed' : 'ended', handle: handle(r),
      cleanupPending: pending, exitCode: r.exitCode, reason: r.failure ? fail(r.failure) : null });
  }
  function release(r) {
    if (!records.delete(r)) return;
    clear(r.readyTimer); clear(r.prepareTimer);
    leases.delete(r.lease);
    if (r.owner.targets.get(r.key) === r) r.owner.targets.delete(r.key);
    r.buffer = []; r.bufferBytes = 0;
    for (const subscription of r.subscriptions) { try { subscription?.dispose?.(); } catch { /* exact old listener only */ } }
    r.done.resolve(ok('closed', { handle: handle(r) }));
  }
  function finish(r) {
    if (!records.has(r) || r.acquiring || r.attaching || !r.exited || !r.cleaned) return;
    // An early exit stays inside its reserved slot until ready/timeout, so its
    // output and exit cannot vanish in the open -> listener-install gap.
    if (!r.ready && !r.closing) return;
    emitExit(r); release(r);
  }
  function cleanup(r) {
    if (r.cleaned || r.cleaning || !r.cleanup) { finish(r); return; }
    r.cleaning = true;
    let work;
    try { work = r.cleanup(); } catch { work = Promise.reject(new Error('cleanup uncertain')); }
    Promise.resolve(work).then(value => { if (value !== false) r.cleaned = true; }, () => {})
      .finally(() => {
        r.cleaning = false;
        if (r.exited && !r.cleaned && (r.ready || r.closing)) emitExit(r);
        finish(r);
      });
  }
  function closeResource(r, code = null) {
    if (!records.has(r)) return;
    r.closing = true;
    if (code && !r.failure) r.failure = code;
    clear(r.readyTimer); r.readyTimer = null;
    r.buffer = []; r.bufferBytes = 0;
    r.abort.abort();
    if (code === 'E_TERM_READY_TIMEOUT' || code === 'E_TERM_OUTPUT_LIMIT') emitExit(r);
    // One existing detach signal, never a PID fallback or stronger signal.
    if (r.pty && !r.exited && !r.killRequested) {
      r.killRequested = true;
      try { r.pty.kill(); } catch { /* no exit confirmation; retain the slot */ }
    }
    cleanup(r); finish(r);
  }
  function revoke(wc) {
    const o = wc?.[own];
    if (!owners.has(o)) return;
    o.admitted = false; o.epoch++; o.frame = null; o.targets = new Map();
    for (const r of records) if (r.wc === wc) closeResource(r, 'E_TERM_CONTEXT_CHANGED');
  }
  function admitDocument(o) {
    if (stopped) return;
    try {
      const frame = o.wc.mainFrame;
      if (!o.wc.isDestroyed() && trustedUrl(frame.url)) { o.frame = frame; o.admitted = true; }
    } catch { /* document is not admitted */ }
  }
  function register(wc) {
    if (stopped) return;
    if (wc[own]) { if (!owners.has(wc[own])) throw new Error('webContents already registered by another broker'); return; }
    const o = { wc, epoch: 1, frame: null, admitted: false, targets: new Map() };
    Object.defineProperty(wc, own, { value: o }); owners.add(o);
    wc.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) revoke(wc); });
    wc.on('did-finish-load', () => admitDocument(o));
    wc.on('render-process-gone', () => revoke(wc));
    wc.once('destroyed', () => { revoke(wc); owners.delete(o); });
    admitDocument(o); // also allows an already-loaded app-created window
  }
  // The hot-path ceiling: principal uses private main-owned object metadata;
  // ONE lease Map.get, then direct id / webContents / epoch comparisons. No
  // target serialization, hashing or owner->target Map lookup on a keystroke.
  function authorize(e, h) {
    const o = principal(e);
    if (!o) return { error: 'E_TERM_FORBIDDEN_FRAME' };
    if (!validHandle(h)) return { error: 'E_TERM_LEASE' };
    const r = leases.get(h.lease);
    if (!r || r.id !== h.id || r.wc !== e.sender || r.epoch !== o.epoch) return { error: 'E_TERM_LEASE' };
    return { r, o };
  }
  function active(r) {
    return r.closing ? 'E_TERM_CLOSING' : !r.ready || r.exited ? 'E_TERM_NOT_READY' : null;
  }
  function onData(r, data) {
    if (!current(r) || r.exited || r.closing || typeof data !== 'string') return;
    if (r.ready) { emit(r, 'data', data); return; }
    const bytes = Buffer.byteLength(data);
    if (bytes + r.bufferBytes > TERM_READY_BYTES) { closeResource(r, 'E_TERM_OUTPUT_LIMIT'); return; }
    r.bufferBytes += bytes; r.buffer.push(data);
  }
  function onExit(r, exit) {
    if (!records.has(r) || r.exited) return;
    r.exited = true;
    r.exitCode = Number.isInteger(exit?.exitCode) ? exit.exitCode : null;
    cleanup(r); finish(r);
  }
  function armReady(r) {
    r.readyTimer = timer(() => closeResource(r, 'E_TERM_READY_TIMEOUT'), TERM_READY_MS);
  }
  async function acquire(r) {
    try {
      if (!preparingCurrent(r)) throw fail('E_TERM_CONTEXT_CHANGED');
      let prepared;
      if (r.spec.remote) {
        r.prepareTimer = timer(() => closeResource(r, 'E_TERM_PREPARE_TIMEOUT'), TERM_PREPARE_MS);
        prepared = await io.prepare(r.spec, { signal: r.abort.signal, current: () => preparingCurrent(r), context: r.context });
      }
      if (!preparingCurrent(r)) throw fail(r.failure || 'E_TERM_CONTEXT_CHANGED');
      // Production create is synchronous: callbacks installed before yielding.
      const opened = io.create(r.spec, prepared, { current: () => preparingCurrent(r) });
      r.pty = opened.pty; r.exited = false;
      r.cleanup = opened.killViewer; r.cleaned = typeof r.cleanup !== 'function';
      r.inMode = typeof opened.inMode === 'function' ? opened.inMode : null;
      r.subscriptions.push(r.pty.onExit(exit => onExit(r, exit)));
      r.subscriptions.push(r.pty.onData(data => onData(r, data)));
      if (!preparingCurrent(r)) throw fail(r.failure || 'E_TERM_CONTEXT_CHANGED');
      armReady(r);
      return ok('opened', { handle: handle(r) });
    } catch (error) {
      if (typeof error?.terminalCleanup === 'function') { r.cleanup = error.terminalCleanup; r.cleaned = false; }
      const code = r.failure || (!preparingCurrent(r) ? 'E_TERM_CONTEXT_CHANGED' : error?.code || 'E_TERM_OPEN_FAILED');
      closeResource(r, code);
      return fail(code);
    } finally {
      clear(r.prepareTimer); r.prepareTimer = null;
      r.acquiring = false; finish(r);
    }
  }
  async function open(e, input) {
    try {
      const owner = principal(e);
      if (!owner) return fail('E_TERM_FORBIDDEN_FRAME');
      // The composition root's say on the frame (main: its hash is still its window's workspace).
      let admittedFrame = false;
      try { admittedFrame = admitFrame(e) === true; } catch { admittedFrame = false; }
      if (!admittedFrame) return fail('E_TERM_FORBIDDEN_FRAME');
      let admitted;
      try { admitted = io.admit(input); } catch (error) { return fail(error?.code === 'E_HERDR_REMOVED' ? error.code : 'E_TERM_BAD_ARGS'); }
      if (!admitted || typeof admitted.key !== 'string' || !admitted.key || !admitted.spec) return fail('E_TERM_BAD_ARGS');
      const epoch = owner.epoch;
      let r = owner.targets.get(admitted.key), reused = !!r;
      if (r?.closing) return fail('E_TERM_CLOSING');
      if (!r) {
        if (records.size >= MAX_TERMINALS) return fail('E_TERM_CAP');
        const ctx = admitted.spec.remote ? context() : undefined;
        if (ctx === null) return fail('E_TERM_CONTEXT_CHANGED');
        const lease = token();
        if (!/^[a-f0-9]{64}$/.test(lease) || leases.has(lease)) return fail('E_TERM_OPEN_FAILED');
        r = { id: nextId++, lease, owner, wc: owner.wc, epoch, key: admitted.key, spec: admitted.spec, context: ctx,
          acquiring: true, closing: false, ready: false, exited: true, cleaned: true, cleaning: false,
          cleanup: null, pty: null, killRequested: false, failure: null, exitCode: null, exitSent: false,
          buffer: [], bufferBytes: 0, readyTimer: null, prepareTimer: null, subscriptions: [],
          attaching: null, inMode: null, abort: new AbortController(), done: deferred(), work: null };
        // Reservation is synchronous, BEFORE even a microtask of preparation.
        records.add(r); leases.set(lease, r); owner.targets.set(r.key, r);
        r.work = Promise.resolve().then(() => acquire(r));
      }
      const result = await r.work;
      if (principal(e) !== owner || epoch !== owner.epoch) return fail('E_TERM_CONTEXT_CHANGED');
      if (!result.ok) return { ...result };
      if (!current(r) || r.closing) return fail(r.failure || 'E_TERM_CONTEXT_CHANGED');
      return ok(reused ? 'reused' : 'opened', { handle: handle(r) });
    } catch { return fail('E_TERM_OPEN_FAILED'); }
  }
  function ready(e, h) {
    try {
      const a = authorize(e, h); if (a.error) return fail(a.error);
      const { r } = a;
      if (r.closing) return fail(r.failure || 'E_TERM_CLOSING');
      if (r.acquiring) return fail('E_TERM_NOT_READY');
      if (!r.ready) {
        clear(r.readyTimer); r.readyTimer = null; r.ready = true;
        const chunks = r.buffer; r.buffer = []; r.bufferBytes = 0;
        for (const chunk of chunks) if (!emit(r, 'data', chunk)) return fail('E_TERM_CONTEXT_CHANGED');
        if (r.exited && !r.cleaned && !r.cleaning) emitExit(r);
        finish(r);
      }
      return ok('ready', { handle: handle(r) });
    } catch { return fail('E_TERM_LEASE'); }
  }
  function write(e, h, data) {
    try {
      const a = authorize(e, h); if (a.error) return fail(a.error);
      const state = active(a.r); if (state) return fail(state);
      if (typeof data !== 'string' || data.length > TERM_WRITE_BYTES || Buffer.byteLength(data) > TERM_WRITE_BYTES || !data.isWellFormed()) return fail('E_TERM_BAD_ARGS');
      a.r.pty.write(data);
      return ok('sent'); // means forwarded, never a promise of agent consumption
    } catch { return fail('E_TERM_LEASE'); }
  }
  /** The agent view's answer (agent-board.mjs): `data` typed as `write` types it, but never into a pane in a mode. In
   * tmux's copy mode the copy-mode table takes the keys (q is cancel), so `q1: Yes` would reach the agent as `1: Yes`,
   * or not at all: the pane's mode is read first, on the viewer's own anchored target, and in a mode nothing is typed
   * (E_TERM_IN_MODE). Never a cancel: leaving the mode is the person's key. No line end and no control character: an
   * answer goes on the input line, and the person's Enter sends it. The same frame, lease and readiness as `write`,
   * checked again after the read. */
  async function answer(e, h, data) {
    try {
      const a = authorize(e, h); if (a.error) return fail(a.error);
      const state = active(a.r); if (state) return fail(state);
      if (typeof data !== 'string' || !data || data.length > 512 || !data.isWellFormed() || /[\x00-\x1f\x7f-\x9f]/.test(data)) return fail('E_TERM_BAD_ARGS');
      let inMode = false;
      if (a.r.inMode) {
        let timeout;
        try { inMode = await Promise.race([a.r.inMode(), new Promise(resolve => { timeout = timer(() => resolve(null), 2000); })]); }
        catch { inMode = null; } finally { clear(timeout); }
      }
      const again = authorize(e, h); if (again.error || again.r !== a.r) return fail(again.error || 'E_TERM_LEASE');
      const now = active(a.r); if (now) return fail(now);
      // A read that failed or took too long says nothing: unknown is refused too, since a mode can't be ruled out.
      if (inMode !== false && a.r.inMode) return fail('E_TERM_IN_MODE');
      a.r.pty.write(data);
      return ok('sent');
    } catch { return fail('E_TERM_LEASE'); }
  }
  function resize(e, h, cols, rows) {
    try {
      const a = authorize(e, h); if (a.error) return fail(a.error);
      const state = active(a.r); if (state) return fail(state);
      if (!terminalGeometry(cols, rows)) return fail('E_TERM_BAD_ARGS');
      a.r.pty.resize(cols, rows); return ok('resized');
    } catch { return fail('E_TERM_LEASE'); }
  }
  async function close(e, h) {
    try {
      const a = authorize(e, h); if (a.error) return fail(a.error);
      const { r, o } = a, epoch = o.epoch;
      closeResource(r);
      let timeout;
      const result = await Promise.race([r.done.promise,
        new Promise(resolve => { timeout = timer(() => resolve(fail('E_TERM_CLOSE_PENDING')), TERM_CLOSE_MS); })]);
      clear(timeout);
      return principal(e) === o && o.epoch === epoch ? result : fail('E_TERM_CONTEXT_CHANGED');
    } catch { return fail('E_TERM_LEASE'); }
  }
  async function attachments(e, h, items) {
    let r, operation;
    try {
      const a = authorize(e, h); if (a.error) return fail(a.error);
      r = a.r;
      const state = active(r); if (state) return fail(state);
      if (r.attaching || batches >= TERM_ATTACHMENTS_MAX) return fail('E_TERM_BUSY');
      const snapshot = terminalHandle(h), epoch = r.epoch, o = r.owner;
      const isCurrent = () => current(r) && !r.closing && !r.exited && r.lease === snapshot.lease && r.epoch === epoch && r.owner === o;
      // Copy/validate synchronously before await. The adapter also validates the
      // actual files/total sizes before any write/upload.
      const copied = io.copyAttachments(items);
      if (!isCurrent()) return fail('E_TERM_ATTACHMENT_INTERRUPTED');
      operation = Symbol('attachment batch'); r.attaching = operation; batches++;
      const paths = await io.attachments(copied, r.spec, { signal: r.abort.signal, current: isCurrent });
      if (!isCurrent() || principal(e) !== o) return fail('E_TERM_ATTACHMENT_INTERRUPTED');
      if (!Array.isArray(paths) || paths.length !== copied.length || paths.length > 16
        || paths.some(path => typeof path !== 'string' || !path || path.length > 4096 || /[\x00-\x1f\x7f]/.test(path))) return fail('E_TERM_ATTACHMENT_FAILED');
      return ok('attached', { paths: [...paths] });
    } catch (error) {
      return fail(error?.code === 'E_TERM_ATTACHMENT_INTERRUPTED' || error?.code === 'E_TERM_CONTEXT_CHANGED'
        || (r && (!current(r) || r.closing || r.abort.signal.aborted)) ? 'E_TERM_ATTACHMENT_INTERRUPTED' : 'E_TERM_ATTACHMENT_FAILED');
    } finally {
      if (operation) { batches--; if (r.attaching === operation) r.attaching = null; finish(r); }
    }
  }
  function rekey(resource, newOwner) {
    try {
      const r = resource, o = newOwner?.[own];
      if (!records.has(r) || !current(r) || !liveOwner(o)) return fail('E_TERM_LEASE');
      if (active(r) || r.attaching || r.owner === o || o.targets.has(r.key)) return fail('E_TERM_BUSY');
      const lease = token();
      if (!/^[a-f0-9]{64}$/.test(lease) || leases.has(lease)) return fail('E_TERM_OPEN_FAILED');
      // Main-internal atomic rotation only. NO escrow, transfer IPC or UI.
      leases.delete(r.lease);
      if (r.owner.targets.get(r.key) === r) r.owner.targets.delete(r.key);
      r.owner = o; r.wc = o.wc; r.epoch = o.epoch; r.lease = lease;
      r.ready = false; r.buffer = []; r.bufferBytes = 0;
      o.targets.set(r.key, r); leases.set(lease, r); armReady(r);
      return ok('rekeyed', { handle: handle(r) });
    } catch { return fail('E_TERM_LEASE'); }
  }
  return {
    register, revoke, open, ready, write, answer, resize, close, attachments, rekey,
    invalidatePreparations() { for (const r of records) if (r.acquiring && r.spec.remote) closeResource(r, 'E_TERM_CONTEXT_CHANGED'); },
    dispose() {
      stopped = true; for (const o of owners) revoke(o.wc);
      let timeout;
      return Promise.race([Promise.all([...records].map(r => r.done.promise)),
        new Promise(resolve => { timeout = timer(() => resolve(null), TERM_CLOSE_MS); })])
        .finally(() => clear(timeout)); // timeout never fabricates resource release
    },
    // Main-only inspection for composition/testing; never exposed through IPC.
    resources: () => [...records], counts: () => ({ slots: records.size, batches }),
  };
}

/** Actual IPC adapters are shared by production and handler tests. All domain
 * operations resolve; one-way handlers deliberately discard safe refusals. */
export function installTerminalHandlers(ipc, broker) {
  for (const [channel, method] of [['open', 'open'], ['ready', 'ready'], ['close', 'close'], ['attachments', 'attachments'], ['answer', 'answer']]) {
    ipc.handle(`term:${channel}`, async (event, ...args) => {
      try { return await broker[method](event, ...args); } catch { return fail('E_TERM_TRANSPORT'); }
    });
  }
  ipc.on('term:write', (event, ...args) => { try { broker.write(event, ...args); } catch { /* zero-effect refusal */ } });
  ipc.on('term:resize', (event, ...args) => { try { broker.resize(event, ...args); } catch { /* zero-effect refusal */ } });
}
