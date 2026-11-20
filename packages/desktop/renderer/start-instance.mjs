import { harnessOf } from '../../client/harness-names.mjs';
import { apiJson, postJson, instanceApiPath, currentWorkspace, workspaceGeneration, onWorkspaceChange, wsQuery, rowDeployment } from "./views/common.mjs";
import { instanceId } from "../../client/instance-tree.mjs";
import { waitForInstanceInPanel } from "./views/spawn.mjs";
import { launchConfigFields } from "./launch-config-fields.mjs";
import { captureFocusReturn } from "./focus-return.mjs";
// The gate alone: session-start.mjs runs the CLI and loads Node builtins, which this page cannot (inventory.test.mjs).
import { startGate } from "../../client/start-gate.mjs";
import { retainedStartMessage, launchFlagIgnored, flagIgnoredNotice } from "../../client/launch-prompt-outcome.mjs";
import { displayLine } from "../../client/display-text.mjs";
import { startRefusalSentence } from "../../client/start-messages.mjs";
import { runtimeErrorLine } from "./speaker-line.mjs";
import { noTerminal } from "./provider-row.mjs";
import { sessionProvider } from "../../client/instance-presentation.mjs";
import { kernelLines } from "../../client/kernel-lines.mjs";
import { DESKTOP_TERMS } from "./desktop-terms.mjs";
import { sourceQuoteCSS } from "./source-quote.mjs";
import { launchDiffered, launchDifferedCSS } from "./launch-differed.mjs";

