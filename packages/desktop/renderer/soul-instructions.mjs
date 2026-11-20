/** The soul page's two prompts and its skills (the Desktop UI rework, slice 3a), from the inspection the page already
 * read: no request of its own.
 *
 * Two tabs, one roving tab stop (Left/Right, Home and End switch; Tab moves into the shown panel):
 * - **Soul instructions**: the soul's own AGENTS.md (`souls[0].instructions` = { file, text, truncated }), under its
 *   place in its repository (the soul row's `path`, the soul's directory there), never the host cache path in `file`.
 * - **Composed instructions**: the AGENTS.md a new agent here would get, when the inspection carries it (feature
 *   soul-composed-instructions, `inspect --soul --instructions`: `souls[0].composedInstructions`): one readable
 *   document made of its parts in the kernel's order, the soul's own body ("From this soul") then each injected block
 *   ("Injected by …"), its `<!-- oats:… -->` marker lines dropped (the part headers stand for them). The kernel's
 *   ranges are trusted only when they tile the text exactly as its contract says; an answer that does not is not shown.
 * Each tab is a reader at a readable measure, with a list of its sections on its left when the pane is wide: the
 * own file's headings, the composed document's parts.
 *
 * **Skills**, folded under a native disclosure below the tabs (the soul-skills-opt-in-inspection decision keeps them
 * reachable): a tree of two sections, the soul's own skills (feature soul-skills, `inspect --soul --skills`:
 * `souls[0].skills`) and every skill an agent gets (feature soul-composed-skills: `souls[0].composedSkills`, each row
 * saying where it comes from; without it the soul's own again, and a note that a newer OATS lists the rest), in the
 * Contents card's skill grammar (contents-reader.mjs `skillTreeItem`), and a reader for the chosen file. The kernel's
 * answer carries every file's text, so nothing more is read. A group that can't list anything is its label and one
 * note, never a guess. A link from either document, or from a skill file, to a listed skill file opens it there.
 *
 * One controller per soul page subject (the inspector creates it with the frame and disposes it with the subject),
 * its element re-appended by every repaint of the page: an unchanged inspection repaints nothing, and `hold()` carries
 * focus and every scroll offset across the re-append. Every text is untrusted repository content, rendered by the
 * shared reader's strict profile. */
import { createContentsTree, createContentsReader, skillTreeItem, sizeText, SKILL_COPY } from './contents-reader.mjs';
import { createHeadingSlugger } from './views/markdown.mjs';
import { DESKTOP_NOUNS } from './desktop-terms.mjs';

export const SOUL_INSTRUCTIONS_COPY = Object.freeze({
  title: 'Instructions',
  ownTab: 'Soul instructions',
  composedTab: 'Composed instructions',
  ownLead: 'The soul’s own AGENTS.md: what it defines itself.',
  composedLead: `What its ${DESKTOP_NOUNS.instances} are told: the soul’s instructions, then every capability’s injected section, in order.`,
  sections: 'Sections',
  soulSection: 'Defined in this soul',
  composedSection: `Every skill an ${DESKTOP_NOUNS.instance} gets`,
  file: 'AGENTS.md',
  unreadable: "This soul's AGENTS.md could not be read.",
  // The kernel caps a file it reports at 200,000 characters (instance-inspect.mjs readTextCapped, soul-composition.mjs).
  truncated: 'Truncated at 200,000 characters',
  composed: 'Composed AGENTS.md',
  parts: n => `${n} part${n === 1 ? '' : 's'}`,
  soulPart: 'This soul',
  fromSoul: 'From this soul',
  injectedBy: label => `Injected by ${label}`,
  partTruncated: 'Truncated',
  pastCap: 'Not included: past the size limit.',
  openCapability: 'Open capability',
  copy: 'Copy composed AGENTS.md',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  cannotCompose: "Can't be composed here: see the problem above.",
  cannotRead: "This OATS answered composed instructions this Desktop can't read.",
  composeAbsent: "This OATS doesn't compose a soul's instructions: OATS 0.46.0 and later do.",
  skillsGroup: 'Skills',
  skillsAbsent: "This OATS doesn't report a soul's skills.",
  noSkills: 'No skills of its own.',
  skillsUnlistable: "Its skills can't be listed: see the problem above.",
  skillsUnreadable: "This OATS answered skills this Desktop can't read.",
  skillsPick: 'Choose a skill’s file to read it.',
  omitted: 'Not shown: past the size limit of this answer.',
  fromCapability: id => `From ${id}`,
  capabilitySkills: 'Skills that capabilities add are listed by a newer OATS.',
  noComposedSkills: 'No skills from this soul or its capabilities.',
  composedSkillsUnlistable: `The skills an ${DESKTOP_NOUNS.instance} gets can't be listed: see the problem above.`,
  composedSkillsUnreadable: "This OATS answered composed skills this Desktop can't read.",
});
/** When the page asks for the composed AGENTS.md: composed-gate.mjs (shared with the server). */
export { COMPOSED_FEATURE, composedSupported } from '../../client/composed-gate.mjs';

