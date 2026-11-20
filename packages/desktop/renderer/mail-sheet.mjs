/** The agent's mail (the Desktop UI rework, S2-M3; guide v6 "Mail: a sheet from the right"): a read-only sheet
 * that slides in from the right over the panes, about 360 px wide, for one agent. Nothing on the main screen says
 * anything about an agent's mail: this sheet is the one place it shows, and only while it is open.
 *
 * It reads through the messaging layer's own view operation, `messaging:mail` (packages/client/mail-contract.mjs),
 * by the route the Teams card already uses (POST /api/capabilities `{action: 'run', selector: {home}, operation}` →
 * `oats operation run messaging:mail --home …`, routed with `--server` for an agent on a registered server). That
 * operation never acknowledges and never marks anything read: it is the only call this sheet makes. It reads on
 * open, on Refresh (r) and on "Older mail" (the provider's next page), never on the status poll and never in the
 * background: each read is one aw call per identity, over the network.
 *
 * Newest first, as the provider merges every identity of the agent; one item per message: Received from / Sent to
 * and the other party, the team when the agent reads more than one, the time, the subject, then the body as an
 * attributed plain-text quote ("<alias> wrote:") cut to a few lines until the item is expanded (Enter, Space or a
 * click on its head). Each message says what the provider said about it: encrypted, not read by the agent yet, high
 * priority, an unverified or failed signature, shortened by the provider to fit its bounds, or part of a long conversation of
 * which only the older part can be read.
 *
 * Keys: ↑/↓ (Home/End) move between messages, Enter or Space expands one, r reads again, Esc closes; Tab cycles
 * inside the sheet. Focus goes back where it was when it opened. A click on the scrim closes it.
 *
 * Every read carries the sheet's lifetime (opened for this agent, in this workspace generation) and a serial, checked
 * on success and on rejection: an answer for a closed sheet, another agent or a superseded read paints nothing.
 * Every provider text is set with textContent, never markup: it is untrusted sender content. */
import { takePickerFocusReturn, joinPickerFocusReturn } from './overlay-picker.mjs';
import { iconElement } from './shell-icons.mjs';
import { ageText } from './age-text.mjs';
import { DESKTOP_NOUNS } from './desktop-terms.mjs';
import { shownInstance } from './forget-dialog.mjs';
import { MAIL_OPERATION, mailAnswer, mailArgs, mailBodyLines, mailLine, messageKey, cursorUsable } from '../../client/mail-contract.mjs';
import { remoteInspectBlock, relayedFailure, serverLabel, shownLabel, codeLineNodes } from '../../client/remote-address.mjs';
import { displayLine, DETAIL_WITHHELD } from '../../client/display-text.mjs';

const agent = DESKTOP_NOUNS.instance;

/** The sheet's sentences. The "too old" one is the contract's (contract-mail-read v2, "Who builds what"). */
/** What an identity's error means, beside the error itself (oats.aweb's words; another provider's error is shown as given,
 * and one of these words from it reads as oats.aweb means it). An identity with an error may still have messages: the
 * sheet shows them. */
export const IDENTITY_ERRORS = Object.freeze({ __proto__: null,
  'identity-missing': 'its identity is missing from the agent\'s home',
  'identity-unreadable': 'its identity could not be read',
  'no-mail-read': 'it may not read mail (no mail.read grant, or the server refused)',
  'threads-unreadable': 'its list of conversations could not be read',
  'conversation-unreadable': 'one conversation could not be read, and its messages are missing',
  'too-many-threads': 'it has too many conversations to order in one read',
});

