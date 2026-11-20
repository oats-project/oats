/** Private entry point of lib/session-providers.mjs (callSessionProvider); no CLI or provider
 *  contract. The kernel runs every command of a session provider through this process, started in
 *  a process group of its own, of which it is the leader:
 *
 *    node provider-call-child.mjs <group file | -> <provider script> [arguments…]
 *
 *  - With a group file, it records who it is there first (`{ pid, processStart }`, created
 *    exclusively), outside the home, and only then runs the provider. A kernel that finds the call
 *    of a kernel that was killed ends this group by that record before it settles anything the
 *    call may still do (lib/core.mjs endProviderCall). A file that is already there is that
 *    kernel's word that the call is void: the provider is not run. Nor is it once the call's own
 *    record (the group file's name without `.group`) is gone: that kernel has ended the call and
 *    taken its records away, the void one last.
 *  - The provider's script runs in this group, with this process's stdin, stdout and stderr: its
 *    request and its answer pass through untouched. A provider runs its own helpers in the group
 *    and never detaches them.
 *  - A signal to end it (the kernel's timeout sends SIGTERM) ends the whole group, by SIGKILL.
 *
 *  It exits as the provider's script did. 125: the call was void or could not be recorded, and
 *  nothing was run. 126: the script could not be started. */
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { processStartToken } from "../packages/record/lib/process-identity.mjs";

const [groupFile, script, ...args] = process.argv.slice(2);
const endGroup = () => process.kill(0, "SIGKILL");
// A test's seam (reserved launch environment): this leader starts late, as on a loaded host.
const late = Number(process.env.OATS_TEST_PROVIDER_LEADER_DELAY_MS);
delete process.env.OATS_TEST_PROVIDER_LEADER_DELAY_MS;
if (Number.isFinite(late) && late > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(late, 10_000));
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, endGroup);

if (groupFile !== "-") {
  const processStart = processStartToken(process.pid);
  // Without its start time the record could not tell this group from a later one of the same id.
  if (!processStart) process.exit(125);
  try { writeFileSync(groupFile, `${JSON.stringify({ pid: process.pid, processStart })}\n`, { flag: "wx", mode: 0o600 }); }
  catch { process.exit(125); } // already there (void), or not writable: nothing is run
  if (!existsSync(groupFile.slice(0, -".group".length))) { rmSync(groupFile, { force: true }); process.exit(125); }
}
const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
child.on("error", () => process.exit(126));
child.on("close", (code, signal) => {
  if (!signal) process.exit(code ?? 1);
  for (const handled of ["SIGTERM", "SIGINT", "SIGHUP"]) process.removeAllListeners(handled);
  process.kill(process.pid, signal);
});
