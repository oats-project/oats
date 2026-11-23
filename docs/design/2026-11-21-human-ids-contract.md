# Human IDs: the contract between aweb's primitives and OATS

**Status:** r3, 2026-11-23. r2 is in force (oats#2059, approved by both sides). r3 corrects
it against the shipped releases and comes into force when aweb's maintainers and the OATS
deployment owner's side approve its PR. Items marked **OPEN** are undecided and mustn't be
built on.

**What it is.** aweb lets a person adopt an agent (a "root") so that every agent the root
creates afterwards carries a verified chain back to that person. OATS consumes this:
- it creates agents from a root, so new instances inherit the chain;
- it reads each instance's verified human and shows it as **Owning human**.

This record is the one place that says which aweb primitives OATS relies on, exactly how
OATS calls them, what each side owns, and the gates before anything ships. When aw changes
one of these primitives, or OATS changes how it uses one, this record changes first.

**Sources.**
- aweb: `b9c015732416`, the cut SHA (`docs/id-certificates.md`, `docs/identity.md`,
  `docs/cli-integration-contract.md`, `docs/cli-command-reference.md`). r2 read them, and
  aweb's primitive list, at `d8d0bfa1e7`; all four docs have changed since.
- Cloud: the person's dashboard steps first read at `15591632` (0.8.80) and main `234882b7`.
  r3 reads adoption and removal at **0.8.81, `4b5b7820`**, live since 2026-11-23.
- OATS: the integration plan v1.7 (`0d8b9e1159c6`), read with oats-aweb main `717d0fd`.

Every behaviour below is pinned at **the 1.36.59 cut SHA**: aweb `b9c015732416`, tag
`aw-v1.36.59`, npm `latest` since 2026-11-23. Other commit ids are background only.

## 1. Principles both sides keep

1. **Opt-in is the adoption itself.** A deployment whose roots nobody adopted needs no OATS
   setting, no config key and no new aw. Its spawns, starts and joins run as before. It sees
   the reads (C1, C2), connect's earlier refusal from a chained root (§4), and more mints kept
   for a person to settle (§4 "Signature pending").
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
4. **Attribution grants no access.** No OATS permission or access decision depends on the
   human. The verdict is read and shown, and informs the P4 parent route, connect's
   chained-inviter refusal, and pending-mint classification and retention (§4).
5. **aw's answer is the truth.** OATS copies aw's verdicts and refusals as aw gives them. It
   reads them only from aw's `--json` fields (§5), never from prose.

## 2. Primitives OATS uses

| # | Primitive (aw at the cut SHA) | Who runs it, where | OATS's use |
|---|---|---|---|
| P1 | `aw --identity-home <root>/.aw id parent request --domain D --parent H --invitation-id I --out request.json` | An agent, in the root's home, during adoption, with the root's own key | Documented step (PR b). D, H and I are copied from the dashboard's invitation, never derived. Writes and retains the request. Only a genuinely chainless root, or one parented directly by its namespace, can be adopted. A root with person ancestry or an agent parent can't. |
| P2 | `aw --identity-home <root>/.aw id parent import response.json --domain D` | An agent, in the root's home | Documented step (PR b). Verifies and installs the exact signed response. If these steps become machine-consumed, they add `--json` and follow §4's refusal rules. |
| P3 | `aw init --join-from=<root> --join-team=<T> --name=<alias> --json --do-not-touch-agents-md` (oats-aweb `5849637f`, `bin/oats-aweb.mjs:3031`), `<root>` being the root's workspace directory | The provider's spawn hook, on the root's host, as the deployment's user | Primary identity mint for newly minted LOCAL instances (unchanged). After adoption, aw signs the child under the root through the mint's same-machine hosted issuer link. |
| P4 | `aw team invite --team-id <T> --json` with the root as the selected identity, then `aw --identity-home <home>/.aweb-identity-<label> id team accept-invite --token-stdin --name <alias> --local [--parent <root>/.aw] --json`, the same token on stdin | The provider, joining an instance to an extra team; `<home>/.aweb-identity-<label>` is fresh, or the same retained target on retry | Joined-team identities. aweb confirms `--parent` as the supported, unattended route (native agent-to-agent exchange through a token-scoped creator link, same user and HOME). The child proves the invite's human before membership is submitted. `nearest_human` selects the explicit `--parent` path. That is decided by one bounded P5 read of `<root>/.aw` at join time, falling back to C3's record when the read is `unavailable` or fails. Otherwise `--parent` is omitted: a genuinely chainless root's join is unchanged, and a chained `no_human` root's same-machine join completes through the retained mint link without it. An adopted root on an aw below 1.36.59 stops before minting any invite. That stop is an oats-aweb diagnostic with an OATS-owned code, and a README line names the fix. |
| P5 | `aw --identity-home <home>/.aw who --json`, plus `--registry <origin>` when the deployment sets a registry (§4 "Registry") | The provider | C1 and C2 (§4). |
| P6 | `aw id team remove-member --namespace D --team NAME --cert-id C [--aweb-url URL] --json` (or `--member`), with a team-scoped owner/admin API key from `--api-key` or `AWEB_API_KEY`, calling `/api/v1/teams/{team_id}/agents/remove-member` | The person, from a terminal (§6) | Membership removal (§6). The documented person-run CLI uses the setup key. The server also accepts signed-in person authority for the same route. A person's signing key is a separate credential. |

Person's steps in Cloud (dashboard, signed in, the root's team selected, from the root's
Chat or Messages pane):
1. **Adopt** opens the dialog. **Adopt agent** creates invitation I and shows the request
   command with I, H and D.
