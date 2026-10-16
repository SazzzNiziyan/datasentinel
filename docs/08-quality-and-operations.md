# DataSentinel Quality and Operations

## 1. Definition of done

A feature is done when all items that apply are true:

- The behavior matches its product requirement and acceptance criteria.
- The API, worker, and UI agree on request/response/state shape.
- Authentication, workspace scope, permission checks, validation, and safe error handling are implemented.
- Long-running work is observable and idempotent where it can be retried.
- Loading, empty, success, permission-denied, failure, and timeout states are usable.
- Changes to the Prisma schema have a reviewed migration and rollback/forward-recovery plan.
- Documentation and example configuration match the implementation.
- Sensitive fields are absent from logs, job payloads, browser bundles, AI input, and error messages.
- The relevant verification steps were performed and their limits are recorded honestly.

## 2. Verification strategy

Build confidence at several layers. Keep all test data synthetic unless a specifically authorized environment provides isolated test data.

| Layer        | What to verify                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Unit         | Rule evaluation, baseline math, incident grouping, state transitions, redaction, validation, idempotency-key behavior     |
| API/module   | Workspace/role permissions, service transactions, DTO validation, safe error normalization, session lifecycle             |
| Connector    | CSV parsing limits, PostgreSQL read-only query behavior, timeout handling, HTTP SSRF policy, credential redaction         |
| Worker/queue | Retry/backoff, duplicate delivery, job timeout, terminal failure, schedule uniqueness, outbox recovery                    |
| UI           | Main journeys, keyboard operation, form errors, responsive screens, queued/running/failed states, accessible status text  |
| End-to-end   | Upload/register dataset → profile → create rule → trigger failure → incident/evidence → notification → resolution         |
| Security     | Cross-workspace access, role escalation, CSRF/session controls, upload abuse, SSRF, secret leakage, approval bypass       |
| Operations   | Backup restore, migration rollout, queue restart, database/Redis/object-store outage, provider outage, retention deletion |

For each failure-path check, confirm the system reports an error rather than showing a false healthy/pass state.

## 3. Required synthetic scenarios

Maintain a small fake dataset and job fixture that can produce:

- Healthy daily sales with expected columns and row count.
- A stale dataset whose timestamp is older than the configured maximum age.
- A required column with unexpected nulls.
- Duplicate customer IDs or emails.
- A row-count drop larger than the configured threshold.
- A missing or type-changed column.
- Too little history for a baseline, producing `insufficient_data`.
- An invalid credential, timeout, malformed CSV, and unavailable notification provider.
- Repeated identical failures, proving evidence is grouped without losing run history.
- An AI provider outage and malformed model output.
- An action payload changed after approval, proving the old approval is rejected.

## 4. Observability

Use structured JSON logs with request, workspace, user/service principal, source/dataset, queue job, check run, and incident IDs as appropriate. Log identifiers and safe summaries, not secrets or raw customer values.

Track at least:

- API request count/latency/error rate by route class.
- Worker queue depth, oldest job age, retry count, failed jobs, and processing duration.
- Source connection-test and check duration/failure rate.
- Scheduled run lateness and missed schedule count.
- Incident creation/grouping count by safe dimensions.
- Notification success/failure and delivery latency.
- AI report queue time, provider errors, token/cost use where available, and redaction failures.
- Object upload/parse failures and retention deletion backlog.

Health endpoints should distinguish liveness from readiness. Readiness reports dependency state without returning connection strings, credentials, or detailed internal topology to public callers.

## 5. Local development setup

Local dependencies should include PostgreSQL, Redis, and private S3-compatible storage. Keep real credentials out of source control. The `.env.example` should list variable names, safe local defaults where appropriate, and where to obtain development-only values.

Suggested local workflows:

1. Start backing services.
2. Install workspace dependencies using the pinned package manager version.
3. Apply Prisma migrations.
4. Seed fake users, workspace, and datasets.
5. Start API and worker separately.
6. Start the web app.
7. Use only synthetic files and local source databases.

Do not use a production connection string as a convenient local test source.

## 6. Deployment and release

### Environments

Use separate development, staging, and production credentials, storage buckets, databases, and signing keys. Staging should use synthetic or explicitly approved masked data.

### Release order

