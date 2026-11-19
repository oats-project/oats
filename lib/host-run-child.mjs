/** Private bootstrap for a kernel child owned by host run. The leading control
 * arguments are consumed here, never parsed as public CLI options. */
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processStartToken } from "../packages/record/lib/process-identity.mjs";
import { pathToFileURL } from "node:url";
import { assertHostRunAdmission, installHostRunFence } from "./host-run-admission.mjs";
const [bin, fence, ownership, ...argv] = process.argv.slice(2);
if (!bin || !fence) throw new Error("host-run child requires its owner control");
installHostRunFence(fence);
if (ownership === "group" && process.platform !== "win32") {
  // Register before importing any launch-capable code. An intermediate
  // supervisor can be stopped or killed without orphaning an unowned launch.
  const readOnly = argv.includes("--plan");
  if (!readOnly) assertHostRunAdmission();
  const start = processStartToken(process.pid);
  if (!start) throw new Error("host-run child cannot establish its process identity");
  const registration = join(dirname(fence), "groups", String(process.pid));
  writeFileSync(`${registration}.new`, JSON.stringify({ pid: process.pid, processStart: start }), { mode: 0o600 });
  renameSync(`${registration}.new`, registration);
  const deadline = Date.now() + 5000;
  while (!existsSync(`${registration}.owned`)) {
    if (!readOnly) assertHostRunAdmission();
    if (Date.now() >= deadline) throw new Error("host-run child ownership was not acknowledged");
    await delay(10);
  }
  if (!readOnly) assertHostRunAdmission();
}
process.argv = [process.execPath, bin, ...argv];
await import(pathToFileURL(bin).href);
