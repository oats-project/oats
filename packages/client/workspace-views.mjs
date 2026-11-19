/** Workspace views (#482): what the switcher lists and a window shows. One view per workspace
 * identity `(key, default team)` its deployments report, matched by the kernel's rules
 * (docs/desktop-cli-api.md, "Matching workspaces across machines" and "Matching teams across
 * machines"), plus one view per deployment that cannot be matched, under that deployment's own id.
 * Pure: no I/O. The identity is the kernel's `workspace` object, read as reported; nothing is
 * derived from a path, a ref or a host name, and `ref` is never compared. */
import { createHash } from 'node:crypto';
import { requireTerms } from './client-terms.mjs';
import { displayLine, DETAIL_WITHHELD } from './display-text.mjs';
import { originLead } from './instance-presentation.mjs';
import { currentRepoKey } from './repo-moves.mjs';

const TEXT_MAX = 2048;
const text = v => typeof v === 'string' && v.length > 0 && v.length <= TEXT_MAX && !v.includes('\0');
const record = v => !!v && typeof v === 'object' && !Array.isArray(v);

/** The identity fields of a reported `workspace` object, validated and copied, or a classification:
 * `{ status: 'none' }` when nothing was reported (null, absent, not an object), `{ status: 'old' }`
 * for a host before 0.36.0 (the reachability-only object has no `key` field), `{ status: 'invalid' }`
 * for a shape the contract does not allow, else `{ status: 'identity', identity }`. */
export function readIdentity(workspace) {
  if (!record(workspace)) return { status: 'none' };
  if (!Object.hasOwn(workspace, 'key')) return { status: 'old' };
  const { key, ref = null, keyFrom = null, standalone, defaultTeam = null, teams = {}, teamsFrom } = workspace;
  const team = v => v === null || text(v);
  const ok = (key === null || text(key)) && (ref === null || text(ref)) && [null, 'workspace', 'member'].includes(keyFrom)
    && typeof standalone === 'boolean' && ['observed', 'cache', 'local'].includes(teamsFrom)
    && (defaultTeam === null || record(defaultTeam) && text(defaultTeam.label) && team(defaultTeam.team))
    && record(teams) && Object.keys(teams).length <= 256 && Object.entries(teams).every(([label, id]) => text(label) && team(id));
  if (!ok) return { status: 'invalid' };
  return { status: 'identity', identity: { key, ref, keyFrom, standalone, teamsFrom,
    defaultTeam: defaultTeam && { label: defaultTeam.label, team: defaultTeam.team }, teams: { ...teams } } };
}

/** How one identity attaches, by the kernel's rules: `{ key, team, unmapped, note? }` (team null and
 * unmapped true for an unmapped default team, which matches only unmapped), or `{ unattached }` with
 * the reason's key. `note` is information, not a failure (a standalone deployment's local teams). */
export function attachment(identity) {
  if (!identity) return { unattached: 'no-report' };
  if (identity.keyFrom === 'member') return { unattached: 'member' };
  if (identity.key === null || identity.keyFrom !== 'workspace') return { unattached: 'invalid-ref' };
  const team = identity.defaultTeam?.team ?? null;
  if (identity.teamsFrom === 'local' && !identity.standalone && team === null) return { unattached: 'unknown-team' };
  return { key: identity.key, team, unmapped: team === null,
    ...(identity.teamsFrom === 'local' && identity.standalone && team === null ? { note: 'standalone' } : {}) };
}

/** A stable view id for one `(key, team)`: never a path, so it cannot collide with a deployment id. */
export function viewId(key, team) {
  return `ws:${createHash('sha256').update(JSON.stringify([key, team])).digest('hex').slice(0, 20)}`;
}

/** The kernel's own reason texts where docs/desktop-cli-api.md gives them, else the spec's: the full
 * sentence, the short label (headings, the switcher) and the fix as plain steps. `there` names where
 * the fix runs ("there" for a remote, "in this deployment" for a local one). */
const REASONS = {
  member: ({ there }) => ({ short: 'Workspace not known yet', detail: 'This deployment\'s workspace reference names a member whose workspace isn\'t known yet; run oats sync there.', fix: [`Run \`oats sync\` ${there}.`] }),
  'invalid-ref': ({ ref }) => ({ short: 'Invalid workspace reference', detail: `This deployment's workspace reference${ref ? ` (${ref})` : ''} isn't valid; fix oats-local.yaml.`,
    fix: [`Fix the workspace reference${ref ? ` (\`${ref}\`)` : ''} in its oats-local.yaml.`] }),
  'unknown-team': ({ there }) => ({ short: 'Workspace not observed yet', detail: 'This host hasn\'t observed its workspace yet; run oats sync there.', fix: [`Run \`oats sync\` ${there}.`] }),
  standalone: () => ({ short: 'Local teams only', detail: 'Teams are local only on this host (standalone).', fix: [] }),
};