2. **Upload request.json**, then **Approve and prepare response**.
3. **Download response.json**.

Preconditions:
- the person has claimed a human ID;
- they have an active account and current membership of the root's team. Both are required
  in every case below;
- the root's team has a live owning organisation. Without one nobody can adopt (403
  `agent_control_organization_unavailable`, checked before membership and creator);
- they hold the authority to adopt (Cloud `4b5b7820`, `services/adoption_authority.py`,
  `human_agent_adoptions.py`):
  - Cloud's recorded creator of the root (`cloud_workspace_metadata.owner_user_id`) is
    **exclusive** while their account is active and they are still a member of the team.
    Anyone else, a team admin or organisation owner included, is refused;
  - otherwise (none recorded, or they are gone), a team admin or an owning-organisation
    owner/admin. An editor isn't enough;
- Cloud has workspace metadata for the root, exactly one live workspace, and the root isn't
  itself a verified human. Otherwise adoption answers 404.
- The adopting person's namespace verifies. A global root already enrolled in the registry's ID
  tree is under the person's own home domain (else 409 `registered_adoption_domain_mismatch`).
- The invitation hasn't expired: 24 hours by default, 7 days at most.

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
    failure. With `--registry`, a failed DNS lookup or a contradicting DNS record is a command
    failure. OATS treats a failed read as no answer, like `unavailable`.
  - A `did:key` home that presents no chain reads `unknown` / `legacy_no_chain`. A chain
    with missing or stale evidence reads `unavailable`. A rejected chain reads `unknown` with
    its own reason.
  - aw 1.36.58 has the same fields except `evidence`.
- **Two kinds of unadopted hosted root:**
  - **Fresh:** from aw 1.36.53 (aweb `3a88ea92d0`), a successful plain-key bootstrap on a
    supporting hosted namespace gives the root its namespace's chain with no person, and it
    reads `no_human`. This is the normal state of a fresh hosted deployment.
  - **Legacy chainless:** a local root made with aw 1.36.51 or earlier, which presents no
    chain, reads `unknown` / `legacy_no_chain`.
  - P5 is aw's local answer. Cloud decides on its own records, and an older install's can
    differ from a fresh root's (another creator, none, or no workspace metadata). Proof on a
    fresh root isn't proof for an older one.
