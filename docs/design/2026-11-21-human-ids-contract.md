# Human IDs: the contract between aweb's primitives and OATS

**Status:** DRAFT r2, 2026-11-21 (r1 read by aweb's maintainers and the OATS deployment owner's side). It isn't in force until aweb's maintainers and the
OATS deployment owner's side approve it on this PR. Items marked **OPEN** are undecided and
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
- OATS: the integration plan v1.7 (`0d8b9e1159c6`), read with oats-aweb main `717d0fd`.

Every behaviour below is pinned at **the 1.36.59 cut SHA**, which aweb names when it cuts.
Commit ids are background only.

## 1. Principles both sides keep

1. **Opt-in is the adoption itself.** A deployment whose roots nobody adopted changes in
   nothing: no OATS setting, no config key, no new aw requirement.
2. **People sign; agents never act as people.**
   - No agent holds or uses a person's signing key, or a team-scoped owner/admin API key of
     a person's account (P6's key). This is an OATS rule in its own right.
   - A BYOT team's controller key on the deployment host, which the provider's mint uses
     (`aw init --join-from` signs the local invite with it), is unchanged. It belongs to the
     deployment's user, not to a person's account.
   - aw also refuses every person signature inside an OATS instance or without a terminal
     (`human_approval_required`). That is a safeguard on native person signing, not a
     custody boundary, so OATS doesn't rely on it.
   - The person's adoption acts happen in Cloud's dashboard.
   - OATS's existing operator-run key flows are unchanged: `oats aweb setup`'s provisioning
     key and `resident create`'s dashboard key are typed by the person into a protected
     child environment and never held by an agent.
3. **Prospective, never retroactive.**
   - Adoption applies from then on.
   - Instances created before it keep their key, ID, certificate, address, mailbox,
     memberships and actual ancestry. Chainless ones read `unknown` / `legacy_no_chain`.
     Ones with older namespace ancestry can read `no_human`, or refuse superseded evidence.
   - Leaving them alone is the deployment owner's choice. OATS doesn't respawn or re-sign
     them.
4. **Attribution is information.** No OATS behaviour (gating, routing, permission) depends on
   the human. OATS only reads it and shows it.
5. **aw's answer is the truth.** OATS copies aw's verdicts and refusals as aw gives them. It
   reads them only from aw's `--json` fields (§5), never from prose.

## 2. Primitives OATS uses

| # | Primitive (aw at the cut SHA) | Who runs it, where | OATS's use |
|---|---|---|---|
| P1 | `aw --identity-home <root>/.aw id parent request --domain D --parent H --invitation-id I --out request.json` | An agent, in the root's home, during adoption, with the root's own key | Documented step (PR b). D, H and I are copied from the dashboard's invitation, never derived. Writes and retains the request. Only a genuinely chainless root, or one parented directly by its namespace, can be adopted. A root with person ancestry or an agent parent can't. |
| P2 | `aw --identity-home <root>/.aw id parent import response.json --domain D` | An agent, in the root's home | Documented step (PR b). Verifies and installs the exact signed response. If these steps become machine-consumed, they add `--json` and follow §4's refusal rules. |
| P3 | `aw init --join-from=<root> --join-team=<T> --name=<alias> --json --do-not-touch-agents-md` (oats-aweb `bin/oats-aweb.mjs:2541`), `<root>` being the root's workspace directory | The provider's spawn hook, on the root's host, as the deployment's user | Primary identity of every spawned instance (unchanged). After adoption, aw signs the child under the root through the mint's same-machine hosted issuer link. |
| P4 | `aw team invite --team-id <T> --json` with the root as the selected identity, then `aw --identity-home <home>/.aweb-identity-<label> id team accept-invite --token-stdin --name <alias> --local [--parent <root>/.aw] --json`, the same token on stdin | The provider, joining an instance to an extra team; `<home>/.aweb-identity-<label>` is fresh, or the same retained target on retry | Joined-team identities. aweb confirms `--parent` as the supported, unattended route (native agent-to-agent exchange through a token-scoped creator link, same user and HOME). The child proves the invite's human before membership is submitted. `nearest_human` selects the explicit `--parent` path. That is decided by one bounded P5 read of `<root>/.aw` at join time, falling back to C3's record when the read is `unavailable`. Otherwise `--parent` is omitted: a genuinely chainless root's join is unchanged, and a chained `no_human` root's same-machine join completes through the retained mint link without it. An adopted root on an aw below 1.36.59 stops before minting any invite. That stop is an oats-aweb diagnostic with an OATS-owned code, and a README line names the fix. |
| P5 | `aw --identity-home <home>/.aw who --json` | The provider | C1 and C2 (§4). |
| P6 | `aw id team remove-member --namespace D --team NAME --cert-id C [--aweb-url URL] --json` (or `--member`), with a team-scoped owner/admin API key from `--api-key` or `AWEB_API_KEY`, calling `/api/v1/teams/{team_id}/agents/remove-member` | The person, from a terminal (§6) | Membership removal (§6). The documented person-run CLI uses the setup key. The server also accepts signed-in person authority for the same route. A person's signing key is a separate credential. |

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
- **Adoption** is once per root key. P1 and P2 cover two cases:
  - first issuance to a genuinely chainless root;
  - one-time replacement of a chain parented directly by the namespace, under the first
    person.
  - Cloud's browser authority and eligibility checks gate either case.
  - A local `did:key` root adopts only through the browser-file flow above. An
    agent-submitted request is refused with `global_agent_required`.
  - One adoption covers one key. A host with several roots needs one adoption per root.