export const soulInstructionsCSS = `
.soul-instructions { display:flex; flex-direction:column; gap:10px; min-width:0; }
/* The two tabs: one roving tab stop; the shown one underlined (its text says which, not the colour alone). */
.soul-tabs { display:flex; gap:4px; min-width:0; border-bottom:1px solid var(--border); }
.oats-view .soul-tabs button.soul-tab { height:auto; min-height:32px; margin:0 0 -1px; padding:6px 12px; border:0; border-bottom:2px solid transparent; border-radius:0;
  background:none; color:var(--muted); font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
.oats-view .soul-tabs button.soul-tab[aria-selected=true] { color:var(--fg); border-bottom-color:var(--accent); }
.oats-view .soul-tabs button.soul-tab:hover { color:var(--fg); }
.soul-tab-lead { margin:0; color:var(--muted); font-size:12px; }
.soul-tabpanel { display:flex; flex-direction:column; gap:8px; min-width:0; }
/* The section's own display rules (grid, flex) would beat the HTML hidden attribute: hidden always wins here. */
.soul-instructions [hidden] { display:none !important; }
/* A tab's document: its sections on the left when the pane is wide, the text at a readable measure. */
.soul-doc { display:grid; grid-template-columns:200px minmax(0,1fr); height:min(75vh, 820px); min-width:0; background:var(--bg); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
.soul-doc-nav { min-height:0; overflow:auto; padding:10px 8px 12px; border-right:1px solid var(--border); box-sizing:border-box; font-size:12px; }
.soul-doc-nav[hidden] { display:none; }
.soul-doc:has(> .soul-doc-nav[hidden]) { grid-template-columns:minmax(0,1fr); }
.soul-doc-nav ul { list-style:none; margin:0; padding:0; }
.oats-view .soul-doc-nav button.soul-doc-link { display:block; width:100%; height:auto; min-height:0; margin:0; padding:4px 6px; border:0; border-radius:6px; background:none; color:var(--fg);
  font:inherit; font-size:12px; font-weight:400; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
.oats-view .soul-doc-nav button.soul-doc-link:hover { background:var(--surface-2); }
.oats-view .soul-doc-nav button.soul-doc-link:focus-visible { background:var(--sel); }
.soul-doc-nav li[data-depth="1"] button.soul-doc-link { padding-left:18px; color:var(--muted); }
.soul-doc .cap-reader-body > * { max-width:72ch; }
@container (max-width: 760px) { .soul-doc { grid-template-columns:minmax(0,1fr); } .soul-doc-nav { display:none; } }
.oats-view .soul-instructions button.soul-copy, .oats-view .soul-instructions button.soul-file-open { height:24px; min-height:24px; margin-left:auto; padding:0 8px; font-size:11.5px; }
.soul-panel-note { margin:0; padding:14px 16px; color:var(--muted); font-size:12.5px; border:1px solid var(--border); border-radius:10px; }
.soul-part + .soul-part { margin-top:22px; }
.soul-part-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 10px; margin:0 0 8px; font-size:11.5px; }
.soul-part-title { color:var(--fg); font-size:12.5px; font-weight:650; }
.soul-part-file { color:var(--fg); font-family:var(--mono,monospace); overflow-wrap:anywhere; }
.soul-part-size { color:var(--muted); }
.soul-part-flag { color:var(--warn); font-weight:600; }
.oats-view .soul-instructions button.soul-part-open { height:22px; min-height:22px; margin-left:auto; padding:0 8px; font-size:11.5px; }
/* The rules are secondary: the header text says where a part comes from (WCAG 1.4.1). */
.soul-part-body { padding-left:12px; border-left:3px solid var(--border); }
.soul-part[data-source=soul] > .soul-part-body { border-left-color:var(--accent); }
/* Skills: folded under the tabs; open, the Contents card's tree and reader. */
.soul-skills > summary { cursor:pointer; color:var(--fg); font-size:13.5px; font-weight:650; }
.soul-skills > summary .soul-skills-count { color:var(--muted); font-size:12px; font-weight:400; }
.soul-skills[open] > summary { margin-bottom:10px; }
.soul-instructions .cap-tree [role=treeitem] [role=group] .cap-node { font-family:inherit; font-size:12px; }
.soul-instructions .cap-tree [role=treeitem] [role=group] .cap-node-name.mono { font-family:var(--mono,monospace); font-size:11.5px; }
.soul-instructions .soul-section-title { margin:4px 6px 6px; color:var(--fg); font-size:11.5px; font-weight:650; }
.soul-instructions .soul-section + .soul-section { margin-top:12px; padding-top:10px; border-top:1px solid var(--border); }
`;

/** The two tabs (OWN, the soul's own AGENTS.md; COMPOSED, the composed one), and a skill file's key: in "Defined in
 * this soul" by its soul-relative path (unique in the answer: a soul's skills never nest); in "Every skill …" by its
 * skill's path and its path in the skill, `//` between them (never in a plain path), since a capability's skills may
 * nest and list one file each. A skill item is expanded, never selected: its key names it in `expanded`. */
export const OWN = 'own';
export const COMPOSED = 'composed';
const skillKey = (path, composed = false) => `${composed ? 'composed-' : ''}skill:${path}`;
const fileKey = (skill, path, composed = false) => composed ? `composed-file:${skill.path}//${path.slice(skill.path.length + 1)}` : `file:${path}`;
/** Where a composed skill comes from, in the vocabulary of instance.json and the spawn preview (#1421 §1): the soul
 * (`soul`), or a capability's module (`module:<capability id>`). Its row's label, and the capability its reader may
 * open. Any other value names nothing: no label, rather than a guess. */
