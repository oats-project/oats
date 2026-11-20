/** The agent view (the Desktop UI rework, stage 2, S2-D; contract D30 v4): the agent's terminal tab, with the board the
 * agent reports around its terminal. Top to bottom in the tab's pane:
 *   1. the facts strip (`.agent-facts`): compact "label · value unit" facts, at most FACTS_SHOWN shown and the rest
 *      folded, each with "updated <time>", a sparkline once its history is read, its link as attributed text that
 *      opens in the system browser on a press, and × (or u) to hide it on this computer only;
 *   2. the agent's own terminal (today's `.term-wrap`, its geometry untouched: the only scrolling region);
 *   3. the question zone (`.agent-questions`): one open question at a time, full width, its numbered options,
 *      "question n of N" with ‹ › and dots, and the question's context in a fold, attributed;
 *   4. the terminal's input line, which is the harness's own, inside the terminal grid: unchanged. The zone sits
 *      right under it.
 *
 * Answering: a number (a press of the option, or its digit while the zone has focus) puts `<id>: <option>` on the
 * terminal's input line through the tab's own PTY lease (`type`), unsent, and gives the terminal the focus: the
 * person's Enter there sends it, as typing would. No bare digit is ever typed, nothing with a line end, and nothing
 * the person can't see. While the agent has a live `permission` or `question` claim (a harness dialog on its screen),
 * the numbers are disabled and the zone says so. After the person's Enter the card hides on this tab (optimistic);
 * the agent's `board ask --clear` removes it for real.
 *
 * Pure DOM, no shell state: agent-board-tabs.mjs (createTabBoards, synced from shell.mjs syncTabNeedsInput) gives it the validated board, the claims and the detail read,
 * and the hooks to type, to focus the terminal and to open a link. The board's own facts and questions are
 * agent-supplied text: every text is set with textContent, never as markup (source-prose-is-an-attributed-quote). */
import { iconElement } from './shell-icons.mjs';
import { DESKTOP_BOARD_WORDS } from './desktop-terms.mjs';
import { FACTS_SHOWN, questionOccurrence, factsView, answerText, questionCount, turnQuestion, updatedText, sparkValues, dialogOpen, boardContext } from '../../client/instance-board.mjs';
import { waitedText } from '../../client/waiting-on-you.mjs';
import { displayLine } from '../../client/display-text.mjs';

/** What the zone says while a harness dialog is open (contract D30 v4, "How an answer is typed"). */
export const DIALOG_NOTE = "The agent's terminal is showing a prompt: answer it there first.";
/** What the zone says when main refused to type an answer: the terminal is in its scrollback (tmux copy mode), where the
 * answer's first letter would be read as a key of the scrollback's own (terminal-owner answer, E_TERM_IN_MODE). */
export const IN_MODE_NOTE = 'The terminal is in its scrollback: press q or scroll to the bottom, then press the number again.';
/** What the zone says to a press while an earlier answer is still on the input line, unsent: a second one would be
 * typed onto the same line, and the Desktop can't clear a harness's line for it. */
/** What the zone says when main could not tell whether the terminal is in its scrollback (a failed read, or an agent on
 * another machine, whose pane this computer can't read): it types only on a read that says no, so nothing was typed. */
export const MODE_UNKNOWN_NOTE = "The answer wasn't typed: the Desktop couldn't check the terminal's scrollback. Type it there yourself, or press the number again.";
/** What the zone says on an agent on another machine: its pane can't be checked for the scrollback from here (main
 * answers an answer there E_TERM_MODE_UNKNOWN, fail closed), so the numbers are disabled from the start and the person
 * types the answer in its terminal. `example` is the shown question's first answer. Follow-up: #2029. */
export const remoteNote = example => `This agent runs on another machine: type the answer in its terminal (for example ${example}).`;
export const PENDING_NOTE = 'An answer is already on the input line: send it, or clear it first.';
/** What the view says for each outcome of the detail read (instance-board.mjs boardDetailData, and `failed`), and
 * for a row board that was not read whole: none of them reads as "no history" or "no questions". */
export const DETAIL_NOTES = Object.freeze({
  failed: { history: 'History could not be read.', context: 'The context could not be read.' },
  malformed: { history: 'History came in a shape this Desktop can\'t read.', context: 'The context came in a shape this Desktop can\'t read.' },
  unsupported: { history: 'This OATS sends no history.', context: 'This OATS sends no context: ask the agent.' },
  none: { history: 'The agent has no board now.', context: 'The agent has no board now.' },
});
export const BOARD_MALFORMED = "This agent's board could not be read.";
export const boardDropped = n => `${n} ${n === 1 ? 'entry' : 'entries'} of this agent's board could not be shown.`;
/** The zone's key hint: the shown question's own number keys. */
export const zoneHint = count => `1–${count} put the answer on the input line · Enter there sends it · c the context · Esc back to the terminal`;
const HIDDEN_STORE = 'oats.desktop.board.hidden';

