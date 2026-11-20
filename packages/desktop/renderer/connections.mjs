import { takePickerFocusReturn } from './overlay-picker.mjs';
import { DESKTOP_NOUNS } from './desktop-terms.mjs';
import { AUTH_PANE_LABEL, FORGE_API, forgeReason, hostName, loginName, ref } from './forge-contract.mjs';
export const connectionsCSS = `
.forge-settings { width:min(760px,calc(100vw - 32px)); max-height:90vh; overflow:auto; padding:18px; border:1px solid var(--border); border-radius:10px; background:var(--surface); color:var(--fg); box-shadow:var(--shadow-popover); }
.forge-settings header, .forge-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.forge-settings header h2 { flex:1; margin:0; font-size:16px; }
.forge-settings button, .forge-settings input { font:inherit; padding:6px 10px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--fg); }
.forge-settings button:focus-visible { background:var(--sel); }
.forge-settings [aria-disabled=true] { color:var(--muted); cursor:wait; }
.forge-settings .forge-card { margin:16px 0; padding:14px; border:1px solid var(--border); border-radius:9px; background:var(--surface-2); }
.forge-settings .forge-hint { color:var(--muted); line-height:1.5; overflow-wrap:anywhere; }
.forge-settings label { display:flex; align-items:center; gap:8px; min-width:0; }
/* The host select is theme.css's select.field; here it only takes the row's width. */
.forge-settings select.field { min-width:0; max-width:100%; flex:1; }
.forge-settings .forge-terminal { height:260px; padding:8px; margin:8px 0; background:var(--surface); border:1px solid var(--border); border-radius:6px; }
.forge-settings .forge-terminal .xterm { height:100%; }
`;
const keys = new Map([['\r', 'enter'], ['\x1b[A', 'up'], ['\x1b[B', 'down'], ['\x1b[C', 'right'], ['\x1b[D', 'left'],
  ['\t', 'tab'], ['\x1b', 'escape'], ['y', 'yes'], ['Y', 'yes'], ['n', 'no'], ['N', 'no'], ['\x03', 'interrupt']]);
export const authKeyName = bytes => keys.get(bytes) || null;
/** The Connections dialog's own words (slice 3b: copy only). `agent` is DESKTOP_NOUNS.instance. */
export const CONNECTIONS_COPY = Object.freeze({
  githubPurpose: agent => `Gives each ${agent}'s branch and pull request in its details. Connect with the GitHub CLI, as yourself.`,
});
/** Settings is machine-scoped. Auth-open ownership is deliberately separate
 * from connection generation: Connect itself increments that generation.
 * `sections` are further Settings sections (Terminal), each a factory
 * returning { element, dispose }: mounted after Connections on open,
 * disposed on close. */