export function skillSource(source) {
  if (source === 'soul') return { label: SOUL_INSTRUCTIONS_COPY.fromSoul, capability: null };
  const capability = typeof source === 'string' ? /^module:(.+)$/.exec(source) : null;
  return capability ? { label: SOUL_INSTRUCTIONS_COPY.fromCapability(capability[1]), capability: capability[1] } : { label: null, capability: null };
}

/** A soul file's repository path: `<dir>/<path>` from the soul row's `path` (its directory in its repository, e.g.
 * `souls/<soul>`), when that is a plain relative path; else the soul-relative path alone. */
export function soulFilePath(dir, path) {
  const trimmed = typeof dir === 'string' ? dir.replace(/\/+$/, '') : null;
  return plainPath(trimmed) ? `${trimmed}/${path}` : path;
}
/** The soul's AGENTS.md as a repository path: `<dir>/AGENTS.md`, else just `AGENTS.md`. */
export const soulInstructionsPath = dir => soulFilePath(dir, SOUL_INSTRUCTIONS_COPY.file);
const plainPath = p => typeof p === 'string' && !!p && !p.startsWith('/') && !/[\\\u0000-\u001f\u007f]/.test(p) && p.split('/').every(s => s && s !== '.' && s !== '..');
/** What the section shows for an inspected soul row: the own file's path, text (null: unreadable) and truncation. */
export function soulInstructionsOf(soul) {
  const reported = soul?.instructions && typeof soul.instructions === 'object' ? soul.instructions : null;
  return { path: soulInstructionsPath(soul?.path), text: typeof reported?.text === 'string' ? reported.text : null, truncated: reported?.truncated === true };
}
const utf8Bytes = text => typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : null;
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
const span = v => record(v) && Number.isSafeInteger(v.start) && Number.isSafeInteger(v.end) && v.start >= 0 && v.start <= v.end && typeof v.truncated === 'boolean';

/** A block's text without its marker lines: the first line when it opens a block (`<!-- oats:`), and, after trailing
 * whitespace, the last when it closes one (`<!-- /oats:`; a block cut by the cap may have none). */
export function blockText(raw) {
  let text = raw;
  const first = text.indexOf('\n');
  if ((first < 0 ? text : text.slice(0, first)).startsWith('<!-- oats:')) text = first < 0 ? '' : text.slice(first + 1);
  text = text.replace(/\s+$/, '');
  const last = text.lastIndexOf('\n');
  if (text.slice(last + 1).startsWith('<!-- /oats:')) text = last < 0 ? '' : text.slice(0, last);
  return text;
}
/** A source's labels: in the navigation, and its part header's "Injected by …" (a capability's id; OATS's own blocks named). */
export function sourceLabels(source) {
  const capability = /^capability:(.+)$/.exec(source);
  if (capability) return { nav: capability[1], header: capability[1], capability: capability[1] };
  if (source === 'kernel:instance-boundary') return { nav: 'Instance boundary · OATS', header: 'OATS · instance boundary' };
  const mode = /^work-mode:(.+)$/.exec(source);
  if (mode) return { nav: `Work mode · ${mode[1]}`, header: `OATS · work mode ${mode[1]}` };
  const kernel = /^kernel:(.+)$/.exec(source);
  if (kernel) return { nav: `${kernel[1]} · OATS`, header: `OATS · ${kernel[1]}` };
  return { nav: source, header: source };
}
/**
 * The composed AGENTS.md of an inspected soul row: `undefined` without the key (the CLI was not asked, or cannot
 * compose), `null` when the kernel answered it cannot be composed here, `false` when the answer breaks its contract,
 * else `{ text, truncated, parts }` with the soul's part first.
 */
export function composedOf(soul, ownPath = soulInstructionsPath(soul?.path)) {
  if (!record(soul) || !Object.hasOwn(soul, 'composedInstructions')) return undefined;
  const c = soul.composedInstructions;
  if (c === null) return null;
  if (!record(c) || typeof c.text !== 'string' || typeof c.truncated !== 'boolean' || !span(c.body) || c.body.start !== 0 || !Array.isArray(c.sources)) return false;
  // The ranges tile the text, in order: body, then every block, the last ending at the text's end.
  let at = c.body.end;
  for (const s of c.sources) {
    if (!record(s) || typeof s.source !== 'string' || !s.source || !(s.file === null || typeof s.file === 'string') || !span(s) || s.start !== at) return false;
    at = s.end;
  }
  if (at !== c.text.length) return false;
  const soulPart = { source: 'soul', nav: SOUL_INSTRUCTIONS_COPY.soulPart, header: SOUL_INSTRUCTIONS_COPY.fromSoul, file: ownPath,
    text: c.text.slice(c.body.start, c.body.end).replace(/\s+$/, ''), truncated: c.body.truncated, past: c.body.truncated && c.body.start === c.body.end };
  const parts = [soulPart, ...c.sources.map(s => ({ source: s.source, ...sourceLabels(s.source), header: SOUL_INSTRUCTIONS_COPY.injectedBy(sourceLabels(s.source).header),
    file: plainPath(s.file) ? s.file : null, text: blockText(c.text.slice(s.start, s.end)), truncated: s.truncated, past: s.truncated && s.start === s.end && s.end === c.text.length }))];
  return { text: c.text, truncated: c.truncated, parts };
}

/**
 * The soul's own skills of an inspected soul row: `undefined` without the key (the CLI was not asked, or does not report
 * them), `null` when the kernel answered they can't be listed (a problem names `skills`), `false` when the answer breaks
 * its contract, else the list in the kernel's order. One bad skill or file makes the whole answer `false`: a partial
 * answer is never shown. Every path is a plain path relative to the soul's directory, a file's under its skill's; a
 * file's `text` is `null` exactly when it is binary or omitted (past the answer's text budget).
 */
