/** The agent view's link to the shell (S2-D): which terminal tab shows the board, and the two reads the view makes
 * while it is open. Every roster paint calls `sync` for each terminal tab (shell.mjs syncTabNeedsInput) with the row
 * the tab shows and its gated claim; `sync` answers whether the tab's waiting row gives way to the question zone.
 *
 * The reads, both only while a tab shows a board, and each with a latest-intent token checked on success and on
 * rejection (a read answered after a newer one began, or after the tab closed, changes nothing):
 *  - the board's detail (`oats inspect --home <h> --board`, through the existing inspect boundary): each fact's
 *    history for its sparkline, each question's context. Read when the view opens and when the board changes.
 *  - the agent's claims (`waitingClaims`, through the existing instance-events read): whether a harness dialog is on
 *    its screen. The row's `waitingOnYou` is the newest claim that carries a message, so the board's own claim (its
 *    message is the question) can stand in front of a harness's `permission` claim with none. Read when the view
 *    opens with a question and when the row's claim or questions change.
 * Unknown (a read refused or failed) is never a dialog, and never history: the view shows what the row says. */
import { createAgentBoard, createHiddenFacts } from './agent-board.mjs';
import { rowHasBoard, boardClaim, detailSignature, boardDetailData } from '../../client/instance-board.mjs';
import { eventsSelector } from '../../client/instance-events-contract.mjs';

/**
 * @param {object} o
 * @param {() => string[] | null} o.features   this computer's CLI features (the probe)
 * @param {() => boolean} o.eventsReadable    whether this computer's CLI serves the events read (eventsApi 2)
 * @param {(path: string, body: object) => Promise<object>} o.post   a POST to the backend
 * @param {(url: string) => void} o.openLink
 * @param {ReturnType<typeof createHiddenFacts>} [o.hidden]
 */
/** The deployment a row belongs to (#482): its `deployment.id`, else the tab's workspace. An instance-addressed read
 * names the row's own deployment, never the window's view. */
const rowDeployment = (row, workspace) => typeof row?.deployment?.id === 'string' && row.deployment.id ? row.deployment.id : workspace;

export function createTabBoards({ features, eventsReadable = () => false, post, openLink, hidden = createHiddenFacts(), now }) {
  const states = new WeakMap(); // tab record -> { view, detailSeq, claimsSeq, detailSig, claimsSig, claims }

  function open(tab, row) {
    const state = { view: null, detailSeq: 0, claimsSeq: 0, detailSig: null, claimsSig: null, claims: [], alive: true, home: row.home };
    state.view = createAgentBoard({ pane: tab.paneEl, home: row.home, name: row.instance,
      type: text => tab.typeText?.(text) === true, focusTerminal: () => tab.focusTerminal?.(), openLink, hidden, ...(now ? { now } : {}),
      // Before a number types: the claims again, read now (null when unknown).
      checkClaims: async () => { const claims = await readClaims(state, state.workspace, state.row); return claims && [state.claim, ...claims]; } });
    states.set(tab, state);
    return state;
  }
  function close(tab) {
    const state = states.get(tab);
    if (!state) return;
    state.alive = false; state.detailSeq++; state.claimsSeq++;
    state.view.dispose(); states.delete(tab);
  }

  async function readDetail(state, view, row) {
    const workspace = rowDeployment(row, view);
    const seq = ++state.detailSeq;
    const owns = () => state.alive && state.detailSeq === seq;
    try {
      const answer = await post(`/api/capabilities?ws=${encodeURIComponent(workspace)}`, { action: 'inspect', selector: { home: row.home }, board: true });
      if (owns()) state.view.detail(boardDetailData(answer));
    } catch {
      // Refused or failed: the view says so (agent-board.mjs DETAIL_NOTES), never "no history".
      if (owns()) state.view.detail({ state: 'failed' });
    }
  }
  async function readClaims(state, view, row) {
    const workspace = rowDeployment(row, view);
    const seq = ++state.claimsSeq;
    const owns = () => state.alive && state.claimsSeq === seq;
    const selector = eventsSelector({ instance: row.instance, agent: row.agent, agentsRoot: row.agentsRoot, server: row.server ?? null });
    if (!selector || !eventsReadable()) { state.claims = []; return null; }
    let claims = null;
    try {
      const answer = await post(`/api/instance-events?ws=${encodeURIComponent(workspace)}`, { action: 'read', selector, limit: 50 });
      claims = answer?.status === 'available' && Array.isArray(answer.data?.waitingClaims) ? answer.data.waitingClaims : null;
    } catch { claims = null; }
    // The answer is this read's own (a press waits on it); only the latest read paints.
    if (owns()) { state.claims = claims ?? []; state.view.update(state.board, { claims: [state.claim, ...state.claims] }); }
    return claims;
  }

  return {
    /** The board on `tab` for `row` (the one row the tab shows, or null) and its gated `claim`. True when the waiting
     * row gives way: the claim is the board's own and the zone shows its questions. */
    sync(tab, row, claim, workspace) {
      let state = states.get(tab);
      if (!row || !rowHasBoard(row, features()) || (state && state.home !== row.home)) { close(tab); state = null; }
      if (!row || !rowHasBoard(row, features())) return false;
      const fresh = !state;
      state ??= open(tab, row);
      state.board = row.board ?? null; state.claim = claim ?? null; state.row = row; state.workspace = workspace;
      state.view.update(state.board, { claims: [state.claim, ...state.claims] });
      // History and context: when the view opens, and again when a fact's `at` changes or a question with context is
      // asked (instance-board.mjs detailSignature); never on an unchanged poll.
      const sig = detailSignature(state.board);
      if ((fresh || sig !== state.detailSig) && state.board && (state.board.facts.length || state.board.questions.some(q => q.hasContext))) {
        state.detailSig = sig; void readDetail(state, workspace, row);
      } else if (fresh || sig !== state.detailSig) state.detailSig = sig;
      // The claims: while a question is open, when the view opens and when the claim or the questions change.
      const claimsSig = JSON.stringify([state.board?.questions.map(q => q.id) ?? [], claim?.producer ?? null, claim?.reason ?? null, claim?.since ?? null]);
      if (state.board?.questions.length && (fresh || claimsSig !== state.claimsSig)) { state.claimsSig = claimsSig; void readClaims(state, workspace, row); }
      else if (!state.board?.questions.length) { state.claimsSig = claimsSig; state.claims = []; }
      return boardClaim(claim) && state.view.question !== null;
    },
    close,
    /** The person's input in the tab's terminal (its xterm onData). */
    input(tab, data) { states.get(tab)?.view.input(data); },
    /** Alt+T in `tab`: terminal → questions → facts → terminal. False when the tab shows no board. */
    cycleFocus(tab) { return states.get(tab)?.view.cycleFocus() ?? false; },
    /** Puts `tab`'s strip and zone either side of its terminal (after the shell appended the terminal). */
    place(tab) { states.get(tab)?.view.place(); },
    /** Whether `tab` shows the board now. */
    shows(tab) { return states.get(tab)?.view.shown === true; },
  };
}
