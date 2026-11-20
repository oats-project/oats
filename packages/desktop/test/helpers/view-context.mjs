// The shell bindings the workspace-views change (#482) added to the roster functions that the
// source-extraction tests run in a vm context: the shown view's deployments (none: a window looks
// as before views), the roster sections and headings, and the re-homing seam. A test about
// re-homing passes its own `rehomeWorkspaceState`. Spec D's needs-input gate, roll-up and sentence are
// pure and shared the same way, with the tab sync's last-painted-roster state (#558).
// #982's lines that say who made a row's text or a kept failure's message (renderer/speaker-line.mjs), and the
// shared home's rule for a kept failure (deployment-facts.mjs keptFailure), are pure and shared the same way.
// #1247: the window's retires in flight. A suite about other behaviour holds none: rows are drawn as the roster
// says (`shownRows` the identity) and a read lets nothing go; a suite about them passes the shipped ones.
// A workspace switch's focus place (focus-place.mjs) is inert the same way.
// #1579: the Background section's placement, section key and heading are pure and shared the same way; a suite
// about other behaviour runs without the kernel's feature (`backgroundShown`), so nothing moves, and its sections
// are closed (`backgroundOpen`). background-sidebar.test.mjs turns the feature on.
// The disclosure (roster-disclosure.mjs, 2026-11-19) is pure and shared the same way. A suite about other behaviour
// draws every root open, as the roster did before roots started collapsed (`expandedInstances` holds every key), and
// its own `collapsedInstances` still closes rows; roster-disclosure-shell.test.mjs runs the default with a plain Set.
// Slice 1 of the Desktop UI rework: a row's two lines (packages/client roster-row-facts.mjs) are pure and shared the
// same way; the foot's count is inert (`sidebarFoot`, sidebar-foot-shell.test.mjs drives the shipped one), and the empty
// roster's line is the shipped words with no chord bound. The relations in words (D26: no drawn lines) are pure too.
// Feature instance-pin: the pin's order and mark are pure and shared the same way; a suite about other behaviour runs
// without the feature (`pinsShown`), so nothing moves and no mark is drawn, and its row menu offers no pin item.
// instance-pin-menu.test.mjs turns the feature on. The palette's Instance: Pin to top / Unpin carry their real labels
// (PIN_LABELS) and offer themselves for no target here (pinTargetOffer, asked of the palette's own target, which is
// none: paletteTargetId), so a suite that builds the palette lists neither.
import { deploymentState, rosterSections, rowStale, splitByDeployment, rosterSectionKey, sidebarSections, isMultiDeployment } from "../../../client/roster-sections.mjs";
import { siblingText } from "../../../client/instance-presentation.mjs";
import { backgroundHeading } from "../../renderer/background-heading.mjs";
import { DESKTOP_TERMS, DESKTOP_NOUNS } from "../../renderer/desktop-terms.mjs";
import { rosterRowFacts } from "../../../client/roster-row-facts.mjs";
import { PINNED, pinnedRowFor } from "../../renderer/shell-nav.mjs";
import { emptyRosterText } from "../../renderer/sidebar-foot.mjs";
import { instanceDisplayName } from "../../../client/instance-display-name.mjs";
import { deploymentHeading, notePanel, panelDeployments } from "../../renderer/view-deployments.mjs";
import { createViewMembership, rehomeMap } from "../../renderer/workspace-rehome.mjs";
import { waitingClaim, waitingSentence, waitingDetail, waitingClock } from "../../../client/waiting-on-you.mjs";
import { waitingRollup, backgroundPlacement, rowPinned } from "../../../client/instance-tree.mjs";
import { pinnedMark } from "../../renderer/instance-tree-view.mjs";
import { PIN_LABELS } from "../../renderer/instance-pin-menu.mjs";
import { rowReasonLine, runtimeErrorLine, unsupportedLine, speakerLine, keptFailureLine, heldLine } from "../../renderer/speaker-line.mjs";
import { keptFailure } from "../../../client/deployment-facts.mjs";
import { retiredTabs, tabShowsRow, otherIncarnation, terminalOrigin } from "../../renderer/retired-tabs.mjs";
import { dotColor, paintDotColor } from "../../renderer/instance-dot.mjs";
import { syncWaitingRow } from "../../renderer/waiting-row.mjs";
import { sectionChildren, collapsedRows, rowsUnder, rowDisclosure, setRowOpen, anyBelow } from "../../renderer/roster-disclosure.mjs";

