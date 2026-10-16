# DataSentinel Product Specification

## 1. Product summary

DataSentinel monitors important business datasets and pipeline runs for freshness, completeness, validity, schema changes, and suspicious metric changes. A successful pipeline status is not enough: the data itself must also satisfy configured expectations.

When a check detects a problem, DataSentinel saves the result, links relevant history, creates or updates an incident, notifies the right people, and can prepare an AI investigation report. People decide what to do and record the resolution.

## 2. Problem and intended outcome

Data pipelines can report success while producing stale, incomplete, duplicated, structurally changed, or implausible data. Teams may discover this only after a dashboard, business decision, or customer-facing workflow has used the bad result.

DataSentinel aims to:

1. Detect configured data problems on a schedule or after an event.
2. Make the result understandable with an expected-versus-actual value and supporting evidence.
3. Create a durable incident with an owner, status, history, and resolution note.
4. Help the engineer investigate without presenting a guess as a fact.
5. Keep human approval in control of consequential actions.

## 3. Users and permissions

| Role            | Main responsibilities                                                | Typical access                                                            |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Workspace owner | Owns the workspace and controls administration                       | All workspace settings and membership; can transfer ownership             |
| Administrator   | Manages people, sources, integrations, and security settings         | Workspace configuration and operational records                           |
| Data engineer   | Connects sources, defines datasets and rules, investigates incidents | Create/edit sources, datasets, rules, schedules, and recovery proposals   |
| Analyst         | Checks data health and reviews incident evidence                     | Read sources/datasets/checks; comment on and acknowledge incidents (D-03) |
| Viewer          | Reads dashboards and reports                                         | Read-only workspace access                                                |

Permissions are enforced by the API for every request and every background action. Hiding a button in the web interface is not authorization.

## 4. Full product scope

### 4.1 Workspace and access

- User accounts, authenticated sessions, workspaces, invitations, and role assignment.
- Sign-in with email/password or an external identity provider; initial providers are Google and GitHub (D-01).
- Workspace-scoped records and audit events.
- Password reset and session revocation.
- A user may belong to multiple workspaces; every request selects and validates its active workspace.

### 4.2 Data sources and datasets

- Upload CSV files, register read-only PostgreSQL sources, configure approved HTTP/API checks, and accept pipeline-run events.
- Store a source owner, connection type, health, schedule, and last successful check.
- Register one or more datasets per source.
- Verify a connection before enabling scheduled checks.
- Support update, pause, reconnect, rotate credentials, and delete/archive flows.
- Never return a plaintext source secret after it has been saved.

### 4.3 Profiles and quality checks

- Profile column names, observed types, row count, null counts, duplicate counts where configured, and last update time.
- Store versioned schema snapshots and compare each new snapshot with the prior one.
- Support freshness, null, uniqueness, row-count, schema, range, and baseline-change rules.
- Show check history, actual values, expected values, duration, and safe error details.
- Allow a rule to be enabled, disabled, edited, and scoped to a dataset/column.

### 4.4 Pipeline reliability

- Record run start/end, status, trigger, source/dataset, safe summary, and external run identifier.
- Accept authenticated events from registered jobs and integrations.
- Provide a run timeline and associate failed checks with nearby pipeline runs.
- Retry only supported DataSentinel-managed demo/import/validation jobs after explicit approval.

### 4.5 Incidents and notifications

- Create an incident when a configured failure meets its rule's severity policy.
- Group repeated failures by workspace, dataset, and rule within a configurable incident window to avoid duplicate incident spam.
- Preserve each check result as evidence even when grouped into one incident.
- Assign, acknowledge, investigate, resolve, reopen, comment, and add a resolution note.
- Notify configured recipients through email, Slack, or a signed webhook. Track delivery attempts and failures.

### 4.6 AI investigation and documents

- Summarize observed facts, possible causes, evidence used, suggested checks, linked documentation, and confidence.
- Retrieve only workspace-authorized pipeline documentation and relevant incidents/checks.
- Keep facts and hypotheses in separate fields; cite evidence record IDs and document sections.
- Allow regenerate, dismiss, and feedback actions; retain a report version and the evidence snapshot used.
- Redact sensitive values before any external model call.
- Never let the model execute SQL, alter a source, change rule configuration, or trigger an action by itself.

### 4.7 Integrations and approved actions

- Email, Slack, and webhook notification targets.
- GitHub issue creation and n8n workflow trigger as optional action integrations.
- Each action shows its target, payload summary, required permission, and expected effect before approval.
- Approval is bound to the exact action payload; material payload changes invalidate the approval.
- Enforce idempotency and record requester, approver, execution result, and timestamps.

