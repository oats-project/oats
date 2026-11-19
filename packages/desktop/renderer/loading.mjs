/** The shared loading-state primitive (desktop/loading-states).
 *
 * One state model for every data region:
 *   pending     no data for this subject yet; after PENDING_DELAY_MS a skeleton
 *               shaped like the final content (never an empty-state message)
 *   ready       data present, last read succeeded
 *   refreshing  data present, a read in flight; content stays interactive and a
 *               muted "Refreshing…" appears after REFRESHING_DELAY_MS
 *   stale       data present, last read failed: content kept, an attention line
 *               "Couldn't refresh <noun> · observed <age>" with Retry
 *               (an unreadable remote, by the kernel's cause: "… · OATS cache problem · observed <age>" with
 *               its message in full, or "Couldn't reach <host> · showing what was read <age>"; Spec D)
 *   empty       a successful read returned zero items (the surface paints its copy)
 *   failed      no data and the read failed: cause, Details (code), Retry
 *
 * The controller owns the delays, `aria-busy`, the status line announcements,
 * the age line and the Retry wiring. The surface owns its latest-intent
 * tokens: it calls begin()/succeed()/fail() only for the read it still owns.
 * Wording is fixed here so no surface drifts. No framework: vanilla DOM. */
import { codeLineNodes, kernelCode } from '../../client/remote-address.mjs';

export const PENDING_DELAY_MS = 150;
export const REFRESHING_DELAY_MS = 400;
/** Data observed longer ago than this is labelled with its age even after a successful read. */
export const OLD_AFTER_MS = 2 * 60_000;
/** How often a shown age line is re-rendered. */
export const AGE_TICK_MS = 30_000;

const capitalise = s => s ? s[0].toUpperCase() + s.slice(1) : s;
/** Why a roster-derived action or claim waits while the roster is not settled-good (the sidebar's rule, shared by
 * every surface that derives from the roster: instance-tree-view.mjs re-exports it). */
export const ROSTER_STALE_TITLE = 'Unavailable: roster is not current';
/** The same rule for a claim derived from the souls list (`oats souls`): Capabilities' "Used by" when the
 * kernel reports each soul's composition (souls-capabilities). */
export const SOULS_STALE_TITLE = 'Unavailable: the souls list is not current';
export const wording = Object.freeze({
  loading: noun => `Loading ${noun}…`,
  refreshing: 'Refreshing…',
  couldNotRefresh: noun => `Couldn't refresh ${noun}`,
  // Spec D: a remote the kernel could not read, by its cause (E_REMOTE_UNREADABLE details.reason).
  cacheProblem: 'OATS cache problem',
  couldNotReach: host => `Couldn't reach ${host}`,
  showingRead: age => age ? `showing what was read ${age}` : 'showing what was last read',
  retry: 'Retry',
  updated: noun => `${capitalise(noun)} updated`,
  observed: age => `Observed ${age}`,
});