- **Adoption** is once per root ID: a global root that rotates its key can't be adopted again. P1 and P2 cover two cases:
  - first issuance to a genuinely chainless root;
  - one-time replacement of a chain parented directly by the namespace, under the first
    person.
  - Cloud's browser authority and eligibility checks gate either case. Cloud 0.8.80 took
    only roots without a certificate, local or global; 0.8.81 also takes a root whose one
    certificate is parented by the namespace and verifies with no person.
  - A local `did:key` root adopts only through the browser-file flow above. An
    agent-submitted request is refused with `global_agent_required`.
  - One adoption covers one subject; a local subject is its key. A host with several roots needs one adoption per root.
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
  - On 1.36.59 it exits 1 with `error.code` `native_agent_signature_pending` (in source at
    the cut SHA).
  - aw 1.36.58 takes the same stop, but exits 1 with the generic `error.code` `error`, which
    doesn't identify this state.

## 4. OATS's side (oats-aweb PR a; docs PR b)

**C1, the attribution read.**
- **When:** at spawn after the mint, and at each start (the launch hook's real pass only,
  never under `OATS_LAUNCH_PREVIEW=1`, and never for a global grant seat). Only when the
  kernel lists the `spawn-attribution` feature; otherwise nothing is read or written.
- **The read:** P5, bounded at 5 s, run once, with no retry. It never refuses and never
  delays beyond the bound.
- **What it writes:** the kernel's existing `attribution` in the served identity:
  `{mode, human: {id, label}|null, parent: {id}|null}`.
- **Mapping from aw's `outcome`:**
  - `nearest_human` → `human`. `label` is `human_id`, because aw gives no display name, so
    the Desktop shows the `did:aw`. `parent {id}` is the chain's next link up from the
    instance, that is, the root.
  - `no_human` → `none`, with `parent` null even when the chain is verified.
  - Anything else → `unknown`.
  - `parent` is set only with `human`.
- **Carry-forward:** a non-zero exit, a timeout, unparseable output or `unavailable` carries
  the previous value forward, or `unknown` if there is none. An answer aw gave replaces the
  previous value.

**C2, the root report in `oats aweb setup --check-only --json`.**
- **Shape:** `roots[]`, one
  `{label, team, home, attribution: {outcome, humanId|null, reason|null}, warnings: [string]}`
  per roots-map entry, and one for the shared `root` (`team` null). `warnings` carries the aw-version note and C3's warning, and is empty
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
- On an aw below 1.36.59, which lacks the code, a signature-pending stop can only come from a
  chained issuer. PR a classifies a failed mint as one only when aw exited 1 with
  `error.code` `error`, the key was written, and the issuing root is chained by P5's read or
  by C3's record. It never parses prose. This rule only classifies: an unknown or unreadable
  outcome can still keep the home (`mint-outcome-unknown`, below). A mint from a chainless
  root settles as before.
- OATS never retries or remints automatically. An explicit operator recovery keeps the exact
  original home, key, token and selection.
- Any other mint OATS can't prove settled keeps the home too, with
  `meta: {retired: false, reason: "mint-outcome-unknown"}` and exit 1: another key,
  selection or request, or aw files or a record that can't be read. No retire answer lets
  the kernel remove a home while aw's pending files are in it, except the settle of a mint
  from a genuinely chainless root, and the older-provider proof below.
- A home from an older provider, whose mint record names no issuing key, is settled only when
  aw's own record of the accept proves no signature can be pending, and kept otherwise.
- aw 1.36.59 has `aw id status --json`, whose `pending_hosted_accept` and `mint_complete` report
  local markers, not live standing. Neither 1.36.58 nor 1.36.59 has a command that abandons a
  pending accept or fully reconciles one.
- Setup refuses to create, accept or mint into a root inside an instance home of its own
  deployment (`E_ROOT_INSIDE_INSTANCE_HOME`).

**What a retire leaves** (oats-aweb `cf628b7d`). An exit 0 removes the home's credential entries.
A nonzero exit, or one that skipped its cleanup, holds them out of aw's reach for the next
retire. Entries a setting names and homes holding a pending mint stay in place. The exact
rules are oats-aweb's README, "What retire does with the key material".

**Signup resume.** aw 1.36.59 keeps an attempted hosted signup whose outcome is unknown in the
root's `.aw` (`signup-recovery.json`), and the same `aw init` resumes it. `oats aweb setup`
re-runs that command, reading only whether the journal is there.

