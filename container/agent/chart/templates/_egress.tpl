{{- define "oats.agent.egress" -}}
{{- $policy := include "oats.egress.policy" . -}}
{{- $name := printf "%s-oats-team-egress" .Release.Name -}}
{{- $addresses := list -}}
{{- range $target := (fromJson $policy).targets -}}
{{- $addresses = concat $addresses $target.addresses -}}
{{- end -}}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ $name }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "oats.egress.labels" . | nindent 4 }}
data:
  policy.json: {{ $policy | quote }}
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ $name }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "oats.egress.labels" . | nindent 4 }}
spec:
  replicas: 1
  selector:
    matchLabels:
      {{- include "oats.egress.labels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "oats.egress.labels" . | nindent 8 }}
      annotations:
        checksum/egress-policy: {{ $policy | sha256sum }}
    spec:
      serviceAccountName: {{ include "agent.name" . }}
      automountServiceAccountToken: false
      enableServiceLinks: false
      terminationGracePeriodSeconds: 5
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        runAsGroup: 10001
        seccompProfile: { type: RuntimeDefault }
        sysctls:
          - { name: net.ipv4.ip_forward, value: "0" }
          - { name: net.ipv4.ip_unprivileged_port_start, value: "0" }
      {{- with .Values.agents.kubernetes.imagePullSecrets }}
      imagePullSecrets:
        {{- range . }}
        - name: {{ . | quote }}
        {{- end }}
      {{- end }}
      dnsPolicy: None
      dnsConfig: { nameservers: ["127.0.0.1"] }
      containers:
        - name: egress
          image: {{ .Values.egress.image | quote }}
          imagePullPolicy: {{ .Values.agents.kubernetes.imagePullPolicy }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
            readOnlyRootFilesystem: true
            privileged: false
          ports:
            - { name: dns-udp, containerPort: 53, protocol: UDP }
            - { name: dns-tcp, containerPort: 53, protocol: TCP }
            - { name: tls, containerPort: 443, protocol: TCP }
          resources:
            limits: { cpu: "1", memory: "268435456" }
          readinessProbe:
            exec: { command: [node, /opt/egress/health.mjs] }
            periodSeconds: 5
            timeoutSeconds: 3
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
            - { name: policy, mountPath: /etc/egress, readOnly: true }
      volumes:
        - name: tmp
          emptyDir: { medium: Memory, sizeLimit: "16777216" }
        - name: policy
          configMap:
            name: {{ $name }}
            defaultMode: 292
            items: [{ key: policy.json, path: policy.json }]
---
apiVersion: v1
kind: Service
metadata:
  name: egress
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "oats.egress.labels" . | nindent 4 }}
spec:
  type: ClusterIP
  clusterIP: {{ .Values.agents.resolverIp | quote }}
  selector:
    {{- include "oats.egress.labels" . | nindent 4 }}
  ports:
    - { name: dns-udp, port: 53, targetPort: 53, protocol: UDP }
    - { name: dns-tcp, port: 53, targetPort: 53, protocol: TCP }
    - { name: tls, port: 443, targetPort: 443, protocol: TCP }
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ $name }}
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "oats.egress.labels" . | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- include "oats.egress.labels" . | nindent 6 }}
  policyTypes: [Ingress, Egress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              {{- include "agent.labels" . | nindent 14 }}
      ports:
        - { protocol: TCP, port: 443 }
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
  egress:
    - to:
        {{- range $ip := $addresses | uniq | sortAlpha }}
        - ipBlock: { cidr: {{ printf "%s/32" $ip | quote }} }
        {{- end }}
      ports:
        - { protocol: TCP, port: 443 }
{{- end -}}
