// The mode a launch runs in, and what that mode needs of the sandbox: read by the launch
// and by the readiness check of a planned launch, so both answer the same.
import { fail } from "./errors.mjs";
import { gapList, missingRemedy } from "./local-settings.mjs";

// Claude Code's own permission-mode words, as a launch configuration writes them.
const PERMISSION_ARG = { auto: "auto", acceptEdits: "accept-edits", bypassPermissions: "full" };

/** bb's permission mode for the launch.
 *
 *  | the launch                                   | bb           |
 *  |----------------------------------------------|--------------|
 *  | yolo true                                    | full         |
 *  | yolo false, or no choice                     | accept-edits |
 *  | --permission-mode auto (launch configuration)| auto         |
 *  | --permission-mode acceptEdits                | accept-edits |
 *  | --permission-mode bypassPermissions          | full         |
 *
 *  `--permission-mode` is the one launch argument this backend can carry; any other is
 *  refused by name (bb starts Claude itself, so an argument has nowhere to go and is never
 *  dropped). Where yolo and the argument disagree (yolo with a mode that is not full; no
 *  yolo with bypassPermissions) the launch is refused: the provider never picks one, and
 *  never runs more permissively than the same launch would on tmux Claude.
 *
 *  For pi (`harness` "pi") no launch argument is carried at all, `--permission-mode`
 *  included: bb starts pi itself, with its own arguments, and bb's pi has one mode. Only
 *  yolo chooses: true is full, anything else is accept-edits, which the launch then
 *  refuses (piModeRefusal). */
export function permissionMode(args, yolo, harness = "claude") {
  if (args !== undefined && args !== null && !Array.isArray(args)) throw fail("E_BACKEND_LAUNCH_ARG", "the launch args must be a list");
  if (yolo !== true && yolo !== false && yolo !== null && yolo !== undefined) throw fail("E_SESSION_START_FAILED", "the launch input's yolo must be true, false or null");
  let mode = null;
  const list = args ?? [];
  if (harness === "pi") {
    if (list.length > 0) throw fail("E_BACKEND_LAUNCH_ARG", `the bb backend cannot carry the launch argument ${JSON.stringify(list[0])}${list.length > 1 ? ` (nor the ${list.length - 1} after it)` : ""}: bb starts pi itself, with its own arguments, and carries none of a launch's for pi. Remove ${list.length > 1 ? "them" : "it"} from the launch configuration or the capability that adds ${list.length > 1 ? "them" : "it"}`);
    return yolo === true ? "full" : "accept-edits";
  }
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    let value = null;
    if (arg === "--permission-mode" && typeof list[i + 1] === "string") { value = list[i + 1]; i += 1; }
    else if (typeof arg === "string" && arg.startsWith("--permission-mode=")) value = arg.slice("--permission-mode=".length);
    else throw fail("E_BACKEND_LAUNCH_ARG", `the bb backend cannot carry the launch argument ${JSON.stringify(arg)}: bb starts Claude Code itself. Remove it from the launch configuration or the capability that adds it (the one argument carried is --permission-mode auto|acceptEdits|bypassPermissions)`);
    if (!Object.hasOwn(PERMISSION_ARG, value)) throw fail("E_BACKEND_LAUNCH_ARG", `the bb backend cannot carry --permission-mode ${JSON.stringify(value)}: bb's modes are auto, accept-edits (acceptEdits) and full (bypassPermissions)`);
    if (mode !== null && mode !== PERMISSION_ARG[value]) throw fail("E_BACKEND_LAUNCH_ARG", "the launch names --permission-mode twice, with different modes");
    mode = PERMISSION_ARG[value];
  }
  if (mode === null) return yolo === true ? "full" : "accept-edits";
  if (yolo === true && mode !== "full") throw fail("E_BACKEND_LAUNCH_ARG", `the launch asks for yolo and for --permission-mode ${Object.keys(PERMISSION_ARG).find((key) => PERMISSION_ARG[key] === mode)}, which disagree: drop one`);
  if (yolo === false && mode === "full") throw fail("E_BACKEND_LAUNCH_ARG", "the launch asks for no yolo and for --permission-mode bypassPermissions, which disagree: drop one");
  return mode;
}

