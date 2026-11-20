import { takePickerFocusReturn } from './overlay-picker.mjs';
import { SHEET, SHEET_BACKDROP } from './sheet.mjs';
import { gitTarget, gitTargetKey } from '../../client/instance-git-contract.mjs';
import { planReference, ownWorktreeOf } from '../../client/lifecycle-contract.mjs';
import { createLifecycleConfirmation } from '../../client/lifecycle-confirmation.mjs';
import { LIFECYCLE_FORBIDDEN_FRAME } from './lifecycle-frame.mjs';
import { DESKTOP_TERMS } from './desktop-terms.mjs';
import { projectedPullRequest } from './forge-contract.mjs';
import { iconElement } from './shell-icons.mjs';
import { codeLineNodes, serverLabel } from '../../client/remote-address.mjs';
import { skeleton, observedAgeText, AGE_TICK_MS } from './loading.mjs';
export const lifecycleCSS = `
.lifecycle-dialog { width:min(420px,calc(100vw - 32px)); max-height:88vh; overflow:auto; display:flex; flex-direction:column; gap:14px; padding:20px; border:1px solid var(--border); border-radius:12px; background:var(--surface); color:var(--fg); box-shadow:var(--shadow-popover); font-size:12.5px; }
.lifecycle-dialog h2 { margin:0; font-size:15px; line-height:1.3; font-weight:700; overflow-wrap:anywhere; }
.lifecycle-dialog h3 { margin:0; font-size:11.5px; font-weight:650; color:var(--muted); }
.lifecycle-heading { display:flex; gap:14px; align-items:center; }
/* The title and the status line under it share a column tall enough for both, so a status that comes and goes moves nothing below. */
.lifecycle-titles { flex:1; min-width:0; min-height:42px; display:flex; flex-direction:column; justify-content:center; gap:2px; }
.lifecycle-mark { flex:none; width:36px; height:36px; border-radius:10px; display:grid; place-items:center; background:var(--surface-2); color:var(--danger); font-size:16px; }
.lifecycle-mark[data-tone=ok] { color:var(--ok); }
.lifecycle-dialog p { margin:0; line-height:1.5; overflow-wrap:anywhere; }
.lifecycle-dialog a { color:var(--accent); overflow-wrap:anywhere; }
.lifecycle-dialog .lifecycle-note, .lifecycle-dialog dt, .lifecycle-dialog .lifecycle-path { color:var(--muted); }
.lifecycle-dialog .lifecycle-path { display:block; font-size:11.5px; user-select:text; overflow-wrap:anywhere; }
.lifecycle-dialog .lifecycle-warning { color:var(--danger); }
.lifecycle-dialog .lifecycle-attention { color:var(--warn); }
.lifecycle-section { display:grid; gap:6px; }
.lifecycle-dialog[data-phase=running] .lifecycle-happen { color:var(--muted); }
.lifecycle-dialog .lifecycle-facts, .lifecycle-dialog .lifecycle-options { padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--surface-2); display:grid; gap:8px; }
.lifecycle-dialog dl { display:grid; grid-template-columns:auto minmax(0,1fr); gap:6px 10px; margin:0; }
.lifecycle-dialog dd { margin:0; overflow-wrap:anywhere; }
.lifecycle-dialog ul { margin:0; padding-left:18px; }
.lifecycle-dialog li { margin:6px 0; overflow-wrap:anywhere; }
.lifecycle-skeleton { display:grid; gap:9px; padding:3px 0; }
.lifecycle-skeleton .skeleton-line:nth-child(2n) { width:75%; }
.lifecycle-skeleton .skeleton-line:nth-child(3n) { width:45%; }
.lifecycle-status { display:flex; gap:8px; align-items:center; }
/* The status text and, under it, the lines that belong to it and are announced with it: each on its own row. */
.lifecycle-status-body, .lifecycle-status-more { min-width:0; display:grid; gap:6px; }
.lifecycle-dialog .spinner { flex:none; width:14px; height:14px; box-sizing:border-box; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:oats-spin .7s linear infinite; }
.lifecycle-sr { position:absolute; width:1px; height:1px; margin:-1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.lifecycle-dialog label { display:flex; gap:8px; align-items:flex-start; }
.lifecycle-dialog label[hidden] { display:none; }
.lifecycle-dialog input { accent-color:var(--accent); }
.lifecycle-dialog button { height:32px; padding:0 14px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); font:inherit; font-size:12.5px; font-weight:600; cursor:pointer; }
.lifecycle-dialog button:disabled { color:var(--faint); background:var(--surface-2); cursor:default; }
.lifecycle-dialog button:focus-visible { background:var(--sel); }
.lifecycle-dialog .lifecycle-confirm:not(:disabled), .lifecycle-dialog .lifecycle-done:not(:disabled) { background:var(--primary-bg); color:var(--primary-fg); }
/* Done paints its own opaque pair, so it keeps it under keyboard focus and its edge sits outside (theme.css :focus-visible). */
.lifecycle-dialog .lifecycle-done:focus-visible { outline-offset:1px; }
.lifecycle-dialog[data-operation=retire] .lifecycle-confirm:not(:disabled) { background:var(--danger); color:var(--primary-fg); }
.lifecycle-dialog .lifecycle-check { height:auto; padding:0 2px; border:0; border-radius:4px; background:none; color:var(--accent); font-weight:600; text-decoration:underline; }
.lifecycle-footer { display:flex; align-items:center; justify-content:flex-end; gap:8px; flex-wrap:wrap; }
.lifecycle-dialog [hidden] { display:none; }
`;
/** What to do next, in the Desktop's words: the shared views name it by a code (lifecycle-confirmation.mjs). */
const NEXT = Object.freeze({
  'retire-with-force': 'Check the process it names, then retire it from the CLI with --force.',
  'check-roster': 'Check the roster for its result.',
});
/** A view's headline as the Desktop says it: main's frame refusal is the Desktop's own sentence
 * (lifecycle-frame.mjs), which the shared table does not know; a next step is the Desktop's to word. */
