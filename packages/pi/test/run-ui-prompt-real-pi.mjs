/**
 * Runs one dialog in pi itself: an SDK session with a faux model whose first
 * reply calls a tool, a tool that asks through `ctx.ui.select` as a question
 * tool does, the bridge (extension/index.ts) loaded by pi's own loader, and
 * the real kernel behind the home's shim. Prints what the kernel read of the
 * home while the dialog was open and after, as JSON.
 *
 *   node run-ui-prompt-real-pi.mjs <pi-coding-agent root> <pi-ai entry> <answered|session-ends> <instance-home>
 */
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { liveWaiting, waitingHold } from "../../../lib/instance-events.mjs";

const [piRoot, piAiEntry, name, home] = process.argv.slice(2);
process.env.OATS_INSTANCE_HOME = home;
const pi = await import(pathToFileURL(join(piRoot, "dist", "index.js")).href);
const ai = await import(pathToFileURL(piAiEntry).href);
const BRIDGE = fileURLToPath(new URL("../extension/index.ts", import.meta.url));
const QUESTION = "Which option should I take?";

const faux = ai.fauxProvider({ tokensPerSecond: 2000 });
faux.setResponses([
  ai.fauxAssistantMessage([ai.fauxToolCall("ask_person", {})], { stopReason: "toolUse" }),
  ai.fauxAssistantMessage("done"),
]);
const modelRuntime = await pi.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerNativeProvider(faux.provider);

const events = [];
const asker = (api) => {
  api.registerTool({
    name: "ask_person",
    label: "Ask the person",
    description: "Ask the person to choose.",
    parameters: { type: "object", properties: {} },
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const choice = await ctx.ui.select(QUESTION, ["Option A", "Option B"]);
      return { content: [{ type: "text", text: `chosen: ${choice}` }], details: {} };
    },
  });
  for (const type of ["ui_prompt_start", "ui_prompt_end"]) api.on(type, (event) => { events.push({ type: event.type, kind: event.kind, title: event.title }); });
};

// The host's side of a dialog (an RPC host's, or the terminal UI's): it stays open until answered.
let answer;
const asked = new Promise((resolve) => { answer = resolve; });
let shown;
const nothing = () => {};
const ui = {
  select: (title) => { shown = title; return asked; },
  confirm: async () => false, input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
  notify: nothing, onTerminalInput: () => nothing, setStatus: nothing, setWorkingMessage: nothing, setWorkingVisible: nothing,
  setWorkingIndicator: nothing, setHiddenThinkingLabel: nothing, setWidget: nothing, setFooter: nothing, setHeader: nothing,
  setTitle: nothing, pasteToEditor: nothing, setEditorText: nothing, getEditorText: () => "", addAutocompleteProvider: nothing,
  setEditorComponent: nothing, getEditorComponent: () => undefined, theme: undefined, getAllThemes: () => [], getTheme: () => undefined,
  setTheme: () => ({ success: false, error: "no theme here" }), getToolsExpanded: () => false, setToolsExpanded: nothing,
};

const loader = new pi.DefaultResourceLoader({
  cwd: home, agentDir: join(home, "agent"), noExtensions: true, noSkills: true,
  additionalExtensionPaths: [BRIDGE],
  extensionFactories: [asker],
});
await loader.reload();
const { session } = await pi.createAgentSession({ cwd: home, agentDir: join(home, "agent"), model: faux.getModel(), modelRuntime, sessionManager: pi.SessionManager.inMemory(), resourceLoader: loader });
await session.bindExtensions({ uiContext: ui, mode: "rpc" });

const until = async (done, what) => {
  for (const end = Date.now() + 30000; !done();) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const read = () => ({ waiting: liveWaiting(home), hold: waitingHold(home) });
const withoutSince = ({ waiting, hold }) => ({ waiting: waiting && { producer: waiting.producer, reason: waiting.reason, message: waiting.message }, hold });

let promptError = null;
const turn = session.prompt("Ask me.").catch((e) => { promptError = e.message; });
await until(() => liveWaiting(home) !== null, "the dialog's claim");
const open = withoutSince(read());
let closed;
if (name === "session-ends") {
  // pi 1.5.2 core/agent-session-runtime.js:312-315 (dispose): the process exits once these handlers return.
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  closed = withoutSince(read());
  answer("Option A");
} else {
  answer("Option A");
  await turn;
  await until(() => liveWaiting(home) === null, "the claim's clear");
  closed = withoutSince(read());
}
await turn;
const toolResult = session.messages.find((m) => m.role === "toolResult");
console.log(JSON.stringify({ shown, events, open, closed, promptError, toolResult: toolResult?.content?.map((c) => c.text).join("") ?? null }));
process.exit(0);
