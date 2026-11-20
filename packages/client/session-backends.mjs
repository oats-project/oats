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
