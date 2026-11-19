/** Spawn dialog on workspace model v2.
 *
 * What the operator sees is what the kernel decided: the dialog reads a spawn
 * preview in the background whenever a choice changes (latest intent wins)
 * and shows the real defaults — instance name, harness, model and where it
 * came from, the work area, branch and base. Nothing here derives a path or a
 * default; the only name it spells is the one the form states exactly.
 *
 * Editing never waits on a read: fields stay live, and after the first answer
 * the preview column keeps the last settled facts, marked Updating…, until the
 * answer for the choices on screen lands (docs/desktop-spawn-preview.md).
 *
 * Spawn is one click, pressable whenever the form is valid: a press before the
 * preview for those choices settled waits for it. The server prepares a fresh confirmation, and only when
 * its decision is the one on screen does it apply it (`--expect-decision`,
 * idempotency key). If the world moved, the dialog shows the new values and
 * asks again. An unknown outcome is checked on the same intent, never retried
 * under a new one. */
import { retainedSpawnMessage, differedLines, flagIgnoredNotice } from '../../client/launch-prompt-outcome.mjs';
import { launchDiffered, launchDifferedCSS } from './launch-differed.mjs';
import { harnessOf } from '../../client/harness-names.mjs';
import { createSoulMark, createRuntimeBadge } from './identity-marks.mjs';
import { distinguishingRootTags } from '../../client/instance-tree.mjs';
import { createChoicePopup } from './choice-popup.mjs';
import { postJson, workspaceGeneration, wsQuery } from './views/common.mjs';
import { previewSupported, previewChoices, previewData, previewTarget, previewFailure, INSTANCE_NAME_MAX, suggestSupported,
  instanceSuggestSupported, instanceSuggestion, APPLY_SUGGEST_FEATURE, SUGGEST_HARNESSES } from '../../client/spawn-preview-contract.mjs';
import { SUGGEST_DEBOUNCE_MS, SUGGEST_MIN_WORDS, taskWords, namingKey, numberedLine } from '../../client/spawn-naming.mjs';
import { answeringFeatures } from '../../client/lifecycle-contract.mjs';
import { spawnApplySupported, spawnPrepareInput, spawnApplyReason, ROLLED_BACK_CODES } from '../../client/spawn-apply-contract.mjs';
import { createSpawnTransaction } from '../../client/spawn-transaction.mjs';
import { spawnProblem, rolledBackProblem, cleanupOwedProblem } from '../../client/spawn-messages.mjs';
import { spawnText, outcomeText } from './spawn-words.mjs';
import { kernelLines } from '../../client/kernel-lines.mjs';
import { DESKTOP_TERMS } from './desktop-terms.mjs';
import { RECOVER_POLL_MS } from './spawn-jobs.mjs';
import { wakeScheduleFields } from './wake-schedule-fields.mjs';
import { iconElement } from './shell-icons.mjs';
import { createWarningsList, capabilityWarningsCSS, WARNINGS_COPY } from './capability-warnings.mjs';
import { shownLaunch, launchHarnessName, launchModelText, launchFromText, preferenceText, declaredDiffers } from '../../client/launch-view.mjs';
import { previewFacts } from '../../client/spawn-preview-facts.mjs';
import { createSpawnDeploymentField, spawnDeployments } from './spawn-deployment-field.mjs';
import { openAddMachineDialog } from './add-machine-dialog.mjs';
import { followBackfill, BACKFILL_POLL_MS } from '../../client/machine-contract.mjs';

export const PREVIEW_DEBOUNCE_MS = 250;
/** Where to run's last entry: opens Add a machine (never a registration id, which is [a-z0-9-]). */
const ADD_MACHINE = '+add-machine';
/** E_BUSY (the server's two-read budget) is retried inside the dialog: as soon as one of its own reads
 * lands, else after this delay, for about the CLI's 30 s timeout before it shows as a failure. */
export const PREVIEW_BUSY_RETRY_MS = 400;
const BUSY_RETRIES = 75;
import { HARNESS_NAMES as RUNTIME_NAMES } from '../../client/harness-names.mjs';
export { RUNTIME_NAMES };
const PURPOSE = /^[a-z0-9][a-z0-9-]*$/i;
/** The kernel's name refusals: said next to the Name field, not only in the footer. */
const NAME_REFUSALS = ['E_INSTANCE_NAME_INVALID', 'E_INSTANCE_NAME_TAKEN'];

/** The one-column dialog: the stylesheet's media query and the preview's place (placePreview) read it. */
export const SPAWN_NARROW = '(max-width:760px)';
export const spawnDialogCSS = `
/* The modal centres in a grid whose auto track grows to the dialog, so 100% would not cap it: the viewport does. */
.spawn-modal .spawn-dialog { width:880px; max-width:calc(100vw - 48px); box-sizing:border-box; max-height:calc(100vh - 48px); padding:0; gap:0; overflow:hidden; background:var(--surface); box-shadow:var(--shadow-modal); }
/* Two layouts, switched in place (design board 6): 'picker' = soul chooser + form; 'scoped' = the
   preview of what the kernel will create + form, for one soul. Hidden columns stay in the DOM under
   [hidden] so the host's focus trap skips them. */
.spawn-modal .spawn-dialog[data-layout=scoped] { width:1000px; }
.spawn-modal .spawn-dialog-head { min-height:52px; flex:none; align-items:center; gap:10px; padding:0 12px 0 20px; border-bottom:1px solid var(--border); }
.spawn-modal .spawn-dialog-head h2 { flex:none; font-size:15px; font-weight:700; }
.spawn-head-copy { flex:1; min-width:0; display:flex; align-items:center; gap:10px; }
.spawn-context { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--muted); font-size:12px; }
.spawn-modal .spawn-dialog[data-layout=scoped] .spawn-dialog-head { min-height:0; padding:16px 12px 16px 20px; gap:12px; }
.spawn-dialog-head .spawn-head-mark { width:34px; height:34px; border-radius:9px; font-size:14px; }
.spawn-dialog[data-layout=scoped] .spawn-head-copy { flex-direction:column; align-items:stretch; gap:1px; }
.spawn-modal .spawn-dialog[data-layout=scoped] .spawn-dialog-head h2 { font-size:16px; }
/* A link, not a button: the soul is the dialog's subject, changing it is a side path. */
.spawn-change-soul { flex:none; border:0; background:none; padding:0; font-weight:600; font-size:12px; line-height:normal; font-family:var(--ui-font,system-ui); color:var(--accent); cursor:pointer; }
.spawn-change-soul:hover { text-decoration:underline; text-underline-offset:2px; }
/* Add a machine under the Deployment field (two or more deployments): a side path, a link. */
.spawn-add-machine { gap:4px; }
.spawn-add-machine-button { align-self:flex-start; border:0; background:none; padding:0; font-weight:600; font-size:12px; line-height:normal; font-family:var(--ui-font,system-ui); color:var(--accent); cursor:pointer; }
.spawn-add-machine-button:hover { text-decoration:underline; text-underline-offset:2px; }
.spawn-add-machine-button:focus-visible { outline:none; background:var(--sel); border-radius:4px; }
.spawn-add-machine-note:empty { display:none; }
.spawn-dialog .close-act { flex:none; margin-left:auto; display:grid; place-items:center; }
.spawn-columns { display:grid; grid-template-columns:300px minmax(0,1fr); height:calc(100vh - 100px); max-height:700px; min-height:0; overflow:hidden; }
.spawn-dialog[data-layout=scoped] .spawn-columns { grid-template-columns:360px minmax(0,1fr); }
/* The preview column: what the kernel will create, re-drawn from every observation. A named size
   container: below ~300px of content width its facts stack label-above-value. */
.spawn-preview { display:flex; flex-direction:column; gap:16px; min-width:0; min-height:0; overflow:auto; padding:18px 20px; box-sizing:border-box; background:var(--surface-2); border-right:1px solid var(--border); container:spawn-preview / inline-size; }
/* Narrow (placePreview): in the form's scroll area after its last field, as a card, at its full height. */
.spawn-form-body > .spawn-preview { flex:none; overflow:visible; padding:14px; border:1px solid var(--border); border-radius:10px; }
.spawn-preview-section { display:flex; flex-direction:column; gap:6px; min-width:0; }
.spawn-preview-body { display:flex; flex-direction:column; gap:12px; min-width:0; }
.spawn-preview-title { margin:0; font-size:10.5px; font-weight:650; letter-spacing:.065em; text-transform:uppercase; color:var(--muted); }
/* A newer preview is reading: the settled facts stay, and the title line says so in words (never fading the text: AA). */
.spawn-preview-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; min-width:0; }
.spawn-preview-updating { flex:none; font-size:10.5px; font-weight:600; color:var(--muted); }
/* The instance first and largest, its home beneath (shortened; the full path is its title). */
.spawn-preview-identity { display:flex; flex-direction:column; gap:2px; margin:0; min-width:0; }
.spawn-preview-identity dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.spawn-preview-name { color:var(--fg); font-weight:650; font-size:13.5px; line-height:1.45; font-family:var(--mono,monospace); }
.spawn-preview-home { color:var(--muted); font-weight:normal; font-size:11.5px; line-height:1.45; font-family:var(--mono,monospace); }
/* The facts: a label column and a value column; a value's origin or extra on its own muted line. */
.spawn-preview-facts { display:grid; grid-template-columns:86px minmax(0,1fr); row-gap:8px; column-gap:10px; margin:0; font-size:12.5px; line-height:1.5; color:var(--fg); }
.spawn-preview-facts dt { margin:0; color:var(--muted); font-size:11.5px; line-height:1.6; }
.spawn-preview-facts dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.spawn-preview-facts .mono, .spawn-core-row .mono, .spawn-cap-row .mono { font-family:var(--mono,monospace); }
.spawn-preview .muted { color:var(--muted); }
.spawn-preview-facts .spawn-fact-sub { display:block; font-size:11.5px; line-height:1.45; }
.spawn-preview-harness { display:flex; align-items:center; gap:6px; min-width:0; }
.spawn-preview-harness .runtime-badge { flex:none; width:16px; height:16px; border-radius:4px; font-size:9px; }
/* Launch prompts: a policy note, not a fact; full width at the section's end. */
.spawn-preview-prompts { display:flex; flex-direction:column; gap:2px; margin:0; padding:8px 10px; border-radius:6px; background:var(--surface); font-size:11.5px; line-height:1.5; color:var(--muted); }
.spawn-preview-prompts dt { margin:0; font-weight:650; }
.spawn-preview-prompts dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.spawn-preview-prompts dd + dt { margin-top:4px; }
@container spawn-preview (max-width:299px) {
 .spawn-preview-facts { grid-template-columns:minmax(0,1fr); row-gap:0; }
 .spawn-preview-facts dd { margin-bottom:8px; }
 .spawn-preview-facts dd:last-child { margin-bottom:0; }
}
/* Loading: the shape of the facts, no words (the sr-only text says it). */
.spawn-preview-skeleton { display:grid; grid-template-columns:86px minmax(0,1fr); row-gap:10px; column-gap:10px; align-items:center; }
.spawn-preview-skeleton span { display:block; height:12px; border-radius:6px; background:var(--tag-bg); }
.spawn-preview-skeleton span:nth-child(odd) { width:56px; }
.spawn-preview-skeleton span:nth-child(2) { width:72%; }
.spawn-preview-skeleton span:nth-child(4) { width:46%; }
.spawn-preview-skeleton span:nth-child(6) { width:60%; }
.spawn-preview-skeleton span:nth-child(8) { width:34%; }
.spawn-preview-failure { margin:0; font-size:12.5px; line-height:1.5; color:var(--warn); overflow-wrap:anywhere; }
.spawn-preview-empty { margin:0; font-size:12.5px; line-height:1.5; color:var(--muted); overflow-wrap:anywhere; }
.spawn-core-box, .spawn-cap-list { display:flex; flex-direction:column; border:1px solid var(--border); border-radius:8px; background:var(--surface); font-size:12px; line-height:1.45; color:var(--fg); }
/* One row grammar for both boxes, the same at every width: line 1 the module (mono, wraps anywhere),
   line 2 its source and reason chips, left-aligned and wrapping as a group. A core row leads with its
   slot as a fixed left column. Nothing is right-justified. */
.spawn-core-row, .spawn-cap-row { min-width:0; padding:7px 10px; border-bottom:1px solid var(--border); }
.spawn-core-row:last-child, .spawn-cap-row:last-child { border-bottom:0; }
.spawn-core-row { display:grid; grid-template-columns:84px minmax(0,1fr); column-gap:8px; align-items:baseline; }
.spawn-core-row .spawn-core-layer { color:var(--muted); }
.spawn-cap-row, .spawn-core-module { display:flex; flex-direction:column; align-items:flex-start; gap:4px; min-width:0; }
.spawn-core-row .mono, .spawn-cap-row .mono, .spawn-core-row .muted { max-width:100%; min-width:0; overflow-wrap:anywhere; }
.spawn-core-row .muted, .spawn-cap-row .muted, .spawn-cap-row.spawn-cap-none { color:var(--muted); }
.spawn-cap-tags { display:flex; flex-wrap:wrap; justify-content:flex-start; gap:4px 6px; max-width:100%; min-width:0; }
.spawn-cap-source, .spawn-cap-why { max-width:100%; padding:1px 6px; border-radius:4px; background:var(--tag-bg); color:var(--muted); font-size:10.5px; font-weight:600; overflow-wrap:anywhere; }
.spawn-preview-note { margin:auto 0 0; font-size:11.5px; line-height:1.5; color:var(--muted); }
.spawn-chooser { border-right:1px solid var(--border); min-width:0; min-height:0; overflow:auto; padding:16px 10px 12px; }
.spawn-chooser-head { display:flex; align-items:baseline; justify-content:space-between; gap:8px; margin:0 6px 10px; }
.spawn-chooser-title { margin:0; font-size:13px; font-weight:650; color:var(--fg); }
.spawn-search-label { display:flex; align-items:center; gap:6px; margin:0 4px 10px; }
.spawn-search-label input { min-width:0; flex:1; }
.spawn-search-count { flex:none; color:var(--muted); font-weight:normal; font-size:10.5px; line-height:normal; font-family:var(--mono,monospace); }
.spawn-chooser h3 { margin:14px 8px var(--title-gap); font-size:10.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); overflow-wrap:anywhere; }
.spawn-choice { width:100%; min-height:56px; display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid transparent; border-radius:8px; text-align:left; background:var(--surface); color:var(--fg); font:inherit; cursor:pointer; }
.spawn-choice[aria-selected=true] { background:var(--sel); border-color:var(--accent); }
.spawn-choice .spawn-choice-check { flex:none; color:var(--accent); visibility:hidden; }
.spawn-choice[aria-selected=true] .spawn-choice-check { visibility:visible; }
.spawn-choice:disabled { color:var(--muted); cursor:default; }
.spawn-choice-copy { min-width:0; display:flex; flex:1; flex-direction:column; gap:1px; }
.spawn-choice strong { font-size:12.5px; overflow-wrap:anywhere; }
.spawn-choice small { font-size:11px; line-height:1.5; color:var(--muted); overflow-wrap:anywhere; }
.spawn-choice .identity-mark { flex:none; width:30px; height:30px; border-radius:8px; }
.spawn-chooser-note { margin:6px 8px; color:var(--muted); font-size:11.5px; line-height:1.5; overflow-wrap:anywhere; }
.spawn-chooser-note:empty { display:none; }
.spawn-form { min-width:0; min-height:0; overflow:hidden; display:flex; flex-direction:column; }
.spawn-form-body { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:var(--section-gap); padding:20px 24px; box-sizing:border-box; }
.spawn-field { display:flex; flex-direction:column; gap:var(--title-gap); min-width:0; margin:0; padding:0; border:0; }
/* a legend is not a flex item: the title gap is its own margin */
.spawn-field > legend { margin-bottom:var(--title-gap); }
.spawn-label, .spawn-field > label, .spawn-name > label, .spawn-row > label > .spawn-label-text, .spawn-field > legend { display:flex; align-items:center; gap:6px; padding:0; font-size:11.5px; font-weight:650; color:var(--muted); }
.spawn-label .shell-icon { color:var(--muted); }
.spawn-label small { font-weight:500; }
/* Spec E: a section's jump chord, quiet beside its label (never the only way to learn it: the editor lists it) */
.spawn-dialog kbd.spawn-key-hint { flex:none; margin:0; padding:0; border:0; background:none; font-weight:500; font-size:10.5px; line-height:normal; font-family:var(--mono,monospace); letter-spacing:0; text-transform:none; color:var(--muted); white-space:nowrap; }
.spawn-dialog kbd.spawn-key-hint[hidden] { display:none; }
.spawn-row { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
.spawn-row > label { display:flex; flex-direction:column; gap:var(--title-gap); min-width:0; }
.spawn-form .field { min-width:0; width:100%; box-sizing:border-box; }
/* Focus is the shell's (rule 2/3: fields turn their border accent); a joined wrapper is the one frame of its inputs. */
.spawn-joined:focus-within { border-color:var(--accent); }
/* Name: optional, the form's last field. One frame (the wrapper's border) that turns to the accent on focus; no ring. */
.spawn-name-input { display:flex; align-items:stretch; min-width:0; height:36px; border:1px solid var(--border); border-radius:8px; background:var(--surface); }
.spawn-name-input:focus-within { border-color:var(--accent); box-shadow:none; outline:none; }
.spawn-name-prefix { flex:none; display:flex; align-items:center; max-width:55%; padding:0 0 0 12px; color:var(--muted); font-weight:normal; font-size:13px; line-height:normal; font-family:var(--mono,monospace); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.spawn-name-input input.field { flex:1; height:100%; border:0; border-radius:8px; background:transparent; padding:0 12px 0 1px; font-weight:600; font-size:13px; line-height:normal; font-family:var(--mono,monospace); color:var(--fg); }
.spawn-dialog .spawn-name-input input.field, .spawn-dialog .spawn-name-input input.field:focus, .spawn-dialog .spawn-name-input input.field:focus-visible { outline:none; border:0; box-shadow:none; }
.spawn-name-result { display:flex; align-items:center; gap:6px; }
/* The <soul>- prefix is shown only where the typed name is a purpose (an older kernel, a remote target). */
.spawn-name-input.unprefixed .spawn-name-prefix { display:none; }
.spawn-name-input.unprefixed input.field { padding-left:12px; }
.spawn-name-result strong { font-weight:600; font-size:11.5px; line-height:normal; font-family:var(--mono,monospace); color:var(--fg); }
.spawn-hint { margin:0; color:var(--muted); font-size:11.5px; line-height:1.5; overflow-wrap:anywhere; }
.spawn-hint:empty { display:none; }
.spawn-hint code, .spawn-work-text code { font-weight:normal; font-size:11.5px; line-height:normal; font-family:var(--mono,monospace); color:var(--fg); }
.spawn-hint.err { color:var(--danger); }
/* Teams (teams contract): one line like Relationship — Default fixed on, mapped teams toggle, unmapped greyed. */
.spawn-teams-row { flex-wrap:wrap; align-self:flex-start; max-width:100%; box-sizing:border-box; }
.spawn-seg input:disabled { cursor:default; }
/* A shared team with no provider id yet: shown, not choosable (muted text, still AA; no opacity). */
.spawn-seg .spawn-team-off .spawn-team-name { color:var(--muted); cursor:default; }
/* Default is fixed, not a choice: a quiet neutral chip (its own hairline, not the accent tint). */
.spawn-seg .spawn-team-fixed input:checked + span { background:var(--surface); color:var(--fg); font-weight:500; box-shadow:inset 0 0 0 1px var(--border); cursor:default; }
/* Runtime picker and model field */
.spawn-run .spawn-choice-trigger, .spawn-deployment .spawn-choice-trigger { height:38px; min-height:38px; border-radius:8px; }
.spawn-run .spawn-choice-trigger .runtime-badge, .spawn-choice-menu .runtime-badge { flex:none; width:20px; height:20px; border-radius:5px; display:grid; place-items:center; font-size:9.5px; font-weight:700; }
.spawn-choice-menu button.has-mark { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.spawn-choice-menu button.has-mark small { flex-basis:100%; margin-left:30px; margin-top:-2px; }
.spawn-trigger-tag, .spawn-input-tag { flex:none; padding:1px 7px; border-radius:999px; background:var(--chip-bg); color:var(--muted); font-weight:600; font-size:10.5px; line-height:normal; font-family:var(--ui-font,system-ui); }
.spawn-trigger-tag { margin-left:2px; }
.spawn-input-tag:empty { display:none; }
.spawn-model-default { position:absolute; left:11px; right:80px; top:50%; transform:translateY(-50%); pointer-events:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; font-size:12.5px; line-height:normal; font-family:var(--ui-font,system-ui); color:var(--fg); }
.spawn-model-default:empty, .spawn-model-field input.field:not(:placeholder-shown) ~ .spawn-model-default { display:none; }
.spawn-model-controls { display:flex; gap:4px; min-width:0; }
.spawn-model-field { position:relative; flex:1; min-width:0; display:flex; }
.spawn-model-field input.field { height:38px; border-radius:8px; padding-right:80px; }
.spawn-input-tag { position:absolute; right:10px; top:50%; transform:translateY(-50%); pointer-events:none; max-width:84px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.spawn-run .spawn-choice-trigger::after, .spawn-deployment .spawn-choice-trigger::after { margin-left:auto; }
.spawn-model-controls .spawn-choice-popover { flex:none; }
.spawn-model-controls .spawn-choice-trigger { width:38px; height:38px; min-height:38px; padding:0 10px; border-radius:8px; }
.spawn-model-controls .spawn-choice-trigger::after { margin-left:0; }
.spawn-model-controls .spawn-choice-menu { left:auto; right:0; }
/* Work */
.spawn-joined { display:flex; align-items:stretch; min-width:0; height:38px; border:1px solid var(--border); border-radius:8px; background:var(--surface); overflow:hidden; }
.spawn-joined-from { flex:none; display:flex; align-items:center; gap:6px; padding:0 4px 0 10px; background:var(--surface-2); border-right:1px solid var(--border); color:var(--muted); font-size:11.5px; }
.spawn-joined-from input.field { width:112px; height:100%; border:0; background:transparent; padding:0 6px; font-weight:700; font-size:12px; line-height:normal; font-family:var(--mono,monospace); color:var(--fg); }
.spawn-joined > input.field { flex:1; height:100%; border:0; border-radius:0; background:transparent; padding:0 10px; font-weight:normal; font-size:12.5px; line-height:normal; font-family:var(--mono,monospace); }
.spawn-joined input.field:focus-visible { box-shadow:none; }
.spawn-work-text { margin:0; font-size:12.5px; line-height:1.5; color:var(--fg); overflow-wrap:anywhere; }
.spawn-work-text:empty { display:none; }
.spawn-switch { display:flex; align-items:center; gap:9px; font-size:12px; color:var(--fg); cursor:pointer; width:max-content; }
.spawn-switch[hidden] { display:none; }
.spawn-switch input { appearance:none; -webkit-appearance:none; flex:none; width:30px; height:18px; margin:0; border-radius:999px; background:var(--muted); position:relative; cursor:pointer; transition:background .15s; }
.spawn-switch input::before { content:''; position:absolute; top:3px; left:3px; width:12px; height:12px; border-radius:50%; background:var(--surface); transition:left .15s; }
.spawn-switch input:checked { background:var(--primary-bg); }
.spawn-switch input:checked::before { left:15px; }
/* Relationship: a segmented control per the shared control rules — one outer frame, tinted
   selection (never white-vs-grey), keyboard focus as tint + a 1px accent edge, no ring on click. */
.spawn-relationship-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; min-width:0; }
.spawn-seg { display:inline-flex; flex:none; gap:2px; padding:2px; border:1px solid var(--border); border-radius:8px; background:var(--surface); }
.spawn-seg label { position:relative; display:block; cursor:pointer; }
.spawn-seg input { position:absolute; inset:0; appearance:none; -webkit-appearance:none; margin:0; border:0; background:transparent; cursor:pointer; }
.spawn-seg span { display:flex; align-items:center; height:28px; padding:0 12px; border-radius:6px; font-size:12px; font-weight:500; color:var(--muted); white-space:nowrap; }
.spawn-seg input:checked + span { background:var(--sel); color:var(--accent); font-weight:650; }
.spawn-seg input:focus-visible + span { background:var(--sel); box-shadow:inset 0 0 0 1px var(--accent); }
.spawn-relationship-row .frelto { flex:1 1 200px; width:auto; min-width:0; height:34px; }
.spawn-relationship-row .frelto[hidden] { display:none; }
/* Deployment (spawn-deployment-field.mjs): the segmented control at its own width (wrapping before it overflows); a deployment's state is the Harness trigger's tag. */
.spawn-deployment .spawn-seg { align-self:flex-start; flex-wrap:wrap; max-width:100%; box-sizing:border-box; }
.spawn-seg .spawn-trigger-tag { margin-left:8px; }
.spawn-server-hint:empty { display:none; }
.spawn-form .ftask { min-height:88px; resize:vertical; border-radius:8px; line-height:1.5; }
/* Developer settings */
.spawn-advanced { border:1px solid var(--border); border-radius:10px; background:var(--surface-2); }
.spawn-advanced > summary { display:flex; align-items:center; gap:8px; padding:11px 14px; cursor:pointer; list-style:none; font-size:12px; font-weight:650; color:var(--fg); }
.spawn-advanced > summary::-webkit-details-marker { display:none; }
.spawn-advanced > summary::before { content:''; flex:none; width:6px; height:6px; margin:0 2px; border-right:1.5px solid var(--muted); border-bottom:1.5px solid var(--muted); transform:rotate(-45deg); transition:transform .15s; }
.spawn-advanced[open] > summary::before { transform:rotate(45deg); }
.spawn-advanced > summary { flex-wrap:wrap; row-gap:2px; }
/* The topics hint: beside the title when it fits whole, else on its own line below it (never broken
   mid-phrase beside it); with no room at all it is clipped, never pushing the summary wider. */
.spawn-advanced > summary small { flex:0 1 auto; min-width:0; margin-left:auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:400; color:var(--muted); font-size:11px; }
.spawn-advanced { container:spawn-advanced / inline-size; }
@container spawn-advanced (max-width:479px) {
 /* No room beside the title: the hint drops to its own line, under the title's text (past the chevron). */
 .spawn-advanced > summary small { flex-basis:100%; margin-left:18px; }
}
.spawn-advanced-body { display:flex; flex-direction:column; gap:14px; padding:4px 14px 14px; }
.spawn-advanced-body [hidden] { display:none; }
.spawn-dialog fieldset.frelgroup { border:1px solid var(--border); border-radius:8px; margin:0; padding:8px 10px 10px; display:flex; flex-direction:column; gap:8px; background:var(--surface); }
.spawn-dialog fieldset.frelgroup legend { font-size:11.5px; font-weight:650; color:var(--muted); padding:0 4px; }
.spawn-dialog fieldset.frelgroup label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
.spawn-dialog .freldesc { font-size:11.5px; color:var(--muted); }
.spawn-dialog .freldesc:empty { display:none; }
.spawn-footer { flex:none; display:flex; align-items:center; gap:8px; flex-wrap:wrap; border-top:1px solid var(--border); padding:12px 24px; background:var(--surface); }
.spawn-status { flex:1 1 160px; min-width:0; display:flex; align-items:baseline; flex-wrap:wrap; gap:2px 10px; }
/* Cancel and Spawn are one group, right-aligned on one line at every width: the status yields first
   (its text wraps beside them, or the whole status sits on its own line above them). */
.spawn-actions { flex:none; display:flex; align-items:center; gap:8px; margin-left:auto; }
.spawn-footer .fstatus { flex:0 1 auto; margin:0; min-width:0; font-size:12.5px; line-height:1.5; color:var(--muted); overflow-wrap:break-word; white-space:pre-line; }
.spawn-footer .fstatus.err { color:var(--danger); }
/* Board 6: a settled preview says so; the check is decoration (empty alt), the words are the status. */
.spawn-footer .fstatus.ok::before { content:"\\2713" / ""; margin-right:5px; color:var(--ok); font-weight:700; }
.spawn-inflight { flex:1 0 100%; margin:0; font-size:12.5px; line-height:1.5; color:var(--fg); }
.spawn-inflight[hidden] { display:none; }
.spawn-inflight-show { border:0; background:none; padding:0; font:inherit; color:var(--accent); text-decoration:underline; text-underline-offset:2px; cursor:pointer; }
.spawn-details-toggle { flex:none; border:0; background:none; padding:0; font:inherit; font-size:12px; color:var(--muted); text-decoration:underline; text-underline-offset:2px; cursor:pointer; }
.spawn-details-toggle:hover { color:var(--fg); }
.spawn-details-toggle[hidden], .spawn-problem-detail[hidden] { display:none; }
.spawn-problem-detail { order:9; flex:1 0 100%; margin:0; padding:8px 10px; border-radius:6px; background:var(--surface-2); color:var(--muted); font-size:11.5px; line-height:1.5; overflow-wrap:anywhere; max-height:96px; overflow:auto; }
/* A kernel text quoted under the code, each on its own line (packages/client/kernel-lines.mjs). */
.spawn-problem-line { display:block; color:var(--muted); }
/* What a blocked launch differed in: under the status, on its own line, never inside it. Its host's CSS holds the quote treatment. */
.spawn-status-differed { order:8; flex:1 0 100%; min-width:0; }
${launchDifferedCSS}
.spawn-footer .act { min-height:34px; padding:0 16px; border-radius:8px; font-weight:600; }
/* data-chord, not data-shortcut: the shell rewrites [data-shortcut] elements as action-id hints. */
.spawn-footer .fspawn::after { content:attr(data-chord); margin-left:8px; font-weight:normal; font-size:10.5px; line-height:normal; font-family:var(--mono,monospace); }
.oats-view .spawn-footer button.fspawn:not(:disabled) { background:var(--primary-bg); color:var(--primary-fg); border-color:var(--primary-bg); }
.spawn-choice-popover { position:relative; min-width:0; }
.spawn-choice-trigger { width:100%; min-height:36px; border:1px solid var(--border); border-radius:7px; background:var(--surface); color:var(--fg); font-weight:600; font-size:12.5px; line-height:normal; font-family:var(--ui-font,system-ui); text-align:left; padding:0 10px; display:flex; align-items:center; gap:8px; cursor:pointer; }
.spawn-choice-trigger::after { content:''; flex:none; width:6px; height:6px; margin:-3px 3px 0 auto; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:rotate(45deg); color:var(--muted); }
.spawn-choice-menu { position:absolute; left:0; top:calc(100% + 4px); width:min(300px,calc(100vw - 60px)); max-height:260px; overflow:auto; z-index:2; border:1px solid var(--border); border-radius:9px; padding:6px; box-shadow:var(--shadow-popover); background:var(--surface); }
.spawn-dialog .spawn-popup-search input.field { min-height:30px; height:30px; padding:0 8px; font-size:12px; }
.spawn-popup-search { position:sticky; top:0; z-index:1; background:var(--surface); padding:0 2px 6px; border-bottom:1px solid var(--border); margin-bottom:4px; }
.spawn-popup-group { padding:6px 8px 3px; font-size:10px; font-weight:650; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
.spawn-popup-status { padding:6px 8px; margin:0; color:var(--muted); font-size:11.5px; }
.spawn-popup-status:empty { display:none; }
.spawn-choice-menu button { width:100%; min-height:36px; border:0; border-radius:6px; background:var(--surface); color:var(--fg); text-align:left; padding:8px 9px; font-weight:normal; font-size:12.5px; line-height:normal; font-family:var(--ui-font,system-ui); cursor:pointer; }
.spawn-choice-menu button[aria-selected=true] { background:var(--sel); }
.spawn-choice-menu button:disabled { color:var(--muted); cursor:default; }
.spawn-choice-menu small { display:block; font-size:10.5px; color:var(--muted); }
/* The segmented inputs are invisible hit areas: their keyboard focus is drawn on the span (above), not on the input. */
.spawn-dialog .spawn-seg input:focus-visible { outline:none; box-shadow:none; }
.spawn-dialog [hidden] { display:none; }
@media${SPAWN_NARROW} {
 .spawn-columns, .spawn-dialog[data-layout=scoped] .spawn-columns { grid-template-columns:minmax(0,1fr); grid-template-rows:auto minmax(0,1fr); }
 .spawn-chooser { max-height:200px; border-right:0; border-bottom:1px solid var(--border); }
 /* What will be created has moved into the form (placePreview): the scoped form is the one row. */
 .spawn-dialog[data-layout=scoped] .spawn-columns { grid-template-rows:minmax(0,1fr); }
 .spawn-row { grid-template-columns:minmax(0,1fr); }
 .spawn-form-body { padding:14px; }
 .spawn-footer { padding:10px 14px; }
 .spawn-relationship-row .frelto { flex-basis:100%; }
}
/* Capability warnings (0.49.0): the shared list under its own title, at the facts' end. */
.spawn-preview-warnings { display:flex; flex-direction:column; gap:6px; min-width:0; }
${capabilityWarningsCSS}
`;

