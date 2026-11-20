/** The capability page's Contents section (spec C): what an instance gets — the injected instructions
 * and every skill's files — read through `oats capabilities show` (capability-show-contract.mjs) and
 * readable in place: a navigation tree on the left, the selected file on the right.
 *
 * The section is one long-lived element owned by this controller, so the page around it can be rebuilt
 * (a catalog repaint) without losing what is open: the host re-appends `element` and calls `update()`
 * with the page's current subject. Presentation only: every file listed is the kernel's, nothing is
 * inferred, and every text is untrusted repository content — Markdown goes through the viewer's
 * sanitising pipeline in its strict profile (no raw HTML, no images), anything else is highlighted text.
 *
 * Latest intent: the show read and each file read carry a ticket checked on success and on failure; a
 * read for a subject or a selection the user has since left is discarded (A→B→A included). Selection and
 * focus never move on a background repaint: the tree is rebuilt only when the answer changed, focus is
 * found again by `data-focus-key`, and the open file stays open while it is still listed.
 *
 * Capability warnings (OATS 0.49.0, capability-warnings.mjs) sit above the card, full width: every one is
 * about this capability, so no name and no Open capability. They never change the section's ready state.
 *
 * Skills (the Desktop UI rework, slice 3b; guide tour steps 35 and 36): the same answer lists the capability's skills,
 * shown by the page as rows of their own (`skills`, a long-lived element the page places under "What it does"): each
 * skill's name and the first sentence of its description. Enter on one opens the whole skill in the pane (`skillView`,
 * a second long-lived element the page places beside its body): its SKILL.md, the front matter as facts then the body,
 * read-only, with the skill's other files a press away. Esc (or its Back) returns to the capability, focus on the
 * skill's row. Before the answer the rows are the catalog's skill names (`row.skills`), not openable; a gate (an older
 * CLI, a remote workspace, an external capability) leaves those names. The skill's read carries its own ticket.
 *
 * Trigger sources (feature `trigger-sources`) come in the same answer but belong to the page's Provides card:
 * the controller owns that row too (`triggerSources`, a second long-lived element the page appends into its
 * card on every rebuild) and tells the host when it appears or disappears (`onProvidesChange`). Neither the
 * declaration nor the kernel's problems with it change the section's state, its problems or its warnings. */
import { capabilityShowSupported, capabilitySelector, capabilityShowData, capabilityFileData, listedFiles, skillFilePath, skillRelativePath, triggerSourcesView, capabilityShowUnreadable } from '../../client/capability-show-contract.mjs';
import { DESKTOP_TERMS } from './desktop-terms.mjs';
import { fillTriggerSourcesRow } from './capability-page.mjs';
import { contentsCardCSS, sizeText, firstSentence, createContentsTree, createContentsReader, skillTreeItem, isSkillMd, SKILL_COPY } from './contents-reader.mjs';
import { iconElement } from './shell-icons.mjs';
import { createDataState, skeleton, captureFocusState } from './loading.mjs';
import { createWarningsList, capabilityWarningsCSS, WARNINGS_COPY } from './capability-warnings.mjs';

export const CONTENTS_COPY = Object.freeze({
  title: 'Contents',
  lead: commit => `What an instance gets, at ${commit}`,
  unsupported: "This OATS version can't show what a capability ships. Update OATS to see its instructions and skill files.",
  remote: 'Not available for a remote workspace yet.',
  external: "Contents can't be shown for an external capability.",
  unlisted: "Not in the workspace's capability list, so its contents can't be shown.",
  noInject: 'Injects no instructions.',
  noSkills: 'Ships no skills.',
  skillsUnlistable: "Its skills can't be listed: a spawn of it would refuse.",
  moreFiles: SKILL_COPY.moreFiles,
  skillUnlisted: SKILL_COPY.unlisted,
  inject: 'Injected instructions',
  binary: SKILL_COPY.binary,
  truncated: SKILL_COPY.truncated,
  tooLarge: size => `Too large to show${size ? ` (${size})` : ''}.`,
  notAvailable: 'Not available.',
  empty: 'Nothing to show: this capability injects no instructions and ships no skills.',
  skills: 'Skills',
  skillsNone: 'Ships no skills.',
  skillOpen: name => `${name}: open the whole skill`,
  skillBack: name => `Back to ${name}`,
  skillHint: 'Esc returns to the capability.',
  skillFiles: 'Its files',
  moved: 'The capability changed while it was read. Its contents are read again when the list is refreshed.',
});

