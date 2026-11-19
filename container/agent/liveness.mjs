/** A dead SSH listener affects readiness. Team liveness follows the supervised
 * owner process, which already tears down on an unexpected critical-child exit. */
import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function supervisorAlive({ procRoot = "/proc" } = {}) {
  let entries;
  try { entries = readdirSync(procRoot, { withFileTypes:true }); }
  catch { return false; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9]\d*$/.test(entry.name)) continue;
    try {
      const args = readFileSync(`${procRoot}/${entry.name}/cmdline`, "utf8").split("\0");
      if (args[1] === "/usr/local/lib/agent-supervisor.mjs"
        && readlinkSync(`${procRoot}/${entry.name}/exe`) === process.execPath) return true;
    } catch { continue; } // Exited or unreadable processes cannot prove liveness.
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (supervisorAlive()) process.stdout.write("OATS_AGENT_SUPERVISOR_ALIVE\n");
  else { process.stderr.write("agent liveness: supervisor unavailable\n"); process.exitCode = 1; }
}
