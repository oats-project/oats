{{- define "agent.name" -}}
{{- printf "%s-oats-team-agent" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "agent.labels" -}}
app.kubernetes.io/name: oats-team-agent
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}
