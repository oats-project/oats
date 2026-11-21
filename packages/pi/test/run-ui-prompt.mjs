/**
 * Runs the real bridge (extension/index.ts) in a PiHost as one pi process, with
 * the process's own OATS_INSTANCE_HOME (set or not), and prints the events the
 * bridge listens to as JSON. What it wrote is in the home: its kernel shim's
 * record, or the kernel's own log. Runs under
 * `node --experimental-strip-types`.
 *
 *   node --experimental-strip-types run-ui-prompt.mjs [dialog-then-quit|failed-run|dialog-then-hang]
 *
 * dialog-then-quit (the default): a dialog opens and the session ends with it open.
 * failed-run: a second pi in a home, a nested one say: it starts, runs a turn that fails, and quits.
 * dialog-then-hang: a dialog opens, the listening line is printed, and the process waits to be killed.
 */
import { PiHost } from "./pi-host.mjs";

const mode = process.argv[2] ?? "dialog-then-quit";
const { default: bridge } = await import("../extension/index.ts");

const host = new PiHost();
bridge(host.api());
const listens = () => process.stdout.write(`${JSON.stringify({ listens: [...host.handlers.keys()].sort() })}\n`);
// pi 1.5.2 core/extensions/runner.js:369-386 (withUIPrompt).
const dialog = () => host.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Which option should I take?" });
// pi 1.5.2 core/agent-session-runtime.js:312-315: awaited before the process exits.
const quit = () => host.emit({ type: "session_shutdown", reason: "quit" });

if (mode === "failed-run") {
  // A reload's start: the bridge's memory nudge, which reads pi's session manager, is for the others.
  await host.emit({ type: "session_start", reason: "reload" });
  await host.emit({ type: "agent_start" });
  await host.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "422: refused" }] });
  await host.emit({ type: "agent_settled", aborted: false });
  await quit();
  listens();
} else if (mode === "dialog-then-hang") {
  await dialog();
  listens();
  setInterval(() => {}, 1000);
} else {
  await dialog();
  await quit();
  listens();
}
