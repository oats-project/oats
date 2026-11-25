/* The sidebar's foot (the Desktop UI rework, slice 1): "N need you" at the left (hidden at 0; activating it focuses the
   first row that needs you), then at the right ? (the keyboard shortcuts); New <instance> (Quick Open, the spawn flow)
   sits at the roster's end since slice 3d, as the prototype has it, and is painted here too. Its words name the agent noun through DESKTOP_NOUNS (desktop-terms.mjs), so a new word is one line there;
   the empty roster's line is built here too, for the same reason. The buttons run their registry actions (shell.mjs);
   this module paints them. */
import { iconElement } from "./shell-icons.mjs";

/** "New agent": the spawn button at the roster's end. */
export const newLabel = (nouns) => `New ${nouns.instance}`;
/** The visible count: "3 need you". */
export const needYouText = (count) => `${count} need you`;
/** The count's accessible name: "3 agents need you", "1 agent needs you", and what activating it does. */
export const needYouName = (count, nouns) => `${count} ${count === 1 ? `${nouns.instance} needs` : `${nouns.instances} need`} you. Go to the first`;
/** The empty roster: "No agents yet · Alt+P starts one", with the spawn action's chord when it has one. */
export const emptyRosterText = (nouns, chord = "") => `No ${nouns.instances} yet${chord ? ` · ${chord} starts one` : ""}`;

/** Wire `#sidebar-need-you` (the foot's count) and paint `#sidebar-spawn` (New agent, at the roster's end) in `doc`. `onNeedYou()` runs on the count's
 * activation. Returns { paint(count) }: the count of the current workspace's rows that need you (0 hides it). */
export function createSidebarFoot(doc, { nouns, onNeedYou = () => {} }) {
  const need = doc.getElementById("sidebar-need-you"), spawn = doc.getElementById("sidebar-spawn");
  if (spawn) {
    const plus = iconElement(doc, "plus", { size: 14 });
    const label = doc.createElement("span"); label.textContent = newLabel(nouns);
    spawn.replaceChildren(plus, label);
    spawn.setAttribute("aria-label", newLabel(nouns)); spawn.title = newLabel(nouns);
  }
  let shown = null;
  if (need) need.addEventListener("click", () => onNeedYou());
  return {
    paint(count) {
      if (!need) return;
      const n = Number.isSafeInteger(count) && count > 0 ? count : 0;
      if (n === shown) return;
      shown = n;
      need.hidden = n === 0;
      if (!n) { need.replaceChildren(); need.removeAttribute("aria-label"); return; }
      const mark = iconElement(doc, "attention", { size: 10, className: "shell-icon attn-mark" });
      const words = doc.createElement("span"); words.textContent = needYouText(n);
      need.replaceChildren(mark, words);
      need.setAttribute("aria-label", needYouName(n, nouns));
    },
  };
}