/** True when a failed probe's message is a timeout: the kernel reports an ssh that timed out as E_SSH,
 * with ssh's own stderr or, when its own deadline ended the call, "timed out: no answer within N s", and
 * no code of its own, so the text is the only signal (a documented limit). */
const TIMED_OUT = /timed out|timeout/i;

/** The client's own sentence for a deployment whose last read failed and whose last observation is kept. */
const LAST_READ_FAILED = 'This deployment\'s last read failed. It shows what was last observed.';

/** The reason of a kept failure, in parts and joined. `message` is the failure's text and `origin` its
 * speaker ("kernel" when the installed CLI printed it; deployment-facts.mjs `keptFailure`). The message
 * is one display line in every form (display-text.mjs `displayLine`), whole or withheld whole:
 *
 *   origin     the line              detail
 *   "kernel"   a line                "<own sentence> OATS says: <line>"
 *   "kernel"   "[withheld]"          "<own sentence> [withheld]"
 *   "kernel"   nothing to show       "<own sentence>"
 *   none       a line                "This deployment's last read failed: <line>. It shows what was last observed."
 *   none       "[withheld]"          "This deployment's last read failed: [withheld]. It shows what was last observed."
 *   none       nothing to show       "<own sentence>"
 *
 * The kernel's words stand apart, after the client's sentence and the speaker's lead
 * (instance-presentation.mjs `originLead`); a withheld or missing message is never introduced by the
 * lead. A message with no origin keeps the words a client always showed, inside its own sentence.
 * The parts, as deployment-facts.mjs `deploymentUnavailableParts` answers them: `headline` the client's
 * sentence, `lead` the speaker's words or null, `sentence` the kernel's line or null; `detail` is those
 * that are there, joined by one space. With no origin the whole detail is the headline. */
function lastReadFailed(message, origin, terms) {
  const line = displayLine(message);
  if (origin !== 'kernel') {
    const detail = line === null ? LAST_READ_FAILED : `This deployment's last read failed: ${line}. It shows what was last observed.`;
    return { headline: detail, lead: null, sentence: null, detail };
  }
  const lead = line === null || line === DETAIL_WITHHELD ? null : originLead('kernel', terms);
  return { headline: LAST_READ_FAILED, lead, sentence: line, detail: [LAST_READ_FAILED, lead, line].filter(part => part !== null).join(' ') };
}

/** Why a deployment is not live or not matched, or null: `{ short, detail, fix }`. `short` is a few
 * words for a heading or the switcher ("OATS too old to report its workspace"); `detail` the one full
 * sentence; `fix` the plain steps (possibly none: the detail then says what happens next). The steps
 * carry every fact the sentence has (a host, a reference): with steps, a heading shows only them.
 * `d`: `{ local, machine, sshHost?, probe?, identityStatus, attach, ref, cliReadsRemotes, rosterError?, unavailable?, readError?, readErrorOrigin? }`.
 * `readError` is a kept failure's message and `readErrorOrigin` its speaker (deployment-facts.mjs
 * `keptFailure`): a string, possibly empty, says the last read failed, whatever it holds. That answer
 * alone also carries `headline`, `lead` and `sentence`, the parts `detail` joins (`lastReadFailed`).
 * `terms`: the client's own (client-terms.mjs): its name where a sentence names it, and the label of its
 * machine where `d` names none. */
