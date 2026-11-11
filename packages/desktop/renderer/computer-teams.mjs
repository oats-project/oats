/** The Workspace › Teams page (team model v2, OATS 0.30; spec docs/design/2026-09-27-team-model-v2.md,
 * option B; layout: the v4.1 Teams board). Two sections: the shared teams (the committed workspace,
 * read-only here: edited by PR) and the local ones (this computer's oats-local.yaml), one card per
 * team with its id, who may join it and (when the roster is given) the instances in it; the default
 * team (changeable); add or remove a local team. The document is the kernel's `oats teams --json`
 * result (K1's shapes, docs/desktop-cli-api.md "Team model v2"), read and changed through
 * `request(body)`: {action: 'list'} | {action: 'add', label, team, description?} |
 * {action: 'remove', label} | {action: 'default', label}, each answering the document after the
 * write. A refusal (E_TEAM_IN_USE, E_TEAM_EXISTS, …) is shown verbatim with its code. The page owns
 * its state, so the Teams tab mounts it once and keeps it across re-renders; `onDocument(doc)`
 * hears each document read (the tab's attention dot counts its problems). `readMembers()` answers
 * /api/team-members (packages/desktop/docs/desktop-teams.md): every instance of this workspace view's
 * deployments (#482: this Mac's and other machines') whose identity.team is a team's provider id, read on
 * mount and at each roster poll (`syncRoster`). A card lists its members by deployment, each headed by its
 * machine label; `onMember('open' | 'show', member)` opens one's terminal or selects its roster row
 * (`member.workspace` is its deployment id). Without the route the cards say nothing about them.
 *
 * Team model 3 (teamsApi 2, OATS 0.38; docs/design/2026-10-02-team-model-3.md): which teams a soul may join,
 * and its default, are the workspace's committed souls:, shown read only in their own section. Local teams
 * are this deployment's only where the workspace allows them (localTeams: true, or null in the standalone
 * view): then Add, Make default and Remove work as before. Where they are closed the kernel refuses add and
 * default before writing, so neither is offered; local teams still in oats-local.yaml keep Remove (the
 * kernel accepts it: the last step of committing them in the workspace), and the kernel's local-teams-closed
 * failure leads the page in its own words. The default says where it comes from (this deployment, or the
 * workspace's defaultTeam). Each card says whose default the team is and who else may join it, computed from
 * souls: alone (`teamAudience`; packages/desktop/docs/desktop-teams.md "The Teams board"). */
import { iconElement } from './shell-icons.mjs';
import { createSoulMark } from './identity-marks.mjs';
import { deploymentLabel, shortPath } from '../../client/deployment-label.mjs';
import { DESKTOP_TERMS } from './desktop-terms.mjs';
import { cliHeldBack } from './views/cli-status.mjs';

/** Above the tested bound (#1879) every team write is held back (packages/client/above-tested.mjs): the notice, or null. */
const writesHeld = () => cliHeldBack('POST /api/workspace-teams add');
import { ageText } from './age-text.mjs';
import { captureFocusState } from './loading.mjs';
import { pageBar } from './capability-page.mjs';

/** The Desktop's teams routes (#269, packages/desktop/docs/desktop-teams.md): `{status: 'ok',
 * teams}` (/api/workspace-teams) or `{status: 'ok', soulTeams}` (/api/workspace-soul-teams) answer
 * the decoded kernel document under `key`; `{status: 'refused', reason: {code, message}}` throws
 * the reason verbatim (the kernel's words, or the Desktop's own plain ones), with its code. */
export function teamsAnswer(answer, key, fallback) {
  const doc = answer?.status === 'ok' ? answer[key] : null;
  if (doc && typeof doc === 'object' && !Array.isArray(doc)) return doc;
  const code = typeof answer?.reason?.code === 'string' ? answer.reason.code : null;
  const message = typeof answer?.reason?.message === 'string' && answer.reason.message ? answer.reason.message : fallback;
  throw Object.assign(new Error(message), { code });
}

/* Rule order matters twice: the cascade, and the contrast tests' computed styles (jsdom applies
 * matching rules in source order), so a state rule (.none, .warn) follows its base. Focus is the
 * shell's (rule 2); a field's one frame is its wrapper (rule 3). The type steps are the Teams and Setup
 * redesign's (packages/desktop/docs/desktop-teams.md "The Teams board"): screen title 24/700, section
 * 18/650, card title 17/700, primary facts 14/600, body 13, secondary 12 in --muted, tags 11.5/600;
 * mono (paths, ids, patterns) runs 1px above the sans step it stands in for. */
