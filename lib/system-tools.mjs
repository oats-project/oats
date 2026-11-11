/** System tools: programs the kernel runs from the system's own directories, never from the
 *  caller's PATH. A job, a shell or an instance may have changed PATH; what a system tool does
 *  (read a process's start, start the OATS tmux server in its own scope) must not depend on it. */
export { SYSTEM_TOOL_DIRS, systemTool, systemToolDirs } from "../packages/record/lib/process-identity.mjs";
