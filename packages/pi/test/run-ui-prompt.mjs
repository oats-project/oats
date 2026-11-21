/**
 * Runs the real bridge (extension/index.ts) through one dialog and the
 * session's end in a PiHost, with the process's own OATS_INSTANCE_HOME (set or
 * not), and prints the events the bridge listens to as JSON. What it wrote is
 * in the home's kernel shim's record. Runs under
 * `node --experimental-strip-types`.
 *
 *   node --experimental-strip-types run-ui-prompt.mjs
 */
import { PiHost } from "./pi-host.mjs";

const { default: bridge } = await import("../extension/index.ts");

const host = new PiHost();
bridge(host.api());
// pi 1.5.2 core/extensions/runner.js:369-386 (withUIPrompt).
await host.emit({ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Which option should I take?" });
// pi 1.5.2 core/agent-session-runtime.js:312-315: awaited before the process exits.
await host.emit({ type: "session_shutdown", reason: "quit" });
process.stdout.write(JSON.stringify({ listens: [...host.handlers.keys()].sort() }));
