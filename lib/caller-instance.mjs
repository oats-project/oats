/** Whether this process runs inside an OATS instance, by the kernel's one detection: the instance
 *  variables, or a working directory inside a home. A leaf (awebai/oats#1630): lib/core.mjs uses it for
 *  the environment of a tmux server it starts, and `oats settings set|unset` (lib/settings-set.mjs) to
 *  refuse a run that is not an operator's. Not part of the `./core` export. */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { enclosingInstanceHome, logicalCwd } from "./soul-listing.mjs";

/** The names that mark a process as an OATS instance: the launch identity, and what older kernels
 *  called it. One of them in the environment, even empty, is evidence of an instance. */
export const INSTANCE_IDENTITY_ENV = Object.freeze(["OATS_INSTANCE", "OATS_INSTANCE_HOME", "OATS_HOME", "PI_AGENT_INSTANCE", "PI_AGENT_HOME"]);
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** Whether this process runs inside an OATS instance, as the CLI resolves an in-home command:
 *  `{ home, by }` for the home OATS_INSTANCE_HOME names when it is one (`by: "OATS_INSTANCE_HOME"`), else
 *  the instance home enclosing the working directory (`by: "cwd"`; a harness may strip the session
 *  environment). `{ evidence }` when neither gives a home and yet the environment carries an instance
 *  identity name: an instance's environment without an identified home is not "outside an instance".
 *  undefined otherwise. */
export function callerInstance() {
  const named = process.env.OATS_INSTANCE_HOME;
  if (named && isAbsolute(named)) {
    try { if (isPlainObject(JSON.parse(readFileSync(join(named, "instance.json"), "utf8")))) return { home: named, by: "OATS_INSTANCE_HOME" }; }
    catch { /* names no home */ }
  }
  const enclosing = enclosingInstanceHome(logicalCwd());
  if (enclosing) return { home: enclosing, by: "cwd" };
  const evidence = INSTANCE_IDENTITY_ENV.find((name) => process.env[name] !== undefined);
  return evidence ? { evidence } : undefined;
}
