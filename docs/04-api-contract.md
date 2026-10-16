# DataSentinel API Contract

This is the initial contract outline for the NestJS API. Treat it as the boundary between the web client, API, workers, and future integrations. Exact DTO field names can be finalized while implementing each endpoint, but authorization, state transitions, and error behavior must remain consistent.

## 1. General conventions

- Base path: `/api/v1`.
- JSON request/response bodies; UTF-8; HTTPS outside local development.
- Use UUIDs for public resource identifiers.
- Use UTC ISO 8601 timestamps.
- Validate every request body, path, and query parameter with a shared DTO/schema.
- Use cursor pagination for history and large lists: `limit` plus opaque `cursor`; enforce a maximum page size.
- Support `Idempotency-Key` for upload completion, pipeline events, manual run creation, and approved action execution.
- Return long-running work as `202 Accepted` with a resource/job ID and status URL.
- Use a consistent problem response: `type`, `title`, `status`, `detail`, `instance`, and stable application `code`. Never return stack traces or secret-bearing driver messages.
- Include a request/correlation ID on every response and in structured logs.
- Version breaking API changes under a new path or an explicit compatibility policy.

## 2. Authentication and workspace selection

Recommended browser flow: secure `HttpOnly`, `SameSite` session cookies with CSRF protection for state-changing requests. Rotate refresh/session credentials, hash stored tokens, set expiry, and revoke sessions after password reset or member removal. Do not store long-lived tokens in browser local storage.

| Method   | Endpoint                                           | Purpose                               | Permission                                                       |
| -------- | -------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `POST`   | `/auth/sessions`                                   | Sign in and create a session          | Public, rate limited                                             |
| `DELETE` | `/auth/sessions/current`                           | Sign out current session              | Authenticated                                                    |
| `GET`    | `/auth/me`                                         | Current user and memberships          | Authenticated                                                    |
| `POST`   | `/auth/password/reset-requests`                    | Request a reset link                  | Public, rate limited; response does not reveal account existence |
| `POST`   | `/auth/password/resets`                            | Set a new password with one-use token | Public, token validated                                          |
| `POST`   | `/workspaces`                                      | Create workspace                      | Authenticated                                                    |
| `GET`    | `/workspaces`                                      | List caller's workspaces              | Authenticated                                                    |
| `GET`    | `/workspaces/{workspaceId}`                        | Workspace settings                    | Member                                                           |
| `PATCH`  | `/workspaces/{workspaceId}`                        | Update workspace settings             | Owner/admin                                                      |
| `GET`    | `/workspaces/{workspaceId}/members`                | List members                          | Admin/owner; reduced fields for other roles if allowed           |
| `POST`   | `/workspaces/{workspaceId}/invitations`            | Invite member                         | Admin/owner, role ceiling enforced                               |
| `PATCH`  | `/workspaces/{workspaceId}/members/{membershipId}` | Change role/status                    | Admin/owner, ownership constraints enforced                      |

For all tenant routes, the server derives the acting user from authentication and verifies workspace membership and permission. A client-provided workspace ID selects context but does not grant access.

## 3. Sources and datasets

