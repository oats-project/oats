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
 * Pure DOM, no shell state: shell.mjs (syncTabBoards) gives it the validated board, the claims and the detail read,
 * and the hooks to type, to focus the terminal and to open a link. The board's own facts and questions are
 * agent-supplied text: every text is set with textContent, never as markup (source-prose-is-an-attributed-quote). */
import { iconElement } from './shell-icons.mjs';
import { DESKTOP_BOARD_WORDS } from './desktop-terms.mjs';
import { FACTS_SHOWN, factsView, answerText, questionCount, turnQuestion, updatedText, sparkValues, dialogOpen, boardContext } from '../../client/instance-board.mjs';
import { waitedText } from '../../client/waiting-on-you.mjs';
import { displayLine } from '../../client/display-text.mjs';

/** What the zone says while a harness dialog is open (contract D30 v4, "How an answer is typed"). */
export const DIALOG_NOTE = "The agent's terminal is showing a prompt: answer it there first.";
/** The zone's key hint. */
export const ZONE_HINT = '1–4 put the answer on the input line · Enter there sends it · Esc back to the terminal';
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
 * @param {ReturnType<typeof createHiddenFacts>} [o.hidden]
 * @param {() => number} [o.now]
 */
export function createAgentBoard({ pane, home, name, type, focusTerminal, openLink, hidden = createHiddenFacts(), now = () => Date.now() }) {
  const doc = pane.ownerDocument;
  let board = null, detail = null, dialog = false, unfolded = false, index = 0, shownId = null, pending = null, alive = true;
  const answered = new Set(); // ids whose answer the person sent from this tab (hidden until the agent clears them)

  // ── the facts strip ──
  const facts = node(doc, 'section', 'agent-facts');
  facts.setAttribute('aria-label', `${DESKTOP_BOARD_WORDS.facts} from ${name}`);
  const factList = node(doc, 'ul', 'agent-fact-list');
  const fold = node(doc, 'button', 'agent-facts-fold'); fold.type = 'button';
  const shown = node(doc, 'button', 'agent-facts-unhide'); shown.type = 'button';
  facts.append(factList, fold, shown);
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
  const hint = node(doc, 'p', 'agent-q-hint', ZONE_HINT);
  zone.append(head, text, options, note, context, hint);
  zone.setAttribute('aria-describedby', text.id);
  prev.addEventListener('click', () => turn(-1));
  next.addEventListener('click', () => turn(1));

  const open = () => (board?.questions ?? []).filter(q => !answered.has(q.id));

  function turn(step) {
    const list = open();
    if (list.length < 2) return;
    index = turnQuestion(index, step, list.length); shownId = list[index].id;
    paint();
  }
  /** Option `i` of the shown question: types `<id>: <option>` and gives the terminal the focus. */
  function choose(i) {
    const list = open(), q = list[index];
    if (!q || dialog) return false;
    const answer = answerText(q, i);
    if (!answer || !type(answer)) return false;
    pending = q.id;
    focusTerminal();
    return true;
  }

  zone.addEventListener('keydown', ev => {
    if (!plain(ev)) return;
    const list = open();
    if (DIGIT.test(ev.key) && !ev.shiftKey) {
      ev.preventDefault();
      choose(Number(ev.key) - 1);
    } else if ((ev.key === 'Tab' || ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') && list.length > 1) {
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
    const values = sparkValues(detail?.facts.get(f.key)?.history);
    if (values) body.append(' ', sparkline(doc, values), node(doc, 'span', 'agent-fact-sparknote', ` last ${values.length}`));
    const when = node(doc, 'span', 'agent-fact-updated', updatedText(f.at, now())); when.title = f.at;
    body.append(' ', when);
    body.setAttribute('aria-label', `${f.label}: ${f.value}${f.unit ? ` ${f.unit}` : ''}, ${updatedText(f.at, now())}`);
    li.append(body);
    if (f.link) {
      const link = node(doc, 'button', 'agent-fact-link'); link.type = 'button';
      link.append(node(doc, 'span', 'agent-fact-says', `${name} says:`), ' ');
      // The full URL as text, its host emphasised: what the person sees is what opens.
      const at = f.link.href.indexOf(f.link.host);
      link.append(f.link.href.slice(0, at), node(doc, 'strong', 'agent-fact-host', f.link.host), f.link.href.slice(at + f.link.host.length));
      link.setAttribute('aria-label', `Open ${f.link.href} in the browser (${name} says)`);
      link.addEventListener('click', () => openLink(f.link.href));
      li.append(link);
    }
    const close = node(doc, 'button', 'agent-fact-hide'); close.type = 'button';
    close.append(iconElement(doc, 'close', { size: 12 }));
    close.setAttribute('aria-label', `Hide ${f.label} on this computer`); close.title = 'Hide on this computer (u)';
    close.addEventListener('click', () => hideFact(f.key));
    li.append(close);
    return li;
  }

  function paintFacts() {
    const view = factsView(board?.facts ?? [], hidden.get(home), { unfolded });
    const any = view.shown.length + view.folded.length + view.hidden.length > 0;
    if (!any) { facts.remove(); return; }
    const focusedKey = facts.contains(doc.activeElement) ? doc.activeElement.closest?.('li')?.dataset.key : null;
    factList.replaceChildren(...view.shown.map(paintFact));
    fold.hidden = view.shown.length + view.folded.length <= FACTS_SHOWN;
    setText(fold, unfolded ? 'Fold' : `${view.folded.length} more`);
    fold.setAttribute('aria-expanded', String(unfolded));
    shown.hidden = !view.hidden.length;
    setText(shown, `${view.hidden.length} hidden · show`);
    if (facts.parentNode !== pane) pane.prepend(facts);
    if (focusedKey) factList.querySelector(`:scope > li[data-key="${focusedKey}"] > .agent-fact-focus`)?.focus();
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
    dots.replaceChildren(...list.map((each, j) => {
      const d = node(doc, 'button', `agent-q-dot${j === index ? ' on' : ''}`); d.type = 'button';
      d.setAttribute('aria-label', `Question ${j + 1}`); if (j === index) d.setAttribute('aria-current', 'true');
      d.addEventListener('click', () => { index = j; shownId = each.id; paint(); zone.focus(); });
      return d;
    }));
    setText(age, ` · asked ${waitedText(q.since, now())} ago`.replace('under a minute ago', 'just now'));
    age.title = q.since;
    setText(text, q.withheld ? displayLine(q.question) : q.question);
    const focusedOption = zone.contains(doc.activeElement) && doc.activeElement.dataset?.option;
    options.replaceChildren(...q.options.map((o, i) => {
      const li = node(doc, 'li');
      const b = node(doc, 'button', 'agent-q-option'); b.type = 'button'; b.dataset.option = String(i);
      b.append(node(doc, 'span', 'agent-q-num', String(i + 1)), ' ', node(doc, 'span', 'agent-q-label', q.optionsWithheld[i] ? displayLine(o) : o));
      const usable = !dialog && answerText(q, i) !== null;
      b.disabled = !usable;
      b.setAttribute('aria-keyshortcuts', String(i + 1));
      b.addEventListener('click', () => choose(i));
      li.append(b);
      return li;
    }));
    if (focusedOption) options.querySelector(`[data-option="${focusedOption}"]`)?.focus();
    note.hidden = !dialog; setText(note, dialog ? DIALOG_NOTE : '');
    zone.setAttribute('aria-label', `${count ? `${count[0].toUpperCase()}${count.slice(1)}` : 'A question'} from ${name}`);
    // The context: read with the detail (inspect --board) once the view is open; attributed, plain text, line breaks kept.
    const ctx = boardContext(detail?.questions.get(q.id)?.context);
    context.hidden = !q.hasContext;
    if (q.hasContext) {
      const lead = node(doc, 'p', 'agent-q-says', `${name} says:`);
      const body = ctx ? node(doc, 'p', 'agent-q-context-text', ctx) : node(doc, 'p', 'agent-q-context-none', detail ? 'The context could not be read.' : 'Reading the context…');
      if (ctx) body.dir = 'auto';
      contextBody.replaceChildren(lead, body);
    }
    if (context.dataset.question !== q.id) { context.open = false; context.dataset.question = q.id; }
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
    paintFacts(); paintZone(); place();
    pane.classList.toggle('agent-view', facts.parentNode === pane || zone.parentNode === pane);
  }

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
      const ids = new Set((board?.questions ?? []).map(q => q.id));
      for (const id of answered) if (!ids.has(id)) answered.delete(id);
      if (pending && !ids.has(pending)) pending = null;
      paint();
    },
    /** The inspect --board read (instance-board.mjs boardDetailData): history and context. */
    detail(next) { detail = next; paint(); },
    /** The person's input to the terminal (the tab's xterm onData): Enter (CR; Shift+Enter is a new line) with an answer
     * on the line hides its card. */
    input(data) {
      if (pending && typeof data === 'string' && data.includes('\r')) { answered.add(pending); pending = null; paint(); }
    },
    /** Alt+T's place: the zone from the terminal, then the facts, then back to the terminal. */
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
    /** Puts the strip and the zone either side of the terminal again. */
    place,
    /** Whether the pane shows any of the board (the plain terminal otherwise). */
    get shown() { return facts.isConnected || zone.isConnected; },
    /** The question shown now (its id), for tests and the detail read's moment. */
    get question() { return open()[index]?.id ?? null; },
    dispose() { alive = false; facts.remove(); zone.remove(); pane.classList.remove('agent-view'); },
  };
}
