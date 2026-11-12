{{/* The wrapper stages a public certificate bundle, never a credential/key. */}}
{{- define "oats.agent.caPem" -}}
{{- $pem := .Files.Get "generated/agent-ca.pem" -}}
{{- if or (empty $pem) (gt (len $pem) 65536) (not (regexMatch "^([ \\t\\r\\n]*-----BEGIN CERTIFICATE-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+\\r?\\n-----END CERTIFICATE-----[ \\t\\r\\n]*)+$" $pem)) -}}
{{- fail "generated/agent-ca.pem must contain only public PEM CA certificates (at most 64 KiB)" -}}
{{- end -}}
{{- $pem -}}
{{- end -}}

{{- define "oats.agent.ca" -}}
{{- if hasKey .Values.agents "caFile" -}}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "agent.name" . }}-ca
  namespace: {{ .Release.Namespace }}
  labels:
    {{- include "agent.labels" . | nindent 4 }}
data:
  ca.pem: {{ include "oats.agent.caPem" . | quote }}
{{- end -}}
{{- end -}}