/** The Contents card's grammar (contents-reader.mjs), shared with the soul page's Instructions, and the warnings above it. */
export const capabilityContentsCSS = `${contentsCardCSS}${capabilityWarningsCSS}
/* Skills (slice 3b): a row per skill, its name and one line; Enter opens the whole skill. */
.cap-skills-list { display:flex; flex-direction:column; margin:0; padding:0; list-style:none; background:var(--surface); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
.cap-skills-list > li { display:flex; min-width:0; }
.cap-skills-list > li + li { border-top:1px solid var(--tag-bg); }
.oats-view button.cap-skill-row, .cap-skill-row { appearance:none; -webkit-appearance:none; display:flex; flex-direction:column; gap:2px; flex:1; width:100%; min-width:0; height:auto; min-height:44px; margin:0; padding:8px 14px; border:0; border-radius:0; background:var(--surface); color:var(--fg); font:inherit; font-family:var(--ui-font,system-ui); text-align:left; box-sizing:border-box; }
.oats-view button.cap-skill-row { cursor:pointer; }
.oats-view button.cap-skill-row:hover { background:var(--surface-2); }
.oats-view button.cap-skill-row:focus-visible { background:var(--sel); }
.cap-skill-name { font-weight:600; font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cap-skill-desc { color:var(--muted); font-size:12.5px; line-height:1.4; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.cap-skills-note { margin:0; color:var(--muted); font-size:12.5px; }
.cap-skills-skeleton { display:flex; flex-direction:column; gap:10px; padding:10px 14px; }
.cap-skills-skeleton .skeleton-line { height:11px; width:60%; }
/* The whole skill, in the pane in place of the capability's body. */
.skill-view[hidden] { display:none !important; }
.skill-view { display:flex; flex-direction:column; gap:12px; max-width:860px; padding:18px 28px 28px; box-sizing:border-box; }
.skill-view-head { display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px; }
.oats-view .skill-view-head button.skill-back { display:inline-flex; align-items:center; gap:6px; height:28px; min-height:28px; padding:0 10px 0 8px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); font-weight:600; font-size:12.5px; line-height:normal; font-family:var(--ui-font,system-ui); cursor:pointer; }
.oats-view .skill-view-head button.skill-back:hover { background:var(--surface-2); }
.skill-view-title { margin:0; font-size:18px; font-weight:700; overflow-wrap:anywhere; }
.skill-view-hint { color:var(--muted); font-size:12px; }
.skill-view-files { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 10px; margin:0; color:var(--muted); font-size:12px; }
.oats-view .skill-view-files button { height:auto; min-height:0; padding:1px 0; border:0; background:transparent; color:var(--accent); font-weight:500; font-size:12px; line-height:normal; font-family:var(--mono,monospace); cursor:pointer; }
.oats-view .skill-view-files button[aria-current=true] { color:var(--fg); font-weight:650; }
.oats-view .skill-view-files button:focus-visible { background:var(--sel); border-radius:4px; }
.skill-view-reader { position:relative; min-width:0; border:1px solid var(--border); border-radius:10px; background:var(--bg); color:var(--fg); overflow:auto; max-height:none; }
.skill-view-reader:focus-visible { outline:1px solid var(--accent); outline-offset:-1px; }
.cap-contents-warnings { display:flex; flex-direction:column; gap:8px; min-width:0; }
/* A part of Contents, not a section of its own: the card's group-label grammar, not the section title's. */
.cap-contents-warnings-title { margin:0; color:var(--muted); font-size:10.5px; font-weight:650; letter-spacing:.05em; text-transform:uppercase; }
`;

const shortCommit = v => typeof v === 'string' && /^[0-9a-f]{40}$/i.test(v) ? v.slice(0, 7) : null;
export { sizeText, firstSentence };

/** What the section shows for a page subject, before any read: a gate line, the pending skeleton, or a
 * selector to read. `row`: the catalog row (or the merged row a soul page opens); `cli`: the probe. */
export function contentsSubject({ row, cli, remote = false, catalogPending = false }) {
  if (remote) return { gate: CONTENTS_COPY.remote };
  if (!capabilityShowSupported(cli)) return { gate: CONTENTS_COPY.unsupported };
  if (catalogPending) return { pending: true };
  if (row?.kind === 'external') return { gate: CONTENTS_COPY.external };
  const selector = capabilitySelector(row);
  return selector ? { selector } : { gate: CONTENTS_COPY.unlisted };
}
/** The selection key of an inject whose manifest value is not a safe path (`inject.path: null`): it is shown (its
 * problem says why) but never read. A leading `/` is never a listed path, nor where a link can resolve. */
export const UNSAFE_INJECT = '/inject';
/** The file opened first: the inject, else the first skill's SKILL.md (else its first file), else none. */
export function defaultSelection(show) {
  if (show?.inject) return show.inject.path ?? UNSAFE_INJECT;
  const skill = (show?.skills || []).find(s => s.files?.length);
  if (!skill) return null;
  const file = skill.files.find(f => isSkillMd(skill, f)) || skill.files[0];
  return skillFilePath(skill, file);
}

/**
 * @param {Document} doc
 * @param {object} o
 * @param {(body: object) => Promise<object>} o.request  POST /api/capabilities for this page's workspace: resolves the
 *   CLI's result, rejects with an Error carrying `code` and the CLI's message
 * @param {(url: string) => void} [o.openExternal]  an https: link
 * @param {() => void} [o.onCatalogStale]  what was read disagrees with the catalog row (E_CAPABILITY_UNKNOWN, or an answer
 *   at another commit than the row's): re-read the catalog; the page's next update() brings the new row
 * @param {() => void} [o.onProvidesChange]  the Trigger sources row (`triggerSources`) now has content, or no longer
 *   has: rebuild the page's Provides card around it. Called once the controller has settled, never mid-update
 */