export const computerTeamsCSS = `
/* The board is one wide column: wider than the tab's 760px list default (the page sits in the tab's body box). */
.workspace-discovery[data-tab=teams] > :has(> .computer-teams) { max-width:1120px; }
.computer-teams { display:flex; flex-direction:column; gap:18px; min-width:0; }
.computer-teams .ct-page-head { display:flex; align-items:flex-end; gap:16px; }
/* Pinned (spec G): 8px inside its edge, the page's 18px gap kept by pulling the next block up by 9px. */
.computer-teams .ct-page-head.ws-sticky { padding-bottom:8px; margin-bottom:-9px; }
.computer-teams .ct-title-wrap { display:flex; flex-direction:column; gap:6px; flex-grow:1; min-width:0; }
.computer-teams .ct-title { margin:0; color:var(--fg); font-size:24px; font-weight:700; line-height:1.2; letter-spacing:-.02em; }
.computer-teams .ct-lead { margin:0; color:var(--muted); font-size:13px; line-height:1.45; }
/* Sections (and any problem above them) stack 40px apart; the first sits 40px under the page head. */
.computer-teams .ct-body { display:flex; flex-direction:column; gap:40px; margin-top:22px; min-width:0; }
.computer-teams .ct-section { display:flex; flex-direction:column; gap:14px; min-width:0; }
.computer-teams .ct-section-head { display:flex; flex-direction:column; gap:2px; min-width:0; }
.computer-teams .ct-section-title { margin:0; color:var(--fg); font-size:18px; font-weight:650; line-height:1.25; letter-spacing:-.01em; }
.computer-teams .ct-section-lead { margin:0; color:var(--muted); font-size:13px; line-height:1.45; overflow-wrap:anywhere; }
/* A team's card: one column (header, facts, notes, foot). A local team's frame is dashed. */
.computer-teams .ct-card { display:flex; flex-direction:column; min-width:0; background:var(--surface); border:1px solid var(--border); border-radius:10px; }
.computer-teams .ct-card.local { border:1px dashed var(--tree-line); }
/* The board's card opens its team's page: the label's button stretches over the card (::after); the card's
   own controls sit above it. The ring is the shell's focus ring on that button. */
.computer-teams .ct-card.ct-openable { position:relative; cursor:pointer; }
.computer-teams .ct-card.ct-openable:hover { border-color:var(--tree-line); }
.computer-teams .ct-card.ct-openable :is(.ct-actions, .ct-confirm, .ct-error, a[href]) { position:relative; z-index:1; }
/* So do its problem boxes: their text (a fix to copy) is selected, not a click that opens the team. */
.computer-teams .ct-card.ct-openable > :is(.ct-blocking, .ct-warn) { position:relative; z-index:1; cursor:auto; }
.computer-teams .ct-head { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 20px; align-items:start; padding:16px 20px 0; min-width:0; }
.computer-teams .ct-id { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 10px; min-width:0; }
.computer-teams .ct-name-h { margin:0; min-width:0; font:inherit; }
.computer-teams .ct-label { color:var(--fg); font-size:17px; font-weight:700; line-height:1.3; letter-spacing:-.01em; overflow-wrap:anywhere; }
.oats-view .computer-teams button.ct-open { appearance:none; display:inline; height:auto; min-height:0; margin:0; padding:0; border:0; border-radius:4px; background:none; color:var(--fg); font-weight:700; font-size:17px; line-height:1.3; font-family:var(--ui-font,system-ui); letter-spacing:-.01em; text-align:left; overflow-wrap:anywhere; cursor:pointer; }
.oats-view .computer-teams button.ct-open::after { content:''; position:absolute; inset:0; border-radius:10px; }
.computer-teams .ct-card.ct-openable:hover .ct-open { text-decoration:underline; text-underline-offset:3px; }
.computer-teams .ct-page-card .ct-head { padding-top:20px; }
.computer-teams .ct-page-card .ct-id { align-items:center; }
.computer-teams .ct-page-label { margin:0; color:var(--fg); font-size:24px; font-weight:700; line-height:1.2; letter-spacing:-.02em; overflow-wrap:anywhere; }
.computer-teams .ct-tag { align-self:center; display:inline-flex; align-items:center; height:20px; padding:0 7px; border-radius:5px; background:var(--sel); color:var(--accent); font-weight:600; font-size:11.5px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; }
.computer-teams .ct-from { color:var(--muted); font-size:12px; }
/* On a team's page, in a view of two or more deployments: which deployment's configuration its actions edit. */
.computer-teams .ct-desc { grid-column:1; margin:0; color:var(--muted); font-size:13px; line-height:1.45; overflow-wrap:anywhere; }
.computer-teams .ct-head > .ct-actions { grid-column:2; grid-row:1; align-self:center; }
/* The facts: labelled rows (dt muted, dd body); the May join row and an empty value are muted; names bold. */
.computer-teams .ct-facts { display:grid; grid-template-columns:92px minmax(0,1fr); align-items:baseline; gap:4px 12px; margin:0; padding:12px 20px 16px; min-width:0; font-size:13px; line-height:1.45; }
.computer-teams .ct-fact { display:contents; }
.computer-teams .ct-fact dt { color:var(--muted); font-size:12px; }
.computer-teams .ct-fact dd { margin:0; min-width:0; color:var(--fg); overflow-wrap:anywhere; }
.computer-teams .ct-fact[data-fact=join] dd, .computer-teams .ct-fact dd.none, .computer-teams .ct-quiet { color:var(--muted); }
.computer-teams .ct-name { font-weight:650; }
.computer-teams .ct-join { color:var(--fg); font-weight:650; }
.computer-teams .ct-join.none { color:var(--muted); font-weight:400; }
.computer-teams .ct-fact dd.ct-address { color:var(--muted); font-weight:normal; font-size:13.5px; line-height:1.45; font-family:var(--mono,monospace); }
.computer-teams .ct-fact dd.ct-address.none { color:var(--warn); font-weight:normal; font-size:13px; line-height:1.45; font-family:var(--ui-font,system-ui); }
/* A problem that blocks spawning: under the header, the 2px danger edge. */
.computer-teams .ct-blocking { display:flex; flex-direction:column; gap:2px; padding-left:10px; border-left:2px solid var(--danger); color:var(--muted); font-size:13px; line-height:1.45; overflow-wrap:anywhere; }
.computer-teams .ct-card > .ct-blocking { margin:12px 20px 0; }
.computer-teams .ct-blocking strong { color:var(--fg); font-size:14px; font-weight:650; }
/* The team's warnings: after the facts, in the attention tint; the message bold, the fix on its own line. */
.computer-teams .ct-warn { display:flex; flex-direction:column; gap:2px; padding:8px 12px; border-radius:7px; background:var(--attn-bg); color:var(--fg); font-size:13px; line-height:1.45; overflow-wrap:anywhere; }
.computer-teams .ct-card > .ct-warn { margin:0 20px 14px; }
.computer-teams .ct-warn-msg { font-weight:650; }
.computer-teams .ct-fix { display:block; color:var(--fg); font-size:12.5px; font-weight:400; overflow-wrap:anywhere; }
.computer-teams .ct-why { color:var(--muted); font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
.computer-teams .ct-card > .ct-why { margin:0 20px 14px; }
.computer-teams .ct-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
.oats-view .computer-teams button.ct-act { height:28px; min-height:28px; padding:0 11px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); font-weight:600; font-size:12px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; cursor:pointer; }
.oats-view .computer-teams button.ct-act:hover:not(:disabled) { background:var(--surface-2); }
.oats-view .computer-teams button.ct-act:disabled { color:var(--muted); cursor:default; }
.oats-view .computer-teams button.ct-act.primary:not(:disabled) { background:var(--primary-bg); border-color:var(--primary-bg); color:var(--primary-fg); }
/* Where this deployment may not declare its own teams the head's Add is hidden: [hidden] wins over display. */
.oats-view .computer-teams button.ct-add[hidden] { display:none; }
.oats-view .computer-teams button.ct-add { display:inline-flex; align-items:center; gap:6px; flex:none; height:32px; min-height:32px; padding:0 12px; border-radius:7px; font-size:12.5px; }
.oats-view .computer-teams button.ct-link { height:auto; min-height:0; padding:0 4px; border:0; border-radius:4px; background:none; color:var(--accent); font-size:13px; }
.oats-view .computer-teams button.ct-link:hover:not(:disabled) { background:none; color:var(--fg); }
.computer-teams .ct-card > :is(.ct-confirm, .ct-error) { margin:0 20px 16px; }
.computer-teams .ct-confirm { display:flex; flex-direction:column; gap:8px; padding:10px 12px; border:1px solid var(--border); border-radius:7px; background:var(--surface-2); }
.computer-teams .ct-confirm p { margin:0; color:var(--fg); font-size:13px; line-height:1.45; }
.computer-teams .ct-confirm .ct-actions { justify-content:flex-start; }
.computer-teams .ct-error { border-left:2px solid var(--danger); padding-left:10px; color:var(--fg); font-size:13px; line-height:1.45; }
.computer-teams .ct-error p { margin:0; overflow-wrap:anywhere; }
.computer-teams .ct-error summary { color:var(--muted); font-size:12px; cursor:pointer; }
.computer-teams .ct-error pre { margin:4px 0 0; color:var(--fg); font-weight:normal; font-size:13px; line-height:normal; font-family:var(--mono,monospace); white-space:pre-wrap; overflow-wrap:anywhere; }
/* The board card's foot: how many of your instances are on it, and the cue that the card opens. */
.computer-teams .ct-foot { display:flex; align-items:center; gap:12px; padding:11px 20px; border-top:1px solid var(--border); min-width:0; }
.computer-teams .ct-sum { flex:1; min-width:0; color:var(--muted); font-size:13px; line-height:1.45; overflow-wrap:anywhere; }
.computer-teams .ct-sum-count { color:var(--fg); font-size:14px; font-weight:650; font-variant-numeric:tabular-nums; }
.computer-teams .ct-sum-warn { color:var(--warn); font-weight:600; }
.computer-teams .ct-go { display:inline-flex; align-items:center; gap:2px; flex:none; margin-left:auto; color:var(--muted); font-size:12.5px; font-weight:600; white-space:nowrap; }
.computer-teams .ct-card.ct-openable:hover .ct-go { color:var(--accent); }
/* Page problems no card holds: a blocking one in a card of its own; a warning is its own tinted box. */
.computer-teams .ct-problem { padding:12px 18px; background:var(--surface); border:1px solid var(--border); border-radius:10px; }
.computer-teams .ct-problem:has(> .ct-warn) { padding:0; background:none; border:0; }
.computer-teams .ct-empty { display:flex; align-items:center; gap:14px; padding:16px 18px; border:1px dashed var(--tree-line); border-radius:10px; color:var(--muted); font-size:13px; line-height:1.45; }
.computer-teams .ct-empty > span { flex-grow:1; overflow-wrap:anywhere; }
/* A sentence in place of a list (local teams closed; a team page with nothing to list): not a card. */
.computer-teams .ct-dashed { margin:0; padding:12px 16px; border:1px dashed var(--tree-line); border-radius:10px; color:var(--muted); font-size:13px; line-height:1.45; overflow-wrap:anywhere; }
.computer-teams .ct-form { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1.4fr); gap:10px; padding:16px 20px; background:var(--surface); border:1px solid var(--border); border-radius:10px; }
.computer-teams .ct-form label { display:flex; flex-direction:column; gap:3px; min-width:0; color:var(--muted); font-size:12px; }
.computer-teams .ct-form label.wide { grid-column:1 / -1; }
/* Rule 3: the field's one frame is the wrapper's; the input inside has none, in every state. */
.computer-teams .ct-field { display:flex; align-items:center; height:28px; min-width:0; border:1px solid var(--border); border-radius:6px; background:var(--surface); }
.computer-teams .ct-field:focus-within { border-color:var(--accent); }
.oats-view .computer-teams .ct-field input { flex:1 1 auto; min-width:0; height:100%; padding:0 8px; box-sizing:border-box; border:0; outline:none; box-shadow:none; background:transparent; color:var(--fg); font-weight:normal; font-size:13px; line-height:normal; font-family:var(--mono,monospace); }
.oats-view .computer-teams .ct-field input:focus, .oats-view .computer-teams .ct-field input:focus-visible { border:0; outline:none; box-shadow:none; }
.computer-teams .ct-form .ct-actions { grid-column:1 / -1; justify-content:flex-start; }
.computer-teams .ct-hint { grid-column:1 / -1; margin:0; color:var(--muted); font-size:12px; line-height:1.45; }
.computer-teams .ct-hint code { color:var(--fg); font-weight:normal; font-size:13px; line-height:normal; font-family:var(--mono,monospace); }
.computer-teams .ct-status { margin:0; color:var(--muted); font-size:12px; }
.computer-teams .ct-status:empty { display:none; }
.computer-teams .ct-reach { margin:0; color:var(--muted); font-size:13px; line-height:1.45; overflow-wrap:anywhere; }
.computer-teams .ct-reach:empty { display:none; }
/* Team model 3's souls: a table in a card: the pattern (its folder muted), its default, the other teams it may join. */
.computer-teams .ct-souls-card { background:var(--surface); border:1px solid var(--border); border-radius:10px; min-width:0; }
.computer-teams .ct-souls { width:100%; border-collapse:collapse; table-layout:fixed; }
.computer-teams .ct-souls col.pattern, .computer-teams .ct-souls col.others { width:38%; }
.computer-teams .ct-souls th { padding:11px 20px 7px 0; color:var(--muted); font-size:12px; font-weight:600; text-align:left; }
.computer-teams .ct-souls td { padding:9px 20px 9px 0; border-top:1px solid var(--border); color:var(--fg); font-size:13px; line-height:1.45; vertical-align:middle; overflow-wrap:anywhere; }
.computer-teams .ct-souls :is(th, td):first-child { padding-left:20px; }
.computer-teams .ct-pattern { color:var(--fg); font-weight:600; font-size:14.5px; line-height:1.4; font-family:var(--mono,monospace); overflow-wrap:anywhere; }
.computer-teams .ct-pattern-dir { color:var(--muted); font-weight:400; }
.computer-teams .ct-every, .computer-teams .ct-souls .ct-none { color:var(--muted); }
.computer-teams .ct-chip { display:inline-flex; align-items:center; height:20px; margin:2px 4px 2px 0; padding:0 7px; border-radius:5px; background:var(--tag-bg); color:var(--fg); font-weight:600; font-size:11.5px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; }
/* A team's page: the board's column, the team's card, then your instances on it. */
.computer-teams.ct-team-page { gap:40px; max-width:1120px; margin:0 auto; padding:20px 24px 28px; }
/* Your instances on it: the counts first, then one card per machine, each a table of its instances. */
.computer-teams .ct-yours-sum { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 22px; margin:0; color:var(--muted); font-size:13px; line-height:1.45; }
.computer-teams .ct-yours-sum b { margin-right:4px; color:var(--fg); font-size:20px; font-weight:700; letter-spacing:-.01em; font-variant-numeric:tabular-nums; }
.computer-teams .ct-yours-sum .warn, .computer-teams .ct-yours-sum .warn b { color:var(--warn); }
.computer-teams .ct-yours-machines { margin-left:auto; }
.computer-teams .ct-default-note { margin:-4px 0 0; color:var(--muted); font-size:12.5px; line-height:1.45; }
/* The machines' cards share one grid: each card, its table and its rows are subgrids of it, so every name on the page
   sizes the same columns and they line up from card to card. --ct-name-room is the most a name may take: the page's
   width (100cqi of .workspace-page, at most the column's 1120px) less everything else on its row: the column's padding
   (48px), the card's borders (2), the row's padding (32), the mark and its gap (34), the name cell's padding (16), 4px
   to spare, and the other columns at their least (Soul gives way to 0). */
.computer-teams .ct-mcards { display:grid; grid-template-columns:1fr minmax(0,.4fr) 200px 84px 104px; row-gap:14px; min-width:0;
  --ct-name-room:calc(min(100cqi, 1120px) - 136px - 388px); }
.computer-teams .ct-mcard { grid-column:1 / -1; display:grid; grid-template-columns:subgrid; position:relative; overflow:hidden; min-width:0; background:var(--surface); border:1px solid var(--border); border-radius:10px; }
.computer-teams .ct-mcard-head { grid-column:1 / -1; display:flex; align-items:center; gap:9px; min-width:0; margin:0; padding:11px 16px; background:var(--surface-2); border-bottom:1px solid var(--border); color:var(--muted); font-size:12.5px; font-weight:400; line-height:1.45; }
.computer-teams .ct-mcard-head .shell-icon { flex:none; color:var(--muted); }
.computer-teams .ct-machine { flex:none; color:var(--fg); font-size:15px; font-weight:700; white-space:nowrap; }
.computer-teams .ct-path { min-width:0; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:normal; font-size:13px; line-height:normal; font-family:var(--mono,monospace); }
.computer-teams .ct-mcard-count { flex:none; color:var(--muted); margin-left:auto; white-space:nowrap; font-variant-numeric:tabular-nums; }
.computer-teams .ct-mcard.unreached :is(.ct-machine, .ct-mcard-count, .shell-icon) { color:var(--warn); }
/* Names come first: from a 760px container the Instance cell is as wide as its name, so the name is whole whenever
   the row has room for it (--ct-name-room); the Soul column gives way, and Created, then Soul, hide as it narrows. */
.computer-teams .ct-ilist { grid-column:1 / -1; display:grid; grid-template-columns:subgrid; min-width:0; }
.computer-teams .ct-irow { grid-column:1 / -1; display:grid; grid-template-columns:subgrid; align-items:center; min-height:46px; padding:0 16px; border-top:1px solid var(--border); }
.computer-teams .ct-irow > * { min-width:0; }
.computer-teams .ct-irow.ct-ihead { min-height:34px; border-top:0; color:var(--muted); font-size:12px; font-weight:600; }
.computer-teams .ct-irow:not(.ct-ihead):hover { background:var(--surface-2); }
.computer-teams .ct-vh { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
.computer-teams .ct-irow > .ct-iname { display:flex; align-items:center; gap:10px; min-width:max-content; padding-right:16px; }
.computer-teams .ct-iname .identity-mark { width:24px; height:24px; border-radius:7px; font-size:10.5px; font-weight:700; flex:none; }
/* The name shows the row: one line, cut with an ellipsis only past the row's room (the full name is its title); the
   soul's prefix steps back. */
.oats-view .computer-teams button.ct-member-name { appearance:none; display:block; height:auto; min-height:0; min-width:0; margin:0; padding:0; border:0; background:none; color:var(--fg); font-weight:650; font-size:14px; line-height:1.3; font-family:var(--ui-font,system-ui); text-align:left; max-width:var(--ct-name-room); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
.computer-teams .ct-name-pre { color:var(--muted); font-weight:500; }
.computer-teams .ct-name-tail { color:var(--fg); font-weight:650; }
.oats-view .computer-teams button.ct-member-name:hover .ct-name-tail { text-decoration:underline; text-underline-offset:3px; }
.computer-teams .ct-isoul { padding-right:12px; color:var(--muted); font-size:12.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
/* The state pill: the word carries the state (its dot is decoration). */
.computer-teams .ct-member-state { display:inline-flex; align-items:center; gap:7px; max-width:100%; height:24px; box-sizing:border-box; padding:0 9px 0 8px; border-radius:12px; color:var(--muted); font-size:12.5px; font-weight:500; white-space:nowrap; overflow:hidden; }
.computer-teams .ct-state-word { overflow:hidden; text-overflow:ellipsis; }
.computer-teams .ct-state-dot { flex:none; width:7px; height:7px; box-sizing:border-box; border-radius:50%; border:1.5px solid var(--faint); }
.computer-teams .ct-member-state.run { background:var(--sel); color:var(--fg); font-weight:600; }
.computer-teams .ct-member-state.run .ct-state-dot { border:0; background:var(--live); }
.computer-teams .ct-member-state.stop { padding-left:0; }
.computer-teams .ct-member-state.warn { background:var(--attn-bg); color:var(--warn); font-weight:600; }
/* A member whose state is not running or stopped (unknown, gone, not reached): the roster's muted bullseye, never
   yellow (yellow means needs input only); the pill's words in --warn say which. */
.computer-teams .ct-member-state.warn .ct-state-dot { border-color:var(--muted); background:radial-gradient(circle, var(--muted) 1px, transparent 1px); }
.computer-teams .ct-age { color:var(--muted); font-size:12.5px; white-space:nowrap; font-variant-numeric:tabular-nums; }
.computer-teams .ct-iact { justify-self:end; }
.oats-view .computer-teams button.ct-member-term { display:inline-flex; align-items:center; gap:6px; height:28px; min-height:28px; padding:0 10px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); font-weight:600; font-size:12px; line-height:normal; font-family:var(--ui-font,system-ui); white-space:nowrap; cursor:pointer; }
.oats-view .computer-teams button.ct-member-term:hover { border-color:var(--accent); color:var(--accent); }
@container (max-width: 999.98px) {
 .computer-teams .ct-mcards { grid-template-columns:1fr minmax(0,.4fr) 200px 104px; --ct-name-room:calc(min(100cqi, 1120px) - 136px - 304px); }
 .computer-teams .ct-ilist .ct-age, .computer-teams .ct-ihead > :nth-child(4) { display:none; }
}
/* Below 900px State may shrink: the name's room leaves it 96px beside Terminal's 104 (200), enough for "Running". */
@container (max-width: 899.98px) {
 .computer-teams .ct-mcards { grid-template-columns:1fr minmax(0,200px) 104px; --ct-name-room:calc(min(100cqi, 1120px) - 136px - 200px); }
 .computer-teams .ct-ilist .ct-isoul, .computer-teams .ct-ihead > :nth-child(2) { display:none; }
}
/* A narrow container: the actions wrap under the description; the souls table stacks; an instance's table keeps
   Instance, State and Terminal, and a name too long for it is cut, whole in its title. */
@container (max-width: 759.98px) {
 .computer-teams .ct-head { grid-template-columns:minmax(0,1fr); }
 .computer-teams .ct-head > .ct-actions { grid-column:1; grid-row:auto; justify-content:flex-start; }
 .computer-teams .ct-souls thead { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
 .computer-teams .ct-souls, .computer-teams .ct-souls tbody { display:block; }
 .computer-teams .ct-souls colgroup { display:none; }
 .computer-teams .ct-souls tr { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); border-top:1px solid var(--border); }
 .computer-teams .ct-souls tbody tr:first-child { border-top:0; }
 .computer-teams .ct-souls td { border-top:0; }
 .computer-teams .ct-souls td:first-child { grid-column:1 / -1; padding-bottom:0; }
 .computer-teams .ct-souls td:nth-child(2) { padding-left:20px; }
 .computer-teams .ct-yours-machines { margin-left:0; }
 .computer-teams .ct-mcards { grid-template-columns:minmax(0,1fr) minmax(0,max-content) 104px; column-gap:12px; --ct-name-room:none; }
 .computer-teams .ct-irow > .ct-iname { min-width:0; }
}
`;