export function skillsOf(soul) {
  if (!record(soul) || !Object.hasOwn(soul, 'skills')) return undefined;
  return skillRows(soul.skills, false);
}
/**
 * Every skill a spawn gives an instance of an inspected soul row (`composedSkills`, feature soul-composed-skills), by
 * skillsOf's rules, each row with its `source` (a non-empty string: `soul`, `module:<id>`, or a value skillSource names
 * nothing for). A soul skill's paths are relative to the soul's directory, a capability's to the instance home
 * (`.oats/modules/<id>/…`). A capability may declare one skill inside another, so a file path is unique within its
 * skill only. `null`: the kernel answered they can't be listed (a problem names `composedSkills`).
 */
export function composedSkillsOf(soul) {
  if (!record(soul) || !Object.hasOwn(soul, 'composedSkills')) return undefined;
  return skillRows(soul.composedSkills, true);
}
function skillRows(v, sourced) {
  if (v === null) return null;
  if (!Array.isArray(v)) return false;
  const skillPaths = new Set(), filePaths = new Set(), out = [];
  for (const s of v) {
    if (!record(s) || typeof s.name !== 'string' || !s.name || !plainPath(s.path) || skillPaths.has(s.path)) return false;
    if (sourced && (typeof s.source !== 'string' || !s.source)) return false;
    if (!(s.description === undefined || s.description === null || typeof s.description === 'string')) return false;
    if (!(s.filesTruncated === undefined || typeof s.filesTruncated === 'boolean') || !(s.files === null || Array.isArray(s.files))) return false;
    if (s.files === null && s.filesTruncated) return false;
    skillPaths.add(s.path);
    let files = null;
    if (s.files) {
      files = [];
      if (sourced) filePaths.clear();
      for (const f of s.files) {
        if (!record(f) || !plainPath(f.path) || !f.path.startsWith(`${s.path}/`) || filePaths.has(f.path)) return false;
        if (!Number.isSafeInteger(f.bytes) || f.bytes < 0 || !(f.text === null || typeof f.text === 'string') || typeof f.binary !== 'boolean' || typeof f.truncated !== 'boolean') return false;
        if (!(f.omitted === undefined || f.omitted === true)) return false;
        const omitted = f.omitted === true;
        if ((f.binary || omitted) !== (f.text === null)) return false;
        filePaths.add(f.path);
        files.push({ path: f.path, bytes: f.bytes, text: f.text, binary: f.binary, truncated: f.truncated, omitted });
      }
    }
    out.push({ name: s.name, ...(sourced ? { source: s.source } : {}), path: s.path, description: typeof s.description === 'string' ? s.description : null, files, filesTruncated: s.filesTruncated === true });
  }
  return out;
}


/**
 * @param {Document} doc
 * @param {object} [o]
 * @param {(url: string) => void} [o.openExternal]  an https: link
 * @param {(id: string) => boolean} [o.canOpenCapability]  the soul page can open this capability's page
 * @param {(id: string) => void} [o.openCapability]
 */
