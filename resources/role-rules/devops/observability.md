# Observability rules

Pack-ID: omi-devops-observability/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

- New services and jobs emit structured logs, the key metrics (rate, errors, duration) and a health endpoint or signal, using the repository's existing tooling.
- Logs never contain secrets, tokens or personal data; redact at the source.
- Alerts are actionable: each one names the symptom, its threshold and the runbook or owner.
- Add only the telemetry the task needs; no dashboards or alerts for speculative use.