const text = v => typeof v === 'string' && v ? v : null;
const list = v => Array.isArray(v) ? v : [];
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);
/** The kernel's own clause for a workspace that closes local teams (lib/teams.mjs), and where a soul's teams
 * are changed in team model 3 (its removed-flag replacement): said in its words, never a second version. */
export const LOCAL_TEAMS_CLOSED = 'oats-workspace.yaml does not allow local teams (localTeams: true)';
export const SOULS_WHERE = 'souls: in oats-workspace.yaml (a PR to the workspace file)';
/** Team model 3's document (teamsApi 2). */
const model3 = d => d?.teamsApi === 2;
/** May this deployment declare its own teams? Always before team model 3; then where the workspace says so,
 * or in the standalone view (localTeams null). */
const localAllowed = d => !model3(d) || d.localTeams !== false;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
function el(doc, tag, value, cls) {
  const node = doc.createElement(tag);
  if (value !== undefined && value !== null) node.textContent = value;
  if (cls) node.className = cls;
  return node;
}

/** Team model 3: how many souls: entries name a label (in teams, as its default, or `any` for a shared team).
 * "*" counts as one entry like the others: the most specific entry gives a soul's teams outright, so "*" is a
 * fallback, never a promise about every soul. */
function patternsOf(document, label) {
  const shared = list(document?.teams).some(t => t.label === label && t.from === 'shared');
  const names = rule => rule.default === label || (rule.teams === 'any' ? shared : list(rule.teams).includes(label));
  return record(document?.souls) ? Object.values(document.souls).filter(rule => record(rule) && names(rule)).length : 0;
}
/** The souls a label is declared for, as the document says: every soul (souls.teams['*']), or the
 * soul keys naming it in souls.teams and souls.default (the same soul counted once). */