**Registry.** An administrator's explicit registry setting in `oats-local.yaml` decides. OATS
takes a private-address registry only from it, never from aw's files (aw's
`registry_operator_origin` included), and passes it to aw by name. Every P5 call passes it
explicitly, as `--registry <origin>`; with no setting, the argv has no flag. oats-aweb passes
it from `5849637f` (oats-aweb#326).
- Publish the namespace authority in DNS. For a registry at a non-public address, set the
  registry origin in `oats-local.yaml`. If DNS also names a non-default registry, the two must
  agree.

**Reading aw's refusals** (aweb's `docs/cli-integration-contract.md` at `b9c015732`).
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
- `tested` is the 1.36.59 final (oats-aweb `5849637f`).
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
    minting the invite, and refuses a chained inviter with `E_CONNECT_CHAINED_INVITER`. It
    doesn't run the file exchange; an operator does that by hand. An `unavailable` or failed read falls back to C3's record, or with none proceeds with a
    warning.
  - **`setup --join`** with only a token can't read the inviter. aw enforces the rule at
    accept, and OATS keeps the pending home (§4 "Signature pending").
  - Because a fresh hosted root reads `no_human` (§3), the refusal and the file exchange are
    the **normal case** for connect on a fresh hosted deployment, not only after adoption.
    Such a connect already failed at the host's accept on 1.36.58 and 1.36.59, so this needs
    no aw version gate.
  - Out of scope for this rule: an identity that already has a chain joining a team, and an
    issuer in host-managed custody.

## 5. Gates

- **G1, aw.** Nothing merges until aw 1.36.59 final is published and PR a's real-binary
  tests pass against the final binary at the cut SHA. Those tests run P3 and same-machine P4
  with their actual argv. They assert that the child's installed leaf binds the retained
  child key and the exact parent, that it verifies to the person, and that P4 without
  `--parent` from a chainless root still joins.
  - `tested` never points at an RC.
  - **Status: compatibility green, adopted evidence pending.** PR a's CI is green on the
    published 1.36.59 at its pinned integrity (run 45152178535, `d28f2df7`). It parses P4's
    `--parent` argv on the real binary, against an unadopted parent. The adopted assertions
    above (the child's leaf, its parent and its person, for P3 and P4) run only on a fake aw.
    aw's own coverage at the cut (an in-process native child exchange, and a BYOT join from a
    root under a person) isn't a published-binary proof for a hosted adopted root either.
    So PR a was merged before G1 was met; both OATS sides approved it in error.
  - **What r3 changes:** the adopted assertions on the real binary, against an adopted root,
    must be green before hosted adoption is opened, along with G2. PR a's merge stands. An
    oats-aweb release may carry it only while its notes say adoption isn't open.
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
       - P6 runs against the scratch hosted team and R's exact team certificate, by
         `--cert-id`. Its exit 0 alone isn't proof of revocation.
       - A surviving child **with its own team certificate** runs `aw id team members` and
         confirms R is absent: exit 0, its own `certificate_id` listed, R's not. A grant home
         reads a roster with no certificate ids, so its answer proves nothing.
       - The signed-in person reloads Agents and sees the surviving child and R's absence.
       - R's next `aw init --join-from` exits nonzero with `error.code`
         `invite_not_created`, `http_status` 401 and `reason` `certificate_revoked`.
       - The surviving members' certificates, mail and chat history are unchanged.
       - The paired runtime evidence includes P6 run with a fresh dashboard-issued,
         same-team setup key of a person P6 accepts (§6).
    8. Clean-up: scratch memberships removed, scratch identities revoked, receipts checked.
  - The record names the aw version per root and step, and which kind of root (§3) each step
    covers. The case covers chainless roots; their proof is due with its run, and a fresh
    `no_human` root's with `aweb-adjb.1`.
  - **Not met.** Step 7's browser proof isn't in Cloud 0.8.81 (a version with P6's
    setup key is at Cloud `f9294da41`, not run there); aweb plans it for a later release and
    sends the landed SHA. The fresh-root receipt is aweb's `aweb-adjb.1`.
  - A run outside aweb's journey, on a scratch hosted team with a test person and all eight
    steps, needs aweb's product owner's word first. It counts as a receipt beside the
    journey's, not as G2, and opens nothing.
