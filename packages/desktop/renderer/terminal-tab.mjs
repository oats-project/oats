// xterm/leased-IPC composition. All subscriptions/observers are installed inside
// lifecycle onReady, before its settlement signal; no late setup after disposal.
// A remote lease that ends with ssh's own exit 255 (a lost link) is re-opened for the
// same target with backoff; the tab, its xterm and its scrollback stay. Reconnecting
// never touches the server: each lease ends only its local ssh child.
import { createTermLifecycle } from './term-lifecycle.mjs';
import { wireTerminalAttachments } from './terminal-attachments.mjs';
import { createSyncGate } from './terminal-sync.mjs';
import { terminalHandle, terminalSameHandle, terminalFailure, terminalMessage } from '../../client/terminal-contract.mjs';

// Shift+Enter writes pi's raw Ctrl+J alias exactly once. Suppress all three key
// phases, otherwise xterm's subsequent keypress writes CR and submits the draft.
export function shiftEnterAction(ev) {
  if (ev.key !== 'Enter' || !ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return { suppress: false, byte: null };
  return { suppress: true, byte: ev.type === 'keydown' ? '\n' : null };
}
// Shift+PgUp and Shift+PgDn write tmux's S-PPage and S-NPage, which the viewer binds to scroll back
// (#1502). xterm.js would scroll its own viewport for them and send nothing, and that viewport is
// empty while tmux draws on the alternate screen. Every phase is claimed; the keys go on keydown.
const SHIFT_PAGE_KEYS = { PageUp: '\x1b[5;2~', PageDown: '\x1b[6;2~' };
export function shiftPageAction(ev) {
  if (!Object.hasOwn(SHIFT_PAGE_KEYS, ev.key) || !ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return { suppress: false, byte: null };
  return { suppress: true, byte: ev.type === 'keydown' ? SHIFT_PAGE_KEYS[ev.key] : null };
}
/** Fit a tab's terminal to its pane and centre it, as a native terminal
 * balances its window padding (the operator's review, 2026-10-02). FitAddon
 * reserves 15px on the right for xterm's scrollbar even where scrollbars
 * overlay (xterm's Viewport falls back to 15) and leaves the sub-cell remainder
 * there too, so the right gutter read up to 23px wider than the left. tmux runs
 * in xterm's alternate screen, where that scrollbar has nothing to scroll, and
 * shell.css hides it on terminal tabs: the grid takes the whole padded box and
 * the remainder is split evenly, across and down, in whole device pixels so the
 * glyphs stay sharp.
 *
 * The grid is sized from the renderer's device cell, which does not depend on
 * the grid: xterm's CSS cell is the rounded screen extent divided by the column
 * count, so fitting from it could flip between two counts at a fractional pane
 * width (review round 8). Both renderers round the screen to
 * round(cells × device cell / dpr) CSS pixels; a count whose rounded extent
 * would overflow the box gives way to one fewer. Without a measured cell,
 * FitAddon fits as before. */
export function fitTerminal(term, fit) {
  const core = term?._core, cell = core?._renderService?.dimensions?.device?.cell;
  const el = term?.element, screen = el?.querySelector('.xterm-screen'), parent = el?.parentElement;
  if (!(cell?.width > 0) || !(cell?.height > 0) || !el || !screen || !parent) { fit.fit(); return; }
  const view = el.ownerDocument.defaultView, own = view.getComputedStyle(el), box = view.getComputedStyle(parent);
  const px = value => Number.parseFloat(value) || 0;
  const width = px(box.width) - px(own.paddingLeft) - px(own.paddingRight);
  const height = px(box.height) - px(own.paddingTop) - px(own.paddingBottom);
  if (!(width > 0) || !(height > 0)) { fit.fit(); return; } // a hidden pane: FitAddon's own no-op
  const ratio = view.devicePixelRatio || 1;
  const extent = (count, size) => Math.round(count * size / ratio); // the screen's CSS size, as xterm rounds it
  const count = (room, size, least) => {
    let n = Math.max(least, Math.floor(room * ratio / size + 1e-6)); // float noise must not lose a whole cell
    while (n > least && extent(n, size) > room) n--;
    return n;
  };
  const cols = count(width, cell.width, 2), rows = count(height, cell.height, 1);
  if (term.cols !== cols || term.rows !== rows) { core._renderService.clear?.(); term.resize(cols, rows); }
  const half = rest => Math.max(0, Math.floor(rest / 2 * ratio) / ratio);
  screen.style.margin = `${half(height - extent(rows, cell.height))}px 0 0 ${half(width - extent(cols, cell.width))}px`;
}

/** Whether this renderer process can make a WebGL2 context: a throwaway
 * canvas whose context is released at once. A yes is kept; a no is asked
 * again next time (a GPU process restarting can refuse contexts for a while),
 * so a later show recovers. */
let webgl2 = false;
export function webgl2Supported(doc) {
  if (!webgl2 && doc) {
    try {
      const gl = doc.createElement('canvas').getContext('webgl2');
      webgl2 = Boolean(gl);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { webgl2 = false; }
  }
  return webgl2;
}

/** xterm's WebGL renderer, so box drawing and block elements (U+2500–259F:
 * Claude Code's input box, tmux borders, progress bars) are drawn the way a
 * native terminal draws them, as thin strokes joined cell to cell whatever the
 * font (xterm's customGlyphs). The DOM renderer takes them from the font, and
 * Inconsolata's are twice as heavy. `Addon` is the WebglAddon class, absent
 * where it is not loaded.
 *
 * Fallbacks, all to xterm's DOM renderer:
 * - no WebGL2 here (`supported`, asked again on every show until it says
 *   yes): the addon is not activated. Its renderer adds a canvas and listeners
 *   before asking for the context, and a throw there leaves them behind where
 *   the addon's dispose cannot reach.
 * - an activation that throws although WebGL2 was there: no further attempt
 *   for this terminal, which stays on the DOM renderer until it is reopened;
 *   another attempt would leave another canvas and listener set behind.
 * - a lost context that is not restored within addon-webgl's 3 s wait
 *   (Chromium keeps about 16 and drops the oldest): the addon is disposed
 *   (`onChange` refits), and `ensure()`, run when the tab is shown, loads a
 *   fresh one. A fresh addon re-joins the window's shared glyph atlas, which
 *   the loss may have left stale, so a load that follows a loss calls
 *   `onRecovered`: the shell's window-wide atlas clear
 *   (terminal-atlas-recovery.mjs), never this terminal's own clear, which
 *   garbles the others. A context restored within the 3 s (a GPU process
 *   restart after sleep or a Space switch) never reaches this path: that
 *   module hears the restore itself. */
export function createGlyphRenderer({ term, Addon, onChange = () => {}, onRecovered = () => {},
  supported = () => webgl2Supported(term.element?.ownerDocument) }) {
  let addon = null, failed = false, lost = false;
  function drop() {
    const was = addon; addon = null;
    try { was?.dispose(); } catch {}
    if (was) onChange();
  }
  function ensure() {
    if (addon || failed || typeof Addon !== 'function' || !term.element || !supported()) return Boolean(addon);
    let next = null;
    try {
      next = new Addon();
      next.onContextLoss(() => { if (addon === next) { lost = true; drop(); } });
      term.loadAddon(next);
      addon = next;
      onChange();
    } catch {
      // No retry (the Desktop lead's decision): a failed activation would leak another canvas and listener set.
      failed = true; try { next?.dispose(); } catch {}
    }
    if (addon && lost) { lost = false; try { onRecovered(); } catch {} }
    return Boolean(addon);
  }
  return { ensure, dispose: drop, get active() { return Boolean(addon); } };
}

/** Every terminal's readability floor (xterm's `minimumContrastRatio`): text
 * under 4.5:1 against its cell's background is drawn lighter or darker until
 * it reaches it. 4.5 is WCAG AA for text, Desktop's bar in every theme, and
 * the highest WCAG level that leaves the hand-calibrated palettes unadjusted
 * on their own background (test/theme-contrast.test.mjs holds them to this
 * constant), so xterm acts only on what nobody calibrated: ANSI on ANSI
 * backgrounds, 256-colour and truecolour text. More in renderer/README.md. */
export const TERMINAL_MINIMUM_CONTRAST = 4.5;

// Native terminal geometry: no lineHeight (xterm's default 1.0), so cells and
// the block cursor keep their natural height and tmux owns row spacing.
export function terminalOptions({ fontSize, fontFamily, fontWeight, theme }) {
  // A drag is xterm's own selection (terminal-mouse.mjs keeps tmux's mouse tracking from xterm); Option-drag
  // still selects on macOS if the far side's tracking ever reaches xterm (the mixed-sequence fallback).
  // altClickMovesCursor is off: with xterm's selection always owning the buttons, a quick Alt/Option+click
  // would otherwise send cursor keys to move the prompt's cursor there, and a tmux client has no scrollback
  // of its own, so that includes Up/Down, which recall a prompt's history (Claude Code's) (#694).
  // fontWeight is the theme's (terminalFontWeight); fontWeightBold stays xterm's bold.
  // The contrast floor is not a parameter: one number for every terminal and theme.
  return { fontSize, fontFamily, fontWeight, theme, scrollback: 5000, macOptionClickForcesSelection: true,
    altClickMovesCursor: false, minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST };
}
export function terminalKeyDecision(ev, interceptKey) {
  const { suppress, byte } = shiftEnterAction(ev);
  if (suppress) return { handled: true, byte };
  if (interceptKey && interceptKey(ev)) return { handled: true, byte: null };
  // After the keymap, which never takes a plain chord such as Shift+PgUp in a terminal (matchEvent).
  const page = shiftPageAction(ev);
  if (page.suppress) return { handled: true, byte: page.byte };
  return { handled: false, byte: null };
}

/** Waits before each reconnect attempt; the last one repeats while the tab is open. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
/** Open failures that may be the link again, so reconnecting goes on; any other stops it. */
export const RECONNECT_RETRIED = new Set(['E_TERM_REMOTE_UNREACHABLE', 'E_TERM_PREPARE_TIMEOUT', 'E_TERM_REMOTE_NO_ANSWER']);
/** No answer from this computer's oats is more likely the CLI than the link: it is retried this
 * many times in a row, then reconnecting stops. An E_SSH answer or a success resets the count. */
export const NO_ANSWER_RETRIES = 3;
/** ssh exits 255 for its own failures: here, a link that died under the viewer. */
export const LOST_LINK_EXIT = 255;

// A resize drag (the sidebar's handle, sidebar-width.mjs) holds the PTY resizes: while any hold is on, a terminal
// still refits every frame, but its program hears the size once, when the last hold lets go. Each terminal that
// resized meanwhile then refits to the final layout and sends its size.
let resizeHolds = 0;
const heldResizes = new Set();
/** Hold every terminal's PTY resize; answers the release (a second call does nothing). */
export function holdTerminalResizes() {
  resizeHolds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--resizeHolds) return;
    const settles = [...heldResizes]; heldResizes.clear();
    for (const settle of settles) { try { settle(); } catch { /* a closed terminal */ } }
  };
}

export function createTerminalTab({ desk, term, tmux, remote, serverLabel, wrap, isActive, ownsFocus = () => false,
  focusInput = () => term.focus(), fit, observe, interceptKey, onError = () => {}, onLink = () => {}, onInput = () => {},
  clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: t => clearTimeout(t) } }) {
  let offData, offExit, unobserve, detachAttachments, bannerEl, stripEl, liveEl;
  // The current lease's output gate (terminal-sync.mjs): a synchronized redraw reaches xterm whole.
  let gate = null;
  let ready = false, closed = false, ended = false, arming = false, wired = false;
  // Reconnect state: connected, waiting (for the next attempt's time and the old lease's
  // cleanup), attempting (a lease open in flight) or stopped. One timer drives the waiting.
  let link = 'connected', failures = 0, noAnswers = 0, dueAt = 0, timer = null;
  const server = serverLabel || remote?.serverId;
  const subscriptions = [];
  const doc = wrap.ownerDocument;
  const clearStrip = () => { stripEl?.remove(); stripEl = null; };
  const banner = text => {
    clearStrip();
    if (!bannerEl) { bannerEl = doc.createElement('div'); bannerEl.className = 'term-banner'; bannerEl.setAttribute('role', 'status'); wrap.append(bannerEl); }
    bannerEl.textContent = text;
  };
  // Only state changes are written here; the visible countdown stays outside it.
  const announce = text => {
    if (!liveEl) {
      liveEl = doc.createElement('div'); liveEl.className = 'term-live sr-only';
      liveEl.setAttribute('role', 'status'); liveEl.setAttribute('aria-live', 'polite'); wrap.append(liveEl);
    }
    liveEl.textContent = text;
  };
  const strip = (text, busy) => {
    if (!stripEl) {
      stripEl = doc.createElement('div'); stripEl.className = 'term-reconnect';
      const words = doc.createElement('span'); words.className = 'term-reconnect-text';
      const now = doc.createElement('button'); now.type = 'button'; now.textContent = 'Reconnect now';
      now.addEventListener('click', reconnectNow);
      stripEl.append(words, now); wrap.append(stripEl);
    }
    stripEl.querySelector('.term-reconnect-text').textContent = text;
    const now = stripEl.querySelector('button');
    if (busy) now.setAttribute('aria-disabled', 'true'); else now.removeAttribute('aria-disabled');
  };
  const focus = () => {
    if (closed || !ready || ended || !ownsFocus()) return;
    try { focusInput(); } catch { /* no focus into a disposed input */ }
  };
  const life = createTermLifecycle({
    open: async () => {
      const result = await desk.termOpen({ ...(remote ? { remote } : {
        session: tmux.session, window: tmux.window, socket: tmux.socket,
      }), cols: term.cols, rows: term.rows });
      if (result?.terminalApi !== 2) throw terminalFailure('E_TERM_TRANSPORT');
      if (!result.ok) throw terminalFailure(result.code);
      // Reuse is not a second tab's lease acquisition. Its close must not detach
      // the already-open tab, even though both tabs share this document owner.
      if (result.status === 'reused') throw terminalFailure('E_TERM_REUSED');
      const h = terminalHandle(result.handle);
      if (result.status !== 'opened' || !h) throw terminalFailure('E_TERM_TRANSPORT');
      return h;
    },
    closePty: h => desk.termClose(h),
  }, onError);
  const clearTimer = () => { if (timer !== null) { clock.clearTimeout(timer); timer = null; } };
  const disposeUi = () => {
    clearTimer();
    offData?.(); offExit?.(); unobserve?.(); detachAttachments?.();
    for (const subscription of subscriptions) subscription?.dispose?.();
    term.dispose(); bannerEl?.remove(); bannerEl = null; clearStrip(); liveEl?.remove(); liveEl = null;
  };
  const defaultObserve = el => {
    const ro = new ResizeObserver(() => { if (!closed && isActive()) { try { fit(); } catch { /* hidden geometry */ } } });
    ro.observe(el); return () => ro.disconnect();
  };
  // Input goes to the current lease only; between leases there is none.
  const write = data => {
    const h = life.ptyId();
    if (!arming || closed || ended || !h) return;
    const result = desk.termWrite(h, data);
    if (result?.ok === false) banner(terminalFailure(result.code).message);
  };
  // The program hears the grid's size from the current lease only.
  const sendSize = () => {
    const current = life.ptyId();
    if (ready && !closed && !ended && current) desk.termResize(current, term.cols, term.rows);
  };
  // A held resize's release: refit to the layout now (a refit that changes the grid has sent it), else send it.
  const settleSize = () => {
    const { cols, rows } = term;
    if (!closed && isActive()) { try { fit?.(); } catch { /* hidden geometry */ } }
    if (term.cols === cols && term.rows === rows) sendSize();
  };
  function wait() {
    // The Desktop UI rework, slice 4: the first drop of an episode is told once (the shell says it on the status line
    // when this is the terminal in front); the countdown strip in the pane is unchanged.
    if (link === 'connected') { try { onLink({ state: 'disconnected', server }); } catch { /* the strip says it */ } }
    link = 'waiting';
    dueAt = clock.now() + RECONNECT_DELAYS_MS[Math.min(failures, RECONNECT_DELAYS_MS.length - 1)];
    failures++;
    announce(`Disconnected from ${server}.`);
    tick();
  }
  // Wall-clock due time: after a sleep the overdue attempt runs once, at the first tick.
  function tick() {
    clearTimer();
    if (closed || link !== 'waiting') return;
    const left = dueAt - clock.now();
    if (left > 0) {
      strip(`Disconnected from ${server}. Reconnecting in ${Math.ceil(left / 1000)}s…`, false);
      timer = clock.setTimeout(tick, left % 1000 || 1000);
    } else if (life.ptyId()) strip(`Reconnecting to ${server}…`, true); // the old lease's confirmed exit ticks again
    else attempt();
  }
  function attempt() {
    link = 'attempting';
    strip(`Reconnecting to ${server}…`, true); announce(`Reconnecting to ${server}…`);
    life.reopen(connect, error => {
      if (closed) return;
      if (error?.code === 'E_TERM_REMOTE_NO_ANSWER') noAnswers++;
      else if (error?.code === 'E_TERM_REMOTE_UNREACHABLE') noAnswers = 0;
      if (RECONNECT_RETRIED.has(error?.code) && noAnswers <= NO_ANSWER_RETRIES) wait();
      else stop(`${terminalMessage(error?.code, server)} Close this tab.`);
    });
  }
  function reconnectNow() {
    if (closed || link !== 'waiting') return;
    dueAt = clock.now(); tick();
  }
  function stop(text) {
    link = 'stopped'; clearTimer(); ended = true;
    banner(text); announce(text);
  }
  function exited(h, result, leaseGate) {
    if (!terminalSameHandle(result?.handle, h) || !terminalSameHandle(life.ptyId(), h)) return;
    // The lease's last output, a held block included, lands before the ended or reconnect state.
    leaseGate.flush(); leaseGate.dispose();
    ready = false; ended = true; arming = false;
    if (!result.cleanupPending) life.forget(h);
    if (remote && !closed && result.exitCode === LOST_LINK_EXIT && !result.reason) {
      if (link === 'connected') { term.options.disableStdin = true; wait(); }
      else if (link === 'attempting') wait(); // this attempt's own lease died before it was ready
      else if (link === 'waiting' && !life.ptyId()) tick(); // cleanup confirmed
      return;
    }
    banner(result.reason?.code === 'E_TERM_READY_TIMEOUT' ? terminalFailure('E_TERM_READY_TIMEOUT').message
      : result.cleanupPending ? terminalFailure('E_TERM_CLOSE_PENDING').message
        : result.reason ? terminalFailure(result.reason.code).message : 'session ended — close this tab');
  }
  // One lease's setup: its data/exit listeners, then (once per tab) the xterm wiring.
  async function connect(h) {
    offData?.(); offExit?.();
    gate?.dispose(); // a new lease, a fresh gate: the last one was flushed where its lease ended
    ended = false;
    const leaseGate = gate = createSyncGate({ clock,
      write: data => { if (!closed && terminalSameHandle(life.ptyId(), h)) term.write(data); } });
    offData = desk.onTermData(h, data => leaseGate.push(data));
    offExit = desk.onTermExit(h, result => exited(h, result, leaseGate));
    if (!wired) {
      wired = true;
      subscriptions.push(term.onData(data => { write(data); try { onInput(data); } catch { /* the board's observer only */ } }));
      term.attachCustomKeyEventHandler?.(event => {
        // While the reconnect strip shows, input is inert: Tab moves focus on to Reconnect now.
        if (stripEl && event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return false;
        const { handled, byte } = terminalKeyDecision(event, interceptKey);
        if (!handled) return true;
        if (byte !== null) write(byte);
        return false;
      });
      subscriptions.push(term.onResize(() => { if (resizeHolds) heldResizes.add(settleSize); else sendSize(); }));
      unobserve = (observe || defaultObserve)(wrap);
      if (desk.termAttachFiles) detachAttachments = wireTerminalAttachments({ wrap, desk, term,
        ptyId: () => !closed && !ended && ready ? life.ptyId() : null, ownsFocus,
      });
    }
    // Permit xterm protocol replies while the ready FIFO is being flushed;
    // main alone admits writes once it has acknowledged this lease's readiness.
    arming = true;
    let result;
    try { result = await desk.termReady(h); } catch { result = terminalFailure('E_TERM_TRANSPORT'); }
    if (closed || !terminalSameHandle(life.ptyId(), h) || ended) return;
    if (result?.terminalApi !== 2 || !result.ok || result.status !== 'ready' || !terminalSameHandle(result.handle, h)) {
      leaseGate.flush();
      ready = false; arming = false; ended = true;
      if (link === 'connected') banner(terminalFailure('E_TERM_READY_TIMEOUT').message);
      else stop(terminalFailure('E_TERM_READY_TIMEOUT').message);
      // An absent/revoked lease is no longer ours to detach. This clears only
      // the local handle, NOT main's quota or any other owner's resource.
      if (result?.code === 'E_TERM_LEASE') life.forget(h);
      else {
        try {
          const cleanup = await desk.termClose(h);
          if (cleanup?.ok && cleanup.status === 'closed' && terminalSameHandle(cleanup.handle, h)) life.forget(h);
        } catch { /* retain handle; explicit close must confirm cleanup */ }
      }
      return;
    }
    ready = true;
    if (remote) term.options.disableStdin = false;
    // tmux redraws the screen for the new client: the scrollback is left as it is.
    desk.termResize(h, term.cols, term.rows);
    if (link !== 'connected') {
      link = 'connected'; failures = 0; noAnswers = 0; clearStrip(); announce(`Reconnected to ${server}.`);
      try { onLink({ state: 'reconnected', server }); } catch { /* the pane said it */ }
    }
    focus();
  }
  return {
    /** The agent view's answer (agent-board.mjs): `text` on the input line through this tab's current lease, exactly
     * where the person's typing goes, never with a line end. False when no lease is ready to take it. */
    type(text) {
      if (typeof text !== 'string' || !text || /[\x00-\x1f\x7f]/.test(text)) return false;
      const h = life.ptyId();
      if (!ready || closed || ended || !h) return false;
      const result = desk.termWrite(h, text);
      if (result?.ok === false) { banner(terminalFailure(result.code).message); return false; }
      return true;
    },
    start: () => life.start(connect, error => banner(`could not attach: ${terminalMessage(error?.code, server)}`)),
    focus,
    async close() {
      gate?.flush(); // written while the tab is still ours: a close that stays pending keeps showing it
      closed = true; ready = false; arming = false; clearTimer(); gate?.dispose();
      banner(terminalFailure('E_TERM_CLOSE_PENDING').message);
      const result = await life.close(disposeUi);
      if (!result.ok) banner(terminalFailure('E_TERM_CLOSE_PENDING').message);
      return result;
    },
  };
}
