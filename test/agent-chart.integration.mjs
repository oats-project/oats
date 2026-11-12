// Cluster-free Helm gate; run explicitly with Helm 3 on PATH (agent-chart.yml).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { parseAllDocuments } from "yaml";

const library = fileURLToPath(new URL("../container/agent/chart", import.meta.url));
// Test infrastructure only: depend on the real component, with the caller's context.
const chart = mkdtempSync(join(tmpdir(), "oats-agent-root-"));
after(() => rmSync(chart, { recursive: true, force: true }));
mkdirSync(join(chart, "charts"));
cpSync(library, join(chart, "charts/oats-team-agent"), { recursive: true });
mkdirSync(join(chart, "templates"));
mkdirSync(join(chart, "generated"));
writeFileSync(join(chart, "Chart.yaml"), `apiVersion: v2
name: agent-root-fixture
version: 0.0.0
dependencies:
  - name: oats-team-agent
    version: 0.1.0
    repository: file://${library}
`);
writeFileSync(join(chart, "templates/agents.yaml"), '{{ include "oats.agent.resources" . }}\n');
writeFileSync(join(chart, "templates/other-components.yaml"), `{{- if .Values.fixtureUnrelated }}
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: aweb }
spec:
  replicas: 1
  serviceName: aweb
  selector: { matchLabels: { app: aweb } }
  template:
    metadata: { labels: { app: aweb } }
    spec:
      containers: [{ name: aweb, image: example.invalid/aweb:fixture }]
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: signer }
automountServiceAccountToken: true
---
apiVersion: v1
kind: Service
metadata: { name: signer }
spec: { type: LoadBalancer, selector: { app: signer }, ports: [{ port: 443 }] }
---
apiVersion: v1
kind: Secret
metadata: { name: aweb-key }
{{- end }}
`);
const config = {
  agents: {
    image: `example.invalid/agent@sha256:${"a".repeat(64)}`,
    uid: 20001, gid: 20001, secrets: "fixture-login", cpus: 2, memory: 4294967296,
    tmpSize: 134217728, resolverIp: "10.96.0.9", network: { subnet: "172.30.0.0/24", address: "172.30.0.3" },
    kubernetes: { fsGroup: 20001, stateSize: 10737418240, storageClass: "",
      requests: { cpu: 0.5, memory: 2147483648 }, ephemeralStorage: { request: 268435456, limit: 1073741824 },
      authorizedKeys: { kind: "ConfigMap", name: "fixture-keys" }, imagePullSecrets: [],
      imagePullPolicy: "IfNotPresent", service: { enabled: false } },
  },
  egress: { image: `example.invalid/egress@sha256:${"b".repeat(64)}`, privateIngressAddresses: ["10.20.0.10"] },
};
const policy = {
  frontAddress: "10.96.0.9", privateIngressAddresses: ["10.20.0.10"], deniedAddresses: ["10.20.0.11", "10.20.0.12"],
  humanOrigin: "https://approve.example.invalid",
  authorityRecords: [{ name: "_awid.team.example.invalid", text: "awid=v1; controller=did:key:z6MkneMkZqwqRiU5mJzSG3kDwzt9P8C59N4NGTfBLfSGE7c7; registry=https://registry.example.invalid;" }],
  targets: Object.fromEntries(["aweb", "secrets", "logs", "signer", "registry"].map(role => [role, { origin: `https://${role}.example.invalid`, addresses: ["10.20.0.10"] }])),
};
writeFileSync(join(chart, "generated/egress-policy.json"), JSON.stringify(policy));
writeFileSync(join(chart, "values.yaml"), JSON.stringify(config));
const values = [];
function helm(...args) {
  const r = spawnSync(process.env.HELM || "helm", args, { encoding: "utf8" });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout;
}
function render(...args) {
  return parseAllDocuments(helm("template", "proof", chart, "--namespace", "proof", ...values, ...args)).map((d) => { assert.deepEqual(d.errors, []); return d.toJSON(); });
}

test("library renderer consumes normalized root agents without defaults or a second schema", () => {
  assert.equal(existsSync(join(library, "values.yaml")), false);
  assert.equal(existsSync(join(library, "values.schema.json")), false);
  assert.match(readFileSync(join(library, "Chart.yaml"), "utf8"), /type: library/);
  const docs = render("--set", "oats-team-agent.agents.uid=0");
  const set = docs.find(d => d.kind === "StatefulSet");
  assert.equal(set.spec.template.spec.containers[0].image, config.agents.image);
  assert.equal(set.spec.template.spec.securityContext.runAsUser, 20001);
});

