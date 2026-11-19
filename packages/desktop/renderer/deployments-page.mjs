/** A deployment's heading (UI spec, #482), from the Deployments page of before (the Machines canvas, which became the
 * Graph in slice 6b, views/graph.mjs: it shows a heading for each machine that has something to say, above its
 * canvas). The page's deployment tabs went with it: the Graph's columns are the machines.
 *
 * Heading: the overview's group label (`.cnm` / `.cct`, the "INDEPENDENT 2" label) naming the
 * deployment and its counts; a deployment that is not live adds its state as a chip, the short reason,
 * and an inline "How to fix" disclosure (the spawn dialog's Developer settings summary: a chevron, 12px
 * at 650) holding the full sentence, the fix steps and the note. Never an id: the full path is the
 * label's tooltip only. */
import { deploymentState } from '../../client/roster-sections.mjs';
import { deploymentLabel, deploymentLabelParts } from '../../client/deployment-label.mjs';
import { DESKTOP_TERMS } from './desktop-terms.mjs';
import { runtimeCounts } from '../../client/instance-presentation.mjs';

export const deploymentsPageCSS = `
.hier-dhead { position:absolute; left:0; display:flex; flex-direction:column; align-items:flex-start; gap:4px; width:max-content; }
.hier-dline { display:flex; align-items:baseline; gap:8px; white-space:nowrap; }
.hier-dname { display:inline-flex; align-items:baseline; gap:6px; min-width:0; flex:0 1 auto; overflow:hidden; }
.hier-dhead .hier-dpath { text-transform:none; letter-spacing:normal; }
.hier-dfix > summary { display:flex; align-items:center; gap:8px; width:max-content; cursor:pointer; list-style:none; font-size:12px; font-weight:650; color:var(--fg); }
.hier-dfix > summary::-webkit-details-marker { display:none; }
.hier-dfix > summary::before { content:''; flex:none; width:6px; height:6px; margin:0 2px; border-right:1.5px solid var(--muted); border-bottom:1.5px solid var(--muted); transform:rotate(-45deg); transition:transform .15s; }
.hier-dfix[open] > summary::before { transform:rotate(45deg); }
.hier-dfix-body { width:max-content; max-width:640px; padding:6px 0 0 18px; color:var(--fg); font-size:12px; line-height:1.5; white-space:normal; overflow-wrap:anywhere; }
.hier-dfix-body p, .hier-dfix-body ol { margin:0 0 6px; }
.hier-dfix-body ol { padding-left:18px; }
.hier-dfix-note { color:var(--muted); }
.hier-dfix-code { font:inherit; font-family:var(--mono, ui-monospace, Menlo, monospace); color:var(--fg); }
.hier-dreason .hier-dhead { position:static; }
`;

/** Text whose `backticked` spans are commands, set as code (the server's reasons quote them so). */
function withCode(doc, host, text) {
  String(text).split('`').forEach((part, i) => { if (part) host.append(i % 2 ? el(doc, 'code', part, 'hier-dfix-code') : doc.createTextNode(part)); });
  return host;
}

const el = (doc, tag, text, cls) => {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};

/** A section's counts in words: "3 running", "1 running · 2 stopped", "no instances". */
export function deploymentCounts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return 'no instances';
  const { running, stopped, unknown } = runtimeCounts(list);
  return [`${running} running`, stopped ? `${stopped} stopped` : '', unknown ? `${unknown} unknown` : ''].filter(Boolean).join(' · ');
}

/** Whether a deployment's heading must say something: it is not live, or it is live but carries a
 * reason (reached, yet not matched to a workspace: an old host, an invalid reference…). A deployment
 * the switcher lists under "Not matched" opens here, so its why is said here too. */
export const deploymentNeedsWords = (deployment) => deploymentState(deployment).key !== 'live' || !!deployment?.short;

/** Whether a deployment's heading has anything to say: words for a failure, or an informational note
 * (a remote that now reports another workspace, a standalone host's local teams). A note is never a
 * failure: it gets no chip and no mark, only its line under "Details". */
