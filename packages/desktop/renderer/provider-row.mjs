/* oats desktop — a roster row that runs on a session provider (a capability's session backend, "bb" say), as
   the Desktop shows it. Pure. Whether a row is one, its sentence and its link are the shared home's
   (packages/client/instance-acts.mjs `openAct`, its reason `no-terminal`); this module reads that answer for the
   places that draw it: the roster row, its context menu, its tooltip and the instance panel's Session line.

   Such a row has no tmux target and no terminal: the Desktop opens, splits, restores and attaches nothing for it
   (instance-tree-view.mjs `resolveTerminalOpen` refuses it before any tab or key is decided; retired-tabs.mjs
   closes a tab left on one). What the provider offers instead is a link, shown as an external link and opened in
   the system browser through the window's own handler (main.mjs setWindowOpenHandler: http and https only). */
import { openAct } from "../../client/instance-acts.mjs";
import { sessionProvider, sessionThreadId } from "../../client/instance-presentation.mjs";
import { displayLine, DETAIL_WITHHELD } from "../../client/display-text.mjs";

/** A value as one display line, or null when it is no text, has nothing to show or is withheld. */
export const shown = (value) => {
  const line = typeof value === "string" ? displayLine(value) : null;
  return line && line !== DETAIL_WITHHELD ? line : null;
};

/** Why `row` has no terminal to open, when it runs on a session provider: `{ sentence, link }`, the shared
 * home's own sentence ("Runs in a bb thread; open it in bb.") and the provider's link, `{ label, url }` with the
 * label as one display line, or null when the row carries none or its label has nothing to show. Null for every
 * other row, and for a provider row the kernel holds or does not report addressable: that row says its own reason. */
export function noTerminal(row) {
  const reason = row !== null && typeof row === "object" ? openAct(row)?.reason : null;
  if (reason?.code !== "no-terminal") return null;
  const label = reason.link ? shown(reason.link.label) : null;
  return { sentence: reason.sentence, link: label ? { label, url: reason.link.url } : null };
}

/** Where the row's session runs, in one line for the instance panel's Session card and the row's tooltip:
 * `tmux · <session>` for a row with a recorded tmux session, `<provider> · thread <id>` for a provider row whose
 * row names its thread (`session.threadId`, this machine's rows only; `<provider>` alone without one), '' for a row that reports neither. Display only:
 * the provider (the row's `backend`) and the thread id through the display filter; neither addresses anything. A
 * provider row whose `backend` has nothing to show reads `session provider`. */
export function sessionLine(row) {
  const provider = sessionProvider(row);
  if (provider) {
    const name = shown(provider) ?? "session provider", thread = shown(sessionThreadId(row));
    return thread ? `${name} · thread ${thread}` : name;
  }
  return typeof row?.tmux?.session === "string" && row.tmux.session ? `tmux · ${row.tmux.session}` : "";
}
