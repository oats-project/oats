{{/* Safety checks for rendered resources, not a second config schema/default table. */}}
{{- define "oats.agent.number" -}}
{{- $v := .value -}}
{{- if not (or (kindIs "float64" $v) (kindIs "int64" $v) (kindIs "int" $v)) -}}
{{- fail (printf "%s must be numeric" .field) -}}
{{- end -}}
{{- if or (le (float64 $v) 0.0) (gt (float64 $v) (float64 .max)) -}}
{{- fail (printf "%s must be positive and within the approved sizing" .field) -}}
{{- end -}}
{{- if and .integer (ne (float64 $v) (floor (float64 $v))) -}}
{{- fail (printf "%s must be an integer" .field) -}}
{{- end -}}
{{- end -}}

{{- define "oats.agent.objectName" -}}
{{- if not (kindIs "string" .value) -}}{{- fail (printf "%s must be a Kubernetes object name" .field) -}}{{- end -}}
{{- $pattern := "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" -}}
{{- if .dots -}}{{- $pattern = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$" -}}{{- end -}}
{{- if or (gt (len .value) 253) (not (regexMatch $pattern .value)) -}}
{{- fail (printf "%s must be a Kubernetes object name" .field) -}}
{{- end -}}
{{- end -}}

{{- define "oats.agent.ipv4" -}}
{{- if not (kindIs "string" .) -}}{{- fail "agent/egress address must be IPv4" -}}{{- end -}}
{{- if not (regexMatch "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$" .) -}}
{{- fail "agent/egress address must be IPv4" -}}
{{- end -}}
{{- end -}}

{{- define "oats.agent.validate" -}}
{{- $a := required "normalized root agents is required" .Values.agents -}}
{{- if hasKey $a "caFile" -}}
{{- if or (not (kindIs "string" $a.caFile)) (not (hasPrefix "/" (toString $a.caFile))) -}}
{{- fail "agents.caFile must be an absolute public certificate source path" -}}
{{- end -}}
{{- end -}}
{{- $k := required "normalized agents.kubernetes is required" $a.kubernetes -}}
{{- $e := required "normalized root egress is required" .Values.egress -}}
{{- range $field, $image := dict "agents.image" $a.image "egress.image" $e.image -}}
{{- if or (not (kindIs "string" $image)) (not (regexMatch "^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$" (toString $image))) -}}
{{- fail (printf "%s must be a SHA-256 digest image reference" $field) -}}
{{- end -}}
{{- end -}}
{{- range $field, $v := dict "agents.uid" $a.uid "agents.gid" $a.gid "agents.kubernetes.fsGroup" $k.fsGroup -}}
{{- include "oats.agent.number" (dict "field" $field "value" $v "integer" true "max" 2147483647) -}}
{{- end -}}
{{- range $field, $v := dict "agents.memory" $a.memory "agents.tmpSize" $a.tmpSize "agents.kubernetes.stateSize" $k.stateSize "agents.kubernetes.requests.memory" $k.requests.memory "agents.kubernetes.ephemeralStorage.request" $k.ephemeralStorage.request "agents.kubernetes.ephemeralStorage.limit" $k.ephemeralStorage.limit -}}
{{- include "oats.agent.number" (dict "field" $field "value" $v "integer" true "max" 9007199254740991) -}}
{{- end -}}
{{- include "oats.agent.number" (dict "field" "agents.cpus" "value" $a.cpus "max" 2) -}}
{{- include "oats.agent.number" (dict "field" "agents.kubernetes.requests.cpu" "value" $k.requests.cpu "max" 0.5) -}}
{{- range $v := list $a.cpus $k.requests.cpu -}}
{{- if ne (mulf (float64 $v) 1000.0) (floor (mulf (float64 $v) 1000.0)) -}}{{- fail "CPU must use whole millicores" -}}{{- end -}}
{{- end -}}
{{- if or (gt (float64 $a.memory) 4294967296.0) (gt (float64 $k.requests.memory) 2147483648.0) -}}{{- fail "memory exceeds the approved admission budget" -}}{{- end -}}
{{- if or (gt (float64 $k.requests.cpu) (float64 $a.cpus)) (gt (float64 $k.requests.memory) (float64 $a.memory)) (gt (float64 $k.ephemeralStorage.request) (float64 $k.ephemeralStorage.limit)) -}}{{- fail "resource requests must not exceed limits" -}}{{- end -}}
{{- range $field, $v := dict "agents.secrets" $a.secrets "agents.kubernetes.authorizedKeys.name" $k.authorizedKeys.name -}}
{{- include "oats.agent.objectName" (dict "field" $field "value" $v) -}}
{{- end -}}
{{- if ne $k.storageClass "" -}}{{- include "oats.agent.objectName" (dict "field" "agents.kubernetes.storageClass" "value" $k.storageClass "dots" true) -}}{{- end -}}
{{- range $v := $k.imagePullSecrets -}}{{- include "oats.agent.objectName" (dict "field" "agents.kubernetes.imagePullSecrets" "value" $v) -}}{{- end -}}
{{- if not (has $k.authorizedKeys.kind (list "Secret" "ConfigMap")) -}}{{- fail "agents.kubernetes.authorizedKeys.kind must be Secret or ConfigMap" -}}{{- end -}}
{{- if not (has $k.imagePullPolicy (list "IfNotPresent" "Always" "Never")) -}}{{- fail "agents.kubernetes.imagePullPolicy is invalid" -}}{{- end -}}
{{- if not (kindIs "bool" $k.service.enabled) -}}{{- fail "agents.kubernetes.service.enabled must be boolean" -}}{{- end -}}
{{- include "oats.agent.ipv4" $a.resolverIp -}}
{{- end -}}
