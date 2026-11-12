{{/* Validate the public artifact before it can grant NetworkPolicy destinations.
     The image still compiles the very same JSON; Helm never generates its policy. */}}
{{- define "oats.egress.policyError" -}}
{{- fail "generated/egress-policy.json is missing or invalid; regenerate with deploy/team/egress_policy.py derive()" -}}
{{- end -}}
{{- define "oats.egress.originHost" -}}
{{- if not (kindIs "string" .) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if not (regexMatch "^https://[A-Za-z0-9.-]+(:443)?/?$" .) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- $host := lower (trimSuffix ":443" (trimSuffix "/" (trimPrefix "https://" .))) -}}
{{- if or (gt (len $host) 253) (regexMatch "^[0-9.]+$" $host) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- range $label := splitList "." $host -}}
{{- if or (gt (len $label) 63) (not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $label)) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- end -}}
{{- $host -}}
{{- end -}}

{{- define "oats.egress.policy" -}}
{{- $raw := .Files.Get "generated/egress-policy.json" -}}
{{- if or (empty $raw) (gt (len $raw) 65536) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- $p := fromJson $raw -}}
{{- if not (kindIs "map" $p) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if ne (keys $p | sortAlpha | join ",") "authorityRecords,deniedAddresses,frontAddress,humanOrigin,privateIngressAddresses,targets" -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if ne (toString $p.frontAddress) .Values.agents.resolverIp -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- range $list := list $p.privateIngressAddresses $p.deniedAddresses -}}
{{- if not (kindIs "slice" $list) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if gt (len $list) 64 -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- range $ip := $list -}}
{{- if or (not (kindIs "string" $ip)) (not (regexMatch "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$" (toString $ip))) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if ne (toJson ($p.privateIngressAddresses | sortAlpha)) (toJson (.Values.egress.privateIngressAddresses | sortAlpha)) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if not (kindIs "map" $p.targets) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if ne (keys $p.targets | sortAlpha | join ",") "aweb,logs,registry,secrets,signer" -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- $hosts := dict -}}
{{- $_ := set $hosts (include "oats.egress.originHost" $p.humanOrigin) true -}}
{{- range $target := $p.targets -}}
{{- if not (kindIs "map" $target) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if ne (keys $target | sortAlpha | join ",") "addresses,origin" -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- $host := include "oats.egress.originHost" $target.origin -}}
{{- if hasKey $hosts $host -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- $_ := set $hosts $host true -}}
{{- if not (kindIs "slice" $target.addresses) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if or (eq (len $target.addresses) 0) (gt (len $target.addresses) 8) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- range $ip := $target.addresses -}}
{{- if or (not (kindIs "string" $ip)) (not (regexMatch "^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$" (toString $ip))) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- $octets := splitList "." $ip -}}
{{- $a := int (index $octets 0) -}}{{- $b := int (index $octets 1) -}}
{{- $private := or (eq $a 10) (and (eq $a 172) (ge $b 16) (le $b 31)) (and (eq $a 192) (eq $b 168)) -}}
{{- $forbidden := or (eq $a 0) (eq $a 127) (ge $a 224) (and (eq $a 100) (ge $b 64) (le $b 127)) (and (eq $a 169) (eq $b 254)) (and (eq $a 198) (or (eq $b 18) (eq $b 19))) (regexMatch "^(192\\.0\\.(0|2)\\.|192\\.88\\.99\\.|198\\.51\\.100\\.|203\\.0\\.113\\.)" $ip) -}}
{{- if or $forbidden (has $ip $p.deniedAddresses) (and $private (not (has $ip $p.privateIngressAddresses))) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if not (kindIs "slice" $p.authorityRecords) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if or (eq (len $p.authorityRecords) 0) (gt (len $p.authorityRecords) 64) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- $names := dict -}}
{{- range $record := $p.authorityRecords -}}
{{- if not (kindIs "map" $record) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if ne (keys $record | sortAlpha | join ",") "name,text" -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if or (not (kindIs "string" $record.name)) (not (kindIs "string" $record.text)) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- if or (not (regexMatch "^_awid\\.[a-z0-9.-]+$" $record.name)) (gt (len $record.name) 253) (hasKey $names $record.name) (not (hasPrefix "awid=v1;" $record.text)) (gt (len $record.text) 2048) (not (regexMatch "^[ -~]+$" $record.text)) -}}{{- include "oats.egress.policyError" . -}}{{- end -}}
{{- $_ := include "oats.egress.originHost" (printf "https://%s" (trimPrefix "_awid." $record.name)) -}}
{{- $_ := set $names $record.name true -}}
{{- end -}}
{{- $raw -}}
{{- end -}}