export function createConnections({ doc, request, desk, terminalFactory, subscribe = () => () => {}, generation = () => 0,
  openShortcuts = () => {}, onIntent = () => {}, applyFocus = fn => fn(), captureFocus = () => () => true, sections = [] } = {}) {
  let overlay = null, ui = null, restoreFocus = null, alive = true, life = 0, readTicket = 0, actionTicket = 0, extras = [];
  let current = null, selectedHost = null, session = null, pending = false, pendingAuth = Promise.resolve();
  const node = (tag, text, cls) => { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
  const button = (text, fn) => { const b = node('button', text); b.type = 'button'; b.addEventListener('click', fn); return b; };
  function locks() {
    if (!ui) return;
    ui.host.disabled = pending || !!session && !session.ended;
    for (const b of [ui.connect, ui.disconnect]) b.setAttribute('aria-disabled', String(pending || !current));
  }
  function stopSession() {
    const old = session; session = null;
    if (!old) return;
    old.offData?.(); old.offExit?.(); old.input?.dispose(); old.resize?.dispose(); old.terminal.dispose();
    void desk.forgeAuthClose(old.lease).catch(() => {});
    ui?.auth.replaceChildren(); locks();
  }
  function close({ restore = true } = {}) {
    if (!overlay) return;
    life++; readTicket++; actionTicket++; pending = false; stopSession();
    for (const extra of extras) { try { extra.dispose?.(); } catch { /* one section must not block closing */ } }
    extras = [];
    overlay.remove(); overlay = null; ui = null; current = null; selectedHost = null;
    if (restore) applyFocus(() => restoreFocus?.restore());
    restoreFocus = null;
  }
  function paint(value) {
    current = null;
    const focused = doc.activeElement;
    const hadActionFocus = focused === ui.connect || focused === ui.disconnect;
    ui.connect.hidden = true; ui.disconnect.hidden = true;
    const valid = value?.forgeApi === FORGE_API && ['connected', 'not-connected'].includes(value.status)
      && hostName(value.host) && ref(value.hostRef) && ref(value.connectionRef)
      && (value.status === 'not-connected' ? value.login === null : loginName(value.login))
      && Array.isArray(value.hosts) && value.hosts.length <= 32 && value.hosts.every(h => hostName(h.host) && ref(h.hostRef));
    if (valid) {
      current = value; selectedHost = value.hostRef;
      ui.host.replaceChildren(...value.hosts.map(h => { const option = node('option', h.host); option.value = h.hostRef; return option; }));
      ui.host.value = value.hostRef;
      ui.status.textContent = value.status === 'connected' ? `Connected as ${value.login} on ${value.host}` : `Not connected on ${value.host}`;
      ui.connect.hidden = value.status !== 'not-connected'; ui.disconnect.hidden = value.status !== 'connected';
      ui.observed.textContent = 'Status is read when you open this or press Refresh. Your credentials stay with GitHub CLI on this computer.';
    } else {
      ui.status.textContent = forgeReason(value?.reason?.code).message;
      selectedHost = null; ui.host.replaceChildren(); ui.observed.textContent = 'No current connection state is established. Refresh to retry.';
    }
    locks();
    if (hadActionFocus && focused.hidden) applyFocus(() => ui.refresh.focus({ preventScroll: true }));
  }
  async function refresh(hostRef = selectedHost) {
    if (!overlay || !alive) return;
    const mounted = life, ticket = ++readTicket, account = generation();
    const owns = () => alive && overlay && life === mounted && ticket === readTicket && generation() === account;
    current = null; ui.status.textContent = 'Reading GitHub connection…'; locks();
    try { const value = await request(hostRef ? { hostRef } : {}); if (owns()) paint(value); }
    catch { if (owns()) paint(null); }
  }
  async function startAuth(connectionRef) {
    if (!overlay || !ref(connectionRef)) return;
    if (session?.ended) stopSession();
    if (session) { applyFocus(() => session.terminal.focus()); return; }
    let preparedLease = null;
    const mounted = life, intent = ++actionTicket, ownsFocus = captureFocus(), focused = doc.activeElement;
    const owns = () => alive && overlay && mounted === life && intent === actionTicket;
    pending = true; locks();
    const previous = pendingAuth; let release;
    pendingAuth = new Promise(resolve => { release = resolve; });
    try {
      // Closing/reopening during prepare cannot reuse a lease that an older
      // completion is about to close. Cleanup completes before the next open.
      await previous; if (!owns()) return;
      const result = await desk.forgeConnect(connectionRef);
      if (!owns()) { if (result?.ok && ref(result.lease)) await desk.forgeAuthClose(result.lease); return; }
      if (!result?.ok || !ref(result.lease)) { ui.status.textContent = forgeReason(result?.reason?.code).message; return; }
      preparedLease = result.lease;
      const area = ui.auth; area.replaceChildren();
      const title = node('h3', AUTH_PANE_LABEL), hint = node('p', 'Complete the web/device flow yourself. No token paste. Shift+Tab leaves this terminal; Ctrl+C interrupts gh.', 'forge-hint');
      const mount = node('div', undefined, 'forge-terminal');
      const cancel = button('Close sign-in', () => { onIntent(); stopSession(); applyFocus(() => ui?.refresh.focus()); });
      area.append(title, hint, mount, cancel);
      const terminal = terminalFactory(mount);
      const live = { lease: result.lease, terminal, mount, connectionRef }; session = live;
      const currentSession = () => alive && overlay && life === mounted && session === live;
      mount.addEventListener('paste', event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
      terminal.setKeyHandler?.(event => {
        if (event.key === 'Tab' && event.shiftKey) {
          if (event.type === 'keydown' && currentSession()) { event.preventDefault(); applyFocus(() => cancel.focus()); }
          return false;
        }
        return true;
      });
      live.offData = desk.onForgeAuthData(live.lease, data => { if (currentSession() && typeof data === 'string') terminal.write(data); });
      live.offExit = desk.onForgeAuthExit(live.lease, receipt => {
        if (!currentSession()) return;
        hint.textContent = receipt?.ok ? 'GitHub CLI exited. Refreshing the observed connection state.' : forgeReason(receipt?.reason?.code).message;
        live.ended = true; locks();
        void refresh(selectedHost);
      });
      live.input = terminal.onData(data => { const key = authKeyName(data); if (currentSession() && !live.ended && key) void desk.forgeAuthKey(live.lease, key).catch(() => {}); });
      const resize = () => {
        if (!currentSession() || live.ended) return;
        terminal.fit(); void desk.forgeAuthResize(live.lease, Math.max(20, Math.min(300, terminal.cols)), Math.max(5, Math.min(100, terminal.rows))).catch(() => {});
      };
      live.resize = terminal.onResize(resize);
      // No await between installing subscriptions and the ready/resize handshake.
      resize();
      if (ownsFocus() && doc.activeElement === focused) applyFocus(() => terminal.focus());
    } catch {
      if (preparedLease && session?.lease !== preparedLease) await desk.forgeAuthClose(preparedLease).catch(() => {});
      if (owns()) { stopSession(); ui.status.textContent = forgeReason('E_GH_FAILED').message; }
    } finally { release(); if (owns()) { pending = false; locks(); } }
  }
  async function disconnect() {
    if (!current || pending) return;
    onIntent(); const selected = current, mounted = life, ticket = ++actionTicket;
    const owns = () => alive && overlay && mounted === life && ticket === actionTicket;
    pending = true; locks();
    try {
      const result = await desk.forgeDisconnect(selected.connectionRef);
      if (!owns()) return;
      if (!result?.ok) ui.status.textContent = forgeReason(result?.reason?.code).message;
      else await refresh(result.hostRef);
    } catch { if (owns()) ui.status.textContent = forgeReason('E_GH_FAILED').message; }
    finally { if (owns()) { pending = false; locks(); } }
  }
  function open({ hostRef = null, connectionRef = null } = {}) {
    if (!alive) return;
    onIntent();
    if (!overlay) {
      restoreFocus = takePickerFocusReturn(doc); life++;
      overlay = node('div', undefined, 'palette-overlay forge-overlay');
      const dialog = node('section', undefined, 'forge-settings'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-label', 'Settings');
      const header = node('header'), closeButton = button('Close settings', () => close());
      header.append(node('h2', 'Settings'), button('Keyboard shortcuts', () => { close(); openShortcuts(); }), closeButton);
      const card = node('section', undefined, 'forge-card'), status = node('p', '', 'forge-hint'), observed = node('p', '', 'forge-hint'); status.setAttribute('role', 'status');
      const host = node('select', undefined, 'field'); host.setAttribute('aria-label', 'GitHub host'); const label = node('label', 'Host'); label.append(host);
      const refreshButton = button('Refresh', () => { onIntent(); void refresh(); });
      const connectButton = button('Connect GitHub', () => { if (current && !pending) { onIntent(); void startAuth(current.connectionRef); } });
      const disconnectButton = button('Disconnect', () => void disconnect());
      connectButton.hidden = true; disconnectButton.hidden = true;
      const actions = node('div', undefined, 'forge-actions'); actions.append(refreshButton, connectButton, disconnectButton);
      // What the connection is for, in one line (the Desktop UI rework, slice 3b; guide tour step 40).
      const purpose = node('p', CONNECTIONS_COPY.githubPurpose(DESKTOP_NOUNS.instance), 'forge-hint'); purpose.dataset.purpose = 'github';
      card.append(node('h3', 'GitHub'), purpose, label, status, observed, actions);
      const auth = node('section'); auth.setAttribute('aria-label', 'GitHub CLI sign-in');
      dialog.append(header, node('h3', 'Connections'), card, auth);
      extras = sections.map(make => make()).filter(extra => extra?.element);
      dialog.append(...extras.map(extra => extra.element)); overlay.append(dialog); doc.body.append(overlay);
      ui = { host, status, observed, auth, refresh: refreshButton, connect: connectButton, disconnect: disconnectButton };
      host.addEventListener('change', () => { if (!pending && !session && host.isConnected) { onIntent(); selectedHost = host.value; void refresh(selectedHost); } });
      overlay.addEventListener('keydown', event => {
        if (session?.mount.contains(event.target)) return; // CLI keys, with explicit Shift+Tab egress
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key !== 'Tab') return;
        const controls = [...dialog.querySelectorAll('button,select,textarea,input')].filter(el => !el.hidden && !el.disabled && el.tabIndex >= 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
      applyFocus(() => closeButton.focus());
    }
    if (!session) { selectedHost = hostRef || selectedHost; void refresh(selectedHost); }
    if (connectionRef) void startAuth(connectionRef);
  }
  const unsubscribe = subscribe(() => { readTicket++; if (overlay) void refresh(); });
  return { open, close, dispose() { if (!alive) return; close({ restore: false }); alive = false; unsubscribe(); } };
}
