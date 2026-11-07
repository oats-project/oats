// The environment of a program the Desktop starts: the user's, without what the Desktop or its
// packaging added to the Desktop's own (#602). A tmux server takes its environment from the
// program that creates it, so whatever leaks here ends up in every agent's pane.
//
// This module imports only the control-environment leaf: a Desktop process that runs as Node
// cleans its own environment through it before loading any other module (own-environment.mjs).
import { withoutControlToken } from "./control-environment.mjs";

/** Set by main for its Node-mode children, and by Electron at startup on Linux. */
const DESKTOP_NAMES = ["ELECTRON_RUN_AS_NODE", "CHROME_DESKTOP"];
/** Set by the AppImage runtime. */
const APPIMAGE_NAMES = ["APPIMAGE", "APPDIR", "ARGV0", "OWD"];

/** The AppImage's mount: APPDIR when it is an absolute path other than the root, without its trailing slashes; else null. */
function mountOf(source) {
  const appdir = source.APPDIR;
  if (typeof appdir !== "string" || !appdir.startsWith("/")) return null;
  return appdir.replace(/\/+$/, "") || null;
}

/**
 * A new object; `source` is never changed.
 *  1. OATS_DESKTOP_TOKEN, ELECTRON_RUN_AS_NODE and CHROME_DESKTOP are removed.
 *  2. MallocNanoZone is removed when it is exactly "0" (the launch environment Electron's
 *     Info.plist declares on macOS; a user's own "0" cannot be told from it).
 *  3. With a mount: APPIMAGE, APPDIR, ARGV0 and OWD are removed, and every other value is read
 *     as a `:` list (APPDIR exists only where an AppImage does, so `:` and not path.delimiter).
 *     An entry is under the mount when it is the mount or starts with the mount and a `/`. A
 *     value with no such entry is passed through as it is, not re-joined. Otherwise those
 *     entries and the empty ones are dropped, and the name is removed when nothing is left.
 * Without a mount step 3 does nothing. A value that is not a string is never read and passes
 * through. The rule is on values, not on the names the AppImage launcher exports, so it holds
 * whatever that generated script exports; it matches whole entries only, so a value that merely
 * contains the mount's path, or a sibling of the mount, is untouched. Applying it to its own
 * result changes nothing.
 */
export function cliEnvironment(source = process.env) {
  const env = withoutControlToken(source);
  for (const name of DESKTOP_NAMES) delete env[name];
  if (env.MallocNanoZone === "0") delete env.MallocNanoZone;
  const mount = mountOf(source);
  if (mount === null) return env;
  for (const name of APPIMAGE_NAMES) delete env[name];
  const underMount = (entry) => entry === mount || entry.startsWith(`${mount}/`);
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const entries = value.split(":");
    if (!entries.some(underMount)) continue;
    const kept = entries.filter((entry) => entry !== "" && !underMount(entry));
    if (kept.length) env[name] = kept.join(":");
    else delete env[name];
  }
  return env;
}