test("Helm lint and default rendering enforce the agent isolation contract", () => {
  helm("lint", chart, "--strict", ...values);
  const docs = render();
  assert.deepEqual(docs.map((d) => d.kind).sort(), ["ConfigMap", "Deployment", "NetworkPolicy", "NetworkPolicy", "PodDisruptionBudget", "Service", "ServiceAccount", "StatefulSet"]);
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
  assert.deepEqual(c.livenessProbe.exec, { command: ["node", "/usr/local/lib/agent-liveness.mjs"] });
  assert.deepEqual(c.readinessProbe.tcpSocket, { port: 2222 });
  assert.equal(c.startupProbe, undefined);
  assert.deepEqual(c.resources, { requests: { cpu: "0.5", memory: "2147483648", "ephemeral-storage": "268435456" }, limits: { cpu: "2", memory: "4294967296", "ephemeral-storage": "1073741824" } });
  assert.deepEqual(c.volumeMounts, [{ name: "state", mountPath: "/state" }, { name: "tmp", mountPath: "/tmp" }, { name: "login", mountPath: "/etc/agent-login", readOnly: true }, { name: "authorized-keys", mountPath: "/etc/agent-ssh/authorized_keys", subPath: "authorized_keys", readOnly: true }]);
  assert.deepEqual(p.volumes, [{ name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "134217728" } }, { name: "login", secret: { secretName: "fixture-login", defaultMode: 288 } }, { name: "authorized-keys", configMap: { name: "fixture-keys", defaultMode: 292, items: [{ key: "authorized_keys", path: "authorized_keys" }] } }]);
  assert.deepEqual(set.spec.volumeClaimTemplates[0].spec, { accessModes: ["ReadWriteOnce"], resources: { requests: { storage: "10737418240" } } });
  assert.equal(docs.find((d) => d.kind === "PodDisruptionBudget").spec.maxUnavailable, 1);
  assert.equal(docs.find((d) => d.kind === "ServiceAccount").automountServiceAccountToken, false);
});

test("agent policy is mandatory and DNS has no cluster recursive escape", () => {
  const docs = render();
  const p = docs.find((d) => d.kind === "StatefulSet").spec.template.spec;
  assert.equal(p.dnsPolicy, "None");
  assert.deepEqual(p.dnsConfig, { nameservers: ["10.96.0.9"] });
  const net = docs.find((d) => d.kind === "NetworkPolicy" && d.metadata.name === "proof-oats-team-agent");
  assert.deepEqual(net.spec.policyTypes, ["Egress"]);
  assert.deepEqual(net.spec.egress, [{ to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "oats-team-egress", "app.kubernetes.io/instance": "proof" } } }], ports: [{ protocol: "TCP", port: 443 }, { protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] }]);
});

