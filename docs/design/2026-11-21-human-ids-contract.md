# Human IDs: the contract between aweb's primitives and OATS

**Status:** DRAFT r1, 2026-11-21. It isn't in force until aweb's maintainers and the
product owner's side approve it on this PR. Items marked **OPEN** are undecided and
mustn't be built on.

**What it is.** aweb lets a person adopt an agent (a "root") so that every agent the root
creates afterwards carries a verified chain back to that person. OATS consumes this:
- it creates agents from a root, so new instances inherit the chain;
- it reads each instance's verified human and shows it as **Owning human**.

This record is the one place that says which aweb primitives OATS relies on, exactly how
OATS calls them, what each side owns, and the gates before anything ships. When aw changes
one of these primitives, or OATS changes how it uses one, this record changes first.

**Sources.**
- aweb: main `d8d0bfa1e7` (`docs/id-certificates.md`, `docs/identity.md`,
  `docs/cli-integration-contract.md`, `docs/cli-command-reference.md`) and aweb's primitive
  list at that SHA.
- Cloud: the person's dashboard steps read at Cloud `15591632` (tag v0.8.80) and main
  `234882b7`.
- OATS: the integration plan v1.5, read with oats-aweb main `717d0fd`.

Every behaviour below is pinned at **the 1.36.59 cut SHA**, which aweb names when it cuts.
Commit ids are background only.

## 1. Principles both sides keep

1. **Opt-in is the adoption itself.** A deployment whose roots nobody adopted changes in
   nothing: no OATS setting, no config key, no new aw requirement.
2. **People sign; agents never act as people.**
   - aw refuses every person signature inside an OATS instance or without a terminal
     (`human_approval_required`).
   - No agent uses a person's signing key, or an account key that carries the person's
     authority, such as a team owner/admin API key.
   - The person's acts happen in Cloud's dashboard.
3. **Prospective, never retroactive.**
   - Adoption applies from then on.
   - Instances created before it keep their key, ID, certificate, address, mailbox and
     memberships, and read `unknown`.
   - OATS doesn't respawn or re-sign them.
4. **Attribution is information.** No OATS behaviour (gating, routing, permission) depends on
   the human. OATS only reads it and shows it.
5. **aw's answer is the truth.** OATS copies aw's verdicts and refusals as aw gives them. It
   reads them only from aw's `--json` fields (§5), never from prose.

## 2. Primitives OATS uses

| # | Primitive (aw at the cut SHA) | Who runs it, where | OATS's use |
|---|---|---|---|
| P1 | `aw --identity-home <root>/.aw id parent request --domain D --parent H --invitation-id I --out request.json` | An agent, in the root's home, during adoption | Documented step (PR b). D, H and I are copied from the dashboard's invitation, never derived. |
| P2 | `aw --identity-home <root>/.aw id parent import response.json --domain D` | An agent, in the root's home | Documented step (PR b). |
| P3 | `aw --json init --join-from=<root> --join-team=<T> --name=<alias> --do-not-touch-agents-md` | The provider's spawn hook, on the root's host, as the deployment's user | Primary identity of every spawned instance (unchanged). After adoption, aw signs the child under the root through a same-machine retained link. |
| P4 | `aw team invite --team-id <T> --json` in the root, then `aw --identity-home <home>/.aweb-identity-<label> id team accept-invite --token-stdin --name <alias> --local --parent <root>/.aw --json` | The provider, joining an instance to an extra team | Joined-team identities. `--parent` is needed once the root is adopted, because its invites then carry `for_human` (**OPEN A**). |
| P5 | `aw --identity-home <home>/.aw who --json` | The provider | C1 and C2 (§4). |
| P6 | `aw id team remove-member` on a hosted team (route `/api/v1/teams/{team_id}/agents/remove-member`), needing a team-scoped owner/admin API key | **OPEN R** | Revocation (§6). |

Person's steps in Cloud (dashboard, signed in, the root's team selected, from the root's
Chat or Messages pane):
1. **Adopt**, which creates invitation I and shows I, H and D.
2. **Upload request.json**, then **Approve and prepare response**.
3. **Download response.json**.

Preconditions:
- the person has claimed a human ID;
- they are the root's recorded creator, with an active account and current membership of
  the root's team, or a team admin or owning-organisation owner/admin.

OATS doesn't use, and doesn't build on, these aw primitives:
- `id create --human-parent`;
- `id child invite/receive/approve` on an OATS host;
- `id parent refresh`, `--resign` and `install`;
- `id revoke`;
- an explicit `team invite --for-human`;
- global join-from;
- hosted `--member-global` mint.

