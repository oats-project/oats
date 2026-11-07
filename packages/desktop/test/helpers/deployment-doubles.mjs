/** Doubles for the workspace-view functions the shipped HTTP handler (server/oats-web.mjs) calls
 * (#482; the real ones are packages/client/panel-views.mjs), over a plain list of deployments where every
 * deployment is its own one-deployment view (the view id IS the deployment id, as for an unattached
 * deployment). They mirror the real functions for that case, with the arguments the server passes:
 * - `held()`: what the server holds, here one fixed object the doubles read nothing of;
 * - `deployments(held)`: the list, read on every call (tests mutate it or count lookups);
 * - `deploymentFor(held, id, terms)`: the exact deployment, or the first one when no id is given, else null;
 * - `surfaceDeployment(held, id, request, terms)`: exact id only when the body names an instance home
 *   (`selector.home` / `spec.home`), else deploymentFor;
 * - `isServed(held, id, terms)`: the id is a listed deployment.
 * Each refuses a call that does not pass `held()` first, and the Desktop's terms where the real function
 * takes terms: a route that forgot either fails here, not only where the real function runs.
 * Tests that need real views use test/helpers/workspace-views-fixture.mjs instead. */
import assert from 'node:assert/strict';
import { checkControlRequest, controlRequestHeaders, loopbackHost } from '../../control-request.mjs';
import { TEST_CONTROL_TOKEN } from './control-auth.mjs';
import { DESKTOP_TERMS } from '../../renderer/desktop-terms.mjs';

export function deploymentDoubles(deployments) {
  const HELD = Object.freeze({});
  const passed = (held, terms) => { assert.equal(held, HELD, 'the route passes held() first'); if (terms !== passed) assert.equal(terms, DESKTOP_TERMS, 'the route passes the Desktop\'s terms'); };
  const exact = id => deployments().find(w => w.id === id);
  const first = id => (id ? exact(id) : deployments()[0]) ?? null;
  const namesInstance = request => request?.selector?.home !== undefined || request?.spec?.home !== undefined;
  return {
    checkControlRequest, controlRequestHeaders, loopbackHost, controlToken: TEST_CONTROL_TOKEN,
    held: () => HELD,
    DESKTOP_TERMS,
    deployments: held => { passed(held, passed); return deployments(); },
    deploymentFor: (held, id, terms) => { passed(held, terms); return first(id); },
    surfaceDeployment: (held, id, request, terms) => { passed(held, terms); return namesInstance(request) ? exact(id) : first(id); },
    isServed: (held, id, terms) => { passed(held, terms); return !!exact(id); },
  };
}
