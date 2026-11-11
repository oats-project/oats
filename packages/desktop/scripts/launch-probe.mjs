// Packaged-launch probe helpers for dist-smoke — extracted so the readiness
// logic is DETERMINISTICALLY TESTED (review ee04a44-r2: the launch logic
// shipped untested, and the ad-hoc port picking had a check-then-use race).
// Pure/injected: no Electron, no real processes.

// Phase budgets the smoke's watchdog must exceed. The launch path is the
// long pole: readiness poll + CDP evaluate, on top of inventory and the ABI
// probe (which re-execs the packaged binary and eats the same cold-start
// cost). The watchdog is DERIVED from these so it can never fire before a
// legitimately-slow-but-succeeding run completes (review ee04a44-r2
// finding 1); a test asserts WATCHDOG_MS > sum(phase budgets).
export const PHASE_BUDGET_MS = {
  inventory: 10_000,
  // The Linux glibc floor (linux-floor.mjs): unpack the DEB and the AppImage
  // and read every ELF file's version needs. A few seconds on a CI runner.
  linuxFloor: 120_000,
  // Rosetta's first x64 translation/start on a fresh arm64 CI runner can
  // exceed 30s. Keep one bounded phase budget that covers native + Rosetta.
  abiProbe: 90_000,
  // The headless backend phase (smoke-probes.mjs runBackendProbe): the
  // packaged backend's first answer (a cold start, under Rosetta on the x64
  // leg), its exit once its stdin closes (#698's lifeline), the collector run.
  backendReady: 90_000,
  backendExit: 15_000,
  collector: 60_000,
  // Phase 4b (smoke-probes.mjs runMainImportsProbe): one more start of the
  // packaged executable as Node, loading what main imports.
  mainImports: 60_000,
  launchFixture: 90_000, // bounded real-kernel fixture setup for the AppImage launch
  instanceLaunchReady: 90_000, // each fixture starts an independent app with a fresh profile
  instanceCdpEvaluate: 20_000,
  instanceObservation: 120_000, // pending-window/attach wait + native unfocused key + 35s of renderer observations
  repeatedLaunch: 90_000,
  repeatedObservation: 120_000,
  fixtureStop: 25_000, // stop plan + apply before the owned private server is reaped
  // Each launch counts viewers (5s), allows quit (5s), drains close (2s), then allows ten
  // restoration checks (500ms sleep + 5s tmux timeout each).
  launchCleanup: 70_000,
  instanceLaunchCleanup: 70_000,
  launchReady: 90_000,
  cdpEvaluate: 20_000,
};
// The stopped fixture retains its own profile and repeats the same bounded launch phases.
PHASE_BUDGET_MS.stoppedLaunches = ["launchFixture", "instanceLaunchReady", "instanceCdpEvaluate", "instanceObservation",
  "repeatedLaunch", "repeatedObservation", "instanceLaunchCleanup"].reduce((sum, key) => sum + PHASE_BUDGET_MS[key], 0);
export const PHASE_BUDGET_SUM = Object.values(PHASE_BUDGET_MS).reduce((a, b) => a + b, 0);
export const WATCHDOG_MS = PHASE_BUDGET_SUM + 30_000; // margin over the summed budgets

/** Rolling bounded tail — a pathologically noisy child must not balloon
 * memory over a 90s wait; only the tail is ever reported anyway. */
export function boundedTail(prev, chunk, max = 4096) {
  const s = prev + String(chunk);
  return s.length > max ? s.slice(-max) : s;
}

/**
 * Read the CDP port from Chromium's DevToolsActivePort file, which the app
 * writes into its --user-data-dir when launched with
 * --remote-debugging-port=0. This is RACE-FREE and IDENTITY-BINDING: the
 * port is definitionally OUR child's (review ee04a44-r2 finding 2 — a
 * pre-picked free port is check-then-use and a foreign Chromium serving a
 * matching /json target would pass). First line is the port.
 * io = { existsSync, readFileSync, sleep, now }, `childExited()` lets the
 * caller abort fast if the app died before writing the file.
 */
export async function readDevToolsPort(userDataDir, io, { timeoutMs = 90_000, pollMs = 250, childExited = () => false } = {}) {
  const file = io.join(userDataDir, "DevToolsActivePort");
  const t0 = io.now();
  while (io.now() - t0 < timeoutMs) {
    if (childExited()) return { error: "child exited before writing DevToolsActivePort" };
    if (io.existsSync(file)) {
      try {
        const lines = String(io.readFileSync(file, "utf8")).split("\n");
        const port = Number(lines[0]);
        if (Number.isInteger(port) && port > 0) return { port, wsPath: lines[1] || "" };
      } catch { /* mid-write — retry */ }
    }
    await io.sleep(pollMs);
  }
  return { error: `DevToolsActivePort not written within ${timeoutMs / 1000}s` };
}

/**
 * Resolve when the child's stdio is fully drained: Node guarantees stdio
 * completion at 'close', not 'exit' (review ee04a44-r2 finding 3 — the same
 * rule the reaper already codified). TOTAL-BOUNDED by drainMs from the call
 * (review 7bdaf1e-r2 finding 2): a still-LIVE child has no pending flush, so
 * the caller must never block on its 'close' — the timer, armed immediately,
 * guarantees the wait cannot exceed drainMs whether or not the child has
 * exited. 'close' resolves earlier when it arrives.
 */
export function awaitClose(child, { drainMs = 2000, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
  return new Promise((resolve) => {
    let done = false, timer = null;
    const finish = () => { if (done) return; done = true; if (timer !== null) ct(timer); resolve(); };
    timer = st(finish, drainMs);            // TOTAL bound, armed at call — live or exited
    child.on?.("close", finish);
  });
}