function soulsOf(document, label) {
  const teams = document?.souls?.teams && typeof document.souls.teams === 'object' ? document.souls.teams : {};
  const defaults = document?.souls?.default && typeof document.souls.default === 'object' ? document.souls.default : {};
  const every = list(teams['*']).includes(label);
  const souls = new Set([...Object.entries(teams).filter(([key, labels]) => key !== '*' && list(labels).includes(label)).map(([key]) => key),
    ...Object.entries(defaults).filter(([, value]) => value === label).map(([key]) => key)]);
  return { every, souls };
}

/** What still references a label in the document (defaultTeam, souls.teams, souls.default):
 * the reason Remove is off, in words. The kernel's own refusal (E_TEAM_IN_USE) stays the authority. */
export function teamInUse(document, label) {
  const reasons = [];
  // Team model 3: only this deployment's own default (oats-local.yaml defaultTeam) keeps a local team;
  // souls: name shared labels only.
  if (model3(document)) return document.defaultTeam?.from === 'deployment' && document.defaultTeam.label === label
    ? "Can't remove: it is the default team. Change that first." : null;
  if (document?.defaultTeam === label) reasons.push('it is the default team');
  const { every, souls } = soulsOf(document, label);
  if (every) reasons.push('every soul may join it');
  if (souls.size) reasons.push(`${plural(souls.size, 'soul')} use${souls.size === 1 ? 's' : ''} it`);
  return reasons.length ? `Can't remove: ${reasons.join('; ')}. Change that first.` : null;
}

/** A souls: key's place in the pattern order: "*" (level 0), `<repo-or-package>/*` (1), `<repo-or-package>/<soul>`
 * (2), split as the kernel does (lib/teams.mjs patternsOf: the last "/"); anything else is ignored. */
function soulKey(key) {
  if (key === '*') return { key, level: 0, repo: null, soul: null };
  const at = key.lastIndexOf('/');
  if (at <= 0 || at === key.length - 1) return null;
  const repo = key.slice(0, at), soul = key.slice(at + 1);
  return soul === '*' ? { key, level: 1, repo, soul: null } : { key, level: 2, repo, soul };
}
const AUDIENCE_ORDER = ['every', 'fallback', 'local', 'repo', 'soul'];
const byAudience = (a, b) => AUDIENCE_ORDER.indexOf(a.kind) - AUDIENCE_ORDER.indexOf(b.kind)
  || codePoint(a.repo ?? '', b.repo ?? '') || codePoint(a.soul ?? '', b.soul ?? '');
const audienceEntry = ({ key, level, repo, soul }) => level === 0 ? { kind: 'every', key } : level === 1 ? { kind: 'repo', key, repo } : { kind: 'soul', key, repo, soul };

/** Team model 3 (teamsApi 2): whose default a team is, and who else may join it, from the committed souls: map
 * alone (docs/design/2026-10-02-team-model-3.md: a soul's teams come from its most specific key, its default
 * from the most specific key that sets one; `any` is every shared team). → `{ defaultFor, mayJoin }`, each a
 * list of `{ kind: 'every' | 'fallback' | 'local' | 'repo' | 'soul', key?, repo?, soul?, except? }`:
 *   - defaultFor: each key whose default is the label (`"*"` every soul, `<p>/*` all souls of p, `<p>/<s>` soul s
 *     of p), less the keys a broader one already implies (the nearest broader key that sets a default gives the
 *     same); `except` names the more specific keys under it that set another default. Plus `fallback` when the
 *     label is the document's defaultTeam (every soul without a souls: default; `from` says whose, `nobody`
 *     when "*" sets a default and so no soul falls back);
 *   - mayJoin: each key whose teams include the label (or `any`, for a shared team) and whose souls do not
 *     already have it as their default, less the keys their nearest broader key already covers; `except` names
 *     the more specific keys under it whose souls are not in that audience (they may not join, or it is their
 *     default and so said under defaultFor). A local team where local teams are allowed:
 *     `local` (every soul).
 * Each list: every/fallback/local first, then repos, then souls, by code point. Null before team model 3. */
export function teamAudience(document, label) {
  if (!model3(document)) return null;
  const rules = new Map();
  for (const [key, rule] of record(document.souls) ? Object.entries(document.souls) : []) {
    const at = soulKey(key);
    if (at && record(rule)) rules.set(key, { ...at, rule });
  }
  const shared = list(document.teams).some(t => t.label === label && t.from === 'shared');
  /** The broader keys that exist, nearest first (the kernel's pattern order). */
  const broader = k => (k.level === 2 ? [`${k.repo}/*`, '*'] : k.level === 1 ? ['*'] : []).map(key => rules.get(key)).filter(Boolean);
  const under = (k, top) => top.level === 0 ? k.level > 0 : top.level === 1 && k.level === 2 && k.repo === top.repo;
  const setsDefault = k => !!text(k.rule.default);
  const ownDefault = k => [k, ...broader(k)].find(setsDefault)?.rule.default ?? null;
  const lists = k => k.rule.teams === 'any' ? shared : list(k.rule.teams).includes(label);
  const sorted = entries => entries.sort(byAudience);
  /** The keys under `top` that `out` (their souls are not in its audience) and whose nearest broader key
   * (`nearest`) is `top`, or a key under it whose souls are (`inside`). */
  const exceptions = (top, out, nearest, inside) => sorted([...rules.values()].filter(d => {
    if (!under(d, top) || !out(d)) return false;
    const n = nearest(d);
    return n === top || (!!n && under(n, top) && inside(n));
  }).map(audienceEntry));

  // Default for: implied when the nearest broader key that sets a default gives the same one.
  const defaultFor = [];
  for (const k of rules.values()) {
    if (k.rule.default !== label) continue;
    const above = broader(k).find(setsDefault);
    if (above?.rule.default === label) continue;
    const except = exceptions(k, d => setsDefault(d) && d.rule.default !== label, d => broader(d).find(setsDefault), n => n.rule.default === label);
    defaultFor.push({ ...audienceEntry(k), ...(except.length ? { except } : {}) });
  }
  if (document.defaultTeam?.label === label) {
    const star = rules.get('*');
    defaultFor.push({ kind: 'fallback', from: document.defaultTeam.from === 'deployment' ? 'deployment' : 'workspace', ...(star && setsDefault(star) ? { nobody: true } : {}) });
  }

  // May join: the keys that list it for souls it is not already the default of; one is implied when its nearest
  // broader key (the one its souls would fall to) is itself shown. Under a shown pattern, the keys whose souls are
  // outside it (they may not join, or it is already their default) are its exceptions.
  const shown = k => lists(k) && ownDefault(k) !== label;
  const mayJoin = [];
  for (const k of rules.values()) {
    if (!shown(k)) continue;
    const above = broader(k)[0];
    if (above && shown(above)) continue;
    const except = exceptions(k, d => !shown(d), d => broader(d)[0], shown);
    mayJoin.push({ ...audienceEntry(k), ...(except.length ? { except } : {}) });
  }
  if (list(document.teams).some(t => t.label === label && t.from === 'local') && localAllowed(document)) mayJoin.push({ kind: 'local' });
  return { defaultFor: sorted(defaultFor), mayJoin: sorted(mayJoin) };
}

/** A card's "Who may join" value: 'every soul', 'N souls', or null when no soul is declared for it yet. */
export function whoMayJoin(document, label) {
  if (model3(document)) {
    // A local team where local teams are allowed: every soul may join it (via local).
    if (list(document.teams).some(t => t.label === label && t.from === 'local') && localAllowed(document)) return 'every soul';
    const entries = patternsOf(document, label);
    const fallback = document.defaultTeam?.label === label ? 'souls without their own default' : null;
    return [fallback, entries ? `${entries} ${entries === 1 ? 'entry' : 'entries'} in souls:` : null].filter(Boolean).join(' · ') || null;
  }
  const { every, souls } = soulsOf(document, label);
  return every ? 'every soul' : souls.size ? plural(souls.size, 'soul') : null;
}

const codePoint = (a, b) => a < b ? -1 : a > b ? 1 : 0;
/** A member's state in words (never colour alone): running, stopped, unknown, or gone from its server. */
export const memberState = m => m.missingRemotely ? 'gone' : m.running === true ? 'running' : m.running === false ? 'stopped' : 'unknown';
/** The state word on a member row: running when it can be opened; else the roster's short reason
 * ("gone from X", "not reachable on X", "X not reached"), else stopped or unknown. */
export function stateWord(m) {
  if (m.running === true && m.addressable === true) return 'running';
  return text(m.reasonLabel) && m.reasonLabel !== 'state unknown' ? m.reasonLabel : memberState(m);
}
/** Why a member's terminal can't be opened: the roster's own reason (the route sends it), or, for a
 * stopped member the roster has no reason for, that it is not running. Null when it can be opened. */
export function openBlocked(m) {
  if (m.running === true && m.addressable === true) return null;
  return text(m.reason) ?? `${m.instance} is not running.`;
}
/** A member's deployment (#482: `{id, machine, path}`, its `workspace` is that id), or null from an older route. */
const memberDeployment = m => m.deployment && typeof m.deployment === 'object' && text(m.deployment.id) ? m.deployment : null;
/** Members by deployment (#482), each headed by its machine label ("This Mac · ~/acme", "altair ·
 * ~/acme"): this computer's first, then the other machines by label (code points), the server id, then the
 * deployment id breaking ties; within one, by instance name, then home. An answer without deployments (an older
 * route) groups by machine: "This computer", then each server. A group is not reached when every roster group its
 * members come from failed its last read; when only some did (an edited registration keeps its old group), the
 * heading stays reached and those members' own state ("unknown") and reason carry it. Each group also names its
 * `machine` and its deployment's full `path` (null from an older route), which the team page heads it with. */
