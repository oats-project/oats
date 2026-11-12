{{- define "oats.agent.resources" -}}
{{- range $template := list "serviceaccount" "statefulset" "pdb" "service" "networkpolicy" -}}
{{- $resource := include (printf "oats.agent.%s" $template) $ | trim -}}
{{- if $resource }}
---
{{ $resource }}
{{ end -}}
{{- end -}}
{{- end -}}
