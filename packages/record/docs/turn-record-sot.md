# Turn record — Source of Truth

Status: **v1 draft — proposed normative contract, not yet shipped behavior**.

This document specifies `turn.jsonl` v1: the format, store layout, and
synchronization contract for the turn record, and the normative projection of
aweb mail and chat messages into it. It is the contract implemented by the
record tools (`capture`, `recall`, and the experimental tools over them); this
package (`@awebai/turn-record`, in the oats repo) is the reference
implementation, and the spec lives beside it on purpose: the record spans
agent sessions from supported harnesses, and the aweb server is one projected
source, not the record's home. The architecture decision it implements is
`2026-08-18-turn-record-and-tools.md` in the strategy repo
(github.com/awebai/strategy); the identity and messaging contracts it builds
on are `docs/awid-sot.md` and `docs/aweb-sot.md` in the aweb repo
(github.com/awebai/aweb), which remain authoritative for signing and
message semantics.

Conformance vectors live in [`test/vectors/`](../test/vectors/) with a
dependency-free validator (`node validate.mjs`). A behavior is part of this
contract only if a vector pins it or this document states it normatively.

---

## Principles

1. **One sacred artifact.** The turn format and its sync contract are the only
   things every tool must agree on. Everything else — indexes, caches,
   projections, conventions — is derived and rebuildable.
2. **Turns are immutable and content-addressed.** A turn's identity is the hash
   of its canonical bytes. There is no update operation; correction and
   deletion are new turns (tombstones).
3. **Writers own streams.** Every turn is appended to exactly one journal, and
   only that journal's owner ever appends to it. This makes replication
   conflict-free by construction, not by resolution.
4. **Sync is set union.** Replicas merge by unioning streams and deduplicating
   by turn id. Global order does not exist and is not needed; causal order
   comes from `thread` and `links`.
5. **Fidelity is declared, never implied.** A projected turn says what its
   source was and what loss class the projection has.
6. **Signatures travel with the data.** Turns carry the original source
   signatures verbatim where they exist, and may carry a producer envelope
   signature. Verification happens at read time; transport is untrusted.
7. **Mutable state never enters a turn.** Delivery state (read, acked),
   presence, and other receiver-local facts are not part of any turn's
   canonical core — they would make identical content hash differently on
   different machines.

---

## Canonical JSON

Turn hashing and signing reuse the existing cross-language canonicalization
contract from awid message signing (`awid/src/awid/signing.py`
`canonical_json_bytes`, Go `CanonicalJSONValue`):

- UTF-8 bytes of the JSON serialization;
- object keys sorted lexicographically by Unicode code point;
- separators `,` and `:` with no whitespace;
- `ensure_ascii=false` — non-ASCII characters are emitted as themselves;
- **no HTML escaping** — `<`, `>`, `&` are emitted literally (the known Go
  `json.Marshal` trap; see the comment on `CanonicalJSONValue`).

**Number restriction (normative):** inside a turn's canonical core, numbers
MUST be integers with absolute value below 2^53. Fractional and exponent
literals are forbidden in the core because float serialization is not
canonical across languages. Anything non-integral MUST be carried as a string
or moved to a content-addressed object.

## The turn