1. Build immutable application artifacts and scan dependencies/container images.
2. Confirm the migration is compatible with currently running code or use an expand/migrate/contract sequence.
3. Back up the application database and verify backup status.
4. Apply the migration through a controlled release job.
5. Deploy API and worker versions; monitor queue compatibility and health.
6. Deploy the web client.
7. Run smoke/acceptance checks with synthetic data.
8. Enable features and customer source egress gradually.
9. Record release version, migration IDs, and rollback/forward-recovery decision.

Do not roll back a database migration blindly after new writes exist. Prefer a documented forward fix or a compatible rollback plan.

### Backups and recovery

- Define recovery point and recovery time targets before public launch.
- Back up PostgreSQL and object metadata/data according to retention policy; encrypt backups and restrict restore permissions.
- Redis should be treated according to its configured persistence/queue semantics; verify recovery does not duplicate non-idempotent work.
- Test restoring into an isolated environment, including decryption key availability and object references.
- Document the order to restore database, object storage, Redis/queues, API, and workers.
- Reconcile queued jobs after restore; expired or duplicate jobs must remain safe.

## 7. Operator runbooks

### Queue backlog or stalled worker

1. Check worker health, Redis connectivity, oldest job age, and failed job counts.
2. Determine whether backlog is isolated to a queue or caused by a shared dependency.
3. Scale/restore worker capacity only after checking source concurrency limits.
4. Retry only jobs whose operations are idempotent and still valid.
5. Record the incident and confirm affected checks/notifications reach a terminal state.

### Source connection failure

1. Confirm whether the source is unreachable, credentials expired, TLS invalid, permissions changed, or a query timed out.
2. Show a safe diagnosis to the workspace user; do not paste secrets into logs or support tickets.
3. Pause repeated retries when failure is permanent.
4. Rotate credentials through the UI/secret store if authorized.
5. Re-run a bounded connection test and then resume schedules.

### Notification provider outage

1. Check delivery queue and provider status/error class.
2. Keep the incident visible in DataSentinel even if notification fails.
3. Retry transient errors with backoff; suppress invalid destinations until corrected.
4. Tell workspace admins that delivery failed without exposing webhook tokens.

### AI provider outage

1. Keep deterministic checks, incidents, evidence, and manual resolution available.
2. Mark report generation failed/retryable; do not block incident creation.
3. Review provider limits and redaction pipeline health before retry.
4. Do not silently route evidence to a different provider or region.

### Suspected secret exposure

1. Revoke/rotate the affected source or integration credential.
2. Disable the affected integration or source if needed.
3. Review audit events and access logs with the incident-response owner.
4. Determine affected workspaces and time window.
5. Restore only after confirming the new secret is stored and delivery/check paths are redacted.
6. Preserve a redacted incident timeline and follow the organization's notification obligations.

## 8. Product decisions still open

These are deployment/product choices, not facts to guess in code:

- First production host, region, and network architecture.
- Production email provider and delivery policy.
- AI provider/model, region, provider retention, per-workspace consent, and cost limits.
- Maximum CSV size/rows and supported encodings.
- Supported PostgreSQL versions and TLS requirements.
- Default history, document, audit, upload, and backup retention.
- Workspace role permissions for analysts and whether action approval requires two people.
- Support/SLA expectations and incident response ownership.
- Whether to enable pgvector and which PostgreSQL extension/hosting options support it.
- Whether imported/API data requires additional legal/privacy notices in target markets.

## 9. Launch readiness checklist

- [ ] Product acceptance criteria are demonstrated with synthetic data.
- [ ] Workspace isolation and role boundaries are reviewed.
- [ ] Read-only data-source access and all query limits are verified.
- [ ] Secret encryption, rotation, and redaction are verified.
- [ ] Incident deduplication, evidence retention, and resolution history are verified.
- [ ] Notification failures and AI provider outage do not hide data incidents.
- [ ] Action approval, expiry, payload binding, and audit trail are verified.
- [ ] Privacy/retention policy and user-facing disclosures are approved.
- [ ] Backup restore is rehearsed and measured against chosen recovery targets.
- [ ] Monitoring, operator alerts, and runbooks have named owners.
- [ ] Production secrets and egress controls are configured for the selected host.
- [ ] No unresolved critical security or reliability issue remains.