- **After adoption:**
  - The root's ordinary hosted member invites default to its verified nearest human
    (`for_human`). There is no opt-out: `--for-human` can only name another valid person.
  - A `--join-from` child satisfies it.
  - Spawning needs current evidence: registry status and the namespace's DNS. Valid cached
    evidence can cover a brief outage. Without current evidence, the spawn is refused
    (`evidence_unavailable`) with no fallback.
  - New children are issued in the person's domain.
  - Alias, address form, roster entry and mail and chat routing are unchanged in form.
  - An instance spawned by another instance has the root as its immediate ID parent,
    because OATS selects the root for every mint. Its OATS parent stays in `spawnedBy`.
  - An evidence failure refuses without dropping a presented chain. The code and reason can
    vary with the command and the cause.
- **Same machine, same HOME, for the unattended route.** The unattended local-link route runs
  both halves of one mint on the root's host, as the same user with the same HOME. The
  retained link lives under the minting process's HOME.
- **Signature pending.** A fresh recipient of an invite that pins a self-custodial agent
  issuer stops before membership when it has no installed chain and no accessible local
  issuer exchange. That holds whether or not the invite carries `for_human`, so it covers a
  chained `no_human` issuer too.
  - aw keeps the key, the pending invite selection and any prepared request. The stop can
    come before any request is created. No membership is submitted.
  - On 1.36.59 it exits 1 with `error.code` `native_agent_signature_pending` (aweb
    `802f1674`; pending verification of the published final binary at the cut SHA).
  - aw 1.36.58 takes the same stop, but exits 1 with the generic `error.code` `error`, which
    doesn't identify this state.

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
    the Desktop shows the `did:aw`. `parent {id}` is the chain's next link up from the
    instance, that is, the root.
  - `no_human` → `none`.
  - Anything else → `unknown`.
  - `parent` is null when there is no verified chain.
- **Carry-forward:** a non-zero exit, a timeout, unparseable output or `unavailable` carries
  the previous value forward, or `unknown` if there is none. An answer aw gave replaces the
  previous value.

**C2, the root report in `oats aweb setup --check-only --json`.**
- **Shape:** `roots[]`, one
  `{label, home, attribution: {outcome, humanId|null, reason|null}, warnings: [string]}` per
  roots-map entry. `warnings` carries the aw-version note and C3's warning, and is empty
  otherwise.
- **The read:** P5 with `--identity-home <root>/.aw`.
- **A failed read** gives `unavailable` with its reason.
- **Old aw:** a root that reads `nearest_human` on an aw below 1.36.59 gets a note that
  spawning from it needs 1.36.59.

**C3, the adopted-lineage warning.**
- **The record:** the provider keeps, in its own state, each root's last *verified*
  `nearest_human` observation (the human and when it was seen), keyed by the root's identity
  and key, not by its label. A later `unknown` or `no_human` doesn't erase it. Only a new
  `nearest_human` replaces it. So the warning shows at every spawn and in every check-only
  while the chain stays missing, not only at the first read.
- **When it warns:** a root with that record now reads `unknown` or `no_human`, whatever the
  reason. Examples are `legacy_no_chain` after a restore from a
  backup taken before adoption, and `revoked` or `root_replaced`.
