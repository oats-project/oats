# Username setup and deployment default

Requires the provider 1.23.0 composition (#70), selected LOCAL deployment D,
messaging soul S, explicit account username and root alias. Selected kernel must
supply deployment scope and public `teams --dir D --json` (`teamsApi: 2`), add,
default and readback. Verified public source is OATS 0.42 at `bb2ba8c9`; this is
not an earliest-release claim or installation proof. Native argument/membership
contract is exercised with aw 1.36.33 (commit `877bbee94ce45aa1ff103912bc9850556e61dfb4`). No live account or timed M3 claim follows.

| Act / context | Exact command in D | Writes / success / one next step | Error → remedy |
|---|---|---|---|
| Preview selected username/root and configuration | `oats aweb setup --soul S --username <u> --name <alias> [--label L] --plan --json` | Reads policy/version and any retained membership; no install, root creation, signup or team mutation. Returns predicted team, chosen label/root, `bootstrap` (`required`, `reuse` for a retained root, or `resume` for a root holding a signup aw has not finished) and conditional add/default argv. Prediction is not membership proof; add may implicitly set default. Next: authorized apply below. | `E_SETUP_POLICY` only for `local-teams-closed` when the plan needs a team write; `E_SETUP_TEAM_CONFLICT` for an existing different/unmapped label. Reconcile policy/declaration before apply or select a different label. |
| Create or resume, with the same authorized inputs | `oats aweb setup --soul S --username <u> --name <alias> [--label L] --json` | Missing root runs native `aw init --new-account --username <u> --name <alias> --do-not-touch-agents-md`. Retained root is read, never signed up again. A root whose `.aw` holds the journal of a signup aw 1.36.59 did not finish after an unknown outcome (`signup-recovery.json`, whatever aw installed beside it) re-runs the same `aw init`, which resumes that signup with the same signer and without a second signup once the service had accepted it; setup never changes that `.aw`. Exactly one LOCAL membership must match `default:<u>.aweb.ai` and explicit alias. Observed canonical ID drives mapping; exact mapping is reused. Public kernel add/default is followed by readback; default runs only if still needed. Success requires matching membership, mapping and default. Next: attach the account's person (`aw --identity-home "<root>/.aw" claim-human --email <their email>`, `/oats-aweb` "attach yourself to the account"), which the success text names with the root; then `/oats-onboarding` staffing and receive verification. | `E_SETUP_USERNAME_UNAVAILABLE` (`that username is taken: choose another`, or reserved, or its format) → nothing was created: ask the person for another username and re-run with it. `E_SETUP_MEMBERSHIP` → wrong/missing/ambiguous account, alias or scope; root is retained and nothing mapped. Reconcile the selected root; do not delete/reinitialize it. |
| Resume after a configuration failure | Repeat the same apply command after fixing its named kernel/configuration error | Retains root and matching mapping; no second signup. Reads actual state, including default side effect of add. Success requires final readback, not a successful prior command alone. Next: onboarding's staffing stage. | `E_SETUP_KERNEL` or `E_SETUP_READBACK` → inspect returned steps/observed configuration. Missing observed data means readback unavailable, not no writes. Repair the selected kernel/deployment before retry; no automatic rollback or success inference. |

Without `--label`, the label uses the existing team-name normalization: lowercase,
dots/underscores become hyphens, and leading/trailing hyphens are removed. Only
the label is normalized; the native account username is never rewritten or
inferred from a soul. Explicit label is a lowercase kernel label. The root alias
is always explicit and follows the existing 1–64 character aweb rule.

Closed policy, when the plan needs a team write, and known label conflicts
refuse before native bootstrap or CLI installation. Their two manual
reconciliation commands are returned as argv:
`oats teams add L --team T --dir D` and `oats teams default L --dir D`.
These commands cannot bypass shared declarations or closed policy; its owner
must resolve that first. A closed workspace whose committed default already
names the label for the predicted team needs no team write and proceeds. Setup never edits shared files, imports private kernel
code or silently overwrites a mapping. `E_SETUP_ARGUMENT`, `E_SETUP_DEPLOYMENT`,
`E_SETUP_ROOT`, `E_SETUP_QUERY` and `E_SETUP_CONFIGURATION` require repairing
inputs/context, not relabelling every failure as policy closure.

`E_SETUP_USERNAME_UNAVAILABLE` names why aw refused the username (taken, reserved,
its format, or the service's own short reason word) and nothing else of aw's
output; aw refuses it before it creates anything. `E_SETUP_NATIVE` preserves safe
exit context and withholds credential-bearing output. A failed signup can leave partial state; no automatic retry or deletion
is performed. When the outcome is unknown (the service answered 5xx: the account may
exist), aw 1.36.59 and later keep the attempted signup in the root's `.aw`, and
`E_SETUP_NATIVE` says so: re-run the same setup command, with the same flags and
`AWEB_URL`, and aw resumes it. A changed username, name, service, scope, registry or
API key is aw's refusal, under `E_SETUP_NATIVE`. A root whose `.aw` this user cannot
search is refused with `E_SETUP_MEMBERSHIP` before any aw command: whether aw left a
signup there is unknown, and an aw that keeps none could sign up again. `E_SETUP_AW` requires the explicit operator installation procedure
in `/oats-aweb` §8; `--install-aw` is never acted on by a plan. `--label/--plan`
apply only to `--username`, not API-key, controller-team, invite-join or GLOBAL
setup. Configuration success does not establish a connected receiver or consent.