## 5. Out of scope

- Silent repair or direct write access to monitored production databases.
- Executing arbitrary SQL, shell commands, or model-generated code against a customer source.
- Claiming that an AI-generated cause is confirmed without evidence.
- Building a complex predictive ML model before transparent thresholds and baselines are validated.
- Replacing customers' orchestration platforms or their source-of-truth data warehouse.
- Promising a production SLA until hosting, staffing, monitoring, and recovery targets are selected and measured.

## 6. Functional requirements and acceptance criteria

### FR-01 — Workspace access

The system shall authenticate users and enforce role permissions within a selected workspace.

**Acceptance:** A user in workspace A cannot read or modify workspace B's source, dataset, incident, document, integration, or audit record by changing an ID in a request. Removed or downgraded members lose the corresponding access on their next request.

### FR-02 — Register and validate sources

The system shall register CSV, PostgreSQL, and approved HTTP/API sources and store their ownership and schedule.

**Acceptance:** A source must pass a safe connection check before scheduled monitoring is enabled. PostgreSQL monitoring uses read-only credentials and a bounded query timeout. Credentials never appear in API responses or logs.

### FR-03 — Register datasets

The system shall associate datasets with a source and provide a stable dataset identity across uploads or source schema changes.

**Acceptance:** A dataset detail page shows its source, owner, schedule, current health, and latest profile. Pausing the dataset stops future scheduled checks without deleting its history.

### FR-04 — Profile datasets

The system shall record an initial profile and subsequent profile snapshots.

**Acceptance:** A profile shows column name/type, row count, configured null/duplicate counts, and observation time. A failed or timed-out profile is recorded as an error, not as a zero-row dataset.

### FR-05 — Configure quality rules

The system shall support freshness, not-null, uniqueness, row-count, schema, range, and baseline-change rules with severity and enabled state.

**Acceptance:** Rule inputs are validated against a versioned schema; invalid rules cannot be scheduled. The rule detail explains its condition in plain language and shows recent results.

### FR-06 — Execute checks

The system shall run checks manually, on schedule, and after supported source/run events.

**Acceptance:** Every execution has a unique ID, start/end time, status, rule version, expected value, actual value where safe, and safe diagnostic. Duplicate queue delivery cannot create duplicate side effects or repeated incident creation.

### FR-07 — Detect schema drift

The system shall compare schema snapshots and report added, removed, renamed, or type-changed columns.

**Acceptance:** A drift record lists the previous and current schema and identifies missing/changed required fields. Renames are reported as a likely rename only when a configured heuristic supports it; otherwise they are represented as remove-plus-add.

### FR-08 — Detect understandable anomalies

The system shall compare configured metrics against user-set bounds or a transparent historical baseline.

**Acceptance:** The result names the comparison window, baseline calculation, current value, percentage/absolute difference, and threshold. If there is insufficient history, the check is `insufficient_data`/skipped rather than a false pass.

### FR-09 — Create and manage incidents

The system shall create or group an incident for qualifying failures and preserve linked evidence.

**Acceptance:** Incident detail shows dataset/pipeline, severity, failed rule, expected and actual value, start time, related runs, owner, status history, comments, and resolution. Repeated failures append evidence without erasing earlier results.

### FR-10 — Investigate with AI

The system shall generate a structured investigation from an evidence snapshot and authorized documents.

**Acceptance:** The report separates facts from possible causes, lists evidence IDs, proposes checks, states confidence and limitations, and shows generation time/model provider. If model service is unavailable, the incident remains usable and a retryable report status is shown.

### FR-11 — Alert people

The system shall send notifications for configured incident events and track delivery.

**Acceptance:** Each delivery record identifies destination, event, attempt count, status, and redacted failure reason. Retries use backoff and stop after a configured limit; repeated delivery is idempotent where the destination permits.

### FR-12 — Approve recovery actions

The system shall require explicit authorized approval before an external action executes.

**Acceptance:** An unapproved action cannot execute. The approver sees a readable preview. The exact approved payload is hashed/versioned; changed payload requires new approval. Execution and outcome are auditable.

### FR-13 — Audit changes

The system shall record security-sensitive configuration and action events.

**Acceptance:** Audit entries contain workspace, actor, action, target, time, request/correlation ID, and redacted before/after summary. Ordinary users cannot edit or delete audit entries through the application.

### FR-14 — Provide operational visibility

The system shall report API, worker, queue, connector, and notification health to operators without exposing customer secrets.

**Acceptance:** Operators can distinguish a failing source from a failing DataSentinel worker or external service. Queue retries and dead-letter items are visible and recoverable by an authorized operator.