const node = (doc, tag, text, cls) => { const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
const identity = soul => JSON.stringify([soul?.agentsRoot || '', soul?.name || '', soul?.server || '']);
const short = oid => typeof oid === 'string' ? oid.slice(0, 7) : '';
export const runtimeName = value => Object.hasOwn(RUNTIME_NAMES, value) ? RUNTIME_NAMES[value] : value;

/** Human text for the kernel's model decision. */
// Where the bound identity's mode came from (settingsOrigins, feature settings-origins).
const ORIGIN_NAMES = { workspace: 'the workspace', soul: 'the soul', host: 'this host', spawn: 'this spawn' };
const originName = kind => ORIGIN_NAMES[kind] ?? kind;
/** The Launch configuration select's first entry while the kernel refuses the spawn for want of a default. */
export const NO_DEFAULT_CONFIG = 'No default: choose one';
/** The identity select's Default option: the mode only when the kernel reported
 * it — a manifest default, or another origin it names. Never a mode it did not report. */
function identityDefaultLabel(data, chosen, origins) {
  const m = data?.messaging, bound = m?.identity;
  if (!data || chosen || !bound) return 'Default';
  const shown = bound.mode === 'global' ? `global as ${bound.resident}` : bound.mode;
  // A global resident is the bound identity itself (reported by value).
  if (!origins || !m.origin) return bound.mode === 'global' ? `Default · ${shown}` : 'Default';
  return m.origin.kind === 'manifest-default' ? `Default · ${shown}` : `Default · ${shown} — from ${originName(m.origin.kind)}`;
}
function identityHintText(m, origins) {
  const said = !m.identity ? `Messaging through ${m.provider}: the provider's own default identity.`
    : m.identity.mode === 'global' ? `Messaging through ${m.provider}: acts as the resident ${m.identity.resident} through a session grant.`
      : `Messaging through ${m.provider}: gets its own team identity.`;
  if (!origins || !m.origin || m.origin.kind === 'spawn') return said;
  return `${said} ${m.origin.kind === 'manifest-default' ? "This is the provider's default" : `Set by ${originName(m.origin.kind)}`} (${m.origin.at}).`;
}
/** 0.30 launch preferences: what this spawn runs and where that choice came from (the preview's
 * Launch, flags applied), plus the soul's own preference when this spawn runs something else. */
export function launchHint(data, cli) {
  const launch = shownLaunch(data?.launch, cli);
  if (!launch) return null;
  const said = `Launches ${launchHarnessName(launch.effective.harness)} with ${launchModelText(launch.effective)} · ${launchFromText(launch.from)}.`;
  return declaredDiffers(launch) ? `${said} The soul prefers ${preferenceText(launch.declared)}.` : said;
}
export function modelText(data) {
  if (!data) return '';
  if (data.model === null) return data.modelSource === 'native default (explicit)' ? 'its own default model (chosen)' : 'its own default model';
  return data.modelSource === 'explicit' ? `${data.model} (chosen)` : `${data.model} (${data.modelSource})`;
}
/** Human text for the work area the kernel decided. */
export function workText(data, soulWork) {
  const work = data?.work ?? soulWork;
  if (work === 'worktree') return data?.branch && data.base
    ? { lead: 'Worktree on a new branch ', code: data.branch, tail: ` from ${data.base.ref} · ${short(data.base.oid)}` }
    : { lead: 'Worktree on a new branch', code: '', tail: '' };
  if (work === 'checkout') return data?.repo ? { lead: 'Works directly in the checkout at ', code: data.repo, tail: '' } : { lead: 'Works directly in the member checkout', code: '', tail: '' };
  // The instance panel's sentence (context-panel.mjs WORK_MODES.directory), so the two surfaces agree.
  if (work === 'directory') return { lead: 'Works in its own folder, not tied to one repository: free to work across repos as its task needs', code: '', tail: '' };
  if (work === 'workspace') return { lead: 'Works in the deployment workspace', code: '', tail: '' };
  return { lead: work ? `Work mode: ${work}` : '', code: '', tail: '' };
}
export function permissionText(yolo) {
  return yolo === true ? 'skips prompts' : "harness's policy";
}
/** Where a catalog soul comes from, for the scoped header (soul rows carry soulKind/package/version/repoName/origin). */
export function soulOriginText(soul) {
  if (soul?.soulKind === 'package' && soul.package) return `from package ${soul.package}${soul.version ? ` ${soul.version}` : ''}`;
  if (soul?.soulKind === 'member') return soul.repoName ? `from ${soul.repoName}` : '';
  const from = soul?.origin || soul?.repoName;
  return from ? `from ${from}` : '';
}
/** The preview column's Core capabilities and Capabilities sections (their children), from the
 * preview's `modules` rows [{name, layer, from, composedFrom?}] as previewFacts answers them
 * (packages/client/spawn-preview-facts.mjs); null when the preview carries none (no placeholder). Both are
 * bordered boxes of one row grammar: the module in mono on its own line, then its source and reason chips
 * (.spawn-cap-tags). A module filling a core slot is Core's only: never in Capabilities or its count. */
export function composePreviewModules(doc, modules) {
  const sections = previewFacts({ modules }).modules;
  if (!sections) return null;
  const el = (tag, text, cls) => node(doc, tag, text, cls);
  // Line 1 the module, line 2 its chips (one group that wraps). The reason is plain text in the row:
  // part of what a screen reader reads for it.
  const describe = (row, into, m) => {
    row.dataset.module = m.name;
    const tags = el('span', undefined, 'spawn-cap-tags'); tags.append(el('span', m.source, 'spawn-cap-source'));
    if (m.why) tags.append(el('span', m.why, 'spawn-cap-why'));
    into.append(el('span', m.name, 'mono'), tags);
  };
  const coreBox = el('div', undefined, 'spawn-core-box');
  for (const { layer, label, module: m } of sections.core) {
    const row = el('span', undefined, 'spawn-core-row'); row.dataset.layer = layer;
    row.append(el('span', label, 'spawn-core-layer'));
    if (m) { const module = el('span', undefined, 'spawn-core-module'); describe(row, module, m); row.append(module); }
    else row.append(el('span', 'None', 'muted')); // an empty slot, not a provider named "none"
    coreBox.append(row);
  }
  const capsList = el('div', undefined, 'spawn-cap-list');
  for (const m of sections.caps) { const row = el('span', undefined, 'spawn-cap-row'); describe(row, row, m); capsList.append(row); }
  if (!sections.caps.length) capsList.append(el('span', 'No other capabilities: only the core ones.', 'spawn-cap-row spawn-cap-none'));
  return { core: [el('h3', 'Core capabilities', 'spawn-preview-title'), coreBox], caps: [el('h3', `Capabilities · ${sections.caps.length}`, 'spawn-preview-title'), capsList] };
}

/** A segmented group is one tab stop (spec F): Arrow keys move along it (in a radio group they
 * also choose, as native radios do), Home/End go to its ends. The tab stop is the checked radio,
 * else the input focused last, else the first enabled one. Returns sync() for after a redraw. */
export function roveSegment(group, { selects = false } = {}) {
  const doc = group.ownerDocument;
  const inputs = () => [...group.querySelectorAll('input')].filter(input => !input.disabled && !input.closest('[hidden]'));
  let last = null;
  const sync = () => {
    const all = inputs();
    const stop = (selects && all.find(input => input.checked)) || (all.includes(last) ? last : null) || all[0];
    for (const input of group.querySelectorAll('input')) input.tabIndex = input === stop ? 0 : -1;
  };
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
  group.addEventListener('keydown', event => {
    if (!(event.key in step) && event.key !== 'Home' && event.key !== 'End') return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.keyCode === 229) return;
    const all = inputs(), at = all.indexOf(event.target);
    if (at < 0) return;
    event.preventDefault(); event.stopPropagation();
    const next = all[event.key === 'Home' ? 0 : event.key === 'End' ? all.length - 1 : (at + step[event.key] + all.length) % all.length];
    last = next;
    if (selects && !next.checked) { next.checked = true; next.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); }
    sync(); next.focus();
  });
  group.addEventListener('focusin', event => { if (inputs().includes(event.target)) { last = event.target; sync(); } });
  group.addEventListener('change', sync);
  sync();
  return sync;
}

