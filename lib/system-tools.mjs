/** System tools: programs the kernel runs from the system's own directories, never from the
 *  caller's PATH. A job, a shell or an instance may have changed PATH; what a system tool does
 *  (read a process's start, start the OATS tmux server in its own scope) must not depend on it. */
import { accessSync, constants, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Where a system tool is looked for, in order. */
export const SYSTEM_TOOL_DIRS = Object.freeze(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);

/** The directories a system tool is looked for in → { dirs } | { reason }. SYSTEM_TOOL_DIRS, or for a
 *  test only, OATS_TEST_SYSTEM_TOOL_DIRS: absolute directories separated by `:`. A seam with any other
 *  value names no tool at all, never a PATH-like lookup. */
export function systemToolDirs() {
  const seam = process.env.OATS_TEST_SYSTEM_TOOL_DIRS;
  if (seam === undefined) return { dirs: SYSTEM_TOOL_DIRS };
  const dirs = seam.split(":");
  if (dirs.some((dir) => !isAbsolute(dir))) return { reason: `OATS_TEST_SYSTEM_TOOL_DIRS is ${JSON.stringify(seam)}, not absolute directories` };
  return { dirs };
}

/** `name` in the system directories (`dirs`, else systemToolDirs) → { file } (the first regular
 *  executable file, an absolute path) or { reason } (none, and where it looked). Nothing is run. */
export function systemTool(name, { dirs } = {}) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._+-]+$/.test(name) || name === "." || name === "..") return { reason: `${JSON.stringify(name)} is not a tool name` };
  if (dirs === undefined) {
    const where = systemToolDirs();
    if (where.reason) return { reason: where.reason };
    dirs = where.dirs;
  }
  for (const dir of dirs) {
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return { file };
    } catch { /* not here */ }
  }
  return { reason: `no executable ${name} in ${dirs.join(", ")}` };
}
