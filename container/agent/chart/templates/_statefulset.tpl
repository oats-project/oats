{{- define "oats.agent.statefulset" -}}
{{- $a := .Values.agents -}}
{{- $k := $a.kubernetes -}}
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: {{ include "agent.name" . }}
  namespace: {{ .Release.Namespace }}
spec:
  # One RWO volume is one team container; scaling is deliberately not a value.
  replicas: 1
  serviceName: {{ include "agent.name" . }}
  selector:
    matchLabels:
      {{- include "agent.labels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "agent.labels" . | nindent 8 }}
      {{- if hasKey $a "caFile" }}
      annotations:
        checksum/agent-ca: {{ include "oats.agent.caPem" . | sha256sum }}
      {{- end }}
    spec:
      serviceAccountName: {{ include "agent.name" . }}
      automountServiceAccountToken: false
      enableServiceLinks: false
      terminationGracePeriodSeconds: 45
      securityContext:
        runAsNonRoot: true
        runAsUser: {{ $a.uid }}
        runAsGroup: {{ $a.gid }}
        fsGroup: {{ $k.fsGroup }}
        # Avoid recursively widening the persisted sshd host-key mode on every remount.
        fsGroupChangePolicy: OnRootMismatch
        seccompProfile: { type: RuntimeDefault }
      {{- with $k.imagePullSecrets }}
      imagePullSecrets:
        {{- range . }}
        - name: {{ . | quote }}
        {{- end }}
      {{- end }}
      dnsPolicy: None
      dnsConfig:
        nameservers: [{{ $a.resolverIp | quote }}]
      containers:
        - name: agent
          image: {{ $a.image | quote }}
          imagePullPolicy: {{ $k.imagePullPolicy }}
          stdin: false
          tty: false
          {{- if hasKey $a "caFile" }}
          env:
            - { name: SSL_CERT_FILE, value: /etc/agent-trust/ca.pem }
            - { name: NODE_EXTRA_CA_CERTS, value: /etc/agent-trust/ca.pem }
          {{- end }}
          securityContext:
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
            readOnlyRootFilesystem: true
            privileged: false
          ports:
            - { name: ssh, containerPort: 2222, protocol: TCP }
          livenessProbe:
            exec: { command: [node, /usr/local/lib/agent-liveness.mjs] }
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            tcpSocket: { port: 2222 }
            periodSeconds: 5
          resources:
            requests:
              cpu: {{ $k.requests.cpu | quote }}
              memory: {{ include "oats.agent.bytes" $k.requests.memory | quote }}
              ephemeral-storage: {{ include "oats.agent.bytes" $k.ephemeralStorage.request | quote }}
            limits:
              cpu: {{ $a.cpus | quote }}
              memory: {{ include "oats.agent.bytes" $a.memory | quote }}
              ephemeral-storage: {{ include "oats.agent.bytes" $k.ephemeralStorage.limit | quote }}
          volumeMounts:
            - { name: state, mountPath: /state }
            - { name: tmp, mountPath: /tmp }
            - { name: login, mountPath: /etc/agent-login, readOnly: true }
            - { name: authorized-keys, mountPath: /etc/agent-ssh/authorized_keys, subPath: authorized_keys, readOnly: true }
            {{- if hasKey $a "caFile" }}
            - { name: agent-ca, mountPath: /etc/agent-trust/ca.pem, subPath: ca.pem, readOnly: true }
            {{- end }}
      volumes:
        - name: tmp
          emptyDir: { medium: Memory, sizeLimit: {{ include "oats.agent.bytes" $a.tmpSize | quote }} }
        - name: login
          secret:
            secretName: {{ required "agents.secrets is required" $a.secrets }}
            defaultMode: 288 # 0440 in both YAML 1.1 and YAML 1.2 readers.
        - name: authorized-keys
          {{- if eq $k.authorizedKeys.kind "Secret" }}
          secret:
            secretName: {{ required "agents.kubernetes.authorizedKeys.name is required" $k.authorizedKeys.name }}
          {{- else }}
          configMap:
            name: {{ required "agents.kubernetes.authorizedKeys.name is required" $k.authorizedKeys.name }}
          {{- end }}
            defaultMode: 292 # 0444
            items:
              - { key: authorized_keys, path: authorized_keys }
        {{- if hasKey $a "caFile" }}
        - name: agent-ca
          configMap:
            name: {{ include "agent.name" . }}-ca
            defaultMode: 292 # 0444
            items: [{ key: ca.pem, path: ca.pem }]
        {{- end }}
  volumeClaimTemplates:
    - metadata:
        name: state
      spec:
        accessModes: [ReadWriteOnce]
        {{- with $k.storageClass }}
        storageClassName: {{ . | quote }}
        {{- end }}
        resources:
          requests:
            storage: {{ include "oats.agent.bytes" $k.stateSize | quote }}

{{- end -}}
