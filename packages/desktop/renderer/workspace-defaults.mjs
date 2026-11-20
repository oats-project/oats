/** Workspace › Capabilities: the workspace's defaults, as the list says them (the Desktop UI rework, slice 3b), and,
 * since slice 2b's Amendment 1 (D), as a Workspace defaults part above the list again (workspace-catalog.mjs
 * workspaceDefaultsPart: Core slots, then Additional, each the list's own row), opened by this sentence.
 *
 * A default is a tag on its own row of the one capability list ("default", or "default · off" for one the workspace
 * turns off: workspace-catalog.mjs), and one sentence above the list says what defaults are and what they are for:
 * the workspace's capabilities every soul starts with, so its agents share one way of working, and a soul may turn
 * one off. Nothing about them is compulsory or automatic. The sentence also names what no row can show: a core slot
 * no default fills, and a declared default the catalog does not list. Read from `oats workspace status --json`
 * `defaults` (packages/client/capability-list.mjs defaultsSummary); with no reported `defaults` there is no sentence
 * and no tag, so nothing is claimed. This replaces the Core / Additional defaults panel (workspace-defaults-show-
 * scope-and-purpose, superseded by Joan's design: "show core and other ones as really the same"). The panel never
 * edited the defaults (they are declared in the workspace file); every default stays reachable as its row, which
 * opens its page. The "About capabilities" dialog the toolbar's "i" opens is about-dialog.mjs. */
import { defaultsSummary } from '../../client/capability-list.mjs';
import { layerLabel } from '../../client/capability-rows.mjs';
import { DESKTOP_NOUNS } from './desktop-terms.mjs';

export const defaultsCSS = `
/* The defaults sentence: one paragraph above the list, at a readable width. */
.cap-lead { margin:0 0 14px; max-width:80ch; color:var(--muted); font-size:13px; line-height:1.55; }
.cap-lead b { color:var(--fg); font-weight:600; }
.cap-lead .cap-lead-name { color:var(--fg); }
`;

const list = v => Array.isArray(v) ? v : [];
const text = v => typeof v === 'string' && v ? v : null;
/** "a, b and c". */
const joined = items => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

export const DEFAULTS_COPY = Object.freeze({
  title: 'Workspace defaults',
  allTitle: 'All capabilities',
  core: 'Core',
  additional: 'Additional',
  noDefault: 'No default',
  unlistedSlot: name => `${name}: the default, but not in this list`,
  noAdditional: 'None: every other capability is a soul\'s own choice.',
  tag: 'default',
  offTag: 'default · off',
  tagTitle: 'A workspace default: every soul starts with it, unless it turns it off',
  offTitle: 'Turned off by the workspace: no soul gets it by default',
  thisWorkspace: 'this workspace',
  // The purpose wording (about-dialog.mjs "Workspace defaults"), in one sentence: shared working, nothing compulsory.
  lead: (ws, agents) => [`Capabilities tagged `, { b: 'default' }, ` are the ones `, { name: ws }, ` gives every soul, so your ${agents} share one way of working. A soul can turn a default off and choose its own instead.`],
  none: (ws) => [{ name: ws }, ` sets no defaults: each soul chooses all of its own capabilities.`],
  emptySlots: slots => ` No default for ${joined(slots.map(slot => layerLabel(slot).toLowerCase()))}.`,
  unlisted: names => ` Also a default, but not in this list: ${joined(names)}.`,
  unlistedOff: names => ` Turned off by the workspace, and not in this list: ${joined(names)}.`,
});

/** The defaults sentence for `status` and the catalog's `rows`, or null when the kernel reports no defaults. */
export function defaultsLead(doc, { status, rows }) {
  const summary = defaultsSummary(status, rows);
  if (!summary) return null;
  const ws = text(status?.workspace?.name) || DEFAULTS_COPY.thisWorkspace;
  const p = doc.createElement('p'); p.className = 'cap-lead'; p.dataset.defaults = summary.empty ? 'none' : 'set';
  // The sentence that opens with the workspace's name opens with a capital when it has none to give.
  const parts = summary.empty ? DEFAULTS_COPY.none(ws === DEFAULTS_COPY.thisWorkspace ? 'This workspace' : ws) : DEFAULTS_COPY.lead(ws, DESKTOP_NOUNS.instances);
  for (const part of parts) {
    if (typeof part === 'string') { p.append(part); continue; }
    const el = doc.createElement(part.b ? 'b' : 'span'); el.textContent = part.b ?? part.name;
    if (part.name !== undefined) el.className = 'cap-lead-name';
    p.append(el);
  }
  // An empty workspace says nothing about slots: every slot is empty.
  if (!summary.empty && summary.emptySlots.length) p.append(DEFAULTS_COPY.emptySlots(summary.emptySlots));
  const on = list(summary.unlisted).filter(d => !d.off).map(d => d.name), off = list(summary.unlisted).filter(d => d.off).map(d => d.name);
  if (on.length) p.append(DEFAULTS_COPY.unlisted(on));
  if (off.length) p.append(DEFAULTS_COPY.unlistedOff(off));
  return p;
}