const headlineOf = status => {
  const headline = status.code === LIFECYCLE_FORBIDDEN_FRAME.code ? LIFECYCLE_FORBIDDEN_FRAME.message : status.headline;
  return status.next ? `${headline} ${NEXT[status.next]}` : headline;
};
let dialogs = 0;
/** A fresh explicit confirmation every time; no Don't-ask-again bypass. What is said, and which controls a
 * phase offers, is the shared confirmation's (packages/client/lifecycle-confirmation.mjs); this module draws it.
 * One phase decides which controls exist (loading, review, updating, running, done, result); the ownership
 * guards (life, ticket, owns, generation) decide whether an answer may paint at all. Every node is built once
 * per modal and updated in place, so a repaint never rebuilds the focused control. `retires` (#1247): the window's
 * retires in flight (packages/client/retire-in-flight.mjs), told of every retire apply by the shared confirmation. */
export function createLifecycleDialog({ doc, request, gitRequest, forgeRequest, generation = () => 0,
  subscribeWorkspace = () => () => {}, subscribeConnections = () => () => {}, connectionGeneration = () => 0,
  onIntent = () => {}, applyFocus = fn => fn(), onSettled = () => {}, openExternal = () => {}, fallbackFocus = () => null, retires = null } = {}) {
  let alive = true, overlay = null, ui = null, target = null, operation = null, choices = null, plan = null, planRef = null, server = null;
  // The row the dialog was opened for is a home a failed spawn left (quarantined, `rollbackIncomplete`).
  let leftover = false;
  // `confirmation`: the shared half of this modal's transaction; `shown`/`shownView`: the plan on screen and what it says.
  let life = 0, ticket = 0, applying = false, restore = null, confirmation = null, phase = null, shown = null, shownView = null, ticker = null;
  const node = (tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  const capture = () => ({ life, ticket, generation: generation(), target, overlay });
  const owns = ref => alive && overlay && ref.overlay === overlay && overlay.isConnected && ref.life === life && ref.ticket === ticket
    && ref.generation === generation() && ref.target === target;
  const selector = () => ({ instance: target.instance, agent: target.agent, agentsRoot: target.agentsRoot, server: target.server });
  const retire = () => operation === 'retire';
  const question = () => `${retire() ? 'Retire' : 'Stop'} ${target.instance}?`;
  function close({ restoreFocus = true } = {}) {
    if (!overlay) return;
    life++; ticket++; confirmation?.close(); confirmation = null;
    overlay.remove(); overlay = null; ui = null; prLink = null; target = null; plan = null; planRef = null; applying = false; phase = null; shown = null; shownView = null;
    clearInterval(ticker); ticker = null;
    // The opener (or a control with its identity), else the host's fallback (a retired row's successor in the
    // roster), else the generic return (a control near where the opener was), never <body>.
    if (restoreFocus) {
      const back = restore;
      applyFocus(() => {
        if (back?.restoreExact ? back.restoreExact() : back?.restore()) return;
        const fallback = fallbackFocus(); fallback?.focus?.();
        if (!fallback || doc.activeElement !== fallback) back?.restore();
      });
    }
    restore = null;
  }
  /** The status line, and under it the lines that belong to it. They share its live region, so a screen
   * reader gets them with the headline, in order; a space before each keeps them apart as text. */
  const say = (text, more = []) => { ui.statusText.textContent = text; ui.statusMore.replaceChildren(...more.flatMap(el => [' ', el])); ui.statusMore.hidden = !more.length; };
  const title = text => { ui.title.textContent = text; };
  const isShown = el => { for (let n = el; n && n !== ui.dialog; n = n.parentElement) if (n.hidden) return false; return !!el?.isConnected; };
  const focusOn = el => applyFocus(() => el.focus());
  /** Show the controls this phase has, and only those. A control that cannot act now names why beside it. */
  function paint() {
    if (!ui) return;
    // What had focus before any control is hidden: Chromium blurs a control the moment it is hidden (jsdom does not).
    const had = ui.dialog.contains(doc.activeElement) ? doc.activeElement : null;
    const before = ['loading', 'review', 'updating'].includes(phase), planned = phase === 'review' || phase === 'updating';
    ui.dialog.dataset.phase = phase;
    ui.happenSection.hidden = !before && phase !== 'running';
    ui.stateSection.hidden = !before;
    for (const region of [ui.happen, ui.facts]) region.setAttribute('aria-busy', String(phase === 'loading' || phase === 'updating'));
    // The worktree choice is offered for the instance's own tree, and stays while it is checked so that it can be undone.
    const option = shownView && (retire() ? shownView.own || choices.discardWorktree : true);
    ui.options.hidden = !(phase === 'loading' || planned && option);
    ui.optionSkeleton.hidden = phase !== 'loading';
    ui.recursive.parentElement.hidden = phase === 'loading' || retire(); ui.discard.parentElement.hidden = phase === 'loading' || !retire();
    ui.observed.hidden = !planned;
    ui.result.hidden = !['done', 'result'].includes(phase); ui.continues.hidden = phase !== 'running';
    ui.spinner.hidden = phase !== 'running';
    ui.status.classList.toggle('lifecycle-sr', phase === 'done');
    ui.status.hidden = !ui.statusText.textContent;
    ui.close.hidden = phase === 'done'; ui.close.textContent = before ? 'Cancel' : 'Close';
    ui.confirm.hidden = !before;
    const offers = confirmation?.state().offers ?? ['close'];
    ui.confirm.disabled = phase !== 'review' || !offers.includes('apply');
    if (phase === 'review' && plan && shownView?.notice) say(shownView.notice.sentence);
    ui.status.hidden = !ui.statusText.textContent;
    if (!ui.confirm.hidden && ui.confirm.disabled) ui.confirm.setAttribute('aria-describedby', ui.status.id); else ui.confirm.removeAttribute('aria-describedby');
    ui.retry.hidden = !(phase === 'result' && offers.includes('check-again'));
    ui.review.hidden = !(phase === 'result' && offers.includes('refresh'));
    ui.done.hidden = phase !== 'done';
    // A control that leaves while it has focus hands focus to the button that stays.
    const active = doc.activeElement;
    if (had && (!isShown(had) || active !== had) && (!active || active === doc.body || !isShown(active))) focusOn(phase === 'done' ? ui.done : ui.close);
  }
  /** A reason's code and the kernel's message, behind a Details disclosure (keyboard and screen reader
   * reachable). The code is text; the message is alone in its <bdi> (remote-address.mjs codeLineNodes).
   * `bare`: shown for the code alone when there is no message (a headline that does not name its code). */
  /** A reason's code and the kernel's message, behind a Details disclosure (keyboard and screen reader
   * reachable). The code is text; the message is alone in its <bdi> (remote-address.mjs codeLineNodes).
   * `bare`: shown for the code alone when there is no message (a headline that does not name its code). */
  function details(parent, reason, bare = false) {
    if (!reason.detail && !bare) return;
    const more = node('details', undefined, 'lifecycle-details'), line = node('p'); line.append(...codeLineNodes(doc, reason));
    more.append(node('summary', 'Details'), line);
    parent.append(more);
  }
  /** What a view says under its status line, in order (lifecycle-confirmation.mjs `blocks`). */
  function drawBlocks(blocks) {
    for (const block of blocks) {
      if (block.type === 'details') details(ui.result, block.reason, block.bare);
      else if (block.type === 'quote') { const p = node('p'); p.append(node('bdi', block.text)); ui.result.append(p); }
      else if (block.type === 'note') ui.result.append(node('p', block.text, 'lifecycle-note'));
      else if (block.type === 'rows') ui.result.append(stopped(block.rows));
      else if (block.type === 'lines') ui.result.append(list(block.lines.map(line)));
    }
  }
  /** A view's status line: its headline, then the lines that belong to it (a kernel's own sentence quoted, alone in its <bdi>). */
  function sayStatus(status) {
    say(headlineOf(status), status.more.map(item => { if (!Object.hasOwn(item, 'quote')) return node('span', item.text);
      const quote = node('span'); quote.append(node('bdi', item.quote)); return quote; }));
  }
  /** One line of a list (a shared view's `{ text, path?, tone?, title? }`), with its path as a muted, selectable second line. */
  const line = item => { const li = node('li', undefined, item.tone ? `lifecycle-${item.tone}` : undefined); li.append(node('span', item.text));
    if (item.path) li.append(node('span', item.path, 'lifecycle-path')); if (item.title) li.title = item.title; return li; };
  const list = lines => { const ul = node('ul'); ul.append(...lines.filter(Boolean)); return ul; };
  /** Current state: a compact two-column list of plain values, then what is not included and why. */
  function current(state) {
    const dl = node('dl');
    for (const row of state.rows) { const dd = node('dd', row.value); if (row.title) dd.title = row.title; dl.append(node('dt', row.label), dd); }
    return [dl, ...state.notes.map(note => { const p = node('p', note.text, `lifecycle-${note.tone}`); if (note.title) p.title = note.title; return p; })];
  }
  /** What a PR row is correlated to: the observed revision and branch, and the remote's host and path. Null
   * when the work is not observed, and when the kernel says the tree is not the instance's (ownWorktreeOf): no PR row
   * then, and no Git or forge read for it. This is the one place that decides it: overlayForge reads nothing
   * on a null, and a row on screen leaves at the swap. The connection account is held beside it, on the link. */
  const notOwn = value => { const whose = ownWorktreeOf(value); return whose.from === 'fact' && !whose.own; };
  const correlation = value => value?.action === 'retire' && value.facts.work.observed && !notOwn(value)
    ? JSON.stringify([value.facts.work.revision, value.facts.work.branch, value.facts.work.remote?.host ?? null, value.facts.work.remote?.path ?? null]) : null;
  /** The PR row's link, or null: { anchor, url, account, key }. Its click reads this record, never the read
   * that drew it, so a link kept across a plan swap stays live exactly while its correlation and account hold. */
  let prLink = null;
  /** Replace the PR row. A focused link that leaves hands focus to the new link, else to Cancel (Close). */
  function setForge(nodes = [], link = null) {
    if (!ui) return;
    const focused = ui.forge.contains(doc.activeElement);
    ui.forge.replaceChildren(...nodes); prLink = link;
    if (focused) focusOn(link?.anchor ?? ui.close);
  }
  /** Swap a plan in, atomically: the previous facts stay on screen until this one replaces them. */
  function renderPlan(value, view) {
    // The PR row is kept across a swap with the same correlation (and re-read); any other swap drops it.
    if (correlation(shown) === null || correlation(shown) !== correlation(value)) setForge();
    ui.happen.replaceChildren(list(view.happening.map(line))); ui.facts.replaceChildren(...current(view.state));
    ui.warning.textContent = view.warning; ui.warning.hidden = !ui.warning.textContent;
    if (!retire()) ui.confirm.textContent = view.targets > 1 ? 'Stop sessions' : 'Stop session';
    for (const item of view.choices) { const text = (item.id === 'recursive' ? ui.recursive : ui.discard).nextElementSibling; if (text.textContent !== item.sentence) text.textContent = item.sentence; }
    shown = value; shownView = view; age();
  }
  const age = () => { if (shown && ui) ui.observedText.textContent = `Observed ${observedAgeText(shown.at) ?? 'earlier'}`; };
  function skeletons() {
    const bones = node('div', undefined, 'lifecycle-skeleton'); bones.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i++) bones.append(skeleton(doc, 'line'));
    const facts = bones.cloneNode(false); for (let i = 0; i < 3; i++) facts.append(skeleton(doc, 'line'));
    ui.happen.replaceChildren(bones); ui.facts.replaceChildren(facts); setForge(); shown = null; shownView = null;
  }
  async function overlayForge(ref, snapshot) {
    const account = connectionGeneration(), key = correlation(snapshot);
    const current = () => owns(ref) && plan === snapshot && !applying && account === connectionGeneration();
    // What this read cannot confirm is unknown: the row is left out, a row kept from the previous plan too.
    const unknown = () => { if (current()) setForge(); };
    if (!retire() || key === null || !gitRequest || !forgeRequest) { unknown(); return; }
    const row = (...value) => { const dl = node('dl'), dd = node('dd'); dd.append(...value); dl.append(node('dt', 'Pull request'), dd); return dl; };
    try {
      const git = await gitRequest(ref.target.workspace, { action: 'git', selector: selector() });
      if (!current()) return;
      const expected = snapshot.facts.work, observed = git?.data?.observation;
      if (!git.target || gitTargetKey(git.target) !== gitTargetKey(ref.target) || git.status !== 'available' || !planReference(git.observationKey)
        || observed?.revision !== expected.revision || observed.branch !== expected.branch) { unknown(); return; }
      const result = await forgeRequest(ref.target.workspace, { selector: selector(), observationKey: git.observationKey });
      if (!current()) return;
      if (result?.forgeApi !== 1 || !result.target || gitTargetKey(result.target) !== gitTargetKey(ref.target)
        || result.observation?.key !== git.observationKey || result.observation.revision !== expected.revision || result.observation.branch !== expected.branch
        || result.host !== expected.remote?.host || result.repository !== expected.remote?.path) { unknown(); return; }
      const pr = result.status === 'available' ? projectedPullRequest(result.data, { host: result.host, path: result.repository, branch: expected.branch }) : null;
      if (result.status === 'no-pull-request' && result.data === null) setForge([row('None for this branch')]);
      else if (pr) {
        const text = `#${pr.number} · ${pr.title} · ${pr.state}`;
        // The same PR as the link on screen: keep the node, and with it any focus on it.
        if (prLink?.url === pr.url && prLink.key === key && prLink.anchor.textContent === text && prLink.anchor.isConnected) { prLink.account = account; return; }
        const a = node('a', text); a.href = pr.url; a.rel = 'noopener noreferrer';
        const link = { anchor: a, url: pr.url, account, key };
        a.addEventListener('click', event => {
          event.preventDefault();
          if (prLink === link && a.isConnected && alive && overlay === ref.overlay && life === ref.life && generation() === ref.generation && !applying
            && link.account === connectionGeneration() && link.key === correlation(plan ?? shown)) openExternal(link.url);
        });
        setForge([row(a, ' (not changed)')], link);
      } else unknown();
    } catch { unknown(); }
  }
  /** A result: a plain title, the headline in the status line, and one way forward where the contract allows it. */
  function settle(next, heading) {
    phase = next; title(heading); paint();
    focusOn(next === 'done' ? ui.done : ui.close);
  }
  /** One line per row of a stop's results or of a retire's child list; the kernel's own sentence for a child whose
   * home it could not lock is a quote, alone in its <bdi>. */
  function stopped(rows) {
    return list(rows.map(row => {
      const li = line({ text: row.text });
      if (Object.hasOwn(row, 'quote')) { const quote = node('span', undefined, 'lifecycle-path lifecycle-quote'); quote.append(node('bdi', row.quote)); li.append(quote); }
      return li;
    }));
  }
  /** The confirmation's steps, drawn. Each paints only while this modal owns it (a newer modal, a workspace
   * change or a close drops it), and the confirmation tells nothing it has superseded. */
  function onChange(event, detail) {
    if (!alive || !overlay || !ui || !overlay.isConnected) return;
    const view = detail.view;
    if (event === 'reading') {
      ticket++; plan = null; planRef = null; ui.result.replaceChildren();
      if (detail.kept) { phase = 'updating'; say(view.message); }
      else { phase = 'loading'; skeletons(); title(view.title); say(view.message); }
      paint(); return;
    }
    if (event === 'applying') {
      ticket++; applying = true; planRef = null; ui.result.replaceChildren(); phase = 'running'; title(view.title); say(view.message);
      paint(); focusOn(ui.close); return;
    }
    if (event === 'plan') {
      plan = detail.plan; planRef = detail.planRef; renderPlan(plan, view); phase = 'review'; say(''); paint(); void overlayForge(capture(), plan); return;
    }
    if (event === 'unavailable') {
      phase = 'result'; skeletons(); ui.result.replaceChildren(); sayStatus(view.status); drawBlocks(view.blocks); settle('result', view.title); return;
    }
    if (event === 'stale') {
      applying = false; plan = detail.plan; planRef = detail.planRef;
      renderPlan(plan, view); say(detail.notice.sentence); phase = 'review'; title(view.question); paint(); focusOn(ui.close);
      void overlayForge(capture(), plan); return;
    }
    // settled: an apply's answer.
    ui.result.replaceChildren(); sayStatus(view.status); drawBlocks(view.blocks);
    if (view.kind === 'complete') { ui.mark.replaceChildren(iconElement(doc, 'check', { size: 18 })); ui.mark.dataset.tone = 'ok'; settle('done', view.title); }
    else settle('result', view.title);
    applying = false; paint();
  }
  function open({ operation: next, instance, workspace }) {
    close({ restoreFocus: false }); if (!alive || !['stop', 'retire'].includes(next)) return;
    target = gitTarget({ workspace, instance: instance?.instance, agent: instance?.agent, agentsRoot: instance?.agentsRoot, home: instance?.home, server: instance?.server ?? null });
    if (!target) return;
    server = target.server ? serverLabel(instance) : null; leftover = instance?.rollbackIncomplete === true;
    onIntent(); restore = takePickerFocusReturn(doc); life++; operation = next;
    choices = next === 'stop' ? { recursive: true } : { discardWorktree: false };
    const id = `lifecycle-${++dialogs}`;
    // A centred sheet over the scrim (the Desktop UI rework, slice 4, D10): Stop's and Retire's.
    overlay = node('div', undefined, `palette-overlay lifecycle-overlay ${SHEET_BACKDROP}`);
    const dialog = node('section', undefined, `lifecycle-dialog ${SHEET}`); dialog.dataset.operation = operation;
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', `${id}-title`);
    const heading = node('div', undefined, 'lifecycle-heading'), mark = node('span', undefined, 'lifecycle-mark'); mark.append(iconElement(doc, next === 'stop' ? 'stop' : 'remove', { size: 18 })); mark.setAttribute('aria-hidden', 'true');
    const h2 = node('h2'); h2.id = `${id}-title`;
    const status = node('p', undefined, 'lifecycle-status'), spinner = node('span', undefined, 'spinner'), statusText = node('span');
    const statusBody = node('span', undefined, 'lifecycle-status-body'), statusMore = node('span', undefined, 'lifecycle-status-more'); statusMore.hidden = true;
    statusBody.append(statusText, statusMore);
    status.id = `${id}-status`; status.setAttribute('role', 'status'); spinner.setAttribute('aria-hidden', 'true'); status.append(spinner, statusBody);
    const titles = node('div', undefined, 'lifecycle-titles'); titles.append(h2, status); heading.append(mark, titles);
    const section = (label, region) => { const s = node('section', undefined, 'lifecycle-section'), h = node('h3', label); h.id = `${id}-${region.className}`;
      s.setAttribute('aria-labelledby', h.id); s.append(h, region); return s; };
    const happen = node('div', undefined, 'lifecycle-happen'), facts = node('div', undefined, 'lifecycle-facts'), forge = node('div', undefined, 'lifecycle-forge');
    const happenSection = section('What will happen', happen), stateSection = section('Current state', facts); facts.after(forge);
    const options = node('div', undefined, 'lifecycle-options'), optionSkeleton = skeleton(doc, 'line', { width: '55%' });
    function choice(label, checked) { const line = node('label'), input = node('input'); input.type = 'checkbox'; input.checked = checked; line.append(input, node('span', label)); options.append(line); return input; }
    options.append(optionSkeleton);
    // A plan's choice says its own sentence (planView `choices`, drawn with the plan); the other operation's stays as built, hidden.
    const recursive = choice('Include child instances', true), discard = choice('Also delete the worktree', false);
    const warning = node('p', '', 'lifecycle-warning'); warning.hidden = true; options.append(warning);
    const mounted = life, mountedGeneration = generation();
    const current = () => alive && overlay && life === mounted && dialog.isConnected && generation() === mountedGeneration;
    // The checkbox stays enabled while a plan is read: the latest choice wins, and tickets drop older answers.
    const changed = event => {
      if (!current() || !event.target.isConnected || event.target.disabled || applying || !confirmation) return; onIntent();
      if (operation === 'stop') choices = { recursive: recursive.checked };
      else choices = { discardWorktree: discard.checked };
      const [id] = Object.keys(choices); confirmation.setChoice(id, choices[id]);
    };
    for (const input of [recursive, discard]) input.addEventListener('change', changed);
    const result = node('div', undefined, 'lifecycle-result'), footer = node('div', undefined, 'lifecycle-footer');
    const continues = node('p', `You can close this window; ${retire() ? 'retirement' : 'stopping'} continues.`, 'lifecycle-note');
    // Close (Cancel before dispatch) and Done close from any generation of this modal; every other control acts only while it owns it.
    const closing = new Set(['lifecycle-close', 'lifecycle-done']);
    const button = (label, action, cls) => { const b = node('button', label, cls); b.type = 'button';
      b.addEventListener('click', () => {
        if (closing.has(cls) && alive && overlay && life === mounted && b.isConnected) { close({ restoreFocus: generation() === mountedGeneration }); return; }
        if (current() && b.isConnected && !b.disabled && isShown(b)) action();
      }); return b; };
    const observed = node('p', undefined, 'lifecycle-observed lifecycle-note'), observedText = node('span');
    const check = button('Check again', () => { onIntent(); confirmation?.refresh('check'); }, 'lifecycle-check');
    observed.append(observedText, ' ', check);
    const closeButton = button('Cancel', () => close(), 'lifecycle-close'), doneButton = button('Done', () => close(), 'lifecycle-done');
    // Each act is the confirmation's, and only while it offers it: Confirm sends the reference under review; Check
    // again asks for the answer to the one already sent (the same reference); Review again reads a new plan.
    const act = (name, run) => () => { if (!confirmation?.state().offers.includes(name)) return; onIntent(); run(); };
    const confirmButton = button(next === 'stop' ? 'Stop session' : 'Retire instance', act('apply', () => confirmation.apply()), 'lifecycle-confirm');
    const retryButton = button('Check again', act('check-again', () => confirmation.checkAgain()), 'lifecycle-retry');
    const reviewButton = button('Review again', act('refresh', () => confirmation.refresh('review')), 'lifecycle-review');
    footer.append(retryButton, reviewButton, closeButton, confirmButton, doneButton);
    dialog.append(heading, happenSection, stateSection, options, observed, result, continues, footer); overlay.append(dialog); doc.body.append(overlay);
    ui = { dialog, title: h2, mark, status, statusText, statusMore, spinner, happen, happenSection, facts, stateSection, forge, options, optionSkeleton, warning,
      observed, observedText, result, continues, recursive, discard, confirm: confirmButton, close: closeButton, done: doneButton, retry: retryButton, review: reviewButton };
    overlay.addEventListener('keydown', event => {
      if (!current()) return;
      // Esc is the visible way out of each phase (Cancel, Close or Done): it closes, and never cancels a dispatched operation.
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
      if (event.key !== 'Tab') return;
      const all = [...dialog.querySelectorAll('button,input,a,summary')].filter(el => !el.disabled && el.tabIndex >= 0 && isShown(el));
      if (event.shiftKey && doc.activeElement === all[0]) { event.preventDefault(); all.at(-1)?.focus(); }
      else if (!event.shiftKey && doc.activeElement === all.at(-1)) { event.preventDefault(); all[0]?.focus(); }
    });
    // The age line ticks while the modal lives; a Node test host never waits on it (unref).
    ticker = setInterval(() => { if (current()) age(); }, AGE_TICK_MS); ticker?.unref?.();
    phase = 'loading'; applyFocus(() => closeButton.focus());
    const workspaceOf = target.workspace, owned = () => current() && confirmation === made;
    // The confirmation reads its first plan at once; its answers paint through onChange while this modal owns it.
    const made = createLifecycleConfirmation({ request: body => request(workspaceOf, body), target, operation, terms: DESKTOP_TERMS, label: server, leftover, retires,
      onChange: (event, detail) => { if (life === mounted && generation() === mountedGeneration) onChange(event, detail); },
      onSettled: (result, settledTarget) => { if (owned()) return onSettled(result, settledTarget); } });
    confirmation = made;
  }
  const off = subscribeWorkspace(() => close({ restoreFocus: false }));
  const offConnections = subscribeConnections(() => {
    if (!overlay || operation !== 'retire') return;
    setForge(); // unknown until the new account answers: the row is left out, also while a plan is read
    if (plan && !applying) void overlayForge(capture(), plan);
  });
  return { open, close, dispose() { close({ restoreFocus: false }); alive = false; off(); offConnections(); } };
}