/** The session backends a spawn or a schedule may name, as the kernel lists them. Two lists, one meaning each:
 *
 *   `sessionBackends` of `oats version --json`   the kernel's own: `["tmux"]` (an older kernel may still say
 *                                                "herdr", which OATS removed: never offered, never sent)
 *   `sessionProviders` of `oats inspect --json`  the session providers a home or a soul can use, each supplied
 *                                                by one of its capabilities (feature session-providers)
 *
 * A client offers and accepts these names and no other: a `--backend` value (cli-adapter.mjs `spawnArgv`) and a
 * schedule's `backend` it reads back into a form are held to them. Pure: no I/O, never throws. */
import { sessionProviderName } from './instance-presentation.mjs';

const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The provider names an inspection lists, in its order, each once: the `name` of each row of its top-level
 * `sessionProviders` (`[{ name, capability }]`). Only a name the contract allows (instance-presentation.mjs
 * `sessionProviderName`) and never "herdr", which OATS removed; anything else, and an inspection without the
 * list, lists none. */
export function sessionProviderNames(inspection) {
  const listed = record(inspection) && Array.isArray(inspection.sessionProviders) ? inspection.sessionProviders : [];
  return [...new Set(listed.map((row) => (record(row) ? row.name : undefined)).filter((name) => sessionProviderName(name) && name !== 'herdr'))];
}

/** A list of backend names as a client may offer or send them: its strings, never empty, never "herdr". */
export const listedBackends = (names) => (Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name && name !== 'herdr') : []);

/** Every backend name the kernel lists: its own (`cli.sessionBackends`; "tmux" alone for a probe record without the
 * list, as before the probe reported it) and then the providers of `inspection`, when one is given. */
export function sessionBackendNames(cli, inspection = null) {
  const own = Array.isArray(cli?.sessionBackends) ? listedBackends(cli.sessionBackends) : ['tmux'];
  return [...new Set([...own, ...sessionProviderNames(inspection)])];
}

/** The session providers that launch only in full mode (`yolo: true`): the provider refuses any other launch
 * at its readiness check (`E_BACKEND_SANDBOXED_MODE`), so a spawn, a schedule's run or a trigger's fire on one
 * without it creates nothing. bb, today (the bb contract, A8: bb homes run in full mode only).
 *
 * THE ONE PLACE a client names them. The kernel does not list this: only the provider knows its mode, and it
 * says so when asked about a planned launch (`oats spawn --preview`, since 0.70.1). A form does not ask that
 * way: the Desktop's preview boundary admits `backend: "tmux"` alone (spawn-preview-contract.mjs
 * `previewChoices`) and a preview may take the provider's whole 20 s, and a soul's readiness asks the check
 * with no launch, so it reads ready. When a provider lifts the refusal, or another one adds it, change this
 * list (or replace it with what the kernel then reports) and nothing else. */
export const FULL_MODE_ONLY_PROVIDERS = Object.freeze(['bb']);

/** Whether `backend` names a provider that launches only in full mode. */
export const fullModeOnly = (backend) => typeof backend === 'string' && FULL_MODE_ONLY_PROVIDERS.includes(backend);

/** What a spawn definition's permission choice means on its backend (`{ backend, yolo }`, as a schedule or a
 * trigger's spawn stores them), for a backend that launches only in full mode:
 *
 *   'refused'   `yolo: false`: every launch is refused
 *   'default'   no `yolo`: the launch takes its launch configuration's choice (docs/execution-targets.md
 *               "Permissions"), so it is refused unless that sets full mode
 *   null        `yolo: true`, or a backend that takes any mode: nothing to say
 *
 * Pure: no I/O, never throws. */
export function fullModeProblem(spawn) {
  if (!record(spawn) || !fullModeOnly(spawn.backend) || spawn.yolo === true) return null;
  return spawn.yolo === false ? 'refused' : 'default';
}
