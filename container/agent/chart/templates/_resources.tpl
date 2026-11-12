{{- define "oats.agent.resources" -}}
{{- include "oats.agent.validate" . -}}
{{- range $template := list "serviceaccount" "statefulset" "pdb" "service" "networkpolicy" "egress" -}}
{{- $resource := include (printf "oats.agent.%s" $template) $ | trim -}}
{{- if $resource }}
---
{{ $resource }}
{{ end -}}
{{- end -}}
{{- end -}}