- **How:** it warns at spawn and in check-only (C2's `warnings`), naming the root and aw's
  reason.
- `unavailable` never triggers it, and the record is kept.
- It never refuses. A stale copied home is never a reason to adopt again.

**Signature pending.**
- A mint stopped as signature pending is left for the operator. Retiring it would delete the
  kept key.
- PR a recognises it by `native_agent_signature_pending`.
- The spawn fails as a failed mint does today. When the kernel's compensation runs the
  provider's retire hook, the hook answers `meta: {retired: false, reason: "signature-pending"}`.
  That is an incomplete cleanup, so the kernel keeps the home, marked
  `.oats-rollback-incomplete.json` (the existing rule in [capabilities](../capabilities.md)).
  No kernel or hook-contract change is involved.
- The hook answers `signature-pending` only while aw still holds the pending mint: the exact
  home, key and pending selection, including any prepared request. Each `oats retire` retry
  runs the hook again. Once aw settles the mint either way, the hook answers what is true and
  a plain retry clears the home. `--force` is not the route.
- Nothing remints into that home or compensates it away while it is pending.
- On an aw without the code (1.36.58, or a cut SHA that lacks it), a signature-pending stop
  can only come from a chained issuer. So PR a keeps a home whose mint failed after aw wrote
  a key only when the mint's issuing root isn't genuinely chainless, by P5's read or by C3's
  record. It never parses prose. A mint from a chainless root keeps today's behaviour, where
  retire settles the recorded mint, so a deployment that doesn't adopt changes in nothing.
- OATS never retries or remints automatically. An explicit operator recovery keeps the exact
  original home, key, token and selection.

**Reading aw's refusals** (aweb's `docs/cli-integration-contract.md` at `e6e9f099c5`).
- PR a branches only on the exit status and the structured fields: `error.code`,
  `error.http_status` and `error.reason`.
- `error.message` is for display only. A direct ID-certificate refusal carries a bare reason
  there, but commands may wrap it, so no machine behaviour keys on it.
- A command may wrap an HTTP refusal under its own code and keep `http_status` and `reason`.
  For example, `aw init --join-from` reports a refused invite as `invite_not_created`, and a
  direct `aw team invite` reports it as `http_error`.
- Tests assert the fields the actual command returns.

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
  another machine, mint a new remote root away from the issuing root.
- The rule (aweb, at `d8d0bfa1e7`, tested against aw 1.36.58 and the 1.36.59 candidate):
  - A new unattended remote root can't join through an invite from a self-custodial chained
    inviter, whether that inviter reads `nearest_human` or `no_human`, on either aw version.
    That holds before adoption as well as after. aw stops it as signature pending (§3).
  - Only a genuinely chainless inviter (`unknown` / `legacy_no_chain`) gives an invite a new
    remote root can join directly, and that root can be adopted on its own later.
  - With a chained inviter, the supported route is aw's cross-machine file exchange. The
    inviting root agent signs the remote root as its child, with an operator moving the files
    and no person signature. The remote root then belongs to that lineage and can't be
    adopted separately.
  - **Connect** has the inviting root on this host. It reads that root with P5 before
    minting the invite, and refuses a chained inviter unless the operator chose the file
    exchange. An `unavailable` read falls back to C3's record, or with none proceeds with a
    warning.
  - **`setup --join`** with only a token can't read the inviter. aw enforces the rule at
    accept, and OATS keeps the pending home (§4 "Signature pending").
  - Out of scope for this rule: an identity that already has a chain joining a team, and an
    issuer in host-managed custody.

## 5. Gates

- **G1, aw.** Nothing merges until aw 1.36.59 final is published and PR a's real-binary
  tests pass against the final binary at the cut SHA. Those tests run P3 and same-machine P4
  with their actual argv. They assert that the child's installed leaf binds the retained
  child key and the exact parent, that it verifies to the person, and that P4 without
  `--parent` from a chainless root still joins.
  - Development and CI may use `1.36.59-rc.3`, pinned by integrity.
  - `tested` never points at an RC.