/** The person's hidden facts on this computer, by agent home: `{ [home]: { [key]: value } }` in `storage`
 * (localStorage by default), read and written whole, bounded (at most 200 homes, 12 keys each). Client-side only:
 * the kernel's `unset` is the agent's. A fact shows again when its value changes. */
export function createHiddenFacts(storage = globalThis.localStorage) {
  const read = () => {
    try { const v = JSON.parse(storage?.getItem(HIDDEN_STORE) ?? '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
    catch { return {}; }
  };
  const write = all => {
    const homes = Object.keys(all);
    for (const h of homes.slice(0, Math.max(0, homes.length - 200))) delete all[h];
    try { storage?.setItem(HIDDEN_STORE, JSON.stringify(all)); } catch { /* storage full or unavailable: hidden for this session only */ }
  };
  const session = new Map(); // home -> Map(key -> value), also when storage fails
  return {
    get(home) {
      const stored = read()[home], out = new Map(session.get(home) ?? []);
      if (stored && typeof stored === 'object') for (const [k, v] of Object.entries(stored)) if (typeof v === 'string') out.set(k, v);
      return out;
    },
    hide(home, key, value) {
      const mine = session.get(home) ?? new Map(); mine.set(key, value); session.set(home, mine);
      const all = read(), entry = all[home] && typeof all[home] === 'object' ? all[home] : {};
      entry[key] = value; all[home] = Object.fromEntries(Object.entries(entry).slice(-12)); write(all);
    },
    showAll(home) {
      session.delete(home);
      const all = read(); delete all[home]; write(all);
    },
  };
}

const node = (doc, tag, cls, text) => { const el = doc.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; return el; };
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const DIGIT = /^[1-9]$/;
const plain = ev => !ev.ctrlKey && !ev.altKey && !ev.metaKey;

/** A sparkline of `values` (two or more numbers), as an SVG polyline the reader skips (its fact says the value). */
function sparkline(doc, values) {
  const NS = 'http://www.w3.org/2000/svg', svg = doc.createElementNS(NS, 'svg');
  const lo = Math.min(...values), hi = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1) * 100).toFixed(1)},${(hi === lo ? 50 : 90 - (v - lo) / (hi - lo) * 80).toFixed(1)}`).join(' ');
  for (const [k, v] of [['class', 'agent-fact-spark'], ['viewBox', '0 0 100 100'], ['preserveAspectRatio', 'none'], ['aria-hidden', 'true'], ['focusable', 'false']]) svg.setAttribute(k, v);
  const line = doc.createElementNS(NS, 'polyline');
  for (const [k, v] of [['points', pts], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '2'], ['vector-effect', 'non-scaling-stroke']]) line.setAttribute(k, v);
  svg.append(line);
  return svg;
}

/** The least the terminal keeps of its pane: TERMINAL_MIN_PX, or TERMINAL_MIN_SHARE of the pane when that is more. */
export const TERMINAL_MIN_PX = 120, TERMINAL_MIN_SHARE = 0.4;
/** The least an open context keeps when the budget's last step shortens it (three lines; it scrolls in its fold). */
export const CONTEXT_MIN_PX = 54;
/** The least of the terminal that must be on screen for a number to type: a terminal the board squeezed below it
 * (a pane too short for the board) is not one the person can see their answer land in. */
export const TERMINAL_TYPE_MIN_PX = 36;
/** The pane's height for the board (its room) and the height the board takes now, from the DOM. */
const defaultMeasure = {
  room: pane => pane.clientHeight > 0 ? pane.clientHeight - Math.max(TERMINAL_MIN_PX, pane.clientHeight * TERMINAL_MIN_SHARE) : null,
  // Everything in the pane but the terminal: the facts, the zone and a waiting row beside them.
  used: pane => [...pane.children].reduce((n, el) => n + (el.classList.contains('term-wrap') ? 0 : el.offsetHeight), 0),
  height: el => el.offsetHeight,
  // The terminal's height on screen; null where nothing is laid out (no measure: not a reason to refuse).
  terminal: pane => { const wrap = pane.querySelector(':scope > .term-wrap'); return wrap && pane.clientHeight > 0 ? wrap.offsetHeight : null; },
};
const observePane = (pane, fn) => {
  if (typeof ResizeObserver !== 'function') return () => {};
  const observer = new ResizeObserver(fn); observer.observe(pane);
  return () => observer.disconnect();
};

/**
 * The board on one terminal tab's pane.
 * @param {object} o
 * @param {HTMLElement} o.pane      the tab's pane (the terminal's `.term-wrap` is its child)
 * @param {string} o.home           the agent's home (the hidden facts' key)
 * @param {string} o.name           the agent's name, for "<name> says:" and the accessible names
 * @param {(text: string) => boolean} o.type   puts text on the terminal's input line through the tab's PTY lease;
 *                                  false when nothing was written (no live lease)
 * @param {() => void} o.focusTerminal
 * @param {(url: string) => void} o.openLink   the system browser (the Desktop's external-open path)
 * @param {() => Promise<{ latest: boolean }>} [o.checkClaims]  reads the agent's live claims now; `latest`: no newer read
 *                                  began meanwhile (its claims then reached `update`)
 * @param {boolean} [o.remote]   the agent runs on another machine: its numbers never type (remoteNote)
 * @param {() => boolean} [o.shown]  this tab's terminal is the one in view (the shell's test)
 * @param {ReturnType<typeof createHiddenFacts>} [o.hidden]
 * @param {() => number} [o.now]
 * @param {object} [o.measure]  the pane's room and what the board takes (layout; DOM by default)
 * @param {(pane: HTMLElement, fn: () => void) => () => void} [o.observe]  the pane's size (a ResizeObserver by default)
 */
export function createAgentBoard({ pane, home, name, type, focusTerminal, openLink, checkClaims = null, remote = false, shown: inView = () => true, hidden = createHiddenFacts(), now = () => Date.now(),
  measure: measured = {}, observe = observePane }) {
  const measure = { ...defaultMeasure, ...measured };
  const doc = pane.ownerDocument;
  let board = null, detail = null, dialog = false, unfolded = false, index = 0, shownId = null, pending = null, alive = true, chooseSeq = 0, painting = false, compact = false, openUrl = null, refusal = null;
  // Each fact's row as last painted (its key -> { sig, li }): paintFacts keeps a row whose sig is unchanged.
  const factRows = new Map();
  // A question's occurrence (instance-board.mjs questionOccurrence): its answer, its context and its options are its own.
  const occurrence = questionOccurrence;
  const answered = new Set(); // occurrences whose answer the person sent from this tab (hidden until the agent clears them)

  // ── the facts strip ──
  const facts = node(doc, 'section', 'agent-facts');
  facts.setAttribute('aria-label', `${DESKTOP_BOARD_WORDS.facts} from ${name}`);
  const factList = node(doc, 'ul', 'agent-fact-list');
  const fold = node(doc, 'button', 'agent-facts-fold'); fold.type = 'button';
  const factsNote = node(doc, 'span', 'agent-facts-note');
  const urlBox = node(doc, 'div', 'agent-fact-url'); urlBox.setAttribute('role', 'group');
  urlBox.addEventListener('keydown', ev => { if (ev.key === 'Escape' && plain(ev)) { ev.preventDefault(); ev.stopPropagation(); const key = openUrl; openUrl = null; paint(); facts.querySelector(`li[data-key="${key}"] .agent-fact-link`)?.focus(); } });
  const shown = node(doc, 'button', 'agent-facts-unhide'); shown.type = 'button';
  facts.append(factList, fold, shown, factsNote, urlBox);
  fold.addEventListener('click', () => { unfolded = !unfolded; paint(); fold.focus(); });
  shown.addEventListener('click', () => { hidden.showAll(home); paint(); focusFacts(); });

  // ── the question zone ──
  const zone = node(doc, 'section', 'agent-questions'); zone.tabIndex = -1;
  const head = node(doc, 'div', 'agent-q-head');
  const tag = node(doc, 'span', 'agent-q-tag');
  const nav = node(doc, 'span', 'agent-q-nav');
  const prev = node(doc, 'button', 'agent-q-turn', '‹'); prev.type = 'button'; prev.setAttribute('aria-label', 'Previous question'); prev.title = 'Previous question (Shift+Tab, ←)';
  const dots = node(doc, 'span', 'agent-q-dots');
  const next = node(doc, 'button', 'agent-q-turn', '›'); next.type = 'button'; next.setAttribute('aria-label', 'Next question'); next.title = 'Next question (Tab, →)';
  nav.append(prev, dots, next);
  const age = node(doc, 'span', 'agent-q-age');
  head.append(tag, nav, age);
  const text = node(doc, 'p', 'agent-q-text'); text.dir = 'auto'; text.id = `agent-q-${Math.random().toString(36).slice(2, 10)}`;
  const options = node(doc, 'ol', 'agent-q-options');
  const note = node(doc, 'p', 'agent-q-note'); note.setAttribute('role', 'status');
  const context = node(doc, 'details', 'agent-q-context');
  const contextSummary = node(doc, 'summary', null, 'Context');
  const contextBody = node(doc, 'div', 'agent-q-context-body');
  context.append(contextSummary, contextBody);
  const hint = node(doc, 'p', 'agent-q-hint');
  zone.append(head, text, options, note, context, hint);
  zone.setAttribute('aria-describedby', text.id);
  prev.addEventListener('click', () => turn(-1));
  next.addEventListener('click', () => turn(1));

  const open = () => (board?.questions ?? []).filter(q => !answered.has(occurrence(q)));

  function turn(step) {
    const list = open();
    if (list.length < 2) return;
    index = turnQuestion(index, step, list.length); shownId = list[index].id;
    paint();
  }
  /** Option `i` of the shown question: types `<id>: <option>` and gives the terminal the focus. Never with the view off
   * screen (`shown`: the shell's own test that this tab's terminal is the one in view), checked before the read, after
   * it and at the write. With `checkClaims`, the agent's claims are read again first: a harness dialog that opened
   * since the view last read them adds a claim the row may not show (its newest claim with a message can be the
   * board's own). That read's answer counts only if it is the latest claims read (`latest`); an older one cancels the
   * press, and its claims are never used. A failed latest read is unknown, not a dialog: the person's Enter, with the
   * terminal in view, stays the consent. A newer press, a closed view or another question shown meanwhile types
   * nothing. */
  const terminalSeen = () => { const h = measure.terminal(pane); return h === null || h >= TERMINAL_TYPE_MIN_PX; };
  async function choose(i) {
    const q = open()[index];
    if (!q || dialog || remote || answerText(q, i) === null || !inView() || !terminalSeen()) return false;
    // One answer on the line at a time: a second press before the person's Enter would be typed onto the first.
    if (pending) { refusal = PENDING_NOTE; paint(); return false; }
    const seq = ++chooseSeq;
    if (checkClaims) {
      zone.setAttribute('aria-busy', 'true');
      let read = null;
      try { read = await checkClaims(); } catch { read = null; }
      if (seq === chooseSeq) zone.removeAttribute('aria-busy');
      if (!alive || seq !== chooseSeq || read?.latest !== true) return false;
      // The latest read has already set the claims (update); a dialog it saw is `dialog` now.
      const still = open()[index];
      if (dialog || !still || occurrence(still) !== occurrence(q) || !inView()) return false;
    }
    const answer = answerText(open()[index], i);
    if (!answer || !inView() || !terminalSeen() || pending) return false;
    // Held while main types it, so a press meanwhile is refused as one after it would be.
    const mine = occurrence(q);
    pending = mine;
    let typed = type(answer);
    if (typed && typeof typed.then === 'function') {
      try { typed = await typed; } catch { typed = false; }
    }
    if (typed !== true) {
      if (pending === mine) pending = null;
      refusal = typed === 'in-mode' ? IN_MODE_NOTE : typed === 'mode-unknown' ? MODE_UNKNOWN_NOTE : null;
      if (alive) paint();
      return false;
    }
    if (refusal) { refusal = null; paint(); }
    if (alive && seq === chooseSeq) focusTerminal();
    return true;
  }

  // Reaching the zone (F6, the palette's command, a click) reads the claims again, so a dialog that opened since shows before a press. The
  // read paints through its owner (update) only when it is the latest; nothing here uses its answer.
  zone.addEventListener('focusin', ev => {
    // A repaint that moves the focus to an option's replacement is not an entry into the zone.
    if (!checkClaims || painting || zone.contains(ev.relatedTarget)) return;
    Promise.resolve().then(checkClaims).catch(() => null);
  });
  zone.addEventListener('keydown', ev => {
    if (!plain(ev)) return;
    const list = open();
    const inContext = context.contains(ev.target);
    if (ev.key === 'c' && !context.hidden) {
      // The context: c opens or closes the fold and gives its summary the focus, where Tab and Shift+Tab move as they
      // always do (into and out of the fold); the carousel keys are the zone's elsewhere.
      ev.preventDefault();
      context.open = !context.open; contextSummary.focus();
    } else if (DIGIT.test(ev.key) && !ev.shiftKey) {
      ev.preventDefault();
      void choose(Number(ev.key) - 1);
    } else if (!inContext && (ev.key === 'Tab' || ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && list.length > 1) {
      ev.preventDefault();
      turn(ev.key === 'ArrowLeft' || (ev.key === 'Tab' && ev.shiftKey) ? -1 : 1);
      zone.focus();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      focusTerminal();
    }
  });
  facts.addEventListener('keydown', ev => {
    if (!plain(ev)) return;
    const items = [...factList.querySelectorAll(':scope > li > .agent-fact-focus')];
    const at = items.indexOf(doc.activeElement);
    if ((ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && items.length) {
      ev.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, (at < 0 ? 0 : at) + (ev.key === 'ArrowRight' ? 1 : -1)))].focus();
    } else if ((ev.key === 'u' || ev.key === 'Delete') && at >= 0) {
      ev.preventDefault();
      hideFact(items[at].closest('li').dataset.key);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      focusTerminal();
    }
  });

  function hideFact(key) {
    const f = board?.facts.find(x => x.key === key);
    if (!f) return;
    const items = [...factList.querySelectorAll(':scope > li')], at = items.findIndex(li => li.dataset.key === key);
    hidden.hide(home, key, f.value);
    paint();
    // Focus stays in the strip: the fact that took its place, the one before it, or the strip's own control.
    const left = [...factList.querySelectorAll(':scope > li > .agent-fact-focus')];
    (left[Math.min(at, left.length - 1)] ?? (fold.hidden ? shown : fold)).focus?.();
  }

  function paintFact(f) {
    const li = node(doc, 'li', 'agent-fact'); li.dataset.key = f.key;
    const body = node(doc, 'span', 'agent-fact-focus'); body.tabIndex = -1;
    const label = node(doc, 'span', 'agent-fact-label', f.withheld ? displayLine(f.label) : f.label);
    const value = node(doc, 'b', 'agent-fact-value', f.withheld ? displayLine(f.value) : f.value); value.dir = 'auto';
    body.append(label, ' ', value);
    if (f.unit) body.append(' ', node(doc, 'span', 'agent-fact-unit', displayLine(f.unit)));
    const values = sparkValues(detail?.state === 'ok' ? detail.facts.get(f.key)?.history : null);
    if (values) body.append(' ', sparkline(doc, values), node(doc, 'span', 'agent-fact-sparknote', ` last ${values.length}`));
    const when = node(doc, 'span', 'agent-fact-updated', updatedText(f.at, now())); when.title = f.at;
    body.append(' ', when);
    // The accessible name is the shown text: a withheld label or value is withheld here too.
    const said = { label: displayLine(f.label), value: displayLine(f.value), unit: f.unit ? displayLine(f.unit) : null };
    body.setAttribute('aria-label', `${said.label}: ${said.value}${said.unit ? ` ${said.unit}` : ''}, ${updatedText(f.at, now())}`);
    li.append(body);
    if (f.link) {
      // The link's button names its host; a press shows the whole address, attributed, with Open in browser beside it,
      // so the person reads exactly what opens before it opens. Only that Open press opens it.
      const link = node(doc, 'button', 'agent-fact-link'); link.type = 'button';
      link.append(node(doc, 'span', 'agent-fact-says', `${name} says:`), ' ', node(doc, 'strong', 'agent-fact-host', f.link.host), '…');
      link.setAttribute('aria-expanded', String(openUrl === f.key));
      link.setAttribute('aria-label', `The address ${name} gives, on ${f.link.host}: show it`);
      link.addEventListener('click', () => { openUrl = openUrl === f.key ? null : f.key; paint(); facts.querySelector(openUrl ? '.agent-fact-url-open' : `li[data-key="${f.key}"] .agent-fact-link`)?.focus(); });
      li.append(link);
    }
    const close = node(doc, 'button', 'agent-fact-hide'); close.type = 'button';
    close.append(iconElement(doc, 'close', { size: 12 }));
    close.setAttribute('aria-label', `Hide ${displayLine(f.label)} on this computer`); close.title = 'Hide on this computer (u)';
    close.addEventListener('click', () => hideFact(f.key));
    li.append(close);
    return li;
  }

  function paintFacts() {
    const view = factsView(board?.facts ?? [], hidden.get(home), { unfolded, limit: compact ? 1 : FACTS_SHOWN });
    const notes = [board?.malformed ? BOARD_MALFORMED : board?.dropped > 0 ? boardDropped(board.dropped) : null,
      board?.facts.length && detail && detail.state !== 'ok' ? (DETAIL_NOTES[detail.state] ?? DETAIL_NOTES.malformed).history : null].filter(Boolean);
    setText(factsNote, notes.join(' ')); factsNote.hidden = !notes.length;
    const any = view.shown.length + view.folded.length + view.hidden.length > 0 || notes.length > 0;
    if (!any) { facts.remove(); return; }
    // The control that has the focus is given it back after a repaint that replaced it: the same fact's body, link or
    // hide button, or the address's Open button.
    const at = facts.contains(doc.activeElement) ? doc.activeElement : null;
    const focusedKey = at?.closest?.('li')?.dataset.key ?? null;
    const focusedPart = !at ? null : urlBox.contains(at) ? 'open' : at.classList.contains('agent-fact-link') ? 'link' : at.classList.contains('agent-fact-hide') ? 'hide' : 'body';
    // Each fact's row is rebuilt only when what it shows changed, and a row that stays is never taken out of the list,
    // whatever the repaint (a poll's, or the budget's: fit() lays the strip out full and then compact on every
    // repaint). A row taken out under the focus gives the focus back, and a focus in the pane selects its tab, which
    // reads the roster again and repaints: rebuilding the list on every repaint made that a loop, and a press landed
    // on a replaced button.
    const rows = view.shown.map(f => {
      const sig = JSON.stringify([f.label, f.value, f.unit, f.link?.href ?? null, !!f.withheld, f.at, updatedText(f.at, now()),
        sparkValues(detail?.state === 'ok' ? detail.facts.get(f.key)?.history : null), openUrl === f.key]);
      let row = factRows.get(f.key);
      if (row?.sig !== sig) { row = { sig, li: paintFact(f) }; factRows.set(f.key, row); }
      return row.li;
    });
    const live = new Set((board?.facts ?? []).map(f => f.key));
    for (const key of [...factRows.keys()]) if (!live.has(key)) factRows.delete(key);
    for (const li of [...factList.children]) if (!rows.includes(li)) li.remove();
    rows.forEach((li, i) => { if (factList.children[i] !== li) factList.insertBefore(li, factList.children[i] ?? null); });
    fold.hidden = !view.folded.length && !(unfolded && view.shown.length > FACTS_SHOWN);
    setText(fold, unfolded ? 'Fold' : `${view.folded.length} more`);
    fold.setAttribute('aria-expanded', String(unfolded));
    shown.hidden = !view.hidden.length;
    setText(shown, `${view.hidden.length} hidden · show`);
    // The whole address of the link the person asked to see, under the facts.
    const url = view.shown.find(f => f.key === openUrl && f.link)?.link ?? null;
    if (!url) openUrl = null;
    urlBox.hidden = !url;
    const urlKey = JSON.stringify(url ? [url.href, url.host] : null);
    // The same address keeps its nodes, and the focus on its Open.
    if (urlBox.dataset.key !== urlKey && !url) { urlBox.dataset.key = urlKey; urlBox.replaceChildren(); }
    else if (urlBox.dataset.key !== urlKey) {
      urlBox.dataset.key = urlKey;
      const lower = url.href.toLowerCase(), at = lower.indexOf(`//${url.host}`) + 2;
      const text = node(doc, 'p', 'agent-fact-url-text'); text.dir = 'ltr';
      // The host in bold where it is spelled in the address (any case); an address whose host the URL parser
      // rewrote (percent-encoded) is shown as written, unemphasised: the text is always exactly what opens.
      if (at >= 2) text.append(url.href.slice(0, at), node(doc, 'strong', 'agent-fact-host', url.href.slice(at, at + url.host.length)), url.href.slice(at + url.host.length));
      else text.append(url.href);
      const open = node(doc, 'button', 'agent-fact-url-open', 'Open in browser'); open.type = 'button';
      open.addEventListener('click', () => openLink(url.href));
      urlBox.setAttribute('aria-label', `The address ${name} gives`);
      urlBox.replaceChildren(node(doc, 'span', 'agent-fact-says', `${name} says:`), text, open);
    }
    if (facts.parentNode !== pane) pane.prepend(facts);
    // Given back where the focus left its control: a replaced row, or a kept one moved within the list (insertBefore
    // blurs it), as when the agent unsets a fact and sets it again, which puts it last.
    if (!at || doc.activeElement === at) return;
    if (focusedPart === 'open') urlBox.querySelector('.agent-fact-url-open')?.focus();
    else if (focusedKey) factList.querySelector(`:scope > li[data-key="${focusedKey}"] > ${focusedPart === 'link' ? '.agent-fact-link' : focusedPart === 'hide' ? '.agent-fact-hide' : '.agent-fact-focus'}`)?.focus();
  }

  function paintZone() {
    const list = open();
    if (!list.length) {
      const had = zone.contains(doc.activeElement);
      zone.remove(); index = 0; shownId = null;
      if (had) focusTerminal();
      return;
    }
    // The question shown stays the same one across repaints, by id; a closed one gives way to its neighbour.
    const kept = list.findIndex(q => q.id === shownId);
    index = kept >= 0 ? kept : Math.min(index, list.length - 1);
    const q = list[index]; shownId = q.id;
    const count = questionCount(index, list.length);
    setText(tag, count ?? 'needs you');
    nav.hidden = list.length < 2;
    const dotsKey = JSON.stringify([list.map(occurrence), index]);
    if (dots.dataset.key !== dotsKey) dots.dataset.key = dotsKey, dots.replaceChildren(...list.map((each, j) => {
      const d = node(doc, 'button', `agent-q-dot${j === index ? ' on' : ''}`); d.type = 'button';
      d.setAttribute('aria-label', `Question ${j + 1}`); if (j === index) d.setAttribute('aria-current', 'true');
      d.addEventListener('click', () => { index = j; shownId = each.id; paint(); zone.focus(); });
      return d;
    }));
    setText(age, ` · asked ${waitedText(q.since, now())} ago`.replace('under a minute ago', 'just now'));
    age.title = q.since;
    setText(text, q.withheld ? displayLine(q.question) : q.question);
    // The keys the question's own options have: 1–2 for two of them, 1–4 for four.
    setText(hint, zoneHint(q.options.length));
    const hadFocus = zone.contains(doc.activeElement), focusedOption = hadFocus && doc.activeElement.dataset?.option;
    // The same question's options are kept, nodes and focus, across repaints: only whether each is usable changes.
    const optionsKey = JSON.stringify([occurrence(q), q.options, q.optionsWithheld]);
    if (options.dataset.key === optionsKey) {
      for (const b of options.querySelectorAll('.agent-q-option')) b.disabled = dialog || remote || answerText(q, Number(b.dataset.option)) === null;
    } else options.dataset.key = optionsKey, options.replaceChildren(...q.options.map((o, i) => {
      const li = node(doc, 'li');
      const b = node(doc, 'button', 'agent-q-option'); b.type = 'button'; b.dataset.option = String(i);
      b.append(node(doc, 'span', 'agent-q-num', String(i + 1)), ' ', node(doc, 'span', 'agent-q-label', q.optionsWithheld[i] ? displayLine(o) : o));
      const usable = !dialog && !remote && answerText(q, i) !== null;
      b.disabled = !usable;
      b.setAttribute('aria-keyshortcuts', String(i + 1));
      b.addEventListener('click', () => choose(i));
      li.append(b);
      return li;
    }));
    if (focusedOption) options.querySelector(`[data-option="${focusedOption}"]:not([disabled])`)?.focus();
    // A focused option that is gone or disabled now (a dialog opened) leaves the focus on the zone, never on the page.
    if (hadFocus && (!zone.contains(doc.activeElement) || doc.activeElement.disabled)) zone.focus();
    const said = dialog ? DIALOG_NOTE : remote ? remoteNote(answerText(q, 0) ?? `${q.id}: …`) : refusal;
    note.hidden = !said; setText(note, said ?? '');
    zone.setAttribute('aria-label', `${count ? `${count[0].toUpperCase()}${count.slice(1)}` : 'A question'} from ${name}`);
    // The context: read with the detail (inspect --board) once the view is open; attributed, plain text, line breaks kept.
    // A detail read for an earlier occurrence of this id says nothing about this one: it reads as still reading.
    const current = !!detail && (!detail.occurrences || detail.occurrences.has(occurrence(q)));
    // The answer's own question must be this occurrence: its `since` exactly, whatever the read was started for. An
    // answer that doesn't prove it (no since, or not a time) is no answer for this question: fail closed.
    const read = current && detail.state === 'ok' ? detail.questions.get(q.id) : null;
    const proven = !!read && read.since === q.since;
    const ctx = proven ? boardContext(read.context) : null;
    context.hidden = !q.hasContext;
    if (q.hasContext) {
      const lead = node(doc, 'p', 'agent-q-says', `${name} says:`);
      const stale = !!read && !proven;
      const words = !current || stale ? 'Reading the context…' : detail.state === 'ok' ? 'The agent sent no context for this question.' : DETAIL_NOTES[detail.state]?.context ?? DETAIL_NOTES.malformed.context;
      const body = ctx ? node(doc, 'p', 'agent-q-context-text', ctx) : node(doc, 'p', 'agent-q-context-none', words);
      // A long context scrolls inside its open fold (at most 12 lines tall), so its text takes the focus for the keys.
      if (ctx) { body.dir = 'auto'; body.tabIndex = 0; }
      // What the fold says is part of its key: the same occurrence can go from "sent no context" to "reading" and back.
      const contextKey = JSON.stringify([occurrence(q), current, detail?.state ?? null, ctx, ctx ? null : words]);
      if (contextBody.dataset.key !== contextKey) { contextBody.dataset.key = contextKey; contextBody.replaceChildren(lead, body); }
    }
    if (context.dataset.question !== occurrence(q)) { context.open = false; context.dataset.question = occurrence(q); }
    if (zone.parentNode !== pane) pane.append(zone);
  }

  /** Facts before the terminal, the zone after it, whatever was added to the pane first (the shell appends the
   * terminal's wrap after the tab's first sync). */
  function place() {
    const wrap = pane.querySelector(':scope > .term-wrap');
    if (!wrap) return;
    if (facts.parentNode === pane && facts.nextElementSibling !== wrap) wrap.before(facts);
    if (zone.parentNode === pane && wrap.nextElementSibling !== zone) wrap.after(zone);
  }
  function paint() {
    if (!alive) return;
    painting = true;
    try {
      paintFacts(); paintZone(); place();
      pane.classList.toggle('agent-view', facts.parentNode === pane || zone.parentNode === pane);
      fit();
    } finally { painting = false; }
  }
  /** The budget: the terminal keeps at least TERMINAL_MIN_PX (or TERMINAL_MIN_SHARE) of the pane. Where the board would
   * take more, it gives way in steps: the facts show one (the rest behind "N more", which the person may still open),
   * then the zone drops its key hint, then an open context gives up the rest, down to three lines (it scrolls in its
   * fold). On a repaint, a resize and the context's toggle. Where even that is too tall (a pane too short for the
   * board), a number refuses to type until the terminal is on screen again (TERMINAL_TYPE_MIN_PX). */
  function fit() {
    const room = measure.room(pane);
    const level = n => {
      const wasCompact = compact;
      compact = n >= 1 && !unfolded;
      pane.classList.toggle('agent-tight', n >= 2);
      if (compact !== wasCompact) paintFacts();
    };
    level(0);
    if (room === null) return;
    for (let n = 1; n <= 2 && measure.used(pane) > room; n++) level(n);
    // The last step: an open context gives up the rest, down to CONTEXT_MIN_PX (it scrolls in its fold).
    const text = context.open ? contextBody.querySelector('.agent-q-context-text') : null;
    if (text) {
      text.style.removeProperty('max-height');
      const over = measure.used(pane) - room;
      if (over > 0) text.style.maxHeight = `${Math.max(CONTEXT_MIN_PX, measure.height(text) - over)}px`;
    }
  }
  // Opening or closing the context changes what the board takes: the budget runs again.
  context.addEventListener('toggle', () => { if (alive && !painting) { painting = true; try { fit(); } finally { painting = false; } } });
  const unobserve = observe(pane, () => { if (alive && !painting) { painting = true; try { fit(); } finally { painting = false; } } });

  function focusFacts() {
    const first = factList.querySelector(':scope > li > .agent-fact-focus');
    if (first) { first.focus(); return true; }
    if (!fold.hidden) { fold.focus(); return true; }
    if (!shown.hidden && shown.isConnected) { shown.focus(); return true; }
    return false;
  }

  return {
    /** The validated board (instance-board.mjs boardData) and the claims that say whether a dialog is open. */
    update(next, { claims = [] } = {}) {
      board = next;
      dialog = dialogOpen(claims);
      // An answer the agent has cleared is forgotten; one it has not stays hidden on this tab.
      const live = new Set((board?.questions ?? []).map(occurrence));
      for (const key of answered) if (!live.has(key)) answered.delete(key);
      if (pending && !live.has(pending)) { pending = null; if (refusal === PENDING_NOTE) refusal = null; }
      paint();
    },
    /** The inspect --board read (instance-board.mjs boardDetailData): history and context. */
    detail(next) { detail = next; paint(); },
    /** The person's input to the terminal (the tab's xterm onData): Enter (CR; Shift+Enter is a new line) with an answer
     * on the line hides its card. */
    input(data) {
      if (!pending || typeof data !== 'string') return;
      // The person's Enter sends the answer: its card hides. Ctrl+C or Ctrl+U clears the line in most harnesses: the
      // answer is gone, unsent, and another press may type again.
      if (data.includes('\r')) { answered.add(pending); pending = null; refusal = null; paint(); }
      else if (/[\x03\x15]/.test(data)) { pending = null; refusal = null; paint(); }
    },
    /** The palette's command: the zone from the terminal, then the facts, then back to the terminal. */
    cycleFocus() {
      const at = doc.activeElement;
      const inZone = zone.isConnected && zone.contains(at), inFacts = facts.isConnected && facts.contains(at);
      if (!inZone && !inFacts) {
        if (zone.isConnected) { (options.querySelector('button:not([disabled])') ?? zone).focus(); return true; }
        if (facts.isConnected && focusFacts()) return true;
        return false;
      }
      if (inZone && facts.isConnected && focusFacts()) return true;
      focusTerminal();
      return true;
    },
    /** The facts strip or the question zone, while it shows (the F6 regions, focus-regions.mjs). */
    part(name) { const el = name === 'facts' ? facts : name === 'questions' ? zone : null; return el?.isConnected ? el : null; },
    /** Focus the region's current item: the zone's first usable option (else the zone), or the first fact. */
    focusPart(name) {
      if (name === 'questions' && zone.isConnected) { (options.querySelector('button:not([disabled])') ?? zone).focus(); return true; }
      if (name === 'facts' && facts.isConnected) return focusFacts();
      return false;
    },
    /** Puts the strip and the zone either side of the terminal again. */
    place,
    /** Whether the pane shows any of the board (the plain terminal otherwise). */
    get shown() { return facts.isConnected || zone.isConnected; },
    /** The question shown now (its id), for tests and the detail read's moment. */
    get question() { return open()[index]?.id ?? null; },
    dispose() { alive = false; unobserve(); facts.remove(); zone.remove(); pane.classList.remove('agent-view', 'agent-tight'); },
  };
}
