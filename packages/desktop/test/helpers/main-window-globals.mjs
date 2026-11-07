// The globals main's api handler uses for window-bound requests (#481), for tests that run the shipped
// handler in a vm. A test's own values win; `advertisedNow` reads the context's live allowedWs (the
// handler reassigns it), else its advertisedBefore, as main does.
import { createControlFetch } from '../../control-fetch.mjs';
import { TEST_CONTROL_TOKEN } from './control-auth.mjs';
import { frameWorkspace } from '../../renderer/window-binding.mjs';
import { windowRefusal } from '../../api-url.mjs';
import { scopedRequest } from '../../renderer/workspace-routes.mjs';
import { workspaceNotServed } from '../../renderer/deployment-header.mjs';

export function withWindowGlobals(context) {
  return Object.assign(context, {
    controlFetch: createControlFetch(TEST_CONTROL_TOKEN, (...args) => context.fetch(...args)),
    frameWorkspace, windowRefusal, scopedRequest, workspaceNotServed, noteServed() {}, panelWorkspaces: async () => null, servedList: [],
    // No window is one main knows has no workspace (a chooser) unless a test says so.
    choosers: new Set(), BrowserWindow: { fromWebContents: () => null },
    advertisedNow: () => (context.allowedWs?.size ? context.allowedWs : context.advertisedBefore ?? new Set()),
  }, Object.fromEntries(['controlFetch', 'frameWorkspace', 'windowRefusal', 'workspaceNotServed', 'noteServed', 'advertisedNow', 'panelWorkspaces', 'servedList', 'choosers', 'BrowserWindow', 'scopedRequest']
    .filter((name) => Object.hasOwn(context, name)).map((name) => [name, context[name]])));
}
