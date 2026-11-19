/* A roster row's facts for its native tooltip (the Desktop UI rework, slice 1: an interim the lead agreed while the
   instance panel serves only a row with its terminal open). The repository, the branch, and the harness and model:
   what the removed hover card said that the row's two lines don't. One line, the row's own reported facts, nothing
   guessed; '' when it reports none. Display only: each value through the display filter (display-text.mjs), so no
   withheld or multi-line text reaches the tooltip. */
import { instanceRepoLabel } from "../../client/instance-tree.mjs";
import { displayLine, DETAIL_WITHHELD } from "../../client/display-text.mjs";
import { harnessName } from "./identity-marks.mjs";
import { sessionProvider } from "../../client/instance-presentation.mjs";
import { sessionLine } from "./provider-row.mjs";

const shown = (value) => {
  const line = typeof value === "string" ? displayLine(value) : null;
  return line && line !== DETAIL_WITHHELD ? line : null;
};

/** "Repository: oats · Branch: b/x · Claude · opus", or the parts the row reports. A row on a session provider adds
 * where it runs, "bb · thread thr_x" (provider-row.mjs `sessionLine`): it never has a terminal, so no panel says it. */
export function rowFactsTitle(row) {
  const repo = shown(instanceRepoLabel(row)), branch = shown(row?.branch);
  const harness = shown(row?.harness), model = shown(row?.model);
  return [repo && `Repository: ${repo}`, branch && `Branch: ${branch}`,
    harness && [harnessName(harness), model].filter(Boolean).join(" · "),
    sessionProvider(row) && sessionLine(row)].filter(Boolean).join(" · ");
}