/** Every root opened by hand: the roster as it was drawn before roots started collapsed. */
class AllOpen extends Set { has() { return true; } }

export const viewContext = () => ({
  pinnedRowFor, PINNED,
  contextDeployments: [], rosterSections, DESKTOP_TERMS, deploymentHeading, notePanel, panelDeployments, rowStale, deploymentState,
  rehomeMap, viewMembership: createViewMembership(), rehomeWorkspaceState() {},
  waitingClaim, waitingRollup, waitingSentence, waitingDetail, waitingClock, splitByDeployment,
  rowReasonLine, runtimeErrorLine, unsupportedLine, speakerLine, keptFailureLine, keptFailure, heldLine,
  // #1421 §2: an instance's colour on its dots (instance-dot.mjs), pure, read by the roster paint, the tab sync and a tab's open.
  dotColor, paintDotColor,
  shownRows: rows => rows, retires: { landed() {}, ids: () => new Set() },
  // A launch's --instance (launch-focus.mjs): a suite about other behaviour has no request pending; an observed read
  // tells it nothing. launch-focus.test.mjs drives the shipped one.
  launchFocus: { observe() {}, pending: () => false },
  // syncTabNeedsInput's module state (#558): the last painted roster, read when a terminal tab opens.
  // Every roster paint calls syncTabNeedsInput; a suite about other behaviour gets this no-op, and a suite
  // that extracts the shipped function by name replaces it (tab-needs-input, roster-needs-input).
  tabNeedsInputRoster: { instances: [], workspace: null }, syncTabNeedsInput() {},
  // #1502: the waiting row over a terminal pane (waiting-row.mjs), pure DOM: the tab sync draws it and closeTab ends it.
  syncWaitingRow,
  // #1237: a terminal tab's incarnation (retired-tabs.mjs) and the retired-tab rule's module state. A roster read
  // runs the rule; a suite about other behaviour gets this no-op, and retired-tabs-shell extracts the shipped one.
  retiredTabs, tabShowsRow, otherIncarnation, terminalOrigin, panelReads: 0, judgedAnswer: null, closeRetiredTabs() {},
  // A switch puts the keyboard back where it was (focus-place.mjs): a suite about other behaviour remembers no place
  // and applies none; workspace-switch-focus-shell extracts the shipped focusArrival and applyRosterPlace.
  focusPlaces: { take: () => null, note() {}, forget() {}, rehome() {} }, focusArrival() {}, applyRosterPlace() {},
  backgroundPlacement, rosterSectionKey, sidebarSections, backgroundHeading, backgroundShown: () => false, backgroundOpen: new Set(),
  setBackgroundOpen() {},
  sectionChildren, collapsedRows, rowsUnder, rowDisclosure, setRowOpen, anyBelow, expandedInstances: new AllOpen(),
  // The row menu's Move to background / out of it (instance-background-menu.mjs) offers nothing here: its gate is the
  // route's check, which a suite about other behaviour never answers. instance-background.test.mjs drives the shipped one.
  backgroundMenu: { items: () => [], handles: () => false, run: async () => {} },
  rosterRowFacts, instanceDisplayName, thisHostName: null, DESKTOP_NOUNS, isMultiDeployment, siblingText, sidebarFoot: { paint() {} }, emptyRosterLine: () => emptyRosterText(DESKTOP_NOUNS),
  // The pinned Automations row's failure mark (automations-failure.mjs): a roster read asks it; a suite about other
  // behaviour reads nothing. automations-failure.test.mjs drives the shipped reader.
  automationsFailure: { refresh: async () => {} },
  rowPinned, pinnedMark, pinsShown: () => false,
  pinMenu: { items: () => [], handles: () => false, run: async () => {} },
  PIN_LABELS, paletteTargetId: null, pinTargetOffer: () => null, runPinCommand: async () => {},
});