## 3. aw's rules OATS relies on

- **The `aw who --json` shape** is `{id, domain, outcome, human_id, identity_valid, kind, reason, chain?, evidence?}`.
  - `outcome` is one of `nearest_human`, `no_human`, `unknown` or `unavailable`.
  - `human_id` is set only on `nearest_human`.
  - `chain[{id,kind}]` is present only when the chain is verified.
  - `unavailable` (`evidence_unavailable`, `status_expired`) is a value, not a command
    failure.
  - A `did:key` home with no chain reads `unknown` / `legacy_no_chain`.
  - The same fields exist in aw 1.36.58.
- **Adoption** is once per root key, and only for an organisation-only chain.
  - A local `did:key` root adopts only through the browser-file flow above. An
    agent-submitted request is refused with `global_agent_required`.
  - One adoption covers one key. A host with several roots needs one adoption per root.
- **After adoption:**
  - The root's invites carry `for_human`. On a hosted team, Cloud sets it by default (**to
    confirm in OPEN A**).
  - A `--join-from` child satisfies it.
  - Spawning needs aw's registry and the person's domain DNS. Without them, the spawn is
    refused (`evidence_unavailable`) with no fallback.
  - New children are issued in the person's domain.
  - Alias, address form, roster entry and mail and chat routing are unchanged in form.
  - A grandchild's ID parent is the root, because OATS mints every instance from the root.
- **Same machine, same HOME.** Both halves of one mint run on the root's host, as the same
  user with the same HOME. The retained link lives under the minting process's HOME. A mint
  whose issuer can't be reached locally stops as **signature pending**: key and request
  kept, no membership submitted, stable code `native_agent_signature_pending` (in the cut
  SHA, to be confirmed by aweb).

## 4. OATS's side (oats-aweb PR a; docs PR b)

**C1, the attribution read.**
- **When:** at spawn after the mint, and at each start (the launch hook's real pass only,
  never under `OATS_LAUNCH_PREVIEW=1`).
- **The read:** P5, bounded at 5 s, run once, with no retry. It never refuses and never
  delays beyond the bound.
- **What it writes:** the kernel's existing `attribution` in the served identity:
  `{mode, human: {id, label}|null, parent: {id}|null}`.
- **Mapping from aw's `outcome`:**
  - `nearest_human` → `human`. `label` is `human_id`, because aw gives no display name, so
    the Desktop shows the `did:aw`.
  - `no_human` → `none`.
  - Anything else → `unknown`.
- **Carry-forward:** a non-zero exit, a timeout, unparseable output or `unavailable` carries
  the previous value forward, or `unknown` if there is none. An answer aw gave replaces the
  previous value.

**C2, the root report in `oats aweb setup --check-only --json`.**
- **Shape:** `roots[]`, one `{label, home, attribution: {outcome, humanId|null, reason|null}}`
  per roots-map entry.
- **The read:** P5 with `--identity-home <root>/.aw`.
- **A failed read** gives `unavailable` with its reason.
- **Old aw:** a root that reads `nearest_human` on an aw below 1.36.59 gets a note that
  spawning from it needs 1.36.59.

**C3, the adopted-lineage warning.**
- **The record:** the provider keeps each root's last C2 outcome in its own state.
- **When it warns:** a root that last read `nearest_human` now reads `unknown` or
  `no_human`, whatever the reason. Examples are `legacy_no_chain` after a restore from a
  backup taken before adoption, and `revoked` or `root_replaced`.
- **How:** it warns at spawn and in check-only, naming the root and aw's reason.
- `unavailable` never triggers it, and the last outcome is kept.
- It never refuses. A stale copied home is never a reason to adopt again.

**Signature pending.**
- A mint stopped as signature pending is left for the operator. The kernel's compensation
  doesn't retire it, because that would delete the kept key.
- PR a recognises it by `native_agent_signature_pending`.
- If the cut SHA lacks that code, PR a falls back to not retiring a home whose mint failed
  after aw wrote a key.
- oats-aweb never retries or remints into the same home.

**Reading aw's refusals.**
- ID-certificate refusals arrive as `error.code "error"` with the bare reason in
  `error.message`.
- HTTP refusals arrive as `error.code "http_error"` with `http_status` and `reason`.
- PR a branches only on the exit status and these fields.

