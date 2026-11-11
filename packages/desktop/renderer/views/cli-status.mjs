/* oats desktop — CLI degradation state (shared, view-independent).

   The desktop-dist contract: without a compatible installed `oats` CLI, all
   reads and existing terminal access keep working, while Spawn, Start and the
   other changes are disabled behind ONE consistent card showing the detected path/version,
   the required range, **Choose oats…**, **Retry**, a docs link, and a
   copyable install command. Never silently install. Missing tmux is a
   SEPARATE diagnosis — never conflated with CLI compatibility.

   One exception to the install command: when the detected CLI was refused
   only for speaking a NEWER desktop API (the locator's `newerApi: true` on its
   `tried` entry, never read from the reason's words), this Desktop is the
   older of the two. The card says so and names the Desktop to install; it
   offers no command, because installing the pinned CLI would downgrade it.

   A CLI of a later minor than this Desktop's own, with the same API, is not
   refused (oats-project/oats#1879): it is accepted ABOVE THE TESTED BOUND
   (`aboveTested` in /api/cli). The card is not shown then; in its place goes
   one line, the notice (aboveTestedCard), and every control whose operation
   packages/client/above-tested.mjs does not allow is disabled with the same
   sentence (cliHeldBack). The backend refuses those operations by itself; the
   renderer only reads the same table.

   The requirement and the install command are the BACKEND's to state, not
   this module's: /api/cli carries `required.range`, `required.desktopApi`
   and `install`, all derived from the locator's enforced band and this
   app's own version. Nothing here restates a version or a range — a
   renderer-side copy of an enforced value drifts silently, which is how the
   card once advertised a CLI below the relations floor it required. The
   settled-unknown and absent-endpoint states have no payload to read, so
   they say "unknown" and offer the VERSION-LESS install command rather than
   inventing a band.

   This module owns the fetch/refresh/subscribe state and the card DOM so
   every mutation surface renders the SAME card; views only mount it.

   Subscribers are notified ON CHANGE, not per response. Every subscriber
   treats an emit as "the CLI changed" — the Workspace view wipes its
   capabilities catalog and repaints its grid, schedules/automations drop
   their gates — while a window-focus reprobe of the same binary returns a
   payload identical in every gate-relevant field with only a fresh
   `probedAt` (and locator `tried`/`source` diagnostics). Change is judged by
   the shared probe signature (packages/client/cli-probe-contract.mjs), so such a reprobe
   is a no-op end to end instead of a flash of re-fetched views. */
import { escapeHtml } from "./common.mjs";
import { icon } from "../shell-icons.mjs";
import { probeChanged } from "../../../client/cli-probe-contract.mjs";
import { displayLine } from "../../../client/display-text.mjs";
import { aboveTestedRefusal, aboveTestedState } from "../../../client/above-tested.mjs";

/** Recovery command when the backend could not tell us which version to
 * pin — version-LESS on purpose: it names the package without restating any
 * band, so it cannot fall out of agreement with what the locator enforces. */
export const GENERIC_INSTALL_COMMAND = "npm install -g @awebai/oats";
export const DOCS_URL = "https://github.com/awebai/oats/blob/main/docs/desktop-cli-api.md";

/** The install command to show/copy: the backend's derived, version-pinned
 * one when a payload settled, else the version-less fallback. */
export function cliInstallCommand(s = cli) {
  return typeof s?.install === "string" && s.install ? s.install : GENERIC_INSTALL_COMMAND;
}
/** The requirement line. Never fabricated: an unreadable/absent payload says
 * so instead of printing a band this build did not obtain. */
export function cliRequirementText(s = cli) {
  const range = s?.required?.range;
  const api = s?.required?.desktopApi;
  if (!range) return "unknown — this build could not read its CLI requirement";
  return `${range} with desktop API ${api ?? 1}`;
}

let cli = null;              // last GET /api/cli payload (null = probe not yet settled)
let settledUnknown = false;  // a response ARRIVED but was unclassifiable (older backend, garbage)
let requestGeneration = 0;   // GET and POST compete for the same shared status
const listeners = new Set();