export const MAIL_WORDS = Object.freeze({
  title: name => `${name} · mail`,
  lead: `The ${agent}'s own mail. You can read it; the app never marks it read.`,
  reading: 'Reading mail…',
  readingOlder: 'Reading older mail…',
  empty: `Nothing in the ${agent}'s mail.`,
  older: 'Older mail',
  refresh: 'Refresh mail',
  close: 'Close mail',
  list: 'Messages, newest first',
  tooOld: [`This ${agent}'s messaging is too old to show mail; stop it and upgrade it (`, 'oats instance upgrade', `), or start a new ${agent} of its soul.`],
  noMessaging: `This ${agent} has no messaging layer, so it has no mail.`,
  awTooOld: detail => (detail ? `This computer's aw is too old to read mail: ${detail}` : "This computer's aw is too old to read mail."),
  remoteTooOld: server => `The OATS on ${server} is too old to read this ${agent}'s mail.`,
  unreadable: `The messaging layer answered mail this Desktop can't read. Update OATS Desktop, or this ${agent}'s messaging.`,
  failed: `Couldn't read the ${agent}'s mail.`,
  identityFailed: (team, code) => `Mail from ${team} can't be read: ${mailLine(code)}${IDENTITY_ERRORS[code] ? ` — ${IDENTITY_ERRORS[code]}` : ''}`,
  noIdentity: `None of this ${agent}'s mail identities could be read.`,
  unreadableConversations: (team, n) => `Mail from ${team}: ${n} ${n === 1 ? 'conversation' : 'conversations'} can't be read`,
  unnamedConversation: 'A conversation whose title is not shown',
  received: 'From', sent: 'To',
  encrypted: 'Encrypted', unread: `Not read by the ${agent} yet`, high: 'High priority',
  unverified: 'Unverified sender', signatureFailed: 'Signature failed',
  // `truncated`: the provider cut the body (past 16 KiB) or, for a message too large to fit an answer alone, its subject
  // and title too (oats.aweb, redesign-mail-read-developer 49e4169f).
  truncated: 'Shortened: the message is too long to show whole.',
  partial: "Older part of a long conversation shown; the newest messages can't be read yet.",
  wrote: alias => `${alias} wrote:`,
  noSubject: '(no subject)',
});