test("optional ClusterIP and key Secret preserve the approved mounts", () => {
  const docs = render("--set", "agents.kubernetes.service.enabled=true", "--set", "agents.kubernetes.authorizedKeys.kind=Secret", "--set", "agents.kubernetes.storageClass=fixture-storage", "--set", "agents.kubernetes.imagePullSecrets[0]=fixture-pull");
  assert.equal(docs.find((d) => d.kind === "Service" && d.metadata.name === "proof-oats-team-agent").spec.type, "ClusterIP");
  const set = docs.find((d) => d.kind === "StatefulSet");
  assert.equal(set.spec.volumeClaimTemplates[0].spec.storageClassName, "fixture-storage");
  assert.deepEqual(set.spec.template.spec.imagePullSecrets, [{ name: "fixture-pull" }]);
  assert.equal(set.spec.template.spec.volumes[2].secret.secretName, "fixture-keys");
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

test("release names are DNS-1035 labels at render and acceptance boundaries", async () => {
  const { checkRendered } = await import("../container/agent/accept-kube.mjs");
  for (const name of ["a", "team-1", "a9b"]) {
    const docs = parseAllDocuments(helm("template", name, chart, "--namespace", "proof", ...values, "--set", "agents.kubernetes.service.enabled=true")).map((d) => d.toJSON());
    checkRendered(docs);
  }
  for (const name of ["a.b", "9team", "team-", "-team", "A-team", "team_1"]) {
    const r = spawnSync(process.env.HELM || "helm", ["template", name, chart, ...values], { encoding: "utf8" });
    assert.ifError(r.error);
    assert.notEqual(r.status, 0, `${name} must not render an invalid release label`);
    const docs = render(), set = docs.find((d) => d.kind === "StatefulSet");
    set.spec.selector.matchLabels["app.kubernetes.io/instance"] = name;
    assert.throws(() => checkRendered(docs), /release.*DNS-1035/);
  }
  const docs = render();
  docs.find((d) => d.kind === "StatefulSet").metadata.name = "a.b-oats-team-agent";
  assert.throws(() => checkRendered(docs), /StatefulSet name.*DNS-1035/);
  const script = fileURLToPath(new URL("../container/agent/accept-kube.sh", import.meta.url));
  const r = spawnSync("sh", [script, "--chart", chart, "--values", "unused", "--namespace", "proof", "--release", "a.b"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /release.*DNS-1035/);
});

test("acceptance rejects admitted pod security or mount drift", async () => {
  const { checkRendered, checkPod } = await import("../container/agent/accept-kube.mjs");
  const docs = render();
  checkRendered(docs);
  const set = docs.find((d) => d.kind === "StatefulSet");
  const pod = { metadata: { name: "proof-oats-team-agent-0", namespace: "proof", labels: structuredClone(set.spec.template.metadata.labels), ownerReferences: [{ kind: "StatefulSet", name: set.metadata.name, controller: true }] }, spec: structuredClone(set.spec.template.spec) };
  pod.spec.volumes.push({ name: "state", persistentVolumeClaim: { claimName: "state-proof-oats-team-agent-0" } });
  checkPod(docs, pod);
  const defaulted = structuredClone(pod);
  delete defaulted.spec.containers[0].stdin;
  delete defaulted.spec.containers[0].tty;
  defaulted.spec.containers[0].livenessProbe.timeoutSeconds = 1;
  checkPod(docs, defaulted);
  for (const mutate of [
    (p) => { p.metadata.labels["app.kubernetes.io/name"] = "unselected"; },
    (p) => { p.metadata.labels["app.kubernetes.io/instance"] = "other-team"; },
    (p) => { p.spec.automountServiceAccountToken = true; },
    (p) => { p.spec.securityContext.runAsUser = 0; },
    (p) => { p.spec.securityContext.fsGroup = 0; },
    (p) => { p.spec.securityContext.fsGroupChangePolicy = "Always"; },
    (p) => { p.spec.hostNetwork = true; },
    (p) => { p.spec.dnsPolicy = "ClusterFirst"; },
    (p) => { p.spec.containers[0].startupProbe = { tcpSocket: { port: 2222 } }; },
    (p) => { p.spec.containers[0].livenessProbe = { tcpSocket: { port: 2222 } }; },
    (p) => { p.spec.containers[0].readinessProbe = { exec: { command: ["true"] } }; },
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

test("admitted tmp volumes accept equivalent quantities and reject changed sizes", async () => {
  const { checkPod } = await import("../container/agent/accept-kube.mjs");
  for (const [size, canonical] of [[1073741824, "1Gi"], [536870912, "512Mi"], [134217728, "128Mi"]]) {
    const docs = render("--set", `agents.tmpSize=${size}`), set = docs.find((d) => d.kind === "StatefulSet");
    const pod = { metadata: { name: `${set.metadata.name}-0`, namespace: "proof", labels: structuredClone(set.spec.template.metadata.labels), ownerReferences: [{ kind: "StatefulSet", name: set.metadata.name, controller: true }] }, spec: structuredClone(set.spec.template.spec) };
    pod.spec.volumes.push({ name: "state", persistentVolumeClaim: { claimName: `state-${set.metadata.name}-0` } });
    pod.spec.volumes.find((v) => v.name === "tmp").emptyDir.sizeLimit = canonical;
    checkPod(docs, pod);
    pod.spec.volumes.find((v) => v.name === "tmp").emptyDir.sizeLimit = "2Gi";
    assert.throws(() => checkPod(docs, pod), /admitted volumes/);
  }
});

test("rendered acceptance rejects unapproved workload objects and weakened limits", async () => {
  const { checkRendered } = await import("../container/agent/accept-kube.mjs");
  for (const mutate of [
    (d) => d.push({ kind: "Secret", metadata: { name: "unexpected", labels: { "app.kubernetes.io/name": "oats-team-agent" } } }),
    (d) => { d.find((o) => o.kind === "StatefulSet").spec.replicas = 2; },
    (d) => { d.splice(d.findIndex(o => o.kind === "NetworkPolicy" && o.metadata.name === "proof-oats-team-agent"), 1); },
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
  delete defaulted.spec.template.spec.containers[0].stdin;
  delete defaulted.spec.template.spec.containers[0].tty;
  checkWorkload(docs, defaulted);
  for (const mutate of [
    (s) => { s.spec.template.metadata.labels["app.kubernetes.io/name"] = "unselected"; },
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

test("accept-kube renders a root chart and requires explicit live deletion inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "oats-chart-"));
  try {
    const valuesPath = join(dir, "values.json");
    writeFileSync(valuesPath, JSON.stringify({ ...config, fixtureUnrelated: true }));
    const script = fileURLToPath(new URL("../container/agent/accept-kube.sh", import.meta.url));
    const args = [script, "--chart", chart, "--values", valuesPath, "--namespace", "proof", "--release", "proof"];
    helm("lint", chart, "--strict", "--values", valuesPath);
    const good = spawnSync("sh", args, { encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /\[render\] PASS/);
    assert.match(good.stdout, /NOT RUN.*live pod/);
    const noRoot = spawnSync("sh", [script, "--values", valuesPath, "--namespace", "proof", "--release", "proof"], { encoding: "utf8" });
    assert.notEqual(noRoot.status, 0);
    assert.match(noRoot.stderr, /library; supply --chart PATH/);
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
    const pod = { kind: "Pod", metadata: { name: `${set.metadata.name}-0`, namespace: "proof", uid: "fixture-uid", labels: structuredClone(set.spec.template.metadata.labels), ownerReferences: [{ kind: "StatefulSet", name: set.metadata.name, controller: true }] }, spec: structuredClone(set.spec.template.spec) };
    pod.spec.volumes.push({ name: "state", persistentVolumeClaim: { claimName: `state-${set.metadata.name}-0` } });
    writeFileSync(join(dir, "objects.json"), JSON.stringify([...docs, pod]));
    writeFileSync(join(dir, "values.json"), JSON.stringify({ ...config, fixtureUnrelated: true }));
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
 const found=docs.find(d=>d.kind.toLowerCase()===a[1].toLowerCase()&&d.metadata.name===a[2]);
 if(!found)process.exit(3);
 const drift=process.env.O1B_FIXTURE_ADMISSION;
 if(found.kind==='PodDisruptionBudget'&&drift==='pdb-max')found.spec.maxUnavailable=2;
 if(found.kind==='PodDisruptionBudget'&&drift==='pdb-selector')found.spec.selector={matchLabels:{purpose:'fixture-private-selector'}};
 if(found.kind==='NetworkPolicy'&&drift==='policy')found.spec.egress[0].to[0].podSelector.matchLabels.purpose='fixture-private-policy';
 if(found.kind==='Service'&&drift==='service')found.spec.type='NodePort';
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
  const watcher=fs.watch(root,()=>{if(fs.existsSync(path.join(root,'stop'))){
   clearTimeout(fail);console.log('oats host run: SIGTERM: ticking ended');
   console.log('oats host run: stopping 1 running instance, each given 20 s');
   if(process.env.O1B_FIXTURE_STOP_FAILURE==='stop')console.log('oats host run: could not stop /fixture (E_FIXTURE): fixture stop failed');
   else if(process.env.O1B_FIXTURE_STOP_FAILURE==='listing')console.log('oats host run: listing failed (E_FIXTURE): no instance is stopped');
   else console.log('oats host run: stopped /fixture');
   console.log('oats host run: ended');watcher.close();
  }});
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
 else console.log(JSON.stringify({ok:true,result:{plan:process.env.O1B_FIXTURE_INVALID_JSON==='plan-value'?'fixture-private-plan-value':true,refusals:[{code:'E_HOST_RUN_BUSY',details:process.env.O1B_FIXTURE_LOCK_FOUND==='missing'?{}:{found:process.env.O1B_FIXTURE_LOCK_FOUND||'running'}}]}}));
}
else if(command.startsWith('node -e ')){
 if(process.env.O1B_FIXTURE_PROBE_REPLY==='empty')process.exit(0);
 if(process.env.O1B_FIXTURE_PROBE_REPLY)console.log('fixture-private-success-output');
 if(process.env.O1B_FIXTURE_PROBE_REPLY!=='other')console.log('OATS_KUBE_PROBE_PASS');
}
else process.exit(2);
`, { mode: 0o755 });
    const script = fileURLToPath(new URL("../container/agent/accept-kube.sh", import.meta.url));
    const r = spawnSync("sh", [script, "--chart", chart, "--values", join(dir, "values.json"), "--namespace", "proof", "--release", "proof", "--context", "fixture-context", "--pod", pod.metadata.name, "--ssh-key", join(dir, "key"), "--delete-pod"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /PASS admitted pod/);
    assert.match(r.stdout, /SIGTERM: ticking ended/);
    assert.match(r.stdout, /PASS ordered host shutdown/);
    assert.match(r.stdout, /oats host run: stopping 1 running instance/);
    assert.match(r.stdout, /oats host run: stopped \/fixture/);
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
    assert.ok(calls.every(args => !args.includes("aweb") && !args.includes("signer") && !args.includes("egress")), "agent admission does not select other root components");
    assert.ok(calls.every((args) => !args.includes("exec")), "operator route needs no exec permission");
    assert.ok(calls.find((args) => args.includes("logs") && args.includes("--tail=1")));
    assert.ok(calls.find((args) => args.includes("delete") && args.includes("--wait=false")));
    rmSync(join(dir, "stop"));
    const failed = spawnSync("sh", [script, "--chart", chart, "--values", join(dir, "values.json"), "--namespace", "proof", "--release", "proof", "--context", "fixture-context", "--pod", pod.metadata.name, "--ssh-key", join(dir, "key")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, O1B_FIXTURE_UID_FAILURE: "1" }, timeout: 10_000 });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /runtime probe failed: uid/);
    assert.doesNotMatch(failed.stdout + failed.stderr, /fixture-sensitive-(stdout|stderr)|AssertionError/);
    for (const reply of ["other", "empty", "extra"]) {
      rmSync(join(dir, "known-host-path"), { force: true });
      const unconfirmed = spawnSync("sh", [script, "--chart", chart, "--values", join(dir, "values.json"), "--namespace", "proof", "--release", "proof", "--context", "fixture-context", "--pod", pod.metadata.name, "--ssh-key", join(dir, "key")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, O1B_FIXTURE_PROBE_REPLY: reply }, timeout: 10_000 });
      assert.notEqual(unconfirmed.status, 0, `${reply} zero-exit stdout must not prove runtime checks`);
      assert.match(unconfirmed.stderr, /runtime probe did not confirm all checks/);
      assert.doesNotMatch(unconfirmed.stdout + unconfirmed.stderr, /fixture-private-success-output|entrypoint host run holds its lock/);
    }
    assert.match(r.stdout, /\[ssh\] PASS uid=20001 gid=20001; CapEff=0; NoNewPrivs=1/);
    assert.doesNotMatch(r.stdout, /OATS_KUBE_PROBE_PASS/);
    for (const source of ["plan", "pod", "plan-value"]) {
      rmSync(join(dir, "known-host-path"), { force: true });
      const invalid = spawnSync("sh", [script, "--chart", chart, "--values", join(dir, "values.json"), "--namespace", "proof", "--release", "proof", "--context", "fixture-context", "--pod", pod.metadata.name, "--ssh-key", join(dir, "key")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, O1B_FIXTURE_INVALID_JSON: source }, timeout: 10_000 });
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, source === "plan-value" ? /host run plan answer/ : /invalid JSON \(output withheld\)/);
      assert.doesNotMatch(invalid.stdout + invalid.stderr, /fixture-private/);
    }
    for (const found of ["unknown", "unreadable", "directory", "cannot-take-over", "held-again", "missing"]) {
      rmSync(join(dir, "known-host-path"), { force: true });
      const held = spawnSync("sh", [script, "--chart", chart, "--values", join(dir, "values.json"), "--namespace", "proof", "--release", "proof", "--context", "fixture-context", "--pod", pod.metadata.name, "--ssh-key", join(dir, "key")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, O1B_FIXTURE_LOCK_FOUND: found }, timeout: 10_000 });
      assert.notEqual(held.status, 0, `a ${found} lock must not prove a running holder`);
      assert.match(held.stderr, /entrypoint host run must already hold its lock/);
      assert.doesNotMatch(held.stdout, /entrypoint host run holds its lock/);
    }
    for (const failure of ["stop", "listing"]) {
      for (const file of ["stop", "ready", "known-host-path", "replacement-reads"]) rmSync(join(dir, file), { force: true });
      const stopped = spawnSync("sh", [script, "--chart", chart, "--values", join(dir, "values.json"), "--namespace", "proof", "--release", "proof", "--context", "fixture-context", "--pod", pod.metadata.name, "--ssh-key", join(dir, "key"), "--delete-pod"], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, O1B_FIXTURE_STOP_FAILURE: failure }, timeout: 10_000 });
      assert.notEqual(stopped.status, 0, `a ${failure} failure must fail shutdown acceptance`);
      assert.match(stopped.stderr, /host run reported a shutdown failure/);
      assert.match(stopped.stdout, failure === "stop" ? /could not stop \/fixture/ : /listing failed/);
      assert.doesNotMatch(stopped.stdout, /PASS ordered host shutdown|PASS replacement pod/);
    }
    // Include optional objects so each live admission failure has its own safe label.
    const optionalValues = structuredClone(config);
    optionalValues.agents.kubernetes.service.enabled = true;
    writeFileSync(join(dir, "values.json"), JSON.stringify(optionalValues));
    const optionalDocs = render("--values", join(dir, "values.json")), optionalSet = optionalDocs.find((d) => d.kind === "StatefulSet");
    const optionalPod = { ...pod, spec: structuredClone(optionalSet.spec.template.spec) };
    optionalPod.spec.volumes.push({ name: "state", persistentVolumeClaim: { claimName: `state-${optionalSet.metadata.name}-0` } });
    writeFileSync(join(dir, "objects.json"), JSON.stringify([...optionalDocs, optionalPod]));
    rmSync(join(dir, "stop"), { force: true });
    for (const [field, label] of [["pdb-max", "PDB maxUnavailable"], ["pdb-selector", "PDB selector"], ["policy", "NetworkPolicy spec differs from the approved chart"], ["service", "Service type"]]) {
      const drift = spawnSync("sh", [script, "--chart", chart, "--values", join(dir, "values.json"), "--namespace", "proof", "--release", "proof", "--context", "fixture-context", "--pod", pod.metadata.name, "--ssh-key", join(dir, "key")], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, O1B_FIXTURE_ADMISSION: field }, timeout: 10_000 });
      assert.notEqual(drift.status, 0);
      assert.ok(drift.stderr.includes(label), `${field} must name its check: ${drift.stderr}`);
      assert.doesNotMatch(drift.stdout + drift.stderr, /fixture-private/);
      assert.doesNotMatch(drift.stderr, /NodePort/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("canonical inputs refuse unsafe images, IDs, bytes, budgets and object names", () => {
  const bad = [
    ["agents.image", "example.invalid/agent:latest"], ["egress.image", "latest"],
    ...["uid", "gid", "kubernetes.fsGroup"].flatMap(key => [0, -1, 1.5, 2147483648, "20001"].map(value => [`agents.${key}`, value])),
    ...["memory", "tmpSize", "kubernetes.stateSize", "kubernetes.requests.memory", "kubernetes.ephemeralStorage.request", "kubernetes.ephemeralStorage.limit"].flatMap(key => [0, -1, 1.5, "1Gi", "1024", "1e9"].map(value => [`agents.${key}`, value])),
    ["agents.cpus", 3], ["agents.cpus", 0], ["agents.cpus", "2"], ["agents.cpus", 0.0001],
    ["agents.memory", 4294967297], ["agents.kubernetes.requests.cpu", 0.6],
    ["agents.kubernetes.requests.memory", 2147483649], ["agents.kubernetes.ephemeralStorage.request", 2147483648],
    ["agents.cpus", 0.25], ["agents.memory", 1073741824],
    ["agents.kubernetes.authorizedKeys.kind", "Pod"], ["agents.kubernetes.imagePullPolicy", "sometimes"],
    ["agents.kubernetes.service.enabled", "false"],
    ...["secrets", "kubernetes.authorizedKeys.name", "kubernetes.storageClass"].flatMap(key => ["bad/name", "bad\nname", "x".repeat(254)].map(value => [`agents.${key}`, value])),
    ...["resolver.invalid", "::1", "256.0.0.1", "10.0.0.01"].map(value => ["agents.resolverIp", value]),
  ];
  const path = join(chart, "bad.json");
  for (const [key, value] of bad) {
    const input = structuredClone(config), parts = key.split(".");
    let field = input; for (const part of parts.slice(0, -1)) field = field[part];
    field[parts.at(-1)] = value;
    writeFileSync(path, JSON.stringify(input));
    const r = spawnSync(process.env.HELM || "helm", ["template", "proof", chart, "--values", path], { encoding: "utf8" });
    assert.ifError(r.error);
    assert.notEqual(r.status, 0, `unsafe canonical field ${key}=${JSON.stringify(value)} rendered`);
  }
  rmSync(path);
});

test("egress uses the canonical image and public artifact with the approved proxy contract", () => {
  const docs = render(), proxy = docs.find(d => d.kind === "Deployment");
  assert.ok(proxy, "component must render the egress proxy");
  assert.equal(proxy.spec.replicas, 1);
  const p = proxy.spec.template.spec, c = p.containers[0];
  assert.equal(c.image, config.egress.image);
  assert.deepEqual(p.securityContext, { runAsNonRoot: true, runAsUser: 10001, runAsGroup: 10001, seccompProfile: { type: "RuntimeDefault" }, sysctls: [{ name: "net.ipv4.ip_forward", value: "0" }, { name: "net.ipv4.ip_unprivileged_port_start", value: "0" }] });
  assert.deepEqual(c.securityContext, { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true, privileged: false });
  assert.equal(p.automountServiceAccountToken, false);
  assert.equal(p.enableServiceLinks, false);
  assert.equal(p.dnsPolicy, "None");
  assert.deepEqual(p.dnsConfig, { nameservers: ["127.0.0.1"] });
  assert.equal(p.terminationGracePeriodSeconds, 5);
  assert.deepEqual(c.resources.limits, { cpu: "1", memory: "268435456" });
  assert.deepEqual(c.volumeMounts, [{ name: "tmp", mountPath: "/tmp" }, { name: "policy", mountPath: "/etc/egress", readOnly: true }]);
  assert.deepEqual(p.volumes, [{ name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "16777216" } }, { name: "policy", configMap: { name: "proof-oats-team-egress", defaultMode: 292, items: [{ key: "policy.json", path: "policy.json" }] } }]);
  assert.deepEqual(c.readinessProbe.exec.command, ["node", "/opt/egress/health.mjs"]);
  const artifact = docs.find(d => d.kind === "ConfigMap");
  assert.deepEqual(JSON.parse(artifact.data["policy.json"]), policy, "use derive()'s exact artifact, not another policy template");
  const service = docs.find(d => d.kind === "Service" && d.metadata.name === "egress");
  assert.equal(service.spec.type, "ClusterIP");
  assert.equal(service.spec.clusterIP, "10.96.0.9");
  assert.deepEqual(service.spec.ports, [{ name: "dns-udp", port: 53, targetPort: 53, protocol: "UDP" }, { name: "dns-tcp", port: 53, targetPort: 53, protocol: "TCP" }, { name: "tls", port: 443, targetPort: 443, protocol: "TCP" }]);
  const agent = docs.find(d => d.kind === "StatefulSet").spec.template.spec.containers[0];
  assert.deepEqual(agent.livenessProbe.exec.command, ["node", "/usr/local/lib/agent-liveness.mjs"]);
  assert.deepEqual(agent.readinessProbe.tcpSocket, { port: 2222 });
  assert.equal(agent.startupProbe, undefined, "later SSH loss must not restart the team");
  const net = docs.find(d => d.kind === "NetworkPolicy" && d.metadata.name.endsWith("egress"));
  assert.deepEqual(net.spec.egress, [{ to: [{ ipBlock: { cidr: "10.20.0.10/32" } }], ports: [{ protocol: "TCP", port: 443 }] }]);
  assert.deepEqual(net.spec.policyTypes, ["Ingress", "Egress"]);
  assert.deepEqual(net.spec.ingress[0].from, [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "oats-team-agent", "app.kubernetes.io/instance": "proof" } } }]);
  assert.deepEqual(net.spec.ingress[0].ports, [{ protocol: "TCP", port: 443 }, { protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }]);
});

test("missing or malformed generated policy fails closed without echoing the artifact", () => {
  const path = join(chart, "generated/egress-policy.json");
  const invalid = [undefined, "not-json-sensitive", "[]", "{}", JSON.stringify({ ...policy, frontAddress: "10.96.0.8" }),
    JSON.stringify({ ...policy, privateIngressAddresses: [] }),
    JSON.stringify({ ...policy, targets: { ...policy.targets, extra: policy.targets.aweb } }),
    ...["127.0.0.1", "169.254.169.254", "10.20.0.11", "10.21.0.10", "203.0.113.1", "256.1.1.1"].map(address => JSON.stringify({ ...policy, targets: { ...policy.targets, aweb: { ...policy.targets.aweb, addresses: [address] } } })),
    JSON.stringify({ ...policy, targets: { ...policy.targets, aweb: { ...policy.targets.aweb, origin: "http://sensitive.example.invalid" } } }),
    JSON.stringify({ ...policy, authorityRecords: [] }), " ".repeat(65537),
  ];
  try {
    for (const artifact of invalid) {
      if (artifact === undefined) rmSync(path); else writeFileSync(path, artifact);
      const r = spawnSync(process.env.HELM || "helm", ["template", "proof", chart], { encoding: "utf8" });
      assert.notEqual(r.status, 0, "invalid policy must fail rendering");
      assert.match(r.stderr, /generated\/egress-policy.json/);
      assert.doesNotMatch(r.stderr, /not-json-sensitive|sensitive.example.invalid/);
    }
  } finally { writeFileSync(path, JSON.stringify(policy)); }
});

test("acceptance selects agent resources from a full deployment root and still rejects agent drift", async () => {
  const { checkRendered, checkWorkload } = await import("../container/agent/accept-kube.mjs");
  const docs = render("--set", "fixtureUnrelated=true");
  assert.equal(docs.filter(d => d.kind === "StatefulSet").length, 2);
  const set = checkRendered(docs);
  assert.equal(set.metadata.name, "proof-oats-team-agent");
  checkWorkload(docs, set);
  for (const mutate of [
    s => { s.spec.template.spec.containers[0].resources.requests.cpu = "400m"; },
    s => { s.spec.template.spec.containers[0].image = `other.invalid/agent@sha256:${"c".repeat(64)}`; },
    s => { s.spec.template.spec.containers[0].livenessProbe.periodSeconds = 60; },
  ]) { const bad = structuredClone(set); mutate(bad); assert.throws(() => checkWorkload(docs, bad)); }
});

test("canonical numeric overrides retain exact accounting and valid Kubernetes names", () => {
  const input = structuredClone(config), a = input.agents, k = a.kubernetes;
  Object.assign(a, { uid: 30001, gid: 30002, cpus: 1.5, memory: 3221225472, tmpSize: 67108864 });
  Object.assign(k, { fsGroup: 30003, stateSize: 21474836480, storageClass: "storage.example.invalid", imagePullSecrets: ["pull-one", "pull-two"] });
  k.requests = { cpu: 0.125, memory: 1073741824 };
  k.ephemeralStorage = { request: 134217728, limit: 536870912 };
  const path = join(chart, "overrides.json");
  try {
    writeFileSync(path, JSON.stringify(input));
    const set = render("--values", path).find(d => d.kind === "StatefulSet"), p = set.spec.template.spec;
    assert.equal(p.securityContext.runAsUser, 30001);
    assert.equal(p.securityContext.runAsGroup, 30002);
    assert.equal(p.securityContext.fsGroup, 30003);
    assert.deepEqual(p.imagePullSecrets, [{ name: "pull-one" }, { name: "pull-two" }]);
    assert.deepEqual(p.containers[0].resources, { requests: { cpu: "0.125", memory: "1073741824", "ephemeral-storage": "134217728" }, limits: { cpu: "1.5", memory: "3221225472", "ephemeral-storage": "536870912" } });
    assert.equal(p.volumes[0].emptyDir.sizeLimit, "67108864");
    assert.equal(set.spec.volumeClaimTemplates[0].spec.storageClassName, "storage.example.invalid");
    assert.equal(set.spec.volumeClaimTemplates[0].spec.resources.requests.storage, "21474836480");
  } finally { rmSync(path); }
});

test("proxy destinations are only the artifact's pinned targets, including normalized DNS hosts", () => {
  const path = join(chart, "generated/egress-policy.json"), input = structuredClone(policy);
  input.targets.aweb = { origin: "https://AWEB.example.invalid:443/", addresses: ["93.184.216.34", "10.20.0.10"] };
  try {
    writeFileSync(path, JSON.stringify(input));
    const docs = render(), net = docs.find(d => d.kind === "NetworkPolicy" && d.metadata.name === "proof-oats-team-egress");
    assert.deepEqual(net.spec.egress, [{ to: [{ ipBlock: { cidr: "10.20.0.10/32" } }, { ipBlock: { cidr: "93.184.216.34/32" } }], ports: [{ protocol: "TCP", port: 443 }] }]);
    assert.deepEqual(JSON.parse(docs.find(d => d.kind === "ConfigMap").data["policy.json"]), input);
  } finally { writeFileSync(path, JSON.stringify(policy)); }
});
