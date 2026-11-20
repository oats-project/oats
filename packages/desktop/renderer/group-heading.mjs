/** A group heading in the Workspace view's grammar (design board 3; slice 3c drew it as the prototype's small
 * uppercase label): an icon (drawn only for a group that warns), the group's name and a muted qualifier. One helper for the Souls tab's groups (views/spawn.mjs) and the
 * Capabilities tab's repository groups (workspace-catalog.mjs), so a repository reads the same in
 * both. The class names are the Souls tab's, which introduced the grammar. */
import { iconElement } from './shell-icons.mjs';

export const groupHeadingCSS = `
/* The small uppercase label (slice 3c, the prototype's look): the group's name in capitals, tracked and muted, then its
   qualifier and count in ordinary case ("AGENTS · member repo · host · 6 souls"). The icon stays in the markup for a
   group that warns (its "Not available" mark); a plain group's icon is not drawn. */
.souls-group-title { display:flex; align-items:baseline; flex-wrap:wrap; gap:0 4px; margin:0; padding:0 2px; color:var(--muted); font-size:var(--text-label); font-weight:var(--label-weight); line-height:16px; min-width:0; }
.souls-group-title .shell-icon { flex:none; align-self:center; color:var(--muted); }
.souls-group-title:not(.warn) .shell-icon { display:none; }
.souls-group-name { font-weight:var(--label-weight); font-size:var(--text-label); line-height:16px; letter-spacing:var(--label-tracking); text-transform:uppercase; font-family:var(--mono,monospace); overflow-wrap:anywhere; }
.souls-group-name.plain { font-family:inherit; }
.souls-group-title.warn .souls-group-name { color:var(--warn); }
.souls-group-title.warn .shell-icon { color:var(--warn); }
.souls-group-note { color:var(--muted); font-size:var(--text-label); font-weight:400; overflow-wrap:anywhere; }
.souls-group-note:not(:empty)::before { content:"· "; }
`;

/** The heading element: `<h{level}>` with the icon (data-icon names it), the name (`mono: false`
 * for words such as a team label) and the qualifier (always present, possibly empty). */
export function groupHeading(doc, { icon, name, note = '', mono = true, warn = false, level = 2 }) {
  const heading = doc.createElement(`h${level}`); heading.className = `souls-group-title${warn ? ' warn' : ''}`;
  const label = doc.createElement('span'); label.className = 'souls-group-name'; label.textContent = name;
  if (!mono) label.classList.add('plain');
  const mark = iconElement(doc, icon, { size: 15 }); mark.setAttribute('data-icon', icon);
  const qualifier = doc.createElement('span'); qualifier.className = 'souls-group-note'; qualifier.textContent = note;
  heading.append(mark, label, qualifier);
  return heading;
}