export const mailSheetCSS = `
.palette-overlay.mail-sheet-overlay { justify-content:flex-end; align-items:stretch; padding:0; }
.mail-sheet { box-sizing:border-box; width:min(360px, calc(100vw - 48px)); height:100%; display:flex; flex-direction:column; min-height:0;
  background:var(--surface); color:var(--fg); border-left:1px solid var(--border); box-shadow:var(--shadow-modal);
  font-family:var(--ui-font, system-ui); font-size:12.5px; animation:mail-sheet-in 150ms ease-out; }
@keyframes mail-sheet-in { from { transform:translateX(100%); } to { transform:none; } }
@media (prefers-reduced-motion: reduce) { .mail-sheet { animation:none; } }
.mail-sheet-head { display:flex; align-items:center; gap:4px; padding:12px 10px 4px 16px; }
.mail-sheet-head h2 { flex:1; min-width:0; margin:0; font-size:13.5px; font-weight:650; line-height:1.35; overflow-wrap:anywhere; }
.mail-sheet-tool { flex:none; display:inline-grid; place-items:center; width:28px; height:28px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--muted); cursor:pointer; }
.mail-sheet-tool:hover:not(:disabled) { background:var(--surface-2); color:var(--fg); }
.mail-sheet-tool:disabled { color:var(--faint); cursor:default; }
.mail-sheet-lead { margin:0; padding:0 16px 10px; color:var(--muted); font-size:11.5px; line-height:1.45; border-bottom:1px solid var(--border); }
.mail-sheet-status { margin:0; padding:8px 16px 0; color:var(--muted); font-size:12px; line-height:1.45; }
.mail-sheet-status:empty { display:none; }
.mail-sheet-body { flex:1; min-height:0; overflow-y:auto; padding:6px 0 12px; }
.mail-sheet-problem { margin:8px 16px; padding-left:8px; border-left:2px solid var(--danger); color:var(--fg); font-size:12px; line-height:1.5; }
.mail-sheet-problem > p { margin:0; }
.mail-sheet-unreadable { margin:4px 0 0; padding-left:16px; color:var(--fg); }
.mail-sheet-problem code { font-family:var(--mono, monospace); font-size:11.5px; }
.mail-sheet-problem details { margin-top:4px; color:var(--muted); font-size:11.5px; }
.mail-sheet-problem pre { margin:4px 0 0; white-space:pre-wrap; overflow-wrap:anywhere; font-family:var(--mono, monospace); font-size:11px; color:var(--fg); }
.mail-sheet-empty { margin:16px; color:var(--muted); font-size:12px; }
.mail-list { list-style:none; margin:0; padding:0; }
.mail-item { border-bottom:1px solid var(--border); }
.mail-item-toggle { display:flex; flex-direction:column; gap:2px; width:100%; box-sizing:border-box; padding:9px 16px 4px; border:0; background:transparent; color:var(--fg);
  font:inherit; text-align:left; cursor:pointer; }
.mail-item-toggle:hover { background:var(--surface-2); }
.mail-item-line { display:flex; align-items:baseline; gap:8px; min-width:0; }
.mail-item-who { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font-size:11.5px; }
.mail-item-who b { color:var(--fg); font-weight:650; }
.mail-item-time { flex:none; color:var(--muted); font-size:11.5px; }
.mail-item-subject { font-weight:650; line-height:1.4; overflow-wrap:anywhere; }
.mail-item-marks { display:flex; flex-wrap:wrap; gap:4px; margin:2px 0 0; padding:0; list-style:none; }
.mail-item-marks li { font-size:11px; line-height:1; padding:3px 7px; border:1px solid var(--border); border-radius:999px; color:var(--muted); }
.mail-item-marks li.is-warn { color:var(--warn); }
.mail-item-quote { margin:0; padding:2px 16px 10px; }
.mail-item-lead { margin:0 0 3px; color:var(--muted); font-size:11.5px; }
.mail-item-text { margin:0; padding:1px 0 1px 8px; border-left:2px solid var(--border); color:var(--fg); font-size:12.5px; line-height:1.5;
  white-space:pre-wrap; overflow-wrap:anywhere; }
.mail-item:not(.is-open) .mail-item-text { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:6; overflow:hidden; }
.mail-item-note { margin:4px 0 0; color:var(--muted); font-size:11.5px; line-height:1.45; }
.mail-sheet-more { display:block; margin:12px 16px 0; height:28px; padding:0 12px; border:1px solid var(--border); border-radius:6px; background:var(--surface);
  color:var(--fg); font:600 12px/1 inherit; cursor:pointer; }
.mail-sheet-more:hover:not(:disabled) { background:var(--surface-2); }
.mail-sheet-more[hidden], .mail-list[hidden], .mail-sheet-empty[hidden] { display:none; }
.mail-sheet-more:disabled { color:var(--muted); cursor:default; }
`;

/** What a failed read says: `{ lines: [string | {code: string}], code, detail }`. `lines` are the Desktop's words,
 * where `{code}` is a command set as code; `detail` the provider's or kernel's own message, shown under Details. */
export function mailFailure(error, row) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const said = typeof error?.answered === 'string' ? error.answered : typeof error?.message === 'string' ? error.message : '';
  const own = displayLine(said);
  const detail = own && own !== DETAIL_WITHHELD ? own : null;
  if (code === 'E_OPERATION_UNKNOWN') return { lines: [MAIL_WORDS.tooOld[0], { code: MAIL_WORDS.tooOld[1] }, MAIL_WORDS.tooOld[2]], code, detail: null };
  if (code === 'E_OPERATION_UNAVAILABLE') return { lines: [MAIL_WORDS.noMessaging], code, detail: null };
  if (code === 'E_MAIL_UNREADABLE') return { lines: [MAIL_WORDS.noIdentity], code, detail };
  if (code === 'E_AW_TOO_OLD') return { lines: [MAIL_WORDS.awTooOld(detail)], code, detail: null };
  // A host's refusal, relayed (remote-address.mjs): its headline is already the sentence, but for a host too old
  // for operations, which says so for mail.
  if (row?.server && (code === 'E_REMOTE_INCOMPATIBLE' || error?.reason?.code === 'E_REMOTE_INCOMPATIBLE')) {
    return { lines: [MAIL_WORDS.remoteTooOld(shownLabel(serverLabel(row)))], code: 'E_REMOTE_INCOMPATIBLE', detail: null };
  }
  if (row?.server && error?.reason) {
    const relayed = relayedFailure(error, serverLabel(row), 'mail');
    return { lines: [displayLine(relayed.message) ?? MAIL_WORDS.failed], code: relayed.code ?? code, detail: displayLine(relayed.detail) };
  }
  // The Desktop's own refusal (nothing ran: this computer's CLI has no operations API 2) says why.
  if (!code || code === 'cli-no-operations') return { lines: [detail ?? MAIL_WORDS.failed], code, detail: null };
  return { lines: [MAIL_WORDS.failed], code, detail };
}

