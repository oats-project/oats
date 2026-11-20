// Preload-only wire v2 facade. No numeric -> latest-lease map; every closure and
// invocation retains a copied original handle. Main remains the authority.
const LIMIT = 1024 * 1024, CHUNK = 64 * 1024, FILES = 25 * 1024 * 1024;
const messages = {
  E_TERM_LEASE: 'This terminal handle is no longer owned by this document.',
  E_TERM_BAD_ARGS: 'Invalid terminal request.',
  E_TERM_INPUT_LIMIT: 'Terminal input exceeds the safe write limit. Nothing was sent.',
  E_TERM_TRANSPORT: 'The terminal service did not confirm the operation.',
  E_TERM_IN_MODE: 'The terminal is in its scrollback. Nothing was typed.',
  E_TERM_ATTACHMENT_FAILED: 'Could not prepare these attachments.',
};
const fail = code => ({ terminalApi: 2, ok: false, code, message: messages[code] });
function handle(h) {
  if (!h || typeof h !== 'object' || Array.isArray(h) || !Number.isSafeInteger(h.id) || h.id < 1
    || typeof h.lease !== 'string' || !/^[a-f0-9]{64}$/.test(h.lease)) return null;
  return Object.freeze({ id: h.id, lease: h.lease });
}
const same = (a, b) => a && b && a.id === b.id && a.lease === b.lease;
function createTerminalBridge(ipc, webUtils) {
  const invoke = async (channel, ...args) => {
    try {
      const r = await ipc.invoke(channel, ...args);
      if (r?.terminalApi !== 2 || typeof r.ok !== 'boolean') return fail('E_TERM_TRANSPORT');
      // Terminal codes, plus the one domain refusal term:open carries: a Herdr target (E_HERDR_REMOVED).
      if (!r.ok) return typeof r.code === 'string' && /^(E_TERM_[A-Z_]+|E_HERDR_REMOVED)$/.test(r.code) && typeof r.message === 'string' && r.message.length <= 256
        ? { terminalApi: 2, ok: false, code: r.code, message: r.message } : fail('E_TERM_TRANSPORT');
      if (channel === 'term:attachments') {
        if (!Array.isArray(r.paths) || r.paths.length > 16 || r.paths.some(p => typeof p !== 'string' || p.length > 4096)) return fail('E_TERM_TRANSPORT');
        return { terminalApi: 2, ok: true, status: 'attached', paths: [...r.paths] };
      }
      if (channel === 'term:answer') return r.status === 'sent' ? { terminalApi: 2, ok: true, status: 'sent' } : fail('E_TERM_TRANSPORT');
      const h = handle(r.handle), expected = channel === 'term:open' ? ['opened', 'reused'] : channel === 'term:ready' ? ['ready'] : ['closed'];
      if (!h || !expected.includes(r.status) || (channel !== 'term:open' && !same(h, args[0]))) return fail('E_TERM_TRANSPORT');
      return { terminalApi: 2, ok: true, status: r.status, handle: h };
    } catch { return fail('E_TERM_TRANSPORT'); }
  };
  const leasedInvoke = async (channel, h) => {
    try { const copy = handle(h); return copy ? await invoke(channel, copy) : fail('E_TERM_LEASE'); }
    catch { return fail('E_TERM_LEASE'); }
  };
  const subscribe = (kind, h, cb) => {
    let copy; try { copy = handle(h); } catch { /* refuse */ }
    if (!copy || typeof cb !== 'function') return () => {};
    const channel = `term:${kind}:${copy.lease}`;
    const fn = (_event, data) => {
      if (kind === 'data') { if (typeof data === 'string') cb(data); }
      else if (data?.terminalApi === 2 && same(data.handle, copy) && ['closing', 'closed', 'ended'].includes(data.status)
        && typeof data.cleanupPending === 'boolean') cb(data);
    };
    ipc.on(channel, fn); return () => ipc.removeListener(channel, fn);
  };
  return {
    termOpen: spec => invoke('term:open', spec),
    termReady: h => leasedInvoke('term:ready', h),
    termClose: h => leasedInvoke('term:close', h),
    // `{ answer: true }`: the agent view's answer (terminal-owner answer). Main types it only when the pane is in no mode
    // (tmux copy mode), so it resolves, a promise, with main's own answer: sent, or a refusal such as E_TERM_IN_MODE.
    termWrite(h, data, options) {
      if (options !== undefined) {
        try {
          const copy = handle(h);
          if (!copy) return Promise.resolve(fail('E_TERM_LEASE'));
          if (!options || typeof options !== 'object' || Object.keys(options).length !== 1 || options.answer !== true
            || typeof data !== 'string' || !data || data.length > 512 || !data.isWellFormed()) return Promise.resolve(fail('E_TERM_BAD_ARGS'));
          return invoke('term:answer', copy, data);
        } catch { return Promise.resolve(fail('E_TERM_TRANSPORT')); }
      }
      try {
        const copy = handle(h); if (!copy) return fail('E_TERM_LEASE');
        if (typeof data !== 'string' || !data.isWellFormed()) return fail('E_TERM_BAD_ARGS');
        if (data.length > LIMIT || Buffer.byteLength(data) > LIMIT) return fail('E_TERM_INPUT_LIMIT');
        const bytes = Buffer.from(data, 'utf8');
        for (let start = 0; start < bytes.length;) {
          let end = Math.min(start + CHUNK, bytes.length);
          while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
          ipc.send('term:write', copy, bytes.toString('utf8', start, end)); start = end;
        }
        return { terminalApi: 2, ok: true, status: 'sent' };
      } catch { return fail('E_TERM_TRANSPORT'); }
    },
    termResize(h, cols, rows) {
      try {
        const copy = handle(h); if (!copy) return fail('E_TERM_LEASE');
        if (!Number.isInteger(cols) || cols < 1 || cols > 1000 || !Number.isInteger(rows) || rows < 1 || rows > 1000) return fail('E_TERM_BAD_ARGS');
        ipc.send('term:resize', copy, cols, rows); return { terminalApi: 2, ok: true, status: 'resized' };
      } catch { return fail('E_TERM_TRANSPORT'); }
    },
    async termAttachFiles(h, files) {
      try {
        const copy = handle(h); if (!copy) return fail('E_TERM_LEASE');
        if (!Array.isArray(files) || !files.length || files.length > 16 || files.some(f => !Number.isSafeInteger(f.size) || f.size < 0)
          || files.reduce((n, f) => n + f.size, 0) > FILES) return fail('E_TERM_ATTACHMENT_FAILED');
        let bytes = 0; const items = [];
        for (const file of files) {
          const path = webUtils.getPathForFile(file);
          if (path) { items.push({ path }); continue; }
          if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) return fail('E_TERM_ATTACHMENT_FAILED');
          const data = new Uint8Array(await file.arrayBuffer()); bytes += data.byteLength;
          if (!data.length || bytes > FILES) return fail('E_TERM_ATTACHMENT_FAILED');
          items.push({ type: file.type, bytes: data });
        }
        return invoke('term:attachments', copy, items);
      } catch { return fail('E_TERM_ATTACHMENT_FAILED'); }
    },
    onTermData: (h, cb) => subscribe('data', h, cb),
    onTermExit: (h, cb) => subscribe('exit', h, cb),
  };
}
module.exports = { createTerminalBridge };