/** Milliseconds since `iso`, or null when absent or unparseable. */
export function observedAgeMs(iso, now = Date.now()) {
  if (typeof iso !== 'string' || !iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.max(0, now - at) : null;
}
/** "just now" (< 10s) / "45s ago" / "3 min ago" / "at 14:05" (an hour or more, local time); null when unknown. */
export function observedAgeText(iso, now = Date.now()) {
  const ms = observedAgeMs(iso, now);
  if (ms === null) return null;
  const s = Math.round(ms / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const d = new Date(Date.parse(iso));
  return `at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** "observed 3 min ago", for the stale line; null when the age is unknown. */
export function observedText(iso, now = Date.now()) {
  const age = observedAgeText(iso, now);
  return age === null ? null : `observed ${age}`;
}
export function isOldObservation(iso, now = Date.now()) {
  const ms = observedAgeMs(iso, now);
  return ms !== null && ms > OLD_AFTER_MS;
}

/* ── skeletons (decorative: aria-hidden, no text) ────────────────────────── */
const SHAPES = new Set(['roster-row', 'soul-card', 'table-row', 'detail-section', 'pill', 'line']);
function element(doc, tag, className) { const el = doc.createElement(tag); el.className = className; return el; }
function bone(doc, className) { const el = element(doc, 'span', `skeleton ${className}`); el.setAttribute('aria-hidden', 'true'); return el; }
/** One skeleton of `shape`. Sizes live in loading.css and mirror the real rows. */
export function skeleton(doc, shape, { columns = 4, width } = {}) {
  if (!SHAPES.has(shape)) throw new Error(`unknown skeleton shape: ${shape}`);
  let el;
  switch (shape) {
    case 'roster-row': {
      // Wears the real row classes (.ctx-tree-row > .ctx-inst > .ctx-dot + .ctx-copy > .ctx-name / .ctx-repo-label)
      // so its height, gap and padding are shell.css's, never a copied pixel value: a row redesign moves both.
      el = element(doc, 'div', 'skeleton-item skeleton-roster-row ctx-tree-row');
      el.style.setProperty('--depth', '0');
      const inst = element(doc, 'span', 'ctx-inst skeleton-inst');
      const copy = element(doc, 'span', 'ctx-copy skeleton-copy');
      copy.append(bone(doc, 'skeleton-line skeleton-name ctx-name'), bone(doc, 'skeleton-line skeleton-meta ctx-meta ctx-repo-label'));
      inst.append(bone(doc, 'skeleton-dot ctx-dot'), copy);
      el.append(inst);
      break;
    }
    case 'soul-card': {
      // Wears the real card classes (.soul-card > .stitle, .sdesc, .sfoot) so the Souls grid's own CSS (views/spawn.mjs)
      // gives it the card's height, padding and gaps.
      el = element(doc, 'div', 'skeleton-item skeleton-soul-card');
      const card = element(doc, 'div', 'soul-card skeleton-card');
      const desc = element(doc, 'span', 'sdesc skeleton-desc'); desc.append(bone(doc, 'skeleton-line skeleton-text'), bone(doc, 'skeleton-line skeleton-text short'));
      const foot = element(doc, 'span', 'sfoot'); foot.append(bone(doc, 'skeleton-line skeleton-activity sactivity'));
      card.append(bone(doc, 'skeleton-line skeleton-name stitle'), desc, foot); el.append(card);
      break;
    }
    case 'table-row': {
      el = element(doc, 'div', 'skeleton-item skeleton-table-row');
      el.style.setProperty('--skeleton-columns', String(columns));
      for (let i = 0; i < columns; i++) el.append(bone(doc, `skeleton-line skeleton-cell${i === 0 ? ' first' : ''}`));
      break;
    }
    case 'detail-section': {
      el = element(doc, 'div', 'skeleton-item skeleton-detail-section');
      el.append(bone(doc, 'skeleton-line skeleton-title'), bone(doc, 'skeleton-block'));
      break;
    }
    case 'pill': el = bone(doc, 'skeleton-pill'); break;
    case 'line': el = bone(doc, 'skeleton-line'); break;
  }
  if (width) el.style.width = width;
  el.setAttribute('aria-hidden', 'true');
  el.dataset.skeleton = shape;
  return el;
}
/** `count` skeletons of `shape` in one aria-hidden block. */
export function skeletonBlock(doc, shape, { count = 3, ...options } = {}) {
  const block = element(doc, 'div', `skeleton-block-list skeleton-${shape}s`);
  block.setAttribute('aria-hidden', 'true'); block.dataset.skeleton = `${shape}s`;
  for (let i = 0; i < count; i++) block.append(skeleton(doc, shape, options));
  return block;
}

/** A `role="status"` line. Visually hidden when the surface has no place for a visible one. */
export function statusLine(doc, { visuallyHidden = false, className = '' } = {}) {
  const el = element(doc, 'p', ['loading-status', visuallyHidden ? 'loading-sr' : '', className].filter(Boolean).join(' '));
  el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  return el;
}

/** Capture the focused element inside `root` (and `scroller`'s scroll) right before
 * a rebuild and return a restore callback. Call it immediately before the repaint,
 * not when the read starts: focus may have moved into the content meanwhile.
 * Identity: an actionable control carries `data-focus-key` (e.g. `remove:<label>`,
 * `op:<layer>:<name>`) and is found again ONLY by that key — a repaint happens when
 * the data changed, which is exactly when positions shift, and a keyboard user must
 * never land on a different mutation control. Anything else (a disclosure summary,
 * a plain element) is found by its structural path, but a path is never trusted
 * onto a button, select, input or link. When nothing matches, `fallback` (an
 * element or a function returning one) receives focus, else focus is left alone.
 * Returns whether focus was restored to the same identity. */
export function captureFocusState(root, { scroller = root, fallback = null } = {}) {
  const doc = root.ownerDocument, active = doc.activeElement;
  const inside = !!active && root.contains(active);
  const key = inside ? active.dataset?.focusKey || null : null;
  const path = inside && !key ? pathFrom(root, active) : null;
  const scrollTop = scroller?.scrollTop ?? 0;
  return () => {
    // A focused control the repaint never touched stays exactly where it is.
    if (inside && active.isConnected && root.contains(active)) { if (scroller) scroller.scrollTop = scrollTop; return true; }
    let target = null;
    if (key) target = [...root.querySelectorAll('[data-focus-key]')].find(el => el.dataset.focusKey === key) || null;
    else if (path) { target = walk(root, path); if (target && ACTIONABLE.test(target.tagName)) target = null; }
    const focusable = !!target && typeof target.focus === 'function' && !target.disabled && target.isConnected;
    if (focusable) target.focus({ preventScroll: true });
    else if (inside) {
      const to = typeof fallback === 'function' ? fallback() : fallback;
      if (to && typeof to.focus === 'function') to.focus({ preventScroll: true });
    }
    if (scroller) scroller.scrollTop = scrollTop;
    return focusable ? doc.activeElement === target : false;
  };
}
const ACTIONABLE = /^(BUTTON|SELECT|INPUT|TEXTAREA|A)$/;
function pathFrom(root, el) {
  const path = [];
  for (let node = el; node && node !== root; node = node.parentElement) {
    const parent = node.parentElement; if (!parent) return null;
    path.unshift([...parent.children].indexOf(node));
  }
  return path;
}
function walk(root, path) {
  let node = root;
  for (const index of path) { node = node?.children?.[index]; if (!node) return null; }
  return node;
}

/* ── the stale / observed notice (shared by the controller and pages that mirror a controller's state) ── */
/** The cause variant a stale line words itself by: { reason, host? } from the kernel (Spec D), or null. */
export function noticeVariant(cause) {
  if (!cause || typeof cause !== 'object' || typeof cause.reason !== 'string') return null;
  if (cause.reason === 'cache') return { reason: 'cache' };
  if (['network', 'timeout'].includes(cause.reason) && typeof cause.host === 'string' && cause.host) return { reason: cause.reason, host: cause.host };
  return null; // other reasons keep the generic line
}
function noticeText(kind, noun, observedAt, now, variant = null) {
  const age = observedText(observedAt, now);
  if (kind === 'stale' && variant?.reason === 'cache') return [wording.couldNotRefresh(noun), wording.cacheProblem, age].filter(Boolean).join(' · ');
  if (kind === 'stale' && variant?.host) return `${wording.couldNotReach(variant.host)} · ${wording.showingRead(observedAgeText(observedAt, now))}`;
  if (kind === 'stale') return age ? `${wording.couldNotRefresh(noun)} · ${age}` : wording.couldNotRefresh(noun);
  return wording.observed(observedAgeText(observedAt, now));
}
/** A failed read's cause, in the two forms the stale notice says it. `title`: the read's own message and
 * its code, the code only in the kernel's code shape; never the `detail` (a refusal's detail does not go
 * into an attribute). `nodes`: the Details line: the same message and code as text, and the detail
 * after the code, inside its <bdi> (remote-address.mjs codeLineNodes). `codeOnly`: the message is on the
 * notice itself, so both keep only the code. */
function staleCause(doc, { message = null, code = null, detail = null, codeOnly = false } = {}) {
  const said = codeOnly ? null : message, shown = kernelCode(code) ? code : null, coded = codeLineNodes(doc, { code, detail });
  return { title: said && shown ? `${said} (${shown})` : said || shown,
    nodes: said && coded.length ? [doc.createTextNode(`${said} (`), ...coded, doc.createTextNode(')')] : said ? [doc.createTextNode(said)] : coded };
}
/** Build the notice line: `kind` 'stale' (the read failed: Retry, the cause behind a Details disclosure
 * and in the title) or 'observed' (an old observation, muted, no Retry). `onRetry` runs on an activation
 * while not busy. Update it in place with `updateNotice()` so a focused Retry survives.
 * `cause`: a page's own line (a string: the title and the Details line alike), or staleCause()'s parts. */
export function noticeElement(doc, kind, { noun, observedAt = null, cause = null, busy = false, onRetry = null, now = Date.now(), variant = null, message = null } = {}) {
  const el = element(doc, 'div', 'loading-notice'); el.dataset.kind = kind;
  el.append(element(doc, 'span', 'loading-notice-text'));
  // A cache problem's remedy is the kernel's message: shown in full on the line, never behind Details.
  if (kind === 'stale') { const said = element(doc, 'p', 'loading-notice-message'); said.hidden = true; el.append(said); }
  if (kind === 'stale') {
    const retry = element(doc, 'button', 'act loading-retry'); retry.type = 'button'; retry.textContent = wording.retry; retry.dataset.focusKey = 'retry';
    retry.addEventListener('click', () => { if (retry.getAttribute('aria-disabled') === 'true') return; onRetry?.(); });
    if (typeof onRetry !== 'function') retry.hidden = true;
    // The cause is reachable by keyboard and screen reader through a Details disclosure (a title alone is hover-only).
    const more = element(doc, 'details', 'loading-notice-details');
    const summary = element(doc, 'summary', ''); summary.textContent = 'Details';
    more.append(summary, element(doc, 'p', 'loading-notice-cause'));
    el.append(retry, more);
  }
  updateNotice(el, { noun, observedAt, cause, busy, now, variant, message });
  return el;
}
/** Refresh a notice's text, cause and busy mark in place (its Retry keeps focus). */
export function updateNotice(el, { noun, observedAt = null, cause = null, busy = false, now = Date.now(), variant = null, message = null } = {}) {
  el.querySelector('.loading-notice-text').textContent = noticeText(el.dataset.kind, noun, observedAt, now, variant);
  if (variant) el.dataset.variant = variant.reason; else delete el.dataset.variant;
  const said = el.querySelector('.loading-notice-message');
  if (said) { const text = variant?.reason === 'cache' && typeof message === 'string' ? message : ''; said.textContent = text; said.hidden = !text; }
  const title = typeof cause === 'string' ? cause : cause?.title ?? null;
  const nodes = typeof cause === 'string' ? cause ? [cause] : [] : cause?.nodes ?? [];
  if (title) el.title = title; else el.removeAttribute('title');
  const more = el.querySelector('.loading-notice-details');
  if (more) { more.hidden = !nodes.length; more.querySelector('.loading-notice-cause').replaceChildren(...nodes); }
  const retry = el.querySelector('.loading-retry');
  if (retry) { if (busy) retry.setAttribute('aria-disabled', 'true'); else retry.removeAttribute('aria-disabled'); }
}

/** Build the failed block (the read failed with nothing to show): the cause, the code (and a host's own message,
 * `detail`, inside its <bdi>) behind a Details disclosure,
 * Retry, and an optional second action `{ label, onActivate }` beside it (Re-add workspace, #461).
 * Shared by the controller and pages that mirror a controller's state; update in place with `updateFailed()`. */
export function failedElement(doc, { message = null, code = null, detail = null, noun = 'data', busy = false, onRetry = null, action = null } = {}) {
  const el = element(doc, 'div', 'loading-failed');
  el.append(element(doc, 'p', 'loading-failed-message'));
  const more = element(doc, 'details', 'loading-failed-details');
  const summary = element(doc, 'summary', ''); summary.textContent = 'Details';
  more.append(summary, element(doc, 'p', 'loading-failed-code muted'));
  const retry = element(doc, 'button', 'act loading-retry'); retry.type = 'button'; retry.textContent = wording.retry; retry.dataset.focusKey = 'retry';
  retry.addEventListener('click', () => { if (retry.getAttribute('aria-disabled') === 'true') return; onRetry?.(); });
  if (typeof onRetry !== 'function') retry.hidden = true;
  el.append(more, retry);
  updateFailed(el, { message, code, detail, noun, busy, action });
  return el;
}
export function updateFailed(el, { message = null, code = null, detail = null, noun = 'data', busy = false, action = null } = {}) {
  el.querySelector('.loading-failed-message').textContent = typeof message === 'string' && message ? message : `${wording.couldNotRefresh(noun)}.`;
  const more = el.querySelector('.loading-failed-details'), line = codeLineNodes(el.ownerDocument, { code, detail });
  more.hidden = !line.length; more.querySelector('.loading-failed-code').replaceChildren(...line);
  const retry = el.querySelector('.loading-retry');
  if (retry) { if (busy) retry.setAttribute('aria-disabled', 'true'); else retry.removeAttribute('aria-disabled'); }
  // The second action is kept in place across updates (it may hold focus); only its label and handler change.
  let second = el.querySelector('.loading-action');
  if (!action || typeof action.label !== 'string' || typeof action.onActivate !== 'function') { second?.remove(); return; }
  if (!second) {
    second = element(el.ownerDocument, 'button', 'act loading-action'); second.type = 'button'; second.dataset.focusKey = 'action';
    second.addEventListener('click', () => { if (second.getAttribute('aria-disabled') === 'true') return; second.onActivate?.(); });
    el.append(second);
  }
  if (second.textContent !== action.label) second.textContent = action.label;
  second.onActivate = action.onActivate;
  if (busy) second.setAttribute('aria-disabled', 'true'); else second.removeAttribute('aria-disabled');
}

/* ── the data-state controller ───────────────────────────────────────────── */
/**
 * @param {object} o
 * @param {Document} o.doc
 * @param {string} o.noun               "instances", "roster", "soul", "readiness"…
 * @param {Element} o.region            gets aria-busy while pending; hosts the skeleton and the failed block unless a host is given
 * @param {Element} [o.skeletonHost]    where the skeleton is appended (default: region)
 * @param {Element|null} [o.failedHost] where the failed block is appended (default: skeletonHost; null when the surface
 *                                      keeps its own failure notice and only wants the state, aria-busy and the announcement)
 * @param {() => Element} [o.skeleton]  builds a fresh skeleton (default: none — the region only becomes busy)
 * @param {Element} [o.status]          the role="status" line; text-only announcements
 * @param {Element} [o.indicatorHost]   where "Refreshing…" is appended
 * @param {Element} [o.noticeHost]      where the stale / observed line is appended (default: indicatorHost)
 * @param {() => void} [o.onRetry]      Retry / the failed block's Retry
 * @param {Element|(() => Element|null)} [o.focusFallback]  receives focus when a focused Retry has to vanish (a successful
 *                                      retry removes its line); default: the first bound Refresh control
 * @param {() => number} [o.now]
 */
export function createDataState({ doc, noun, region, skeletonHost = region, failedHost = skeletonHost, skeleton: buildSkeleton = null, status = null,
  indicatorHost = null, noticeHost = indicatorHost, onRetry = null, focusFallback = null, now = Date.now,
  setTimeout: schedule = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: cancel = id => globalThis.clearTimeout(id) } = {}) {
  // `settled` is the last state a read left behind (ready / empty / stale / failed): what cancel() returns to.
  let state = 'idle', settled = 'idle', busy = false, hasData = false, user = false, disposed = false;
  let observedAt = null, announced = null, inFlight = null;
  let pendingTimer = null, refreshingTimer = null, ageTimer = null;
  let skeletonEl = null, failedEl = null, indicatorEl = null, noticeEl = null, noticeVariantNow = null, noticeMessage = null, noticeCause = null;
  let failedAction = null; // the failed block's second action, if the failing read named one
  const refreshControls = new Set();

  const clearTimer = id => { if (id !== null) cancel(id); return null; };
  function say(text) {
    if (!status || text === announced) return;
    announced = text; status.textContent = text;
  }
  // While the stale line or the failed block is on screen, the status line is announced but not shown
  // (.loading-quiet: loading.css clips it, its 1.5em box stays so nothing shifts; the class works on any surface's own status element): one visible message, calm.
  function syncQuiet() {
    if (!status) return;
    status.classList.toggle('loading-quiet', noticeEl?.dataset.kind === 'stale' || !!failedEl);
  }
  // A focused Retry never disappears under the finger silently: focus moves to the fallback first.
  function removeKeepingFocus(el) {
    if (!el) return;
    if (el.contains(doc.activeElement)) {
      const target = typeof focusFallback === 'function' ? focusFallback() : focusFallback || [...refreshControls].find(c => c.isConnected) || null;
      if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
    }
    el.remove();
  }
  function removeSkeleton() { skeletonEl?.remove(); skeletonEl = null; }
  function removeFailed() { removeKeepingFocus(failedEl); failedEl = null; }
  function removeIndicator() { indicatorEl?.remove(); indicatorEl = null; }
  function removeNotice() { removeKeepingFocus(noticeEl); noticeEl = null; ageTimer = clearTimer(ageTimer); }
  function setBusyControls() {
    const mark = el => busy ? el.setAttribute('aria-disabled', 'true') : el.removeAttribute('aria-disabled');
    refreshControls.forEach(mark);
    for (const host of [noticeEl, failedEl]) for (const button of host?.querySelectorAll('.loading-retry, .loading-action') || []) mark(button);
  }
  function retryButton() {
    const b = element(doc, 'button', 'act loading-retry'); b.type = 'button'; b.textContent = wording.retry;
    b.addEventListener('click', () => { if (disposed || busy || b.getAttribute('aria-disabled') === 'true') return; onRetry?.(); });
    if (busy) b.setAttribute('aria-disabled', 'true');
    return b;
  }
  function showSkeleton() {
    pendingTimer = null;
    if (disposed || state !== 'pending' || failedEl || !buildSkeleton || !skeletonHost) return;
    removeSkeleton(); skeletonEl = buildSkeleton(); skeletonEl.dataset.loadingSkeleton = '1'; skeletonHost.append(skeletonEl);
  }
  function showIndicator() {
    refreshingTimer = null;
    if (disposed || state !== 'refreshing' || !indicatorHost) return;
    removeIndicator();
    indicatorEl = element(doc, 'span', 'loading-refreshing');
    const dot = element(doc, 'span', 'loading-dot'); dot.setAttribute('aria-hidden', 'true');
    indicatorEl.append(dot, doc.createTextNode(inFlight || wording.refreshing));
    indicatorHost.append(indicatorEl);
  }
  function showNotice(kind, { cause = null, variant = null, message = null } = {}) {
    // `cause`: the read's message and its code as staleCause() parts (set by fail()).
    // `variant` / `message`: the kernel's cause and message for an unreadable remote (Spec D).
    // A notice of the same kind is updated in place: its Retry (which may hold focus) is kept.
    if (!noticeHost) return;
    noticeVariantNow = variant; noticeMessage = message; noticeCause = cause;
    if (!noticeEl || noticeEl.dataset.kind !== kind) {
      removeNotice();
      noticeEl = noticeElement(doc, kind, { noun, observedAt, cause, busy, now: now(), variant, message, onRetry: () => { if (!disposed && !busy) onRetry?.(); } });
      noticeHost.append(noticeEl);
    } else updateNotice(noticeEl, { noun, observedAt, cause, busy, now: now(), variant, message });
    ageTimer = clearTimer(ageTimer);
    if (observedText(observedAt, now())) ageTimer = schedule(() => { ageTimer = null; touch(); }, AGE_TICK_MS);
  }
  // The failed block is updated in place on a repeated failure: its Retry may hold focus.
  function showFailed(error) {
    removeSkeleton();
    if (!failedHost) return;
    const action = failedAction && { label: failedAction.label, onActivate: () => { if (!disposed && !busy) failedAction?.onActivate(); } };
    const facts = { message: error?.message, code: error?.code, detail: error?.detail, noun, busy, action };
    if (!failedEl) { failedEl = failedElement(doc, { ...facts, onRetry: () => { if (!disposed && !busy) onRetry?.(); } }); failedHost.append(failedEl); }
    else updateFailed(failedEl, facts);
  }
  function setRegionBusy(value) {
    if (!region) return;
    if (value) region.setAttribute('aria-busy', 'true'); else region.removeAttribute('aria-busy');
  }
  /** Re-render the age line (called on a timer, and by surfaces on their own polls). */
  function touch() {
    if (disposed || !noticeEl) return;
    showNotice(noticeEl.dataset.kind, { cause: noticeCause, variant: noticeEl.dataset.kind === 'stale' ? noticeVariantNow : null, message: noticeMessage });
  }

  const api = {
    get state() { return state; },
    /** The last state a read left behind (ready / empty / stale / failed): what a refreshing read returns to.
     * A surface holding actions "while stale" reads this, not `state`: a Retry in flight is `refreshing`
     * while the content on screen is still the stale observation. */
    get settled() { return settled; },
    get busy() { return busy; },
    get hasData() { return hasData; },
    get observedAt() { return observedAt; },
    /** A new subject: forget the data and every visual; the next begin() is pending. */
    reset() {
      if (disposed) return;
      pendingTimer = clearTimer(pendingTimer); refreshingTimer = clearTimer(refreshingTimer);
      removeSkeleton(); removeFailed(); removeIndicator(); removeNotice();
      state = settled = 'idle'; busy = false; hasData = false; user = false; observedAt = null; announced = null;
      if (status) status.textContent = '';
      setRegionBusy(false); setBusyControls(); syncQuiet();
    },
    /** A read starts. `user`: a Refresh/Retry the person asked for (its completion is announced).
     * `message`: what the read is doing when the generic wording would hide it ("Reading from <server>…"). */
    begin({ user: invoked = false, message = null } = {}) {
      if (disposed) return;
      user = user || invoked; busy = true;
      inFlight = typeof message === 'string' && message ? message : null;
      if (!hasData) {
        // A retry from `failed` keeps the block (its Retry may be focused) and shows no skeleton beside it.
        if (state !== 'pending') {
          state = 'pending'; setRegionBusy(true); say(inFlight || wording.loading(noun));
          if (!failedEl && pendingTimer === null) pendingTimer = schedule(showSkeleton, PENDING_DELAY_MS);
        }
      } else if (state !== 'refreshing') {
        state = 'refreshing'; setRegionBusy(false);
        if (refreshingTimer === null) refreshingTimer = schedule(showIndicator, REFRESHING_DELAY_MS);
      }
      setBusyControls();
    },
    /** The owning read succeeded. `observedAt` (ISO) labels old data; `empty` paints no notice but marks the state. */
    succeed({ observedAt: at = null, empty = false } = {}) {
      if (disposed) return;
      pendingTimer = clearTimer(pendingTimer); refreshingTimer = clearTimer(refreshingTimer);
      removeSkeleton(); removeFailed(); removeIndicator();
      const wasUser = user; user = false; busy = false; hasData = true;
      observedAt = typeof at === 'string' && at ? at : null;
      state = settled = empty ? 'empty' : 'ready'; setRegionBusy(false);
      if (isOldObservation(observedAt, now())) showNotice('observed'); else removeNotice();
      if (wasUser) say(wording.updated(noun)); else { announced = null; if (status) status.textContent = ''; }
      setBusyControls(); syncQuiet();
    },
    /** The owning read failed: stale with data, failed without. `observedAt` (ISO): the observation the
     * kept data comes from, when the failed reply still names it (a held / last-good table) — it dates
     * the stale line. A surface with data on screen calls fail() alone (never succeed() first: that
     * would rebuild the line under a focused Retry and announce twice). */
    fail(error = null, { observedAt: at, action = null } = {}) {
      if (disposed) return;
      // `action`: a second action for the failed block ({ label, onActivate }), e.g. Re-add workspace.
      failedAction = action && typeof action.label === 'string' && typeof action.onActivate === 'function' ? action : null;
      pendingTimer = clearTimer(pendingTimer); refreshingTimer = clearTimer(refreshingTimer);
      removeSkeleton(); removeIndicator();
      user = false; busy = false;
      if (typeof at === 'string' && at) observedAt = at;
      const message = typeof error?.message === 'string' && error.message ? error.message : null;
      const variant = noticeVariant(error?.cause);
      // A cache problem's message is on the line itself; Details keeps only the code.
      const cause = staleCause(doc, { message, code: error?.code, detail: error?.detail, codeOnly: variant?.reason === 'cache' });
      if (hasData) {
        state = settled = 'stale'; setRegionBusy(false);
        showNotice('stale', { cause, variant, message });
        say(`${wording.couldNotRefresh(noun)}.`);
      } else {
        state = settled = 'failed'; setRegionBusy(false); removeNotice();
        showFailed(error);
        say(message ? `${wording.couldNotRefresh(noun)}. ${message}` : `${wording.couldNotRefresh(noun)}.`);
      }
      setBusyControls(); syncQuiet();
    },
    touch,
    /** A surface's own message on the status line (an operation's result, a miss): goes through the
     * controller so its own announcements stay in sync (a direct textContent write would leave a
     * later identical announcement deduplicated away). */
    say(text) {
      if (disposed || !status) return;
      announced = text; status.textContent = text;
      // A surface's own message (an operation's result, a miss) is a different message from the stale or
      // failed one the quiet mark hides: it must be seen. The next fail() re-quiets through syncQuiet().
      status.classList.remove('loading-quiet');
    },
    /** The read settled without an observation (the server's deployment is still pending): stay
     * pending — aria-busy, the one announcement — but with no skeleton, since the surface paints the
     * deployment's own copy. The next begin() adds nothing; the first observation settles it. */
    defer({ keepSkeleton = false } = {}) {
      if (disposed) return;
      if (hasData) { api.cancel(); return; } // with data on screen there is nothing to hold: the read is simply over
      refreshingTimer = clearTimer(refreshingTimer);
      // keepSkeleton: the server answered "still reading" (an observed deployment whose list is being read,
      // `refreshing: true` with nothing held): the subject IS loading, so the skeleton stays or still arrives.
      if (!keepSkeleton) { pendingTimer = clearTimer(pendingTimer); removeSkeleton(); }
      removeIndicator(); removeFailed();
      busy = false; user = false;
      state = 'pending';
      // Also when already pending: an unobserved deployment's defer() (no skeleton) followed by "still reading".
      if (keepSkeleton && !skeletonEl && pendingTimer === null) pendingTimer = schedule(showSkeleton, PENDING_DELAY_MS);
      setRegionBusy(true); say(wording.loading(noun));
      setBusyControls(); syncQuiet();
    },
    /** The in-flight read was superseded or abandoned (the view hid, the host cancelled): drop the
     * pending visuals and the busy mark without announcing anything; the settled state stays. */
    cancel() {
      if (disposed || !busy) return;
      pendingTimer = clearTimer(pendingTimer); refreshingTimer = clearTimer(refreshingTimer);
      removeSkeleton(); removeIndicator();
      busy = false; user = false;
      if (state === 'pending' && settled === 'idle') { announced = null; if (status) status.textContent = ''; }
      state = settled; setRegionBusy(false);
      setBusyControls();
    },
    /** A Refresh control: aria-disabled while a read is in flight; `run` ignored meanwhile (never `disabled`: focus survives). */
    bindRefresh(control, run) {
      refreshControls.add(control);
      if (busy) control.setAttribute('aria-disabled', 'true');
      if (typeof run === 'function') control.addEventListener('click', () => { if (!disposed && !busy && control.getAttribute('aria-disabled') !== 'true') run(); });
      return () => refreshControls.delete(control);
    },
    dispose() {
      if (disposed) return;
      api.reset(); disposed = true; refreshControls.clear();
    },
  };
  return api;
}
