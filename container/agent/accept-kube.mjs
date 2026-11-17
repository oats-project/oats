// Host-side acceptance only. This module adds no kernel or image dependency.
import assert from "node:assert/strict";
import { isIP } from "node:net";

const ordered = (v) => Array.isArray(v) ? v.map(ordered) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, ordered(x)])) : v;
// Compare without including values in errors: admission may have injected a secret.
const same = (actual, expected, field) => assert.ok(JSON.stringify(ordered(actual)) === JSON.stringify(ordered(expected)), `${field} differs from the approved chart`);
const keys = (value) => Object.keys(value ?? {}).sort();
const one = (docs, kind) => { const found = docs.filter((d) => d.kind === kind); assert.equal(found.length, 1, `expected one ${kind}`); return found[0]; };
const quantity = (value) => {
  const match = String(value).match(/^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti)?$/);
  assert.ok(match, "unsupported resource quantity");
  return Number(match[1]) * ({ m: 0.001, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 }[match[2]] ?? 1);
};
function resources(value) {
  same(keys(value), ["limits", "requests"], "resource sections");
  for (const section of ["requests", "limits"]) same(keys(value[section]), ["cpu", "ephemeral-storage", "memory"], `resource ${section}`);
  const normalized = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([name, amount]) => [name, quantity(amount)]))]));
  for (const name of ["cpu", "memory", "ephemeral-storage"]) {
    assert.ok(normalized.requests[name] > 0 && normalized.limits[name] >= normalized.requests[name], `${name} request/limit must be positive and ordered`);
  }
  assert.ok(normalized.requests.cpu <= 0.5 && normalized.requests.memory <= 2 * 1024 ** 3, "requests exceed the chart's admission budget");
  assert.ok(normalized.limits.cpu <= 2 && normalized.limits.memory <= 4 * 1024 ** 3, "limits exceed the chart's admission budget");
  return normalized;
}
function isolation(p) {
  assert.equal(p.automountServiceAccountToken, false, "service-account token must be disabled");
  assert.equal(p.enableServiceLinks, false, "service links must be disabled");
  assert.equal(p.terminationGracePeriodSeconds, 45, "termination grace must be 45 seconds");
  for (const key of ["hostNetwork", "hostPID", "hostIPC", "shareProcessNamespace"]) assert.ok(!p[key], `${key} must be off`);
  for (const key of ["initContainers", "ephemeralContainers"]) assert.equal(p[key]?.length ?? 0, 0, `${key} not approved`);
  const s = p.securityContext;
  same(keys(s), ["fsGroup", "fsGroupChangePolicy", "runAsGroup", "runAsNonRoot", "runAsUser", "seccompProfile"], "pod security context fields");
  assert.equal(s.fsGroupChangePolicy, "OnRootMismatch", "fsGroup must not widen persisted host-key permissions on remount");
  assert.equal(s.runAsNonRoot, true, "runAsNonRoot");
  for (const key of ["runAsUser", "runAsGroup", "fsGroup"]) assert.ok(Number.isInteger(s[key]) && s[key] > 0, `${key} must be positive`);
  same(s.seccompProfile, { type: "RuntimeDefault" }, "seccomp profile");
  assert.equal(p.containers.length, 1, "one agent container, no sidecars");
  const c = p.containers[0];
  same(c.securityContext, { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true, privileged: false }, "container security context");
  assert.equal(c.name, "agent", "container name");
  // The API's non-pointer bool fields omit false when serializing an admitted pod.
  assert.equal(c.stdin ?? false, false, "stdin"); assert.equal(c.tty ?? false, false, "tty");
  for (const key of ["command", "args", "env", "envFrom"]) assert.equal(c[key]?.length ?? 0, 0, `unapproved container ${key}`);
  assert.ok(!c.lifecycle, "no lifecycle hooks");
  assert.match(c.image, /^[^\s@]+@sha256:[a-f0-9]{64}$/, "image must be pinned by digest");
  same(c.volumeMounts, [{ name: "state", mountPath: "/state" }, { name: "tmp", mountPath: "/tmp" }, { name: "login", mountPath: "/etc/agent-login", readOnly: true }, { name: "authorized-keys", mountPath: "/etc/agent-ssh/authorized_keys", subPath: "authorized_keys", readOnly: true }], "approved mounts");
  same(c.ports, [{ name: "ssh", containerPort: 2222, protocol: "TCP" }], "container ports");
  for (const key of ["livenessProbe", "readinessProbe"]) {
    same(c[key]?.tcpSocket, { port: 2222 }, key);
    assert.ok(!c[key].exec && !c[key].httpGet && !c[key].grpc, `${key} must use TCP only`);
  }
  resources(c.resources);
}

