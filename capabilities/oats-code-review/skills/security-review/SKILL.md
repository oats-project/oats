---
name: security-review
description: The reviewer's security pass. Read the change as an attacker would, across every trust boundary it touches (injection, paths, secrets, authz, crypto, agent instructions, CI, supply chain, web), and report only what is exploitable or a concrete hardening gap. Use in every adversarial review round, and alone when asked for a security review.
---

# Security review

Every input the process didn't create itself is hostile. Every boundary the change
crosses is a chance for an attacker. Rank by **exploitability**, not pattern count.

## Map the trust boundaries first
List what the change reads from outside (users, files, env, network, other processes,
config, CI) and what it can cause (commands, file writes, network calls, privileged
actions). Findings live where the first reaches the second.

## Checklist
**Injection and execution**
- Command injection: external data reaching a shell string or an argv. Quoting isn't
  escaping; use argv arrays. **Option injection:** a value starting with `-` passed as an
  argument can become a flag (`--upload-pack=…`, `--config=…`). Use `--` or a
  `--flag=value` single token, and refuse leading `-`.
- Interpreters: SQL/NoSQL, regex (catastrophic backtracking), templates, `eval`/`Function`,
  YAML/JSON loaders that build objects.
- Anything that writes, then executes (temp scripts, `curl | sh`, hooks, plugins).
- **Agent instructions:** text from a forge, mail, a ticket or another agent placed into a
  prompt, a task or a brief as directives, or treated as granting authority. It belongs
  there only quoted by link or id, as data.

**Files and paths**
- Traversal: external segments joined into paths (`..`, absolute paths, symlinks, zip-slip,
  crafted archive or git tree entries). Canonicalize, then prefix-check, and don't follow
  symlinks out of the root.
- Permissions on new files holding secrets or state; temp files in shared directories.
- TOCTOU: check-then-use on files, permissions or state.

**Secrets and data**
- Hard-coded credentials, tokens, keys (tests and examples included).
- Secrets in logs, errors, process arguments (visible in `ps`), URLs, crash reports.
- Sensitive data persisted without need, or left behind on delete/retire paths.
- Randomness and crypto: `Math.random` or a seeded generator for tokens, ids or nonces;
  home-made crypto, ECB, a reused nonce or IV, an unsalted or fast hash for passwords, a
  non-constant-time compare of secrets, TLS verification turned off.

**AuthN / AuthZ**
- New endpoints, commands, IPC or local servers: who can reach them, and what they check.
  "Localhost only" is a weak boundary: what can a hostile local process or a web page do?
- CSRF, CORS, Host/Origin checks on local HTTP servers.
- Object-level authorization (IDOR): an id from the caller used to read or change a record
  with no check that the caller may reach that record.
- Can low-trust input (config, a repo's files, a PR) cause high-trust execution (CI, hooks,
  automation running under someone's credentials)?

**CI workflows**
- A changed workflow: `pull_request_target` or `workflow_run` that checks out or runs the
  PR's code, secrets or a write token reachable from a fork's code, broadened
  `permissions`, untrusted fields (titles, branch names) interpolated into a `run:` step,
  third-party actions not pinned to a commit.

**Supply chain**
- New dependencies: needed, pinned, from the expected owner?
- Downloaded or cloned artifacts: is integrity checked before use?

**Web (when applicable)**
- XSS: external strings reaching HTML without escaping (`innerHTML`, attributes, URLs).
- SSRF: a URL or host from outside fetched by the server (internal addresses, metadata
  endpoints, redirects that land there, DNS rebinding). Open redirects: a redirect target
  taken from the request without an allowlist.

## Report
Use the adversarial-review format. Any credible injection, traversal, secret leak or authz
bypass is a **blocker**. Each finding states the **attack in one sentence** (who, what
input, what they gain). If you can't state the attack, it's a hardening note (minor) or a
question, not a blocker.