| Method   | Endpoint                                                          | Purpose                                          | Permission              |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------ | ----------------------- |
| `GET`    | `/workspaces/{workspaceId}/sources`                               | List sources with health summary                 | Member                  |
| `POST`   | `/workspaces/{workspaceId}/sources`                               | Create source metadata and encrypted credentials | Engineer/admin          |
| `GET`    | `/workspaces/{workspaceId}/sources/{sourceId}`                    | Source details without secret values             | Member                  |
| `PATCH`  | `/workspaces/{workspaceId}/sources/{sourceId}`                    | Rename, owner, schedule, or safe config          | Engineer/admin          |
| `POST`   | `/workspaces/{workspaceId}/sources/{sourceId}/connection-tests`   | Queue a connection check                         | Engineer/admin          |
| `POST`   | `/workspaces/{workspaceId}/sources/{sourceId}/credentials/rotate` | Replace credentials                              | Engineer/admin; audited |
| `POST`   | `/workspaces/{workspaceId}/sources/{sourceId}/pause`              | Pause checks                                     | Engineer/admin          |
| `POST`   | `/workspaces/{workspaceId}/sources/{sourceId}/resume`             | Resume checks                                    | Engineer/admin          |
| `DELETE` | `/workspaces/{workspaceId}/sources/{sourceId}`                    | Archive source; preserve history                 | Admin/owner             |
| `GET`    | `/workspaces/{workspaceId}/datasets`                              | List datasets                                    | Member                  |
| `POST`   | `/workspaces/{workspaceId}/datasets`                              | Register dataset                                 | Engineer/admin          |
| `GET`    | `/workspaces/{workspaceId}/datasets/{datasetId}`                  | Dataset detail                                   | Member                  |
| `PATCH`  | `/workspaces/{workspaceId}/datasets/{datasetId}`                  | Update name/owner/schedule metadata              | Engineer/admin          |
| `POST`   | `/workspaces/{workspaceId}/datasets/{datasetId}/profile-runs`     | Queue profile now                                | Engineer/admin          |
| `GET`    | `/workspaces/{workspaceId}/datasets/{datasetId}/profiles`         | Profile history                                  | Member                  |
| `GET`    | `/workspaces/{workspaceId}/datasets/{datasetId}/schema-history`   | Schema snapshot history and drift                | Member                  |

### Upload lifecycle

1. `POST /workspaces/{workspaceId}/sources/{sourceId}/uploads` creates an upload and returns an upload ID plus short-lived upload instructions.
2. The client uploads to private object storage.
3. `POST /workspaces/{workspaceId}/uploads/{uploadId}/complete` validates size/checksum and queues parsing.
4. `GET /workspaces/{workspaceId}/uploads/{uploadId}` returns parse/profile status.

Validate content independently of the filename and declared MIME type. Reject oversized files, unsafe encodings, malformed rows, and decompression bombs.

## 4. Rules and check history

| Method  | Endpoint                                               | Purpose                                      | Permission     |
| ------- | ------------------------------------------------------ | -------------------------------------------- | -------------- |
| `GET`   | `/workspaces/{workspaceId}/datasets/{datasetId}/rules` | List rules                                   | Member         |
| `POST`  | `/workspaces/{workspaceId}/datasets/{datasetId}/rules` | Create validated rule revision               | Engineer/admin |
| `GET`   | `/workspaces/{workspaceId}/rules/{ruleId}`             | Rule detail and recent result                | Member         |
| `PATCH` | `/workspaces/{workspaceId}/rules/{ruleId}`             | Create a new revision / change enabled state | Engineer/admin |
| `POST`  | `/workspaces/{workspaceId}/rules/{ruleId}/runs`        | Queue manual check                           | Engineer/admin |
| `GET`   | `/workspaces/{workspaceId}/check-runs`                 | Filtered check history                       | Member         |
| `GET`   | `/workspaces/{workspaceId}/check-runs/{checkRunId}`    | Result and safe evidence                     | Member         |
| `POST`  | `/workspaces/{workspaceId}/schedules`                  | Create schedule                              | Engineer/admin |
| `PATCH` | `/workspaces/{workspaceId}/schedules/{scheduleId}`     | Pause/update schedule                        | Engineer/admin |

The rule API accepts typed definitions, not raw database SQL. The API returns the stored rule revision ID on each check run.

## 5. Pipeline runs and inbound events

| Method  | Endpoint                                                  | Purpose                                        | Permission                                        |
| ------- | --------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------- |
| `POST`  | `/workspaces/{workspaceId}/pipeline-runs`                 | Record a run from an authenticated integration | Scoped integration credential                     |
| `PATCH` | `/workspaces/{workspaceId}/pipeline-runs/{pipelineRunId}` | Complete/update run state                      | Same integration principal or authorized engineer |
| `GET`   | `/workspaces/{workspaceId}/pipeline-runs`                 | Filtered run history                           | Member                                            |
| `GET`   | `/workspaces/{workspaceId}/pipeline-runs/{pipelineRunId}` | Run detail and related checks                  | Member                                            |

Inbound events require a signed request or scoped token, timestamp/replay check, rate limit, schema validation, and idempotency key. Keep log summaries bounded and redact them before storage.

## 6. Incidents and reports