export const HARNESSES = Object.freeze(["claude", "pi"]);
// bb's own name for the provider that runs each harness (`bb thread spawn --provider`,
// and the `providerId` of a thread's row and of bb's provider state).
export const BB_PROVIDER = Object.freeze({ claude: "claude-code", pi: "pi" });

/** Why this provider cannot run the harness, or null. → {code, message} | null. */
export function harnessRefusal(harness) {
  if (typeof harness === "string" && HARNESSES.includes(harness)) return null;
  return { code: "E_BACKEND_HARNESS", message: `the bb backend runs ${HARNESSES.join(" and ")} only, not ${JSON.stringify(harness)}` };
}

/** Why a pi launch cannot run in this mode, or null. bb's pi has one permission mode,
 *  full (bb's own declaration: bb answers a spawn or a tell in another with "Provider pi
 *  only supports full permission mode"), and pi has no sandbox. So this stands whatever
 *  the provider's command offers for Claude. → {code, message} | null. */
export function piModeRefusal(mode) {
  if (mode === "full") return null;
  return { code: "E_BACKEND_SANDBOXED_MODE", message: `this launch would run in bb's ${mode} mode, and bb runs pi in its full mode only (pi has no permission prompts and no sandbox). Launch in full mode: spawn or start with --yolo. Nothing was started` };
}

/** Why the provider's command does not launch in this mode (not offered), or null. bb's sandboxed modes
 *  (auto, accept-edits) are not a boundary: bb lets a command ask to run outside the
 *  sandbox, and such a command writes past the rules a sandboxed launch writes (contract
 *  item 6c, rule 4). The contract keeps bb homes in full mode, which claims no boundary,
 *  until its two sides offer the sandboxed modes; the rules themselves are here and tested.
 *  → {code, message} | null (the launch and the readiness check share it). */
export function sandboxedModeRefusal(mode) {
  if (mode === "full") return null;
  return { code: "E_BACKEND_SANDBOXED_MODE", message: `this launch would run in bb's ${mode} mode, a sandboxed mode, and the bb backend launches in bb's full mode only: sandboxed modes are not offered (bb lets a command leave its sandbox, so they are no boundary between an agent and your account). Launch in full mode: spawn or start with --yolo (or a launch configuration's --permission-mode bypassPermissions). Nothing was started` };
}

/** Why a launch of this harness is not taken in this mode, or null: the one answer the
 *  launch and the readiness check of a planned launch share. `sandboxedModes`: whether the
 *  command takes Claude launches in bb's sandboxed modes (the tests' entry only). */
export function modeRefusal(mode, harness, { sandboxedModes = false } = {}) {
  if (harness === "pi") return piModeRefusal(mode);
  return sandboxedModes ? null : sandboxedModeRefusal(mode);
}

/** Why a launch in this mode cannot have the sandbox it needs, or null. A sandboxed launch
 *  that would lack a host OATS's own commands reach is refused before anything starts:
 *  the agent's messaging would be cut off inside the sandbox. Full mode has no sandbox, so
 *  there neither a gap nor an unresolved configuration changes anything. Optional rows
 *  never refuse, and neither does a team other than the soul's default: the agent's own
 *  team is served, and readiness says what it cannot do for the other. → {code, message} | null (the launch and the readiness check share it). */
export function sandboxRefusal(mode, allowances) {
  if (mode === "full") return null;
  if (allowances.unavailable !== null) {
    // The remedy before the cause: the kernel relays 500 characters.
    return { code: "E_BACKEND_SANDBOX_UNAVAILABLE", message: `this launch runs in bb's ${mode} mode, whose sandbox must be told which hosts and paths OATS's own commands reach, and the deployment's configuration could not be resolved for it. Fix the cause, or launch in full mode (--yolo). Cause: ${allowances.unavailable}` };
  }
  if (allowances.missing.length + allowances.unnamed === 0) return null;
  // The remedy before the list: the kernel relays 500 characters, and the list can be long.
  return { code: "E_BACKEND_SANDBOX_HOST", message: `this launch runs in bb's ${mode} mode, whose sandbox must be told which hosts OATS's own commands reach, and the deployment records none for some. ${missingRemedy(allowances.missing)}, or launch in full mode (--yolo). Missing: ${gapList(allowances.missing, allowances.unnamed)}` };
}
