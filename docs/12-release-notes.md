# Release notes

## 0.1.0 (first release candidate)

**Included:** sign-in and workspaces with roles; sources (CSV upload, read-only PostgreSQL); profiling and schema snapshots; quality rules and scheduled checks; incidents with evidence, comments and notifications; destinations (email, Slack, webhook, GitHub, n8n); pipeline-run events; optional AI investigation (off by default); approved recovery actions; health, readiness and workspace metrics.

**Known limits (be honest with customers):**

- No email provider is bundled; email deliveries fail visibly until one is configured.
- No AI provider is bundled; AI stays unavailable until the deployer configures one.
- Only raw uploads are purged automatically (30 days); other history is kept until the workspace is deleted, which the owner can do (runbook section 6).
- The restore rehearsal, TLS and DNS, secret manager, and staging walkthrough are operator tasks not yet performed.

**Upgrade:** follow runbook section 2. Every release that changes the schema must say so here, and the pipeline must run `prisma migrate status` against a fresh database before deploy.

## Staging walkthrough (Operator, synthetic data only)

Upload a synthetic file; profile it; create a freshness rule; let a check fail; see the incident and evidence; receive a notification at a test destination; propose and approve a recovery action; resolve the incident. Record the date and result here.
