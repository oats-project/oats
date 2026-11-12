// Host-side acceptance only. This module adds no kernel or image dependency.
import assert from "node:assert/strict";
import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";

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
function publicCertificates(pem) {
  const message = "agent CA must contain only public X.509 CA certificates";
  assert.ok(typeof pem === "string" && Buffer.byteLength(pem) > 0 && Buffer.byteLength(pem) <= 65536, message);
  const pattern = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----/g;
  const blocks = pem.match(pattern);
  assert.ok(blocks?.length && /^[ \t\r\n]*$/.test(pem.replace(pattern, "")), message);
  try { for (const block of blocks) assert.equal(new X509Certificate(block).ca, true, message); }
  catch { throw new Error(message); }
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
  const ca = p.volumes?.some(v => v.name === "agent-ca"), mirrors = p.volumes?.some(v => v.name === "mirrors");
  same(c.env ?? [], ca ? [{ name: "SSL_CERT_FILE", value: "/etc/agent-trust/ca.pem" }, { name: "NODE_EXTRA_CA_CERTS", value: "/etc/agent-trust/ca.pem" }] : [], "approved trust settings");
  for (const key of ["command", "args", "envFrom"]) assert.equal(c[key]?.length ?? 0, 0, `unapproved container ${key}`);
  assert.ok(!c.lifecycle, "no lifecycle hooks");
  assert.match(c.image, /^[^\s@]+@sha256:[a-f0-9]{64}$/, "image must be pinned by digest");
  same(c.volumeMounts, [{ name: "state", mountPath: "/state" }, { name: "tmp", mountPath: "/tmp" }, { name: "login", mountPath: "/etc/agent-login", readOnly: true }, { name: "authorized-keys", mountPath: "/etc/agent-ssh/authorized_keys", subPath: "authorized_keys", readOnly: true }, ...(ca ? [{ name: "agent-ca", mountPath: "/etc/agent-trust/ca.pem", subPath: "ca.pem", readOnly: true }] : []), ...(mirrors ? [{ name: "mirrors", mountPath: "/mirrors", readOnly: true }] : [])], "approved mounts");
  same(c.ports, [{ name: "ssh", containerPort: 2222, protocol: "TCP" }], "container ports");
  same(c.livenessProbe?.exec, { command: ["node", "/usr/local/lib/agent-liveness.mjs"] }, "liveness must check the host supervisor");
  assert.ok(!c.livenessProbe.tcpSocket && !c.livenessProbe.httpGet && !c.livenessProbe.grpc, "liveness must use the supervisor helper only");
  same(c.readinessProbe?.tcpSocket, { port: 2222 }, "readinessProbe");
  assert.ok(!c.readinessProbe.exec && !c.readinessProbe.httpGet && !c.readinessProbe.grpc, "readiness must use TCP only");
  assert.ok(!c.startupProbe, "no SSH startup probe may restart the team");
  resources(c.resources);
  return { ca, mirrors };
}

/** Select the agent component inside an installable deployment root. Proxy and
 * service components have their own admission/boundary gates. Names and workload
 * identity also select objects, so removing a label cannot hide agent drift. */
export function agentObjects(docs) {
  const sets = docs.filter(d => d.kind === "StatefulSet" && (
    d.metadata?.name?.endsWith("-oats-team-agent") ||
    d.spec?.selector?.matchLabels?.["app.kubernetes.io/name"] === "oats-team-agent" ||
    d.spec?.template?.spec?.containers?.some(c => c.name === "agent")));
  assert.equal(sets.length, 1, "expected one agent StatefulSet");
  const set = sets[0], release = set.spec?.selector?.matchLabels?.["app.kubernetes.io/instance"];
  const names = [set.metadata.name, `${set.metadata.name}-ca`, `${release}-oats-team-agent`, set.spec?.template?.spec?.serviceAccountName];
  return docs.filter(d => d === set || names.includes(d.metadata?.name) || d.metadata?.labels?.["app.kubernetes.io/name"] === "oats-team-agent");
}