export function cliStatus() { return cli; }
/** Mutations are enabled ONLY on a verified compatible CLI (coordinator
 * directive — frozen contract): anything else renders disabled. The card
 * distinction is transient-vs-settled (coordinator UX clarification):
 * only PROBE-PENDING (no response yet) may be card-less — every SETTLED
 * non-ok state (incompatible, absent endpoint, malformed payload, failed
 * binary, unclassifiable) shows the actionable Choose/Retry/docs/install
 * card so users always have a recovery path. */
export function cliAvailable() { return !!cli?.ok; }
/** Spawn-time relations capability. Follows the shared degradation rule:
 * unknown (older backend that predates the `relations` field, or test
 * stubs) is treated as CAPABLE — the server independently fails closed
 * (cli-no-relations) if the real CLI cannot do related spawns. Only a
 * PROVEN relations:false hides the relation UI. */
export function cliRelationsAvailable() { return !!cli?.ok && cli.relations !== false; }
/** The notice of an accepted CLI above this Desktop's tested bound ({ message, release, version }), or null. */
export function cliAboveTested(s = cli) { return aboveTestedState(s); }
/** Why `operation` (above-tested.mjs's name for it) is off, the notice sentence, or null when it is not held
 * back. What a control that would run it shows as its title once it is disabled; the backend refuses it too. */
export function cliHeldBack(operation, s = cli) { return aboveTestedRefusal(s, operation)?.message ?? null; }
export function cliKnownUnavailable() { return (!!cli && !cli.ok) || settledUnknown; }
export function onCliChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
/** Test seam: invalidate in-flight work and return to probe-pending. */
export function resetCliStateForTests() { ++requestGeneration; cli = null; settledUnknown = false; emit(); }
function emit() { for (const fn of [...listeners]) { try { fn(cli); } catch { /* listener errors stay local */ } } }

/** Fetch a CLI endpoint distinguishing TRANSPORT failure (throw — keep last
 * state) from a RECEIVED HTTP error (settled — an older backend's 404 on
 * /api/cli is the contract's "absent endpoint" case and must card).
 * ctx.api has three shapes: a Response-like ({ok,status,json}), the shell
 * proxy's parsed body (throws err.status-tagged Errors on non-2xx), or a
 * plain object. */
async function fetchCliEndpoint(ctx, pathname, opts) {
  let r;
  try {
    r = await ctx.api(pathname, opts);
  } catch (e) {
    // The shell's api() tags RECEIVED HTTP errors with .status; anything
    // untagged is a transport failure and stays transient.
    if (typeof e?.status === "number") return { received: true, error: true, status: e.status };
    throw e;
  }
  // Only a Response's ok describes HTTP. The current shell returns the
  // parsed domain body: ok:false is useful CLI diagnostics, NOT an HTTP error.
  if (!r || typeof r.json !== "function") return { received: true, body: r };
  let body = null;
  try { body = await r.json(); } catch { /* non-JSON body */ }
  if (!r.ok) return { received: true, error: true, status: r.status };
  return { received: true, body };
}

/** One commit boundary for refresh AND reprobe, including transport rejection.
 * Stale completions neither replace state nor notify/repaint subscribers. */
async function updateCli(ctx, pathname, opts) {
  const request = ++requestGeneration;
  let r;
  try { r = await fetchCliEndpoint(ctx, pathname, opts); }
  catch { /* TRANSPORT failure — keep last state (transient; no flapping) */ }
  if (request !== requestGeneration) return cli;
  if (r) {
    // A response was RECEIVED — the probe is SETTLED either way:
    //   status shape        → that state (ok / known-unavailable + card);
    //   HTTP error (404…)   → settled "absent endpoint" — carded;
    //   non-status payload  → settled-unknown (older backend / garbage) —
    //                         carded. "Disabled with no card forever" is
    //                         not acceptable (binding UX clarification).
    const d = r.body;
    const previous = cli, wasUnknown = settledUnknown;
    cli = d && !Array.isArray(d) && typeof d.ok === "boolean" ? d : null;
    settledUnknown = !cli;
    // The first settled payload always emits (previous null ≠ any payload);
    // afterwards only a gate-relevant difference or an unknown↔known flip
    // does — repeated identical probes and repeated garbage stay silent.
    // While NO CLI is accepted, the card's "Detected" line is drawn from the
    // `tried` diagnostics, so a Retry that found a different failing
    // candidate must repaint it; nothing is cached in that state, so the
    // emit costs no re-fetch.
    if (probeChanged(previous, cli) || settledUnknown !== wasUnknown || triedChanged(previous, cli)) emit();
  }
  // TRANSPORT failure: nothing was received, nothing changed, nobody is told.
  return cli;
}