/** Validate rendered objects independently before trusting them as the live baseline. */
export function checkRendered(docs) {
  const allowed = ["StatefulSet", "ServiceAccount", "PodDisruptionBudget", "Service", "NetworkPolicy"];
  for (const d of docs) {
    assert.ok(allowed.includes(d.kind), "unapproved rendered object kind");
    assert.ok(!d.metadata?.annotations?.["helm.sh/hook"], "no Helm hooks");
  }
  for (const kind of allowed) assert.ok(docs.filter((d) => d.kind === kind).length <= 1, `duplicate ${kind}`);
  const set = one(docs, "StatefulSet"), sa = one(docs, "ServiceAccount"), pdb = one(docs, "PodDisruptionBudget");
  assert.ok(typeof set.metadata.name === "string" && set.metadata.name.length <= 52, "StatefulSet name must leave room for its revision label");
  const dnsLabel = /^[a-z]([-a-z0-9]*[a-z0-9])?$/, release = set.spec.selector?.matchLabels?.["app.kubernetes.io/instance"];
  assert.ok(dnsLabel.test(set.metadata.name), "StatefulSet name must be a DNS-1035 label");
  assert.ok(typeof release === "string" && dnsLabel.test(release), "release name must be a DNS-1035 label");
  assert.ok(release.length <= 36, "release name must be at most 36 characters");
  assert.equal(set.spec.replicas, 1, "replicas must stay at one");
  const p = set.spec.template.spec;
  isolation(p);
  assert.equal(p.serviceAccountName, sa.metadata.name, "dedicated service account");
  assert.notEqual(sa.metadata.name, "default", "dedicated service account");
  assert.equal(sa.automountServiceAccountToken, false, "SA token off");
  same(sa.metadata.annotations ?? {}, {}, "SA annotations (no cloud IAM binding)");
  same(sa.secrets ?? [], [], "SA secrets");
  assert.equal(pdb.spec.maxUnavailable, 1, "PDB must allow a single-pod drain");
  same(pdb.spec.selector.matchLabels, set.spec.selector.matchLabels, "PDB selector");
  assert.equal(set.spec.volumeClaimTemplates.length, 1, "one persistent volume");
  const pvc = set.spec.volumeClaimTemplates[0];
  assert.equal(pvc.metadata.name, "state", "PVC name");
  same(pvc.spec.accessModes, ["ReadWriteOnce"], "PVC access mode");
  assert.ok(quantity(pvc.spec.resources.requests.storage) > 0, "PVC size");
  same(keys(p.volumes.reduce((a, v) => ({ ...a, [v.name]: v }), {})), ["authorized-keys", "login", "tmp"], "rendered volumes");
  const v = Object.fromEntries(p.volumes.map((v) => [v.name, v]));
  same(v.tmp, { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: v.tmp.emptyDir?.sizeLimit } }, "tmp volume");
  assert.ok(quantity(v.tmp.emptyDir.sizeLimit) > 0, "tmp size");
  same(v.login, { name: "login", secret: { secretName: v.login.secret?.secretName, defaultMode: 288 } }, "login secret reference");
  assert.ok(v.login.secret.secretName, "login secret name");
  const key = v["authorized-keys"], source = key.secret ?? key.configMap;
  assert.ok(source?.secretName || source?.name, "authorized keys reference");
  same(keys(key), [key.secret ? "secret" : "configMap", "name"].sort(), "authorized keys source");
  same(source, { [key.secret ? "secretName" : "name"]: source.secretName ?? source.name, defaultMode: 292, items: [{ key: "authorized_keys", path: "authorized_keys" }] }, "authorized keys volume");
  const policy = docs.find((d) => d.kind === "NetworkPolicy");
  if (p.dnsPolicy === "None") {
    assert.equal(p.dnsConfig?.nameservers?.length, 1, "one forwarder resolver");
    assert.equal(isIP(p.dnsConfig.nameservers[0]), 4, "forwarder resolver IPv4");
  } else assert.ok(!p.dnsConfig && !policy, "forwarder policy requires explicit DNS");
  if (policy) {
    same(policy.spec.policyTypes, ["Egress"], "policy type");
    same(policy.spec.podSelector.matchLabels, set.spec.selector.matchLabels, "policy selector");
    assert.equal(policy.spec.egress.length, 1, "one forwarder egress rule");
    const rule = policy.spec.egress[0];
    assert.equal(rule.to.length, 1, "one forwarder peer");
    const peer = rule.to[0];
    same(keys(peer), ["namespaceSelector", "podSelector"], "forwarder peer fields");
    for (const k of ["namespaceSelector", "podSelector"]) { same(keys(peer[k]), ["matchLabels"], "peer labels only"); assert.ok(keys(peer[k].matchLabels).length, "nonempty peer labels"); }
    same(rule.ports, [{ protocol: "TCP", port: 443 }, { protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }], "forwarder ports");
  }
  const service = docs.find((d) => d.kind === "Service");
  if (service) { assert.equal(service.spec.type, "ClusterIP", "service must be ClusterIP"); assert.ok(!service.spec.externalIPs?.length && !service.spec.ports.some((p) => p.nodePort), "no external service exposure"); }
  return set;
}