- **G3, Cloud.** The Cloud release paired with aw 1.36.59 is **0.8.81** (`4b5b7820`, read from
  its health endpoint on 2026-11-23). Cloud 0.8.81 itself offers the dashboard
  steps to eligible roots. **OATS's rollout of hosted-root adoption stays closed** until aweb's
  release decision, made on G2's evidence, and G1's adopted evidence. Opening it for only some roots
  would be a change to this record, approved by all sides.

## 6. Revocation

- There is no per-root undo of an adoption: it stays once per root ID.
- For a local `did:key` root, which is what §3's browser-file flow adopts, the control is removing the root's
  team membership. The way on is a new root with a new key.
- An adopted global (`did:aw`) root also has a certificate revoke in Cloud (0.8.80 and
  0.8.81). It is a control, not an undo. OATS doesn't use it.
- Removing the membership leaves the other members' memberships, mail and history
  unchanged.
- The person can revoke their whole ID, which ends the ID-tree authority of everything under
  them. Team memberships, addresses and did:key history are separate. OATS neither does nor
  tests that.

**How the membership is removed on a hosted team** (decided by aweb's product owner,
2026-11-21, relayed by aweb's maintainers in their mail `c05ca697`):
- The paired Cloud release keeps the existing hosted CLI route, P6. The person who runs it
  is a current team admin, or an owning-organisation owner/admin who is in the team, using
  their team's unexpired dashboard setup key, with the existing team and person checks.
- The setup key's authority on that route is restored at Cloud `939528ba9` (merged
  `aa8f344a`), and is in 0.8.81. The key is bound to one team and one person. Minting it
  needs only editor; authority is checked when P6 runs, so an editor can hold a key that P6
  refuses. It lasts 24 hours unused and 15 minutes after its first successful `aw init`, and a
  new one for the same person and team revokes it (aweb's report at `aa8f344a`). The
  user-path evidence is G2 step 7, not yet recorded.
- There is no dashboard membership-only Remove for a team-only root. Archive and Replace
  remain for eligible nonlocal agents (`packages/dashboard/src/pages/AgentDetailPage.tsx`).
- The principle: no user path is harder than production, and extra human-assurance security
  is opt-in.
- Removing the membership affects that team and the root's ability to mint there. The
  signed adoption and identity ancestry stay in place. This is not an undo of adoption.

**Current behaviour: the person runs P6.** No agent holds or uses the person's owner or
admin key (principle 2). The ruling above restores a credential's server authority; it
grants no exception to principle 2.
- The OATS deployment owner agreed to the person-run P6 step on 2026-11-21 (relayed by their
  side in mails `c0a90d92` and `348d4f53`; the owner gave it directly in that side's session).
- Use `--cert-id`, with the exact certificate of the root's membership in that team. A local
  root has no stored address, which is what `--member` takes.
- From a clean terminal (no aw workspace), pass `--aweb-url` as well.

**OPEN R: whether to allow delegation later.** An agent running P6 with an owner key the
person delegates would need a separate ruling.

Principle 2 forbids the second unless both OATS owners, aweb's product owner and the OATS
deployment owner, rule otherwise. Principle 2 binds every OATS deployment, so neither side
changes it alone.

PR b documents the person-run P6 with the setup key, and no session plumbing.

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
- **C: answered.** `native_agent_signature_pending` is in the 1.36.59 final (§3).
- **G2** (§5): step 7's landed SHA, its receipts, and the fresh-root receipt.
- **`aweb-adpw`:** an aw command that fully reconciles or abandons a pending accept, in a later aw
  release. **`aweb-adql`:** the dashboard showing the request's fingerprint. Neither exists
  yet; don't build on them.
- **R.** Whether an agent may ever run P6 with a delegated owner key (§6). Today only the
  person runs it. (both OATS owners: aweb's product owner and the OATS deployment owner)
