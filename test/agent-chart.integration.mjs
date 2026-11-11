// Cluster-free Helm gate; run explicitly with Helm 3 on PATH (agent-chart.yml).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAllDocuments } from "yaml";

const chart = fileURLToPath(new URL("../container/agent/chart", import.meta.url));
const values = ["--set", "image.repository=example.invalid/agent", "--set", `image.digest=sha256:${"a".repeat(64)}`, "--set", "loginSecret=fixture-login", "--set", "authorizedKeys.name=fixture-keys"];
function helm(...args) {
  const r = spawnSync(process.env.HELM || "helm", args, { encoding: "utf8" });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout;
}
function render(...args) {
  return parseAllDocuments(helm("template", "proof", chart, "--namespace", "proof", ...values, ...args)).map((d) => { assert.deepEqual(d.errors, []); return d.toJSON(); });
}

test("Helm lint and default rendering enforce the agent isolation contract", () => {
  helm("lint", chart, "--strict", ...values);
  const docs = render();
  assert.deepEqual(docs.map((d) => d.kind).sort(), ["PodDisruptionBudget", "ServiceAccount", "StatefulSet"]);
  const set = docs.find((d) => d.kind === "StatefulSet");
  assert.equal(set.spec.replicas, 1);
  const p = set.spec.template.spec, c = p.containers[0];
  assert.equal(p.containers.length, 1);
  assert.equal(p.automountServiceAccountToken, false);
  assert.equal(p.enableServiceLinks, false);
  assert.equal(p.serviceAccountName, "proof-oats-team-agent");
  assert.deepEqual(p.securityContext, { runAsNonRoot: true, runAsUser: 20001, runAsGroup: 20001, fsGroup: 20001, fsGroupChangePolicy: "OnRootMismatch", seccompProfile: { type: "RuntimeDefault" } });
  assert.deepEqual(c.securityContext, { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true, privileged: false });
  assert.equal(c.stdin, false);
  assert.equal(c.tty, false);
  assert.match(c.image, /@sha256:a{64}$/);
  assert.equal(p.terminationGracePeriodSeconds, 45);
  for (const probe of [c.livenessProbe, c.readinessProbe]) assert.deepEqual(probe.tcpSocket, { port: 2222 });
  assert.deepEqual(c.resources, { requests: { cpu: "500m", memory: "2Gi", "ephemeral-storage": "256Mi" }, limits: { cpu: "2", memory: "4Gi", "ephemeral-storage": "1Gi" } });
  assert.deepEqual(c.volumeMounts, [{ name: "state", mountPath: "/state" }, { name: "tmp", mountPath: "/tmp" }, { name: "login", mountPath: "/etc/agent-login", readOnly: true }, { name: "authorized-keys", mountPath: "/etc/agent-ssh/authorized_keys", subPath: "authorized_keys", readOnly: true }]);
  assert.deepEqual(p.volumes, [{ name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "128Mi" } }, { name: "login", secret: { secretName: "fixture-login", defaultMode: 288 } }, { name: "authorized-keys", configMap: { name: "fixture-keys", defaultMode: 292, items: [{ key: "authorized_keys", path: "authorized_keys" }] } }]);
  assert.deepEqual(set.spec.volumeClaimTemplates[0].spec, { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "10Gi" } } });
  assert.equal(docs.find((d) => d.kind === "PodDisruptionBudget").spec.maxUnavailable, 1);
  assert.equal(docs.find((d) => d.kind === "ServiceAccount").automountServiceAccountToken, false);
});