**The aw floor.**
- `min` stays 1.36.33, so a deployment that doesn't adopt needs no new aw.
- `tested` moves to the 1.36.59 final.
- A deployment that adopts a root needs aw 1.36.59 on that root's host (C2's note; PR b says
  to upgrade before adopting).

**Where OATS mints, and the connect rule.**
- Spawns (including routed spawns, schedules and sandbox seats made by sync) mint through P3
  on the host that runs them, from that host's own root.
- Joined teams mint through P4.
- GLOBAL grant seats, retained seats and `setup --create` don't mint from a root.
- `oats aweb connect <server>`, and `setup --join` with an invite issued by a root on
  another machine, mint away from the issuing root. After that root is adopted they would
  stall.
- The rule (**OPEN B** until aweb confirms): connect a server before adopting the root that
  invites it, or invite it from an unadopted member. The remote root is then adopted on its
  own.

## 5. Gates

- **G1, aw.** Nothing merges until aw 1.36.59 final is published and PR a's real-binary
  tests pass against the final binary at the cut SHA.
  - Development and CI may use `1.36.59-rc.3`, pinned by integrity.
  - `tested` never points at an RC.
- **G2, the run.** aweb's Cloud journey case (`cloud-journey-case-acxy7-v1`, step hash
  `85196827b2b0`) runs on a scratch hosted team with a test person, never on a live team or
  a real person's identities.
  - Its first green run, with a verdict per step, is the evidence.
  - The agreed record (v3) is written from it.
  - Its steps: adopt R; mint child and grandchild unattended, both verifying to the person;
    an earlier child unchanged; a control child from an unadopted root matching in alias,
    address, roster and routing; revocation refusing the next mint (expected `http_error`
    401 `certificate_revoked`, counted once the run reports it); memberships and history
    kept; clean-up.
- **G3, Cloud.** Adoption on hosted teams waits for the Cloud release that aweb pairs with
  aw 1.36.59 to go live. aweb names its version.

## 6. Revocation

- There is no per-root undo of an adoption.
- The control is removing the root's team membership. The way on is a new root with a new
  key.
- Removing the membership leaves the other members' memberships, mail and history
  unchanged.
- The person can revoke their whole ID, which ends everything under them. OATS neither does
  nor tests that.

**OPEN R: who removes the membership, and how.** On a hosted team it's P6, which sends a
team-scoped person API key. aweb rules that no agent may use that key. Cloud's dashboard
owners read the paired Cloud release (7b034ae27) and found:
- the dashboard issues only creation-only setup keys, which removal refuses with 403
  `setup_key_creation_only`;
- so a person has no dashboard way to obtain a key P6 accepts. Only a previously issued
  unrestricted key still works.
- such keys have no expiry, and there is no dashboard control to revoke them.

As released, the person can't revoke an adoption on a hosted team without an old key. The
Cloud removal route also accepts a signed-in person's authority, so a dashboard **Remove**
action for an agent member needs no new server authority. The options, for the people who
own the product:
- Cloud ships that dashboard Remove action with the paired release. Adoption then has a
  documented undo, all in the browser. **The OATS maintainers recommend this.**
- Adoption ships without a documented revocation on hosted teams, and PR b says so plainly.
- Cloud adds a dashboard issuer for a removal-capable key, and the person runs P6 from a
  terminal.

PR b's revocation text waits for this.

## 7. Ownership

| Area | Owner | Approves changes |
|---|---|---|
| aw primitives P1 to P6, codes, the cut SHA | aweb's maintainers | aweb's maintainers |
| Cloud's person steps and the paired Cloud release | aweb's Cloud maintainers | aweb's maintainers |
| The journey case and its verdicts (G2) | aweb's Cloud maintainers | both sides; any change to the case's text comes to OATS first |
| C1 to C3, the mint flows, the floor (oats-aweb PR a) | the product owner's side builds it | the product owner's side, then the OATS maintainers at the exact head |
| Docs and release notes (PR b) | the product owner's side | both |
| This record | the OATS maintainers | both sides, on its PR |

## 8. Open items

- **A.** Whether `--parent <root>/.aw` on `id team accept-invite` is the supported,
  unattended route for joined-team mints from an adopted hosted root, and whether Cloud sets
  `for_human` on a hosted root's invite by default. (aweb)
- **B.** The connect rule, or a supported way for an adopted root to issue a member invite
  without the `for_human` condition. (aweb)
- **C.** Confirm `native_agent_signature_pending` is in the cut SHA. (aweb, at the cut)
- **R.** Who removes a root's membership on a hosted team (§6). (decided by the people who
  own the product)
