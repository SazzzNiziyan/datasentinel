# DataSentinel Small-Step Build Roadmap

This roadmap builds the full product in dependency order. Each checkbox is intended to be one short Claude Code task. Keep the full product scope; finish one small item, understand it, and then move to the next.

## Current status (handoff)

Keep this section current after every item so another agent can continue.

- **Last updated:** 2026-10-18. **Done:** 136 of 148 items. Phases A to D are complete; Phase E is complete except two blocked items; Phase F is complete except the PostgreSQL branch of the add-source flow (waits for Phase G).
- **Uncommitted work:** the user commits; check `git status` first. Everything since D-20 may be uncommitted.
- **Blocked, needs the user:** Google/GitHub sign-in needs development OAuth app credentials in `.env`. D-04, D-05, D-07 are needed later (hosting, production storage/secrets, LLM). D-06 and D-08 were decided on 2026-10-17.
- **Next item:** the first unchecked, unblocked box below (Phase F is done except the PostgreSQL branch of the add-source flow, which waits for Phase G; Phases G, H, and I are complete; Phase J is complete; Phase K is complete; Phase L is complete; Phase M is complete; Phase N is in progress). Decisions D-01 to D-128 are in `docs/09-decision-log.md`.
- **Run commands:** see `CLAUDE.local.md` if present (pnpm/fnm PATH line for tool shells). Gate: `pnpm check`. Services: `pnpm services:up` (Docker Desktop must run). Database: `pnpm --filter @datasentinel/db migrate:dev` (interactive) or the non-interactive steps in D-36; seed with `pnpm --filter @datasentinel/api build && pnpm --filter @datasentinel/api seed`.
- **Integration tests** (database, Redis, storage) run when local services are up and are skipped otherwise.

## 1. Claude Code plugin setup

Install these existing marketplace plugins in Claude Code:

