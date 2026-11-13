// The machine sweep's answers (`oats session resume --json`) for tests, and the roster rows the resume trigger
// reads: built from the constants of the modules that own each shape (session-resume.mjs for the answer,
// deployment-data.mjs for `sessionEnd`, session-resume-cli.mjs for the feature), so no test spells them itself;
// the refused reasons, which no client module owns, are spelled here once.
// Hand-written from the agreed kernel contract; the deployment, homes and messages are examples.
import { RESUME_OUTCOMES } from '../../../client/session-resume.mjs';
import { SESSION_RESUME_FEATURE } from '../../../client/session-resume-cli.mjs';
import { SESSION_ENDS } from '../../../client/deployment-data.mjs';

/** The deployment a row is in unless it says another. */
export const SWEEP_DEPLOYMENT = '/home/ana/agents';
/** An accepted probe with the sweep's feature. */
export const RESUME_PROBE = Object.freeze({ ok: true, bin: '/usr/local/bin/oats', features: Object.freeze([SESSION_RESUME_FEATURE]) });
/** A `refused` row's reasons: no client module reads them; the kernel's lib/session-resume-contract.mjs ROW_REASON owns them. */
export const REFUSAL_REASONS = Object.freeze(['start-refused', 'start-refused-retrying', 'keeps-getting-lost']);

/** An instance's home in a deployment. */
export const sweepHome = (instance, deployment = SWEEP_DEPLOYMENT) => `${deployment}/agents/x/instances/${instance}`;
/** The kernel's success envelope: `rows`, `deployments`, and `extra` over the result (`plan`, say). */
export const sweepAnswer = (rows = [], deployments = [], extra = {}) =>
  ({ schemaVersion: 1, ok: true, result: { schemaVersion: 1, plan: false, deployments, rows, ...extra } });
/** A refusal envelope with its code and message. */
export const sweepRefusal = (code, message = 'm') => ({ schemaVersion: 1, ok: false, error: { code, message } });
/** A row with any `outcome` (an unknown one too): its deployment and home, then `more` over them. */
export const sweepRow = (instance, outcome, more = {}) =>
  ({ deployment: more.deployment ?? SWEEP_DEPLOYMENT, instance, home: sweepHome(instance, more.deployment), outcome, ...more });
/** A row of each outcome; `more` carries its reason, code, message or warnings. */
export const resumedRow = (instance, more) => sweepRow(instance, RESUME_OUTCOMES.resumed, more);
export const freshRow = (instance, more) => sweepRow(instance, RESUME_OUTCOMES.fresh, more);
export const blockedRow = (instance, more) => sweepRow(instance, RESUME_OUTCOMES.blocked, more);
export const refusedRow = (instance, more) => sweepRow(instance, RESUME_OUTCOMES.refused, more);
export const runningRow = (instance, more) => sweepRow(instance, RESUME_OUTCOMES.alreadyRunning, more);
export const skippedRow = (instance, more) => sweepRow(instance, RESUME_OUTCOMES.skipped, more);

/** The tag /api/panel puts on each row (panel-views.mjs deploymentTag): the deployment it belongs to. */
export const deploymentTag = (id, machine = 'This computer', path = id) => ({ id, machine, path });
/** The local deployment ids of a read (the trigger's `localDeploymentIds`): SWEEP_DEPLOYMENT alone. */
export const SWEEP_LOCAL = Object.freeze([SWEEP_DEPLOYMENT]);
/** A remote deployment's tag, as panelData gives a server's rows. */
export const REMOTE_TAG = Object.freeze(deploymentTag('remote:devbox:a1', 'devbox', '/home/alex/oats'));
/** A roster instance row (as /api/panel serves one) of SWEEP_DEPLOYMENT whose session was lost and is not
 * running; `more` over it. */
export const lostInstance = (instance, more = {}) =>
  ({ instance, home: sweepHome(instance), deployment: deploymentTag(SWEEP_DEPLOYMENT), sessionEnd: SESSION_ENDS.lost, running: false, ...more });
