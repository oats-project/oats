// The globals shell.mjs functions use for one window per workspace (#481), for tests that run them in a
// vm: a window bound to its workspace (never choosing) and a bridge with no window channels. A test's
// own values win.
//
// Slice 6a (pages as tabs, Details, the rail): the shell's seams a function under test may call that the test does
// not exercise, as inert doubles. A test that runs the real one extracts it (a function declaration in the vm script
// overrides the double); a test's own values win too.
export const shellSliceDoubles = () => ({
  rosterModelChanged() {}, updateRail() {}, showEmptyState() {}, hideEmptyState() {},
  openDetailsTab: () => false, detailsTarget: () => null,
  takePageTabs: () => [], closePageTabs() {}, reopenPageTabs: async () => {}, pageOpens: new Map(),
  openViewTab: async () => {},
});
export function withShellWindowGlobals(context) {
  const defaults = { windowState: () => 'bound', desktopBridge: {}, ...shellSliceDoubles() };
  return Object.assign(context, defaults,
    Object.fromEntries(Object.keys(defaults).filter((name) => Object.hasOwn(context, name)).map((name) => [name, context[name]])));
}