export function createSoulInstructions(doc, { openExternal = null, canOpenCapability = () => false, openCapability = null } = {}) {
  const node = (tag, cls, text) => { const el = doc.createElement(tag); if (cls) el.className = cls; if (text !== undefined && text !== null) el.textContent = text; return el; };
  const uid = `soul-instructions-${++instances}`;
  const element = node('section', 'page-section soul-instructions'); element.dataset.section = 'Instructions';
  element.setAttribute('aria-label', SOUL_INSTRUCTIONS_COPY.title);

  /* ── the two tabs ─────────────────────────────────────────────────────── */
  const TABS = [OWN, COMPOSED];
  const tablist = node('div', 'soul-tabs'); tablist.setAttribute('role', 'tablist'); tablist.setAttribute('aria-label', SOUL_INSTRUCTIONS_COPY.title);
  const tabs = new Map(), panels = new Map(), docs = new Map();
  for (const name of TABS) {
    const tab = node('button', 'soul-tab', name === OWN ? SOUL_INSTRUCTIONS_COPY.ownTab : SOUL_INSTRUCTIONS_COPY.composedTab);
    tab.type = 'button'; tab.id = `${uid}-tab-${name}`; tab.dataset.tab = name; tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `${uid}-panel-${name}`); tab.dataset.focusKey = `instructions:tab:${name}`;
    tab.addEventListener('click', () => setTab(name));
    tab.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const at = TABS.indexOf(name), n = TABS.length;
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : event.key === 'ArrowRight' ? (at + 1) % n : event.key === 'ArrowLeft' ? (at + n - 1) % n : -1;
      if (index < 0) return;
      event.preventDefault(); setTab(TABS[index], { focus: true });
    });
    tabs.set(name, tab); tablist.append(tab);
    const panel = node('div', 'soul-tabpanel'); panel.id = `${uid}-panel-${name}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id);
    panel.dataset.tab = name;
    panel.append(node('p', 'soul-tab-lead', name === OWN ? SOUL_INSTRUCTIONS_COPY.ownLead : SOUL_INSTRUCTIONS_COPY.composedLead));
    const note = node('p', 'soul-panel-note'); note.hidden = true;
    const box = node('div', 'soul-doc');
    const nav = node('nav', 'soul-doc-nav'); nav.setAttribute('aria-label', `${SOUL_INSTRUCTIONS_COPY.sections}: ${tab.textContent}`); nav.hidden = true;
    const reader = node('div', 'cap-contents-reader'); reader.setAttribute('role', 'region'); reader.tabIndex = 0;
    const head = node('div', 'cap-reader-head'); head.hidden = true;
    const body = node('div', 'cap-reader-body');
    reader.append(head, body); box.append(nav, reader); panel.append(note, box);
    const fileReader = createContentsReader(doc, { reader, head, body, alive: () => alive, openExternal,
      isLocal: path => local.has(path), openLocal: path => openSkillFile(localKey(path, name === COMPOSED)) });
    docs.set(name, { nav, reader, head, body, note, box, fileReader });
    panels.set(name, panel);
  }
  let tab = OWN;
  /** Show a tab (its panel; the other hidden), and with `focus` move focus to it. */
  function setTab(name, { focus = false } = {}) {
    if (!alive || !TABS.includes(name)) return;
    tab = name;
    for (const [key, control] of tabs) { const on = key === name; control.setAttribute('aria-selected', String(on)); control.tabIndex = on ? 0 : -1; panels.get(key).hidden = !on; }
    if (focus) tabs.get(name).focus({ preventScroll: true });
  }

  /* ── skills ───────────────────────────────────────────────────────────── */
  const skillsBox = node('details', 'soul-skills');
  const skillsSummary = node('summary'); skillsSummary.dataset.focusKey = 'instructions:skills';
  const skillsCount = node('span', 'soul-skills-count');
  skillsSummary.append(node('span', null, SOUL_INSTRUCTIONS_COPY.skillsGroup), ' ', skillsCount);
  const card = node('div', 'cap-contents');
  const nav = node('nav', 'cap-contents-nav'); nav.setAttribute('aria-label', SOUL_INSTRUCTIONS_COPY.skillsGroup);
  const navBody = node('div', 'cap-contents-nav-body');
  const reader = node('div', 'cap-contents-reader'); reader.setAttribute('role', 'region'); reader.tabIndex = 0;
  const head = node('div', 'cap-reader-head'); head.hidden = true;
  const body = node('div', 'cap-reader-body');
  nav.append(navBody); reader.append(head, body); card.append(nav, reader);
  skillsBox.append(skillsSummary, card);
  element.append(tablist, ...panels.values(), skillsBox);

  // `files`: each listed skill file by its key ({ skill, file, path: its repository path, or a capability's home path,
  // composed: in "Every skill …", capability: the one it comes from or null }); `local`: the keys by that path,
  // { own, composed: [each composed copy] }, either absent when the file is listed in one section only.
  let alive = true, name = null, own = null, composed, skills, composedSkills, files = new Map(), local = new Map();
  let navSignature = null, ownSignature = null, composedSignature = null, fileSignature = null, localSignature = null, shown = null, selected = null;
  const expanded = new Set(); // each expanded skill's skillKey
  const timers = new Set();
  setTab(OWN);
  // A skill item toggles (Enter/Space, as in Contents); a file item opens it.
  const keys = createContentsTree(nav, { selected: () => selected,
    activate: item => { if (item.dataset.skill !== undefined) keys.toggle(item); else if (item.dataset.path) openSkillFile(item.dataset.path); },
    onExpand: (item, value) => { const key = item.dataset.focusKey.slice('instructions:'.length); if (value) expanded.add(key); else expanded.delete(key); } });
  const skillReader = createContentsReader(doc, { reader, head, body, alive: () => alive, openExternal,
    isLocal: path => local.has(path), openLocal: path => openSkillFile(localKey(path, !!files.get(shown)?.composed)) });
  /** A link's target: in the section it is read from (`composedSide`: the composed document or a composed skill file),
   * a composed copy in the skill being read first, as nested skills list one file each; else the one listed. */
  function localKey(path, composedSide) {
    const { own: mine, composed: copies = [] } = local.get(path) || {};
    const reading = files.get(shown)?.skill, copy = copies.find(key => files.get(key).skill === reading) ?? copies[0];
    return (composedSide ? copy : mine) ?? mine ?? copy;
  }
  // Found by its key as data, never through a selector: a key holds the soul's own paths.
  const itemFor = focusKey => [...nav.querySelectorAll('[role=treeitem]')].find(item => item.dataset.focusKey === focusKey) || null;
  const fileSig = key => { const entry = files.get(key); return JSON.stringify(entry ? [entry.path, entry.file, entry.capability] : null); };

  /** The page's inspected soul row (`inspected.souls[0]`). Unchanged → nothing: a repaint never touches what is open. */
  function update(soul) {
    if (!alive) return;
    name = typeof soul?.name === 'string' && soul.name ? soul.name : null;
    own = soulInstructionsOf(soul);
    composed = composedOf(soul, own.path);
    skills = skillsOf(soul);
    composedSkills = composedSkillsOf(soul);
    files = new Map(); local = new Map();
    const list = (rows, composedCopy) => {
      for (const skill of Array.isArray(rows) ? rows : []) {
        // A soul's skill is shown under its repository path; a capability's under its place in the agent's home.
        const { capability } = composedCopy ? skillSource(skill.source ?? 'soul') : { capability: null };
        const ownFile = !composedCopy || skill.source === undefined || skill.source === 'soul';
        for (const file of skill.files || []) {
          const path = ownFile ? soulFilePath(soul?.path, file.path) : file.path, key = fileKey(skill, file.path, composedCopy);
          files.set(key, { skill, file, path, composed: composedCopy, capability });
          const keysAt = local.get(path) || {};
          if (composedCopy) (keysAt.composed ||= []).push(key); else keysAt.own = key;
          local.set(path, keysAt);
        }
      }
    };
    // "Every skill an agent gets": the kernel's composed list when it answered one, else the soul's own again.
    list(skills, false); list(composedSkills === undefined ? skills : composedSkills, true);
    for (const d of docs.values()) d.reader.setAttribute('aria-label', `${name || 'This soul'}: ${d === docs.get(OWN) ? SOUL_INSTRUCTIONS_COPY.ownTab : SOUL_INSTRUCTIONS_COPY.composedTab}`);
    reader.setAttribute('aria-label', `${name || 'This soul'}: ${SOUL_INSTRUCTIONS_COPY.skillsGroup}`);
    if (selected !== null && !files.has(selected)) selected = null;
    const rows = list => Array.isArray(list) ? list.map(s => [s.name, s.source ?? null, s.path, s.description, s.filesTruncated, s.files && s.files.map(f => f.path)]) : String(list);
    const signature = JSON.stringify([name, rows(skills), rows(composedSkills)]);
    if (signature !== navSignature) { navSignature = signature; paintNav(); }
    // What a reader's links resolve to is part of what it shows: another set of listed files repaints them.
    const ownNow = JSON.stringify(own), composedNow = JSON.stringify(composed ?? String(composed)), localNow = JSON.stringify([...local.keys()]);
    const linksChanged = localNow !== localSignature;
    if (ownNow !== ownSignature || linksChanged) paintOwn();
    if (composedNow !== composedSignature || linksChanged) paintComposed();
    ownSignature = ownNow; composedSignature = composedNow; localSignature = localNow;
    // A repaint of what is shown keeps the reader's offset (the host's hold()); the browser clamps it.
    if (selected !== null) { if (shown !== selected || linksChanged || fileSig(selected) !== fileSignature) paintFile(selected); }
    else if (shown !== null || !body.childElementCount) { shown = null; skillReader.clear(); body.append(skillReader.line(SOUL_INSTRUCTIONS_COPY.skillsPick)); }
  }

  /* ── the documents ───────────────────────────────────────────────────── */
  /** A tab's section list: one button per entry, `[label, target, depth]`; none hides the list. */
  function paintSections(d, entries) {
    d.nav.replaceChildren();
    d.nav.hidden = entries.length < 2;
    const list = node('ul');
    entries.forEach(([label, target, depth = 0], i) => {
      const item = node('li'); item.dataset.depth = String(depth);
      const link = node('button', 'soul-doc-link', label); link.type = 'button'; link.title = label; link.dataset.focusKey = `instructions:${d === docs.get(OWN) ? OWN : COMPOSED}:section:${i}`;
      link.addEventListener('click', () => { if (alive && target.isConnected) d.fileReader.scrollTo(target); });
      item.append(link); list.append(item);
    });
    d.nav.append(list);
  }
  /** The own file: its path, size and cut in the head; the text through the strict reader; its headings as sections. */
  function paintOwn() {
    const d = docs.get(OWN);
    d.fileReader.paintHead(own.path, { bytes: own.text !== null && !own.truncated ? utf8Bytes(own.text) : null, flag: own.truncated ? SOUL_INSTRUCTIONS_COPY.truncated : null });
    d.fileReader.paintFile({ path: own.path, text: own.text, binary: false }, { missing: SOUL_INSTRUCTIONS_COPY.unreadable, binary: null });
    const headings = [...d.body.querySelectorAll('h1, h2, h3')];
    const top = Math.min(...headings.map(h => Number(h.tagName[1])));
    paintSections(d, headings.map(h => [h.textContent, h, Number(h.tagName[1]) > top ? 1 : 0]));
  }
  /** The composed document: one section per part, its header saying where the part comes from; or why there is none. */
  function paintComposed() {
    const d = docs.get(COMPOSED);
    const reason = composed === undefined ? SOUL_INSTRUCTIONS_COPY.composeAbsent : composed === null ? SOUL_INSTRUCTIONS_COPY.cannotCompose
      : composed === false ? SOUL_INSTRUCTIONS_COPY.cannotRead : null;
    d.note.textContent = reason ?? ''; d.note.hidden = !reason; d.box.hidden = !!reason;
    // With no reader in it, the panel itself is the stop Tab lands on from the tablist (the accessible-tabs pattern).
    if (reason) panels.get(COMPOSED).tabIndex = 0; else panels.get(COMPOSED).removeAttribute('tabindex');
    if (reason) { d.fileReader.clear(); d.nav.replaceChildren(); d.nav.hidden = true; return; }
    d.fileReader.paintHead(SOUL_INSTRUCTIONS_COPY.composed, { bytes: composed.truncated ? null : utf8Bytes(composed.text),
      flag: composed.truncated ? SOUL_INSTRUCTIONS_COPY.truncated : null, actions: [copyButton(composed.text)] });
    d.body.replaceChildren(...composed.parts.map(partSection(d.fileReader)));
    uniqueIds([...d.body.querySelectorAll(':scope > .soul-part')]);
    paintSections(d, [...d.body.querySelectorAll(':scope > .soul-part')].map((section, i) => [composed.parts[i].nav, section]));
  }
  const partSection = fileReader => (part, i) => {
    const section = node('section', 'soul-part'); section.dataset.part = String(i); section.dataset.source = part.source;
    const title = node('span', 'soul-part-title', part.header); title.id = `${uid}-part-${i}`;
    section.setAttribute('aria-labelledby', title.id);
    const headRow = node('div', 'soul-part-head'); headRow.append(title);
    if (part.file) headRow.append(node('span', 'soul-part-file', part.file));
    const size = part.source !== 'soul' && !part.past ? sizeText(utf8Bytes(part.text)) : null; if (size) headRow.append(node('span', 'soul-part-size', size));
    if (part.truncated && !part.past) headRow.append(node('span', 'soul-part-flag', SOUL_INSTRUCTIONS_COPY.partTruncated));
    const button = part.capability ? openCapabilityButton(part.capability, 'act soul-part-open') : null;
    if (button) headRow.append(button);
    const content = node('div', 'soul-part-body');
    content.append(part.past ? fileReader.line(SOUL_INSTRUCTIONS_COPY.pastCap) : fileReader.fileView({ path: part.file || SOUL_INSTRUCTIONS_COPY.file, text: part.text }, { markdown: true }));
    section.append(headRow, content);
    return section;
  };

  /* ── the skills tree ─────────────────────────────────────────────────── */
  function paintNav() {
    const focused = nav.contains(doc.activeElement) ? doc.activeElement.closest('[role=treeitem]') : null;
    const focusKey = focused?.dataset.focusKey, parentKey = focused?.parentElement.closest('[role=treeitem]')?.dataset.focusKey;
    navBody.replaceChildren();
    const count = Array.isArray(composedSkills) ? composedSkills.length : Array.isArray(skills) ? skills.length : null;
    skillsCount.textContent = count === null ? '' : `· ${count}`;
    // One tree of two labelled sections, each a group of skills or its note (one tab stop; the arrows cross the boundary).
    const tree = node('ul', 'cap-tree'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', `${SOUL_INSTRUCTIONS_COPY.skillsGroup} of ${name || 'this soul'}`);
    tree.addEventListener('keydown', keys.onKey);
    const section = (id, title) => {
      const wrap = node('li', 'soul-section'); wrap.setAttribute('role', 'none');
      const heading = node('div', 'soul-section-title', title); heading.id = id;
      const items = node('ul'); items.setAttribute('role', 'group'); items.setAttribute('aria-labelledby', id);
      wrap.append(heading, items); tree.append(wrap); return items;
    };
    /** Notes in place of a section's skills (or after them): rows that are not tree items. */
    const noteRow = (parent, ...notes) => { const row = node('li'); row.setAttribute('role', 'none'); row.append(...notes.map(text => node('p', 'cap-contents-note', text))); parent.append(row); };
    const listed = Array.isArray(skills) && skills.length > 0;
    const mine = section(`${uid}-soul`, SOUL_INSTRUCTIONS_COPY.soulSection);
    if (listed) for (const skill of skills) mine.append(skillItem(skill));
    else noteRow(mine, skillsNote());
    const theirs = section(`${uid}-composed`, SOUL_INSTRUCTIONS_COPY.composedSection);
    if (composedSkills !== undefined) {
      if (Array.isArray(composedSkills) && composedSkills.length) for (const skill of composedSkills) theirs.append(skillItem(skill, skillSource(skill.source)));
      else noteRow(theirs, composedSkills === null ? SOUL_INSTRUCTIONS_COPY.composedSkillsUnlistable
        : composedSkills === false ? SOUL_INSTRUCTIONS_COPY.composedSkillsUnreadable : SOUL_INSTRUCTIONS_COPY.noComposedSkills);
    } else if (listed) {
      for (const skill of skills) theirs.append(skillItem(skill, skillSource('soul')));
      noteRow(theirs, SOUL_INSTRUCTIONS_COPY.capabilitySkills);
    } else if (Array.isArray(skills)) noteRow(theirs, skillsNote(), SOUL_INSTRUCTIONS_COPY.capabilitySkills);
    else noteRow(theirs, skillsNote());
    navBody.append(tree);
    keys.syncRoving();
    if (focusKey) (itemFor(focusKey) || (parentKey && itemFor(parentKey)) || nav.querySelector('[role=treeitem]'))?.focus({ preventScroll: true });
  }
  function skillItem(skill, source = null) {
    const composedCopy = !!source;
    return skillTreeItem(doc, skill, { open: expanded.has(skillKey(skill.path, composedCopy)), focusKey: `instructions:${skillKey(skill.path, composedCopy)}`, keys,
      source: source?.label ?? null,
      fileItem: (file, shownPath) => leaf(fileKey(skill, file.path, composedCopy), [node('span', 'cap-node-name mono', shownPath)], { level: 2, label: shownPath }) });
  }
  const skillsNote = () => skills === undefined ? SOUL_INSTRUCTIONS_COPY.skillsAbsent : skills === null ? SOUL_INSTRUCTIONS_COPY.skillsUnlistable
    : skills === false ? SOUL_INSTRUCTIONS_COPY.skillsUnreadable : SOUL_INSTRUCTIONS_COPY.noSkills;
  function leaf(key, content, { level, label }) {
    const item = node('li'); item.setAttribute('role', 'treeitem'); item.setAttribute('aria-level', String(level));
    item.setAttribute('aria-selected', String(key === selected)); item.setAttribute('aria-label', label);
    item.dataset.path = key; item.dataset.focusKey = `instructions:${key}`; item.tabIndex = -1;
    const row = node('div', 'cap-node'); const twisty = node('span', 'cap-node-twisty'); twisty.setAttribute('aria-hidden', 'true');
    const copy = node('span', 'cap-node-copy'); copy.append(...content); row.append(twisty, copy); item.append(row);
    row.addEventListener('click', () => { keys.focusItem(item); openSkillFile(key); });
    return item;
  }
  /** Open a skill file in the Skills reader: the disclosure opens, its skill expands (a link may come from a document). */
  function openSkillFile(key) {
    if (!alive || !files.has(key)) return;
    skillsBox.open = true;
    selected = key; keys.markSelected();
    const entry = files.get(key);
    const item = itemFor(`instructions:${skillKey(entry.skill.path, entry.composed)}`);
    if (item?.getAttribute('aria-expanded') === 'false') keys.setExpanded(item, true);
    if (shown !== key) { paintFile(key); reader.scrollTop = 0; }
  }
  /** A skill file into the reader, under its repository path (a capability's: its path in the agent's home): its full
   * size, the kernel's cut, and its text through the strict reader; a binary file and a file past the answer's text
   * budget are a line each. A capability's file offers Open capability in the head, when the page can open it. */
  function paintFile(key) {
    const { file, path, capability } = files.get(key);
    shown = key; fileSignature = fileSig(key);
    skillReader.paintHead(path, { bytes: file.bytes, flag: file.truncated ? SKILL_COPY.truncated : null,
      actions: capability ? [openCapabilityButton(capability, 'act soul-file-open')].filter(Boolean) : [] });
    skillReader.paintFile({ path, text: file.text, binary: file.binary }, { missing: SOUL_INSTRUCTIONS_COPY.omitted, binary: SKILL_COPY.binary });
  }
  /** "Open capability" for `id`, or null when the page can't open its page. */
  function openCapabilityButton(id, cls) {
    if (typeof openCapability !== 'function' || !canOpenCapability(id)) return null;
    const button = node('button', cls, SOUL_INSTRUCTIONS_COPY.openCapability); button.type = 'button';
    button.dataset.focusKey = `instructions:open:${id}`; button.setAttribute('aria-description', id);
    button.addEventListener('click', () => { if (alive) openCapability(id); });
    return button;
  }
  /** Each part is rendered on its own, so its heading ids are numbered within the part. The composed document
   * renumbers them in document order with one slugger (`usage`, `usage-1`, `usage-2`: the ids the whole AGENTS.md
   * would give), and a part's own `#fragment` links follow its renamed headings; any other fragment is looked up
   * across the whole document, as written. */
  function uniqueIds(sections) {
    const slugOf = createHeadingSlugger();
    for (const section of sections) {
      const renamed = new Map();
      for (const h of section.querySelectorAll('.soul-part-body h1, .soul-part-body h2, .soul-part-body h3, .soul-part-body h4')) {
        const id = slugOf(h.textContent);
        if (id !== h.id) { renamed.set(h.id, id); h.id = id; }
      }
      if (!renamed.size) continue;
      for (const a of section.querySelectorAll('.soul-part-body a[href^="#"]')) {
        let id; try { id = decodeURIComponent(a.getAttribute('href').slice(1)); } catch { continue; }
        if (renamed.has(id)) a.setAttribute('href', `#${encodeURIComponent(renamed.get(id))}`);
      }
    }
  }
  /** Copies the kernel's exact text (markers included): what a new agent's AGENTS.md would hold. */
  function copyButton(text) {
    const button = node('button', 'act soul-copy', SOUL_INSTRUCTIONS_COPY.copy); button.type = 'button'; button.dataset.focusKey = 'instructions:copy';
    const say = label => {
      button.textContent = label;
      const timer = setTimeout(() => { timers.delete(timer); if (alive) button.textContent = SOUL_INSTRUCTIONS_COPY.copy; }, 1200); timers.add(timer);
    };
    button.addEventListener('click', async () => {
      try { await doc.defaultView.navigator.clipboard.writeText(text); if (alive) say(SOUL_INSTRUCTIONS_COPY.copied); }
      catch { if (alive) say(SOUL_INSTRUCTIONS_COPY.copyFailed); }
    });
    return button;
  }

  const scrollers = () => [...[...docs.values()].flatMap(d => [d.nav, d.reader]), nav, reader];
  return {
    element, update, setTab,
    /** Before the host moves `element` (a page repaint re-appends it): detaching drops focus and every pane's scroll
     * offset, so take them now and put them back once it is in the document again. */
    hold() {
      const active = element.contains(doc.activeElement) ? doc.activeElement : null, tops = scrollers().map(el => el.scrollTop);
      return () => {
        if (!alive || !element.isConnected) return;
        scrollers().forEach((el, i) => { el.scrollTop = tops[i]; });
        if (active?.isConnected && doc.activeElement !== active) active.focus({ preventScroll: true });
      };
    },
    /** The tab shown: OWN or COMPOSED. */
    get tab() { return tab; },
    /** The skill file open in the Skills reader (its key), or null. */
    get selected() { return selected; },
    dispose() { alive = false; for (const timer of timers) clearTimeout(timer); timers.clear(); for (const d of docs.values()) d.fileReader.dispose(); skillReader.dispose(); },
  };
}
let instances = 0; // ids for the tabs, panels and group labels, unique per document