- **G2, the run.** aweb's Cloud journey case (`cloud-journey-case-acxy7-v1`; original
  case-text hash `85196827b2b0`) runs on a scratch hosted team with a test person, never on
  a live team or a real person's identities.
  - Its first green run is the evidence, recorded with the actual Cloud head, the aw cut SHA
    and a verdict per step. The agreed record (v3) is written from it.
  - Its eight steps:
    1. Before adoption, R mints an early child E.
    2. The person adopts R through the dashboard's invitation, upload and approval, and
       download, with P1 and P2 run in R. R then reads `nearest_human`.
    3. R mints a child C unattended. C verifies to the person, and its chain ends in R then
       C.
    4. A grandchild G is minted unattended. Its chain ends in R then G.
    5. E is unchanged: same ID, key and membership certificate, still `unknown`.
    6. A control child K, minted from an unadopted root R0, matches C in alias, address,
       roster and workspace form. Verified mail and chat flow both ways between C and K.
    7. Revocation, as changed with both sides' agreement from the original "a team admin
       removes R's membership in the dashboard", which the released Cloud lacks (§6):
       - P6 runs against the scratch hosted team and R's exact team certificate.
       - A surviving child reads fresh registry membership and confirms R is absent.
       - The signed-in person reloads Agents and sees the surviving child and R's absence.
       - R's next `aw init --join-from` exits nonzero with `error.code`
         `invite_not_created`, `http_status` 401 and `reason` `certificate_revoked`
         (aw init.go:434-442).
       - The surviving members' certificates, mail and chat history are unchanged.
       - The paired runtime evidence includes P6 run with a fresh dashboard-issued,
         same-team owner or admin setup key, once Cloud's restoration is composed (§6).
    8. Clean-up: scratch memberships removed, scratch identities revoked, receipts checked.
- **G3, Cloud.** Production Cloud (0.8.80, `15591632`, read from its health endpoint on
  2026-11-21) already has the person's three adoption steps. Adoption on hosted teams still
  waits for aweb's release decision on the Cloud release it pairs with aw 1.36.59, made on
  G2's browser evidence. aweb names that version.

## 6. Revocation

- There is no per-root undo of an adoption.
- The control is removing the root's team membership. The way on is a new root with a new
  key.
- Removing the membership leaves the other members' memberships, mail and history
  unchanged.
- The person can revoke their whole ID, which ends everything under them. OATS neither does
  nor tests that.

**How the membership is removed on a hosted team** (decided by aweb's product owner,
2026-11-21, relayed by aweb's maintainers in their mail `c05ca697`):
- The paired Cloud release keeps the existing hosted CLI route, P6. The person who runs it
  is the team's current owner or team admin, using their team's unexpired dashboard setup
  key, with the existing team and person checks.
- This restores the setup key's authority on that route, which production (`15591632`)
  already gives. Until aweb's maintainers name the restoring SHA and the user-path evidence
  exists, this is a release commitment, not shipped behaviour.
- There is no dashboard membership-only Remove for a team-only root. Archive and Replace
  remain for permanent agents.
- The principle: no user path is harder than production, and extra human-assurance security
  is opt-in.
- Removing the membership affects that team and the root's ability to mint there. The
  signed adoption and identity ancestry stay in place. This is not an undo of adoption.

**Current behaviour: the person runs P6.** No agent holds or uses the person's owner or
admin key (principle 2). The ruling above restores a credential's server authority; it
grants no exception to principle 2.
- For the OATS deployment owner's deployments, the person-run P6 step is pending their word,
  because their recorded rule is that agents run every command. PR b's revocation text waits
  on it.

**OPEN R: whether to allow delegation later.** An agent running P6 with an owner key the
person delegates would need a separate ruling.

Principle 2 forbids the second unless both OATS owners, aweb's product owner and the OATS
deployment owner, rule otherwise. Principle 2 binds every OATS deployment, so neither side
changes it alone.

Once that word is in, PR b documents the person-run P6 with the setup key, and no session
plumbing.

## 7. Ownership

| Area | Owner | Approves changes |
|---|---|---|
| aw primitives P1 to P6, codes, the cut SHA | aweb's maintainers | aweb's maintainers |
| Cloud's person steps and the paired Cloud release | aweb's Cloud maintainers | aweb's maintainers |
| The journey case and its verdicts (G2) | aweb's Cloud maintainers | both sides; any change to the case's text comes to OATS first |
| C1 to C3, the mint flows, the floor (oats-aweb PR a) | the OATS deployment owner's side builds it | the OATS deployment owner's side, then the OATS maintainers at the exact head |
| Docs and release notes (PR b) | the OATS deployment owner's side | both |
| This record | the OATS maintainers | both sides, on its PR |

## 8. Open items

- **A, B: answered** by aweb at `d8d0bfa1e7`, with B tested against aw 1.36.58 and the
  1.36.59 candidate (§2 P4, §3, §4 "Where OATS mints").
- **C.** `native_agent_signature_pending` is implemented on aweb `802f1674` (exit 1, recovery
  state kept, no membership). Its inclusion is pending verification of the published final
  binary at the cut SHA.
- **R.** Whether an agent may ever run P6 with a delegated owner key (§6). Today only the
  person runs it. (both OATS owners: aweb's product owner and the OATS deployment owner)