export function deploymentReasonParts(d, terms) {
  requireTerms(terms, 'deploymentReasonParts');
  const machine = d.machine || terms.thisMachine;
  const updateHere = ['Update OATS on this computer.'];
  if (d.local) {
    if (d.unavailable) return { short: 'Not observed', detail: d.unavailable, fix: [] };
    // A re-read failed and the last observation was kept (deployment-panel.mjs `failedEntry`): a string, whatever it holds.
    if (typeof d.readError === 'string') return { short: 'Last read failed', ...lastReadFailed(d.readError, d.readErrorOrigin, terms), fix: [] };
    if (d.identityStatus === 'feature') return { short: 'OATS here too old to report workspaces', detail: 'This computer\'s OATS is too old to report its workspace; update OATS here.', fix: updateHere };
    if (d.identityStatus === 'old' || d.identityStatus === 'none') return { short: 'Reports no workspace', detail: 'This deployment reports no workspace identity.', fix: [] };
  } else {
    if (d.cliReadsRemotes === false) return { short: 'OATS here can\'t read other machines', detail: 'This computer\'s OATS can\'t read other machines; update OATS here.', fix: updateHere };
    if (d.identityStatus === 'feature' && d.probe?.ok === true) return { short: 'OATS here too old to read workspaces', detail: 'This computer\'s OATS is too old to read other machines\' workspaces; update OATS here.', fix: updateHere };
    if (d.rosterError) return { short: 'Not reached', detail: `${machine} was not reached: ${d.rosterError}`, fix: [] };
    if (d.probe && d.probe.ok !== true) {
      const code = d.probe.error?.code, message = typeof d.probe.error?.message === 'string' ? d.probe.error.message : '';
      if (code === 'E_CLI_TIMEOUT' || TIMED_OUT.test(message)) return { short: 'Timed out', detail: `${machine} timed out; it is tried again on the next read.`, fix: [] };
      if (code === 'E_SSH') {
        const host = d.sshHost || machine;
        return { short: 'ssh needs a prompt', detail: `${machine} needs ssh to connect without a prompt; run \`ssh ${host}\` once in a terminal.`,
          fix: [`Run \`ssh ${host}\` once in a terminal and answer its prompt (a host key or a password).`, `${terms.name} tries again on its next read.`] };
      }
      return { short: 'Not reached', detail: `${machine} was not reached${code ? ` (${code})` : ''}.`, fix: [] };
    }
    if (d.identityStatus === 'old') return { short: 'OATS too old to report its workspace', detail: `${machine}'s OATS is too old to report its workspace; update OATS there.`, fix: [`Update OATS on ${machine}.`] };
    if (d.identityStatus === 'none') return { short: 'Reports no workspace', detail: `${machine} reports no workspace for this deployment.`, fix: [] };
  }
  if (d.identityStatus === 'invalid') return { short: 'Unreadable workspace report', detail: `${machine} reported a workspace ${terms.self} can't read.`, fix: [] };
  const reason = d.attach?.unattached && REASONS[d.attach.unattached];
  return reason ? reason({ ref: d.ref, there: d.local ? 'in this deployment' : `on ${machine}` }) : null;
}

/** The one plain sentence for a deployment that is not live or not matched, or null. */
export function deploymentReason(d, terms) {
  requireTerms(terms, 'deploymentReason');
  return deploymentReasonParts(d, terms)?.detail ?? null;
}

/** The last segment of a canonical key: github.com/example/app → app. */
const keyTail = key => String(key).split('/').filter(Boolean).pop() || String(key);

/** Build the views from the served deployments, in their served order (locals first, as given).
 * `deployments`: `[{ id, local, name, attach }]` where `attach` comes from attachment().
 * Returns `[{ id, name, key, team, teamLabel, unattached, deployments: [id…], primary }]`: attached
 * views first in order of their first deployment, then one view per unattached deployment, under
 * its deployment id (today's id, so nothing saved breaks). The two spellings of a moved repository are one
 * workspace (repo-moves.mjs): a view takes its id and key from its first deployment, so what is saved under
 * an id holds until that deployment's own key changes. */
export function buildViews(deployments) {
  const attached = new Map(), loose = [];
  for (const d of deployments) {
    if (!d.attach || d.attach.unattached) { loose.push(d); continue; }
    const bucket = viewId(currentRepoKey(d.attach.key), d.attach.team);
    if (!attached.has(bucket)) attached.set(bucket, { id: viewId(d.attach.key, d.attach.team), key: d.attach.key, team: d.attach.team, teamLabel: d.teamLabel ?? null, members: [] });
    attached.get(bucket).members.push(d);
  }
  const views = [...attached.values()].map(v => {
    const primary = v.members.find(d => d.local) || v.members[0];
    const localName = v.members.find(d => d.local && d.name)?.name;
    return { id: v.id, name: localName || keyTail(v.key), key: v.key, team: v.team, teamLabel: v.teamLabel,
      unattached: false, deployments: v.members.map(d => d.id), primary: primary.id };
  });
  // The same key with another team is another workspace: both names say which team.
  const byKey = new Map();
  for (const v of views) byKey.set(currentRepoKey(v.key), [...(byKey.get(currentRepoKey(v.key)) || []), v]);
  for (const same of byKey.values()) {
    if (same.length < 2) continue;
    const labels = same.map(v => v.teamLabel);
    for (const v of same) {
      const label = v.team === null ? 'unmapped'
        : v.teamLabel && labels.filter(l => l === v.teamLabel).length === 1 ? v.teamLabel : v.team;
      v.name = `${v.name} · ${label}`;
    }
  }
  for (const v of views) delete v.teamLabel;
  for (const d of loose) views.push({ id: d.id, name: d.name || d.id, key: null, team: null, unattached: true, deployments: [d.id], primary: d.id });
  return views;
}
