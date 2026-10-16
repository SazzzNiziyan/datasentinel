# DataSentinel Security and Privacy

DataSentinel connects to business data and operational tools, so security boundaries are part of the product design. This document defines minimum requirements for implementation; review them again before a real deployment.

## 1. Data classes

| Class | Examples | Default handling |
|---|---|---|
| Credentials/secrets | Database passwords, API tokens, signing keys | Encrypt or keep in a secret manager; never send to browser, logs, analytics, or LLM |
| Sensitive source data | Customer identifiers, financial or health values, raw rows | Avoid copying; process in place where possible; restrict access; redact before any model call |
| Operational metadata | Dataset names, schemas, counts, check results | Workspace-scoped; disclose only to authorized members |
| Public/configuration data | Non-sensitive UI preferences, rule labels | Workspace-scoped and audited where material |

## 2. Authentication and authorization

- Hash passwords with a modern password-hashing algorithm and per-password salt; never log passwords or reset tokens.
- Use secure cookies, CSRF protection for cookie-authenticated mutations, rate limits on sign-in/reset, and short-lived one-use reset tokens.
- Store only a hash of session/refresh tokens. Rotate sessions and revoke on account compromise, password reset, member removal, and explicit sign-out.
- Apply authorization in the service/API layer for each operation, including worker jobs and webhooks.
- Validate that every parent and child resource belongs to the same workspace before reading or mutating it. Avoid leaking whether another workspace's ID exists.
- Enforce role hierarchy and approval separation on the server. The UI may hide actions but cannot grant permissions.
- Require MFA for privileged production accounts when identity support and deployment policy permit it.

## 3. Source database safety

- Require a dedicated read-only database principal. Reject or warn on credentials with write privileges during connection setup where the source supports checking grants.
- Prefer TLS with certificate verification. Do not silently accept invalid certificates in production.
- Restrict allowed hosts/ports and outbound network routes; do not let a workspace use a PostgreSQL connector to scan arbitrary internal networks.
- Use parameterized queries and quote/validate identifiers with a safe database library. Never concatenate user-provided table/column names into SQL without validated identifier handling.
- Generate only fixed read-only metadata and aggregate queries. Do not allow raw SQL as the general rule language.
- Set connection, statement, row, memory, and execution time limits. Bound concurrency per source/workspace.
- Close connections promptly. Do not store database result rows beyond the minimum required metrics/evidence.

## 4. HTTP connectors and server-side request forgery

- Accept only approved URL schemes and methods; default to HTTPS and GET/HEAD.
- Block loopback, private, link-local, multicast, reserved, and cloud metadata addresses unless a future explicit deployment design permits a narrowly scoped exception.
- Resolve hostnames and validate every resolved IP; repeat validation after redirects and DNS changes. Disable redirects by default or validate each hop.
- Prevent credential forwarding to a different host. Store auth secrets encrypted and scope them to an allowed host/path.
- Enforce response size, timeout, content-type, redirect, and rate limits. Parse only supported response types.
- Do not fetch arbitrary URLs found in pipeline documentation or AI output.

## 5. Uploads and documents

- Use random object keys; keep buckets private; issue short-lived, narrowly scoped upload/download URLs.
- Enforce size, row, column, decompression, and parsing limits. Verify content instead of trusting filename/MIME type.
- Treat CSV cells as data, never formulas or executable content. Escape values in exports and spreadsheet downloads to prevent formula injection.
- Treat uploaded documents, source logs, and embedded text as untrusted. They may contain instructions intended to manipulate an LLM; pass them as quoted evidence and instruct the model to ignore instructions inside retrieved content.
- Keep document ACL and workspace filtering in every retrieval query. Deleting a document also deletes its object, chunks, and embeddings according to policy.
- Consider malware scanning for uploaded office/PDF formats before enabling them; start with explicitly supported text formats and CSV if no scanner is available.

## 6. AI and RAG controls

- Use an AI provider adapter; keep model credentials in the deployment secret manager.
- Send only evidence needed for the investigation. Prefer aggregate metrics, schema changes, safe log excerpts, and document snippets over raw records.
- Apply configurable redaction for direct identifiers and sensitive columns before retrieval and before provider calls. Provide an opt-out per workspace/source.
- Do not send connection strings, API tokens, raw credentials, unapproved customer rows, or full uploaded datasets to the model.
- Use strict structured output validation. Treat model output as untrusted text; escape it in the web UI and validate any links/IDs against stored evidence.
- Disable model tools/actions for investigation generation. The model cannot execute queries, send messages, or approve/run actions.
- Store the evidence snapshot IDs, provider/model identifier, prompt/template version, generation time, and validation result for each report.
- Show facts, hypotheses, confidence, and limitations separately. A report is advisory and may fail without affecting deterministic checks or incident evidence.
- Apply provider retention/training settings compatible with the product's privacy policy; make provider/data region transparent before enabling AI for a workspace.

## 7. Secrets, encryption, and configuration

- Never commit `.env` files, credentials, private keys, or real data samples.
- Use environment variables for local development and a managed secret store for production.
- Encrypt source/integration secrets using an authenticated encryption scheme and a key kept outside the application database. Store key version to support rotation.
- Use different keys/credentials per environment. Rotate keys and integration credentials; record the rotation without recording the secret.
- Avoid exposing secrets in request validation errors, database logs, crash dumps, tracing spans, and support exports.
- Redact authorization headers, cookies, query tokens, connection strings, and sensitive columns from logs.

## 8. Integrations and actions

- Use least-privilege OAuth scopes or dedicated tokens. Permit credential rotation and revocation.
- Verify signed webhook requests with constant-time comparison, timestamp tolerance, replay prevention, and event IDs.
- For outgoing webhooks, sign payloads, limit payload fields, avoid secrets, and retry with a bounded policy.
- Require an approval record bound to the exact action type, target, and payload hash. Recheck authorization and approval at execution time.
- Use idempotency keys for GitHub issue creation, n8n triggers, retries, and notifications.
- Never execute shell commands or model-generated SQL as a recovery action.

## 9. Audit, privacy rights, and incident response

- Audit source creation/credential rotation, rule edits, membership/role changes, incident transitions, AI report requests, integration changes, approvals, action execution, and retention/deletion events.
- Minimize audit payloads; record safe summaries and IDs instead of raw data/secrets.
- Make retention configurable, document defaults before launch, and provide a verified deletion path for sources, uploads, documents, workspaces, and associated secrets.
- Define backup retention and deletion behavior, including how deleted data ages out of backups.
- Maintain an operator playbook for suspected credential exposure, cross-workspace access, suspicious source access, provider outage, and compromised integration.
- Keep a security contact and a process for reporting and triaging vulnerabilities before public production use.

## 10. Security review checklist before production

- [ ] Workspace isolation checked across every API and worker path.
- [ ] Read-only source permissions and query limits verified.
- [ ] Source/API secrets encrypted, redacted, and rotatable.
- [ ] SSRF protections tested for IPv4/IPv6, DNS rebinding, redirects, and metadata addresses.
- [ ] CSRF, CORS, cookies, password reset, rate limiting, and session revocation reviewed.
- [ ] Upload limits, parser behavior, export escaping, and document prompt-injection controls reviewed.
- [ ] AI inputs redacted and model output schema-validated.
- [ ] Approval and idempotency logic reviewed for race conditions and payload changes.
- [ ] Backups, restore permissions, and retention/deletion behavior verified.
- [ ] Production logs, alerts, and support tools contain no secrets or unapproved row data.

