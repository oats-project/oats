{{- define "oats.agent.networkpolicy" -}}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "agent.name" . }}
  namespace: {{ .Release.Namespace }}
spec:
  podSelector:
    matchLabels:
      {{- include "agent.labels" . | nindent 6 }}
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              {{- include "oats.egress.labels" . | nindent 14 }}
      ports:
        - { protocol: TCP, port: 443 }
        - { protocol: UDP, port: 53 }
        - { protocol: TCP, port: 53 }
{{- end -}}