export const deploymentHasWords = (deployment) => deploymentNeedsWords(deployment) || !!deployment?.note;

/** A deployment's heading: `{ element, label }`, `label` being the accessible name for the group that
 * holds it (the visible line is aria-hidden; the disclosure stays reachable). `open` and `onToggle`
 * carry the disclosure's state across repaints. */
export function deploymentHead(doc, { deployment, rows, open = false, onToggle }) {
  const label = deploymentLabel(deployment, DESKTOP_TERMS), state = deploymentState(deployment), counts = deploymentCounts(rows);
  // `live` here means "nothing to explain": a reached deployment that is not matched explains itself
  // under a "not matched" chip.
  const live = !deploymentNeedsWords(deployment);
  const chip = state.key === 'live' ? 'not matched' : state.text;
  const head = el(doc, 'div', undefined, 'hier-dhead');
  const line = el(doc, 'div', undefined, 'hier-dline'); line.setAttribute('aria-hidden', 'true');
  // The machine in the group-label type (uppercase); the path beside it in normal case, never
  // transformed: a path is case-sensitive.
  const parts = deploymentLabelParts(deployment, DESKTOP_TERMS);
  const name = el(doc, 'span', undefined, 'hier-dname');
  name.append(el(doc, 'span', parts.machine, 'cnm hier-dmachine'));
  if (parts.path) name.append(doc.createTextNode(' '), el(doc, 'span', `· ${parts.path}`, 'cct hier-dpath'));
  if (deployment.path) name.title = deployment.path;
  line.append(name, el(doc, 'span', counts, 'cct hier-dcount'));
  if (!live) {
    line.append(el(doc, 'span', chip, 'chip hier-dstate'));
    if (deployment.short) line.append(el(doc, 'span', deployment.short, 'cct hier-dshort'));
  }
  head.append(line);
  // What the tree under it is (the Machines tab, 2026-10-26): the instances on that machine, said under its name.
  const here = !(typeof deployment?.machine === 'string' && deployment.machine);
  head.append(el(doc, 'div', here ? 'Instances on this machine' : `Instances on ${parts.machine}`, 'hier-dsub'));
  // With steps to follow, the steps are the explanation (the short reason above already names the
  // cause; the full sentence would repeat step 1): only a remembered deployment's "Last report" lead
  // stays. Without steps, the full sentence says what happens.
  const remembered = !live && deployment.identityFrom === 'remembered' ? 'Last report, not live now.' : '';
  const sentence = live ? '' : (deployment.fix?.length ? remembered : state.detail || deployment.reason || '');
  const steps = live ? [] : deployment.fix || [];
  // A note is information, live or not: always said.
  const note = deployment.note || '';
  if (sentence || steps.length || note) {
    // "How to fix" when there are steps to follow; with only an explanation, it is details.
    const fix = el(doc, 'details', undefined, 'hier-dfix');
    const body = el(doc, 'div', undefined, 'hier-dfix-body');
    if (sentence) body.append(withCode(doc, el(doc, 'p', undefined, 'hier-dfix-reason'), sentence));
    if (steps.length) { const list = el(doc, 'ol', undefined, 'hier-dfix-steps'); for (const step of steps) list.append(withCode(doc, el(doc, 'li'), step)); body.append(list); }
    if (note) body.append(el(doc, 'p', note, 'hier-dfix-note'));
    fix.append(el(doc, 'summary', steps.length ? 'How to fix' : 'Details'), body);
    fix.open = !!open;
    fix.addEventListener('toggle', () => onToggle?.(fix.open));
    head.append(fix);
  }
  return { element: head, label: [label, counts, live ? '' : chip, live ? '' : deployment.short || ''].filter(Boolean).join(', ') };
}

/** The tab's empty state for a deployment that is not live and has no rows: the same heading, in flow. */
export function deploymentReasonBlock(doc, options) {
  const { element, label } = deploymentHead(doc, options);
  const block = el(doc, 'div', undefined, 'hier-dreason');
  block.setAttribute('role', 'group'); block.setAttribute('aria-label', label);
  block.dataset.deployment = options.deployment.id;
  block.append(element);
  return block;
}