/** An admitted pod may acquire API defaults, but no extra authority or mounts. */
export function checkPod(docs, pod) {
  const set = checkRendered(docs), expected = set.spec.template.spec, p = pod.spec;
  isolation(p);
  assert.equal(pod.metadata.namespace, set.metadata.namespace, "pod namespace");
  assert.equal(pod.metadata.name, `${set.metadata.name}-0`, "pod ordinal");
  assert.ok(pod.metadata.ownerReferences?.some((o) => o.kind === "StatefulSet" && o.name === set.metadata.name && o.controller), "pod owner");
  for (const key of ["securityContext", "serviceAccountName", "imagePullSecrets"]) same(p[key] ?? [], expected[key] ?? [], key);
  same(p.dnsPolicy ?? "ClusterFirst", expected.dnsPolicy ?? "ClusterFirst", "DNS policy");
  same(p.dnsConfig, expected.dnsConfig, "DNS config");
  const c = p.containers[0], wanted = expected.containers[0];
  for (const key of ["image", "imagePullPolicy"]) same(c[key], wanted[key], key);
  same(resources(c.resources), resources(wanted.resources), "resource quantities");
  for (const key of ["livenessProbe", "readinessProbe"]) for (const field of ["tcpSocket", "initialDelaySeconds", "periodSeconds"]) same(c[key][field] ?? (field === "initialDelaySeconds" ? 0 : 10), wanted[key][field] ?? (field === "initialDelaySeconds" ? 0 : 10), `${key}.${field}`);
  const approved = [...expected.volumes, { name: "state", persistentVolumeClaim: { claimName: `state-${set.metadata.name}-0` } }];
  // The API canonicalizes quantities (1024Mi becomes 1Gi); other volume fields stay exact.
  const volumes = (list) => list.map((v) => v.name === "tmp" && v.emptyDir ? { ...v, emptyDir: { ...v.emptyDir, sizeLimit: quantity(v.emptyDir.sizeLimit) } } : v).sort((a, b) => a.name.localeCompare(b.name));
  same(volumes(p.volumes), volumes(approved), "admitted volumes");
  return set;
}

/** Check persistence and controller fields which are not present on an admitted pod. */
export function checkWorkload(docs, admitted) {
  const expected = one(docs, "StatefulSet");
  checkRendered(docs.map((d) => d.kind === "StatefulSet" ? admitted : d));
  for (const key of ["replicas", "selector", "serviceName"]) same(admitted.spec[key], expected.spec[key], `StatefulSet ${key}`);
  const actual = admitted.spec.volumeClaimTemplates[0].spec, wanted = expected.spec.volumeClaimTemplates[0].spec;
  same(quantity(actual.resources.requests.storage), quantity(wanted.resources.requests.storage), "PVC size");
  if (wanted.storageClassName) same(actual.storageClassName, wanted.storageClassName, "PVC storage class");
  for (const key of ["securityContext", "serviceAccountName", "imagePullSecrets", "dnsConfig"]) same(admitted.spec.template.spec[key], expected.spec.template.spec[key], `StatefulSet ${key}`);
  same(admitted.spec.template.spec.dnsPolicy ?? "ClusterFirst", expected.spec.template.spec.dnsPolicy ?? "ClusterFirst", "StatefulSet DNS policy");
  return admitted;
}

/** Helm ownership is metadata, not an IAM binding. All other SA annotations refuse. */
export function checkAccount(expected, admitted, release) {
  assert.equal(admitted.metadata.name, expected.metadata.name, "SA name");
  assert.equal(admitted.metadata.namespace, expected.metadata.namespace, "SA namespace");
  assert.equal(admitted.automountServiceAccountToken, false, "SA token off");
  same(admitted.secrets ?? [], [], "SA token references");
  const annotations = { ...admitted.metadata.annotations };
  for (const [key, value] of [["meta.helm.sh/release-name", release], ["meta.helm.sh/release-namespace", expected.metadata.namespace]]) {
    if (key in annotations) { same(annotations[key], value, "Helm ownership annotation"); delete annotations[key]; }
  }
  delete annotations["kubectl.kubernetes.io/last-applied-configuration"];
  same(annotations, {}, "SA annotations (no cloud IAM binding)");
}