/** A refusal of the Desktop's own, before anything is sent (the CLI held back, a remote row that can't be routed):
 * its sentence, and its code and detail when it has them. */
export function ownFailure(error) {
  return { lines: [displayLine(error?.message) ?? MAIL_WORDS.failed], code: typeof error?.code === 'string' ? error.code : '',
    detail: displayLine(error?.detail) };
}

/** The marks one message carries, in a fixed order: `[{ text, warn }]`. */
export function mailMarks(m) {
  const marks = [];
  if (m.encrypted) marks.push({ text: MAIL_WORDS.encrypted, warn: false });
  if (m.direction === 'received' && !m.readByAgent) marks.push({ text: MAIL_WORDS.unread, warn: false });
  if (m.priority === 'high') marks.push({ text: MAIL_WORDS.high, warn: true });
  // Anything but a verified signature says so: unknown is not verified either.
  if (m.verification === 'unverified' || m.verification === 'unknown') marks.push({ text: MAIL_WORDS.unverified, warn: true });
  if (m.verification === 'failed') marks.push({ text: MAIL_WORDS.signatureFailed, warn: true });
  return marks;
}

let sheets = 0;

/**
 * @param {object} deps
 * @param {Document} deps.doc
 * @param {(workspace: string, body: object) => Promise<object>} deps.request  POST /api/capabilities for the workspace
 * @param {() => number} [deps.generation]  the window's workspace generation; a change closes the sheet
 * @param {(fn) => () => void} [deps.subscribeWorkspace]
 * @param {() => object} [deps.cli]  this computer's CLI state (remote routing; cli-status.mjs cliStatus)
 * @param {() => string|null} [deps.heldBack]  the above-tested notice for an operation run, or null
 * @param {() => void} [deps.onIntent]
 * @param {(fn) => void} [deps.applyFocus]
 * @param {() => number} [deps.now]
 */
