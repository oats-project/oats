/* oats desktop — resume lost sessions (main).

   The shared trigger (packages/client/session-resume-trigger.mjs) decides when the kernel's machine sweep
   `oats session resume --json` runs; the Desktop owns no session: the kernel resumes them. This module is
   that trigger's wiring in main, with main's IO injected: the reading's routing. main.mjs only builds it, arms
   it with `launch()` after the startup's deployments-list step settles (its first run imports the Desktop's
   saved deployments into the machine registry the sweep reads), and hands it each accepted /api/panel reply's
   instance rows with `observed()`.

   - A sweep's child is the runner's default exec's (file-output-exec.mjs: detached, output in files):
     nothing here holds it, so quitting Desktop never cancels it. Never add the trigger to shutdown(), the
     terminal broker or the server's lifetime; `dispose()` is for tests and the TUI.
   - The Desktop shows nothing of a sweep (the product owner, 2026-10-27): every reading but `failed` is
     dropped. `failed` logs one line with its code only: no kernel text is logged. */

import { aboveTestedRefusal } from "../client/above-tested.mjs";

const CODE = /^E_[A-Z0-9_]{1,64}$/;

/**
 * The trigger, built with main's reading routing; returns what `createTrigger` made.
 * @param {object} io
 * @param {(options: object) => object} io.createTrigger  createResumeTrigger (its run and read are its defaults)
 * @param {() => object|null|Promise<object|null>} io.cli  the settled CLI probe, or null
 * @param {(line: string) => void} io.error                a failed sweep
 */
export function createResumeWiring({ createTrigger, cli, error }) {
  // Above the tested bound (oats-project/oats#1879) the sweep is held back: the trigger is handed no probe,
  // so nothing runs, and one line names the refusal's code, once until the CLI is back within the bound.
  let skipped = false;
  const gate = (probe) => {
    const refused = aboveTestedRefusal(probe, "main session-resume");
    if (!refused) { skipped = false; return probe; }
    if (!skipped) { skipped = true; error(`oats-desktop: the session resume sweep was skipped: ${refused.code}`); }
    return null;
  };
  return createTrigger({
    // A sync probe stays sync (the trigger runs a sweep in the same call); a promise is gated when it settles.
    cli: () => {
      let probe;
      try { probe = cli(); } catch { return null; }
      return typeof probe?.then === "function" ? probe.then(gate, () => null) : gate(probe);
    },
    onReading(reading) {
      if (reading?.kind === "failed") error(`oats-desktop: the session resume sweep failed: ${typeof reading.code === "string" && CODE.test(reading.code) ? reading.code : "E_CLI_PROTOCOL"}`);
    },
  });
}