/** Existing homes are started, never scaffolded again. One dialog owns a launch. */
export function createInstanceStarter(doc, ctx, { waitForReady = waitForInstanceInPanel } = {}) {
  let active;
  const pending = new Set();
  return function openStart(instance, { restart = false } = {}) {
    if (active) { active.focus(); return; }
    const key = instanceId(instance);
    const ws = currentWorkspace(), generation = workspaceGeneration();
    // A logical return target: a roster row's Start… hides with its row tools once focus leaves
    // the row, so focus returns to the row itself (focus-return.mjs), never to <body>.
    const opener = captureFocusReturn(doc);
    const modal = doc.createElement("div"); modal.className = "oats-view instance-start-modal";
    modal.innerHTML = `<form class="instance-start-dialog" role="dialog" aria-modal="true" aria-labelledby="instance-start-title">
      <h2 id="instance-start-title"></h2>
      <p class="start-context"></p>
      <p>Continue in this instance’s existing home, with its identity, work and notes.</p>
      <p>This starts a new conversation using the saved briefing and state.</p>
      <div class="start-launch-controls" hidden>
        <label>Harness<select class="field start-runtime"><option value="">Keep recorded harness</option><option value="codex">codex</option><option value="claude">claude</option><option value="pi">pi</option></select></label>
        <label>Permissions<select class="field start-yolo"><option value="">Keep defaults</option><option value="true">YOLO — skip permission prompts</option><option value="false">Use native permission policy</option></select></label>
      </div>
      <label>Model for this start<input class="field start-model" list="instance-start-models" autocomplete="off"></label>
      <datalist id="instance-start-models"></datalist>
      <p class="start-model-help"></p>
      <div class="start-configurations" hidden></div>
      <p class="start-status" role="status" aria-live="polite"></p>
      <div class="start-outcome" hidden></div>
      <div class="start-buttons"><button class="act start-submit" type="submit" disabled>Start</button>
        <button class="act start-retry" type="button">Refresh status</button>
        <button class="act start-cancel" type="button">Cancel</button></div>
    </form>`;
    const form = modal.querySelector("form"), model = modal.querySelector(".start-model");
    const submit = modal.querySelector(".start-submit"), status = modal.querySelector(".start-status");
    const retry = modal.querySelector(".start-retry");
    // A start that stopped at a launch prompt (the kernel's E_SPAWN_INCOMPLETE, its retained outcome decoded
    // on the way here): the Desktop's sentence is the status; under it, what the screen differed in (the
    // quote treatment, whose CSS the dialog brings), then the kernel's own message, attributed, one display
    // line alone in its <bdi>. Never the kernel's command-line sentence as the dialog's own text.
    const outcome = modal.querySelector(".start-outcome");
    const quoteStyle = doc.createElement("style"); quoteStyle.textContent = sourceQuoteCSS + launchDifferedCSS; modal.prepend(quoteStyle);
    const clearOutcome = () => { outcome.replaceChildren(); outcome.hidden = true; };
    const showRetained = (error) => {
      status.textContent = retainedStartMessage(instance.instance, error.incomplete);
      const differed = launchDiffered(doc, error.incomplete.launchPrompts?.differed), line = displayLine(error.message);
      let says = null;
      if (line) { says = doc.createElement("p"); says.className = "start-kernel-says"; const text = doc.createElement("bdi"); text.textContent = line; says.append("OATS says: ", text); }
      outcome.replaceChildren(...[differed, says].filter(Boolean)); outcome.hidden = !outcome.children.length;
    };
    // A refusal the Desktop has a sentence for (start-messages.mjs, or the start rule's `startedNothing` the route
    // answers): the sentence is the status, and under it the kernel's message, attributed and filtered by the
    // shared rule (kernel-lines.mjs kernelLines), one <p> for each line it answers. No name stands before a text
    // that is not shown. The message is the answer's own (`answered`, views/common.mjs), never the transport's
    // stand-in for an answer without one.
    const showRefused = (sentence, error) => {
      status.textContent = sentence;
      outcome.replaceChildren(...kernelLines(error.answered, null, DESKTOP_TERMS).map(line => { const says = doc.createElement("p"); says.className = "start-kernel-says"; says.textContent = line; return says; }));
      outcome.hidden = !outcome.children.length;
    };
    modal.querySelector("h2").textContent = `${restart ? "Restart" : "Start"} ${instance.instance}`;
    modal.querySelector(".start-context").textContent = `${instance.harness || "Harness not reported"} · ${instance.server || "This machine"} · ${instance.home}`;
    model.placeholder = instance.model || "Harness default";
    modal.querySelector(".start-model-help").textContent = `Leave blank to keep ${instance.model || "the harness default"}. Choosing a model here changes this instance’s next launch.`;
    let closed = false, starting = false, started = false, live = false, canStart = false, refreshGeneration = 0, hasLaunchConfig = false, hasLaunchConfigDefault = false, configsLoaded = false;
    const owns = () => !closed && ws === currentWorkspace() && generation === workspaceGeneration();
    const runtime = modal.querySelector(".start-runtime"), yolo = modal.querySelector(".start-yolo");
    let chosenConfig, modelRequest = 0;
    const updateModelHelp = () => {
      const effectiveHarness = harnessOf(chosenConfig) || runtime.value || instance.harness || "pi";
      const defaultModel = chosenConfig?.model || (effectiveHarness === instance.harness ? instance.model : null);
      model.placeholder = defaultModel || "Harness default";
      modal.querySelector(".start-model-help").textContent = `Leave blank to use ${defaultModel || "the selected harness’s default model"}. This choice is saved for later starts of this instance.`;
    };
    const fillModels = async () => {
      const id = ++modelRequest, list = modal.querySelector("datalist"); list.replaceChildren();
      if (instance.server || chosenConfig) return; // A named wrapper may have a different model catalog.
      try {
        const data = await postJson(ctx, "/api/models", { harness: runtime.value || instance.harness || "pi" });
        if (!owns() || id !== modelRequest) return;
        for (const m of data.models || []) { const option = doc.createElement("option"); option.value = m.id; if (m.label) option.label = m.label; list.append(option); }
      } catch { /* Models can always be entered explicitly. */ }
    };
    const choices = () => ({ ...(model.value.trim() ? { model: model.value.trim() } : {}), ...(hasLaunchConfig && runtime.value ? { harness: runtime.value } : {}), ...(hasLaunchConfig && yolo.value !== "" ? { yolo: yolo.value === "true" } : {}) });
    const launchFields = launchConfigFields(modal.querySelector(".start-configurations"), { ctx, selector: () => ({ home: instance.home }), choices, owns,
      deployment: rowDeployment(instance), // the instance's own deployment, never the view
      supportsDefault: () => hasLaunchConfigDefault,
      // A named configuration decides the harness, so the list is emptied and disabled. With no row (the
      // recorded launch, or the bare harness) the list stays usable and keeps what was picked.
      changed: row => { chosenConfig = row; if (row) runtime.value = ""; runtime.disabled = !!row; runtime.querySelector("option").textContent = row ? `Configuration harness (${harnessOf(row)})` : `Recorded harness (${instance.runtime || "pi"})`; updateModelHelp(); void fillModels(); },
    });
    for (const input of [runtime, model, yolo]) input.addEventListener("input", () => launchFields.invalidate());
    runtime.addEventListener("change", () => { updateModelHelp(); void fillModels(); });
    const close = () => {
      if (closed) return;
      closed = true; launchFields.dispose(); offWorkspace(); modal.remove(); active = null;
      opener.restore();
    };
    const offWorkspace = onWorkspaceChange(close);
    // After the dialog closed: the started instance's terminal, while this window still shows the
    // workspace it was started from and the operator has chosen nothing since (`chosen`, the shell's
    // selection watch). The open's own selection ticket supersedes the watch from then on.
    // A row on a session provider (provider-row.mjs) has no terminal: its start opens none and says nothing of one.
    // What was started is what the kernel's receipt says, when it names a backend: a home's backend can move while
    // the dialog is open, either way. A provider's name: no terminal to follow. "tmux": followed as any start,
    // whatever the row this dialog was opened with said. A receipt with no `backend`, or an empty one (an older
    // kernel's), keeps the answer of the row the dialog was opened with.
    const openWhenReady = async (chosen, receipt = null) => {
      const started = typeof receipt?.backend === "string" && receipt.backend !== "" ? receipt.backend : null;
      if (started === null ? noTerminal(instance) : sessionProvider({ backend: started }) !== null) return;
      const ours = () => ws === currentWorkspace() && generation === workspaceGeneration() && chosen();
      try {
        const ready = await waitForReady({ ctx }, instance, ours);
        if (!ours()) return;
        if (ready) await ctx.openTerminal(instance, { quiet: true });
        else ctx.notify?.(`${instance.instance} was started, but its terminal isn't ready yet. Open it from its row when it is.`);
      } catch (error) {
        if (ours()) ctx.notify?.(`${instance.instance} was started, but its terminal could not open: ${error.message}`);
      }
    };
    active = { focus: () => model.focus() };
    const refresh = async () => {
      if (starting || started) return;
      const request = ++refreshGeneration;
      clearOutcome(); // the lines belong to the sentence a failed start left as the status
      submit.disabled = true; canStart = false; status.textContent = "Checking instance…";
      try {
        const [cli, panel] = await Promise.all([apiJson(ctx, "/api/cli"), apiJson(ctx, `/api/panel${wsQuery()}`)]);
        if (!owns() || request !== refreshGeneration) return;
        const found = panel.instances?.find((i) => instanceId(i) === key);
        live = found?.running === true;
        hasLaunchConfig = !!cli.ok && cli.features?.includes("launch-config") && (!instance.server || cli.remote?.includes("launch-config"));
        // Offered for this computer's own configurations only: its CLI can't tell whether a
        // remote host's kernel has the feature (the fields still keep a default that host reports).
        hasLaunchConfigDefault = hasLaunchConfig && !instance.server && cli.features.includes("launch-config-default");
        modal.querySelector(".start-launch-controls").hidden = modal.querySelector(".start-configurations").hidden = !hasLaunchConfig;
        if (hasLaunchConfig && !configsLoaded) { configsLoaded = true; void launchFields.load(); }
        submit.textContent = restart ? "Restart" : live ? "Open terminal" : "Start";
        model.disabled = live && !restart;
        // The start rule's gate is the shared home's (start-gate.mjs), the one the route decides by too: this dialog
        // never sends a start it has refused. The route reads the row again and checks the home, so it may still refuse.
        const gate = startGate(cli, found ?? null, { restart }, DESKTOP_TERMS);
        if (gate?.code === "already-running") { submit.disabled = false; status.textContent = gate.sentence; return; }
        // A row whose state is not known says so with its own text and its speaker, when it has one.
        if (gate) throw new Error((gate.code === "state-unknown" && runtimeErrorLine(found)) || gate.sentence);
        canStart = true; submit.disabled = pending.has(key);
        status.textContent = pending.has(key) ? "A start is already in progress for this instance." : restart && live ? "Restart stops the current harness after checking the new configuration. Save any in-progress work before continuing." : "Ready to start.";
      } catch (e) { if (owns() && request === refreshGeneration) status.textContent = e.message; }
    };
    retry.addEventListener("click", refresh);
    modal.querySelector(".start-cancel").addEventListener("click", close);
    modal.addEventListener("mousedown", (e) => { if (e.target === modal) close(); });
    form.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key !== "Tab") return;
      const items = [...form.querySelectorAll("input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), summary")].filter(el => !el.closest("[hidden]") && (!el.closest("details") || el.tagName === "SUMMARY" || el.closest("details").open));
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && doc.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first?.focus(); }
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!owns() || submit.disabled || starting || started) return;
      if (live && !restart) { close(); await ctx.openTerminal(instance, { quiet: true }); return; }
      if (!canStart || pending.has(key)) return;
      if (launchFields.busy()) { status.textContent = "Wait for the launch configuration to finish saving."; return; }
      const chosen = model.value.trim();
      if (chosen.startsWith("-") || chosen.includes("\0")) { status.textContent = "Enter a model name, not a command-line option."; return; }
      const path = instanceApiPath(restart ? "restart" : "start", instance);
      starting = true; pending.add(key); submit.disabled = true; model.disabled = true; retry.disabled = true;
      const body = { ...choices(), ...(hasLaunchConfig && launchFields.value() ? { launchConfig: launchFields.value() } : {}) };
      launchFields.invalidate();
      runtime.disabled = yolo.disabled = true; launchFields.disabled(true);
      clearOutcome(); status.textContent = restart ? "Checking configuration and restarting…" : "Starting…";
      try {
        const result = await postJson(ctx, path, body);
        started = true;
        // Accepted. The harness may stop at something only its terminal shows (Claude Code's channels
        // confirmation, an error), so the dialog never waits on it (#525): it closes, and the terminal
        // opens as soon as the row is ready. Readiness is reported there, or by a notice, never by a modal.
        const open = owns();
        if (open) close();
        // The start worked while Claude Code ignored the channel option (the answer's own `launchPrompts`):
        // a notice says so once the dialog is gone, also when the person closed it while the start ran. The
        // view it was started from must still be on screen, as for every notice of this dialog. Never a
        // failure: the terminal opens as for any start that worked.
        const ignored = flagIgnoredNotice(instance.instance, launchFlagIgnored(result));
        if (ignored && ws === currentWorkspace() && generation === workspaceGeneration()) ctx.notify?.(ignored.headline, ignored.detail ? { detail: ignored.detail } : undefined);
        if (!open) return;
        // Taken after the focus return: any explicit choice from now on (another terminal, tab, view or
        // the sidebar) keeps the foreground, and this terminal does not take it later.
        void openWhenReady(ctx.watchSelection?.() ?? (() => true), result);
      } catch (error) {
        if (!owns()) return;
        // A start that stopped at a launch prompt says what happened in the Desktop's words, and so does a
        // refusal the Desktop has a sentence for; any other refusal shows the server's message, as before.
        const sentence = error.startedNothing ?? startRefusalSentence(error.code);
        if (error.incomplete) showRetained(error); else if (sentence) showRefused(sentence, error); else status.textContent = error.message;
        // A timeout may have happened after launch, and a retained session is still there. Recheck before
        // offering another start.
        canStart = false;
      } finally {
        starting = false; pending.delete(key);
        if (owns()) { model.disabled = yolo.disabled = started; runtime.disabled = started || !!chosenConfig; retry.disabled = started; launchFields.disabled(started); }
      }
    });
    doc.body.append(modal); model.focus(); void refresh();
    void fillModels();
    return modal;
  };
}