export function memberGroups(members, servers = []) {
  const byGroup = new Map(list(servers).map(s => [`remote:${s.group}`, s]));
  for (const s of list(servers)) if (text(s.deployment)) byGroup.set(s.deployment, s);
  const groups = new Map();
  for (const m of members) {
    const deployment = memberDeployment(m), key = deployment ? `deployment:${deployment.id}` : m.server ?? '';
    const server = m.server ? text(m.serverLabel) ?? m.server : null;
    const machine = deployment ? text(deployment.machine) ?? server ?? DESKTOP_TERMS.thisMachine : server ?? 'This computer';
    const label = deployment ? deploymentLabel({ machine, label: shortPath(deployment.path) }, DESKTOP_TERMS) : machine;
    if (!groups.has(key)) groups.set(key, { key, server: m.server ?? null, deployment: deployment?.id ?? null, label, machine, path: text(deployment?.path),
      reached: true, error: null, members: [], sources: new Map() });
    const group = groups.get(key), source = m.server ? byGroup.get(m.workspace) : null;
    if (source) group.sources.set(source.group, source);
    group.members.push(m);
  }
  for (const group of groups.values()) {
    const sources = [...group.sources.values()];
    if (sources.length && sources.every(s => !s.reached)) { group.reached = false; group.error = text(sources[0].error); }
    delete group.sources;
  }
  for (const group of groups.values()) group.members.sort((a, b) => codePoint(a.instance, b.instance) || codePoint(a.home, b.home));
  return [...groups.values()].sort((a, b) => (a.server === null) !== (b.server === null) ? (a.server === null ? -1 : 1)
    : codePoint(a.label, b.label) || codePoint(a.server ?? '', b.server ?? '') || codePoint(a.deployment ?? '', b.deployment ?? ''));
}
/** The board card's summary of a team's members, in parts (`kind`: count, more, warn): "N of your instances", ", M on
 * other machines" when some run elsewhere, ", <machine>[, <machine>] not reached" for its groups not reached (each
 * machine once); "None of your instances" for none. */
export function memberSummaryParts(members, servers = []) {
  if (!members.length) return [{ kind: 'more', text: 'None of your instances' }];
  const elsewhere = members.filter(m => m.server).length;
  const unreached = [...new Set(memberGroups(members, servers).filter(g => !g.reached).map(g => g.machine))];
  return [{ kind: 'count', text: `${members.length} of your instances` },
    ...(elsewhere ? [{ kind: 'more', text: `, ${elsewhere} on other machines` }] : []),
    ...(unreached.length ? [{ kind: 'warn', text: `, ${unreached.join(', ')} not reached` }] : [])];
}
/** The same summary as one string. */
export function memberSummary(members, servers = []) {
  return memberSummaryParts(members, servers).map(part => part.text).join('');
}
/** The member's state on its row: `run` (running and it can be opened), `stop` (plainly stopped) or `warn` (anything
 * else: its word is the roster's reason label, or unknown, gone). The team page counts its rows by it. */
export function stateKind(m) {
  if (m.running === true && m.addressable === true) return 'run';
  return stateWord(m) === 'stopped' ? 'stop' : 'warn';
}
/** A soul's short name, as its mark's (identity-marks.mjs, step 1): after the last "/" or "--". */
export function soulShort(name) {
  const value = text(name) ?? '', slash = value.lastIndexOf('/'), dashes = value.lastIndexOf('--');
  return value.slice(Math.max(slash < 0 ? 0 : slash + 1, dashes < 0 ? 0 : dashes + 2));
}
/** The route's answer, kept only as far as it validates (every string still enters the DOM by assignment). */
function membersAnswer(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.members)) return null;
  // A member's deployment (#482), when sent, is `{id, machine, path}` of strings and its id is the member's `workspace`.
  const members = v.members.filter(m => m && typeof m === 'object' && text(m.instance) && text(m.home) && text(m.team) && text(m.workspace)
    && (m.server === null || text(m.server))
    && (m.deployment === undefined || m.deployment && typeof m.deployment === 'object' && m.deployment.id === m.workspace
      && typeof m.deployment.machine === 'string' && typeof m.deployment.path === 'string'));
  return { members, servers: list(v.servers).filter(s => s && typeof s === 'object' && text(s.group)),
    notReached: list(v.notReached).filter(s => s && typeof s === 'object' && text(s.label)) };
}