const triedChanged = (before, after) => !after?.ok && JSON.stringify(before?.tried ?? null) !== JSON.stringify(after?.tried ?? null);

/** Refresh from GET /api/cli (cheap — server-side cached probe state). */
export function refreshCli(ctx) { return updateCli(ctx, "/api/cli"); }

/** POST /api/cli/reprobe — Retry and Choose-binary trigger. */
export function reprobeCli(ctx, bin) {
  return updateCli(ctx, "/api/cli/reprobe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bin ? { bin } : {}),
  });
}

/** Retry and Choose oats…, shared by the card and the notice: a reprobe whose answer is said in the element's
 * `.cli-status`, only while the element still owns it (`isAlive()`, this action, the shared request). `still`:
 * whether the answer is still the failure the element is about, which says so. */
function probeAction(el, ctx, isAlive, still) {
  let actionGeneration = 0;
  return async (choose = false) => {
    if (!isAlive()) return;
    const action = ++actionGeneration;
    let request = requestGeneration;
    const owns = () => isAlive() && action === actionGeneration && request === requestGeneration;
    const status = (text) => { const st = el.querySelector(".cli-status"); if (st) st.textContent = text; };
    let bin;
    if (choose) {
      let picked;
      try { picked = await ctx.chooseCliBinary(); }
      catch { if (owns()) status("Could not choose an oats binary. Try again."); return; }
      if (!owns() || !picked?.path) return;
      bin = picked.path;
    }
    status(choose ? "Probing chosen binary…" : "Probing…");
    const pending = reprobeCli(ctx, bin);
    request = requestGeneration;
    await pending;
    // A refresh, another action, reset or dispose revokes this callback's UI
    // authority. The shared request itself outlives any one mounted card.
    if (owns() && still() && el.isConnected) {
      status(choose ? "Could not verify a compatible oats CLI for this choice." : "Still no compatible oats CLI.");
    }
  };
}
/** Choose oats…, Retry and the docs link, wired on an element that holds them. */
function wireActions(el, doc, ctx, probe) {
  el.querySelector(".cli-retry").addEventListener("click", () => probe());
  const choose = el.querySelector(".cli-choose");
  if (typeof ctx.chooseCliBinary === "function") {
    choose.addEventListener("click", () => probe(true));
  } else choose.disabled = true;
  el.querySelector(".cli-docs").addEventListener("click", (e) => {
    e.preventDefault();
    if (typeof ctx.openExternal === "function") ctx.openExternal(DOCS_URL);
    else doc.defaultView.open?.(DOCS_URL, "_blank", "noreferrer");
  });
}
const ACTIONS_HTML = `<div class="cli-actions">
        <button class="act cli-choose">Choose oats…</button>
        <button class="act cli-retry">Retry</button>
        <a class="cli-docs" href="#" title="${escapeHtml(DOCS_URL)}">CLI setup docs</a>
        <span class="cli-status" role="status"></span>
      </div>`;

/** The notice, in the card's place, while the accepted CLI is above this Desktop's tested bound
 * (oats-project/oats#1879): ONE line from the shared sentence builder (packages/client/above-tested-notice.mjs)
 * naming the Desktop to install, which actions are off and why; below it the GitHub Release of that version;
 * then Choose oats…, Retry and the docs link. No install command: installing the CLI this Desktop pins would
 * downgrade it. Empty (and hidden) while the CLI is not above the bound. */
