# DataSentinel operations runbook

This is the operator's guide for a deployment. It states what is built and what you must supply. Items marked **Operator** need your environment; the repository cannot do them for you.

## 1. Images and configuration

- `Dockerfile` builds the API (`--build-arg APP=api`) or the worker (`--build-arg APP=worker`). `Dockerfile.web` builds the web app behind nginx. All run as a non-root user and hold no secrets; configuration is environment variables only (`.env.example` lists them).
- Missing or invalid configuration stops the process at start with a list of variable names (never values).
- `deploy/compose.production.example.yaml` shows how the pieces connect. It is an example, not a turnkey stack.

## 2. Upgrade and rollback

Migrations are versioned folders under `packages/db/prisma/migrations`, applied by `prisma migrate deploy`.

**Upgrade (migration gate)**

1. Take a database backup (section 3). It is the rollback.
2. Run `pnpm --filter @datasentinel/db exec prisma migrate status`. It must show no failed migrations.
3. Run the one-shot job `prisma migrate deploy` with the new image. If it fails, stop: do not start new API or worker versions.
4. Roll the worker, then the API, then the web app. Check `GET /health/ready` on the API.

**Rollback**

Migrations are forward-only. To go back, stop API and worker, restore the pre-upgrade backup, and start the previous image. Data written after the backup is lost, so decide quickly and record the time. This project adds tables and columns before code uses them, so the previous image normally still runs on the new schema; prefer rolling the image back first and restoring only if the schema is the problem.

## 3. Backup and restore

- **PostgreSQL** holds everything that matters: use `pg_dump --format=custom` on a schedule, or continuous archiving if your host offers it. Keep encrypted copies in another account or region.
- **Redis** holds queue state only. The database is the source of truth; losing Redis delays jobs, and the scheduler recreates them from the database.
- **Object storage** holds uploaded files. Enable bucket versioning or replication.
- **Secrets**: keep `SECRETS_ENCRYPTION_KEY` (and earlier versions still in use) in your secret manager. Without it, stored source and destination credentials cannot be read.

**Restore rehearsal (Operator: required before production)**

1. Create an empty PostgreSQL instance and run `pg_restore --clean --if-exists --no-owner -d <new db> backup.dump`.
2. Run `prisma migrate status` against it; expect everything applied.
3. Start the API against it with the real encryption key; sign in; open a source and a recent incident; confirm a destination test action still works.
4. Record the date, backup size and restore time in the release notes. A backup never restored is not a backup.

## 4. Network, TLS, DNS, secrets (Operator)

- Terminate TLS at the load balancer or proxy. Set `WEB_ORIGIN` to the exact https origin so cookies are `Secure` and CSRF checks match.
- Serve the API and web app on the same site (for example `app.example.com` and `api.example.com`) so session cookies work.
- Database, Redis and object storage must not be reachable from the internet: private network or allow-listed addresses only.
- Outbound: only the API and worker reach monitored sources and destinations. Allow-list egress to the sources you register. The app already refuses private, loopback and metadata addresses for destinations.
- Keep `SESSION_SECRET`, `SECRETS_ENCRYPTION_KEY`, database and Redis URLs, OAuth secrets and AI keys in a secret manager and inject them at start. Never put them in an image or repository.
- Rotate the encryption key: set the new key and version, deploy, then run `pnpm --filter @datasentinel/api credentials:rewrap`. Rotate `SESSION_SECRET` by deploying a new value (this signs everyone out).

## 5. Monitoring

- `GET /health/live` (process up) and `GET /health/ready` (database, Redis and storage answer; 503 otherwise) for orchestrator probes.
- `GET /workspaces/:id/metrics` (admin session) returns counts: open incidents, failed checks, pending and failed notifications, actions awaiting approval, failed AI investigations, failed and stalled queue jobs. Alert on rising failed notifications and stalled jobs.
- Logs are structured and redact secrets; ship them to your log store.

## 6. Retention and deletion

Built: archiving sources, destinations and documents (destination secrets are wiped on archive); append-only audit events.

**Not built:** automatic purging of old rows and a one-step "delete workspace". Until they exist, deletion is a manual operator procedure: delete the workspace row (its data cascades by foreign key), delete its object-storage prefix, and record who did it and when. Deleted data stays in backups until they age out; set backup retention to match what you promise customers.

## 7. Incident response

1. **Suspected secret exposure:** rotate the affected secret (section 4), revoke integration tokens in Settings, sign out all sessions by rotating `SESSION_SECRET`, and review audit events for the period.
2. **Bad notifications or actions:** archive the destination; switch the workspace's AI off or the feature flags off; cancel pending actions on the incident screen.
3. **Outage:** check `/health/ready` to find the failing dependency. Queue jobs are retried, and no source data is lost because the app never writes to monitored sources.
4. **Always:** keep a timeline, preserve logs and audit events, and write a short after-action note.

## 8. Feature flags before real customer connections

Review each before enabling a workspace: `FEATURE_AI` (needs a provider, region and retention note you are willing to show customers), `FEATURE_DESTINATION_GITHUB` and the n8n flag (outbound calls), email (needs a provider; otherwise deliveries fail with `email_not_configured`), and OAuth sign-in (the callback URL must be your https origin). Keep everything off until the staging walkthrough in the release notes passes.
