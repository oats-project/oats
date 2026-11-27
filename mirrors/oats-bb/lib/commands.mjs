// The provider's session commands, as the kernel calls them: one handler per verb.
import { inspect, inspectMany } from "./inspect.mjs";
import { sendInput } from "./input.mjs";
import { launch } from "./launch.mjs";
import { bounded } from "./errors.mjs";
import { HARNESSES } from "./mode.mjs";
import { FULL_MODE_ONLY, homeSandboxWarnings, plannedLaunchFindings, readinessResult } from "./readiness.mjs";
import { readSettings } from "./settings.mjs";
import { stop } from "./stop.mjs";

const withSettings = (run) => (input, rawSettings, options) => run(input, readSettings(rawSettings), options);

/** The planned launch of a check input: `launch: {harness, yolo, args, sandbox, trees?, protected?, model?}`, there before
 *  every launch and absent on a plain readiness read. (`model`: the launch's model, from a
 *  kernel that hands the check one; a pi launch's is then checked as the launch checks it.) */
function plannedLaunch(input) {
  const planned = input !== null && typeof input === "object" ? input.launch : null;
  return planned !== null && typeof planned === "object" && !Array.isArray(planned) ? planned : null;
}

/** The handlers of the six verbs.
 *
 *  `sandboxedModes`: whether a launch in one of bb's sandboxed modes (auto, accept-edits)
 *  is taken. The provider's command takes none (false, the default, and the only value
 *  `bin/oats-bb.mjs` uses): the contract keeps bb homes in full mode until its two sides
 *  offer the sandboxed modes (bb lets a command leave the sandbox, so they are no
 *  boundary), so such a launch is refused before anything starts and the check says so.
 *  What a sandboxed launch does (the allowances, the deny rules of contract item 6c) is
 *  here and tested; the tests reach it with `true`.
 *
 *  `now`: the clock the pi model check reads to tell whether pi's configuration changed a
 *  moment ago (lib/pi-config.mjs piListMayBeOld); the tests give one of their own. */
export function sessionHandlers({ sandboxedModes = false, now = Date.now } = {}) {
  return {
    launch: (input, rawSettings, options) => launch(input, readSettings(rawSettings), { ...options, sandboxedModes, now }),
    inspect: withSettings(inspect),
    inspectMany: withSettings(inspectMany),
    input: withSettings(sendInput),
    stop: withSettings(stop),
    // input: {home | null, soul | null, settings?, launch?: {harness, yolo, args, sandbox}}.
    // bb's own state depends on the settings alone. With the planned launch the kernel
    // hands it, the check also says what that launch would be refused for and would write.
    check: async (input, rawSettings, options) => {
      const planned = plannedLaunch(input);
      const settings = readSettings(rawSettings);
      const home = input !== null && typeof input === "object" ? input.home : null;
      // bb runs each harness with a provider of its own: the planned launch says whose state
      // must be ready. A harness the provider does not run is the planned launch's own finding.
      const harness = planned !== null && HARNESSES.includes(planned.harness) ? planned.harness : null;
      const { result } = await readinessResult(settings, { ...options, harness, model: planned?.model, home, now, extra: planned ? plannedLaunchFindings(planned, { sandboxedModes, settings, home }) : undefined });
      // For a home, what its own settings say of the sandbox (a report only). Where no
      // sandboxed launch is taken, the provider wrote none of it, and says nothing of it.
      if (sandboxedModes) result.warnings.push(...homeSandboxWarnings(home));
      // With no planned launch the check cannot know the mode a launch would run in: it
      // says what the command launches in, so `oats readiness` does not read "ready" and
      // the spawn that follows is then refused with nothing having said why.
      if (planned === null && !sandboxedModes) result.warnings.push({ ...FULL_MODE_ONLY });
      // The last word on every line of the answer: cut to what the kernel relays.
      result.warnings = result.warnings.map(({ code, message }) => ({ code, message: bounded(message) }));
      return result;
    },
  };
}
