# DataSentinel — In-Depth Architecture & Design Decisions Guide

This document is an in-depth, beginner-to-advanced architectural guide for **DataSentinel**. It explains not just **what** was built, but **why** every single technical decision was made, complete with simple definitions, real-world analogies, code examples, and trade-off comparisons.

---

## Table of Contents
1. [The Core Mission: What Problem Does DataSentinel Solve?](#1-the-core-mission-what-problem-does-datasentinel-solve)
2. [Architectural Decision 1: The Monorepo Structure (`pnpm` Workspaces)](#2-architectural-decision-1-the-monorepo-structure-pnpm-workspaces)
3. [Architectural Decision 2: Vanilla CSS & Bauhaus System vs. Tailwind CSS](#3-architectural-decision-2-vanilla-css--bauhaus-system-vs-tailwind-css)
4. [Architectural Decision 3: React SPA (Vite) + NestJS vs. Next.js](#4-architectural-decision-3-react-spa-vite--nestjs-vs-next-js)
5. [Architectural Decision 4: PostgreSQL, Prisma & UUIDv7](#5-architectural-decision-4-postgresql-prisma--uuidv7)
6. [Architectural Decision 5: Redis + BullMQ Asynchronous Queues](#6-architectural-decision-5-redis--bullmq-asynchronous-queues)
7. [Architectural Decision 6: HttpOnly Cookies & OriginGuard CSRF Defense](#7-architectural-decision-6-httponly-cookies--originguard-csrf-defense)
8. [Architectural Decision 7: Read-Only Bounded Data Connectors](#8-architectural-decision-7-read-only-bounded-data-connectors)
9. [Architectural Decision 8: Deterministic Math vs. Advisory AI](#9-architectural-decision-8-deterministic-math-vs-advisory-ai)
10. [Architectural Decision 9: The Two-Person Approval Security Gate](#10-architectural-decision-9-the-two-person-approval-security-gate)
11. [Chronological Project Journey: Phases A to N (Decisions D-01 to D-133)](#11-chronological-project-journey-phases-a-to-n-decisions-d-01-to-d-133)
12. [Visual System Flow Diagram](#12-visual-system-flow-diagram)

---

## 1. The Core Mission: What Problem Does DataSentinel Solve?

### The Simple Definition
**DataSentinel** is an automated quality guard and incident responder for company data pipelines. 

* **The Real-World Analogy:** Think of a hospital patient monitor or an automated factory safety shutoff. If bad, corrupted, or missing data enters an analytics system, reports become wrong, billing charges fail, and machine learning models make dangerous mistakes. DataSentinel acts as the constant health monitor that catches bad data immediately, sounds the alarm, identifies the cause, and coordinates a safe fix.

### Operational Tool vs. Analytical Dashboard
Most tools in the data space are **analytical dashboards** (like PowerBI or Tableau) designed for looking at charts. DataSentinel is an **operational tool**:
* Its purpose is **action**: *What is broken right now? Why did it break? Who is fixing it? What safe recovery action can we run?*
* This distinction drives every engineering decision in this project: speed, clarity, strict contrast, fault tolerance, and zero chance of corrupting customer data.

---

## 2. Architectural Decision 1: The Monorepo Structure (`pnpm` Workspaces)

### What is a Monorepo?
* **Definition:** A **monorepo** (monolithic repository) is a single code repository that contains multiple distinct projects, applications, and shared libraries that work together.
* **The Analogy:** Instead of keeping your hammer in one shed, your nails in another shed down the street, and your blueprints in a third building, you have a well-organized professional workshop where everything is within arm's reach.

### How DataSentinel's Monorepo is Organized:
```text
datasentinel/
├── apps/
│   ├── web/        # The Frontend: React + TypeScript Single Page App (Vite)
│   ├── api/        # The Backend: NestJS REST API server process
│   └── worker/     # The Engine: NestJS BullMQ background processing worker
└── packages/
    ├── contracts/  # The Universal Language: Shared TypeScript interfaces & Zod schemas
    ├── config/     # The Vault: Validated environment variables & secret scrubbing
    ├── connectors/ # The Adapters: Safe, read-only data connections (Postgres, CSV)
    └── db/         # The Foundation: Prisma database models, migrations & transactions
```

### Why Did We Choose This over Multiple Separate Repositories (Polyrepos)?

#### Reason 1: End-to-End Type Safety (Zero Drift)
* **The Problem in Separate Repositories:** If the backend engineer renames an API response field from `user_name` to `displayName`, the frontend repository doesn't know until the app crashes in production with `undefined`.
* **The Monorepo Solution:** Both `apps/api` and `apps/web` import the exact same contract from `packages/contracts`.
  ```typescript
  // packages/contracts/src/auth.ts
  export interface MeResponse {
    user: { id: string; email: string; displayName: string };
  }
  ```
  If you rename a field in `packages/contracts`, TypeScript immediately flags an error in both the frontend and backend simultaneously when compiling (`tsc -b`). You can never deploy mismatched code.

#### Reason 2: Atomic Commits
* **Definition:** An **atomic commit** means all parts of a feature (database table, backend logic, queue job, frontend screen) are saved in one single Git commit.
* In separate repos, you have to coordinate 4 different pull requests across 4 repositories, carefully timing which one deploys first. In our monorepo, a single commit deploys the entire feature in perfect harmony.

#### Reason 3: Why `pnpm` Instead of `npm` or `yarn`?
* `pnpm` uses a **content-addressable hard link system**. If 5 packages use the same version of React or TypeScript, `pnpm` stores it only once on your hard drive, saving gigabytes of disk space.
* It prevents **"phantom dependencies"**: In normal `npm`, Package A can secretly access Package B's dependencies even if not listed in `package.json`. `pnpm` strictly forbids this, ensuring reproducible, unbreakable builds.

---

## 3. Architectural Decision 2: Vanilla CSS & Bauhaus System vs. Tailwind CSS

### What is the Bauhaus Design System?
* **Definition:** **Bauhaus** is a historic, influential design philosophy that originated in Germany with one central motto: **"Form follows function."**
* In DataSentinel, this means visual design is used to **communicate operational truth**, not to decorate. Every shape, border, and color has a specific operational meaning:
  * Red is never used for styling; it is reserved exclusively for critical failures.
  * Yellow is reserved for warnings.
  * Blue is reserved for active selection and navigation.
  * Green is reserved for passed health checks.

### Why Did We Choose Pure Vanilla CSS (Design Tokens) Over Tailwind CSS?

| Aspect | Tailwind CSS | DataSentinel's Semantic CSS Tokens | Why Our Choice is Better |
| :--- | :--- | :--- | :--- |
| **JSX Readability** | Bloated strings: `class="flex flex-col sm:flex-row items-center justify-between p-4 bg-slate-900 border border-slate-800 rounded-lg text-sm text-slate-300..."` | Clean, semantic classes: `className="metric-card"` or `className="session-gate"` | Engineers scanning code can immediately understand the purpose of the component rather than drowning in utility classes. |
| **Operational Tables** | Hard to maintain dense data grids; requires repeating 15 utility classes on every single `<td>` and `<tr>`. | Defined once in CSS: `.data-table td { padding: 8px 12px; border-bottom: 1px solid var(--line); }` | High information density without code duplication. |
| **Theming & Global Changes** | Changing spacing or borders requires searching and replacing thousands of utility classes across hundreds of files. | One line in `index.css`: change `--line: #B8B4AA;` and the entire app updates instantly. | Effortless centralized auditing and maintenance. |
| **Build Overhead** | Requires PostCSS plugins, Tailwind compilation steps, and JIT class scanners. | Zero build step. Natively parsed by the browser in microseconds. | Maximum build speed and zero dependency vulnerabilities. |

### Concrete Example: Our Centralized Token System
In `apps/web/src/index.css`:
```css
:root {
  --ink: #171717;           /* High-contrast readable text */
  --paper: #F4F1E8;         /* Warm background reducing eye strain */
  --surface: #FFFFFF;       /* Clean elevated cards */
  --line: #B8B4AA;          /* Subtle geometric dividers */
  --signal-red: #C83225;    /* Critical failure accent */
  --signal-blue: #24528A;   /* Primary navigation */
  --signal-yellow: #F0C64A; /* Warnings and highlights */
  --success: #236B4A;       /* Verified healthy checks */
}
```
Every component in the application references these exact CSS variables. Contrast is mathematically guaranteed to meet **WCAG AA** accessibility standards.

---

## 4. Architectural Decision 3: React SPA (Vite) + NestJS vs. Next.js

### What is the Difference?
* **Next.js:** A full-stack meta-framework where server code and client code live inside the same project, typically running in serverless edge environments (like Vercel).
* **React SPA (Vite) + NestJS:** A clean separation where the frontend is compiled into pure static HTML/JS/CSS files, and the backend is a persistent, long-running Node.js process using NestJS.

### Why Next.js Was the Wrong Choice for DataSentinel:

#### 1. The Background Worker Problem (Serverless Incompatibility)
* **The Reality:** DataSentinel is not just a website that returns HTML pages. It is an **asynchronous computing engine**. It must maintain persistent connection pools to customer databases, hold open TCP connections to Redis, and run continuous BullMQ queue loops that evaluate millions of rows.
* **Why Next.js Fails Here:** Next.js API routes and Server Actions are built on serverless lambdas. Serverless functions freeze or terminate after a few seconds. They cannot host long-lived BullMQ queue workers or background schedulers.

#### 2. The Danger of Secret Leakage
* In Next.js, frontend code and backend code often live in the exact same file (e.g. `page.tsx` with Server Actions or `use client`).
* In DataSentinel, our backend manages `SECRETS_ENCRYPTION_KEY`, database passwords, and private S3 credentials. In Next.js, accidentally omitting a server pragma can bundle private keys into the public JavaScript delivered to customer browsers.
* With Vite + NestJS, there is a **physical wall**: the frontend bundle literally only contains public static files. It cannot access backend secrets even if a developer makes a mistake.

#### 3. Independent Scaling (Asymmetric Resource Demands)
* At peak hours, a company might run 50 data quality checks simultaneously. This requires **massive worker CPU and memory**, but the web dashboard traffic remains low.
* With our modular monolith architecture:
  * We can scale the Worker process to 10 instances.
  * Keep the API server at 2 instances.
  * Serve the React SPA from a free CDN.
* With Next.js, you are forced to scale the entire monolithic serverless bundle together, dramatically increasing hosting costs.

---

## 5. Architectural Decision 4: PostgreSQL, Prisma & UUIDv7

### The Choice of Database: PostgreSQL + Prisma
* **PostgreSQL:** The gold standard for ACID-compliant relational data integrity. It guarantees that workspace transactions, incident status transitions, and audit logs are permanently safe from corruption.
* **Prisma:** A modern TypeScript ORM that generates type-safe database queries, manages versioned database migrations, and provides compile-time query validation.

### Why UUIDv7 Instead of Auto-Increment (1, 2, 3) or UUIDv4?

#### 1. Why not Auto-Increment Integers (`id = 1, 2, 3...`)?
* **Security & Business Leakage:** If your workspace URL is `/workspaces/42`, a competitor can guess `/workspaces/43` or know exactly that you only have 42 customers.
* **Distributed Collision:** Multiple servers cannot generate integer IDs independently without talking to a central database counter first.

#### 2. Why not standard UUIDv4 (Random Strings like `c9bf9e57-1685-4c89...`)?
* **The Database Performance Problem:** UUIDv4 is 100% random. When PostgreSQL inserts a new row into an index (B-Tree index), a random UUID must be inserted into a random page in the middle of disk storage. This causes **index fragmentation**, high memory churn, and slows down database inserts as the table grows to millions of rows.

#### 3. The Winner: UUIDv7
* **Definition:** **UUIDv7** combines a high-precision Unix timestamp in the first 48 bits with cryptographically random bits at the end.
* **The Magic:**
  1. **Time-Ordered:** Newly created records are naturally sorted chronologically. In database indexes, new rows are always appended to the end of the B-Tree index, keeping database inserts blazing fast.
  2. **Globally Unique:** Like any UUID, it can be generated anywhere without collision.
  3. **No Sequence Leakage:** Attackers cannot guess sequential IDs.

In `packages/db/prisma/schema.prisma`:
```prisma
model User {
  id String @id @default(uuid(7)) @db.Uuid
  ...
}
```

---

## 6. Architectural Decision 5: Redis + BullMQ Asynchronous Queues

### What is BullMQ?
* **Definition:** **BullMQ** is a distributed, ultra-fast background job and message queue built on top of **Redis**.
* **The Real-World Analogy:** Think of a busy restaurant. When you order food, the waiter does not make you wait at the counter while they cook the steak. The waiter writes an order ticket, slips it onto the kitchen carousel (the queue), and hands you a buzzer. The chefs (workers) pick up tickets one by one, cook the meals, and notify you when ready.

### Why Not Just Use `setTimeout()` or Cron in Node.js?
1. **Crash Durability:** If the Node.js server crashes while running a `setTimeout()`, that task is lost forever. With BullMQ, the job sits safely in Redis memory/disk. When the server restarts, it picks up right where it left off.
2. **Exponential Backoff Retries:** If a customer's PostgreSQL database is temporarily overloaded, BullMQ automatically retries the check after 2 seconds, then 4 seconds, then 8 seconds, rather than crashing immediately.
3. **Dead-Letter Queues:** If a job fails after all retries, it is preserved in a "failed" list with its full error trace for human inspection. No silent failures.

---

## 7. Architectural Decision 6: HttpOnly Cookies & OriginGuard CSRF Defense

### Why HttpOnly Cookies Instead of LocalStorage JWTs?
* **The Security Flaw with LocalStorage:** If an application stores an authentication token in `localStorage`, any Cross-Site Scripting (XSS) vulnerability (such as a malicious third-party npm package) can run `localStorage.getItem('token')` and steal the user's account completely.
* **The HttpOnly Cookie Advantage:** Cookies marked `HttpOnly` **cannot be read by JavaScript at all**. The browser automatically attaches the cookie to API requests, but malicious scripts cannot view or extract it.

### What is CSRF and How Does `OriginGuard` Stop It?
* **What is CSRF (Cross-Site Request Forgery)?**
  Imagine you are logged into your bank. You open another browser tab and visit `evil-site.com`. That site has a hidden script that makes a request to `yourbank.com/transfer-money`. Because cookies are sent automatically, the bank might execute the transfer!
* **How DataSentinel Solves This with `OriginGuard`:**
  In `apps/api/src/auth/origin.guard.ts`:
  ```typescript
  const origin = req.headers.origin;
  if (SAFE_METHODS.has(req.method) || origin === undefined || origin === this.options.webOrigin) {
    return true;
  }
  throw new ProblemException(
    HttpStatus.FORBIDDEN,
    'origin_not_allowed',
    'This request came from a site that may not change data here.',
  );
  ```
  Every time a browser sends a state-changing request (`POST`, `PUT`, `DELETE`), the browser attaches an unforgeable `Origin` header. If the request does not come from the exact verified website (`WEB_ORIGIN`), DataSentinel instantly slams the door shut.

---

## 8. Architectural Decision 7: Read-Only Bounded Data Connectors

### The Golden Rule (Decision D-119):
> **DataSentinel will NEVER execute a write, update, or delete query against a monitored customer database.**

### Why Bounded Connectors?
1. **The Row Limit Cap (Default: 10,000 rows for profiling):**
   * If a customer has a table with 500 million rows, running `SELECT *` would crash the database, exhaust server memory, and create massive network bills.
   * DataSentinel's connectors enforce strict query caps.
2. **Statement Timeouts (Default: 8,000ms):**
   * If a customer query takes longer than 8 seconds, the database connection is cleanly severed to prevent table locking.
3. **Zero Customer PII Retention:**
   * DataSentinel does not copy customer tables into its own database. It streams rows, computes mathematical aggregates (e.g. *"null percentage is 0.04%"*), saves the aggregate number, and discards the raw records immediately.

---

## 9. Architectural Decision 8: Deterministic Math vs. Advisory AI

### The Danger of "AI-First" Data Validation
Many modern tools attempt to have an LLM (like GPT-4 or Claude) inspect datasets directly and decide if data is correct. **This is fundamentally flawed:**
* LLMs can hallucinate.
* LLMs are probabilistic, meaning the same prompt can yield different answers on Tuesday than it did on Monday.
* Passing millions of customer data rows into an external AI API violates privacy laws (GDPR, HIPAA, SOC 2).

### DataSentinel's Hybrid Approach:
1. **The Core is 100% Deterministic Code:**
   * Null checks, row count comparisons, distribution tests, and schema drift detection are performed by deterministic, compiled TypeScript code and mathematical SQL aggregations. There is zero guessing.
2. **AI is Strictly Advisory (Decision D-99):**
   * Generative AI is used **only after an incident occurs** to assist human triage.
   * Before sending an incident prompt to the LLM:
     * All direct identifiers and sensitive credentials are completely scrubbed.
     * The AI is provided with verified facts (e.g., *"Orders table dropped by 64% at 04:00 UTC"*) and relevant documentation chunks.
     * The AI outputs hypotheses (e.g., *"Possible cause: upstream dbt pipeline failure"*).
   * The AI **never** has permission to change data or resolve incidents automatically.

---

## 10. Architectural Decision 9: The Two-Person Approval Security Gate

### Decision D-116: Preventing Rogue Automated Actions
When an incident is detected, an engineer may want to execute a recovery action (such as triggering an external webhook, re-running a data pipeline, or dispatching a ticket).

#### How the Approval Flow Works:
1. **Proposal:** Engineer A proposes an action (e.g. *"Rerun pipeline batch #402"*).
2. **Cryptographic Payload Hash:** The exact JSON payload of the action is hashed with `SHA-256` and locked with an expiration timestamp. The payload cannot be altered while waiting.
3. **The Two-Person Rule:** Engineer A **cannot approve their own action**. A second authorized team member (Engineer B or Admin) must inspect the proposal and click **Approve**.
4. **Worker Verification:** When the background worker executes the approved action, it verifies the hash against the database approval record. If any byte was changed, execution is immediately aborted.

---

## 11. Chronological Project Journey: Phases A to N (Decisions D-01 to D-133)

DataSentinel was developed in a strict, dependency-ordered engineering sequence across 14 phases:

```
[Phase A: Spec & Rules] ➔ [Phase B: Monorepo Tooling] ➔ [Phase C: DB & Tenancy]
           │
           ▼
[Phase D: Auth & CSRF]  ➔ [Phase E: Bauhaus UI Shell] ➔ [Phase F: Ingestion]
           │
           ▼
[Phase G: Profiling]    ➔ [Phase H: Rules Engine]     ➔ [Phase I: Incidents]
           │
           ▼
[Phase J: Webhooks]     ➔ [Phase K: Notifications]    ➔ [Phase L: Advisory AI]
           │
           ▼
[Phase M: Approval Gate]➔ [Phase N: Hardening & Deploy]
```

### Milestone Breakdown:
* **Phase A (Requirements & Decisions D-01 to D-09):** Formulated core architecture, non-destructive rules, and role hierarchies (`owner`, `admin`, `engineer`, `analyst`, `viewer`).
* **Phase B (Monorepo Scaffolding D-10 to D-20):** Built `pnpm` workspaces, strict linting gates, and TypeScript references so frontend and backend share types.
* **Phase C (Database Architecture D-21 to D-30):** Designed Prisma schema with UUIDv7, tenant isolation (`workspace_id`), and encrypted secrets with versioned rotation keys.
* **Phase D (Authentication & Sessions D-31 to D-38):** Implemented HttpOnly session cookies, RFC 9457 structured error format, and `OriginGuard` CSRF defense.
* **Phase E (Bauhaus Design System D-39 to D-50):** Built geometric, high-contrast UI tokens, responsive `AppShell`, session gates, and empty states.
* **Phase F (Data Ingestion D-51 to D-65):** Built bounded read-only PostgreSQL adapters and private S3-compatible CSV upload streams with MinIO/R2.
* **Phase G (Profiling & Drift D-66 to D-75):** Automated schema extraction, column null percentage computation, distinct counts, and drift alerts.
* **Phase H (Quality Rules Engine D-76 to D-85):** Built the deterministic rules evaluation engine for freshness, row count drops, null ceilings, and schema integrity.
* **Phase I (Incident Engine D-86 to D-90):** Fingerprinted recurring check failures into single deduplicated incident threads with timeline audit trails.
* **Phase J (Pipeline Webhooks D-91 to D-95):** Created inbound webhook receivers for Airflow and dbt with HMAC signatures and replay defense.
* **Phase K (Notifications D-96 to D-100):** Built outbound delivery adapters for Slack, Email, and signed webhooks with exponential backoff retries.
* **Phase L (AI Advisory Investigation D-99 to D-112):** Built document chunking, PII redaction, and structured LLM root-cause hypothesis generation.
* **Phase M (Approved Recovery Actions D-113 to D-119):** Built typed remediation proposals, SHA-256 payload locking, and the two-person approval security rule.
* **Phase N (Production Hardening D-120 to D-133):** Added `/api/health` probes, synthetic datasets, Docker Compose environments, Render deployment blueprints, and the first-user bootstrap script (`user:create`).

---

## 12. Visual System Flow Diagram

To see all these runtime components operating in real time with interactive state transitions, glowing paths, and payload previews:

👉 **[Open the Apple Liquid Glass System Flow Diagram (system-flow.html)](./system-flow.html)**

*(You can double-click or open `docs/system-flow.html` in any web browser to explore the interactive visual architecture).*