One turn is one JSON object. On disk it is one line of a journal file.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `v` | int | yes | format version; this document defines `1` |
| `id` | string | yes on disk | content address: `t1:<sha256 hex of canonical core>` |
| `ts` | string | yes | RFC 3339 UTC (`Z` suffix); fractional seconds permitted; projections preserve source precision |
| `from` | string | yes | producing/speaking name: address, alias, `did:key`, or `did:aw` |
| `to` | string \| string[] | no | addressed recipients, same name forms |
| `thread` | string | no | conversation reference, namespaced (see [Threads](#threads)) |
| `kind` | string | yes | source class (see [Kinds](#kinds)) |
| `body` | object | yes | content; may be `{}`; large/binary content by reference: `{"ref":"sha256:<hex>","media_type":...,"bytes":<int>}` |
| `links` | array | no | `{"rel": <string>, "ref": <turn id or "sha256:<hex>">}` entries |
| `signature` | string | no | source signature, verbatim (e.g. aweb message signature) |
| `signed_payload` | string | no | source canonical signed payload, **byte-verbatim** |
| `provenance` | object | yes | see [Provenance](#provenance) |
| `sig` | object | no | producer envelope signature: `{"by":"did:key:...","sig":"<base64>"}` |

**Canonical core** = the turn object minus `id` and `sig`, serialized as
canonical JSON.

- `id` = `"t1:" + sha256hex(canonical core bytes)`. Lowercase hex.
- `sig.sig` = Ed25519 signature over the same canonical core bytes, base64
  (RFC 4648) without padding; verifiers accept both the standard and the
  URL-safe alphabet, exactly as awid message verification does.
- `sig.by` is a `did:key`; verification resolves the public key from the DID
  as in awid.

Because `id` excludes `sig`, co-signing does not change identity: the same
content is the same turn whether or not its producer signed the envelope.
When id-equal duplicates differ in `sig`, replicas prefer a copy with a valid
`sig` over one without; further attestation is expressed as separate turns,
not by mutating this one.

**Determinism (normative):** a projection MUST be a pure function of its
source data. Two machines projecting the same source row MUST produce
byte-identical canonical cores, hence the same `id`, so union dedupes them.
This is why nothing machine-local (paths, host names, wall-clock at projection
time) may appear in a projected turn's core.

**Unknown fields are preserved.** Readers and re-serializers MUST carry
unknown top-level and nested fields through untouched (they are covered by
`id`). Validators reject a turn only when its `id` or signatures fail, never
because a field is unrecognized. Lines whose `v` is greater than 1 are
preserved verbatim and not interpreted.

### Kinds

v1 defines: `mail`, `chat`, `session`, `note`, `tombstone`.
Reserved for later specification: `attestation`, `lesson`.

**`session` turns are one-per-native-event** (corrected 2026-08-19, Juan:
sessions are turns like everything else, never opaque file snapshots).
Each native transcript record — a Claude Code JSONL line, a pi record, a
Codex record — is one turn:

    kind: "session"
    thread: "<source>:session:<id>"
    body: { line: "<the native record, verbatim text>" }
    ts: the event's own timestamp (carried forward over unstamped
        bookkeeping lines)
    provenance: { source: cc|pi|codex, fidelity: "verbatim",
                  origin: { session_id, line: <line number> } }

The body is the exact bytes of the native line, so the original transcript
is reconstructible by concatenation, nothing is interpreted at storage
time, and capture appends each event exactly once as the session grows —
storage is linear in conversation size by construction. Session turns live
in one stream per session (`<owner>~<source>.<session-id>`), keeping
journals bounded by their conversation. An earlier whole-file-snapshot
encoding (content-addressed blobs referenced by meta-turns) is withdrawn:
it duplicated every prefix on every snapshot and put a file, not the turn,
at the center of the model.

### Threads

`thread` is a namespaced string: `<namespace>:<type>:<id>`.

- aweb conversations: `aweb:conv:<conversation_id>` (mail) and
  `aweb:conv:<session_id>` (chat) — both are UUIDs in the same server
  namespace.
- Captured runtime sessions: `cc:session:<session_id>` for Claude Code;
  other runtimes register their own namespace.

### Provenance

```json
{
  "source": "aweb-mail" | "aweb-chat" | "cc" | ...,
  "fidelity": "verbatim" | "projected" | "summary",
  "origin": { ...source-native identifiers... },
  "runtime": { "credential": "grant:<id>", ... }
}
```

- `source` and `fidelity` are required.
- **Fidelity classes:**
  - `verbatim` — the source bytes are preserved (inline or in the object
    store); nothing was interpreted.
  - `projected` — a structured, lossless field mapping; the round-trip back to
    the source fields is guaranteed and vector-tested.
  - `summary` — lossy by design; the reader is told so.
- `origin` carries source-native identifiers needed for round-trip that are
  not already inside `signed_payload`. **Do not duplicate** into `origin` what
  is derivable from `signed_payload`; duplication invites divergence.
- `runtime` names the acting credential when a runtime produced the turn
  (grant attribution; see the aweb server provenance work).

## Store layout

```
<record-root>/
  streams/<stream-id>/journal.jsonl     replicated, append-only, owner-write
  objects/sha256/<hh>/<hex>             replicated, immutable, content-addressed
  index/                                derived, rebuildable, never replicated
```

- **stream-id** is a filesystem-safe name unique to one writer:
  `<owner>~<source>`, e.g. `did-aw-1abc...~mail`, `mac-a~cc`. The owner is the
  only party that ever appends to it. `~` is the separator because it cannot
  appear in aweb aliases or DID identifiers. Sources that are naturally
  per-life suffix the stream with the life's id, same shape: captured
  sessions as `<owner>~<source>.<session-id>`, and reader judgments as
  `<owner>~mind.<principal>` — one stream per followed life, written by
  that life's jiminy (`from: <jiminy-name>`).
- **journal.jsonl**: UTF-8, one JSON turn per line, each line terminated by
  `\n`. A truncated final line (missing newline or invalid JSON) is ignored by
  readers and repaired by the owner on its next append — this is the crash
  tolerance contract.
- **objects/** holds immutable blobs keyed by SHA-256 (two-hex-char fan-out).
  Turns reference them as `sha256:<hex>`.
- **index/** (SQLite metadata/FTS, later vectors) is cache. Deleting it loses
  nothing; any replica can rebuild it from streams + objects.
- **Permissions.** The record holds conversations, so what the store creates
  is for its owner alone: directories with mode `0700` (the root, `streams/`
  and each stream, `objects/` and its fan-out, `index/`) and files with mode
  `0600` (journals, objects, quarantined copies, the index databases). The
  mode is given at creation and the store never changes the permissions of
  what already exists: a root, a directory or a file made beforehand keeps
  the permissions it has until its owner tightens them
  (`chmod -R go-rwx <record-root>`). One directory is outside the rule: a
  capture pass's lock creates a root that does not exist yet with the
  process's default mode. What is created below it is private as above.

## Synchronization contract

Any file-level replication mechanism (syncthing, rsync, git, an object relay)
is a valid transport, because the invariants below make merges mechanical.

1. **Owner-only append.** A replica never writes into a stream it does not
   own. Sync tools replicate `streams/` and `objects/`, never `index/`.
2. **Stream merge is prefix extension.** Two copies of the same journal must
   be related by prefix (append-only). Merged result = the longer copy. If
   neither is a prefix of the other, that is corruption or an ownership
   violation: quarantine both copies and surface an error; never merge
   silently, never last-writer-wins.
3. **Record merge is set union.** The effective record = union of turns across
   all streams, deduplicated by `id`. Duplicate ids across streams are normal
   (deterministic projections) and harmless.
4. **Tombstones dominate.** A turn is hidden from readers when a valid
   tombstone targets it (below), regardless of which replica or stream the
   tombstone arrived from.
5. **Verification at read time.** `signed_payload`/`signature` and `sig` are
   verified by consumers, per awid rules. Transport integrity is not assumed.

### Tombstones

A tombstone is itself a turn:

```json
{"v":1, "kind":"tombstone", "from":..., "ts":...,
 "links":[{"rel":"tombstones","ref":"t1:<target id>"}],
 "body":{"reason": "..."}, "provenance":{"source":..., "fidelity":"projected"}}
```

v1 authority rule (deliberately minimal): a tombstone is valid when its
`from` equals the target turn's `from`, or equals the record owner's identity
as configured for the store. Richer delegation is a later revision.

Effects: readers MUST hide the target turn and MUST exclude it from tool
output; indexes drop it on rebuild. The owner of the target's stream MAY
physically remove the body by compacting **its own** journal (rewriting its
own stream is permitted to the owner alone; other replicas converge by prefix
rule on the new journal only if the owner bumps the stream — in v1, owners
compact by writing a new stream `<stream-id>.<n>` and retiring the old one).

**Honest caveat (normative text, carried from the architecture decision):** an
offline replica physically retains bytes until it reconnects and receives the
tombstone. Deletion is eventual, and tools must not claim otherwise.

## Projection of aweb messages

This is the projection the conformance vectors prove. It covers the message
content contract: the fields listed below. Receiver-local delivery state
(read/acked flags, folder placement) is out of scope by principle 7.

### Signed mail

Input: a message row with `message_id`, `conversation_id`, `signature`,
`signed_payload` (canonical JSON string per awid `SIGNED_FIELDS`), and the
transport-echoed content fields.

```json
{
  "v": 1,
  "ts": "<signed_payload.timestamp>",
  "from": "<signed_payload.from>",
  "to": "<signed_payload.to>",
  "thread": "aweb:conv:<conversation_id>",
  "kind": "mail",
  "body": {"subject": "<signed_payload.subject>", "text": "<signed_payload.body>"},
  "signature": "<row.signature verbatim>",
  "signed_payload": "<row.signed_payload byte-verbatim>",
  "provenance": {
    "source": "aweb-mail",
    "fidelity": "projected",
    "origin": {"message_id": "<uuid>", "conversation_id": "<uuid>"}
  }
}
```

`id` is then computed over the canonical core as usual.

**Consistency rule (normative):** for a turn carrying `signed_payload`, the
turn's `ts`, `from`, `to`, `body.subject`, and `body.text` MUST equal the
corresponding `signed_payload` fields (`timestamp`, `from`, `to`, `subject`,
`body`). Validators reject on mismatch. The duplication exists only for
readability and indexing; `signed_payload` is authoritative.

**Round-trip (normative):** `unproject(project(row)) == row` for the field
set: `message_id`, `conversation_id`, `signature`, `signed_payload` (both
byte-identical), plus every field parsed from `signed_payload` (`from`,
`from_did`, `from_stable_id?`, `to`, `to_did`, `to_stable_id?`, `subject`,
`body`, `timestamp`, `message_id`, `conversation_id?`, `priority?`,
`reply_to?`, `wait_seconds?`, `hang_on?`, `sender_leaving?`) value-identical.
Verification status is derived at read time exactly as
`server/src/aweb/messaging/verification.py` does; it is never stored.

### Signed chat

Identical, with `kind: "chat"`, `provenance.source: "aweb-chat"`, and
`thread: "aweb:conv:<session_id>"`. Chat-only signed fields (`wait_seconds`,
`hang_on`, `sender_leaving`, `reply_to`) live inside `signed_payload` and are
recovered from it; they are not duplicated onto the turn.

### Legacy unsigned messages

Rows without `signature`/`signed_payload` project with the same shape minus
those two fields, and `origin` additionally carries the row-level fields that
signed rows recover from the payload: `from_did?`, `from_stable_id?`,
`to_did?`, `to_stable_id?`, `priority?`, `timestamp_source: "created_at"` when
`ts` was taken from the row's `created_at`. Their verification status derives
to `unverified`, matching server behavior.

## Conformance vectors

`test/vectors/` (in this package):

| File | Proves |
|---|---|
| `turn-id-v1.json` | canonical core bytes and `t1:` ids, including the unicode / HTML-character trap, unknown-field coverage, and envelope `sig` verification |
| `aweb-projection-v1.json` | the mail/chat/legacy projections above: row → expected turn (byte-exact core, exact id) → round-trip row equality, with real signatures (test seed `000102…1f`, the `docs/vectors/message-signing-v1.json` identity) |
| `journal-merge-v1.json` | union dedup by id, prefix rule (including the corruption case), tombstone dominance and the v1 authority rule |
| negatives (in each file) | id mismatch, invalid signature, signed-consistency violation, float in core |

`validate.mjs` (Node ≥ 18, no dependencies) re-derives everything
independently of the Python generator, so passing vectors is a two-language
agreement, the same discipline as `e2ee-v2-cross-language.json`. Run:

```bash
node test/vectors/validate.mjs
```

## Versioning

- `v` bumps only for changes that alter canonical bytes, id computation, or
  merge semantics. Additive fields do not bump `v` (unknown-field preservation
  covers them).
- A store may hold mixed versions; tools interpret the versions they know and
  preserve the rest.

## Deliberately deferred

- Tombstone delegation beyond the v1 owner/author rule.
- Encrypted turn bodies (`encrypted_v2` envelopes project today with body by
  reference and fidelity declared; a first-class ciphertext mode is a later
  revision).
- Entitlement-scoped partial replicas (the relay concern, not the format's).
- The `session` body schema (specified with `capture`, M1).
