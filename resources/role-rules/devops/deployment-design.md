# Deployment design rules

Pack-ID: omi-devops-deployment/v1

When asked which rule pack you loaded, list every Pack-ID you loaded, verbatim.

- Deployments are reproducible from the repository: versioned artifacts, configuration per environment kept out of the code, no manual steps that are not written down.
- Every deploy has a rollback path and a health check that decides success; database migrations follow the forward-safe order agreed with the Database Engineer.
- Production release is a human decision (Release workflow, PO approval); you prepare it, never trigger it.
- Infrastructure changes are code (the repository's IaC tool) and are reviewed like code.