/** Validate rendered objects independently before trusting them as the live baseline. */
export function checkRendered(docs) {
  docs = agentObjects(docs);
  const allowed = ["StatefulSet", "ServiceAccount", "PodDisruptionBudget", "Service", "NetworkPolicy", "ConfigMap"];
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
  const labels = { "app.kubernetes.io/name": "oats-team-agent", "app.kubernetes.io/instance": release };
  same(set.spec.selector.matchLabels, labels, "agent selector");
  same(set.spec.template.metadata.labels, labels, "agent template labels");
  assert.equal(set.spec.replicas, 1, "replicas must stay at one");
  const p = set.spec.template.spec;
  const { ca, mirrors } = isolation(p);
  const bundles = docs.filter(d => d.kind === "ConfigMap");
  assert.equal(bundles.length, ca ? 1 : 0, "only the configured agent CA ConfigMap is approved");
  if (ca) {
    const bundle = bundles[0];
    same(bundle.metadata.name, `${set.metadata.name}-ca`, "agent CA ConfigMap name");
    same(bundle.metadata.namespace, set.metadata.namespace, "agent CA ConfigMap namespace");
    same(keys(bundle.data), ["ca.pem"], "agent CA ConfigMap keys");
    same(bundle.binaryData ?? {}, {}, "agent CA binary data");
    publicCertificates(bundle.data["ca.pem"]);
  }
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
  same(keys(p.volumes.reduce((a, v) => ({ ...a, [v.name]: v }), {})), ["authorized-keys", "login", "tmp", ...(ca ? ["agent-ca"] : []), ...(mirrors ? ["mirrors"] : [])].sort(), "rendered volumes");
  const v = Object.fromEntries(p.volumes.map((v) => [v.name, v]));
  if (mirrors) {
    const claim = v.mirrors.persistentVolumeClaim?.claimName;
    assert.ok(typeof claim === "string" && claim.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(claim), "mirrors must reference an existing approved claim");
    assert.notEqual(claim, `state-${set.metadata.name}-0`, "mirrors must not alias the writable agent state claim");
    same(v.mirrors, { name: "mirrors", persistentVolumeClaim: { claimName: claim, readOnly: true } }, "read-only mirror volume");
  }
  if (ca) same(v["agent-ca"], { name: "agent-ca", configMap: { name: `${set.metadata.name}-ca`, defaultMode: 292, items: [{ key: "ca.pem", path: "ca.pem" }] } }, "agent CA projection");
  same(v.tmp, { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: v.tmp.emptyDir?.sizeLimit } }, "tmp volume");
  assert.ok(quantity(v.tmp.emptyDir.sizeLimit) > 0, "tmp size");
  same(v.login, { name: "login", secret: { secretName: v.login.secret?.secretName, defaultMode: 288 } }, "login secret reference");
  assert.ok(v.login.secret.secretName, "login secret name");
  const key = v["authorized-keys"], source = key.secret ?? key.configMap;
  assert.ok(source?.secretName || source?.name, "authorized keys reference");
  same(keys(key), [key.secret ? "secret" : "configMap", "name"].sort(), "authorized keys source");
  same(source, { [key.secret ? "secretName" : "name"]: source.secretName ?? source.name, defaultMode: 292, items: [{ key: "authorized_keys", path: "authorized_keys" }] }, "authorized keys volume");
  assert.equal(p.dnsPolicy, "None", "agent DNS must use only the egress resolver");
  same(keys(p.dnsConfig), ["nameservers"], "DNS configuration fields");
  assert.equal(p.dnsConfig.nameservers?.length, 1, "one egress resolver");
  assert.equal(isIP(p.dnsConfig.nameservers[0]), 4, "egress resolver IPv4");
  const policy = one(docs, "NetworkPolicy");
  same(policy.spec, {
    podSelector: { matchLabels: set.spec.selector.matchLabels },
    policyTypes: ["Egress"],
    egress: [{ to: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "oats-team-egress", "app.kubernetes.io/instance": release } } }], ports: [{ protocol: "TCP", port: 443 }, { protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] }],
  }, "agent egress policy");
  const service = docs.find((d) => d.kind === "Service");
  if (service) { assert.equal(service.spec.type, "ClusterIP", "service must be ClusterIP"); assert.ok(!service.spec.externalIPs?.length && !service.spec.ports.some((p) => p.nodePort), "no external service exposure"); }
  return set;
}

function baseline(p, expected) {
  for (const key of ["securityContext", "serviceAccountName", "imagePullSecrets"]) same(p[key] ?? [], expected[key] ?? [], key);
  same(p.dnsPolicy ?? "ClusterFirst", expected.dnsPolicy ?? "ClusterFirst", "DNS policy");
  same(p.dnsConfig, expected.dnsConfig, "DNS config");
  same(p.volumes?.find(v => v.name === "mirrors"), expected.volumes?.find(v => v.name === "mirrors"), "mirror source");
  const c = p.containers[0], wanted = expected.containers[0];
  same(c.env ?? [], wanted.env ?? [], "trust settings");
  for (const key of ["image", "imagePullPolicy"]) same(c[key], wanted[key], key);
  same(resources(c.resources), resources(wanted.resources), "resource quantities");
  const probe = value => ({ initialDelaySeconds: 0, periodSeconds: 10, timeoutSeconds: 1, successThreshold: 1, failureThreshold: 3, ...value });
  for (const key of ["livenessProbe", "readinessProbe"]) same(probe(c[key]), probe(wanted[key]), key);
}

/** An admitted pod may acquire API defaults, but no extra authority or mounts. */
export function checkPod(docs, pod) {
  const set = checkRendered(docs), expected = set.spec.template.spec, p = pod.spec;
  isolation(p);
  for (const [key, value] of Object.entries(set.spec.template.metadata.labels)) same(pod.metadata.labels?.[key], value, "agent pod labels");
  assert.equal(pod.metadata.namespace, set.metadata.namespace, "pod namespace");
  assert.equal(pod.metadata.name, `${set.metadata.name}-0`, "pod ordinal");
  assert.ok(pod.metadata.ownerReferences?.some((o) => o.kind === "StatefulSet" && o.name === set.metadata.name && o.controller), "pod owner");
  baseline(p, expected);
  const approved = [...expected.volumes, { name: "state", persistentVolumeClaim: { claimName: `state-${set.metadata.name}-0` } }];
  // The API canonicalizes quantities (1024Mi becomes 1Gi); other volume fields stay exact.
  const volumes = (list) => list.map((v) => v.name === "tmp" && v.emptyDir ? { ...v, emptyDir: { ...v.emptyDir, sizeLimit: quantity(v.emptyDir.sizeLimit) } } : v).sort((a, b) => a.name.localeCompare(b.name));
  same(volumes(p.volumes), volumes(approved), "admitted volumes");
  return set;
}

/** Check persistence and controller fields which are not present on an admitted pod. */
export function checkWorkload(docs, admitted) {
  docs = agentObjects(docs);
  const expected = one(docs, "StatefulSet");
  checkRendered(docs.map((d) => d.kind === "StatefulSet" ? admitted : d));
  baseline(admitted.spec.template.spec, expected.spec.template.spec);
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
