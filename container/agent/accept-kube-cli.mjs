import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";
import { checkAccount, checkPod, checkRendered, checkWorkload } from "./accept-kube.mjs";

const usage = "accept-kube.sh --values FILE --namespace NS --release NAME [--context CONTEXT --pod POD --ssh-key FILE] [--delete-pod]";
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const report = (phase, message) => console.log(`[${phase}] ${message}`);
function command(bin, args, { probe = false } = {}) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 ** 2 });
  assert.ifError(r.error);
  // Only fixed probe labels can leave a failed SSH call; arbitrary remote output stays private.
  if (r.status !== 0 && probe) {
    const failed = r.stdout.match(/^OATS_KUBE_PROBE_FAIL:(uid|gid|process-security|state-tmp|root|mounts|login|host-key-mode)$/m);
    throw new Error(failed ? `runtime probe failed: ${failed[1]}` : "ssh runtime probe failed (output withheld)");
  }
  // Do not echo argv, stdout or stderr on failure: an admission hook may inject secrets.
  assert.equal(r.status, 0, `${bin} failed (output withheld)`);
  return r.stdout;
}
function json(text, what) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${what}: invalid JSON (output withheld)`); }
}
function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--delete-pod") { assert.ok(!out.delete, "duplicate --delete-pod"); out.delete = true; continue; }
    assert.ok(["--values", "--namespace", "--release", "--context", "--pod", "--ssh-key"].includes(k), usage);
    assert.ok(!out[k] && argv[i + 1] && !argv[i + 1].startsWith("--"), usage);
    out[k] = argv[++i];
  }
  for (const k of ["--values", "--namespace", "--release"]) assert.ok(out[k], usage);
  for (const k of ["--namespace", "--release", "--pod"]) if (out[k]) assert.match(out[k], /^[a-z0-9][a-z0-9.-]*$/, "invalid resource name");
  assert.ok(!out["--pod"] || (out["--context"] && out["--ssh-key"]), "live pod requires --context and --ssh-key");
  assert.ok(!out.delete || out["--pod"], "--delete-pod requires an explicit live pod");
  assert.ok(!out["--ssh-key"] || out["--pod"], "--ssh-key requires --pod");
  return out;
}

// Serialized and run through SSH, as the image's agent user. No kubectl exec right.
function runtimeProbe(uid, gid) {
  const assert = require("node:assert/strict"), fs = require("node:fs");
  let check = "uid";
  try {
    assert.equal(process.getuid(), uid);
    check = "gid";
    assert.equal(process.getgid(), gid);
    check = "process-security";
    const status = fs.readFileSync("/proc/self/status", "utf8");
    assert.match(status, /^CapEff:\s+0+$/m); assert.match(status, /^NoNewPrivs:\s+1$/m);
    assert.equal(fs.existsSync("/var/run/secrets/kubernetes.io/serviceaccount/token"), false);
    check = "state-tmp";
    for (const dir of ["/state", "/tmp"]) {
      const path = `${dir}/.oats-kube-probe-${process.pid}`;
      fs.writeFileSync(path, "probe", { flag: "wx", mode: 0o600 }); fs.unlinkSync(path);
    }
    check = "root";
    for (const path of ["/opt/.oats-kube-probe", "/run/.oats-kube-probe"]) {
      let wrote = false;
      try { fs.writeFileSync(path, "probe", { flag: "wx" }); wrote = true; }
      catch (e) { assert.equal(e.code, "EROFS"); }
      if (wrote) fs.unlinkSync(path);
      assert.equal(wrote, false, "root filesystem write succeeded");
    }
    check = "mounts";
    for (const path of ["/etc/resolv.conf", "/etc/agent-ssh/authorized_keys"]) {
      fs.accessSync(path, fs.constants.R_OK);
      assert.throws(() => fs.openSync(path, "r+"), (e) => e.code === "EROFS" || e.code === "EACCES");
    }
    check = "login";
    assert.ok(fs.statSync("/etc/agent-login").isDirectory());
    assert.throws(() => fs.accessSync("/etc/agent-login", fs.constants.W_OK));
    check = "host-key-mode";
    assert.equal(fs.statSync("/state/ssh/ssh_host_ed25519_key").mode & 0o777, 0o600, "persisted SSH host key must retain mode 0600");
  } catch {
    console.log(`OATS_KUBE_PROBE_FAIL:${check}`);
    process.exitCode = 1;
    return;
  }
  console.log(`PASS uid=${uid} gid=${gid}; CapEff=0; NoNewPrivs=1; no SA token; /state,/tmp writable; root and login/key/resolver mounts not writable`);
}

async function forwarded(kube, pod) {
  const child = spawn("kubectl", [...kube, "port-forward", "--address=127.0.0.1", `pod/${pod}`, ":2222"], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("port-forward did not become ready")), 30_000);
      const fail = () => { clearTimeout(timer); reject(new Error("kubectl port-forward ended before ready")); };
      child.once("error", fail); child.once("exit", fail);
      let output = "";
      const read = (data) => {
        output += data;
        const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+) -> 2222/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stdout.on("data", read); child.stderr.on("data", read);
    });
    return { child, port };
  } catch (e) { child.kill(); throw e; }
}

async function shutdown(kube, pod, expectedUID) {
  // Start streaming BEFORE deletion; a removed pod cannot be queried for its final logs.
  const log = spawn("kubectl", [...kube, "logs", "--follow", "--tail=1", pod, "-c", "agent"], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((resolve) => { log.once("error", () => resolve(false)); log.once("close", (code) => resolve(code === 0)); });
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  let tail = "", ended = false, signal = false;
  log.stdout.on("data", (data) => {
    // Receiving the stream proves attachment even after the boot line has rotated away.
    if (data.length) ready(true);
    tail += data;
    const lines = tail.split("\n"); tail = lines.pop();
    for (const line of lines) {
      if (line === "oats host run: SIGTERM: ticking ended") { signal = true; report("stop", line); }
      if (signal && line === "oats host run: ended") { ended = true; report("stop", line); }
    }
  });
  let timer;
  try {
    const attached = await Promise.race([started, closed.then(() => false), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 15_000); })]);
    clearTimeout(timer);
    assert.ok(attached, "shutdown log stream did not attach before deletion");
    const current = json(command("kubectl", [...kube, "get", "pod", pod, "-o", "json"]), "pod before deletion");
    assert.equal(current.metadata.uid, expectedUID, "pod was replaced before deletion");
    const start = Date.now();
    command("kubectl", [...kube, "delete", "pod", pod, "--wait=false"]);
    const success = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("host run did not stop within 45 seconds")), 45_000); })]);
    assert.ok(success, "shutdown log stream failed");
    assert.ok(signal && ended, "missing ordered SIGTERM and ended events");
    assert.ok(Date.now() - start <= 45_000, "shutdown exceeded grace period");
    report("stop", `PASS ordered host shutdown in ${Date.now() - start}ms (45s grace); StatefulSet may replace the deleted pod`);
  } finally { clearTimeout(timer); log.kill(); }
}

function sshProof(port, key, knownHosts, uid, gid, phase = "ssh") {
  const ssh = ["-F", "/dev/null", "-T", "-oBatchMode=yes", "-oIdentitiesOnly=yes", "-oIdentityAgent=none", `-oStrictHostKeyChecking=${phase === "replacement" ? "yes" : "accept-new"}`, "-oHostKeyAlias=oats-kube-accept", `-oUserKnownHostsFile=${knownHosts}`, "-oConnectTimeout=10", "-p", port, "-i", key, "agent@127.0.0.1"];
  report(phase, command("ssh", [...ssh, `node -e ${quote(`(${runtimeProbe.toString()})(${uid},${gid})`)}`], { probe: true }).trim());
  const plan = json(command("ssh", [...ssh, "oats host run --plan --json"]), "host plan");
  assert.equal(plan.ok, true, "host run plan failed");
  assert.equal(plan.result.plan, true, "host run plan answer");
  assert.ok(plan.result.refusals.some((r) => r.code === "E_HOST_RUN_BUSY" && r.details?.found === "running"), "entrypoint host run must already hold its lock");
  report(phase, "PASS oats host run --plan: plan=true; entrypoint host run holds its lock (E_HOST_RUN_BUSY)");
}

async function replacementPod(kube, name, previousUID, docs) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const text = command("kubectl", [...kube, "get", "pod", name, "--ignore-not-found=true", "--request-timeout=5s", "-o", "json"]);
    const pod = text.trim() ? json(text, "replacement pod") : null;
    if (pod?.metadata?.uid && pod.metadata.uid !== previousUID) {
      checkPod(docs, pod);
      if (!pod.metadata.deletionTimestamp && pod.status?.phase === "Running" && pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True")) return pod;
    }
    // Readiness is bounded and observed; an old Ready condition cannot satisfy a new UID.
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("replacement pod did not become Ready with a new UID within 120 seconds");
}

async function main() {
  const o = options(process.argv.slice(2)), chart = fileURLToPath(new URL("./chart", import.meta.url));
  const args = ["--values", o["--values"], "--namespace", o["--namespace"]];
  command(process.env.HELM || "helm", ["lint", "--strict", chart, ...args]);
  const docs = parseAllDocuments(command(process.env.HELM || "helm", ["template", o["--release"], chart, ...args])).map((d) => { assert.equal(d.errors.length, 0, "invalid rendered YAML"); return d.toJSON(); });
  const set = checkRendered(docs);
  report("render", "PASS Helm lint/template; one RWO StatefulSet, dedicated SA/no RBAC, fixed security, mounts, probes, budgets and 45s grace");
  report("render", "NOT ASSUMED: NetworkPolicy enforcement; no hostname allowlist proof without operator-verified enforcement and bypass tests");
  if (!o["--pod"]) { report("render", "NOT RUN: live pod, SSH, filesystem and deletion checks (supply --context --pod --ssh-key)"); return; }
  const kube = ["--context", o["--context"], "--namespace", o["--namespace"]];
  const pod = json(command("kubectl", [...kube, "get", "pod", o["--pod"], "-o", "json"]), "pod");
  checkPod(docs, pod);
  checkWorkload(docs, json(command("kubectl", [...kube, "get", "StatefulSet", set.metadata.name, "-o", "json"]), "StatefulSet"));
  report("live", `PASS admitted pod ${pod.metadata.name}: declared image digest, uid/gid, security, exact mounts, resources and probes match`);
  // Also compare workload objects whose limits cannot be inferred from a pod alone.
  for (const object of docs) if (object.kind !== "StatefulSet") {
    const admitted = json(command("kubectl", [...kube, "get", object.kind, object.metadata.name, "-o", "json"]), "admitted workload");
    if (object.kind === "ServiceAccount") {
      checkAccount(object, admitted, o["--release"]);
    } else if (object.kind === "PodDisruptionBudget") { assert.equal(admitted.spec.maxUnavailable, 1); assert.deepEqual(admitted.spec.selector, object.spec.selector); }
    else if (object.kind === "NetworkPolicy") assert.deepEqual(admitted.spec, object.spec);
    else assert.equal(admitted.spec.type, "ClusterIP");
  }
  const dir = mkdtempSync(join(tmpdir(), "oats-kube-accept-"));
  let tunnel;
  try {
    tunnel = await forwarded(kube, pod.metadata.name);
    const s = set.spec.template.spec.securityContext;
    sshProof(tunnel.port, o["--ssh-key"], join(dir, "known_hosts"), s.runAsUser, s.runAsGroup);
    if (o.delete) {
      await shutdown(kube, pod.metadata.name, pod.metadata.uid);
      tunnel.child.kill();
      const replacement = await replacementPod(kube, pod.metadata.name, pod.metadata.uid, docs);
      tunnel = await forwarded(kube, replacement.metadata.name);
      sshProof(tunnel.port, o["--ssh-key"], join(dir, "known_hosts"), s.runAsUser, s.runAsGroup, "replacement");
      report("replacement", "PASS replacement pod Ready with a new UID; declared isolation, persisted SSH host key and host-run lock re-proven");
    }
    else report("stop", "NOT RUN: deletion requires --delete-pod (only for a disposable acceptance deployment)");
  } finally { tunnel?.child.kill(); rmSync(dir, { recursive: true, force: true }); }
  report("live", "NOT RUN: seats, native harness auth, mail/chat and network bypass checks; each needs its own platform evidence");
}

main().catch((error) => {
  // Assertion diagnostics append actual remote values after the fixed check label.
  console.error(`[kube] FAIL: ${error.message.split("\n")[0]}`);
  process.exitCode = 1;
});