| Plugin                                                                                | When to use it                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Learning Output Style](https://claude.com/marketplace/plugins/learning-output-style) | Keep it active while building. It explains decisions and may ask you to write small, meaningful pieces of code while Claude handles routine setup.                |
| [Feature Dev](https://claude.com/plugins/feature-dev)                                 | Use `/feature-dev` for a bounded feature, especially API, database, worker, security, and end-to-end slices. State exactly which one small checkbox to implement. |
| [Frontend Design](https://claude.com/marketplace/plugins/frontend-design)             | Use while implementing the Bauhaus design system, pages, responsive layouts, and UI polish. It is a frontend aid, not the backend workflow.                       |

There is no need to install a backend plugin tied to a different stack such as Convex. Feature Dev can guide general backend features; Claude Code writes the Node/NestJS/PostgreSQL code. You can add a documentation lookup plugin later if current framework docs become a recurring problem, but it is not required to start.

### Reusable session prompt

Paste this at the start of a build session, then name only one unchecked task:

> We are building the complete DataSentinel product described in `README.md` and `docs/`. Our stack is React + TypeScript, NestJS + TypeScript, PostgreSQL + Prisma, Redis + BullMQ, and private S3-compatible storage. Follow the Bauhaus rules in `docs/06-design-system.md`. Implement only this task: **[copy one unchecked item]**. First tell me the goal, terms, files likely to change, and how this task fits the architecture. Keep the change small. Explain what you changed and how I can verify it. Do not skip security, tenant isolation, or human approval rules. Stop after this task and wait for me to say “next.”

When using `/feature-dev`, use it for the bounded task above. For a visual task, ask Frontend Design to use the existing tokens and screen rules; do not let it invent a different visual system.

## 2. Phase A — Requirements and decisions

- [x] Create the repository and copy this documentation into its `docs/` folder.
- [x] Read the product specification and mark any requirement that is unclear (see spec §9).
- [x] Decide whether sign-in starts with email/password, an identity provider, or both.
- [x] Decide the initial workspace roles and whether analysts may acknowledge/comment on incidents.
- [ ] Decide the first deployment region and hosting provider before production configuration.
- [ ] Select the production object-storage provider and secret manager.
- [ ] Select an email provider and decide whether Slack/webhook integrations are enabled at first launch.
- [ ] Select the LLM provider, model, region, retention controls, and workspace opt-out behavior for product AI reports.
- [x] Set initial upload limits, source query timeouts, check schedule minimums, and retention defaults. (D-08)
- [x] Record unresolved choices in a decision log rather than silently guessing.

**Phase gate:** scope and policy decisions are written down; unresolved deployment decisions are labeled as open.

## 3. Phase B — Repository and local development foundation

- [x] Initialize Git and add a `.gitignore` for Node builds, local databases, secrets, uploads, and editor files.
- [x] Select a supported Node LTS version and pin it for local/CI use (Node 26: `.nvmrc`, `engines`, `engineStrict`).
- [x] Initialize a pnpm workspace; add a monorepo tool only if it simplifies shared packages. (D-12: no monorepo tool yet)
- [x] Create empty `apps/web`, `apps/api`, `apps/worker`, `packages/contracts`, and `prisma` folders.
- [x] Add TypeScript configurations with strict type checking. (D-13; verified against real NestJS 12 and Vite 8 + React apps)
- [x] Add formatting/linting configuration and a root command for each app. (D-14)
  - Lint note (D-14): DI safety comes from `experimentalDecorators` + `emitDecoratorMetadata` in each Nest tsconfig (typescript-eslint reads them and skips decorated files); parser options cannot replace them. Nothing detects a hand-written `import type` of an injected class, so the boot test stays required.
- [x] Add `.env.example` with variable names and safe placeholders only.
- [x] Add configuration parsing that fails early when required values are missing or invalid. (`packages/config`; called from each app entry point when the Nest scaffold lands)
- [x] Add a short local setup section to the repository README. (extend as services and apps land)

**Phase gate:** a clean checkout can install dependencies and start each scaffold with no real credentials committed.

Verified 2026-10-17: a clean copy installs with `--frozen-lockfile` and passes `pnpm check`; no credentials are committed. The apps are still placeholders, so "start" means each entry point runs; real start commands arrive with the Nest and Vite scaffolds. Use `pnpm clean` (root script) to remove build output; `pnpm -r clean` is pnpm's built-in that deletes every `node_modules`.

## 4. Phase C — Bauhaus UI foundation

- [x] Install Frontend Design and provide it `docs/06-design-system.md`. (plugin active; React + Vite scaffold added)
- [x] Create design tokens for ink, paper, surfaces, signal colors, borders, typography, and spacing. (D-15; contrast enforced by tests)
- [x] Build the global app shell: workspace header, left navigation, page frame, and account menu. (D-16; sample session in `apps/web/src/app/sampleSession.ts`)
  - Vite scaffold notes (D-13): `vite.config.ts` with `resolve.conditions: ['@datasentinel/source', ...defaultClientConditions]` and `envDir: '../..'`; `tsconfig.node.json` extending the base (`noEmit`, `incremental`, `types: ["node"]`, include `vite.config.ts`) referenced from `apps/web/tsconfig.json`; `src/vite-env.d.ts` typing each `VITE_*` variable with `strictImportMetaEnv`; scripts `dev`, `build` (`tsc -b && vite build`), `preview`.
- [x] Build reusable status, severity, metric, table, empty-state, and confirmation components. (D-17; `EvidenceRow`, `RuleSummary`, `Timeline`, table filters/pagination, and dialog approval state are built with the screens that need them)
- [x] Create responsive loading, error, empty, and permission-denied states. (D-18; also the offline banner and a per-page crash boundary; preview at `/dev/components`)
- [x] Build static versions of Dashboard, Incidents, Sources, Datasets, and Settings screens using clearly labeled sample data. (D-19; sample values only in `apps/web/src/sample/sampleData.ts`)
- [x] Check keyboard focus, labels, status text, contrast, and narrow-screen behavior. (D-20; axe-core test on every screen)
  - Include: move focus to the page heading (and announce it) on route change; after choosing a link in the mobile drawer, focus should land on the new page, not the Menu button.
- [ ] Remove sample data before any screen is presented as connected to live services.

**Phase gate:** users can navigate a coherent, responsive interface; every state is visibly sample or connected.

## 5. Phase D — Local services and backend skeleton

- [x] Add local PostgreSQL to the development container setup. (D-21; `compose.yaml`)
- [x] Add local Redis to the same setup. (D-21)
- [x] Add local MinIO or another S3-compatible storage service for development. (D-21; SeaweedFS)
- [x] Add a health endpoint to the NestJS API. (D-22; `/health/live`, `/health/ready`)
  - Nest scaffold notes (D-13), same for the worker: `tsconfig.build.json` extending `tsconfig.json` with `noEmit: false`, `rootDir: src`, `outDir: dist` and its own `tsBuildInfoFile`; `nest-cli.json` with `tsConfigPath: tsconfig.build.json`; `build` script builds contracts first (`tsc -b ../../packages/contracts && nest build`); `--conditions=@datasentinel/source` in dev scripts only, never in production start commands; start scripts set `NODE_ENV` and load the root `.env` with `node --env-file` (NODE_ENV must never live in `.env`: Vite would ship development React); do not add `typescript` or `@types/node` to the app (they would shadow the root versions); add an e2e test that boots the module so an `import type` on an injected class is caught.
- [x] Add API request IDs and structured logging with secret redaction. (D-23)
- [x] Add a separate NestJS worker entry point. (D-24)
- [x] Add BullMQ connection and one harmless sample job for local wiring. (D-24; `sample-job` script)
- [x] Add a basic web-to-API health check with a clear disconnected state. (D-25)

**Phase gate:** local services start and stop predictably; health checks identify each dependency.

## 6. Phase E — Database and workspace access

- [x] Create the initial Prisma schema for users, sessions, workspaces, and memberships. (D-26; `packages/db`)
- [x] Create and apply the first migration locally. (D-26; `pnpm --filter @datasentinel/db migrate:dev`)
- [x] Add a seed command that creates only fake development accounts/data. (D-27)
- [x] Implement sign-in and sign-out with secure session handling. (D-28; email/password)
  - [ ] Add Google and GitHub sign-in with account linking (D-01, D-09). Needs development OAuth apps: set `GOOGLE_CLIENT_ID/SECRET` and `GITHUB_CLIENT_ID/SECRET` in `.env` first.
- [x] Implement `/auth/me` and the workspace list. (D-29)
- [x] Implement workspace creation and initial owner membership in one transaction. (D-30)
- [x] Add a workspace permission guard and use it on one read endpoint. (D-31)
- [x] Add invitations and accept/revoke flows. (D-40; copy-link per D-06)
- [x] Add role changes and session revocation after member removal/downgrade. (D-32; access is re-checked on every request, so no session revocation is needed for one workspace)
- [x] Add audit events for sign-in security events, membership changes, and workspace settings. (D-33)
- [x] Attempt cross-workspace access during manual verification and confirm it is denied. (2026-10-17: seeded Ana (Northwind engineer) got 404 `workspace_not_found` for GET, PATCH, and members of the Contoso workspace; Contoso unchanged. Automated in `apps/api/test/workspace-access.test.ts`.)
- [x] Connect the web app to the API session: sign-in page, `/auth/me` replaces `sampleSession`, workspace from the membership list, sign-out in the account menu. (Added: the phase gate needs workspace access in the UI too.) (D-34)

**Phase gate:** workspace-scoped access works in API and UI; every tenant-owned route checks membership.

## 7. Phase F — Data sources and CSV ingestion

- [x] Define the connector interface and normalized safe error format. (D-35; `packages/connectors`)
- [x] Add source and dataset metadata models and migrations. (D-36)
- [x] Add source and dataset list/detail API routes with workspace authorization. (D-37)
- [ ] Build the source list and add-source UI flow. Source and dataset lists are live (D-39); CSV (D-44) and PostgreSQL (D-47) sources can be added. **Still waiting:** the connection test ("validate") and table choice in Phase G, and schedules in Phase I.
- [x] Add private object storage configuration and random object keys. (D-38)
- [x] Add upload initiation and completion endpoints. (D-41)
- [x] Enforce file-size, row-size, encoding, and content validation limits. (D-08: 50 MB, UTF-8, 1,000 columns, 1 MB rows; D-42)
- [x] Add streaming CSV parsing in the worker; reject malformed/oversized input safely. (D-42)
- [x] Save an initial CSV profile and schema snapshot. (D-43)
- [x] Show upload status, parse errors, and profile results in the UI. (D-44)
- [x] Add pause, resume, and archive behavior for sources/datasets. (D-45)

**Phase gate:** a user can upload a CSV, register a dataset, and view a safe profile without loading the whole file into browser memory.

## 8. Phase G — PostgreSQL monitoring connector

- [x] Define source credential encryption and key-version handling. (D-46)
- [x] Add the PostgreSQL source form and keep secret fields write-only. (D-47)
- [x] Validate host, port, database, TLS policy, and allowed network destinations. (D-48; resolved-address check runs with the connection test)
- [x] Add a connection-test worker with timeout and redacted output. (D-49)
- [x] Document creation of a read-only PostgreSQL principal for demo and customer setups. (`docs/10-postgres-read-only-setup.md`)
- [x] Implement safe discovery of schemas/tables with generated read-only queries. (D-50)
- [x] Let an engineer select a table/view and register a stable dataset locator. (D-51)
- [x] Profile columns, types, row count, and supported null/duplicate counts. (D-52; duplicate counts with Phase H rules)
- [x] Add credential rotation without exposing old/new secrets. (D-53)
- [x] Add per-source concurrency and query timeouts. (D-54)
- [x] Verify the connector never performs writes and records a failed check on access/timeout errors. (D-55)

**Phase gate:** an authorized read-only PostgreSQL source can be checked without unbounded query or network behavior.

## 9. Phase H — Profiles, schema drift, and rules

- [x] Define immutable profile and schema snapshot models. (D-43: append-only triggers)
- [x] Store exact/approximate method and observation time for each profile metric. (D-56)
- [x] Compare schema snapshots and produce added/removed/type-changed fields. (D-57)
- [x] Implement rule definition validation with versioned schemas. (D-58; answers Q-02, Q-04, Q-05)
- [x] Add the freshness rule. (D-59)
- [x] Add the not-null rule. (D-60)
- [x] Add the uniqueness/duplicate rule with an explicit scan-cost limit. (D-61)
- [x] Add minimum/maximum row-count rules. (D-62)
- [x] Add range rules for supported numeric/date types. (D-63)
- [x] Add schema-required-column/type rules. (D-64)
- [x] Add configurable row-count/metric change rules against 7/30-day history. (D-65)
- [x] Return `insufficient_data` when baseline history is too short. (D-65)
- [x] Save a rule revision whenever definition/severity changes. (D-66)
- [x] Build the rule builder with a plain-language preview and validation state. (D-67)
- [x] Display profile and check history with method, units, and comparison window. (D-68)

**Phase gate:** each supported rule has a deterministic result, a revision, a visible history entry, and a bounded query strategy.

## 10. Phase I — Scheduling and pipeline-run history

- [x] Define schedule schema, timezone behavior, and allowed minimum interval. (D-69)
- [x] Add the scheduler process and unique schedule-occurrence key. (D-70)
- [x] Enqueue due profile/check jobs and record the resulting run ID. (D-71)
- [x] Add pause/resume/update schedule endpoints and UI. (D-72)
- [x] Define pipeline-run event authentication and idempotency contract. (D-73)
- [x] Add pipeline-run create/update endpoints for external jobs. (D-74)
- [x] Add status timeline and run filters. (D-75)
- [x] Correlate nearby pipeline runs with failed checks using documented time/ID rules. (D-76)
- [x] Add queue attempt/backoff/terminal failure settings. (D-77)
- [x] Add authorized operator visibility for stalled/failed queue jobs. (D-78)

**Phase gate:** scheduled and event-triggered jobs are durable, idempotent, and understandable from the UI.

## 11. Phase J — Incidents and evidence

- [x] Define incident deduplication key and grouping window. (D-79)
- [x] Create an incident on a qualifying failed check in a transaction-safe flow. (D-80)
- [x] Store immutable check/profile/schema/run evidence references. (D-81)
- [x] Build incident list filters and severity/status sorting. (D-82)
- [x] Build incident detail with expected/actual values and related runs. (D-83)
- [x] Implement acknowledge, investigate, assign, resolve, and reopen transitions. (D-84)
- [x] Require and preserve a resolution note. (D-84)
- [x] Add comments and status/assignment history. (D-85)
- [x] Add owner notifications as pending outbox events. (D-86)
- [x] Verify repeated check failures append evidence instead of creating duplicate incident spam. (D-87)

**Phase gate:** one data problem is traceable from rule revision through check run, incident, evidence, owner, and resolution.

## 12. Phase K — Alerts and integrations

- [x] Define typed integration and alert-destination configuration. (D-88)
- [x] Add email delivery adapter with safe templates and delivery records. (D-89)
- [x] Add Slack notification adapter with least-privilege configuration. (D-90)
- [x] Add signed outgoing webhook delivery. (D-91)
- [x] Add destination test action with explicit confirmation. (D-92)
- [x] Add retries, deduplication, and delivery status UI. (D-93)
- [x] Add credential rotation and disable/archive flows. (D-94)
- [x] Add scoped inbound pipeline webhook authentication and replay protection. (D-95)
- [x] Add GitHub issue and n8n adapters behind feature/configuration flags. (D-96)
- [x] Ensure integrations never receive raw source rows or secrets by default. (D-97)

**Phase gate:** delivery failures are visible and retryable; each integration has bounded permissions and audited configuration.

## 13. Phase L — AI investigation and documentation retrieval

- [x] Decide whether AI is enabled globally and per workspace; record provider, region, and retention policy. (D-99)
- [x] Define the structured investigation report schema. (D-100)
- [x] Implement the provider-neutral LLM adapter with timeout, budget, and retry limits. (D-101)
- [x] Implement redaction/minimization before provider calls. (D-102)
- [x] Add supported pipeline-document upload and safe text extraction. (D-103)
- [x] Store workspace-scoped document chunks and source section metadata. (D-104)
- [x] Add full-text retrieval; add pgvector only if a reviewed need exists and extension support is confirmed. (D-105)
- [x] Build a prompt that separates trusted incident facts from untrusted retrieved text and ignores instructions inside documents/logs. (D-106)
- [x] Validate model output against the schema and reject invalid output safely. (D-107)
- [x] Store report versions with evidence IDs, template/provider version, and status. (D-108, D-109)
- [x] Show facts, hypotheses, suggested checks, confidence, and limitations distinctly in the incident UI. (D-111)
- [x] Add report regeneration, feedback, opt-out, and provider-failure behavior. (D-110)
- [x] Verify no direct identifiers, raw rows, credentials, or unapproved content reach the provider. (D-112)

**Phase gate:** AI is advisory, evidence-linked, redacted, auditable, and non-blocking for core checks/incidents.

## 14. Phase M — Approved recovery actions

- [x] Define typed action schemas for validation rerun, supported demo/import retry, notification, GitHub issue, and n8n trigger. (D-113)
- [x] Create action proposal and exact payload preview. (D-113)
- [x] Define who may request, approve, reject, and execute each action. (D-115)
- [x] Add payload hash and expiry to the approval record. (D-114)
- [x] Prevent self-approval where the workspace policy requires a second person. (D-116)
- [x] Recheck permission, approval, payload hash, expiry, and idempotency in the worker. (D-118)
- [x] Add execution log, safe output, retry policy, and audit events. (D-117)
- [x] Confirm that no action can write to a monitored source database. (D-119)

**Phase gate:** no action starts without a current valid approval, and every result is attributable.

## 15. Phase N — Finish, harden, deploy, and operate

- [x] Review all API routes for permission and workspace checks. (D-120)
- [x] Review all logs, job payloads, errors, and AI inputs for secrets/raw data. (D-128)
- [x] Add versioned migrations and an upgrade/rollback procedure. (D-122)
- [ ] Add automated checks for API, UI, worker, connector, authorization, and critical acceptance paths.
- [x] Add synthetic datasets that demonstrate healthy, stale, incomplete, duplicate, schema-drift, and 60%-drop cases. (D-123)
- [x] Add health/readiness endpoints and operational metrics for queues, sources, checks, alerts, and AI failures. (D-121)
- [ ] Add backup and restore instructions; perform a restore rehearsal before production.
- [x] Add container build and deployment configuration for isolated environments. (D-124)
- [ ] Configure TLS, DNS, secret manager, database/Redis networking, object-store policy, and outbound source allowlists.
- [x] Add release notes and a migration gate. (D-125)
- [ ] Run a staging end-to-end acceptance walkthrough with fake/synthetic data.
- [ ] Verify retention/deletion and incident-response runbooks.
- [ ] Review permissions and feature flags before enabling customer connections.

**Phase gate:** production deployment has tested backups, monitoring, secret rotation, incident response, and a verified end-to-end walkthrough.

## 16. How to keep each AI coding session small

For every checkbox:

1. Start a fresh task or clearly mark the active checkbox in the current Claude Code session.
2. Ask Claude to inspect the relevant docs and code before editing.
3. Request a short explanation of the goal, new terms, expected files, and risk boundaries.
4. Let Learning Output Style ask you to write small meaningful code where it helps you learn; let Claude handle repetitive scaffolding.
5. Use `/feature-dev` for a bounded feature that crosses modules; specify that it must stop after the one checkbox.
6. Use Frontend Design only for interface work and provide the design-system document.
7. Review the diff and ask Claude to explain every changed file.
8. Verify the visible behavior locally before checking off the item.
9. Update this roadmap and continue only when you say “next.”
