// A fake sandbox provider (the sandboxes record, C4), standing in for S2's oats.aweb-sandbox: a member
// capability whose `sandbox` hook answers each act from a scripted table and records every request it
// is given, with the environment the kernel handed it. It mints nothing, runs no Docker and reaches no
// network: it is the kernel's side of C4 that the tests prove, against a provider that answers as the
// record's table says one may.
//
// The table is a JSON file (FAKE_SANDBOX_TABLE), read on every call, so a test changes the next answer
// by rewriting it. Its keys: `<act>` or `plan:<target>`, each a value of:
//   - an answer object (the envelope's sandboxApi and act are filled in when absent);
//   - a list of them, taken in turn per sandbox (the last one repeats);
//   - `{ "$exit": <n> }`, `{ "$sleepMs": <n> }` (then the default answer), `{ "$raw": "<stdout>" }`;
//   - `{ "$child": { "write": "<path>", "afterMs": <n>, "holds": "stderr"? } }`, alone (then the default
//     answer) or with any of those: first a child of the hook, in its process group, holding none of its
//     pipes (or only its stderr), that writes `late` to the path after n ms.
// A key absent from the table gets the default answer below. The record is FAKE_SANDBOX_LOG, one JSON
// line per call: { act, request, env, pending } (env: the OATS_* names the hook saw; pending: the files in
// FAKE_SANDBOX_PENDING when it is set, the kept routed requests at that moment).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FAKE_SANDBOX_CAPABILITY = "fixture.sandbox";
/** The messaging capability the fake's seat plan names (spawnProvider), whose `identity.seat` the
 *  routed spawn passes as `--provider fixture.seat identity.seat=<path>`. */
export const FAKE_SEAT_CAPABILITY = "fixture.seat";
/** The provider's remedy of ssh-include-missing ends this way (D-S1-3, aweb's precision). */
export const SSH_INCLUDE_REMEDY = "add `Include ~/.oats/sandboxes/ssh_config` to ~/.ssh/config, then rerun oats readiness";

const HOOK = String.raw`
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
const request = JSON.parse(input);
const act = process.env.OATS_SANDBOX_ACT;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("OATS_")));
const pendingDir = process.env.FAKE_SANDBOX_PENDING;
const pending = pendingDir && existsSync(pendingDir) ? readdirSync(pendingDir).sort() : [];
if (process.env.FAKE_SANDBOX_LOG) appendFileSync(process.env.FAKE_SANDBOX_LOG, JSON.stringify({ act, request, env, pending }) + "\n");
const table = process.env.FAKE_SANDBOX_TABLE && existsSync(process.env.FAKE_SANDBOX_TABLE) ? JSON.parse(readFileSync(process.env.FAKE_SANDBOX_TABLE, "utf8")) : {};
const key = act === "plan" ? "plan:" + request.target : act;
const server = "sandbox-" + request.sandbox;
const seatId = (spawnKey) => "seat-" + String(spawnKey ?? "x").slice(0, 8);
const defaults = {
  "plan:start": { state: "ready", planRevision: "rev-start", actions: [] },
  "plan:stop": { state: "ready", planRevision: "rev-stop", actions: [{ step: "stop", detail: "stop the containers" }] },
  "plan:reconcile": { state: "ready", planRevision: "rev-reconcile", actions: [] },
  "plan:seat": { state: "ready", planRevision: "rev-seat", actions: [{ step: "mint" }, { step: "deliver" }],
    seat: { id: seatId(request.instance?.spawnKey), path: "/srv/seats/" + seatId(request.instance?.spawnKey) },
    spawnProvider: { capability: "fixture.seat", options: { "identity.seat": "/srv/seats/" + seatId(request.instance?.spawnKey) } } },
  "plan:bind": { state: "ready", planRevision: "rev-bind", actions: [] },
  "plan:release": { state: "ready", planRevision: "rev-release", actions: [{ step: "remove" }] },
  start: { state: "ready", server, receipts: [{ step: "start", ok: true }] },
  stop: { state: "stopped", server, receipts: [{ step: "stop", ok: true }] },
  status: { state: "ready", server, seats: [] },
  reconcile: { state: "ready", server, seats: [] },
  seat: { state: "ready", seat: { id: seatId(request.instance?.spawnKey), path: "/srv/seats/" + seatId(request.instance?.spawnKey), alias: request.instance?.name, certificateId: "cert-1", team: request.team?.id } },
  bind: { state: "ready", seat: { id: seatId(request.instance?.spawnKey), certificateId: "cert-1", state: "active" } },
  release: { state: "ready", seat: { id: request.instance?.seatId, certificateId: "cert-1", state: "released" } },
};
let entry = Object.hasOwn(table, key) ? table[key] : defaults[key];
if (Array.isArray(entry)) {
  const counter = process.env.FAKE_SANDBOX_LOG + ".count." + key.replace(/[^a-z:]/g, "") + "." + request.sandbox;
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  entry = entry[Math.min(n, entry.length - 1)];
}
if (entry && entry.$child) {
  const { spawn } = await import("node:child_process");
  spawn(process.execPath, ["-e", "setTimeout(() => require('node:fs').writeFileSync(" + JSON.stringify(entry.$child.write) + ", 'late'), " + Number(entry.$child.afterMs) + ")"], { stdio: entry.$child.holds === "stderr" ? ["ignore", "ignore", "inherit"] : "ignore" }).unref();
  const { $child, ...rest } = entry;
  entry = Object.keys(rest).length ? rest : defaults[key];
}
if (entry && entry.$exit !== undefined) process.exit(entry.$exit);
if (entry && entry.$raw !== undefined) { process.stdout.write(entry.$raw); process.exit(0); }
if (entry && entry.$sleepMs !== undefined) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, entry.$sleepMs); entry = defaults[key]; }
process.stdout.write(JSON.stringify({ sandboxApi: 1, act, receipts: [], ...entry }) + "\n");
`;

/** The capabilities a fixture composes for the fake: the provider (its `sandbox` hook) and the seat
 *  capability its seat plan names. Settings: `region` (a default the workspace and the host override). */
export function fakeSandboxCapabilities({ name = FAKE_SANDBOX_CAPABILITY, layer = null } = {}) {
  return {
    [name]: {
      manifest: {
        // `layer`: a provider that fills a slot (messaging or tasks) also takes the workspace's payload.
        ...(layer ? { layer } : {}),
        hooks: { sandbox: "sandbox.mjs" },
        settings: { region: { default: "manifest" }, tier: { default: "manifest" }, zone: { default: "manifest" } },
      },
      files: { "sandbox.mjs": HOOK },
    },
    // The seat's capability: what a soul inside a sandbox is given `identity.seat` for. It has no hooks.
    [FAKE_SEAT_CAPABILITY]: { manifest: { settings: { identity: { default: {}, description: "the seat the host delivered (identity.seat)" } } } },
  };
}

/** The table and the record of one test: `set(table)` writes the answers, `calls()` reads the record. */
export function fakeSandboxState(dir) {
  mkdirSync(dir, { recursive: true });
  const table = join(dir, "sandbox-table.json"), log = join(dir, "sandbox-calls.jsonl");
  writeFileSync(table, "{}\n");
  return {
    env: { FAKE_SANDBOX_TABLE: table, FAKE_SANDBOX_LOG: log },
    set(answers) { writeFileSync(table, `${JSON.stringify(answers, null, 2)}\n`); },
    calls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    reset() { writeFileSync(log, ""); },
  };
}
