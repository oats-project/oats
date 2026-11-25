/**
 * Runs turns in pi itself and prints what the kernel read of the home's turn
 * record at each point, as JSON: an SDK session with a faux model that streams
 * slowly, and the bridge (extension/index.ts) loaded by pi's own loader.
 *
 *   node run-turn-record-real-pi.mjs <pi-coding-agent root> <pi-ai entry> <instance-home> <startedAt>
 *
 * The first prompt is the session's first, as a launch's `@TASK.md` is; the
 * second is aborted while it streams.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmuxActivity } from "../../../lib/turn-activity.mjs";

const [piRoot, piAiEntry, home, startedAt] = process.argv.slice(2);
process.env.OATS_INSTANCE_HOME = home;
const pi = await import(pathToFileURL(join(piRoot, "dist", "index.js")).href);
const ai = await import(pathToFileURL(piAiEntry).href);
const BRIDGE = fileURLToPath(new URL("../extension/index.ts", import.meta.url));

const faux = ai.fauxProvider({ tokensPerSecond: 40 });
faux.setResponses(Array.from({ length: 4 }, (_, i) => ai.fauxAssistantMessage(`reply ${i + 1}, ${"long enough to stream for a good while ".repeat(8)}`)));
const modelRuntime = await pi.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerNativeProvider(faux.provider);

const events = [];
const watcher = (api) => { for (const type of ["agent_start", "agent_end"]) api.on(type, () => { events.push(type); }); };
const loader = new pi.DefaultResourceLoader({
  cwd: home, agentDir: join(home, "agent"), noExtensions: true, noSkills: true,
  additionalExtensionPaths: [BRIDGE],
  extensionFactories: [watcher],
});
await loader.reload();
const { session } = await pi.createAgentSession({ cwd: home, agentDir: join(home, "agent"), model: faux.getModel(), modelRuntime, sessionManager: pi.SessionManager.inMemory(), resourceLoader: loader });
await session.bindExtensions({});

const until = async (done, what) => {
  for (const end = Date.now() + 30000; !done();) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
/** The record's event, or null for no file, and what the kernel makes of it for this start. */
const read = () => {
  let event = null;
  try { event = JSON.parse(readFileSync(join(home, ".oats", "turn.json"), "utf8")).event; } catch (e) { if (e.code !== "ENOENT") throw e; }
  return { event, activity: tmuxActivity(home, { startedAt, harness: "pi" }), stopReason: session.messages.findLast((m) => m.role === "assistant")?.stopReason ?? null };
};
const streaming = () => session.isStreaming && session.messages.some((m) => m.role === "user");

const seen = { beforeFirstPrompt: read() };
let promptError = null;
const first = session.prompt("THE TASK").catch((e) => { promptError = e.message; });
await until(() => events.includes("agent_start") && streaming(), "the first turn to run");
seen.firstTurnRunning = read();
await first;
await until(() => session.isIdle && events.filter((e) => e === "agent_end").length === 1, "the first turn to end");
seen.firstTurnEnded = read();

const second = session.prompt("AGAIN").catch((e) => { promptError = e.message; });
await until(() => events.filter((e) => e === "agent_start").length === 2 && session.isStreaming, "the second turn to run");
seen.secondTurnRunning = read();
await session.abort();
await second;
await until(() => session.isIdle && events.filter((e) => e === "agent_end").length === 2, "the aborted turn to end");
seen.aborted = read();
console.log(JSON.stringify({ seen, events, promptError }));
process.exit(0);
