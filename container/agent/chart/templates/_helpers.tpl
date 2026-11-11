{{- define "agent.name" -}}
{{- $name := printf "%s-oats-team-agent" .Release.Name -}}
{{- if gt (len $name) 52 -}}
{{- fail "release name must be at most 36 characters (StatefulSet name limit 52)" -}}
{{- end -}}
{{- $name -}}
{{- end -}}
{{- define "agent.labels" -}}
app.kubernetes.io/name: oats-team-agent
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}
