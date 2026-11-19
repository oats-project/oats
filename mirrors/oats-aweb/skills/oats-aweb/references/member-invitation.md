# Issue and accept a LOCAL hosted member invite

The following provider act needs the provider 1.23.0 composition (#71); pinned native
contract evidence is aw 1.36.33 (commit `877bbee94ce45aa1ff103912bc9850556e61dfb4`). Use an authorized selected deployment D and
messaging soul S, selected-kernel `OATS_TEAM_SCOPE` dispatch and public
`teams --dir D --json` with `teamsApi: 2` (verified at OATS 0.42 source
`bb2ba8c9`, not an earliest-release claim). Unsupported schema refuses before
minting; other acts retain the general package floor. It issues an **agent member** invite, not a human admission
invite. Do not infer an owner/admin role from membership or `can_spawn`.

| Act / context | Exact command | Writes / success / one next step | Error → remedy |
|---|---|---|---|
| Plan LOCAL hosted member invite in D; declared L or selected soul default and matching root membership | `oats aweb invite --soul S --label L --plan --json` | Reads only; returns root/team and server-decides-authority statement, no token or permission promise. Next: authorized issuance below. | `E_INVITE_TEAM_QUERY`, `E_INVITE_TEAM`, `E_INVITE_ROOT`, `E_INVITE_MEMBERSHIP` → repair selected kernel/declaration/root membership; no ambient-principal fallback. |
| Issue once in D under the same selection | `oats aweb invite --soul S --label L --out <new file> --json` (an agent always passes `--out`: the token then never enters its transcript) | Native/server decides permission at issuance. With `--out`, the token is written to that new owner-only (0600) file and JSON success carries `result.tokenFile`, its absolute path, in place of `result.token`; hand the file to the recipient privately, and delete it once accepted. Without `--out`, JSON success has exactly one `result.token`: capture privately, never echo/log or send as ordinary mail. Token is not alias-bound. `result.awebUrl` is the service the issuing root names, a plain service URL only (`null` when it names none or one that could carry a credential): it is safe to hand on with the token as the recipient's `--service`; the token is the only secret part. Next: intended recipient's labelled stdin acceptance below. | `E_INVITE_OUT` before minting ("nothing was minted", or the path is taken, missing or cannot be checked) → something is already at the `--out` path (a link included), its directory is missing, or the file cannot be created there: name a new file. `E_INVITE_OUT` after minting ("the invite was minted (invite_id …) but could not be written") → the token is not printed and that invite stays live: keep its `invite_id` to revoke it (named only when aw gave it as a plain identifier; otherwise the message says it is withheld), and mint another; if it adds that the file could not be removed, delete that file: it may hold part of the token with a new `--out`. `E_INVITE_DENIED` → native HTTP 401/403 refused; static body-withheld detail, no inferred role. Other status/transport/unknown errors are `E_INVITE_NATIVE`; malformed successful output is `E_INVITE_OUTPUT`. Privately reconcile uncertain issuance before any deliberate retry. |
| Accept at the recipient deployment with intake-selected D/S/L, alias and service | `oats aweb setup --soul S --join L --invite-stdin --name <chosen-root-alias> --service <selected-url> < <the token file>` | Supply the private token on stdin (the `--out` file, or typed at the no-echo prompt on a terminal), never provider argv/history/logs. Existing labelled join creates/connects/records its separate LOCAL root; verify matching canonical membership. Next: `/oats-teams` mapping/default readback. | Use `/oats-aweb` §8 **LOCAL team join and resume** for errors and tokenless resume; never redeem again to repair recording. |

Omit `--label` only to use the selected soul's default. A positional recipient
is `E_INVITE_ARGUMENT`; accepting alias belongs only on the acceptance command.
Without `--json` and `--out`, apply stdout is the token alone; with `--out`, it names the file. Native accept still puts it
in target-host argv temporarily. Never use issuance success as receive readiness.
`roots[T]` takes precedence; an invalid explicit override fails closed. Native
issuance runs at that root with explicit team, isolated HOME and no external
identity-home or inherited credentials/routing. Controller-only/BYOT and GLOBAL
issuance are unsupported here; no ambient controller fallback or auto-retry.