export function aboveTestedCard(doc, ctx) {
  const el = doc.createElement("div");
  el.className = "cli-card cli-above-tested";
  let alive = true;
  const probe = probeAction(el, ctx, () => alive, () => !!cliAboveTested());
  const render = () => {
    if (!alive) return;
    const state = cliAboveTested();
    el.hidden = !state;
    if (!state) { el.replaceChildren(); return; }
    el.innerHTML = `
      <p class="cli-notice" role="status"><span class="glyph" aria-hidden="true">${icon("warning", { size: 14 })}</span> ${escapeHtml(state.message)}</p>
      <a class="cli-release" href="#" title="${escapeHtml(state.release)}">${escapeHtml(state.release)}</a>
      ${ACTIONS_HTML}`;
    el.querySelector(".cli-release").addEventListener("click", (e) => {
      e.preventDefault();
      if (typeof ctx.openExternal === "function") ctx.openExternal(state.release);
      else doc.defaultView.open?.(state.release, "_blank", "noreferrer");
    });
    wireActions(el, doc, ctx, probe);
  };
  render();
  const off = onCliChange(render);
  return { el, dispose() { alive = false; off(); } };
}

/** The one degradation card. `ctx` needs api(); optional ctx.chooseCliBinary
 * (native picker via preload) and ctx.openExternal for the docs link. */
export function cliCard(doc, ctx) {
  const el = doc.createElement("div");
  el.className = "cli-card";
  let alive = true;
  const probe = probeAction(el, ctx, () => alive, () => !cliAvailable());
  const render = () => {
    if (!alive) return;
    const s = cli;
    const tried = Array.isArray(s?.tried) ? s.tried : [];
    const candidates = tried.filter((t) => typeof t?.path === "string" && t.path);
    const detected = typeof s?.bin === "string" && s.bin
      ? { path: s.bin, version: s.version }
      : candidates.find((t) => typeof t.version === "string" && t.version) || candidates[0];
    const version = typeof detected?.version === "string" && detected.version ? detected.version : "unknown";
    // The Desktop older than the CLI it found: that CLI's only failure is a newer desktop API (desktopApi > 1). A CLI
    // that is only of a later minor is accepted instead (aboveTestedCard). Without a version to name, the card is the
    // usual one.
    const api = s?.required?.desktopApi ?? 1;
    const newer = detected?.newerApi === true && typeof detected.version === "string" ? displayLine(detected.version) : null;
    el.innerHTML = `
      <div class="cli-head"><span class="glyph" aria-hidden="true">${icon("warning", { size: 14 })}</span> ${newer
        ? "This Desktop is older than the installed <code>oats</code> CLI"
        : "Compatible <code>oats</code> CLI required"}</div>
      <div class="cli-body">
        ${newer
          ? `<p class="cli-explanation">The installed <code>oats</code> CLI is ${escapeHtml(newer)}, which speaks a newer desktop API than this
        Desktop's (${escapeHtml(String(api))}). Install OATS Desktop ${escapeHtml(newer)} to use it; reads and terminals keep working meanwhile.</p>`
          : `<p class="cli-explanation">Spawn, Start and other changes run through the installed <code>oats</code> CLI. Reads and
        terminals keep working without it.</p>`}
        <div class="cli-kv">
          <span class="k">Detected</span>
          <span class="v">${detected
            ? `${version === "unknown" ? "candidate: " : ""}${escapeHtml(detected.path)} <span class="cli-ver">(${escapeHtml(version)})</span>`
            : "unknown — no CLI detection reported"}</span>
          <span class="k">Required</span>
          <span class="v">${escapeHtml(cliRequirementText(s))}</span>
        </div>
        ${newer ? "" : `<div class="cli-install">
          <code class="cli-cmd">${escapeHtml(cliInstallCommand(s))}</code>
          <button class="act cli-copy" title="Copy install command">Copy</button>
        </div>`}
      </div>
      ${ACTIONS_HTML}`;
    el.querySelector(".cli-copy")?.addEventListener("click", async () => {
      try { await doc.defaultView.navigator.clipboard.writeText(cliInstallCommand()); } catch { /* clipboard denied */ }
      const st = el.querySelector(".cli-status");
      if (st) st.textContent = "Install command copied.";
    });
    wireActions(el, doc, ctx, probe);
  };
  render();
  const off = onCliChange(render);
  // dispose with the element: observe removal via the returned disposer
  return { el, dispose() { alive = false; off(); } };
}