## 7. Core states

| Record                | States                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Source                | `pending`, `healthy`, `degraded`, `failed`, `paused`, `archived`                                 |
| Check run             | `queued`, `running`, `passed`, `failed`, `warning`, `skipped`, `error`, `timed_out`, `cancelled` |
| Pipeline run          | `queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`, `unknown`                  |
| Incident              | `open`, `acknowledged`, `investigating`, `resolved`, `reopened`                                  |
| Notification delivery | `pending`, `sent`, `retrying`, `failed`, `suppressed`                                            |
| Recovery action       | `proposed`, `approved`, `rejected`, `running`, `succeeded`, `failed`, `cancelled`, `expired`     |
| AI report             | `not_requested`, `queued`, `ready`, `failed`, `stale`                                            |

State transitions are validated in the API; the browser cannot set arbitrary state values.

## 8. Product success measures

- A user can connect a demo PostgreSQL source or upload a CSV, register a dataset, and see its profile.
- A user can create a missing-row, null, duplicate, freshness, schema, or threshold anomaly and see the corresponding check result.
- A qualifying failure creates one understandable incident with linked evidence and history.
- The right configured recipient receives a notification, and delivery status is visible.
- An AI report clearly distinguishes evidence from hypotheses and does not expose protected values.
- A recovery action cannot run without a valid approval and leaves an audit trail.

## 9. Open questions

Requirements above that are ambiguous or underspecified. Each must be answered (and moved to the decision log) before the roadmap phase in the last column starts. Do not guess an answer in code.

| #    | Where              | Question                                                                                                                                                                                                          | Why it matters                                                    | Needed by |
| ---- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------- |
| Q-01 | §4.1, D-01         | **Resolved: D-09.** If a password account and a Google/GitHub sign-in share the same email, are they linked automatically (verified provider email only), linked only from a signed-in session, or kept separate? | Automatic linking on an unverified email allows account takeover. | Phase E   |
| Q-02 | §4.5, FR-05, FR-09 | What severity levels exist, and which create an incident? Does a `warning` check result open an incident or only show on the dashboard?                                                                           | "Severity policy" is used but never defined.                      | Phase H   |
| Q-03 | §4.5               | When a failure recurs after its incident was resolved, is the incident reopened or is a new one created? What is the default incident window?                                                                     | Determines the dedupe key and incident history behavior.          | Phase J   |
| Q-04 | FR-08, §7          | `insufficient_data` is not a check-run state. Should it be added as a state, or recorded as `skipped` with a reason code?                                                                                         | The state list and acceptance criterion disagree.                 | Phase H   |
| Q-05 | FR-08              | What is the default baseline: rolling mean or median of the last N runs, or a same-weekday comparison? What is the minimum history?                                                                               | "Transparent baseline" needs one documented formula.              | Phase H   |
| Q-06 | FR-03, §4.2        | **Resolved: D-10.** How does a new CSV upload attach to an existing dataset (user selects it, filename match, or one dataset per CSV source)? Is CSV freshness the upload time or a timestamp column?             | Stable dataset identity and freshness rules depend on it.         | Phase F   |
| Q-07 | §4.2               | What does an HTTP/API check measure (status code, latency, a JSON field value, a count)? Who approves a host for the allowlist?                                                                                   | "Approved HTTP/API checks" has no defined checks or approver.     | Phase G/H |
| Q-08 | §4.2               | **Resolved: D-11.** Is hard delete of a source ever allowed? If so, by which role, and what happens to its incidents, evidence, and audit records?                                                                | Delete versus archive affects retention and audit integrity.      | Phase F   |
| Q-09 | FR-14, §3          | "Operator" is not a workspace role. Is it DataSentinel platform staff (cross-workspace) or a view for workspace Administrators?                                                                                   | A cross-workspace role is a tenancy boundary exception.           | Phase I   |
| Q-10 | §4.5, FR-11        | Who is "the right recipient": the dataset owner, per-rule subscribers, or a workspace-wide channel?                                                                                                               | Notification routing model and data shape.                        | Phase K   |
| Q-11 | FR-12, §4.7        | Which roles may approve an action? Is self-approval blocked by default? How long does an approval stay valid before `expired`?                                                                                    | Approval policy defaults.                                         | Phase M   |
| Q-12 | §7                 | What makes a source `degraded` rather than `failed`? What makes an AI report `stale` (new evidence, rule change, time)?                                                                                           | State transitions must be validated in the API.                   | Phase G/L |
| Q-13 | §4.4               | Which DataSentinel-managed demo/import/validation jobs are retryable?                                                                                                                                             | Defines the full set of retryable actions.                        | Phase M   |
