/** The Desktop's own terms (packages/client/client-terms.mjs): the words the shared sentence tables use
 * where a sentence names the client that shows it. Said once, here; main, the backend and the page import
 * this module and pass `DESKTOP_TERMS` at every call of a table that takes terms. Code that asks whether
 * a label is this machine's compares against `DESKTOP_TERMS.thisMachine`.
 * In `renderer/` because the page loads modules from here and from the shared home only. */
import { clientTerms } from '../../client/client-terms.mjs';

export const DESKTOP_TERMS = clientTerms({
  name: 'Desktop',            // "… than Desktop can show."
  self: 'this Desktop',       // "… a workspace this Desktop can't read."
  selfInitial: 'This Desktop', // "This Desktop can't read …"
  update: 'OATS Desktop',     // "Update OATS Desktop."
  thisMachine: 'This Mac',    // a deployment that names no machine; also on Linux, for now
});

/** The Desktop's noun for what an agent runs as, on its primary surface (the Desktop UI rework, slice 1; D3 decided:
 * "agent"): every string slice 1 owns reads it from here (the foot's "N need you" name and "New …", the empty roster).
 * The CLI and the docs keep "instance": this is the one place that maps the two, so another word is a change of this
 * one line. Not a client term: client-terms.mjs is the shared five-key contract with the Terminal UI, and this word is
 * the Desktop's own. */
export const DESKTOP_NOUNS = Object.freeze({ instance: 'agent', instances: 'agents' });