test("forwarder DNS and optional policy have no cluster DNS escape", () => {
  const args = ["--set", "forwarder.enabled=true", "--set", "forwarder.resolverIP=10.96.0.9", "--set", "forwarder.networkPolicy=true", "--set", "forwarder.namespaceLabels.purpose=egress", "--set", "forwarder.podLabels.role=forwarder"];
  const docs = render(...args);
  const p = docs.find((d) => d.kind === "StatefulSet").spec.template.spec;
  assert.equal(p.dnsPolicy, "None");
  assert.deepEqual(p.dnsConfig, { nameservers: ["10.96.0.9"] });
  const policy = docs.find((d) => d.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.policyTypes, ["Egress"]);
  assert.deepEqual(policy.spec.egress, [{ to: [{ namespaceSelector: { matchLabels: { purpose: "egress" } }, podSelector: { matchLabels: { role: "forwarder" } } }], ports: [{ protocol: "TCP", port: 443 }, { protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] }]);
  assert.equal(render(...args, "--set", "forwarder.networkPolicy=false").some((d) => d.kind === "NetworkPolicy"), false);
});

test("optional ClusterIP and key Secret preserve the approved mounts", () => {
  const docs = render("--set", "service.enabled=true", "--set", "authorizedKeys.kind=Secret", "--set", "storage.className=fixture-storage", "--set", "imagePullSecrets[0].name=fixture-pull");
  assert.equal(docs.find((d) => d.kind === "Service").spec.type, "ClusterIP");
  const set = docs.find((d) => d.kind === "StatefulSet");
  assert.equal(set.spec.volumeClaimTemplates[0].spec.storageClassName, "fixture-storage");
  assert.deepEqual(set.spec.template.spec.imagePullSecrets, [{ name: "fixture-pull" }]);
  assert.equal(set.spec.template.spec.volumes[2].secret.secretName, "fixture-keys");
});

test("chart refuses unpinned images and unbounded forwarder selectors", () => {
  for (const args of [["--set", "image.digest=latest"], ["--set", "uid=0"], ["--set", "authorizedKeys.kind=Pod"], ["--set", "forwarder.enabled=true"], ...["resolver.invalid", "::1", "256.0.0.1", "10.0.0.01"].map((ip) => ["--set", "forwarder.enabled=true", "--set-string", `forwarder.resolverIP=${ip}`]), ["--set", "forwarder.networkPolicy=true"], ["--set", "forwarder.enabled=true", "--set", "forwarder.resolverIP=10.96.0.9", "--set", "forwarder.networkPolicy=true"]]) {
    const r = spawnSync(process.env.HELM || "helm", ["template", "proof", chart, ...values, ...args], { encoding: "utf8" });
    assert.ifError(r.error);
    assert.notEqual(r.status, 0, `unsafe values rendered: ${args}`);
  }
});

test("chart refuses names that cannot fit the StatefulSet revision label", async () => {
  const { checkRendered } = await import("../container/agent/accept-kube.mjs");
  const docs = parseAllDocuments(helm("template", "r".repeat(36), chart, ...values)).map((d) => d.toJSON());
  const set = docs.find((d) => d.kind === "StatefulSet");
  assert.equal(set.metadata.name.length, 52);
  checkRendered(docs);
  const r = spawnSync(process.env.HELM || "helm", ["template", "r".repeat(37), chart, ...values], { encoding: "utf8" });
  assert.ifError(r.error);
  assert.notEqual(r.status, 0, "a 53-character StatefulSet name must not render");
  assert.match(r.stderr, /36 characters/);
  set.metadata.name += "r";
  assert.throws(() => checkRendered(docs), /StatefulSet name/);
});

test("acceptance rejects admitted pod security or mount drift", async () => {
  const { checkRendered, checkPod } = await import("../container/agent/accept-kube.mjs");
  const docs = render();
  checkRendered(docs);
  const set = docs.find((d) => d.kind === "StatefulSet");
  const pod = { metadata: { name: "proof-oats-team-agent-0", namespace: "proof", ownerReferences: [{ kind: "StatefulSet", name: set.metadata.name, controller: true }] }, spec: structuredClone(set.spec.template.spec) };
  pod.spec.volumes.push({ name: "state", persistentVolumeClaim: { claimName: "state-proof-oats-team-agent-0" } });
  checkPod(docs, pod);
  const defaulted = structuredClone(pod);
  defaulted.spec.dnsPolicy = "ClusterFirst";
  delete defaulted.spec.containers[0].stdin;
  delete defaulted.spec.containers[0].tty;
  defaulted.spec.containers[0].livenessProbe.timeoutSeconds = 1;
  checkPod(docs, defaulted);
  for (const mutate of [
    (p) => { p.spec.automountServiceAccountToken = true; },
    (p) => { p.spec.securityContext.runAsUser = 0; },
    (p) => { p.spec.securityContext.fsGroup = 0; },
    (p) => { p.spec.securityContext.fsGroupChangePolicy = "Always"; },
    (p) => { p.spec.hostNetwork = true; },
    (p) => { p.spec.serviceAccountName = "default"; },
    (p) => { p.spec.containers[0].securityContext.capabilities.add = ["SYS_ADMIN"]; },
    (p) => { p.spec.containers[0].securityContext.allowPrivilegeEscalation = true; },
    (p) => { p.spec.containers[0].securityContext.readOnlyRootFilesystem = false; },
    (p) => { p.spec.containers[0].image = "example.invalid/agent:latest"; },
    (p) => { p.spec.containers[0].env = [{ name: "TOKEN", value: "fixture" }]; },
    (p) => { p.spec.containers.push(structuredClone(p.spec.containers[0])); },
    (p) => { p.spec.initContainers = [{ name: "extra" }]; },
    (p) => { p.spec.containers[0].volumeMounts.push({ name: "extra", mountPath: "/var/run/secrets/kubernetes.io/serviceaccount" }); },
    (p) => { p.spec.volumes.push({ name: "extra", hostPath: { path: "/" } }); },
    (p) => { p.spec.volumes.find((v) => v.name === "state").persistentVolumeClaim.claimName = "other-team"; },
    (p) => { p.spec.containers[0].volumeMounts[2].readOnly = false; },
    (p) => { p.spec.containers[0].livenessProbe = {}; },
    (p) => { p.spec.terminationGracePeriodSeconds = 1; },
    (p) => { p.spec.containers[0].resources.limits.memory = "8Gi"; },
  ]) {
    const bad = structuredClone(pod); mutate(bad);
    assert.throws(() => checkPod(docs, bad));
  }
});

test("rendered acceptance rejects unapproved workload objects and weakened limits", async () => {
  const { checkRendered } = await import("../container/agent/accept-kube.mjs");
  for (const mutate of [
    (d) => d.push({ kind: "Secret", metadata: { name: "unexpected" } }),
    (d) => { d.find((o) => o.kind === "StatefulSet").spec.replicas = 2; },
    (d) => { d.find((o) => o.kind === "ServiceAccount").metadata.annotations = { "example.invalid/role": "fixture" }; },
    (d) => { d.find((o) => o.kind === "StatefulSet").spec.template.spec.containers[0].resources.requests.cpu = "600m"; },
    (d) => { d.find((o) => o.kind === "StatefulSet").spec.template.spec.containers[0].resources.limits["ephemeral-storage"] = "0"; },
    (d) => { d.find((o) => o.kind === "StatefulSet").spec.volumeClaimTemplates[0].spec.accessModes = ["ReadWriteMany"]; },
  ]) { const docs = render(); mutate(docs); assert.throws(() => checkRendered(docs)); }
});

test("acceptance checks the admitted StatefulSet persistence contract", async () => {
  const { checkWorkload } = await import("../container/agent/accept-kube.mjs");
  const docs = render(), set = docs.find((d) => d.kind === "StatefulSet");
  checkWorkload(docs, set);
  const defaulted = structuredClone(set);
  defaulted.spec.template.spec.dnsPolicy = "ClusterFirst";
  delete defaulted.spec.template.spec.containers[0].stdin;
  delete defaulted.spec.template.spec.containers[0].tty;
  checkWorkload(docs, defaulted);
  for (const mutate of [
    (s) => { s.spec.replicas = 2; },
    (s) => { s.spec.volumeClaimTemplates[0].spec.accessModes = ["ReadWriteMany"]; },
    (s) => { s.spec.volumeClaimTemplates[0].spec.resources.requests.storage = "1Gi"; },
    (s) => { s.spec.template.spec.securityContext.runAsUser = 10001; },
  ]) { const bad = structuredClone(set); mutate(bad); assert.throws(() => checkWorkload(docs, bad)); }
});

test("live account checks permit Helm ownership and reject cloud bindings", async () => {
  const { checkAccount } = await import("../container/agent/accept-kube.mjs");
  const expected = render().find((d) => d.kind === "ServiceAccount");
  const admitted = structuredClone(expected);
  admitted.metadata.annotations = { "meta.helm.sh/release-name": "proof", "meta.helm.sh/release-namespace": "proof" };
  checkAccount(expected, admitted, "proof");
  for (const mutate of [
    (a) => { a.metadata.annotations["example.invalid/cloud-role"] = "fixture"; },
    (a) => { a.automountServiceAccountToken = true; },
    (a) => { a.secrets = [{ name: "token" }]; },
    (a) => { a.metadata.annotations["meta.helm.sh/release-name"] = "other"; },
  ]) { const bad = structuredClone(admitted); mutate(bad); assert.throws(() => checkAccount(expected, bad, "proof")); }
});

test("accept-kube renders by default and requires explicit live deletion inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "oats-chart-"));
  try {
    const config = join(dir, "values.json");
    writeFileSync(config, JSON.stringify({ image: { repository: "example.invalid/agent", digest: `sha256:${"a".repeat(64)}` }, loginSecret: "fixture-login", authorizedKeys: { name: "fixture-keys" } }));
    const script = fileURLToPath(new URL("../container/agent/accept-kube.sh", import.meta.url));
    const args = [script, "--values", config, "--namespace", "proof", "--release", "proof"];
    const good = spawnSync("sh", args, { encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /\[render\] PASS/);
    assert.match(good.stdout, /NOT RUN.*live pod/);
    for (const extra of [["--delete-pod"], ["--pod", "proof-oats-team-agent-0"], ["--unknown"], ["--values"]]) {
      const bad = spawnSync("sh", [...args, ...extra], { encoding: "utf8" });
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /FAIL/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("acceptance records shutdown and re-proves SSH on the replacement pod in the selected context", () => {
  const dir = mkdtempSync(join(tmpdir(), "oats-kube-boundary-"));
  try {
    const docs = render(), set = docs.find((d) => d.kind === "StatefulSet");
    const pod = { kind: "Pod", metadata: { name: `${set.metadata.name}-0`, namespace: "proof", uid: "fixture-uid", ownerReferences: [{ kind: "StatefulSet", name: set.metadata.name, controller: true }] }, spec: structuredClone(set.spec.template.spec) };
    pod.spec.volumes.push({ name: "state", persistentVolumeClaim: { claimName: `state-${set.metadata.name}-0` } });
    writeFileSync(join(dir, "objects.json"), JSON.stringify([...docs, pod]));
    writeFileSync(join(dir, "values.json"), JSON.stringify({ image: { repository: "example.invalid/agent", digest: `sha256:${"a".repeat(64)}` }, loginSecret: "fixture-login", authorizedKeys: { name: "fixture-keys" } }));
    // Replace only executable boundaries; Helm and the acceptance code remain real.
    writeFileSync(join(dir, "kubectl"), `#!/usr/bin/env node
const fs=require('node:fs'), path=require('node:path');
const root=__dirname, args=process.argv.slice(2);
fs.appendFileSync(path.join(root,'calls'),JSON.stringify(args)+'\\n');
if(args[0]!=='--context'||args[1]!=='fixture-context'||args[2]!=='--namespace'||args[3]!=='proof')process.exit(2);
const a=args.slice(4);
if(a[0]==='get'){
 if(process.env.O1B_FIXTURE_INVALID_JSON==='pod'){console.log('fixture-private-kubectl-banner');process.exit(0);}
 const docs=JSON.parse(fs.readFileSync(path.join(root,'objects.json')));
 const found=docs.find(d=>d.kind.toLowerCase()===a[1].toLowerCase());
 if(!found)process.exit(3);
 if(found.kind==='Pod'&&fs.existsSync(path.join(root,'stop'))){
  const f=path.join(root,'replacement-reads'),n=fs.existsSync(f)?Number(fs.readFileSync(f))+1:1;fs.writeFileSync(f,String(n));
  found.metadata.uid=n===1?'fixture-uid':'replacement-uid';
  found.status={phase:n===2?'Pending':'Running',conditions:[{type:'Ready',status:n===2?'False':'True'}]};
 }
 console.log(JSON.stringify(found));
}else if(a[0]==='port-forward'){
 console.log('Forwarding from 127.0.0.1:22222 -> 2222'); setInterval(()=>{},10000);
}else if(a[0]==='logs'){
 setTimeout(()=>{
  const watcher=fs.watch(root,()=>{if(fs.existsSync(path.join(root,'stop'))){clearTimeout(fail);console.log('oats host run: SIGTERM: ticking ended');console.log('oats host run: ended');watcher.close();}});
  const fail=setTimeout(()=>{watcher.close();process.exit(6);},3000);
  fs.writeFileSync(path.join(root,'ready'),'ready');
  console.log('sshd: periodic probe connection closed (boot line rotated away)');
 },500);
}else if(a[0]==='delete'){
 if(!fs.existsSync(path.join(root,'ready')))process.exit(5);
 fs.writeFileSync(path.join(root,'stop'),'stop');
}else process.exit(4);
`, { mode: 0o755 });
    writeFileSync(join(dir, "ssh"), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
fs.appendFileSync(path.join(__dirname,'ssh-calls'),JSON.stringify(args)+'\\n');
const command=process.argv.at(-1);
if(process.env.O1B_FIXTURE_UID_FAILURE==='1'&&command.startsWith('node -e ')){
 console.error('fixture-sensitive-stderr');
 console.log('fixture-sensitive-stdout');
 const program=command.slice('node -e '.length+1,-1).replaceAll(String.fromCharCode(39,92,39,39),String.fromCharCode(39));
 const remote={getuid:()=>0,getgid:()=>20001,exitCode:0};
 require('node:vm').runInNewContext(program,{require,console,process:remote});
 process.exit(remote.exitCode||7);
}
const strict=fs.existsSync(path.join(__dirname,'stop'))?'yes':'accept-new';
if(!args.includes('-oStrictHostKeyChecking='+strict))process.exit(3);
const known=args.find(a=>a.startsWith('-oUserKnownHostsFile='))?.slice('-oUserKnownHostsFile='.length);
if(!known)process.exit(4);
const prior=path.join(__dirname,'known-host-path');
if(fs.existsSync(prior)){
 if(fs.readFileSync(prior,'utf8')!==known||!fs.existsSync(known)||!fs.readFileSync(known,'utf8').includes('fixture-public-host-key'))process.exit(5);
}else{
 fs.writeFileSync(prior,known);fs.writeFileSync(known,'oats-kube-accept ssh-ed25519 fixture-public-host-key\\n');
}
if(command==='oats host run --plan --json'){
 if(process.env.O1B_FIXTURE_INVALID_JSON==='plan')console.log('fixture-private-ssh-banner');
 else console.log(JSON.stringify({ok:true,result:{plan:process.env.O1B_FIXTURE_INVALID_JSON==='plan-value'?'fixture-private-plan-value':true,refusals:[{code:'E_HOST_RUN_BUSY'}]}}));
}
else if(command.startsWith('node -e '))console.log('PASS fixture SSH boundary (no real runtime assertions)');
else process.exit(2);
`, { mode: 0o755 });
    const script = fileURLToPath(new URL("../container/agent/accept-kube.sh", import.meta.url));
    const r = spawnSync("sh", [script, "--values", join(dir, "values.json"), "--namespace", "proof", "--release", "proof", "--context", "fixture-context", "--pod", pod.metadata.name, "--ssh-key", join(dir, "key"), "--delete-pod"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /PASS admitted pod/);
    assert.match(r.stdout, /SIGTERM: ticking ended/);
    assert.match(r.stdout, /PASS ordered host shutdown/);
    assert.match(r.stdout, /PASS replacement pod/);
    assert.equal(readFileSync(join(dir, "replacement-reads"), "utf8"), "3", "old Ready UID and new Pending UID cannot satisfy replacement readiness");
    const sshCalls = readFileSync(join(dir, "ssh-calls"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(sshCalls.filter((a) => a.at(-1).startsWith("node -e ")).length, 2, "runtime is checked before and after replacement");
    assert.equal(sshCalls.filter((a) => a.at(-1) === "oats host run --plan --json").length, 2);
    assert.ok(sshCalls.every((a) => a.includes("-oHostKeyAlias=oats-kube-accept")), "one known host key must survive a new forwarded port");
    assert.deepEqual(sshCalls.map((a) => a.find((arg) => arg.startsWith("-oStrictHostKeyChecking="))), ["-oStrictHostKeyChecking=accept-new", "-oStrictHostKeyChecking=accept-new", "-oStrictHostKeyChecking=yes", "-oStrictHostKeyChecking=yes"], "replacement requires the already-persisted host key");
    assert.equal(new Set(sshCalls.map((a) => a.find((arg) => arg.startsWith("-oUserKnownHostsFile=")))).size, 1, "one known_hosts file must survive replacement");
    for (const args of sshCalls.filter((a) => a.at(-1).startsWith("node -e "))) {
      assert.match(args.at(-1), /assert\.equal\(fs\.statSync\("\/state\/ssh\/ssh_host_ed25519_key"\)\.mode & 0o777, 0o600[,)]/, "the shipped probe must enforce the persisted host-key mode");
    }
    const calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(calls.every((args) => !args.includes("exec")), "operator route needs no exec permission");
    assert.ok(calls.find((args) => args.includes("logs") && args.includes("--tail=1")));
    assert.ok(calls.find((args) => args.includes("delete") && args.includes("--wait=false")));
    rmSync(join(dir, "stop"));
    const failed = spawnSync("sh", [script, "--values", join(dir, "values.json"), "--namespace", "proof", "--release", "proof", "--context", "fixture-context", "--pod", pod.metadata.name, "--ssh-key", join(dir, "key")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, O1B_FIXTURE_UID_FAILURE: "1" }, timeout: 10_000 });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /runtime probe failed: uid/);
    assert.doesNotMatch(failed.stdout + failed.stderr, /fixture-sensitive-(stdout|stderr)|AssertionError/);
    for (const source of ["plan", "pod", "plan-value"]) {
      rmSync(join(dir, "known-host-path"), { force: true });
      const invalid = spawnSync("sh", [script, "--values", join(dir, "values.json"), "--namespace", "proof", "--release", "proof", "--context", "fixture-context", "--pod", pod.metadata.name, "--ssh-key", join(dir, "key")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, O1B_FIXTURE_INVALID_JSON: source }, timeout: 10_000 });
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, source === "plan-value" ? /host run plan answer/ : /invalid JSON \(output withheld\)/);
      assert.doesNotMatch(invalid.stdout + invalid.stderr, /fixture-private/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