export function createComputerTeams(doc, { request, onDocument = null, readMembers = null, onMember = () => {}, onOpenTeam = null }) {
  const page = el(doc, 'section', null, 'computer-teams'); page.dataset.box = 'Teams'; page.setAttribute('aria-label', 'Teams');
  const status = el(doc, 'p', '', 'ct-status'); status.setAttribute('role', 'status');
  // Servers we hold no rows for yet: said under the head, and kept current as they answer (outside the redraw barrier).
  const reach = el(doc, 'p', '', 'ct-reach'); reach.setAttribute('role', 'status');
  let roster = null, rosterSerial = 0;
  const body = el(doc, 'div', null, 'ct-body');
  let current = null, pending = false, serial = 0, disposed = false;
  let rowError = null, cardError = null, confirming = null, adding = false, opener = 'head';
  const draft = { label: '', team: '', description: '' };
  // The open team page (showTeam): { host, label, content, back, onGone, signature }.
  let shown = null;

  // The page head is static: the title, its one line, and the add button (the form opens below,
  // in Local teams). Opened twice, the button only brings the focus back to the form.
  // The head stays pinned while the page scrolls (spec G: .ws-sticky, discoveryCSS and sticky-top.mjs).
  const head = el(doc, 'div', null, 'ct-page-head ws-sticky'), titles = el(doc, 'div', null, 'ct-title-wrap');
  titles.append(el(doc, 'h2', 'Teams', 'ct-title'), el(doc, 'p', 'Who your agents can message. A team never adds capabilities or restricts what a soul can do.', 'ct-lead'));
  const addButton = el(doc, 'button', null, 'ct-act ct-add'); addButton.type = 'button';
  addButton.append(iconElement(doc, 'plus', { size: 13 }), el(doc, 'span', 'Add a local team'));
  addButton.setAttribute('aria-expanded', 'false');
  addButton.addEventListener('click', () => { if (addButton.disabled) return; openAdd('head'); });
  head.append(titles, addButton);
  page.append(head, reach, status, body);

  function openAdd(from) {
    opener = from;
    if (adding) { focusIn('.ct-form input[name=label]'); return; }
    adding = true; cardError = null; render();
  }

  async function run(action, { label = null } = {}) {
    const ticket = ++serial; pending = true; rowError = null; cardError = null; render();
    try {
      const next = await request(action);
      if (disposed || ticket !== serial) return;
      pending = false;
      if (!next || !Array.isArray(next.teams)) { cardError = { message: 'The teams on this computer could not be read.', read: true }; render(); return; }
      current = next;
      if (action.action === 'add') { adding = false; Object.assign(draft, { label: '', team: '', description: '' }); }
      if (action.action === 'default') confirming = null;
      status.textContent = ''; render();
      onDocument?.(current);
    } catch (error) {
      if (disposed || ticket !== serial) return;
      pending = false;
      const shown = { code: text(error?.code), message: text(error?.message) || 'The change was refused.' };
      if (label && action.action !== 'add') rowError = { label, ...shown }; else cardError = { ...shown, read: action.action === 'list' };
      render();
    }
  }
  const read = () => run({ action: 'list' });

  /** A refusal: one sentence, then the kernel's lines (its code under Details). */
  function problemBox(error) {
    const wrap = el(doc, 'div', null, 'ct-error'); wrap.setAttribute('role', 'alert');
    wrap.append(el(doc, 'p', error.message));
    if (error.code) { const more = el(doc, 'details'); more.append(el(doc, 'summary', 'Details'), el(doc, 'pre', error.code)); wrap.append(more); }
    return wrap;
  }
  function button(label, cls, onClick, { disabled = false, title = '', aria = '', key = '' } = {}) {
    const b = el(doc, 'button', label, `ct-act${cls ? ` ${cls}` : ''}`); b.type = 'button';
    b.disabled = disabled || pending; if (title) b.title = title; if (aria) b.setAttribute('aria-label', aria);
    if (key) b.dataset.focusKey = key;
    b.addEventListener('click', () => { if (!b.disabled) onClick(); });
    return b;
  }
  const blocks = p => p.default === true || p.severity === 'failure';
  function kernelProblem(problem) {
    // The default team's problem blocks every spawn here (the kernel's `default: true`): said as such.
    // Any other failure (team model 3's local-teams-closed) is the kernel's words, as an alert.
    const blocking = problem.default === true && text(problem.label), failure = blocking || problem.severity === 'failure';
    const line = el(doc, 'div', null, failure ? 'ct-blocking' : 'ct-warn'); line.dataset.problem = problem.code || '';
    if (failure) line.setAttribute('role', 'alert');
    if (blocking) line.append(el(doc, 'strong', `The default team ${problem.label} has no provider id yet: nothing can be spawned until it has one.`));
    line.append(el(doc, 'span', problem.message || problem.code || 'A problem was reported.', failure ? null : 'ct-warn-msg'));
    // A kernel message that already ends with its fix (local-teams-closed) says it once.
    if (text(problem.fix) && !(problem.message ?? '').includes(problem.fix)) line.append(el(doc, 'span', problem.fix, 'ct-fix'));
    if (blocking) line.append(el(doc, 'span', 'Or make another team the default.', 'ct-why'));
    return line;
  }

  /** A team's members, wherever they run: its provider id is their identity's team. An unmapped team has none. */
  function membersOf(team) {
    if (!text(team.team) || !roster) return [];
    return roster.members.filter(m => m.team === team.team);
  }

  /** The facts rows: team model 3's Default for and May join (only those with entries, else "No soul may join it
   * yet" as a muted May join), or team model 2's Who may join; then the address. Names are bold, each with its
   * souls: key as its title; every string enters by assignment. */
  function teamFacts(team) {
    const rows = el(doc, 'dl', null, 'ct-facts');
    const row = (key, caption, value) => {
      const item = el(doc, 'div', null, 'ct-fact'); item.dataset.fact = key;
      item.append(el(doc, 'dt', caption), value); rows.append(item); return value;
    };
    const audience = teamAudience(current, team.label);
    if (audience && (audience.defaultFor.length || audience.mayJoin.length)) {
      for (const [key, caption, entries, may] of [['default', 'Default for', audience.defaultFor, false], ['join', 'May join', audience.mayJoin, true]]) {
        if (!entries.length) continue;
        const value = el(doc, 'dd'); value.append(...audiencePhrase(entries, may)); row(key, caption, value);
      }
    } else if (audience) row('join', 'May join', el(doc, 'dd', 'No soul may join it yet', 'none'));
    const address = row('address', 'Address', el(doc, 'dd', team.team ?? 'no provider id yet', `ct-address${team.team ? '' : ' none'}`));
    address.title = 'Address: the team on the messaging provider';
    if (!audience) {
      const who = whoMayJoin(current, team.label), value = el(doc, 'dd');
      value.append(el(doc, 'b', who ?? 'No soul yet', `ct-join${who ? '' : ' none'}`)); row('who', 'Who may join', value);
    }
    return rows;
  }
  /** Team model 3's audience phrases ("all souls of p except x · y (q)"), as nodes. */
  function audiencePhrase(entries, may) {
    const name = entry => { const b = el(doc, 'b', entry.kind === 'soul' ? entry.soul : entry.repo, 'ct-name'); b.title = entry.key; return [b]; };
    const soul = entry => [...name(entry), ` (${entry.repo})`];
    const series = (items, nodes) => items.flatMap((item, i) => [...(i ? [i === items.length - 1 ? ' and ' : ', '] : []), ...nodes(item)]);
    /** What "every soul" leaves out: the repos as one series ("souls of p and q"), then each soul. */
    const everyBut = except => {
      const repos = except.filter(x => x.kind === 'repo'), groups = except.filter(x => x.kind === 'soul').map(soul);
      if (repos.length) groups.unshift(['souls of ', ...series(repos, name)]);
      return series(groups, nodes => nodes);
    };
    const parts = [], plainRepos = entries.filter(e => e.kind === 'repo' && !e.except), souls = entries.filter(e => e.kind === 'soul');
    const ofRepo = may ? 'souls of ' : 'all souls of ';
    for (const e of entries) {
      if (e.kind === 'every') parts.push(['every soul', ...(e.except ? [' except ', ...everyBut(e.except)] : [])]);
      else if (e.kind === 'fallback') parts.push(e.nobody ? [el(doc, 'span', 'fallback; every soul has its own default', 'ct-quiet')]
        : [`every soul without its own default${e.from === 'deployment' ? " (this deployment's choice)" : ''}`]);
      else if (e.kind === 'local') parts.push(['every soul (local team)']);
      else if (e.kind === 'repo' && e.except) parts.push([ofRepo, ...name(e), ' except ', ...series(e.except, name)]);
      // The repos without exceptions read as one series ("souls of a, b and c"), as do the single souls.
      else if (e === plainRepos[0]) parts.push([ofRepo, ...series(plainRepos, name)]);
      else if (e === souls[0]) parts.push(series(souls, soul));
    }
    return parts.flatMap((nodes, i) => [...(i ? [' · '] : []), ...nodes]);
  }

  /** A team's card. On the board (`onPage` false) the label is a button that opens the team's page, stretched
   * over the card, and a foot sums up your instances on it; on its page the label is the page's h2 and there is
   * no foot. Both hold the same header, facts, notes and actions, and the same confirmation flows. */
  function teamCard(team, { onPage = false } = {}) {
    const openable = !onPage && typeof onOpenTeam === 'function';
    const card = el(doc, 'article', null, `ct-card${team.from === 'shared' ? '' : ' local'}${onPage ? ' ct-page-card' : ''}${openable ? ' ct-openable' : ''}`);
    card.dataset.team = team.label; card.dataset.from = team.from;
    if (team.default) card.dataset.default = 'true';
    const root = onPage ? () => shown?.content : () => page;
    const header = el(doc, 'div', null, 'ct-head'), id = el(doc, 'div', null, 'ct-id');
    if (onPage) id.append(el(doc, 'h2', team.label, 'ct-page-label'));
    else {
      const heading = el(doc, 'h4', null, 'ct-name-h');
      if (openable) {
        const open = el(doc, 'button', team.label, 'ct-open'); open.type = 'button';
        open.setAttribute('aria-description', "Opens the team's page with your instances on it");
        open.addEventListener('click', () => onOpenTeam(team.label));
        heading.append(open);
      } else heading.append(el(doc, 'span', team.label, 'ct-label'));
      id.append(heading);
    }
    if (team.default) id.append(el(doc, 'span', 'Default team', 'ct-tag'), el(doc, 'span', !model3(current) ? 'on this computer'
      : current.defaultTeam?.from === 'workspace' ? 'set by the workspace' : 'set on this deployment', 'ct-from'));
    header.append(id);
    // The Workspace pages show no "On <deployment>" line (the product owner, 2026-10-23).
    if (text(team.description)) header.append(el(doc, 'p', team.description, 'ct-desc'));
    const actions = el(doc, 'div', null, 'ct-actions');
    // Make default writes oats-local.yaml's defaultTeam: only where this deployment may declare it.
    if (!team.default && localAllowed(current)) actions.append(button('Make default', '', () => { confirming = team.label; render(); focusIn(`[data-team="${team.label}"] .ct-confirm .primary`, root()); },
      { disabled: !team.team || !!writesHeld(), title: writesHeld() ?? (team.team ? '' : 'A team with no provider id yet cannot be the default.'), aria: `Make ${team.label} the default team`, key: 'team:make-default' }));
    const why = team.from === 'local' ? teamInUse(current, team.label) : null;
    if (team.from === 'local') actions.append(button('Remove', '', () => run({ action: 'remove', label: team.label }, { label: team.label }),
      { disabled: !!why || !!writesHeld(), title: writesHeld() ?? (why || ''), aria: why ? `Remove ${team.label}: ${why}` : `Remove ${team.label}`, key: 'team:remove' }));
    if (actions.childElementCount) header.append(actions);
    card.append(header);
    // What blocks comes first, then the facts, then the team's warnings and why Remove is off.
    const problems = list(current.problems).filter(p => p?.label === team.label);
    for (const problem of problems.filter(blocks)) card.append(kernelProblem(problem));
    card.append(teamFacts(team));
    for (const problem of problems.filter(p => !blocks(p))) card.append(kernelProblem(problem));
    if (why) card.append(el(doc, 'p', why, 'ct-why'));
    if (confirming === team.label) {
      const confirm = el(doc, 'div', null, 'ct-confirm');
      confirm.append(el(doc, 'p', `Make ${team.label} the default team on this computer? Running instances keep their current default team until they are respawned.`));
      const buttons = el(doc, 'div', null, 'ct-actions');
      buttons.append(button('Make default', 'primary', () => run({ action: 'default', label: team.label }, { label: team.label }), { key: 'team:confirm' }),
        button('Cancel', '', () => { confirming = null; render(); focusIn(`[data-team="${team.label}"] .ct-head .ct-actions button`, root()); }, { key: 'team:cancel' }));
      confirm.append(buttons); card.append(confirm);
    }
    if (rowError?.label === team.label) card.append(problemBox(rowError));
    // A failed read: the page's facts may be stale, so its card says so as the board does (not the add form's errors).
    if (onPage && cardError?.read) card.append(problemBox(cardError));
    if (!onPage) {
      // The foot: your instances on it (only once the members are known, and only a team with an id can have any).
      const foot = el(doc, 'div', null, 'ct-foot'), sum = el(doc, 'span', null, 'ct-sum');
      if (roster && text(team.team)) for (const part of memberSummaryParts(membersOf(team), roster.servers)) sum.append(el(doc, 'span', part.text, `ct-sum-${part.kind}`));
      foot.append(sum);
      if (openable) {
        const go = el(doc, 'span', null, 'ct-go'); go.setAttribute('aria-hidden', 'true');
        go.append(el(doc, 'span', 'Open team'), iconElement(doc, 'chevronRight', { size: 14 }));
        foot.append(go);
      }
      if (sum.childElementCount || openable) card.append(foot);
    }
    return card;
  }

  function addForm() {
    const form = el(doc, 'form', null, 'ct-form'); form.noValidate = true; form.setAttribute('aria-label', 'Add a local team');
    const field = (name, caption, placeholder, cls = '') => {
      const label = el(doc, 'label', caption, cls), wrap = el(doc, 'span', null, 'ct-field'), input = el(doc, 'input');
      input.name = name; input.value = draft[name]; input.placeholder = placeholder; input.autocomplete = 'off'; input.spellcheck = false;
      input.addEventListener('input', () => { draft[name] = input.value; });
      wrap.append(input); label.append(wrap); form.append(label); return input;
    };
    const first = field('label', 'Label', 'mine'); field('team', 'Team id', 'mine:you.aweb.ai'); field('description', 'Description (optional)', '', 'wide');
    const actions = el(doc, 'div', null, 'ct-actions');
    const submit = button('Add team', 'primary', () => {});
    submit.type = 'submit'; submit.disabled = pending;
    actions.append(submit, button('Cancel', '', () => { adding = false; cardError = null; render(); focusIn(opener === 'link' ? '.ct-empty .ct-link' : '.ct-add'); }));
    const hint = el(doc, 'p', null, 'ct-hint'); hint.append('To create a new team, run ', el(doc, 'code', 'oats aweb setup'), '.');
    form.append(actions, hint);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const label = draft.label.trim(), team = draft.team.trim(), description = draft.description.trim();
      if (!label || !team) { cardError = { message: 'A local team needs a label and its provider team id.' }; render(); return; }
      // The kernel's label grammar (lowercase only); said here instead of a bare E_BAD_ARGS from the route.
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(label)) { cardError = { message: 'A label is lowercase letters and digits, with . _ or - after the first character.' }; render(); return; }
      void run({ action: 'add', label, team, ...(description ? { description } : {}) });
    });
    queueMicrotask(() => { if (first.isConnected && !first.value) first.focus(); });
    return form;
  }

  /** A section: its heading (sentence case) and one muted line. */
  function section(name, titleText, leadText) {
    const wrap = el(doc, 'section', null, 'ct-section'); wrap.dataset.section = name;
    const head = el(doc, 'div', null, 'ct-section-head');
    head.append(el(doc, 'h3', titleText, 'ct-section-title'), el(doc, 'p', leadText, 'ct-section-lead'));
    wrap.setAttribute('aria-label', titleText); wrap.append(head);
    return wrap;
  }
  function emptyCard(message) { const card = el(doc, 'div', null, 'ct-empty'); card.append(el(doc, 'span', message)); return card; }
  /** Team model 3: the workspace's souls: patterns as committed, read only: a table of each pattern, its default and
   * the other teams its souls may join (`any`: every shared team). */
  function soulsSection() {
    const wrap = section('souls', 'Which teams each soul may join', `And its default: ${SOULS_WHERE}.`);
    const rules = record(current.souls) ? Object.entries(current.souls) : [];
    if (!rules.length) {
      // With local teams allowed, every soul may also join each of this deployment's local teams (via local).
      const local = localAllowed(current) && list(current.teams).some(t => t.from === 'local');
      wrap.append(emptyCard(`No souls: entries: a soul may join its default team${local ? " and this deployment's local teams" : ' only'}.`));
      return wrap;
    }
    const card = el(doc, 'div', null, 'ct-souls-card'), table = el(doc, 'table', null, 'ct-souls');
    // Explicit roles: the narrow layout re-displays the rows as grids, which may drop a table's implicit semantics.
    const role = (node, value) => { node.setAttribute('role', value); return node; };
    role(table, 'table'); table.setAttribute('aria-label', 'Which teams each soul may join');
    const cols = el(doc, 'colgroup'); for (const name of ['pattern', 'default', 'others']) cols.append(el(doc, 'col', null, name));
    const thead = role(el(doc, 'thead'), 'rowgroup'), headRow = role(el(doc, 'tr'), 'row');
    for (const caption of ['Souls', 'Default team', 'May also join']) { const th = role(el(doc, 'th', caption), 'columnheader'); th.scope = 'col'; headRow.append(th); }
    thead.append(headRow);
    const tbody = role(el(doc, 'tbody'), 'rowgroup');
    const none = () => el(doc, 'span', 'none', 'ct-none');
    for (const [key, rule] of rules) {
      const row = role(el(doc, 'tr'), 'row'); row.dataset.soulKey = key;
      const pattern = role(el(doc, 'td'), 'cell'), code = el(doc, 'span', null, 'ct-pattern');
      // "agents/release-manager": the folder steps back, the soul stands out; "*" reads "every soul".
      const at = key.lastIndexOf('/');
      if (at >= 0) code.append(el(doc, 'span', key.slice(0, at + 1), 'ct-pattern-dir'), key.slice(at + 1)); else code.append(key);
      pattern.append(code);
      if (key === '*') pattern.append(el(doc, 'span', ' every soul', 'ct-every'));
      const fallback = role(el(doc, 'td'), 'cell'); fallback.append(record(rule) && text(rule.default) ? el(doc, 'span', rule.default, 'ct-chip') : none());
      // The other teams (the default is not said twice); any is every shared team.
      const others = role(el(doc, 'td'), 'cell'), labels = record(rule) && rule.teams !== 'any' ? list(rule.teams).filter(l => l !== rule.default) : [];
      if (record(rule) && rule.teams === 'any') others.append('any shared team');
      else if (labels.length) others.append(...labels.map(l => el(doc, 'span', l, 'ct-chip')));
      else others.append(none());
      row.append(pattern, fallback, others); tbody.append(row);
    }
    table.append(cols, thead, tbody); card.append(table); wrap.append(card);
    return wrap;
  }

  // Who is in each team, as drawn: a roster poll that changes it redraws the cards (syncRoster).
  let rosterDrawn = '';
  const rosterKey = () => JSON.stringify([!!roster, list(current?.teams).map(team => membersOf(team).map(m => [m.server, m.home, m.instance, m.agent, m.agentsRoot,
    m.running, m.addressable, m.missingRemotely, m.reason])), list(roster?.servers).map(s => [s.group, s.reached, s.error])]);
  function render() {
    if (disposed) return;
    paintBoard();
    paintTeam();
  }
  function paintBoard() {
    body.replaceChildren();
    addButton.disabled = pending || !!writesHeld(); addButton.title = writesHeld() ?? ''; addButton.setAttribute('aria-expanded', String(adding));
    addButton.hidden = !!current && !localAllowed(current);
    if (!current) { status.textContent = pending ? 'Reading the teams on this computer (oats teams)…' : status.textContent; if (cardError) body.append(problemBox(cardError)); return; }
    // The page's own problems (no team card holds them), failures first: team model 3's local-teams-closed leads.
    const pageProblems = list(current.problems).filter(p => !text(p?.label) || !list(current.teams).some(t => t.label === p.label));
    for (const problem of [...pageProblems.filter(p => p.severity === 'failure'), ...pageProblems.filter(p => p.severity !== 'failure')]) {
      const wrap = el(doc, 'div', null, 'ct-problem'); wrap.append(kernelProblem(problem)); body.append(wrap);
    }
    // The default team's card leads its section; the others keep the document's order (a stable sort).
    const teams = list(current.teams).slice().sort((a, b) => (b.default === true) - (a.default === true));
    const shared = teams.filter(t => t.from === 'shared'), local = teams.filter(t => t.from !== 'shared');
    const sharedSection = section('shared', 'Shared teams', 'Declared in oats-workspace.yaml and shared through Git, so every computer that runs the workspace has them.');
    for (const team of shared) sharedSection.append(teamCard(team));
    if (!shared.length) sharedSection.append(emptyCard("No shared teams. A shared team is declared in the workspace's oats-workspace.yaml and committed, so every computer running the workspace has it."));
    const localSection = section('local', 'Local teams', 'Only on this computer, in its oats-local.yaml. Not shared.');
    for (const team of local) localSection.append(teamCard(team));
    if (!local.length && !adding && !localAllowed(current)) localSection.append(el(doc, 'p', `No local teams: ${LOCAL_TEAMS_CLOSED}.`, 'ct-dashed'));
    else if (!local.length && !adding) {
      const empty = emptyCard("No local teams. A local team lives in this computer's oats-local.yaml and is visible only here.");
      empty.append(button('Add a local team', 'ct-link', () => openAdd('link'), { disabled: !!writesHeld(), title: writesHeld() ?? '' }));
      localSection.append(empty);
    }
    if (cardError) localSection.append(problemBox(cardError));
    if (adding && localAllowed(current)) localSection.append(addForm());
    body.append(sharedSection, localSection);
    // Team model 3: the workspace's souls: (none in the standalone view, where no workspace file is read).
    if (model3(current) && current.localTeams !== null) body.append(soulsSection());
    rosterDrawn = rosterKey();
  }

  /* ── The team's page (packages/desktop/docs/desktop-teams.md "A team's page"): its card, then your instances on
   * it. It follows the pages' rule, not the board's barrier: it repaints only when what it shows changed, and puts
   * focus back on the same control by its focus key (else Back). ── */
  /** A focus key per member control: the instance's deployment and name. */
  const memberKey = (m, part) => JSON.stringify([m.workspace, m.instance, part]);
  function memberRow(m, machine) {
    const row = el(doc, 'div', null, 'ct-irow'); row.setAttribute('role', 'row');
    const cell = cls => { const c = el(doc, 'span', null, cls); c.setAttribute('role', 'cell'); return c; };
    // Instance: its soul's mark, then the name, which shows its roster row; the soul's prefix steps back.
    const instance = cell('ct-iname'), soul = soulShort(m.agent);
    const name = el(doc, 'button', null, 'ct-member-name'); name.type = 'button'; name.dataset.focusKey = memberKey(m, 'name');
    name.setAttribute('aria-label', `Show ${m.instance} in the roster`); name.title = `Show ${m.instance} in the roster`;
    const tail = soul && m.instance.startsWith(`${soul}-`) && m.instance.length > soul.length + 1 ? m.instance.slice(soul.length + 1) : null;
    if (tail) name.append(el(doc, 'span', `${soul}-`, 'ct-name-pre'), el(doc, 'span', tail, 'ct-name-tail'));
    else name.append(el(doc, 'span', m.instance, 'ct-name-tail'));
    name.addEventListener('click', () => onMember('show', { ...m }));
    // The mark keeps the full soul as its title where the Soul column is hidden.
    const mark = createSoulMark(doc, { name: m.agent, agentsRoot: m.agentsRoot }); mark.title = m.agent;
    instance.append(mark, name);
    const soulCell = cell('ct-isoul'); soulCell.textContent = soul; soulCell.title = m.agent;
    // State: the word carries it (never colour alone); a member that can't be opened says why.
    const state = cell(''), kind = stateKind(m), blocked = openBlocked(m), word = stateWord(m);
    const pill = el(doc, 'span', null, `ct-member-state ${kind}`); pill.dataset.state = memberState(m);
    const dot = el(doc, 'span', null, 'ct-state-dot'); dot.setAttribute('aria-hidden', 'true');
    pill.append(dot, el(doc, 'span', kind === 'run' ? 'Running' : kind === 'stop' ? 'Stopped' : word, 'ct-state-word'));
    if (blocked) { pill.title = blocked; pill.setAttribute('aria-description', blocked); }
    state.append(pill);
    const created = cell('ct-age');
    if (text(m.createdAt)) { created.textContent = ageText(m.createdAt); created.title = m.createdAt; created.dataset.created = m.createdAt; }
    // Terminal only when it can be opened: the list holds no disabled buttons.
    const act = cell('ct-iact');
    if (!blocked) {
      const term = el(doc, 'button', null, 'ct-member-term'); term.type = 'button'; term.dataset.focusKey = memberKey(m, 'term');
      term.setAttribute('aria-label', `Open ${m.instance} terminal on ${machine}`);
      term.append(iconElement(doc, 'terminal', { size: 13 }), el(doc, 'span', 'Terminal'));
      term.addEventListener('click', () => onMember('open', { ...m }));
      act.append(term);
    }
    row.append(instance, soulCell, state, created, act);
    return row;
  }
  /** One machine's card: a head band (machine, path, its counts) and a table of its instances. */
  function machineCard(team, group, named) {
    const card = el(doc, 'section', null, `ct-mcard${group.reached ? '' : ' unreached'}`); card.setAttribute('role', 'group');
    card.setAttribute('aria-label', named); card.dataset.group = group.key;
    const path = group.path ? shortPath(group.path) : '';
    const head = el(doc, 'h4', null, 'ct-mcard-head');
    const running = group.members.filter(m => stateKind(m) === 'run').length;
    head.append(iconElement(doc, group.reached ? 'computer' : 'warning', { size: 15 }), el(doc, 'span', group.machine, 'ct-machine'));
    if (path) { const at = el(doc, 'span', path, 'ct-path'); at.title = group.path; head.append(at); }
    head.append(el(doc, 'span', group.reached ? `${plural(group.members.length, 'instance')}, ${running} running` : 'not reached', 'ct-mcard-count'));
    if (!group.reached && group.error) head.title = group.error;
    const table = el(doc, 'div', null, 'ct-ilist'); table.setAttribute('role', 'table'); table.setAttribute('aria-label', `Your instances on ${team.label} on ${named}`);
    const columns = el(doc, 'div', null, 'ct-irow ct-ihead'); columns.setAttribute('role', 'row');
    for (const caption of ['Instance', 'Soul', 'State', 'Created', 'Terminal']) {
      const th = el(doc, 'span', caption === 'Terminal' ? null : caption); th.setAttribute('role', 'columnheader');
      if (caption === 'Terminal') th.append(el(doc, 'span', caption, 'ct-vh'));
      columns.append(th);
    }
    table.append(columns);
    const machine = group.server ? group.machine : 'this computer';
    for (const m of group.members) table.append(memberRow(m, machine));
    card.append(head, table);
    return card;
  }
  /** "Your instances on this team": the counts, then one card per machine; nothing until the members are known. */
  function yours(team) {
    const wrap = section('yours', 'Your instances on this team',
      `On this computer and the machines you added to this workspace. Instances other people run on ${team.label} are not listed here.`);
    if (!text(team.team)) { wrap.append(el(doc, 'p', 'This team has no provider id yet, so no instance can be on it.', 'ct-dashed')); return wrap; }
    if (!roster) return wrap;
    const members = membersOf(team);
    if (!members.length) { wrap.append(el(doc, 'p', `None of your instances is on ${team.label}.`, 'ct-dashed')); return wrap; }
    const groups = memberGroups(members, roster.servers), kinds = members.map(stateKind);
    const count = kind => kinds.filter(k => k === kind).length, running = count('run'), stopped = count('stop'), attention = count('warn');
    const machines = new Set(groups.map(g => g.server ?? '')).size;
    const sum = el(doc, 'p', null, 'ct-yours-sum');
    const fact = (n, words, cls = '') => { const part = el(doc, 'span', null, cls || null); part.append(el(doc, 'b', String(n)), words); sum.append(part); };
    fact(members.length, members.length === 1 ? 'instance' : 'instances'); fact(running, 'running');
    if (stopped) fact(stopped, 'stopped');
    if (attention) fact(attention, attention === 1 ? 'needs attention' : 'need attention', 'warn');
    sum.append(el(doc, 'span', `on ${plural(machines, 'machine')}`, 'ct-yours-machines'));
    wrap.append(sum);
    if (team.default) wrap.append(el(doc, 'p', 'Every instance joins its default team, so all of your instances are here.', 'ct-default-note'));
    // A machine's card is named by its machine, with its path where two cards share a machine.
    const repeated = name => groups.filter(g => g.machine === name).length > 1;
    const cards = el(doc, 'div', null, 'ct-mcards'); wrap.append(cards);
    for (const group of groups) cards.append(machineCard(team, group, repeated(group.machine) && group.path ? `${group.machine} ${shortPath(group.path)}` : group.machine));
    return wrap;
  }
  /** What the open page shows, for its repaint rule (ages excepted: they are updated in place). */
  function teamSignature(team) {
    const members = membersOf(team);
    return JSON.stringify([team, list(current.problems).filter(p => p?.label === team.label), teamAudience(current, team.label), whoMayJoin(current, team.label),
      team.from === 'local' ? teamInUse(current, team.label) : null, localAllowed(current), current.defaultTeam ?? null, pending, confirming === team.label,
      rowError?.label === team.label ? rowError : null, cardError?.read ? cardError : null, !!roster, members, roster ? memberGroups(members, roster.servers).map(g => [g.key, g.machine, g.path, g.reached, g.error]) : null]);
  }
  function paintTeam() {
    if (!shown || !current) return;
    const team = list(current.teams).find(t => t.label === shown.label);
    // Gone from the document (removed, here or elsewhere): the page closes.
    if (!team) { const gone = shown.onGone; forget(); gone?.(); return; }
    const signature = teamSignature(team);
    if (signature !== shown.signature) {
      shown.signature = signature;
      const restore = captureFocusState(shown.content, { scroller: shown.host, fallback: () => shown.back });
      shown.content.replaceChildren(teamCard(team, { onPage: true }), yours(team));
      restore();
    }
    // The ages follow the roster poll in place.
    for (const cell of shown.content.querySelectorAll('.ct-age[data-created]')) cell.textContent = ageText(cell.dataset.created);
  }
  /** Show `label`'s page in `host` (its bar, then its content), or false when the document has no such team.
   * `onBack` is Back's; `onGone` hears that the team left the document or the page's owner went away. */
  function showTeam(host, label, { onBack, onGone = null } = {}) {
    if (disposed || !current || !list(current.teams).some(t => t.label === label)) return false;
    const { bar, back } = pageBar(doc, { backLabel: 'Teams', crumbs: ['Workspace', 'Teams'], current: label, onBack });
    const content = el(doc, 'div', null, 'computer-teams ct-team-page'); content.dataset.team = label;
    host.replaceChildren(bar, content);
    forget();
    // It edits the view's primary deployment, without naming it (the Workspace pages, the product owner, 2026-10-23).
    shown = { host, label, content, back, onGone, signature: null };
    paintTeam();
    return true;
  }
  function hideTeam() { forget(); }
  /** The page closes (Back, Esc, a tab change, its team gone, a new page, the owner gone): a Make default
   * confirmation it held ends with it, which releases the board's redraw barrier and takes it off the board's card. */
  function forget() {
    if (!shown) return;
    shown = null;
    if (confirming === null) return;
    confirming = null;
    if (!disposed && current) paintBoard();
  }

  /** The members changed: redraw only when who is in a team (or their state) changed, and never under an
   * open form, a pending confirmation or the keyboard (a redraw would drop what is typed or focused). */
  function redrawMembers() {
    paintTeam();
    if (disposed || !current || pending || adding || confirming || page.contains(doc.activeElement) || rosterKey() === rosterDrawn) return;
    paintBoard();
  }
  function paintReach() {
    const labels = list(roster?.notReached).map(s => s.label);
    reach.textContent = labels.length ? `Not reached: ${labels.join(', ')}. Their members aren't shown until they answer.` : '';
  }
  /** Read the members (on mount and at each roster poll); the notice follows every answer. */
  async function readRoster() {
    if (typeof readMembers !== 'function') return;
    const ticket = ++rosterSerial;
    let answer; try { answer = membersAnswer(await readMembers()); } catch { answer = null; }
    if (disposed || ticket !== rosterSerial || !answer) return;
    roster = answer; paintReach(); redrawMembers();
  }
  function syncRoster() { void readRoster(); }
  function focusIn(selector, root = page) { queueMicrotask(() => root?.querySelector(selector)?.focus()); }

  void read(); void readRoster();
  return { element: page, refresh: read, syncRoster, showTeam, hideTeam,
    dispose() { disposed = true; serial++; rosterSerial++; const gone = shown?.onGone; forget(); gone?.(); } };
}