export function createMailSheet({ doc, request, generation = () => 0, subscribeWorkspace = () => () => {}, cli = () => null,
  heldBack = () => null, onIntent = () => {}, applyFocus = fn => fn(), now = () => Date.now() } = {}) {
  let alive = true, overlay = null, ui = null, restore = null, life = 0, serial = 0, release = null, outside = null, contain = null;
  const node = (tag, cls, value) => { const el = doc.createElement(tag); if (cls) el.className = cls; if (value !== undefined && value !== null) el.textContent = value; return el; };
  const unsubscribe = subscribeWorkspace(() => close({ focus: 'none' }));

  function close({ focus = 'opener' } = {}) {
    release?.(); release = null;
    if (outside) { doc.removeEventListener('keydown', outside, true); outside = null; }
    if (contain) { doc.removeEventListener('focusin', contain, true); contain = null; }
    if (!overlay) return;
    life++; serial++; overlay.remove(); overlay = null; ui = null;
    const back = restore; restore = null;
    if (focus === 'none') return;
    applyFocus(() => { if (back?.restoreExact ? back.restoreExact() : back?.restore()) return; back?.restore(); });
  }

  /** The toggles in list order, and the one that holds the list's tab stop. */
  const toggles = () => (ui ? [...ui.list.querySelectorAll('.mail-item-toggle')] : []);
  function roving(at = null) {
    const all = toggles();
    const stop = at ?? all.find(b => b.tabIndex === 0) ?? all[0] ?? null;
    for (const b of all) b.tabIndex = b === stop ? 0 : -1;
    return stop;
  }

  function problem(failure, key) {
    const box = node('div', 'mail-sheet-problem'); box.dataset.mailProblem = failure.code || 'failed';
    const p = node('p');
    for (const part of failure.lines) p.append(typeof part === 'string' ? doc.createTextNode(part) : node('code', null, part.code));
    box.append(p);
    if (failure.code || failure.detail) {
      const more = node('details'), line = node('pre');
      line.append(...(failure.code ? codeLineNodes(doc, { code: failure.code, detail: failure.detail }) : [doc.createTextNode(failure.detail)]));
      const summary = node('summary', null, 'Details'); summary.dataset.focusKey = key;
      more.append(summary, line); box.append(more);
    }
    return box;
  }

  /** An identity whose read named the conversations it couldn't read: how many, and each one by the title a shown
   * message gives it, else unnamed with its id in the tooltip. Its other messages are shown as usual. */
  function unreadableBox(i, ids, messages) {
    const box = node('div', 'mail-sheet-problem');
    box.dataset.mailProblem = 'conversation-unreadable';
    box.append(node('p', null, MAIL_WORDS.unreadableConversations(mailLine(i.team), ids.length)));
    const list = node('ul', 'mail-sheet-unreadable');
    for (const id of ids) {
      // Ids are opaque per identity: only a message of this identity's team names it.
      const title = messages.find(m => m.team === i.team && m.conversationId === id && mailLine(m.threadTitle));
      const li = node('li', null, title ? mailLine(title.threadTitle) : MAIL_WORDS.unnamedConversation);
      if (!title) li.title = mailLine(id);
      li.dataset.conversation = id;
      list.append(li);
    }
    box.append(list);
    return box;
  }

  function item(m, { showTeam, partialNote }) {
    const key = messageKey(m), li = node('li', 'mail-item'), id = `mail-sheet-${ui.id}-${ui.items++}`;
    li.dataset.mailKey = key; li.dataset.direction = m.direction;
    if (ui.open.has(key)) li.classList.add('is-open');
    const toggle = node('button', 'mail-item-toggle'); toggle.type = 'button'; toggle.tabIndex = -1;
    toggle.setAttribute('aria-expanded', String(ui.open.has(key))); toggle.setAttribute('aria-controls', `${id}-quote`);
    const other = m.direction === 'received' ? m.from : m.to;
    const who = node('span', 'mail-item-who');
    who.append(doc.createTextNode(`${m.direction === 'received' ? MAIL_WORDS.received : MAIL_WORDS.sent} `), node('b', null, mailLine(other.alias)));
    if (showTeam) who.append(doc.createTextNode(` · ${mailLine(m.team)}`));
    const time = node('span', 'mail-item-time', ageText(m.createdAt, now())); time.title = m.createdAt;
    const line = node('span', 'mail-item-line'); line.append(who, time);
    const subject = node('span', 'mail-item-subject', mailLine(m.subject) || mailLine(m.threadTitle) || MAIL_WORDS.noSubject);
    toggle.append(line, subject);
    const marks = mailMarks(m);
    if (marks.length) {
      const ul = node('ul', 'mail-item-marks'); ul.setAttribute('aria-label', 'About this message');
      for (const mark of marks) ul.append(node('li', mark.warn ? 'is-warn' : '', mark.text));
      toggle.append(ul);
    }
    toggle.addEventListener('click', () => { if (ui) { onIntent(); setOpen(li, toggle, !li.classList.contains('is-open')); } });
    toggle.addEventListener('focus', () => roving(toggle));
    // The body: the sender's words, attributed to the sender, as plain text.
    const quote = node('div', 'mail-item-quote'); quote.id = `${id}-quote`;
    const lead = node('p', 'mail-item-lead', MAIL_WORDS.wrote(mailLine(m.from.alias))); lead.id = `${id}-lead`;
    quote.setAttribute('role', 'group'); quote.setAttribute('aria-labelledby', lead.id);
    const body = node('blockquote', 'mail-item-text', mailBodyLines(m.body).join('\n'));
    quote.append(lead, body);
    if (m.truncated) quote.append(node('p', 'mail-item-note', MAIL_WORDS.truncated));
    if (partialNote) { const note = node('p', 'mail-item-note', MAIL_WORDS.partial); note.dataset.mailPartial = ''; quote.append(note); }
    li.append(toggle, quote);
    return li;
  }
  function setOpen(li, toggle, open) {
    li.classList.toggle('is-open', open); toggle.setAttribute('aria-expanded', String(open));
    if (open) ui.open.add(li.dataset.mailKey); else ui.open.delete(li.dataset.mailKey);
  }

  /** Where focus is in the sheet, as a key that survives a repaint: a message's, a problem's Details, or a control's
   * own (refresh, close, older); null when it is not in the sheet. */
  function focusKey() {
    const el = doc.activeElement;
    if (!ui || !el || !ui.dialog.contains(el)) return null;
    const message = el.closest?.('.mail-item')?.dataset.mailKey;
    if (message) return `message:${message}`;
    if (el.dataset?.focusKey) return el.dataset.focusKey;
    return el.dataset?.mailAction ? `action:${el.dataset.mailAction}` : 'sheet';
  }
  /** After a repaint, focus that was in the sheet stays in it: on the same control when it is still there and enabled,
   * else on the list's stop, else on Older mail, else on Close, which is always there. Never on <body>. */
  function keepFocus(key) {
    if (!ui || key === null || ui.dialog.contains(doc.activeElement)) return;
    const usable = el => el && el.isConnected && !el.disabled && !el.hidden;
    const same = key.startsWith('message:') ? toggles().find(b => `message:${b.closest('.mail-item')?.dataset.mailKey}` === key)
      : key.startsWith('action:') ? ui.dialog.querySelector(`[data-mail-action="${key.slice(7)}"]`)
      : [...ui.dialog.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === key);
    const next = [same, toggles().find(b => b.tabIndex === 0), ui.problems.querySelector('summary'), ui.more, ui.closeButton].find(usable);
    next?.focus();
  }

  /** Paints the messages held, keeping focus where it was (by key) across a repaint. */
  function paint() {
    if (!ui) return;
    const { state } = ui;
    const kept = focusKey();
    const focusedKey = doc.activeElement?.closest?.('.mail-item')?.dataset.mailKey ?? null;
    const stopKey = toggles().find(b => b.tabIndex === 0)?.closest('.mail-item')?.dataset.mailKey ?? null;
    ui.list.replaceChildren(); ui.problems.replaceChildren();
    ui.dialog.setAttribute('aria-busy', String(!!state.reading));
    ui.refresh.disabled = !!state.reading;
    ui.status.textContent = state.reading === 'first' ? MAIL_WORDS.reading : state.reading === 'older' ? MAIL_WORDS.readingOlder : '';
    if (state.failure) ui.problems.append(problem(state.failure, 'problem:read'));
    // Identities that could not be read: said once each, the rest of the mail shown.
    for (const i of state.identities.filter(x => x.error)) {
      const named = Array.isArray(i.unreadableConversations) ? i.unreadableConversations : [];
      const box = named.length ? unreadableBox(i, named, state.messages)
        : problem({ lines: [MAIL_WORDS.identityFailed(mailLine(i.team), i.error)], code: '', detail: null }, `problem:identity:${i.team}`);
      box.dataset.mailIdentity = i.team; ui.problems.append(box);
    }
    const showTeam = new Set(state.identities.map(i => i.team)).size > 1;
    const noted = new Set();
    for (const m of state.messages) {
      const partial = m.conversationId !== null && state.partial.has(m.conversationId) && !noted.has(m.conversationId);
      if (partial) noted.add(m.conversationId);
      ui.list.append(item(m, { showTeam, partialNote: partial }));
    }
    ui.list.hidden = !state.messages.length;
    ui.empty.hidden = !(state.loaded && !state.messages.length && !state.failure);
    // A cursor that can't travel as an argument is no way to the next page from here: no button.
    ui.more.hidden = !(state.loaded && cursorUsable(state.nextCursor));
    ui.more.disabled = !!state.reading;
    ui.more.textContent = state.reading === 'older' ? MAIL_WORDS.readingOlder : MAIL_WORDS.older;
    const find = key => key && toggles().find(b => b.closest('.mail-item')?.dataset.mailKey === key);
    const stop = roving(find(stopKey) || null);
    const back = find(focusedKey);
    if (back) back.focus(); else if (focusedKey && stop) stop.focus();
    keepFocus(kept);
  }

  /** One read: the first page (`older: false`, which replaces what is held) or the next one. */
  async function read({ older = false } = {}) {
    if (!ui) return;
    const { state, row, workspace } = ui, mounted = life, ticket = ++serial, gen = generation();
    const owns = () => alive && !!ui && life === mounted && ticket === serial && generation() === gen;
    if (older && !cursorUsable(state.nextCursor)) return;
    const held = heldBack();
    // Nothing is sent while the CLI is held back or the row can't be routed from here: the reason is said instead.
    if (held) { state.failure = ownFailure({ message: held }); state.reading = null; paint(); return; }
    const blocked = remoteInspectBlock(row, cli());
    if (blocked) { state.failure = ownFailure(blocked); state.reading = null; paint(); return; }
    state.reading = older ? 'older' : 'first'; state.failure = null; paint();
    let answer;
    try {
      const result = await request(workspace, { action: 'run', selector: { home: row.home }, operation: MAIL_OPERATION,
        args: mailArgs({ cursor: older ? state.nextCursor : null }) });
      if (!owns()) return;
      answer = mailAnswer(result);
      if (!answer) { state.reading = null; state.failure = { lines: [MAIL_WORDS.unreadable], code: '', detail: null }; paint(); return; }
    } catch (error) {
      if (!owns()) return;
      state.reading = null; state.failure = mailFailure(error, row); paint(); return;
    }
    if (older) {
      const seen = new Set(state.messages.map(messageKey));
      state.messages = [...state.messages, ...answer.messages.filter(m => !seen.has(messageKey(m)))];
      for (const id of answer.partial) state.partial.add(id);
    } else {
      state.messages = answer.messages; state.partial = answer.partial;
    }
    state.identities = answer.identities; state.nextCursor = answer.nextCursor; state.loaded = true; state.reading = null;
    paint();
  }

  /** The sheet's tab stops, in order. */
  const stops = () => [ui.refresh, ui.closeButton, ...ui.problems.querySelectorAll('summary'), ...toggles().filter(b => b.tabIndex === 0),
    ...(ui.more.hidden ? [] : [ui.more])].filter(el => el.isConnected && !el.disabled);

  /**
   * Opens the sheet for `row` (a roster row: { instance, home, server? }) in `workspace` (its deployment id), and
   * reads its mail. Answers whether it opened.
   */
  function open(row, workspace) {
    if (!alive || !row || typeof row.instance !== 'string' || typeof row.home !== 'string' || typeof workspace !== 'string' || !workspace) return false;
    close({ focus: 'none' });
    onIntent(); restore = takePickerFocusReturn(doc); life++;
    const id = ++sheets;
    overlay = node('div', 'palette-overlay mail-sheet-overlay');
    const dialog = node('aside', 'mail-sheet'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    dialog.dataset.instance = row.instance;
    const head = node('div', 'mail-sheet-head'), h2 = node('h2', null, MAIL_WORDS.title(shownInstance(row.instance))); h2.id = `mail-sheet-${id}-title`;
    const tool = (icon, label) => { const b = node('button', 'mail-sheet-tool'); b.type = 'button'; b.setAttribute('aria-label', label); b.title = label;
      b.append(iconElement(doc, icon, { size: 15 })); return b; };
    const refresh = tool('refresh', MAIL_WORDS.refresh), closeButton = tool('close', MAIL_WORDS.close);
    refresh.dataset.mailAction = 'refresh'; closeButton.dataset.mailAction = 'close';
    head.append(h2, refresh, closeButton);
    const lead = node('p', 'mail-sheet-lead', MAIL_WORDS.lead); lead.id = `mail-sheet-${id}-lead`;
    const status = node('p', 'mail-sheet-status'); status.setAttribute('role', 'status');
    const body = node('div', 'mail-sheet-body'), problems = node('div'), list = node('ol', 'mail-list'), empty = node('p', 'mail-sheet-empty', MAIL_WORDS.empty);
    list.setAttribute('aria-label', MAIL_WORDS.list); list.hidden = true; empty.hidden = true;
    const more = node('button', 'mail-sheet-more', MAIL_WORDS.older); more.type = 'button'; more.hidden = true; more.dataset.mailAction = 'older';
    body.append(problems, list, empty, more);
    dialog.setAttribute('aria-labelledby', h2.id); dialog.setAttribute('aria-describedby', lead.id);
    dialog.append(head, lead, status, body); overlay.append(dialog);
    ui = { id, dialog, refresh, closeButton, status, problems, list, empty, more, row: { ...row }, workspace, items: 0, open: new Set(),
      state: { messages: [], identities: [], partial: new Set(), nextCursor: null, loaded: false, reading: null, failure: null } };
    const mounted = life, owns = () => alive && !!ui && life === mounted;
    refresh.addEventListener('click', () => { if (owns() && !ui.state.reading) { onIntent(); void read(); } });
    closeButton.addEventListener('click', () => { if (owns()) close(); });
    more.addEventListener('click', () => { if (owns() && !ui.state.reading) { onIntent(); void read({ older: true }); } });
    // The scrim (the overlay itself, not the sheet) closes it.
    overlay.addEventListener('mousedown', event => { if (owns() && event.target === overlay) { event.preventDefault(); close(); } });
    overlay.addEventListener('keydown', event => {
      if (!owns() || event.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      const all = toggles(), at = all.indexOf(doc.activeElement);
      const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
      if (plain && at >= 0 && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : Math.min(Math.max(at + (event.key === 'ArrowDown' ? 1 : -1), 0), all.length - 1);
        roving(all[next]); all[next].focus(); all[next].scrollIntoView?.({ block: 'nearest' });
        return;
      }
      if (plain && !event.shiftKey && (event.key === 'r' || event.key === 'R') && !event.repeat) {
        event.preventDefault(); event.stopPropagation();
        if (!ui.state.reading) { onIntent(); void read(); }
        return;
      }
      if (event.key !== 'Tab') return;
      // Focus stays in the sheet: Tab and Shift+Tab cycle its stops.
      event.preventDefault();
      const list = stops(); if (!list.length) return;
      const i = list.indexOf(doc.activeElement);
      const next = list[(i < 0 ? 0 : i + (event.shiftKey ? -1 : 1) + list.length) % list.length];
      next.focus();
    });
    doc.body.append(overlay);
    // The sheet is modal: a key pressed while focus is somewhere else (a control that left under it) is still the
    // sheet's for Esc, which closes it, and Tab, which brings focus back into it. Every other key goes where it goes.
    outside = event => {
      if (!owns() || event.isComposing || overlay.contains(event.target)) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); keepFocus('sheet'); }
    };
    doc.addEventListener('keydown', outside, true);
    // Focus is contained too: a shortcut that focuses something behind the scrim (the roster's Alt+F, the workspace
    // list's Alt+O) brings it straight back to where it was in the sheet. Another modal that takes focus (a dialog
    // over this one) closes the sheet instead, as the shared pickers' handoff does.
    let last = null;
    contain = event => {
      if (!owns()) return;
      if (overlay.contains(event.target)) { last = event.target; return; }
      if (event.target?.closest?.('[aria-modal="true"], .palette-overlay')) { close({ focus: 'none' }); return; }
      const back = last && last.isConnected && !last.disabled ? last : null;
      if (back) back.focus(); else keepFocus('sheet');
    };
    doc.addEventListener('focusin', contain, true);
    release = joinPickerFocusReturn(doc, { opener: restore, dismiss: () => close({ focus: 'none' }) });
    closeButton.focus();
    void read();
    return true;
  }

  return {
    open,
    close: () => close(),
    isOpen: () => !!overlay,
    /** The agent the open sheet reads, or null. */
    current: () => (ui ? { instance: ui.row.instance, home: ui.row.home, server: ui.row.server ?? null, workspace: ui.workspace } : null),
    dispose() { if (!alive) return; close({ focus: 'none' }); alive = false; unsubscribe?.(); },
  };
}