| Method  | Endpoint                                                          | Purpose                                              | Permission                                  |
| ------- | ----------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| `GET`   | `/workspaces/{workspaceId}/incidents`                             | Filter by status, severity, owner, dataset, and time | Member                                      |
| `GET`   | `/workspaces/{workspaceId}/incidents/{incidentId}`                | Incident, evidence, history, and current report      | Member                                      |
| `PATCH` | `/workspaces/{workspaceId}/incidents/{incidentId}`                | Assign, acknowledge, investigate, or resolve         | Engineer/admin; analysts if policy allows   |
| `POST`  | `/workspaces/{workspaceId}/incidents/{incidentId}/comments`       | Add comment                                          | Member with incident-comment permission     |
| `POST`  | `/workspaces/{workspaceId}/incidents/{incidentId}/investigations` | Queue AI report generation                           | Engineer/admin; optional analyst permission |
| `GET`   | `/workspaces/{workspaceId}/incidents/{incidentId}/investigations` | List report versions/status                          | Member                                      |
| `POST`  | `/workspaces/{workspaceId}/investigations/{reportId}/feedback`    | Record useful/not-useful feedback                    | Member                                      |

Resolve requests require a resolution note. Reopening requires a reason and creates a new status-history event. Evidence is immutable; additional evidence is appended.

## 7. Integrations, notifications, and actions

| Method         | Endpoint                                                             | Purpose                                           | Permission                                                    |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| `GET/POST`     | `/workspaces/{workspaceId}/alert-destinations`                       | List/create email, Slack, or webhook destinations | Admin/owner for secrets; engineer may configure within policy |
| `PATCH/DELETE` | `/workspaces/{workspaceId}/alert-destinations/{destinationId}`       | Update/disable/archive destination                | Admin/owner                                                   |
| `POST`         | `/workspaces/{workspaceId}/alert-destinations/{destinationId}/test`  | Send a test notification                          | Admin/owner; audited                                          |
| `GET`          | `/workspaces/{workspaceId}/notification-deliveries`                  | View delivery status                              | Member; secret-free                                           |
| `GET/POST`     | `/workspaces/{workspaceId}/documents`                                | Register/list pipeline documentation              | Engineer/admin                                                |
| `POST`         | `/workspaces/{workspaceId}/documents/{documentId}/index-runs`        | Reindex a document                                | Engineer/admin                                                |
| `POST`         | `/workspaces/{workspaceId}/incidents/{incidentId}/action-proposals`  | Propose typed recovery/integration action         | Engineer/admin                                                |
| `POST`         | `/workspaces/{workspaceId}/action-proposals/{proposalId}/approvals`  | Approve or reject exact payload                   | Authorized approver                                           |
| `POST`         | `/workspaces/{workspaceId}/action-proposals/{proposalId}/executions` | Execute approved action                           | Authorized engineer; worker revalidates approval              |
| `GET`          | `/workspaces/{workspaceId}/audit-events`                             | Search audit events                               | Admin/owner; restricted fields                                |

## 8. Example responses

### Queue a manual check

```json
{
  "checkRunId": "<uuid>",
  "status": "queued",
  "statusUrl": "/api/v1/workspaces/<workspaceId>/check-runs/<checkRunId>"
}
```

### A failed rule result

```json
{
  "id": "<uuid>",
  "status": "failed",
  "rule": { "id": "<uuid>", "revision": 3, "type": "row_count_change" },
  "expected": { "minimumRows": 7000 },
  "actual": { "rowCount": 2810, "changePercent": -60.2 },
  "startedAt": "<UTC timestamp>",
  "endedAt": "<UTC timestamp>",
  "incidentId": "<uuid>"
}
```

Sample values above illustrate shape only; do not hard-code these IDs or numbers.

## 9. Error and concurrency behavior

- `400` invalid request; `401` unauthenticated; `403` authenticated but forbidden; `404` missing or intentionally undisclosed tenant resource; `409` conflict/idempotency mismatch/state conflict; `413` upload too large; `429` rate limited; `5xx` unexpected service failure.
- Check-run creation returns a queued resource; poll or subscribe to a future event stream only after the polling contract is stable.
- Use optimistic concurrency (`version` or `updatedAt` precondition) for edits to rules, integrations, and incident state to avoid silent lost updates.
- Never let API retries create a second incident/action. Enforce idempotency server-side, not only in the browser.