/** The soul chooser (left column). */
function composeChooser(doc, { soul, agents, canChoose, choose, query, note }) {
  const el = (tag, text, cls) => node(doc, tag, text, cls);
  const chooser = el('section', undefined, 'spawn-chooser'); chooser.setAttribute('aria-label', 'Choose a soul');
  const searchLabel = el('label', undefined, 'spawn-search-label'), search = el('input', undefined, 'field spawn-soul-search'), count = el('span', '', 'spawn-search-count');
  search.type = 'search'; search.autocomplete = 'off'; search.placeholder = 'Search souls…'; search.setAttribute('aria-label', 'Search souls to spawn'); search.value = query;
  searchLabel.append(search);
  const head = el('div', undefined, 'spawn-chooser-head'), title = el('h2', 'Souls', 'spawn-chooser-title');
  title.id = 'spawn-chooser-title'; chooser.setAttribute('aria-labelledby', title.id); head.append(title, count);
  const list = el('div', undefined, 'spawn-soul-choices'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-labelledby', title.id);
  const empty = el('p', '', 'spawn-chooser-note spawn-chooser-empty'); empty.setAttribute('role', 'status');
  const catalogNote = el('p', note || '', 'spawn-chooser-note spawn-catalog-note');
  chooser.append(head, searchLabel, list, empty, catalogNote);
  const rows = [], groups = new Map();
  for (const candidate of agents) {
    // Grouped by the repository that declares the soul (design frame 02).
    const key = JSON.stringify([candidate.agentsRoot || '', candidate.server || '', candidate.repoName || '']);
    if (!groups.has(key)) groups.set(key, []); groups.get(key).push(candidate);
  }
  const groupLabel = first => `${first.repoName || first.server || 'Souls'}${first.server ? ` · ${first.server}` : ''}`;
  const labels = [...groups.values()].map(group => groupLabel(group[0]));
  const rootTags = distinguishingRootTags([...groups.values()].map(group => group[0].agentsRoot).filter(Boolean));
  // Repositories alphabetically; external souls last.
  const ordered = [...groups.values()].sort((a, b) => (a[0].soulKind === 'external') - (b[0].soulKind === 'external') || groupLabel(a[0]).localeCompare(groupLabel(b[0])));
  for (const group of ordered) {
    const first = group[0], groupEl = el('div'), label = groupLabel(first);
    const suffix = labels.filter(value => value === label).length > 1 ? ` · ${rootTags.get(first.agentsRoot) || first.agentsRoot || ''}` : '';
    const heading = el('h3', label + suffix); heading.title = first.agentsRoot || ''; groupEl.append(heading);
    // A listbox group, named by its heading (the listbox holds only groups and options).
    heading.id = `spawn-choice-group-${list.childElementCount}`; groupEl.setAttribute('role', 'group'); groupEl.setAttribute('aria-labelledby', heading.id);
    for (const candidate of group) {
      const row = el('button', undefined, 'spawn-choice'); row.type = 'button';
      row.dataset.agent = candidate.name; row.dataset.root = candidate.agentsRoot || ''; row.dataset.server = candidate.server || '';
      // An option of the listbox: one tab stop (roving), Arrow/Home/End move, Enter or a click picks.
      row.setAttribute('role', 'option'); row.disabled = !canChoose(candidate); row.tabIndex = -1;
      row.setAttribute('aria-selected', String(identity(candidate) === identity(soul))); row.setAttribute('aria-disabled', String(row.disabled));
      const copy = el('span', undefined, 'spawn-choice-copy');
      copy.append(el('strong', candidate.name), el('small', candidate.work === 'attached' ? 'Attached only — cannot launch standalone' : candidate.description || candidate.repoName || ''));
      const check = iconElement(doc, 'check', { size: 15, className: 'shell-icon spawn-choice-check' }); check.setAttribute('aria-hidden', 'true');
      row.append(createSoulMark(doc, candidate), copy, check);
      // A pick (a click, Space or Enter) goes on to the form's Name (Spec E).
      row.addEventListener('click', () => { if (!row.disabled && row.isConnected) choose(candidate, search.value); });
      row.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || event.isComposing) return;
        event.preventDefault(); event.stopPropagation();
        if (!row.disabled && row.isConnected) choose(candidate, search.value);
      });
      groupEl.append(row);
      rows.push({ row, group: groupEl, text: [candidate.name, candidate.description, candidate.repoName, candidate.team, candidate.server].join('\n').toLowerCase() });
    }
    list.append(groupEl);
  }
  const filter = () => {
    let shown = 0;
    for (const entry of rows) { entry.row.hidden = !entry.text.includes(search.value.toLowerCase()); if (!entry.row.hidden) shown++; }
    for (const group of list.children) group.hidden = !rows.some(entry => entry.group === group && !entry.row.hidden);
    count.textContent = `${shown} of ${rows.length}`;
    empty.textContent = shown ? '' : rows.length ? 'No souls match this filter.' : 'No souls to spawn in this workspace.';
    const visible = rows.filter(entry => !entry.row.hidden && !entry.row.disabled);
    const tabStop = visible.find(entry => entry.row === doc.activeElement) || visible.find(entry => entry.row.getAttribute('aria-selected') === 'true') || visible[0];
    for (const entry of rows) entry.row.tabIndex = entry === tabStop ? 0 : -1;
  };
  search.addEventListener('input', filter); filter();
  /** The row to land on when the chooser opens: the selected soul if the filter shows it, else the search. */
  const focusTarget = () => rows.find(entry => !entry.row.hidden && !entry.row.disabled && entry.row.getAttribute('aria-selected') === 'true')?.row || search;
  const choosable = () => rows.filter(entry => !entry.row.hidden && !entry.row.disabled);
  search.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      const entry = rows.find(item => !item.row.hidden && !item.row.disabled && item.row.tabIndex === 0);
      if (entry) { event.preventDefault(); event.stopPropagation(); entry.row.focus(); }
    } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !event.repeat) {
      // Type to filter, Enter to pick: the best match (the first shown), or with no query the
      // selected soul; then on to Name.
      const visible = choosable();
      const entry = search.value.trim() ? visible[0] : visible.find(item => item.row.getAttribute('aria-selected') === 'true') || visible[0];
      if (!entry) return;
      event.preventDefault(); event.stopPropagation();
      entry.row.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }
  });
  list.addEventListener('keydown', event => {
    // Typing on the list filters it: the character goes to the search field.
    if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
      event.preventDefault(); event.stopPropagation();
      search.value += event.key; search.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); search.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.isComposing) return;
    const visible = rows.filter(entry => !entry.row.hidden && !entry.row.disabled).map(entry => entry.row), at = visible.indexOf(doc.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
    event.preventDefault(); event.stopPropagation();
    for (const row of visible) row.tabIndex = row === visible[next] ? 0 : -1;
    visible[next]?.focus();
  });
  return { chooser, search, focusTarget };
}

/**
 * @param modal  the .spawn-modal element (backdrop); the dialog is built inside it.
 * @param opts   ctx, soul, agents, workspace(), cli(), instances(), servers (Promise|array),
 *               canChoose(soul), choose(soul, draft), close(), owns(), draft,
 *               layout 'picker' (chooser + form; the default) | 'scoped' (preview + form, one soul),
 *               onCreated(view, isCurrent) — local creation handoff,
 *               remoteSpawn(fields) — execution-server spawn (unguarded route),
 *               serverFacts() — each remote group (/api/team-members `servers`): reached, registered, souls,
 *               serverRows(group) — a remote group's roster rows (the relation picker for a chosen server),
 *               handoff(spec) — Spec C: a confirmed local press hands its transaction to the background spawn
 *                 store and the host closes the dialog (returns true when taken). Without it the dialog runs
 *                 the transaction itself (the view harness, and tests of that flow).
 *               draft.restore — { choices, wake }: every choice of an earlier press, restored (Reopen spawn).
 *               spawnInFlight() — Spec D (#383): { instance, show() } while a background spawn of this soul is in
 *                 flight in this window, else null. The press stays disabled and a polite line says so, with a
 *                 link to its pending row; the host calls syncInFlight() when the store changes.
 *               backfillDelay — #517: ms between list reads while the server learns unknown keys (BACKFILL_POLL_MS).
 *               pollDelay — #802: ms between `result` reads while a submitted spawn is pending (RECOVER_POLL_MS).
 *               suggestDelay — #1421 §3: the debounce, in ms, before the dialog asks for a name for the typed task (SUGGEST_DEBOUNCE_MS).
 *               deployments() — #482: the view's deployments (/api/panel `deployments`). With two or more the
 *                 Deployment field (spawn-deployment-field.mjs) chooses where to spawn; every spawn request
 *                 addresses a deployment, never the view.
 */
