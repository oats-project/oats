/** Workspace-scoped endpoints: the roster/agents/brain reads, the path-addressed start and restart, AND the
 * body-addressed instance and workspace families. The server resolves instance names per workspace, and
 * same-named instances exist across workspaces.
 * Shared by main (api-url.mjs pins and refuses by it) and the renderer (a window with no workspace
 * sends none of these, #481). */
export function workspaceScoped(pathname) {
  return pathname === "/api/panel" || pathname === "/api/agents" || pathname === '/api/spawn' || pathname === '/api/automations'
    || pathname === '/api/team-members'
    || /^\/api\/(?:instance|workspace)-[a-z-]+$/.test(pathname) // entire body-addressed scoped families
    || /^\/api\/(?:brain|start|restart)\//.test(pathname);
}

/** Is a renderer api() path a workspace-scoped request (resolved as main resolves it)? */
export function scopedRequest(pathname) {
  if (typeof pathname !== 'string') return false;
  try { return workspaceScoped(new URL(pathname, 'http://desktop.invalid').pathname); } catch { return false; }
}
