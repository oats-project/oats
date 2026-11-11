// Cluster-free Helm gate; run explicitly with Helm 3 on PATH (agent-chart.yml).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  assert.deepEqual(p.securityContext, { runAsNonRoot: true, runAsUser: 20001, runAsGroup: 20001, fsGroup: 20001, seccompProfile: { type: "RuntimeDefault" } });
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
  for (const args of [["--set", "image.digest=latest"], ["--set", "uid=0"], ["--set", "authorizedKeys.kind=Pod"], ["--set", "forwarder.enabled=true"], ["--set", "forwarder.networkPolicy=true"], ["--set", "forwarder.enabled=true", "--set", "forwarder.resolverIP=10.96.0.9", "--set", "forwarder.networkPolicy=true"]]) {
    const r = spawnSync(process.env.HELM || "helm", ["template", "proof", chart, ...values, ...args], { encoding: "utf8" });
    assert.ifError(r.error);
    assert.notEqual(r.status, 0, `unsafe values rendered: ${args}`);
  }
});