export function createSpawnDialog(modal, { ctx, soul, agents, workspace, cli, instances, canChoose, choose, close, owns,
  draft = {}, catalogNote = '', onCreated = async () => {}, remoteSpawn = async () => {}, servers = [], serverFacts = () => [], serverRows = async () => [],
  delay: debounce = PREVIEW_DEBOUNCE_MS, busyDelay = PREVIEW_BUSY_RETRY_MS, backfillDelay = BACKFILL_POLL_MS, pollDelay = RECOVER_POLL_MS, suggestDelay = SUGGEST_DEBOUNCE_MS, layout = 'picker', handoff = null, spawnInFlight = null, deployments = () => [] }) {
  const doc = modal.ownerDocument, el = (tag, text, cls) => node(doc, tag, text, cls);
  const titleId = 'spawn-dialog-title';
  const dialog = el('section', undefined, 'spawn-dialog');
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', titleId);
  // ── header: one h2 (the dialog's name) whose words follow the layout
  const header = el('div', undefined, 'spawn-dialog-head');
  const mark = createSoulMark(doc, soul); mark.classList.add('spawn-head-mark');
  const headCopy = el('div', undefined, 'spawn-head-copy');
  const title = el('h2'); title.id = titleId;
  const workspaceName = () => workspace()?.name || workspace()?.id || soul.repoName || 'this workspace';
  const context = el('span', '', 'spawn-context');
  headCopy.append(title, context);
  const changeSoul = el('button', 'Change soul', 'spawn-change-soul'); changeSoul.type = 'button';
  const closeButton = el('button', undefined, 'close-act fcancel-x'); closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Close spawn dialog');
  closeButton.append(iconElement(doc, 'close', { size: 14 }));
  header.append(mark, headCopy, changeSoul, closeButton);
  // ── chooser (picker layout)
  const { chooser, search, focusTarget } = composeChooser(doc, { soul, agents, canChoose, query: draft.query || '', note: catalogNote,
    choose: (candidate, query) => { if (!busy()) choose(candidate, { query, purpose: purpose.value, task: task.value, layout: 'picker' }); } });
  // ── preview (scoped layout): what the kernel will create, from the latest observation
  const preview = el('aside', undefined, 'spawn-preview'); preview.setAttribute('aria-label', 'Spawn preview');
  const factsSection = el('section', undefined, 'spawn-preview-section spawn-preview-created');
  const factsBody = el('div', undefined, 'spawn-preview-body');
  const factsHead = el('div', undefined, 'spawn-preview-head'), updatingMark = el('span', 'Updating…', 'spawn-preview-updating');
  updatingMark.hidden = true; factsHead.append(el('h3', 'What will be created', 'spawn-preview-title'), updatingMark);
  factsSection.append(factsHead, factsBody);
  // Core capabilities / Capabilities: filled only when the preview carries `modules`; otherwise empty and hidden.
  const coreSection = el('section', undefined, 'spawn-preview-section spawn-preview-core'), capsSection = el('section', undefined, 'spawn-preview-section spawn-preview-caps');
  coreSection.hidden = capsSection.hidden = true;
  const previewNote = el('p', 'Resolved by the installed CLI. Spawn refuses if this changes before you confirm.', 'spawn-preview-note');
  preview.append(factsSection, coreSection, capsSection, previewNote);
  // ── form
  const form = el('div', undefined, 'spawn-form');
  // Spec E: each section's jump chord (spawn-dialog-keys.mjs), a quiet hint beside its label, hidden from
  // assistive tech (the control carries aria-keyshortcuts instead); filled by setShortcuts().
  const keyHints = {};
  const keyHint = target => { const k = el('kbd', '', 'shortcut-hint spawn-key-hint'); k.setAttribute('aria-hidden', 'true'); k.hidden = true; keyHints[target] = k; return k; };
  const selectionSummary = el('span', `Selected soul ${soul.name}${soul.server ? ` on ${soul.server}` : ''}`, 'workspace-sr-only');
  selectionSummary.id = 'spawn-selection-summary'; dialog.setAttribute('aria-describedby', selectionSummary.id);
  // Name (optional, the last field): what is typed goes as --name exactly as typed, lowercased, with nothing
  // appended, where the CLI advertises spawn-name and,
  // for a spawn on another machine, so does that host (roleNamed); elsewhere (an older kernel on either
  // side, or a host whose features are unknown) it is a purpose, named <soul>-<typed>, with that prefix
  // shown. Empty: the kernel numbers it, or, where the CLI advertises spawn-suggest-name and the field was never typed in, names it from its task (the suggestion below).
  const nameField = el('div', undefined, 'spawn-field spawn-name');
  const nameLabel = el('label', 'Name '); nameLabel.htmlFor = 'spawn-purpose'; nameLabel.append(el('small', '· optional'), keyHint('name'));
  const nameInput = el('div', undefined, 'spawn-name-input');
  const prefix = el('span', `${soul.name}-`, 'spawn-name-prefix'); prefix.setAttribute('aria-hidden', 'true'); prefix.title = `${soul.name}-`;
  const purpose = el('input', undefined, 'field fpurpose'); purpose.id = 'spawn-purpose'; purpose.autocomplete = 'off'; purpose.spellcheck = false;
  purpose.placeholder = 'purpose, e.g. api-v2'; purpose.value = draft.purpose || '';
  purpose.setAttribute('aria-describedby', 'spawn-name-result');
  nameInput.append(prefix, purpose);
  const nameResult = el('p', '', 'spawn-hint spawn-name-result'); nameResult.id = 'spawn-name-result'; nameResult.setAttribute('aria-live', 'polite');
  nameField.append(nameLabel, nameInput, nameResult);
  // Harness · Model — the harness is a picker with its badge; the select holds the value.
  const runRow = el('div', undefined, 'spawn-row spawn-run');
  const runtimeLabel = el('label'), runtimeText = el('span', 'Harness', 'spawn-label-text'); runtimeText.append(keyHint('harness')); runtimeLabel.append(runtimeText);
  const runtime = el('select', undefined, 'field fruntime'); runtime.hidden = true; runtime.tabIndex = -1; runtime.setAttribute('aria-hidden', 'true');
  runtimeLabel.append(runtime);
  const modelLabel = el('label'), modelText_ = el('span', 'Model', 'spawn-label-text'); modelText_.append(keyHint('model')); modelLabel.append(modelText_);
  const modelControls = el('div', undefined, 'spawn-model-controls'), modelField = el('span', undefined, 'spawn-model-field');
  const model = el('input', undefined, 'field fmodel'); model.autocomplete = 'off'; model.spellcheck = false; model.setAttribute('aria-label', 'Model — empty uses the default');
  const modelTag = el('span', '', 'spawn-input-tag'); modelTag.setAttribute('aria-hidden', 'true');
  // The default shows as a value (not placeholder grey) until the operator types a model.
  const modelDefault = el('span', '', 'spawn-model-default'); modelDefault.setAttribute('aria-hidden', 'true');
  modelField.append(model, modelDefault, modelTag); modelControls.append(modelField); modelLabel.append(modelControls);
  runRow.append(runtimeLabel, modelLabel);
  const runHint = el('p', '', 'spawn-hint spawn-run-hint'); runHint.setAttribute('aria-live', 'polite');
  const runField = el('div', undefined, 'spawn-field'); runField.append(runRow, runHint);
  // Where to run: a primary decision, at the top level just above Relationship (whose picker lists that machine's instances).
  const placeRow = el('div', undefined, 'spawn-row'), serverLabel = el('label'); serverLabel.append(el('span', 'Where to run', 'spawn-label-text'));
  const server = el('select', undefined, 'field fserver'); server.setAttribute('aria-label', 'Where to run'); serverLabel.append(server); placeRow.append(serverLabel);
  const serverHint = el('p', '', 'spawn-hint spawn-server-hint');
  const placeField = el('div', undefined, 'spawn-field spawn-place'); placeField.append(placeRow, serverHint);
  // Work — read from the soul; a worktree gets the joined "from base | branch" control.
  const workField = el('div', undefined, 'spawn-field spawn-work');
  const workLabel = el('span', undefined, 'spawn-label'); workLabel.append(iconElement(doc, 'branch', { size: 13 }), doc.createTextNode('Work'));
  const workText_ = el('p', '', 'spawn-work-text'); workText_.setAttribute('aria-live', 'polite');
  const joined = el('div', undefined, 'spawn-joined');
  const from = el('span', 'from', 'spawn-joined-from');
  const base = el('input', undefined, 'field fbase'); base.autocomplete = 'off'; base.spellcheck = false; base.setAttribute('aria-label', 'Base the new branch starts from');
  from.append(base);
  const branch = el('input', undefined, 'field fbranch'); branch.autocomplete = 'off'; branch.spellcheck = false; branch.setAttribute('aria-label', 'New branch');
  joined.append(from, branch);
  const worktreePath = el('p', '', 'spawn-hint spawn-worktree-path');
  const worktreeLabel = el('label', undefined, 'spawn-switch spawn-use-worktree'), worktree = el('input', undefined, 'fworktree');
  worktree.type = 'checkbox'; worktree.setAttribute('role', 'switch');
  worktreeLabel.append(worktree, doc.createTextNode('Use a worktree instead'));
  worktreeLabel.hidden = soul.work !== 'checkout';
  workField.append(workLabel, workText_, joined, worktreePath, worktreeLabel);
  // Run in background (feature instance-background, #1579): the instance is listed under the sidebar's Background
  // heading. A switch (the worktree switch's idiom), set to the soul's default (`background: true` in its soul.yaml,
  // as the souls catalog reports it, then as a preview without the flag reports it); offered only where this CLI
  // lists the feature and, on another machine, its host does too (backgroundOffered). Sent only when it differs
  // from that default (backgroundChoice).
  const backgroundField = el('div', undefined, 'spawn-field spawn-background'); backgroundField.hidden = true;
  const backgroundLabel = el('label', undefined, 'spawn-switch'), backgroundSwitch = el('input', undefined, 'fbackground');
  backgroundSwitch.type = 'checkbox'; backgroundSwitch.setAttribute('role', 'switch');
  backgroundLabel.append(backgroundSwitch, doc.createTextNode('Run in background'));
  const backgroundHint = el('p', '', 'spawn-hint spawn-background-hint'); backgroundHint.id = 'spawn-background-hint';
  backgroundSwitch.setAttribute('aria-describedby', backgroundHint.id);
  backgroundField.append(backgroundLabel, backgroundHint);
  let backgroundDefault = soul.background === true, backgroundTouched = false;
  backgroundSwitch.checked = backgroundDefault;
  // Touched on the press itself: the form's own `input` listener repaints the dialog before `change` fires, and must find it touched.
  for (const type of ['input', 'change']) backgroundSwitch.addEventListener(type, () => { backgroundTouched = true; });
  // Relationship — shown by default.
  const relation = el('fieldset', undefined, 'spawn-field spawn-relationship');
  const relationLegend = el('legend', 'Relationship'); relationLegend.append(keyHint('relationship')); relation.append(relationLegend);
  const relRow = el('div', undefined, 'spawn-relationship-row'), seg = el('div', undefined, 'spawn-seg frelation'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'Relationship');
  for (const [value, label] of [['unrelated', 'Independent'], ['child', 'Child of'], ['sibling', 'Sibling of'], ['parent', 'Parent of']]) {
    const option = el('label'), input = el('input'); input.type = 'radio'; input.name = `spawn-relation-${Math.floor(workspaceGeneration())}`; input.value = value; input.checked = value === 'unrelated';
    option.append(input, el('span', label)); seg.append(option);
  }
  const rel = { get value() { return seg.querySelector('input:checked')?.value || 'unrelated'; } };
  roveSegment(seg, { selects: true });
  const relTo = el('select', undefined, 'field frelto'); relTo.setAttribute('aria-label', 'Which instance');
  relRow.append(seg, relTo);
  const relDesc = el('p', '', 'spawn-hint freldesc'); relDesc.setAttribute('aria-live', 'polite');
  relation.append(relRow, relDesc);
  // Opening instruction
  const taskLabel = el('label', undefined, 'spawn-field');
  const taskTitle = el('span', 'Opening instruction ', 'spawn-label'); taskTitle.append(el('small', '· optional'), keyHint('task')); taskLabel.append(taskTitle);
  const task = el('textarea', undefined, 'field ftask'); task.rows = 4; task.placeholder = 'What should this instance do? Empty starts it waiting for you.'; task.value = draft.task || '';
  taskLabel.append(task);
  // Developer settings (collapsed)
  const advanced = el('details', undefined, 'spawn-advanced');
  const advancedSummary = el('summary', 'Developer settings'), advancedTopics = el('small', 'Work area · permissions · launch · session · wake-up');
  advancedSummary.append(keyHint('advanced'), advancedTopics);
  advanced.append(advancedSummary);
  const advancedBody = el('div', undefined, 'spawn-advanced-body'); advanced.append(advancedBody);
  const permRow = el('div', undefined, 'spawn-row');
  const yoloLabel = el('label', 'Permissions'), yolo = el('select', undefined, 'field fyolo'); yoloLabel.append(yolo);
  const configLabel = el('label', 'Launch configuration'), config = el('select', undefined, 'field flaunch'); configLabel.append(config);
  permRow.append(yoloLabel, configLabel);
  // Messaging identity (decision 27): offered when the CLI takes provider
  // payloads and the preview reports the soul's messaging provider.
  const identityField = el('div', undefined, 'spawn-field spawn-identity'); identityField.hidden = true;
  const identityRow = el('div', undefined, 'spawn-row');
  const identityLabel = el('label', 'Messaging identity'), identity = el('select', undefined, 'field fidentity');
  for (const [value, label] of [['', 'Default'], ['local', 'Local — its own team identity'], ['global', 'Global — act as a resident']]) { const o = el('option', label); o.value = value; identity.append(o); }
  identityLabel.append(identity);
  const residentLabel = el('label', 'Resident'), resident = el('input', undefined, 'field fresident');
  resident.autocomplete = 'off'; resident.spellcheck = false; resident.placeholder = 'resident name, e.g. ops'; residentLabel.append(resident); residentLabel.hidden = true;
  identityRow.append(identityLabel, residentLabel);
  const identityHint = el('p', '', 'spawn-hint spawn-identity-hint'); identityHint.setAttribute('aria-live', 'polite');
  identityField.append(identityRow, identityHint);
  let messagingProvider = null; // the capability the latest preview reported on layer messaging
  // Teams: offered only when the provider declares the spawn setting `join`; the
  // list is the kernel's, never computed here. Team model v2 (0.30): the default
  // row (`default: true`) is fixed; every other mapped row is an unchecked box
  // (opt-in, sent as join=); a shared team with no provider id yet is shown, disabled.
  // 0.29 rows carry no `default`: a fixed "Default" chip, then the mapped rows.
  const teamsField = el('fieldset', undefined, 'spawn-field spawn-teams'); teamsField.hidden = true;
  const teamsList = el('div', undefined, 'spawn-seg spawn-teams-row spawn-team-list'); teamsList.setAttribute('role', 'group'); teamsList.setAttribute('aria-label', 'Teams');
  const teamsHint = el('p', '', 'spawn-hint spawn-teams-hint'); teamsHint.setAttribute('aria-live', 'polite');
  const teamsError = el('p', '', 'spawn-hint spawn-teams-error err'); teamsError.setAttribute('aria-live', 'polite');
  const teamsLegend = el('legend', 'Teams'); teamsLegend.append(keyHint('teams'));
  teamsField.append(teamsLegend, teamsList, teamsHint, teamsError);
  let teamsNow = null, joinDeclaredNow = false, teamsDrawn = '', defaultFromNow = null;
  const syncTeamsStop = roveSegment(teamsList);
  const joinPicked = new Set();
  // A team the operator may opt into: mapped, and not the soul's default (v2 rows say `default`).
  const joinable = t => t.mapped && t.default !== true;
  teamsList.addEventListener('change', event => {
    const box = event.target;
    if (box?.type !== 'checkbox' || !box.value || box.disabled) return;
    if (box.checked) joinPicked.add(box.value); else joinPicked.delete(box.value);
  }); // before the form's own change listener: the choice is current when it re-reads
  function drawTeams() {
    const key = JSON.stringify([teamsNow, defaultFromNow]);
    if (key === teamsDrawn) return;
    // A preview landing redraws the row: focus stays on the same team (its label is the stable key).
    const focusedTeam = teamsList.contains(doc.activeElement) ? doc.activeElement.closest('[data-team]')?.dataset.team ?? null : null;
    teamsDrawn = key; teamsList.replaceChildren();
    const chip = (cls, name, box, title) => { const c = el('label', undefined, cls); c.append(box, el('span', name, 'spawn-team-name')); c.title = title; teamsList.append(c); return c; };
    const rows = teamsNow || [], home = rows.find(t => t.default === true);
    const fixed = el('input'); fixed.type = 'checkbox'; fixed.checked = true; fixed.disabled = true;
    if (home) {
      const c = chip('spawn-team spawn-team-fixed', `${home.label} · default`, fixed, home.team
        ? `The default team (${home.team}): every instance of ${soul.name} is in it and can't leave it.`
        : `The default team ${home.label} has no provider id yet.`);
      c.dataset.team = home.label; if (!home.team) c.classList.add('spawn-team-blocked');
    } else chip('spawn-team spawn-team-fixed', 'Default', fixed, "The workspace's default team — always. Every instance is in it.");
    // Blocked: nothing to join into, so no opt-ins.
    for (const t of home && !home.team ? [] : rows.filter(t => t.default !== true && (t.mapped || t.default === false))) {
      const box = el('input'); box.type = 'checkbox'; box.value = t.label; box.className = 'fteam';
      box.checked = t.mapped && joinPicked.has(t.label); box.disabled = !t.mapped;
      const c = chip(`spawn-team${t.mapped ? '' : ' spawn-team-off'}`, t.label, box, t.mapped ? `Join ${t.label} (${t.team})` : `${t.label} has no provider id yet: its owner runs oats aweb setup, then commits the id.`);
      c.dataset.team = t.label;
    }
    syncTeamsStop(); applyKeys();
    if (focusedTeam !== null) [...teamsList.querySelectorAll('[data-team]')].find(c => c.dataset.team === focusedTeam)?.querySelector('input')?.focus({ preventScroll: true });
    const open = rows.filter(joinable).length;
    // An unmapped default blocks the spawn (the kernel refuses it): say so and what to do, not the opt-ins.
    teamsHint.classList.toggle('err', !!home && !home.team);
    teamsHint.textContent = home && !home.team
      ? `The default team ${home.label} has no provider id yet, so ${soul.name} can't be spawned here. Its owner runs oats aweb setup, then commits the id; or choose another default ${defaultFromNow === 'soul' ? `for ${soul.name} on its page (Teams here)` : 'in Workspace › Teams'}.`
      : home
      ? (open ? `It joins its default team, ${home.label}. Tick any other team it should also join.` : `It joins its default team, ${home.label}. No other team is open to ${soul.name} on this computer.`)
      : `By default it's only in the workspace's default team. These are the teams ${soul.name} has access to — tick the ones it should also join.`;
  }
  const hostRow = el('div', undefined, 'spawn-row');
  const backendLabel = el('label', 'Session backend'), backend = el('select', undefined, 'field fbackend'); backendLabel.append(backend);
  hostRow.append(backendLabel);
  const wake = wakeScheduleFields(doc);
  advancedBody.append(workField, permRow, identityField, hostRow, wake.el);
  // Footer
  const footer = el('div', undefined, 'spawn-footer');
  const statusRow = el('div', undefined, 'spawn-status');
  const status = el('p', '', 'fstatus'); status.setAttribute('role', 'status');
  const detailsToggle = el('button', 'Details', 'spawn-details-toggle'); detailsToggle.type = 'button'; detailsToggle.hidden = true;
  const details = el('p', '', 'spawn-problem-detail'); details.id = 'spawn-problem-detail'; details.hidden = true;
  detailsToggle.setAttribute('aria-controls', details.id); detailsToggle.setAttribute('aria-expanded', 'false');
  detailsToggle.addEventListener('click', () => {
    details.hidden = !details.hidden; detailsToggle.setAttribute('aria-expanded', String(!details.hidden));
    detailsToggle.textContent = details.hidden ? 'Details' : 'Hide details';
  });
  // Spec D: a spawn of this soul still in flight in this window (text, announced politely, with its row).
  const inflight = el('p', undefined, 'spawn-inflight'); inflight.setAttribute('role', 'status'); inflight.hidden = true;
  const inflightText = el('span', '', 'spawn-inflight-text');
  const inflightShow = el('button', 'Show its row', 'spawn-inflight-show'); inflightShow.type = 'button';
  inflightShow.addEventListener('click', () => { try { inFlightNow()?.show?.(); } catch { /* the row is gone: nothing to show */ } });
  inflight.append(inflightText, ' ', inflightShow);
  statusRow.append(inflight, status, detailsToggle);
  const cancel = el('button', 'Cancel', 'act fcancel'); cancel.type = 'button';
  const spawn = el('button', 'Spawn', 'act fspawn primary'); spawn.type = 'button';
  const actions = el('div', undefined, 'spawn-actions'); actions.append(cancel, spawn);
  // What a blocked launch differed in (0.52.0): a group of its own under the status, above Details; in the
  // footer only while there is one to show (setStatus).
  const statusDiffered = el('div', undefined, 'spawn-status-differed');
  footer.append(statusRow, actions, details);
  const body = el('div', undefined, 'spawn-form-body');
  // The Opening instruction first (the dialog lands there), Name last before Developer settings.
  body.append(selectionSummary, taskLabel, runField, placeField, relation, backgroundField, teamsField, nameField, advanced);
  form.append(body, footer); // the footer stays in view while the body scrolls
  const columns = el('div', undefined, 'spawn-columns'); columns.append(preview, chooser, form);
  // Below SPAWN_NARROW (one column), What will be created follows the form's last field in the form's own
  // scroll area, above the footer, which stays in view: the instruction is what shows on open, and the
  // preview is reached by scrolling on with the fields. Moved in the document, not only drawn there, so the
  // reading and tab order are the order on screen. Wide, it is the left column again.
  const narrowQuery = (() => { try { return doc.defaultView?.matchMedia?.(SPAWN_NARROW) ?? null; } catch { return null; } })();
  function placePreview() {
    if (narrowQuery?.matches) { if (body.lastElementChild !== preview) body.append(preview); }
    else if (columns.firstElementChild !== preview) columns.prepend(preview);
  }
  placePreview();
  narrowQuery?.addEventListener?.('change', placePreview);
  dialog.append(header, columns); modal.append(dialog);
  // ── #482 Deployment (renderer/spawn-deployment-field.mjs) ───────────────────────────────────────────
  // With two or more deployments in the view the field replaces "Where to run" and comes first, before
  // Harness: a remote deployment spawns through its server, a local one through the preview-bound
  // prepare/apply at ?ws=<its id>. Why Spawn is blocked there is said in the footer only; the preview
  // column's "Runs on" row names the chosen deployment.
  // The view's deployments as the dialog opened (a dialog belongs to one view; a newer list is the next dialog's).
  const deploymentsAtOpen = (() => { try { return spawnDeployments(deployments()); } catch { return []; } })();
  const deploymentField = createSpawnDeploymentField(doc, { ctx, soul, viewId: workspace()?.id, deployments: deploymentsAtOpen,
    preferred: draft.restore?.deployment ?? null, storage: (() => { try { return doc.defaultView?.localStorage ?? null; } catch { return null; } })(), rove: roveSegment,
    onChange: ({ moved, programmatic }) => {
      if (!current()) return;
      // The selector is the chosen deployment's catalog row, known once its catalog answered.
      const asked = deploymentField.selector(), rooted = asked.agentsRoot !== selector.agentsRoot;
      if (rooted) selector = asked;
      // Another deployment is another catalog, its own previews and its own instances: re-read from scratch.
      if (moved || rooted) { shown = settled = null; void fillConfigs(); void fillRelatives(); if (programmatic) dropPress(); }
      schedule(0);
      if (moved) taskEdited(); // a name is asked for the machine it names a spawn on
    } });
  if (deploymentField) { placeField.remove(); runField.before(deploymentField.element); }
  /** The deployment every spawn request addresses (the preview and prepare/apply echo it): the chosen one,
   * else the view's only one, else its primary; a view id only while none is known. */
  const address = () => deploymentField?.value() ?? (deploymentsAtOpen.length === 1 ? deploymentsAtOpen[0].id : null) ?? workspace()?.primary ?? workspace()?.id;
  /** Relation anchors: the chosen deployment's rows only (relations never cross deployments). */
  const deploymentRows = rows => deploymentField ? rows.filter(i => i?.deployment?.id === deploymentField.value()) : rows;
  // ── end #482 Deployment ─────────────────────────────────────────────────────────────────────────────
  let layoutNow = 'picker';
  /** Switch layout in place: the other column goes under [hidden]; every typed value stays. */
  function setLayout(name) {
    layoutNow = name === 'scoped' ? 'scoped' : 'picker';
    const scoped = layoutNow === 'scoped';
    dialog.dataset.layout = layoutNow;
    chooser.hidden = scoped; preview.hidden = !scoped; mark.hidden = !scoped; changeSoul.hidden = !scoped;
    title.textContent = scoped ? `Spawn ${soul.name}` : 'Spawn instance';
    context.textContent = scoped ? [soulOriginText(soul), `in ${workspaceName()}`].filter(Boolean).join(' · ') : `in ${workspaceName()}`;
    context.title = context.textContent;
    if (scoped) renderPreview();
  }

  // ── static options
  const c0 = cli();
  const runtimes = Array.isArray(c0?.harnesses) ? c0.harnesses.filter(v => Object.hasOwn(RUNTIME_NAMES, v)) : [];
  const fillSelect = (select, rows) => { select.replaceChildren(); for (const [value, label, disabled] of rows) { const o = el('option', label); o.value = value; o.disabled = !!disabled; select.append(o); } };
  fillSelect(runtime, [['', 'Default'], ...runtimes.map(v => [v, RUNTIME_NAMES[v]])]);
  const yoloSupported = Array.isArray(c0?.launchOptions) && c0.launchOptions.includes('yolo');
  fillSelect(yolo, [['', 'Default'], ['false', "Ask — harness's policy", !yoloSupported], ['true', 'Skip prompts (YOLO)', !yoloSupported]]);
  // tmux is the only session backend; an older kernel may still list herdr, which is never offered.
  const backends = Array.isArray(c0?.sessionBackends) ? c0.sessionBackends.filter(v => v === 'tmux') : [];
  fillSelect(backend, [['', 'Default'], ...backends.map(v => [v, v])]);
  fillSelect(config, [['', 'Default']]);
  fillSelect(server, [['', 'This computer']]);
  if (soul.server) { fillSelect(server, [[soul.server, soul.repoName || soul.server]]); server.value = soul.server; server.disabled = true; }
  // The relation picker lists the rows of the machine the instance will run on: relations never cross machines.
  // relativesPending: the chosen machine's rows are still being read; until they land no relation can be chosen.
  let relativeRows = [], relativesReq = 0, relativesPending = false;
  function paintRelatives(rows) {
    relativeRows = rows; const picked = [relTo.value, relTo.selectedOptions[0]?.dataset.root];
    const counts = new Map(); for (const i of rows) counts.set(i.instance, (counts.get(i.instance) || 0) + 1);
    const tags = distinguishingRootTags(rows.filter(i => counts.get(i.instance) > 1).map(i => i.agentsRoot));
    fillSelect(relTo, [['', '— which instance? —']]);
    for (const i of rows) {
      const o = el('option', `${i.instance}${counts.get(i.instance) > 1 && i.agentsRoot ? ` [${tags.get(String(i.agentsRoot)) || i.agentsRoot}]` : ''}${i.running === true ? '' : ' (stopped)'}`);
      o.value = i.instance; o.dataset.root = i.agentsRoot || ''; relTo.append(o);
    }
    const keep = [...relTo.options].find(o => o.value && o.value === picked[0] && o.dataset.root === picked[1]);
    if (keep) keep.selected = true;
  }
  paintRelatives(deploymentRows(instances() || []));

  // ── state
  // shown: the latest read's settled answer, data or failure ({ key, value, data|failure }); settled: the
  // latest settled DATA, which the preview column and the derived rows keep while a newer read is due or
  // in the air (never blanked after the first read). latest: the newest read in the air ({ ticket, key });
  // a newer schedule starts its own read without waiting for it, and only the latest ticket may settle.
  let alive = true, mount = workspaceGeneration(), serial = 0, timer = null, latest = null, shown = null, settled = null, nativeModel = false;
  let inFlight = 0, retryOnSettle = false, busyRetries = 0;
  // A Spawn press before the preview for these exact choices settled, kept as intent ({ key }).
  let pressed = null;
  // Spec C: this dialog's one handoff (single-flight: the store refuses a token it has seen).
  const handoffToken = {}; let handedOff = false;
  // The spawn transaction without a store (packages/client/spawn-transaction.mjs), this dialog's own: its job
  // (`spawnJob`) carries the submitted reference and its deadline (#802: the broker's CLI deadline + 30 s, from the press).
  const transaction = createSpawnTransaction({ request: (body, job) => postJson(ctx, `/api/spawn?ws=${encodeURIComponent(job.address)}`, body),
    now: () => Date.now(), pollMs: pollDelay });
  let spawnJob = null;
  let flight = null, phase = 'idle', intent = null, submitted = false, delivered = false, modelsReq = 0, configsReq = 0, remoteBusy = false, modelsFor = null;
  let notice = null; // a refusal from the last Spawn stays visible until the operator edits
  // A remote spawn's name refusal from its host ({ code, sent }), beside the field while the form still sends what was
  // refused (sent: remoteNamingKey() at the press), and until the next edit.
  let hostNameRefusal = null;
  // ── the suggested name (feature spawn-suggest-name, awebai/oats#1421 §3 "The Desktop's use of it")
  // namings: every answer of this dialog, by the exact task text and the soul (namingKey): { source: 'suggested', name }
  // or { source: 'numbered', reason, harness }. asking: the one call in the air ({ key, promise }); a newer one ends it
  // on the server (E_SUPERSEDED). suggestTimer: the debounce after a task edit, armed by an edit only. nameTouched: the name field
  // was typed in, for this dialog's lifetime (a draft brings it back): no suggestion is asked for or used.
  // suggestedNow: the suggestion the choices carry. pressNaming: this press's naming ended numbered, for that text (each
  // press the person makes starts without it: press()).
  const namings = new Map();
  let asking = null, suggestTimer = null, nameTouched = draft.nameTouched === true || !!String(draft.purpose || '').trim(), suggestedNow = null, pressNaming = null;
  const current = () => alive && owns() && mount === workspaceGeneration();
  const remoteTarget = () => deploymentField ? deploymentField.server() : soul.server || server.value || '';
  // Each server's registered group (where `spawn --server` goes), from the roster's facts, whichever way the
  // dialog targets that server: Where to run, the Deployment field or a soul listed from it. Its label for the hint.
  const serverGroups = new Map(), serverNames = new Map();
  const registeredGroup = (facts, id) => facts.find(f => f.server === id && f.registered === true);
  async function fillRelatives() {
    const target = soul.server || deploymentField ? '' : server.value, ticket = ++relativesReq, group = serverGroups.get(target);
    relativesPending = !!target; syncButton();
    let rows = deploymentRows(instances() || []);
    if (target) { try { rows = group ? await serverRows(group.group) : []; } catch { rows = []; } }
    if (ticket !== relativesReq || !current()) return;
    relativesPending = false;
    paintRelatives(Array.isArray(rows) ? rows : []); render(); syncButton();
  }
  function paintServerHint() {
    const target = remoteTarget();
    serverHint.textContent = target ? `Runs on ${serverNames.get(target) || soul.repoName || target}. Its teams and defaults come from that machine's workspace.`
      : machines?.reason || '';
  }
  // ── #517: a workspace's own machines (renderer/add-machine-dialog.mjs)
  let machines = null; // the filtered /api/servers answer, or null (gates off: today's list)
  /** One machine in Where to run: disabled with why from its roster group, as before. */
  function addServerOption(srv, facts = []) {
    const groups = facts.filter(f => f.server === srv.id), group = registeredGroup(facts, srv.id);
    const why = !groups.length ? null : !group ? 'not registered' : !group.reached ? 'not reached' : null;
    const label = srv.label || srv.id;
    const o = el('option', why ? `${label} (${why})` : label !== srv.id ? `${label} (${srv.id})` : label);
    o.value = srv.id; o.disabled = !!why;
    const add = [...server.options].find(option => option.value === ADD_MACHINE);
    if (add) add.before(o); else server.append(o);
    serverNames.set(srv.id, label);
  }
  function openAddMachine({ select }) {
    if (!current() || !machines?.deployment) return;
    addMachineDialog?.close({ restoreFocus: false });
    addMachineDialog = openAddMachineDialog(doc, { ctx, ws: workspace()?.id, deployment: machines.deployment, aweb: machines.aweb === true, owns: current,
      onClose: () => { addMachineDialog = null; },
      onAdded: id => {
        if (!current()) return;
        if (!select) { addedNote.textContent = `${id} is added. It is listed here once this computer has read it.`; addedButton.focus(); return; }
        if (![...server.options].some(o => o.value === id)) addServerOption({ id, label: id });
        server.value = id; server.focus();
        server.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
      } });
  }
  let addedButton = null, addedNote = null, addMachineDialog = null, stopBackfill = null;
  /** Two or more deployments: the Deployment field replaces Where to run, so Add a machine is a button under it. */
  function addMachineRow() {
    const row = el('div', undefined, 'spawn-field spawn-add-machine');
    addedButton = el('button', 'Add a machine to this workspace…', 'spawn-add-machine-button'); addedButton.type = 'button';
    addedNote = el('p', '', 'spawn-hint spawn-add-machine-note'); addedNote.setAttribute('aria-live', 'polite');
    addedButton.addEventListener('click', () => openAddMachine({ select: false }));
    row.append(addedButton, addedNote);
    return row;
  }
  let serverChosen = server.value;
  server.addEventListener('change', event => {
    if (server.value !== ADD_MACHINE) { serverChosen = server.value; return; }
    // The entry opens the dialog; Where to run keeps its choice until a machine is added.
    event.stopPropagation(); server.value = serverChosen;
    openAddMachine({ select: true });
  });
  const local = () => !remoteTarget() && (!!deploymentField || !workspace()?.remote && !workspace()?.server);
  /** A typed name goes as --name, as typed, where the CLI advertises spawn-name and, on another machine,
   * the host does too: its registered group's last roster read relayed a list that names it (answeringFeatures).
   * Unknown is a purpose: never decided from a refusal, never by probing. */
  const roleNamed = () => !!cli()?.features?.includes('spawn-name') && (local() || hostAdvertises('spawn-name'));
  /** The remote target's host advertises `feature`, as its registered group's last roster read relayed it. */
  function hostAdvertises(feature) {
    const group = serverGroups.get(remoteTarget());
    return !!answeringFeatures({ cli: cli(), routed: true, group: group && { probe: { ok: group.reached === true, features: group.features } } })?.includes(feature);
  }
  /** An empty, untouched name on another machine that this computer did not name: the host names it from its task, where
   * this CLI and the host both advertise spawn-apply-suggest-name (#1490 §3); else the host numbers it. */
  const hostNames = () => !local() && !nameTouched && roleNamed() && !!cli()?.features?.includes(APPLY_SUGGEST_FEATURE) && hostAdvertises(APPLY_SUGGEST_FEATURE);
  /** The deployment of this computer a suggest-name read is addressed to (its launch configurations name the harness):
   * the view's local one; null when the view has none here. */
  const suggestDeployment = () => deploymentField ? deploymentsAtOpen.find(d => d.local === true)?.id ?? null
    : !workspace()?.remote && !workspace()?.server ? address() ?? null : null;
  /** The instance name a typed value gives: the name as typed, or <soul>-<purpose>. --name is used exactly as
   * given (the kernel slugs a purpose, never a name), so a typed name is lowercased; PURPOSE admits only ASCII. */
  const finalName = (typed, named) => named ? typed.toLowerCase() : `${soul.name}-${typed}`;
  // The server admits the workspace against its own registry (absolute scope, local); /api/panel carries only the id.
  const previewable = () => local() && previewSupported(cli()) && !!address() && soul.work !== 'attached';
  const applicable = () => previewable() && spawnApplySupported(cli()) && !soul.captured;
  /** The dialog asks for a name, for a name field never typed in, where the name is passed on (roleNamed): a local,
   * previewable spawn whose CLI suggests names (the suggest read), or a spawn on another machine whose name this
   * computer's CLI chooses (instance-suggest-name, the suggest-name read: #1490 §2). */
  const suggesting = () => !nameTouched && roleNamed()
    && (local() ? previewable() && suggestSupported(cli()) : instanceSuggestSupported(cli()) && !!suggestDeployment());
  /** What an answer is kept by: the text, the soul and the machine it names a spawn on (namingKey). */
  const keyOf = text => namingKey(selector, text, remoteTarget() || null);
  /** The suggested name for exactly this task text, or null (a numbered answer is not a suggestion). */
  const suggestionFor = text => { const n = namings.get(keyOf(text)); return n?.source === 'suggested' ? n.name : null; };
  /** The suggestion that speaks for the form now: the field empty, and the text the one it was made for. */
  const suggestionNow = () => suggesting() && !purpose.value.trim() ? suggestionFor(task.value) : null;
  const busy = () => !!flight || remoteBusy || handedOff;
  const effectiveWork = () => worktree.checked && soul.work === 'checkout' ? 'worktree' : soul.work;
  const identityOffered = () => local() && !!messagingProvider && !!cli()?.features?.includes('spawn-provider-payload');
  // The row shows the teams the soul has access to: a joinable one, or (v2) its default; with neither, no row.
  // Gate (teams contract bdd7e55e): feature settings-declared, and the messaging row declares `join`.
  const teamsOffered = () => identityOffered() && !!cli()?.features?.includes('settings-declared') && joinDeclaredNow && Array.isArray(teamsNow) && teamsNow.some(t => joinable(t) || t.default === true);
  // What the operator ticked, in the kernel's order, joinable labels only (never the default).
  const joinLabels = () => teamsOffered() ? teamsNow.filter(t => joinable(t) && joinPicked.has(t.label)).map(t => t.label) : [];
  // The preview for these choices must bind exactly the ticked teams (settings echo).
  const joinBound = data => { const labels = joinLabels(); return !labels.length || data?.messaging?.join === labels.join(','); };
  /** Run in background is offered: this CLI lists instance-background and, on another machine, so does its host. */
  const backgroundOffered = () => !!cli()?.features?.includes('instance-background') && (local() || hostAdvertises('instance-background'));
  /** What the switch sends: here, its value only when it differs from the soul's default; on another machine, whose soul's
   * default is not reported here, its value once it was switched; else nothing (the soul decides). */
  const backgroundChoice = () => !backgroundOffered() ? undefined : local() ? backgroundSwitch.checked !== backgroundDefault ? backgroundSwitch.checked : undefined
    : backgroundTouched ? backgroundSwitch.checked : undefined;
  /** The preview for these choices decided what the switch shows (absent: an older kernel, which offers no switch). */
  const backgroundBound = data => !backgroundOffered() || data?.background === undefined || data.background === backgroundSwitch.checked;
  /** The preview for these choices can be spawned as the form shows it. */
  const bound = data => joinBound(data) && backgroundBound(data);
  // The chosen deployment's own catalog row (#482): the root differs per deployment.
  let selector = deploymentField?.selector() ?? { soul: soul.name, agentsRoot: soul.agentsRoot };
  /** The facts a preview depends on from outside the form: the CLI (identity and features), the
   * workspace and the relation anchor's roster rows. sync() re-reads only when one changed: the
   * roster polls every few seconds, and a routine poll must never supersede a read in flight
   * (a preview slower than the poll would otherwise never settle). */
  const factsKey = () => {
    const c = cli(), w = workspace(), anchor = rel.value === 'unrelated' ? null : relTo.value;
    return JSON.stringify([c?.ok ?? null, c?.bin ?? null, c?.version ?? null, c?.spawnPreviewApi ?? null, c?.spawnApplyApi ?? null, c?.features ?? null,
      w?.id ?? null, w?.remote ?? null, w?.server ?? null, address() ?? null,
      anchor === null ? null : (instances() || []).filter(i => i.instance === anchor).map(i => [i.instance, i.agent, i.agentsRoot, i.home ?? null, i.remote ?? null, i.server ?? null])]);
  };
  let factsSeen = factsKey();

  function relationChoice() {
    if (rel.value === 'unrelated') return { kind: 'unrelated' };
    if (relativesPending) return null;
    const name = relTo.value, root = relTo.selectedOptions[0]?.dataset.root, target = remoteTarget();
    const matches = relativeRows.filter(i => i.instance === name && i.agentsRoot === root && (target ? true : !i.remote && !i.server));
    if (matches.length !== 1) return null;
    const a = matches[0];
    return { kind: rel.value, anchor: { instance: a.instance, agent: a.agent, agentsRoot: a.agentsRoot, server: target || null } };
  }
  /** The choices the fields express, or { error } for one the operator must fix. With `suggested` (the default), an
   * empty name field carries the suggestion for this text as the name: the preview, prepare and apply all bind it. */
  function choices({ suggested = true } = {}) {
    const p = purpose.value.trim(), suggestion = suggested && !p ? suggestionNow() : null;
    if (p && !PURPOSE.test(p)) return { error: 'Use letters, digits and dashes in the name (start with a letter or digit).', field: 'name' };
    const named = roleNamed();
    // The final name is what the kernel caps (#159): the typed name itself, or <soul>-<purpose>.
    if (p && finalName(p, named).length > INSTANCE_NAME_MAX) {
      return { error: `Instance names are at most ${INSTANCE_NAME_MAX} characters. Shorten the name.`, field: 'name' };
    }
    const relationValue = relationChoice();
    if (!relationValue) return { error: `Pick the instance this one is a ${rel.value} of.`, field: 'relation' };
    const identityChoice = identityOffered() && identity.value ? identity.value === 'local' ? { provider: messagingProvider, mode: 'local' }
      : { provider: messagingProvider, mode: 'global', resident: resident.value.trim() } : null;
    if (identityChoice?.mode === 'global' && !identityChoice.resident) return { error: 'Type the resident this instance acts as.', field: 'identity' };
    const out = { ...(p ? named ? { name: finalName(p, true) } : { purpose: p } : suggestion ? { name: suggestion } : {}), ...(soul.work === 'checkout' && worktree.checked ? { work: 'worktree' } : {}),
      ...(effectiveWork() === 'worktree' && branch.value.trim() ? { branch: branch.value.trim() } : {}),
      ...(effectiveWork() === 'worktree' && base.value.trim() ? { base: base.value.trim() } : {}),
      ...(runtime.value ? { harness: runtime.value } : {}), ...(config.value ? { launchConfig: config.value } : {}),
      ...(backend.value ? { backend: backend.value } : {}), ...(yolo.value ? { yolo: yolo.value === 'true' } : {}),
      ...(backgroundChoice() !== undefined ? { background: backgroundChoice() } : {}),
      model: nativeModel ? { kind: 'native-default' } : model.value.trim() ? { kind: 'custom', value: model.value.trim() } : { kind: 'inherit' },
      // A remote spawn sends its relation to /api/spawn itself; the local preview contract never sees a remote anchor.
      relation: relationValue.anchor?.server ? { kind: 'unrelated' } : relationValue, ...(identityChoice ? { identity: identityChoice } : {}),
      ...(joinLabels().length ? { join: { provider: messagingProvider, labels: joinLabels() } } : {}) };
    const valid = previewChoices(out);
    return valid ? { value: valid } : { error: 'A value here is not a valid spawn option (no spaces or leading dashes).', field: 'option' };
  }
  // The deployment is part of what a preview answers (#482): an answer for another deployment never matches.
  const choiceKey = value => JSON.stringify([address() ?? null, value]);
  /** A read is scheduled, or the latest one is in the air: what is shown is not yet for these choices. */
  const readDue = () => !!timer || latest?.ticket === serial;
  /** Two choice values agree on these fields (absent = absent). */
  const sameOn = (a, b, fields) => !!a && !!b && fields.every(f => JSON.stringify(a[f] ?? null) === JSON.stringify(b[f] ?? null));
  /** The settled preview where it still speaks for the choices on screen on `fields` (what decides the
   * fact a hint reads), else null. A hint never describes a previous choice of its own fields
   * (desktop/loading-states item 9), and never blinks while an unrelated field is edited. */
  const settledFor = fields => settled && sameOn(settled.value, choices().value, fields) ? settled.data : null;
  // The default harness and model follow the harness, model and launch configuration chosen.
  const LAUNCH_CHOICES = ['harness', 'model', 'launchConfig'];
  const matched = () => settledFor(LAUNCH_CHOICES);
  /** The instance name for the choices on screen: the kernel's, from a settled preview for the same
   * name input; else the one the form spells (the kernel may still number a taken one); else null
   * (numbered by the kernel). Never a stale name while a read is due. */
  function nameNow() {
    // Named from its task, with no suggestion for this text yet: the kernel's numbered name is not what Spawn creates.
    if (!purpose.value.trim() && suggesting() && !suggestionNow()) return { name: null, kernel: false };
    const same = settledFor(['purpose', 'name']);
    if (same) return { name: same.instance, kernel: true };
    const typed = purpose.value.trim();
    return { name: typed ? finalName(typed, roleNamed()) : suggestionNow(), kernel: false };
  }

  // ── rendering from the latest observation
  function render() {
    if (!alive) return;
    // Derived rows read the last settled preview: they update when a read lands, never vanish while one reads.
    const data = settled?.data, draftChoice = choices();
    const typed = purpose.value.trim();
    // Name: what was typed, then the kernel's decision.
    const named = roleNamed();
    nameInput.classList.toggle('unprefixed', named);
    // The suggestion is the placeholder, only for the text it was made for: it never names what Spawn would not create.
    const suggestion = suggestionNow();
    purpose.placeholder = suggestion ? suggestion : named ? 'e.g. pricing-page-lead' : 'purpose, e.g. api-v2';
    // The kernel's name refusals belong next to the field, not only in the footer.
    const nameRefusal = !local() ? hostNameRefusal?.sent === remoteNamingKey() ? hostNameRefusal : null
      : shown?.failure && shown.key === choiceKey(draftChoice.value) && NAME_REFUSALS.includes(shown.failure.code) ? shown.failure : null;
    nameResult.classList.toggle('err', !!(draftChoice.error && draftChoice.field === 'name' || nameRefusal));
    if (draftChoice.error && draftChoice.field === 'name') nameResult.textContent = draftChoice.error;
    else if (nameRefusal) nameResult.textContent = spawnText(spawnProblem(nameRefusal));
    else if (!local() && !named) nameResult.textContent = `Named by ${remoteTarget()} when it spawns.`;
    else if (named && !typed && suggestion) { nameResult.replaceChildren('Instance name: '); nameResult.append(el('strong', nameNow().name), ' (from the task)'); }
    // Only what is true now: an empty name is named from its task where the kernel suggests names and the field was
    // never typed in, else numbered by the kernel (its number is the preview's "What will be created").
    // On another machine: named here, else named there from its task (hostNames), else numbered there.
    else if (named && !typed) nameResult.textContent = suggesting() ? 'Left empty, the instance is named from its task.'
      : local() ? 'Left empty, the kernel numbers it.' : hostNames() ? `Left empty, the instance is named from its task on ${remoteTarget()}.` : `Named by ${remoteTarget()} when it spawns.`;
    else {
      nameResult.replaceChildren();
      const { name, kernel } = nameNow();
      if (name) { nameResult.append('Instance name: '); nameResult.append(el('strong', name)); }
      else nameResult.append('Instance name: numbered by the kernel');
      // A purpose's taken name is numbered by the kernel; --name is refused instead (E_INSTANCE_NAME_TAKEN, beside the field).
      if (kernel && typed && !named && name !== `${soul.name}-${typed.toLowerCase()}`) nameResult.append(' — that name is taken, so the kernel numbered it');
    }
    // Runtime / model defaults: from the preview for these very choices only.
    const now = matched();
    const defaultRuntime = now && !runtime.value ? ` · ${runtimeName(now.harness)}` : '';
    runtime.options[0].textContent = `Default${defaultRuntime}`;
    const shownRuntime = runtimeName(runtime.value || now?.harness || '');
    const defaultModel = !now ? '' : nativeModel || now.model === null ? `${shownRuntime}'s default model` : now.model;
    model.placeholder = ' '; // :placeholder-shown drives the default overlay
    modelDefault.textContent = model.value ? '' : defaultModel;
    modelTag.textContent = model.value || !now ? '' : nativeModel || now.modelSource === 'explicit' ? 'chosen' : 'default';
    modelTag.title = now?.modelSource || '';
    model.setAttribute('aria-label', model.value ? 'Model' : `Model — empty uses ${defaultModel || 'the default'}`);
    syncRuntime(now);
    runHint.textContent = !local() ? `Harness and model defaults are decided on ${remoteTarget()}.` : launchHint(now, cli()) ?? (now ? `Launches ${runtimeName(now.harness)} with ${modelText(now)}.` : '');
    // Work.
    worktreeLabel.hidden = soul.work !== 'checkout';
    const worktreeMode = effectiveWork() === 'worktree' && local();
    const work = workText(settledFor(['work', 'branch', 'base']), effectiveWork());
    workText_.replaceChildren();
    if (!worktreeMode) { workText_.append(work.lead); if (work.code) workText_.append(el('code', work.code)); if (work.tail) workText_.append(work.tail); }
    joined.hidden = !worktreeMode;
    worktreePath.replaceChildren(); worktreePath.hidden = !worktreeMode || !data?.worktree;
    if (worktreeMode && data?.worktree) {
      // Shown relative to the deployment the kernel reported; the full path is the tooltip.
      const dir = data.subject?.dir, shownPath = dir && data.worktree.startsWith(`${dir}/`) ? data.worktree.slice(dir.length + 1) : data.worktree;
      worktreePath.append('Worktree at '); const code = el('code', shownPath); code.title = data.worktree; worktreePath.append(code);
    }
    // Run in background: a preview read without the flag reports the soul's default here (the catalog may be older).
    backgroundField.hidden = !backgroundOffered();
    if (local() && settled?.data && typeof settled.data.background === 'boolean' && settled.value?.background === undefined
      && settled.key === choiceKey(settled.value)) backgroundDefault = settled.data.background;
    if (!backgroundTouched && backgroundSwitch.checked !== backgroundDefault) backgroundSwitch.checked = backgroundDefault;
    backgroundHint.textContent = !local() && !backgroundTouched ? `Left as it is, its soul decides on ${remoteTarget()}.`
      : backgroundSwitch.checked ? 'Listed under Background in the sidebar.' : 'Listed in the main tree of the sidebar.';
    // Advanced defaults.
    yolo.options[0].textContent = data ? `Default · ${permissionText(data.yolo)}` : 'Default';
    backend.options[0].textContent = data ? `Default · ${data.backend}` : 'Default';
    // E_LAUNCH_CONFIG_AMBIGUOUS (0.52.0): while the answer for the choices on screen is that refusal, there is
    // no default to name. The entry stays the selected one (it is the state the dialog is in), and reads
    // Default again as soon as the answer for the choices on screen is anything else.
    const noDefault = shown?.failure?.code === 'E_LAUNCH_CONFIG_AMBIGUOUS' && shown.key === choiceKey(draftChoice.value);
    config.options[0].textContent = noDefault ? NO_DEFAULT_CONFIG : data?.launchConfig ? `Default · ${data.launchConfig}` : 'Default';
    branch.placeholder = data?.branch && !branch.value ? data.branch : `agents/${soul.name}-…`;
    base.placeholder = data?.base ? `${data.base.ref} · ${short(data.base.oid)}` : 'HEAD';
    // Messaging identity: what the kernel bound for this spawn, and the choice.
    if (data) { messagingProvider = data.messaging?.provider ?? null; teamsNow = data.teams ?? null; joinDeclaredNow = data.messaging?.joinDeclared === true; defaultFromNow = data.defaultTeam?.from ?? null; }
    // An unmapped default blocks the spawn even where joins are not offered (no provider declares
    // `join`): the row then shows the default and why, so a disabled Spawn never goes unexplained.
    teamsField.hidden = !teamsOffered() && !defaultBlocked();
    if (!teamsField.hidden) drawTeams();
    if (teamsOffered()) {
      teamsError.textContent = shown?.data && shown.key === choiceKey(draftChoice.value) && !joinBound(shown.data)
        ? "The kernel didn't bind the ticked teams. Spawn waits until it does." : '';
    }
    identityField.hidden = !identityOffered();
    residentLabel.hidden = identity.value !== 'global';
    advancedTopics.textContent = `Work area · permissions${identityOffered() ? ' · identity' : ''} · launch · session · wake-up`;
    if (identityOffered()) {
      const origins = !!cli()?.features?.includes('settings-origins');
      identity.options[0].textContent = identityDefaultLabel(data, identity.value, origins);
      identityHint.classList.toggle('err', draftChoice.field === 'identity');
      identityHint.textContent = draftChoice.field === 'identity' ? draftChoice.error : !data || !data.messaging ? '' : identityHintText(data.messaging, origins);
    }
    const related = rel.value !== 'unrelated';
    relTo.hidden = !related; relTo.disabled = !related; relTo.setAttribute('aria-label', related ? `${rel.value[0].toUpperCase()}${rel.value.slice(1)} of which instance?` : 'Which instance');
    relDesc.textContent = !related ? 'Independent — not linked to another instance.' : relTo.value ? `Spawns as a ${rel.value} of ${relTo.value}.` : `Pick the instance this one is a ${rel.value} of.`;
    if (layoutNow === 'scoped') renderPreview();
    syncButton();
  }
  /** What the preview column shows for the choices on screen: the kernel's data for exactly these
   * choices or its refusal; once anything settled, while a newer read is due or in the air, the last
   * settled facts (else the last refusal) marked `updating`; before the first settle, the loading
   * shape, or why there is none. */
  function previewState() {
    const draftChoice = choices(), key = choiceKey(draftChoice.value);
    if (deploymentField?.blocked()) return { kind: 'empty', text: '' }; // the footer says why, once
    if (!local()) return { kind: 'empty', text: `Decided on ${remoteTarget()} when it spawns.` };
    const said = answer => {
      if (answer.data) return { kind: 'data', data: answer.data, key: answer.key };
      // A name refusal is already said next to the Name field.
      if (NAME_REFUSALS.includes(answer.failure.code)) return { kind: 'empty', text: 'No preview until the name is accepted.' };
      return { kind: 'failure', text: spawnText(spawnProblem(answer.failure, 'preview'), 'preview') };
    };
    if (shown && shown.key === key && !readDue()) return said(shown);
    // A failure for the choices on screen stays while its retry reads; otherwise the last settled facts.
    // Marked updating only while a read is due or will be (an invalid form reads nothing).
    if (shown) return { ...said(shown.key === key ? shown : settled ?? shown), updating: readDue() || !draftChoice.error };
    if (readDue()) return { kind: 'reading' };
    if (draftChoice.error) return { kind: 'empty', text: 'The preview reads once the form is valid.' };
    if (!previewable()) return { kind: 'empty', text: soul.work === 'attached' ? 'Attached souls are started by the instance they attach to.' : 'The installed CLI can’t preview this spawn.' };
    return { kind: 'reading' };
  }
  let previewDrawn = '', modulesDrawn = '';
  function renderPreview() {
    const state = previewState(), data = state.data;
    // The Name fact is the form's own while a read is due (nameNow), so it is never a stale name.
    const name = state.kind === 'data' ? nameNow().name : null;
    const unnamed = suggesting() && !purpose.value.trim() ? 'named from its task' : undefined;
    // The whole (bounded) projection: a re-read for the same choices may answer different facts.
    // #482: the chosen deployment's row, first (as the field is), whatever the preview's state.
    const runsOn = deploymentField?.runsOn() ?? null;
    const signature = `${runsOn}:${state.kind === 'data' ? `data:${state.key}:${name}:${unnamed}:${JSON.stringify(data)}` : `${state.kind}:${state.text || ''}`}`;
    preview.setAttribute('aria-busy', String(state.kind === 'reading' || !!state.updating));
    updatingMark.hidden = !state.updating;
    if (signature === previewDrawn) return;
    previewDrawn = signature; factsBody.replaceChildren();
    const facts = el('dl', undefined, 'spawn-preview-facts');
    const fact = (label, ...value) => { const dd = el('dd'); dd.append(...value); facts.append(el('dt', label), dd); };
    // #482: the chosen deployment's row is the facts' last; alone (before the state's words) until data lands.
    const runsOnFact = () => { if (runsOn) fact('Runs on', runsOn); };
    if (state.kind !== 'data' && runsOn) { runsOnFact(); factsBody.append(facts); }
    if (state.kind === 'reading') {
      const skeleton = el('div', undefined, 'spawn-preview-skeleton'); skeleton.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 4; i++) skeleton.append(el('span'), el('span'));
      factsBody.append(skeleton, el('p', 'Reading the preview…', 'workspace-sr-only spawn-preview-reading'));
    } else if (state.kind === 'failure') factsBody.append(el('p', state.text, 'spawn-preview-failure'));
    else if (state.kind === 'empty') { if (state.text) factsBody.append(el('p', state.text, 'spawn-preview-empty')); }
    else {
      // The facts are previewFacts' (packages/client/spawn-preview-facts.mjs); the drawing is the dialog's.
      const shownFacts = previewFacts(data, { name, runsOn, cli: cli(), unnamed });
      // A part: plain text, a branch in mono, muted, or a value's second line (where it came from, what else).
      const part = p => p.sub ? el('span', p.text, 'muted spawn-fact-sub') : p.muted ? el('span', p.text, 'muted') : p.mono ? el('span', p.text, 'mono') : doc.createTextNode(p.text);
      // The instance first and largest, its home beneath: the terms are for assistive tech, the eye reads the shape.
      const identity = el('dl', undefined, 'spawn-preview-identity');
      for (const entry of shownFacts.identity) {
        const dd = el('dd', entry.text, `${entry.label === 'Home' ? 'spawn-preview-home' : 'spawn-preview-name'}${entry.muted ? ' muted' : ''}`);
        if (entry.title) dd.title = entry.title;
        identity.append(el('dt', entry.label, 'workspace-sr-only'), dd);
      }
      for (const { label, parts, harness: id } of shownFacts.facts) {
        if (id) {
          const harness = el('span', undefined, 'spawn-preview-harness');
          // The badge is decorative here: the term says Harness and the text names it.
          const badge = createRuntimeBadge(doc, id); badge.setAttribute('aria-hidden', 'true');
          harness.append(badge, el('span', parts[0].text));
          fact(label, harness, ...parts.slice(1).map(part));
        } else fact(label, ...parts.map(part));
      }
      factsBody.append(identity, facts);
      if (shownFacts.prompts) {
        // The launch-prompt policy is a note, not a fact: its words stay the kernel contract's, verbatim.
        const note = el('dl', undefined, 'spawn-preview-prompts');
        for (const entry of shownFacts.prompts) note.append(el('dt', entry.label), entry.mono ? el('dd', entry.text, 'mono') : el('dd', entry.text));
        factsBody.append(note);
      }
      // Capability warnings (0.49.0): the kernel's strings, each line as text (no Details, no Open capability); they block nothing.
      const warnings = createWarningsList(doc, shownFacts.warnings.map(lines => lines.join('\n')), { lines: true });
      if (warnings) { const box = el('div', undefined, 'spawn-preview-warnings'); box.append(el('h4', WARNINGS_COPY.title, 'spawn-preview-title'), warnings); factsBody.append(box); }
    }
    // Core capabilities and Capabilities exist only when the preview carries `modules`; redrawn only when those change.
    const modules = state.kind === 'data' ? JSON.stringify(data.modules ?? null) : '';
    if (modules === modulesDrawn) return;
    modulesDrawn = modules;
    const sections = state.kind === 'data' ? composePreviewModules(doc, data.modules) : null;
    coreSection.hidden = capsSection.hidden = !sections;
    coreSection.replaceChildren(...(sections?.core ?? [])); capsSection.replaceChildren(...(sections?.caps ?? []));
  }
  /** The default team has no provider id yet: the spawn is refused (team model v2, the lead's ruling). */
  const defaultBlocked = () => (teamsNow || []).some(t => t.default === true && !t.team);
  const inFlightNow = () => { if (!local() || typeof spawnInFlight !== 'function') return null; try { return spawnInFlight() || null; } catch { return null; } };
  function syncInFlightLine(job) {
    const text = job ? `A spawn of ${soul.name} is in progress.` : '';
    if (inflightText.textContent !== text) inflightText.textContent = text; // an unchanged line is not re-announced
    inflight.hidden = !job;
    if (job) inflightShow.setAttribute('aria-label', `Show the pending row of ${job.instance}`);
  }
  function syncButton() {
    if (!alive) return;
    const blocking = inFlightNow();
    syncInFlightLine(blocking);
    // Spawn is pressable whenever the form is valid: a press before the preview for these choices
    // settled is kept as intent (run). Only a settled answer for exactly these choices that cannot be
    // spawned (a refusal, or teams it did not bind) keeps it disabled.
    const draftChoice = choices(), known = local() && !!shown && shown.key === choiceKey(draftChoice.value) && !readDue();
    const refused = known && (!shown.data || !bound(shown.data));
    spawn.textContent = flight || pressed ? (phase === 'checking' ? 'Checking…' : 'Spawning…')
      : ['unknown', 'pending'].includes(phase) ? 'Check result' : ['complete', 'partial'].includes(phase) ? 'Created' : phase === 'incomplete' ? 'Spawn incomplete' : 'Spawn';
    spawn.setAttribute('aria-busy', String(!!(flight || pressed)));
    const recovering = ['unknown', 'pending'].includes(phase);
    spawn.disabled = !current() || busy() || !!pressed || !!blocking || ['complete', 'partial', 'incomplete'].includes(phase)
      || !recovering && (!!draftChoice.error || defaultBlocked() || !!deploymentField?.blocked() || (local() ? !applicable() || refused : false));
  }
  /** A problem shows one plain sentence; its code and technical text wait behind Details. `differed`: what a
   * blocked launch differed in, shown under the sentence for as long as that sentence is the status.
   * Details hold the problem's `detail`, then, for a problem with the kernel's own texts (`kernel`: its
   * message and fix), each of them as a line under the kernel's name (packages/client/kernel-lines.mjs). */
  let differedDrawn = '', detailDrawn = '';
  function setStatus(text, error = false, problem = null, ok = false, differed = null) {
    const differedKey = differed ? JSON.stringify(differed) : '';
    if (differedKey !== differedDrawn) {
      differedDrawn = differedKey;
      const group = differed ? launchDiffered(doc, differed) : null;
      if (group) { statusDiffered.replaceChildren(group); footer.insertBefore(statusDiffered, details); } else statusDiffered.remove();
    }
    if (status.textContent !== text) status.textContent = text; // an unchanged status is not re-announced
    status.classList.toggle('err', error); status.classList.toggle('ok', ok && !error);
    status.dataset.code = problem?.code || '';
    // Details stay as the person left them while nothing in them changed: the detail and each line count.
    const lines = problem?.kernel ? kernelLines(problem.kernel.message, problem.kernel.fix, DESKTOP_TERMS) : [];
    const detailKey = JSON.stringify([problem?.detail || '', lines]);
    if (detailKey !== detailDrawn) {
      detailDrawn = detailKey;
      details.textContent = problem?.detail || ''; details.hidden = true;
      for (const line of lines) details.append(el('span', line, 'spawn-problem-line'));
      detailsToggle.setAttribute('aria-expanded', 'false'); detailsToggle.textContent = 'Details';
    }
    detailsToggle.hidden = !problem;
  }
  // The problem as the dialog said it: the shared answer with the Desktop's sentence (spawn-words.mjs) as `text`.
  const showProblem = (reason, stage) => { const problem = spawnProblem(reason, stage), text = spawnText(problem, stage); setStatus(text, true, problem); return { ...problem, text }; };

  // ── background preview (latest intent wins)
  function schedule(delay = debounce) {
    if (!alive) return;
    clearTimeout(timer);
    if (submitted && !['complete', 'partial', 'incomplete'].includes(phase)) return; // the submitted intent owns the form until settled
    serial++;
    timer = setTimeout(() => { timer = null; void read(); }, delay); // before render(): the preview column shows a read is due
    render();
  }
  async function read() {
    if (!current()) return;
    // #482: the deployments' catalogs are still read (the default may move): the read follows when they land.
    if (deploymentField?.pending()) return;
    // The chosen deployment does not offer this soul: nothing to read, and Spawn says why.
    if (deploymentField?.blocked()) { endPress(); shown = settled = null; setStatus(`${deploymentField.blockText()}.`, true); render(); return; }
    // A read that cannot answer the pressed choices ends the press: it never spawns later on its own.
    if (!local()) { endPress(); shown = settled = hostNameRefusal = null; setStatus(''); render(); return; }
    if (!previewable()) {
      endPress(); shown = settled = null;
      if (soul.work === 'attached') setStatus('Attached souls are started by the instance they attach to.', true);
      else showProblem(previewFailure('E_PREVIEW_UNAVAILABLE').reason, 'preview');
      render(); return;
    }
    const draftChoice = choices();
    // Nothing to read until the form is valid; what settled stays on screen (the field says what to fix).
    if (draftChoice.error) { endPress(); setStatus(''); render(); return; }
    // Never queued behind a superseded read: that one's answer is discarded when it lands.
    const ticket = serial, value = draftChoice.value, key = choiceKey(value), ws = address(), owner = mount, asked = selector;
    latest = { ticket, key }; inFlight++; retryOnSettle = false; factsSeen = factsKey(); // the facts this read is based on
    // Only the first read says so in the footer; afterwards the column's "Updating…" is the signal. A
    // preview failure no longer describes these choices (a Spawn refusal, the notice, stays until an edit).
    if (!shown) setStatus('Reading defaults…');
    else if (status.classList.contains('err') && !notice && shown.key !== key) setStatus('');
    syncButton();
    let next = null;
    try {
      const response = await postJson(ctx, `/api/workspace-spawn-preview?ws=${encodeURIComponent(ws)}`, { action: 'preview', selector: asked, choices: value });
      if (!alive) return;
      if (response?.spawnPreviewViewApi !== 1) next = { key, value, failure: previewFailure('E_CLI_PROTOCOL').reason };
      else if (response.status !== 'available') next = { key, value, failure: reasonOf(response.reason) };
      else {
        const target = previewTarget(response.target), data = target && previewData(response.data, target);
        next = data && target.workspace === ws && target.selector.soul === asked.soul && target.selector.agentsRoot === asked.agentsRoot
          ? { key, value, data } : { key, value, failure: previewFailure('E_CLI_PROTOCOL').reason };
      }
    } catch (error) { next = { key, value, failure: previewFailure(error?.code === 'E_FORBIDDEN_FRAME' ? 'E_FORBIDDEN_FRAME' : 'E_CLI_FAILED').reason }; }
    finally { inFlight--; if (latest?.ticket === ticket) latest = null; }
    // Every completion, success or failure, is checked for ownership: a closed dialog, another
    // workspace or mount, or a newer ticket discards it (stale errors would corrupt newer state too).
    if (!current() || owner !== mount) return;
    if (ticket !== serial) {
      // Superseded. It freed a server slot a busy latest read is waiting for: read the latest now.
      if (retryOnSettle) { retryOnSettle = false; schedule(0); } else render(); // the column may no longer be waiting for any read
      return;
    }
    if (next.failure?.code === 'E_TARGET_CHANGED') { schedule(0); return; }
    // The server's two-read budget is full (superseded reads still running): an internal retry, as soon
    // as one of this dialog's reads lands, else shortly. Never a failure while a newer read is pending.
    if (next.failure?.code === 'E_BUSY' && busyRetries < BUSY_RETRIES) {
      busyRetries++; retryOnSettle = inFlight > 0; schedule(busyDelay); return;
    }
    busyRetries = 0;
    // The suggested name was taken since it was suggested: it is forgotten, and a press waiting on it names again
    // (one more call: the kernel then gives the next free name). Without a press, the form reads without it.
    if (next.failure?.code === 'E_INSTANCE_NAME_TAKEN' && value.name && !purpose.value.trim() && value.name === suggestionFor(task.value)) {
      namings.delete(keyOf(task.value)); suggestedNow = suggestionNow();
      const press = pressed?.naming ? null : pressed;
      if (press) { pressed = null; phase = 'idle'; void run(); } else schedule(0);
      return;
    }
    shown = next; if (next.data) settled = next;
    // A press kept as intent continues only on the preview for exactly the choices pressed. A press that is naming
    // (nameThenRun) is not a preview's to settle: it continues when its name lands.
    const press = pressed?.naming ? null : pressed;
    if (press) { pressed = null; phase = 'idle'; }
    if (press && next.data && press.key === key && bound(next.data)) { render(); void run(); return; }
    if (next.data) {
      if (phase === 'drifted') setStatus(outcomeText('drifted', null, '', 'dialog'));
      else if (notice) setStatus(notice.text, true, notice);
      else if (press && press.key !== key) setStatus('Changed: press Spawn again');
      else setStatus('Preview ready', false, null, true);
    }
    else if (NAME_REFUSALS.includes(next.failure.code)) setStatus(''); // said next to the name itself
    else showProblem(next.failure, 'preview');
    if (phase === 'drifted' && next.data) phase = 'idle';
    render();
    // Suggestions follow the harness the kernel resolved, once it is known.
    if (next.data && !runtime.value && modelsFor !== next.data.harness) void fillModels();
  }
  // ── the suggested name: asked shortly after the task text is edited, never on a timer of its own
  /** The choices now carry another suggestion (one arrived, or the text moved away from it): the preview reads again. */
  function followSuggestion() {
    const now = suggestionNow();
    if (now === suggestedNow) { render(); return; }
    suggestedNow = now; schedule(debounce);
  }
  /** The task text changed: the suggestion follows it, and after a short debounce (suggestDelay, SUGGEST_DEBOUNCE_MS: only
   * so typing makes no read per keystroke) the dialog asks for a name for it, once it holds SUGGEST_MIN_WORDS words and the
   * dialog has no answer for it yet. A newer text supersedes the older read on the server. */
  function taskEdited() {
    clearTimeout(suggestTimer); suggestTimer = null;
    followSuggestion();
    const text = task.value;
    if (!suggesting() || purpose.value.trim() || taskWords(text) < SUGGEST_MIN_WORDS || namings.has(keyOf(text))) return;
    suggestTimer = setTimeout(() => { suggestTimer = null; if (current() && task.value === text) void ask(text); }, suggestDelay);
  }
  /** Ask the kernel to name the instance for `text` (a suggest read: the full preview, and `naming`). An answer the dialog
   * has is reused; with `fresh` (Spawn) only a suggested one is. A call in the air for the same text is joined; one
   * for another text is ended by this one, on the server (it answers E_SUPERSEDED, read here as null). Answers
   * { source, ... } (kept), { failure } (not kept) or null (superseded, or the dialog moved on). */
  async function ask(text, { fresh = false } = {}) {
    const key = keyOf(text), had = namings.get(key);
    if (had && (!fresh || had.source === 'suggested')) return had;
    if (asking?.key === key) return asking.promise;
    const draftChoice = choices({ suggested: false });
    if (draftChoice.error || !suggesting()) return null;
    const ws = address(), asked = { ...selector }, owner = mount;
    const promise = !local() ? askHere(text) : (async () => {
      try {
        const response = await postJson(ctx, `/api/workspace-spawn-preview?ws=${encodeURIComponent(ws)}`, { action: 'suggest', selector: asked, choices: draftChoice.value, task: text });
        if (response?.spawnPreviewViewApi !== 1) return { failure: previewFailure('E_CLI_PROTOCOL').reason };
        if (response.status !== 'available') return response.reason?.code === 'E_SUPERSEDED' ? null : { failure: reasonOf(response.reason) };
        const target = previewTarget(response.target), data = target && previewData(response.data, target);
        if (!data?.naming || target.workspace !== ws || target.selector.soul !== asked.soul || target.selector.agentsRoot !== asked.agentsRoot) return { failure: previewFailure('E_CLI_PROTOCOL').reason };
        return data.naming.source === 'suggested' ? { source: 'suggested', name: data.instance } : { source: 'numbered', reason: data.naming.reason, harness: data.harness };
      } catch (error) { return { failure: previewFailure(error?.code === 'E_FORBIDDEN_FRAME' ? 'E_FORBIDDEN_FRAME' : 'E_CLI_FAILED').reason }; }
    })();
    asking = { key, promise };
    const answer = await promise;
    if (asking?.promise === promise) asking = null;
    if (!current() || owner !== mount) return null;
    if (answer?.source) { namings.set(key, answer); followSuggestion(); }
    return answer;
  }
  /** The suggest-name read (#1490 §2): this computer's harness names a spawn on another machine, from `text`. Its harness
   * is the dialog's Harness choice, else the soul's default as its host reports it, else the kernel's default; its model
   * goes only with pi. No launch configuration: the dialog's are the host's, and this machine's default for the harness
   * is what runs. Answers as ask() does. */
  async function askHere(text) {
    const ws = suggestDeployment(), harness = runtime.value || remoteSoulHarness();
    const choice = SUGGEST_HARNESSES.includes(harness) ? harness : undefined, chosenModel = !nativeModel && model.value.trim();
    const request = { action: 'suggest-name', soul: soul.name, task: text, ...(choice ? { harness: choice } : {}), ...(choice === 'pi' && chosenModel ? { model: chosenModel } : {}) };
    try {
      const response = await postJson(ctx, `/api/workspace-spawn-preview?ws=${encodeURIComponent(ws)}`, request);
      if (response?.spawnPreviewViewApi !== 1) return { failure: previewFailure('E_CLI_PROTOCOL').reason };
      if (response.status !== 'available') return response.reason?.code === 'E_SUPERSEDED' ? null : { failure: reasonOf(response.reason) };
      const data = instanceSuggestion(response.data);
      if (!data || response.workspace !== ws) return { failure: previewFailure('E_CLI_PROTOCOL').reason };
      return data.naming.source === 'suggested' ? { source: 'suggested', name: data.name } : { source: 'numbered', reason: data.naming.reason, harness: choice ?? 'claude' };
    } catch (error) { return { failure: previewFailure(error?.code === 'E_FORBIDDEN_FRAME' ? 'E_FORBIDDEN_FRAME' : 'E_CLI_FAILED').reason }; }
  }
  /** The soul's default harness where it will run, as that machine reports it: the chosen deployment's catalog row when
   * the Deployment field chooses (another deployment is another catalog), else a soul listed from a server; null when
   * this computer does not know it. */
  const remoteSoulHarness = () => (deploymentField ? deploymentField.harness() : soul.server ? soul.harness : null) || null;
  /** Spawn with an empty, untouched name and no suggestion for this text: name it first ("Naming…"), whatever the
   * text's length, then spawn. An empty task makes no call: it is numbered, and the dialog says why. A suggestion
   * spawns under its name (the choices carry it); a numbered answer spawns the numbered name and says why. An edit
   * meanwhile ends the press (dropPress), as it ends a press waiting for its preview. */
  async function nameThenRun() {
    const text = task.value, owner = mount;
    if (!text.trim()) { pressNaming = { text, reason: 'no-task', harness: null }; return run(); }
    const press = { naming: true }; pressed = press; phase = 'checking'; setStatus('Naming…'); syncButton();
    const answer = await ask(text, { fresh: true });
    if (!current() || owner !== mount || pressed !== press) return;
    pressed = null; phase = 'idle';
    if (!answer) { setStatus('Changed: press Spawn again'); syncButton(); return; }
    // A spawn on another machine never fails over naming: unnamed here, the host names or numbers it (runRemote).
    if (answer.failure && !local()) { pressNaming = { text, reason: null, harness: null }; return run(); }
    if (answer.failure) { showProblem(answer.failure, 'preview'); syncButton(); return; }
    if (answer.source === 'numbered') pressNaming = { text, reason: answer.reason, harness: answer.harness };
    return run();
  }
  /** A Spawn the person pressed (the button, or the submit key): a press of its own, so a numbered naming outcome of an
   * earlier press (pressNaming), ended by an edit or a refusal, is never reused: this press names again. */
  function press() { pressNaming = null; return run(); }
  /** Spawn pressed before the preview for these exact choices settled: keep the press as intent until
   * the read for them lands (read continues it, or shows its failure). The button says Checking…. */
  function holdPress() {
    pressed = { key: choiceKey(choices().value) }; phase = 'checking';
    setStatus('Spawning…'); syncButton();
    if (!readDue()) schedule(0);
  }
  /** No answer can come for the pressed choices (the form or the CLI changed under it): the press ends. */
  function endPress() { if (pressed) { pressed = null; phase = 'idle'; } }
  /** An edit while a press waits: the intent belonged to the choices at press time. */
  function dropPress() {
    if (!pressed) return;
    pressed = null; phase = 'idle'; setStatus('Changed: press Spawn again'); syncButton();
  }
  // A launch refusal (0.30) may carry the kernel's `fix`, flat on the reason: kept, bounded text.
  const fixOf = reason => typeof reason?.fix === 'string' && reason.fix.length && reason.fix.length <= 1024 && !/[\x00-\x1f\x7f]/.test(reason.fix) ? { fix: reason.fix } : {};
  const reasonOf = reason => typeof reason?.code === 'string' && typeof reason?.message === 'string' && reason.message.length <= 2048
    ? { code: reason.code, message: reason.message, ...fixOf(reason) } : previewFailure(reason?.code).reason;

  // ── spawn (local): prepare → same decision as shown → apply
  async function run() {
    syncButton();
    if (!current() || busy() || spawn.disabled) return;
    const recovering = local() && ['unknown', 'pending'].includes(phase) && intent;
    // Named from its task (feature spawn-suggest-name; on another machine, instance-suggest-name): an empty, untouched
    // name with no suggestion for this text asks first, unless this press already ended unnamed for exactly this text.
    if (!recovering && suggesting() && !purpose.value.trim() && !suggestionNow() && pressNaming?.text !== task.value) { void nameThenRun(); return; }
    if (!local()) return runRemote();
    // The decision a spawn binds is the kernel's for exactly these choices: until that preview settled,
    // the press waits for it (and prepare checks the prepared decision against it, as always).
    if (!recovering && !(shown?.data && shown.key === choiceKey(choices().value) && !readDue())) { holdPress(); return; }
    let prepareInput = null;
    if (!recovering) {
      const draftChoice = choices();
      let wakeValue;
      try { wakeValue = wake.read(); } catch (error) { setStatus(error.message, true); return; }
      prepareInput = spawnPrepareInput({ action: 'prepare', selector, choices: draftChoice.value, task: task.value, ...(wakeValue ? { wake: wakeValue } : {}) });
      if (draftChoice.error || !prepareInput) { showProblem(spawnApplyReason('E_BAD_ARGS'), 'spawn'); return; }
      // Spec C: the confirmed press leaves the dialog. The store runs the transaction against exactly the
      // decision on screen; the dialog is single-flight: one press, one handoff (handedOff), never two.
      if (handoff) {
        if (handedOff) return;
        // A suggested name is the task's, not typed: Reopen brings it back as the suggestion for that text, never into the field.
        const suggested = !purpose.value.trim() && draftChoice.value.name !== undefined ? draftChoice.value.name : null;
        const restoreChoices = structuredClone(draftChoice.value); if (suggested) delete restoreChoices.name;
        const draftNow = { purpose: purpose.value, task: task.value, layout: 'scoped', nameTouched,
          restore: { choices: restoreChoices, ...(suggested ? { naming: { task: task.value, name: suggested } } : {}),
            ...(wakeValue ? { wake: structuredClone(wakeValue) } : {}), ...(deploymentField ? { deployment: address() } : {}) } };
        // Numbered where the dialog would have named it from its task: the spawn says why when it completes.
        const named = !suggested && pressNaming?.text === task.value && !purpose.value.trim() && suggesting()
          ? numberedLine(shown.data.instance, pressNaming.reason, pressNaming.harness) : null;
        handedOff = true; syncButton();
        let taken = false;
        // Owned by the view on screen, addressed to the chosen deployment (#482).
        try { taken = handoff({ token: handoffToken, workspace: workspace().id, deployment: address(), selector: { ...selector }, input: prepareInput, decision: structuredClone(shown.data.decision), relation: draftChoice.value.relation, draft: draftNow, ...(named ? { named } : {}) }) === true; }
        catch { taken = false; }
        if (!taken && alive) { handedOff = false; showProblem(spawnApplyReason('E_BUSY'), 'spawn'); syncButton(); }
        return;
      }
    }
    const ws = address(), token = {}, connection = ctx.connectionGeneration?.() ?? 0, owner = mount;
    const valid = () => current() && owner === mount && flight === token && connection === (ctx.connectionGeneration?.() ?? 0);
    flight = token; phase = recovering ? 'checking' : 'preparing'; setStatus(recovering ? 'Checking the submitted spawn…' : 'Spawning…'); syncButton();
    // The shared transaction: prepare, apply only the decision on screen at the press, follow a pending apply
    // (#802), and Check result on the same intent (an unknown result re-applies the SAME reference only).
    const call = { alive: valid, progress: (event, job) => {
      if (event === 'submitted') { intent = job.prepared; spawnJob = job; submitted = true; phase = 'submitting'; }
      else if (event === 'pending') { phase = 'pending'; setStatus('Spawning…'); syncButton(); }
    } };
    try {
      const outcome = recovering
        ? await transaction.check(spawnJob, call)
        : await transaction.submit({ address: ws, selector, input: prepareInput, decision: structuredClone(shown.data.decision) }, call);
      if (!outcome) return;
      const { kind, view, reason } = outcome;
      if (kind === 'refused' && !outcome.job.submitted) {
        // Refused before anything was submitted: the prepare's own refusal, or the request failed.
        phase = 'idle';
        if (view) { notice = showProblem(reason, 'spawn'); schedule(0); } else showProblem(reason, 'spawn');
        return;
      }
      if (kind === 'drifted' && !reason) {
        // The confirmation is re-read by the server; only what is on screen is applied.
        phase = 'drifted'; shown = settled = { key: shown?.key, value: shown?.value, data: view.preview }; render();
        setStatus(outcomeText('drifted', null, '', 'dialog')); return;
      }
      if (kind === 'never-submitted' && recovering) { intent = null; submitted = false; phase = 'idle'; setStatus(outcomeText('never-submitted', null, '', 'dialog')); schedule(0); return; }
      // Past the deadline and still pending: the outcome is unknown, with Check result (as the store does).
      if (kind === 'pending-expired') { phase = 'unknown'; showProblem(spawnApplyReason('E_OUTCOME_UNKNOWN'), 'spawn'); return; }
      const named = intent?.preview?.instance ?? shown?.data?.instance ?? '';
      if (kind === 'created') {
        phase = view.status;
        if (['complete', 'partial'].includes(phase)) {
          setStatus(outcomeText('created', view, view.receipt.instance, 'dialog'), phase === 'partial');
          if (!delivered) {
            delivered = true; deploymentField?.remember();
            // The spawn worked while Claude Code ignored the channel option (the receipt's `flagIgnored`): a
            // notice says so, once per completed apply, beside whatever the completion itself says. Only a
            // dialog that runs its own apply gets here: with a store (the shipped shell) spawn-jobs.mjs says it.
            const ignored = flagIgnoredNotice(view.receipt.instance, view.receipt.flagIgnored);
            if (ignored) ctx.notify?.(ignored.headline, ignored.detail ? { detail: ignored.detail } : undefined);
            await onCreated(view, () => current() && owner === mount);
          }
        } else {
          // Incomplete: what the screen differed in goes under the sentence; the nearest entry and the position are Details' data.
          const problem = spawnProblem(view.reason, 'spawn'), differed = view.incomplete.launchPrompts?.differed ?? null, said = differedLines(differed);
          setStatus(retainedSpawnMessage(view.incomplete), true, said ? { ...problem, detail: `${problem.detail} · ${said.detail}` } : problem, false, said ? differed : null);
        }
      } else if (kind === 'cleanup-owed') {
        // #802: rolled back, its cleanup owed: retiring the quarantined home completes it; a re-apply cannot.
        intent = null; submitted = false; phase = 'idle';
        const problem = cleanupOwedProblem(reason, named);
        notice = { ...problem, text: spawnText(problem) }; setStatus(notice.text, true, notice);
      } else if (kind === 'unknown') {
        // Unknown, with Check result: E_OUTCOME_UNKNOWN's words, or E_INTENT_EXPIRED's own once the press was
        // submitted (the record is gone, which proves nothing: never "Nothing was created").
        phase = 'unknown'; showProblem(reason, 'spawn');
      } else if (ROLLED_BACK_CODES.includes(reason?.code)) {
        // #802: the kernel rolled the spawn back: nothing was created.
        intent = null; submitted = false; phase = 'idle';
        const problem = rolledBackProblem(reason, named);
        notice = { ...problem, text: spawnText(problem) }; setStatus(notice.text, true, notice); schedule(0);
      } else {
        // Refused, stale or drifted after the press: nothing was created. Read the current values again.
        intent = null; submitted = false; phase = 'idle';
        const problem = spawnProblem(reason, 'spawn'), text = spawnText(problem, 'spawn');
        notice = { ...problem, text: /Nothing was created/.test(text) ? text : `${text} Nothing was created.` };
        setStatus(notice.text, true, notice); schedule(0);
      }
    } catch (error) {
      if (!valid()) return;
      if (submitted) { phase = 'unknown'; showProblem(spawnApplyReason('E_OUTCOME_UNKNOWN'), 'spawn'); }
      else { phase = 'idle'; showProblem(spawnApplyReason(error?.code), 'spawn'); }
    } finally {
      if (flight === token) { flight = null; if (alive) syncButton(); }
    }
  }
  /** What a remote spawn sends as its name: where it takes --name (roleNamed), the typed name, as for a local spawn;
   * else the purpose as typed (the host prefixes it); empty, the host names it from its task where it can (hostNames), else numbers it. The
   * key adds the target, so a refusal speaks only for the same name on the same host. */
  const remoteNaming = () => {
    if (!roleNamed()) return { purpose: purpose.value.trim() };
    const name = choices().value?.name; // typed, or this computer's suggestion for the text
    return name ? { name } : hostNames() && task.value.trim() ? { suggestName: true } : {};
  };
  const remoteNamingKey = () => JSON.stringify([remoteTarget(), remoteNaming()]);
  async function runRemote() {
    let wakeValue;
    try { wakeValue = wake.read(); } catch (error) { setStatus(error.message, true); return; }
    const draftChoice = choices();
    if (draftChoice.error) { setStatus(draftChoice.error, true); return; }
    const naming = remoteNaming(), sent = remoteNamingKey();
    // Unnamed here for exactly this text, and nobody else names it: the host numbers it, and the spawn says why.
    const numbered = !naming.name && !naming.suggestName && !naming.purpose && pressNaming?.text === task.value && pressNaming.reason
      ? { numbered: { reason: pressNaming.reason, harness: pressNaming.harness } } : {};
    // The host's own name refusal is said beside the Name field too, as a local preview's is, for the name it refused.
    const status = (text, error = false, problem = null) => {
      hostNameRefusal = error && NAME_REFUSALS.includes(problem?.code) ? { code: problem.code, sent } : null;
      setStatus(text, error, problem); if (alive) render();
    };
    remoteBusy = true; syncButton();
    try {
      const outcome = await remoteSpawn({ server: remoteTarget(), ...(deploymentField ? { agentsRoot: selector.agentsRoot, deployment: address() } : {}),
        ...naming, ...numbered, task: task.value, harness: runtime.value, model: model.value.trim(),
        backend: backend.value, launchConfig: config.value, yolo: yolo.value === '' ? undefined : yolo.value === 'true', background: backgroundChoice(), wake: wakeValue,
        relation: rel.value, relativeTo: relTo.value, relativeRoot: relTo.selectedOptions[0]?.dataset.root || '', status, button: spawn });
      if (outcome?.created) deploymentField?.remember(); // the host created it (the dialog may already be closed)
      if (outcome?.created && alive) phase = 'complete'; // created on the host: never a second spawn
    } finally { remoteBusy = false; if (alive) syncButton(); }
  }

  // ── model suggestions (advisory; free text stays valid)
  const suggestions = [];
  const models = createChoicePopup(doc, modelControls, 'Model choices', 'spawn-model-choices', () => [
    { value: '', label: matched() && !model.value && !nativeModel ? `Default · ${matched().model ?? "harness's own"}` : 'Default', selected: !model.value && !nativeModel, group: 'Defaults', search: false },
    { native: true, label: "The harness's own default", selected: nativeModel, group: 'Defaults', search: false },
    ...suggestions.map(m => ({ value: m.id, label: m.label || m.id, detail: m.label && m.label !== m.id ? m.id : undefined, selected: model.value === m.id, group: 'Suggestions' })),
    { custom: true, label: 'Custom…', detail: model.value || 'Type a model ID', group: 'Custom', search: false, selected: !!model.value && !suggestions.some(m => m.id === model.value) },
  ], item => {
    if (item.native) { nativeModel = true; model.value = ''; }
    else if (!item.custom) { nativeModel = false; model.value = item.value; }
    notice = null; dropPress(); schedule(0); model.focus();
  }, { searchable: true, scope: () => JSON.stringify([runtime.value || settled?.data?.harness || '', remoteTarget()]),
    nothingReported: 'No model suggestions reported. Any model ID can be typed.', noMatch: 'No suggestions match this filter.' });
  models.trigger.textContent = ''; models.trigger.setAttribute('aria-label', 'Choose model');
  // ── harness picker: the harness's badge, like the design's provider field
  const runtimePicker = createChoicePopup(doc, runtimeLabel, 'Harness choices', 'spawn-runtime-choices', () => [
    { value: '', label: matched() ? `Default · ${runtimeName(matched().harness)}` : 'Default', detail: 'What this soul launches with unless you choose', selected: !runtime.value,
      group: 'Default', search: false, ...(matched() ? { mark: () => createRuntimeBadge(doc, matched().harness) } : {}) },
    ...runtimes.map(v => ({ value: v, label: RUNTIME_NAMES[v], selected: runtime.value === v, group: 'Harnesses', mark: () => createRuntimeBadge(doc, v) })),
  ], item => { runtime.value = item.value; runtime.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); });
  function syncRuntime(data) {
    const t = runtimePicker.trigger, value = runtime.value || data?.harness || '';
    t.replaceChildren();
    if (value) t.append(createRuntimeBadge(doc, value));
    t.append(doc.createTextNode(value ? runtimeName(value) : 'Default'));
    if (!runtime.value && data) t.append(el('span', 'default', 'spawn-trigger-tag'));
    t.setAttribute('aria-label', `Harness: ${value ? runtimeName(value) : 'default'}${runtime.value ? '' : ' (default)'}`);
    runtimePicker.refresh();
  }
  async function fillModels() {
    const ticket = ++modelsReq, rt = runtime.value || settled?.data?.harness || '';
    modelsFor = rt; suggestions.length = 0; models.refresh();
    if (!rt || !local() || !current()) return;
    try {
      const d = await postJson(ctx, '/api/models', { harness: rt });
      if (!current() || ticket !== modelsReq) return;
      for (const m of Array.isArray(d?.models) ? d.models.slice(0, 500) : []) if (m && typeof m.id === 'string' && m.id) suggestions.push({ id: m.id, label: typeof m.label === 'string' ? m.label : '' });
      models.refresh();
    } catch { /* advisory only */ }
  }
  // ── launch configurations for this soul
  let configWanted = null; // a restored launch configuration, chosen once its options are listed
  async function fillConfigs() {
    const ticket = ++configsReq, prefer = configWanted ?? config.value;
    fillSelect(config, [['', config.options[0]?.textContent || 'Default']]);
    if (!local() || !cli()?.features?.includes('launch-config') || !current()) return;
    try {
      const asked = selector, ws = address();
      const d = await postJson(ctx, ws ? `/api/launch-configs?ws=${encodeURIComponent(ws)}` : `/api/launch-configs${wsQuery()}`, { action: 'list', selector: asked });
      if (!current() || ticket !== configsReq || asked !== selector) return;
      if (d?.selected?.soul !== asked.soul || d.selected.agentsRoot !== asked.agentsRoot || !Array.isArray(d.configurations)) return;
      for (const row of d.configurations.slice(0, 200)) if (row && typeof row.name === 'string' && typeof harnessOf(row) === 'string') {
        const o = el('option', `${row.name} · ${runtimeName(harnessOf(row))}`); o.value = row.name; config.append(o);
      }
      if ([...config.options].some(o => o.value === prefer)) config.value = prefer;
      if (configWanted !== null) { configWanted = null; schedule(0); }
    } catch { /* the default stays */ }
  }
  // ── execution servers (Advanced › Run on)
  // Disabled with why: the server's registered group failed its last roster read, or no group of it is the
  // registration's. Before the roster answers nothing is known: nothing is guessed. A group's souls are only
  // those spawned there before, not the ones its workspace offers, so they never disable a server: the kernel
  // refuses a soul the host doesn't offer, in its own words.
  // #517: with servers-per-workspace and server-connect the route answers this window's machines only
  // (`{ servers, filtered, key, deployment, aweb, reason? }`); without them it answers the registered list.
  // "Add a machine to this workspace…" is offered when the window has a key and a local deployment: the
  // last entry here, or (two or more deployments, no Where to run) a button under the Deployment field.
  Promise.all([Promise.resolve(typeof servers === 'function' ? servers() : servers),
    Promise.resolve().then(() => serverFacts()).catch(() => [])]).then(([answer, facts]) => {
    if (!current()) return;
    facts = Array.isArray(facts) ? facts : [];
    for (const f of facts) if (!serverGroups.has(f.server) && f === registeredGroup(facts, f.server)) serverGroups.set(f.server, f);
    render(); // a remote target's naming follows its host's features (roleNamed)
    taskEdited(); // and so does whether a name is asked for (suggesting)
    if (soul.server) return;
    const list = Array.isArray(answer) ? answer : Array.isArray(answer?.servers) ? answer.servers : null;
    if (!list) return;
    machines = !Array.isArray(answer) && answer.filtered === true ? answer : null;
    for (const srv of list) addServerOption(srv, facts);
    // The server is still learning unknown keys: read again until it is done, adding the machines it found.
    if (machines?.backfilling === true && typeof servers === 'function') stopBackfill = followBackfill({ read: servers, owns: current, delay: backfillDelay,
      use: next => { for (const srv of Array.isArray(next?.servers) ? next.servers : []) if (!serverNames.has(srv.id)) addServerOption(srv, facts); } });
    if (machines?.deployment) {
      if (deploymentField) deploymentField.element.after(addMachineRow());
      else { const o = el('option', 'Add a machine to this workspace…'); o.value = ADD_MACHINE; server.append(o); }
    }
    placeField.hidden = !list.length && !machines?.deployment && !machines?.reason;
    paintServerHint();
  }).catch(() => {});
  placeField.hidden = !soul.server;
  paintServerHint();

  // ── events
  const onEdit = event => {
    if (!current()) return;
    if (event.target === model) nativeModel = false;
    notice = hostNameRefusal = null; dropPress();
    if (phase === 'drifted') phase = 'idle';
    if (event.target === runtime || event.target === server) void fillModels();
    if (event.target === server) { shown = settled = null; void fillConfigs(); void fillRelatives(); paintServerHint(); taskEdited(); }
    // Typing in the name field replaces the suggestion, and stops suggestions for this dialog.
    if (event.target === purpose && event.type === 'input' && !nameTouched) { nameTouched = true; clearTimeout(suggestTimer); suggestTimer = null; suggestedNow = null; }
    if (event.target === task && event.type === 'input') { taskEdited(); syncButton(); return; }
    if ([search].includes(event.target) || wake.el.contains(event.target) || event.target === task) { syncButton(); return; }
    schedule(event.type === 'change' && (event.target.tagName !== 'INPUT' || event.target.type === 'checkbox') ? 0 : debounce);
  };
  form.addEventListener('input', onEdit); form.addEventListener('change', onEdit);
  spawn.addEventListener('click', () => { void press(); });
  cancel.addEventListener('click', () => close());
  closeButton.addEventListener('click', () => close());
  // Change soul: the picker, in place — never a reopen, so nothing typed is lost.
  changeSoul.addEventListener('click', () => { dropPress(); setLayout('picker'); focusTarget().focus({ preventScroll: true }); });

  // ── Spec E: focus and the section keys
  /** Name, with the caret at the end of what is there (a restored draft is never selected). */
  function focusName({ preventScroll = true } = {}) {
    purpose.focus({ preventScroll });
    const end = purpose.value.length;
    try { purpose.setSelectionRange(end, end); } catch { /* not a text input here */ }
  }
  const visibleControl = c => !!c && !c.disabled && !c.hidden && !c.closest('[hidden]');
  const tabbable = root => [...root.querySelectorAll('button, input, select, textarea, summary, [tabindex]')].filter(c => visibleControl(c) && c.tabIndex >= 0);
  /** Focus on open: the form's first field, the Opening instruction, without scrolling, with the caret at the
   * end of what is there (a restored draft is never selected). */
  function focusFirst({ preventScroll = true } = {}) {
    task.focus({ preventScroll });
    const end = task.value.length;
    try { task.setSelectionRange(end, end); } catch { /* not a text field here */ }
  }
  /** The control each section key lands on (Relationship: its selected segment; Teams: its first box one can tick). */
  const jumpTargets = {
    name: () => purpose,
    harness: () => runtimePicker.trigger,
    model: () => model,
    relationship: () => seg.querySelector('input:checked') || seg.querySelector('input'),
    teams: () => [...teamsList.querySelectorAll('input')].find(visibleControl) || null,
    task: () => task,
  };
  /** The first control of Developer settings, in tab order. */
  const firstAdvanced = () => tabbable(advancedBody)[0] || null;
  /** A section key: focus moves to that section's control; a closed disclosure holding it opens first.
   * 'advanced' toggles Developer settings: open, focus on its first control; closed, focus on its summary.
   * False when the section is not there (Teams not offered, say): focus stays. */
  function jump(target) {
    if (!alive) return false;
    // An open Harness or Model picker closes first (its focus is not restored: focus moves on), so Escape
    // afterwards still closes a picker before the dialog only when one is shown.
    models.close(); runtimePicker.close();
    if (target === 'advanced') {
      advanced.open = !advanced.open;
      const to = advanced.open ? firstAdvanced() || advancedSummary : advancedSummary;
      to.focus();
      return true;
    }
    const control = jumpTargets[target]?.();
    if (!visibleControl(control)) return false;
    const closed = control.closest('details:not([open])'); if (closed) closed.open = true;
    if (control === purpose) focusName({ preventScroll: false }); else control.focus();
    return true;
  }
  // The chords on screen, per section ({ label, aria } or null): the hint beside each label, and the
  // control's aria-keyshortcuts (every segment of Relationship and every team box, the one focused varies).
  let keysNow = {};
  function applyKeys() {
    const targets = {
      name: [purpose], harness: [runtimePicker.trigger], model: [model], relationship: [...seg.querySelectorAll('input')],
      teams: [...teamsList.querySelectorAll('input')].filter(c => !c.disabled), task: [task], advanced: [advancedSummary],
    };
    for (const [target, hint] of Object.entries(keyHints)) {
      const key = keysNow[target];
      if (hint.textContent !== (key?.label || '')) hint.textContent = key?.label || '';
      hint.hidden = !key?.label;
      for (const control of targets[target] || []) {
        if (key?.aria) control.setAttribute('aria-keyshortcuts', key.aria); else control.removeAttribute('aria-keyshortcuts');
      }
    }
  }
  function setShortcuts(keys) { keysNow = keys && typeof keys === 'object' ? { ...keys } : {}; if (alive) applyKeys(); }

  /** Reopen spawn (Spec C): put back every choice an earlier press made, exactly as sent. The preview
   * then reads for them as for any edit; nothing restored bypasses validation (choices()). */
  function restoreDraft(restore) {
    const c = restore?.choices;
    if (c && typeof c === 'object') {
      // A name comes back as sent, and goes again as it is; a purpose as typed.
      if (typeof c.name === 'string') purpose.value = c.name;
      else if (typeof c.purpose === 'string') purpose.value = c.purpose;
      worktree.checked = c.work === 'worktree' && soul.work === 'checkout';
      if (typeof c.branch === 'string') branch.value = c.branch;
      if (typeof c.base === 'string') base.value = c.base;
      if (typeof c.harness === 'string' && [...runtime.options].some(o => o.value === c.harness)) runtime.value = c.harness;
      if (typeof c.launchConfig === 'string') configWanted = c.launchConfig;
      if (typeof c.backend === 'string' && [...backend.options].some(o => o.value === c.backend)) backend.value = c.backend;
      if (typeof c.yolo === 'boolean') yolo.value = String(c.yolo);
      if (typeof c.background === 'boolean') { backgroundSwitch.checked = c.background; backgroundTouched = true; }
      if (c.model?.kind === 'native-default') nativeModel = true;
      else if (c.model?.kind === 'custom' && typeof c.model.value === 'string') model.value = c.model.value;
      const kind = c.relation?.kind, anchor = c.relation?.anchor;
      if (kind && kind !== 'unrelated' && anchor) {
        const radio = [...seg.querySelectorAll('input')].find(i => i.value === kind);
        const option = [...relTo.options].find(o => o.value === anchor.instance && o.dataset.root === anchor.agentsRoot);
        if (radio && option) { radio.checked = true; option.selected = true; }
      }
      if (c.identity?.mode === 'local' || c.identity?.mode === 'global') { identity.value = c.identity.mode; resident.value = c.identity.resident || ''; }
      for (const label of Array.isArray(c.join?.labels) ? c.join.labels : []) joinPicked.add(label);
    }
    if (restore?.wake) wake.set(restore.wake);
    // A suggested name comes back as the suggestion for the text it was made for (the field stays empty).
    const n = restore?.naming;
    if (n && typeof n.task === 'string' && typeof n.name === 'string' && previewChoices({ name: n.name })) {
      namings.set(keyOf(n.task), { source: 'suggested', name: n.name });
      suggestedNow = suggestionNow();
    }
  }
  restoreDraft(draft.restore);
  setLayout(layout); render();
  return {
    /** Begin reading once the host owns the attached dialog. */
    start() { if (!current()) return; deploymentField?.start(); schedule(0); void fillModels(); void fillConfigs(); },
    dialog, search, purpose, spawn, status, preview, changeSoul,
    /** Spec E: focus Name (caret at the end), the first field (focus on open), a section key's jump, and the chords the hints show. */
    focusName, focusFirst, jump, setShortcuts,
    /** 'scoped' (preview + form) or 'picker' (chooser + form); switched in place. */
    get layout() { return layoutNow; }, setLayout,
    submit: () => { if (!spawn.disabled) void press(); },
    busy,
    /** CLI/roster/workspace facts changed under the open dialog. */
    sync() {
      if (!alive) return;
      if (!current() || flight || submitted) { syncButton(); return; }
      const facts = factsKey();
      // A settled failure (the CLI failed, was busy…) is retried on the next poll; a name refusal waits
      // for the operator's edit, and a settled preview or a read in flight stands until a fact changes.
      const retry = !readDue() && !!shown?.failure && !NAME_REFUSALS.includes(shown.failure.code);
      if (facts === factsSeen && !retry) { syncButton(); return; }
      factsSeen = facts; schedule(0);
    },
    /** The background spawn store changed: re-read whether a spawn of this soul is in flight. */
    syncInFlight() { if (alive) syncButton(); },
    closePopups() { models.close(); runtimePicker.close(); deploymentField?.closePopup(); },
    dispose() { alive = false; narrowQuery?.removeEventListener?.('change', placePreview); addMachineDialog?.close({ restoreFocus: false }); stopBackfill?.(); clearTimeout(timer); clearTimeout(suggestTimer); serial++; pressed = null; modelsReq++; configsReq++; deploymentField?.dispose(); models.dispose(); runtimePicker.dispose(); form.removeEventListener('input', onEdit); form.removeEventListener('change', onEdit); },
  };
}
