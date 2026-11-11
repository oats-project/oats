/** `oats doctor`'s `retire-incomplete` problems (oats-project/oats#1747): one per instance home whose
 *  retirement was left open, with the command that finishes it and the capability whose retire hook
 *  failed last, so the operator knows whose service to check.
 *
 *  A retirement is open when the home's status row reads a quarantine (`rollbackIncomplete`, never
 *  a spawn still in progress), when its `retire.state` is `failed` or `interrupted`, or when a
 *  failed self-retire left its outcome beside it. A home whose retire is `running` or `unknown` is
 *  not listed: a retire may be under way, or cannot be read. An outcome whose home is gone is not
 *  an open retirement either: a home is removed only once its hooks proved clean or `--force` took
 *  over the debt, and `oats status` still lists the outcome.
 *
 *  Read with the readers `oats status` uses (openRetirements, lib/instance-listing.mjs): read-only
 *  and offline, no claim taken, no file removed, nothing signalled. */
import { openRetirements } from "./instance-listing.mjs";
import { shellWord } from "./shell-word.mjs";

export const RETIRE_INCOMPLETE = "retire-incomplete";

/** The capabilities a failed outcome's items name as `retire hook <capability>: …`, in order. */
function hooksNamedIn(items) {
  const caps = [];
  for (const item of Array.isArray(items) ? items : []) {
    const m = typeof item === "string" && /^retire hook ([^\s:]+): /.exec(item);
    if (m && !caps.includes(m[1])) caps.push(m[1]);
  }
  return caps;
}
const list = (items) => items.join(", ");

/** What a quarantine marker owes, as the clauses of a message; the hooks it owes; and the hooks its
 *  latest attempt left incomplete (`latest`). */
function quarantineOwes(marker) {
  const owed = marker?.cleanup?.outstanding;
  if (!owed || typeof owed !== "object") return { said: ["it is quarantined, and its quarantine marker cannot be read"], hooks: [], latest: hooksNamedIn(marker?.incomplete) };
  const hooks = Array.isArray(owed.hooks) ? owed.hooks.filter((h) => typeof h === "string" && h) : [];
  const git = Array.isArray(owed.git) ? owed.git.filter((g) => typeof g === "string" && g) : [];
  const debts = [
    ...(hooks.length ? [`retire hooks of ${list(hooks)}`] : []),
    ...(git.length ? [`Git steps (${list(git)})`] : []),
    ...(owed.directory === true ? ["the preservation of its directory"] : []),
    ...(owed.orphanedWork === true ? ["its orphaned work directory"] : []),
  ];
  const at = [marker.lastRetryAt, marker.createdAt].find((t) => typeof t === "string" && t);
  // `outstanding` is what the quarantine first owed, and a retry does not rewrite it; `incomplete`
  // is what its latest attempt left, which names the hook that failed last.
  return { said: [`it is quarantined${debts.length ? `, owing ${debts.join(" and ")}` : ""}${at ? ` (since ${at})` : ""}`], hooks, latest: hooksNamedIn(marker.incomplete) };
}

/** The `retire-incomplete` problem of one home, or null when its retirement is not open. */
function problemOf(row, failures) {
  const state = row.retire?.state;
  if (state === "running" || state === "unknown") return null;
  if (!row.rollbackIncomplete && state !== "failed" && state !== "interrupted" && !failures.length) return null;
  const said = [];
  let owed = [], latest = [];
  if (row.rollbackIncomplete) {
    const owes = quarantineOwes(row.rollbackIncomplete);
    said.push(...owes.said);
    owed = owes.hooks;
    latest = owes.latest;
  }
  if (state === "failed") {
    const why = row.retire.message ?? (failures.some((f) => f.incomplete) ? "its cleanup did not finish" : undefined);
    said.push(`its self-retire failed at ${row.retire.since}${row.retire.code ? ` (${row.retire.code})` : ""}${why ? `: ${why}` : ""}`);
  }
  else if (state === "interrupted") said.push(`its self-retire, requested at ${row.retire.since}, was interrupted: its completion ended without an outcome`);
  for (const f of failures) {
    if (f.error === "unreadable result file") said.push(`its result file ${f.resultPath} cannot be read`);
    // A failure the row's `failed` state already said is said once.
    else if (state !== "failed") said.push(`its self-retire failed at ${f.completedAt ?? "an unknown time"}${f.error ? `: ${f.error}` : f.incomplete ? ": its cleanup did not finish" : ""}`);
  }
  if (row.record === "unreadable") said.push(`its record ${row.recordSaid}`);
  // The hook that failed last: as the quarantine's latest attempt names it, else as the outcome's
  // items do, else the hooks the quarantine owes.
  const named = failures.flatMap((f) => hooksNamedIn(f.incomplete)).filter((cap, i, all) => all.indexOf(cap) === i);
  const hooks = latest.length ? latest : named.length ? named : owed;
  const command = `oats retire ${shellWord(row.instance)} --home ${shellWord(row.home)}`;
  const remedy = hooks.length
    ? `check the service of ${list(hooks)}, whose retire hook failed last, then run: ${command}`
    : `no failed retire hook is recorded; run: ${command}`;
  return { code: RETIRE_INCOMPLETE, message: `the retirement of ${row.instance} (${row.home}) is not finished: ${said.join("; ")}`, remedy };
}

/** Every `retire-incomplete` problem of the deployment whose agents root is `root`, ordered by soul
 *  and home. [] when no retirement is open. */
export function retireIncompleteProblems(root) {
  const problems = [];
  for (const agent of openRetirements(root)) {
    const homes = [...agent.homes].sort((a, b) => (a.home < b.home ? -1 : a.home > b.home ? 1 : 0));
    for (const row of homes) {
      const problem = problemOf(row, agent.retireFailures.filter((f) => f.instance === row.instance));
      if (problem) problems.push(problem);
    }
  }
  return problems;
}