export function createCapabilityContents(doc, { request, openExternal = null, onCatalogStale = null, onProvidesChange = null } = {}) {
  const node = (tag, cls, text) => { const el = doc.createElement(tag); if (cls) el.className = cls; if (text !== undefined && text !== null) el.textContent = text; return el; };
  const element = node('section', 'page-section cap-contents-section'); element.dataset.section = 'Contents';
  const heading = node('h3', 'page-section-title'); heading.append(node('span', null, CONTENTS_COPY.title));
  const lead = node('span', 'page-section-lead'); lead.hidden = true; heading.append(lead);
  const gate = node('p', 'cap-contents-gate'); gate.hidden = true;
  const card = node('div', 'cap-contents'); card.hidden = true;
  const nav = node('nav', 'cap-contents-nav'); nav.setAttribute('aria-label', 'Contents');
  const navNotice = node('div', 'cap-contents-nav-notice'); // the stale line (a re-read failed over an answer on screen) and "Refreshing…"
  const navBody = node('div', 'cap-contents-nav-body');
  const reader = node('div', 'cap-contents-reader'); reader.setAttribute('role', 'region'); reader.tabIndex = 0;
  const head = node('div', 'cap-reader-head'); head.hidden = true;
  const body = node('div', 'cap-reader-body');
  nav.append(navNotice, navBody); reader.append(head, body); card.append(nav, reader);
  const warnings = node('div', 'cap-contents-warnings'); warnings.hidden = true;
  element.append(heading, gate, warnings, card);
  // Not in `element`: the page's Provides card holds it (capability-page.mjs `fillTriggerSourcesRow`); empty until an answer declares sources.
  const triggerSources = node('div'); fillTriggerSourcesRow(triggerSources, null);
  // Skills (slice 3b): the page's rows under "What it does", and the whole skill in the pane. Not in `element` either.
  const skills = node('section', 'page-section cap-skills-section'); skills.dataset.section = 'Skills';
  const skillsHead = node('h3', 'page-section-title'); skillsHead.append(node('span', null, CONTENTS_COPY.skills));
  const skillsBody = node('div', 'cap-skills-body'); skills.append(skillsHead, skillsBody); skills.hidden = true;
  const skillView = node('section', 'skill-view'); skillView.hidden = true; skillView.dataset.view = 'skill';
  const svHead = node('div', 'skill-view-head'), svBack = node('button', 'skill-back'); svBack.type = 'button';
  const svTitle = node('h2', 'skill-view-title'); svTitle.id = `skill-view-title-${++instances}`; skillView.setAttribute('aria-labelledby', svTitle.id);
  svHead.append(svBack, svTitle, node('span', 'skill-view-hint', CONTENTS_COPY.skillHint));
  const svFiles = node('p', 'skill-view-files'); svFiles.hidden = true;
  const svReader = node('div', 'skill-view-reader'); svReader.setAttribute('role', 'region'); svReader.tabIndex = 0; svReader.setAttribute('aria-labelledby', svTitle.id);
  const svReaderHead = node('div', 'cap-reader-head'); svReaderHead.hidden = true;
  const svReaderBody = node('div', 'cap-reader-body');
  svReader.append(svReaderHead, svReaderBody); skillView.append(svHead, svFiles, svReader);
  let fallbackSkills, capName = '', skillsDrawn = null, openSkillRef = null, skillFile = null, skillTicket = 0;

  let alive = true, subjectKey = null, identityKey = null, selector = null, rowCommit = null, show = null, files = new Map();
  let selected = null, readerPath = null, expanded = new Set(), showTicket = 0, fileTicket = 0, rendered = null, renderedWarnings = null;
  let renderedSources = null, providesShown = false;

  const navState = createDataState({ doc, noun: 'contents', region: nav, skeletonHost: navBody, indicatorHost: navNotice,
    skeleton: () => { const block = node('div', 'cap-nav-skeleton'); block.setAttribute('aria-hidden', 'true'); for (let i = 0; i < 6; i++) block.append(skeleton(doc, 'line')); return block; },
    onRetry: () => readShow({ user: true }), focusFallback: () => reader });
  const fileState = createDataState({ doc, noun: 'file', region: reader, skeletonHost: body,
    skeleton: () => { const block = node('div', 'cap-reader-skeleton'); block.setAttribute('aria-hidden', 'true'); for (let i = 0; i < 7; i++) block.append(skeleton(doc, 'line')); return block; },
    onRetry: () => { if (selected) open(selected, { force: true }); }, focusFallback: () => nav.querySelector('[role=treeitem][tabindex="0"]') || reader });
  // The shared tree model (Enter/Space toggle a skill, open a file) and reader (contents-reader.mjs).
  const keys = createContentsTree(nav, { selected: () => selected,
    activate: item => { if (item.dataset.skill) keys.toggle(item); else if (item.dataset.path) open(item.dataset.path); },
    onExpand: (item, value) => { if (value) expanded.add(item.dataset.skill); else expanded.delete(item.dataset.skill); } });
  const fileReader = createContentsReader(doc, { reader, head, body, alive: () => alive, openExternal,
    isLocal: path => files.has(path),
    openLocal: path => {
      const parent = files.get(path);
      if (parent?.kind === 'skill' && !expanded.has(parent.skill.path)) keys.setExpanded([...nav.querySelectorAll('[role=treeitem][data-skill]')].find(i => i.dataset.skill === parent.skill.path), true);
      open(path);
    } });
  const skillReader = createContentsReader(doc, { reader: svReader, head: svReaderHead, body: svReaderBody, alive: () => alive, openExternal,
    isLocal: path => !!openSkillRef?.files?.some(f => f.path === path), openLocal: path => showSkillFile(path) });

  function showGate(text) {
    closeSkill({ focus: false });
    subjectKey = identityKey = null; selector = show = null; files = new Map(); showTicket++; fileTicket++;
    navState.reset(); fileState.reset(); clearWarnings(); clearTriggerSources();
    gate.textContent = text; gate.hidden = false; card.hidden = true; lead.hidden = true;
  }

  /** The page's subject now. Unchanged → nothing (a background repaint never touches what is open). */
  function update(page) { if (!alive) return; setSubject(page); paintSkills(); syncProvides(); }
  function setSubject({ row, cli, remote = false, catalogPending = false, deployment = null }) {
    const subject = contentsSubject({ row, cli, remote, catalogPending });
    // The catalog's skill names: a list, null (not listable: a spawn of it would refuse) or undefined (not reported).
    fallbackSkills = Array.isArray(row?.skills) ? row.skills.filter(name => typeof name === 'string' && name) : row?.skills === null ? null : undefined; capName = row?.name || '';
    if (subject.gate) { if (gate.textContent !== subject.gate || gate.hidden) showGate(subject.gate); return; }
    gate.hidden = true; card.hidden = false;
    reader.setAttribute('aria-label', `File of ${row?.name || 'this capability'}`);
    if (subject.pending) {
      // The selector comes from the catalog row, which is not read yet: the navigation's skeleton stands.
      if (subjectKey !== 'pending') { subjectKey = identityKey = null; selector = show = null; files = new Map(); rendered = null; showTicket++; navState.reset(); navBody.replaceChildren(); clearReader(); clearWarnings(); clearTriggerSources(); lead.hidden = true; subjectKey = 'pending'; navState.begin(); }
      return;
    }
    const identity = JSON.stringify([deployment, subject.selector]);
    const key = JSON.stringify([identity, typeof row?.commit === 'string' ? row.commit : null]);
    if (key === subjectKey) return;
    // Another capability (or deployment) starts afresh; the same one at a moved commit keeps the open path when it is still listed.
    if (identity !== identityKey) { closeSkill({ focus: false }); selected = null; expanded = new Set(); show = null; files = new Map(); rendered = null; navState.reset(); navBody.replaceChildren(); clearReader(); clearWarnings(); clearTriggerSources(); lead.hidden = true; }
    subjectKey = key; identityKey = identity; selector = subject.selector; rowCommit = typeof row?.commit === 'string' ? row.commit : null;
    readShow();
  }

  async function readShow({ user = false } = {}) {
    if (!selector) return;
    const ticket = ++showTicket, asked = selector;
    navState.begin({ user });
    let data;
    try {
      const result = await request({ action: 'show', capability: asked });
      if (!alive || ticket !== showTicket) return;
      data = capabilityShowData(result, { selector: asked });
      if (!data) throw Object.assign(new Error(capabilityShowUnreadable(DESKTOP_TERMS)), { code: 'E_CLI_PROTOCOL' });
      // The member head moved between the catalog read and this one: never render a mix of the two.
      if (rowCommit && data.commit !== rowCommit) throw Object.assign(new Error(CONTENTS_COPY.moved), { code: 'E_CAPABILITY_MOVED' });
    } catch (error) {
      if (!alive || ticket !== showTicket) return;
      // With an answer on screen it stays, stale (the line with Retry above the tree); without one, the failed
      // block with the CLI's message (a repeated failure updates it in place: its Retry may hold focus).
      navState.fail(error);
      paintSkills(); // the catalog's names stand in for the rows the answer would have given
      if (STALE_CODES.has(error?.code)) onCatalogStale?.();
      return;
    }
    navState.succeed({ empty: !data.inject && !(data.skills || []).length });
    applyShow(data);
  }

  function applyShow(data) {
    const previous = show; show = data; files = listedFiles(data);
    if (data.inject && data.inject.path === null) files.set(UNSAFE_INJECT, { kind: 'inject', file: data.inject });
    const short = shortCommit(data.commit); lead.textContent = short ? CONTENTS_COPY.lead(short) : ''; lead.hidden = !short;
    // Keep the open file while it is listed; else the default.
    if (!selected || !files.has(selected)) selected = defaultSelection(data);
    const parent = selected ? files.get(selected) : null;
    if (parent?.kind === 'skill') expanded.add(parent.skill.path);
    // An unchanged answer (a re-read at the same commit) never rebuilds the tree, or the warnings, under focus.
    // Each part is drawn from its own keys: trigger sources and their problems repaint neither of the two.
    const signature = JSON.stringify({ ...data, warnings: null, triggerSources: null, triggerSourceProblems: null });
    if (signature !== rendered) { rendered = signature; paintNav(); }
    const warned = JSON.stringify(data.warnings);
    if (warned !== renderedWarnings) { renderedWarnings = warned; paintWarnings(); }
    const sources = triggerSourcesView(data), sourced = JSON.stringify(sources);
    if (sourced !== renderedSources) { renderedSources = sourced; fillTriggerSourcesRow(triggerSources, sources); }
    const moved = !!previous && previous.commit !== data.commit;
    if (!previous || moved || readerPath !== selected) open(selected, { force: moved });
    // The open skill follows the answer: still listed, its file is read again at a moved commit; gone, it closes.
    let returnTo = null; // a skill closed under focus: its row (or Back), once the rows are repainted
    if (openSkillRef) {
      const still = (data.skills || []).find(skill => skill.path === openSkillRef.path && skill.files?.length);
      if (!still) returnTo = closeSkill({ focus: false, defer: true });
      else {
        // The same skill at a moved commit, or with another file list: its file buttons follow the answer, and the open
        // file stays open only while it is still listed (else its SKILL.md).
        const relisted = JSON.stringify(still.files) !== JSON.stringify(openSkillRef.files);
        openSkillRef = still;
        if (relisted) paintSkillFiles(still);
        const next = listedSkillFile(still, skillFile);
        if (moved || next !== skillFile) showSkillFile(next, { force: true });
      }
    }
    paintSkills();
    if (returnTo) focusSkillRow(returnTo);
    syncProvides();
  }

  /* ── skills (the page's rows) and the whole skill ────────────────────── */
  /** The rows: the answer's skills; before it the catalog's names, not openable (a skeleton while it is first read). */
  function paintSkills() {
    const pending = !show && navState.state === 'pending' && !fallbackSkills?.length;
    const listed = show ? show.skills : null;
    const signature = JSON.stringify([show ? 'show' : 'catalog', listed && listed.map(s => [s.name, s.path, s.description, s.files && s.files.map(f => f.path)]), show ? null : fallbackSkills === undefined ? 'unreported' : fallbackSkills, pending, capName]);
    if (signature === skillsDrawn) return;
    skillsDrawn = signature;
    const restore = captureFocusState(skillsBody, { scroller: null });
    skillsBody.replaceChildren();
    if (show) {
      if (listed === null) skillsBody.append(node('p', 'cap-skills-note', CONTENTS_COPY.skillsUnlistable));
      else if (!listed.length) skillsBody.append(node('p', 'cap-skills-note', CONTENTS_COPY.skillsNone));
      else skillsBody.append(skillRows(listed.map(skill => ({ skill, name: skill.name, description: skill.description }))));
    } else if (pending) {
      const block = node('div', 'cap-skills-skeleton'); block.setAttribute('aria-hidden', 'true'); for (let i = 0; i < 3; i++) block.append(skeleton(doc, 'line')); skillsBody.append(block);
    } else if (fallbackSkills?.length) skillsBody.append(skillRows(fallbackSkills.map(name => ({ skill: null, name, description: null }))));
    else if (Array.isArray(fallbackSkills)) skillsBody.append(node('p', 'cap-skills-note', CONTENTS_COPY.skillsNone));
    else if (fallbackSkills === null) skillsBody.append(node('p', 'cap-skills-note', CONTENTS_COPY.skillsUnlistable));
    skills.hidden = !skillsBody.childElementCount;
    restore();
  }
  function skillRows(entries) {
    const rows = node('ul', 'cap-skills-list'); rows.setAttribute('aria-label', `Skills of ${capName}`);
    for (const { skill, name, description } of entries) {
      const opens = !!skill?.files?.length;
      const row = node(opens ? 'button' : 'div', 'cap-skill-row');
      row.append(node('span', 'cap-skill-name', name));
      const line = skill && skill.files === null ? SKILL_COPY.unlisted : firstSentence(description);
      if (line) { const desc = node('span', 'cap-skill-desc', line); if (description) desc.title = description; row.append(desc); }
      if (opens) {
        row.type = 'button'; row.dataset.skill = skill.path; row.dataset.focusKey = `skill-row:${skill.path}`;
        row.setAttribute('aria-label', CONTENTS_COPY.skillOpen(name));
        // The skill as the answer lists it when pressed (a re-read may have moved its files since the row was drawn).
        row.addEventListener('click', () => openSkill((show?.skills || []).find(s => s.path === skill.path) || skill));
      }
      const item = node('li'); item.append(row); rows.append(item);
    }
    return rows;
  }
  /** The capability page's body beside the skill view (the page places both): hidden while a skill is open. */
  const pageBody = () => skillView.parentElement?.querySelector(':scope > .page-body') ?? null;
  /** The file a skill opens on, or `wanted` while it is still the skill's. */
  const listedSkillFile = (skill, wanted = null) => (skill.files.some(f => f.path === wanted) ? wanted : (skill.files.find(f => isSkillMd(skill, f)) || skill.files[0]).path);
  function openSkill(skill) {
    if (!alive || !skill?.files?.length) return;
    openSkillRef = skill;
    svBack.replaceChildren(iconElement(doc, 'chevronLeft', { size: 15 }), node('span', null, CONTENTS_COPY.skillBack(capName)));
    svTitle.textContent = skill.name;
    paintSkillFiles(skill);
    skillView.hidden = false; pageBody()?.setAttribute('hidden', '');
    showSkillFile(listedSkillFile(skill), { force: true });
    svReader.focus({ preventScroll: true });
  }
  /** The open skill's file buttons (SKILL.md first), when it has more than one; the shown file is marked current. */
  function paintSkillFiles(skill) {
    const focused = svFiles.contains(doc.activeElement) ? doc.activeElement.dataset.path : null;
    svFiles.replaceChildren(); svFiles.hidden = skill.files.length < 2;
    if (skill.files.length < 2) { if (focused) svReader.focus({ preventScroll: true }); return; }
    svFiles.append(node('span', null, `${CONTENTS_COPY.skillFiles}:`));
    for (const f of [...skill.files].sort((a, b) => isSkillMd(skill, b) - isSkillMd(skill, a))) {
      const b = node('button', null, skillRelativePath(skill, f)); b.type = 'button'; b.dataset.path = f.path; b.addEventListener('click', () => showSkillFile(f.path));
      if (f.path === skillFile) b.setAttribute('aria-current', 'true');
      svFiles.append(b);
    }
    // A repaint keeps focus on the same file's button, else on the reader (never on <body>).
    if (focused) ([...svFiles.querySelectorAll('button')].find(b => b.dataset.path === focused) || svReader).focus({ preventScroll: true });
  }
  /** Read one of the open skill's files into the skill view (its own ticket: a read for a file or skill left since is dropped). */
  function showSkillFile(path, { force = false } = {}) {
    if (!alive || !openSkillRef || !path) return;
    if (path === skillFile && !force) return;
    skillFile = path; const ticket = ++skillTicket, skill = openSkillRef, asked = selector;
    for (const b of svFiles.querySelectorAll('button')) { if (b.dataset.path === path) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); }
    const listed = skill.files.find(f => f.path === path);
    skillReader.paintHead(path, { bytes: listed?.bytes ?? null });
    svReaderBody.replaceChildren(); svReader.scrollTop = 0;
    const wait = node('div', 'cap-reader-skeleton'); wait.setAttribute('aria-hidden', 'true'); for (let i = 0; i < 7; i++) wait.append(skeleton(doc, 'line')); svReaderBody.append(wait);
    request({ action: 'file', capability: asked, path }).then(result => {
      if (!alive || ticket !== skillTicket) return;
      const data = capabilityFileData(result, { selector: asked, path });
      if (!data) throw Object.assign(new Error(capabilityShowUnreadable(DESKTOP_TERMS)), { code: 'E_CLI_PROTOCOL' });
      if (show && data.commit !== show.commit) throw Object.assign(new Error(CONTENTS_COPY.moved), { code: 'E_CAPABILITY_MOVED' });
      skillReader.paintHead(path, { bytes: data.file.bytes ?? listed?.bytes ?? null, flag: data.file.truncated ? CONTENTS_COPY.truncated : null });
      skillReader.paintFile(data.file, { missing: CONTENTS_COPY.notAvailable, binary: CONTENTS_COPY.binary });
    }).catch(error => {
      if (!alive || ticket !== skillTicket) return;
      if (error?.code === 'E_CAPABILITY_FILE_UNKNOWN') { svReaderBody.replaceChildren(skillReader.line(CONTENTS_COPY.notAvailable)); return; }
      if (error?.code === 'E_REMOTE_FILE_OVERSIZE') { svReaderBody.replaceChildren(skillReader.line(CONTENTS_COPY.tooLarge(sizeText(listed?.bytes)))); return; }
      const failed = skillReader.line(typeof error?.message === 'string' && error.message ? error.message : CONTENTS_COPY.notAvailable); failed.setAttribute('role', 'alert');
      const retry = node('button', 'act', 'Retry'); retry.type = 'button'; retry.addEventListener('click', () => { showSkillFile(path, { force: true }); svReader.focus({ preventScroll: true }); });
      svReaderBody.replaceChildren(failed, retry);
      if (STALE_CODES.has(error?.code)) onCatalogStale?.();
    });
  }
  /** Back to the capability: its body again, focus on the skill's row (`focus`, or when focus was in the skill view).
   * `defer`: focus nothing now and answer the closed skill's path when focus was in the view (the caller repaints the
   * rows first, then calls focusSkillRow), else null. */
  function closeSkill({ focus = true, defer = false } = {}) {
    const was = openSkillRef; skillTicket++; openSkillRef = null; skillFile = null;
    if (skillView.hidden) return null;
    const hadFocus = skillView.contains(doc.activeElement);
    skillView.hidden = true; pageBody()?.removeAttribute('hidden'); skillReader.clear();
    if (!was || !(focus || hadFocus)) return null;
    if (defer) return was.path;
    focusSkillRow(was.path);
    return null;
  }
  /** Focus the skill's row when it is still an openable row, else the page's Back (never <body>). */
  function focusSkillRow(path) {
    const row = [...skills.querySelectorAll('button.cap-skill-row')].find(b => b.dataset.skill === path);
    (row || pageBody()?.closest('.capability-page')?.querySelector('.page-back') || skills.querySelector('button'))?.focus({ preventScroll: false });
  }
  svBack.addEventListener('click', () => closeSkill({ focus: true }));
  skillView.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable) return;
    event.preventDefault(); closeSkill({ focus: true });
  });

  /* ── trigger sources (the Provides card's row) ───────────────────────── */
  function clearTriggerSources() { renderedSources = null; triggerSources.replaceChildren(); }
  /** The row appeared or disappeared: the host builds its Provides card with or without it. A change of what the
   * row says needs no host: the row is repainted in place. */
  function syncProvides() {
    const shown = triggerSources.childElementCount > 0;
    if (shown === providesShown) return;
    providesShown = shown; onProvidesChange?.();
  }

  /* ── warnings ────────────────────────────────────────────────────────── */
  function paintWarnings() {
    const restore = captureFocusState(warnings, { scroller: null });
    const list = createWarningsList(doc, show.warnings, { focusKey: 'cap-warning' });
    warnings.replaceChildren(...(list ? [node('h4', 'cap-contents-warnings-title', WARNINGS_COPY.title), list] : [])); warnings.hidden = !list;
    restore();
  }
  function clearWarnings() { renderedWarnings = null; warnings.replaceChildren(); warnings.hidden = true; }

  /* ── navigation ──────────────────────────────────────────────────────── */
  function paintNav() {
    const restore = captureFocusState(nav, { scroller: nav });
    navBody.replaceChildren();
    if (show.problems.length) {
      const notices = node('div', 'cap-contents-problems');
      for (const p of show.problems) {
        const line = node('p', 'cap-contents-problem'); line.dataset.code = p.code;
        if (p.path) line.append(node('span', 'mono', p.path), doc.createTextNode(' — '));
        line.append(doc.createTextNode(p.message)); notices.append(line);
      }
      navBody.append(notices);
    }
    // Both groups live in ONE tree (one tab stop; the arrows cross from one group to the other), each a
    // labelled role=group. An empty group is a label and a note beside the tree, in its place: notes are
    // not tree items. Order: Instructions, then Skills.
    const uid = `cap-contents-${++instances}`;
    const tree = node('ul', 'cap-tree'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', `Files of ${show.name}`);
    tree.addEventListener('keydown', keys.onKey);
    const group = (id, label) => {
      const wrap = node('li'); wrap.setAttribute('role', 'none');
      const title = node('div', 'cap-contents-group-label', label); title.id = id;
      const items = node('ul'); items.setAttribute('role', 'group'); items.setAttribute('aria-labelledby', id);
      wrap.append(title, items); tree.append(wrap);
      return items;
    };
    const note = (label, text) => [node('div', 'cap-contents-group-label', label), node('p', 'cap-contents-note', text)];
    if (show.inject) {
      const where = show.inject.path; // null: the manifest's value is not a safe path (its problem says so)
      group(`${uid}-instructions`, 'Instructions').append(leaf(where ?? UNSAFE_INJECT,
        [node('span', 'cap-node-name', CONTENTS_COPY.inject), ...(where ? [node('span', 'cap-node-file', where)] : [])], { level: 1, label: where ? `${CONTENTS_COPY.inject}, ${where}` : CONTENTS_COPY.inject }));
    } else navBody.append(...note('Instructions', CONTENTS_COPY.noInject));
    if (show.skills?.length) { const items = group(`${uid}-skills`, 'Skills'); for (const skill of show.skills) items.append(skillNode(skill)); }
    if (tree.childElementCount) navBody.append(tree);
    if (!show.skills?.length) navBody.append(...note('Skills', show.skills === null ? CONTENTS_COPY.skillsUnlistable : CONTENTS_COPY.noSkills));
    keys.syncRoving();
    restore();
  }
  function leaf(path, content, { level, label }) {
    const item = node('li'); item.setAttribute('role', 'treeitem'); item.setAttribute('aria-level', String(level));
    item.setAttribute('aria-selected', String(path === selected)); item.setAttribute('aria-label', label);
    item.dataset.path = path; item.dataset.focusKey = `file:${path}`; item.tabIndex = -1;
    const row = node('div', 'cap-node'); const twisty = node('span', 'cap-node-twisty'); twisty.setAttribute('aria-hidden', 'true');
    const copy = node('span', 'cap-node-copy'); copy.append(...content); row.append(twisty, copy); item.append(row);
    row.addEventListener('click', () => { keys.focusItem(item); open(path); });
    return item;
  }
  /** A skill and its files (the shared item, contents-reader.mjs): each file a leaf that opens it. */
  function skillNode(skill) {
    return skillTreeItem(doc, skill, { open: expanded.has(skill.path), focusKey: `skill:${skill.path}`, keys,
      fileItem: (f, shown) => leaf(skillFilePath(skill, f), [node('span', 'cap-node-name', shown)], { level: 2, label: shown }) });
  }
  /* ── reader ──────────────────────────────────────────────────────────── */
  function clearReader() { readerPath = null; fileTicket++; fileReader.clear(); fileState.reset(); }
  const paintHead = (path, bytes, truncated) => fileReader.paintHead(path, { bytes, flag: truncated ? CONTENTS_COPY.truncated : null });
  const line = fileReader.line;
  /** Open a listed file in the reader (and select it on the left). `force`: read again even when it is the one shown. */
  function open(path, { force = false } = {}) {
    if (!alive) return;
    if (!path) { clearReader(); body.append(line(CONTENTS_COPY.empty)); return; }
    const listed = files.get(path); if (!listed) return;
    selected = path; keys.markSelected();
    if (readerPath === path && !force) return;
    // A Retry of the file on screen keeps its failed block (and the Retry's focus) until the read settles.
    const retrying = readerPath === path && fileState.settled === 'failed';
    readerPath = path; const ticket = ++fileTicket;
    if (!retrying) { reader.scrollTop = 0; body.replaceChildren(); fileState.reset(); }
    paintHead(listed.file.path ?? CONTENTS_COPY.inject, listed.file.bytes, listed.kind === 'inject' ? listed.file.truncated : false);
    if (listed.kind === 'inject') { paintFile(listed.file); return; } // the show answer carries the inject's text: no --file call
    fileState.begin();
    request({ action: 'file', capability: selector, path }).then(result => {
      if (!alive || ticket !== fileTicket) return; // the user has left this file (A→B→A: B's ticket won, A's new read owns it)
      const data = capabilityFileData(result, { selector, path });
      if (!data) throw Object.assign(new Error(capabilityShowUnreadable(DESKTOP_TERMS)), { code: 'E_CLI_PROTOCOL' });
      if (data.commit !== show.commit) throw Object.assign(new Error(CONTENTS_COPY.moved), { code: 'E_CAPABILITY_MOVED' });
      fileState.succeed(); paintHead(path, data.file.bytes ?? listed.file.bytes, data.file.truncated); paintFile(data.file);
    }).catch(error => {
      if (!alive || ticket !== fileTicket) return;
      // By design (the kernel's 200-file cap, a symlink) or too large: a muted line, not the failed state.
      if (error?.code === 'E_CAPABILITY_FILE_UNKNOWN') { fileState.succeed(); body.replaceChildren(line(CONTENTS_COPY.notAvailable)); return; }
      if (error?.code === 'E_REMOTE_FILE_OVERSIZE') { fileState.succeed(); body.replaceChildren(line(CONTENTS_COPY.tooLarge(sizeText(listed.file.bytes)))); return; }
      fileState.fail(error);
      if (STALE_CODES.has(error?.code)) onCatalogStale?.();
    });
  }
  function paintFile(file) {
    // Missing, over the kernel's budget, or not a safe path (path null): its problem says why, verbatim.
    const problem = file.text === null ? show?.problems.find(p => p.path === file.path) : null;
    fileReader.paintFile(file, { missing: problem ? problem.message : CONTENTS_COPY.notAvailable, binary: CONTENTS_COPY.binary });
  }

  return {
    element, update,
    /** The Provides card's "Trigger sources" row: empty (no children) while the answer declares none. */
    triggerSources,
    /** The Skills rows (hidden while there is nothing to say) and the whole-skill view (hidden until a skill opens):
     * the page places both on every rebuild; the page's body is hidden while the skill view is shown. */
    skills, skillView,
    /** The open skill's path, or null. */
    get openSkill() { return openSkillRef?.path ?? null; },
    closeSkill,
    /** Re-read the show answer (the page's catalog was refreshed by the user). */
    refresh() { if (selector) readShow({ user: true }); },
    /** Before the host moves `element` (a page rebuild re-appends it): detaching drops focus and the panes'
     * scroll offsets, so take them now and put them back once it is in the document again. */
    hold() {
      const active = [element, skills, skillView].some(part => part.contains(doc.activeElement)) ? doc.activeElement : null;
      const navTop = nav.scrollTop, readerTop = reader.scrollTop, skillTop = svReader.scrollTop;
      return () => {
        if (!alive || !(element.isConnected || skillView.isConnected)) return;
        nav.scrollTop = navTop; reader.scrollTop = readerTop; svReader.scrollTop = skillTop;
        if (active?.isConnected && doc.activeElement !== active) active.focus({ preventScroll: true });
      };
    },
    get selected() { return selected; },
    dispose() { alive = false; showTicket++; fileTicket++; skillTicket++; fileReader.dispose(); skillReader.dispose(); navState.dispose(); fileState.dispose(); },
  };
}
/** Codes after which the catalog row is re-read: the kernel no longer knows the capability, or it moved. */
const STALE_CODES = new Set(['E_CAPABILITY_UNKNOWN', 'E_CAPABILITY_MOVED']);
let instances = 0; // ids for the group labels, unique per document
