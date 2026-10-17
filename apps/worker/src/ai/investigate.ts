import {
  PROMPT_TEMPLATE_VERSION,
  INVESTIGATION_SCHEMA_VERSION,
  type InvestigationFailureCode,
  type InvestigationReport,
} from '@datasentinel/contracts';
import { searchDocumentChunks, type PrismaClient } from '@datasentinel/db';
import { buildProviderInput } from './facts.js';
import { callLlm, LlmError, type LlmDeps } from './llm.js';
import { loadIncidentFacts } from './load-facts.js';
import { parseModelOutput } from './parse-output.js';
import { buildInvestigationPrompt, PROMPT_LIMITS, type Excerpt } from './prompt.js';
import { RedactionError, type RedactionCounts } from './redact.js';

export interface InvestigationDeps {
  prisma: PrismaClient;
  llm: LlmDeps;
  /** What the deployment says (D-99); `providerName` is stored on reports. */
  config: { available: boolean; providerName: string | null };
  maxOutputTokens?: number;
}

export type ClaimedInvestigation = {
  id: string;
  workspaceId: string;
  incidentId: string;
  attempts: number;
};

/** A claimed report that is never finished becomes claimable again after this. */
const LEASE_MS = 10 * 60_000;
/** A report that has been claimed this many times without finishing is
 * given up on, so a job that crashes the worker cannot loop forever. */
const MAX_CLAIMS = 3;

/** Takes the oldest pending report nobody holds (D-108). SKIP LOCKED lets
 * several workers share the queue; the lease lets a crashed worker's report
 * come back. */
export async function claimInvestigation(
  prisma: PrismaClient,
  now: Date,
  /** Tests only: take from this workspace alone. */
  workspaceId: string | null = null,
): Promise<ClaimedInvestigation | null> {
  const rows = await prisma.$queryRaw<ClaimedInvestigation[]>`
    UPDATE investigation_reports
       SET attempts = attempts + 1, lease_until = ${new Date(now.getTime() + LEASE_MS)}
     WHERE id = (
       SELECT id FROM investigation_reports
        WHERE status = 'pending' AND (lease_until IS NULL OR lease_until < ${now})
          AND (${workspaceId}::uuid IS NULL OR workspace_id = ${workspaceId}::uuid)
        ORDER BY created_at
        LIMIT 1
          FOR UPDATE SKIP LOCKED)
    RETURNING id, workspace_id AS "workspaceId", incident_id AS "incidentId", attempts`;
  return rows[0] ?? null;
}

type Meta = {
  providerName: string | null;
  model: string | null;
  excerptCount: number;
  redactions: RedactionCounts;
};

const noMeta = (deps: InvestigationDeps): Meta => ({
  providerName: deps.config.providerName,
  model: null,
  excerptCount: 0,
  redactions: {},
});

async function fail(
  prisma: PrismaClient,
  id: string,
  code: InvestigationFailureCode,
  meta: Meta,
): Promise<void> {
  await prisma.investigationReport.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'failed', failureCode: code, completedAt: new Date(), ...meta },
  });
}

const STOP_WORDS = new Set(['the', 'and', 'for', 'are', 'with', 'not', 'has', 'was', 'null']);

/** Search words from the incident's own facts (never from a document). Any
 * one matching is enough, so the query joins them with OR. */
function searchQuery(parts: string[]): string {
  const words = parts
    .join(' ')
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g);
  const unique = [...new Set(words ?? [])].filter((w) => !STOP_WORDS.has(w)).slice(0, 8);
  return unique.join(' or ');
}

/** Produces one report (D-108 to D-110), start to finish, and records the
 * outcome. It never throws: every failure becomes a failed report with a
 * short code, and nothing here can affect the incident or its checks. The
 * order matters: AI must be allowed, facts are loaded and redacted, document
 * excerpts are found by the incident's own words, the prompt separates
 * trusted from untrusted text, the provider is called under every limit, and
 * the reply must pass the strict schema before it is stored. */
export async function processInvestigation(
  deps: InvestigationDeps,
  claimed: ClaimedInvestigation,
): Promise<void> {
  const { prisma } = deps;
  let meta = noMeta(deps);
  try {
    if (claimed.attempts > MAX_CLAIMS)
      return await fail(prisma, claimed.id, 'worker_interrupted', meta);

    const workspace = await prisma.workspace.findUnique({
      where: { id: claimed.workspaceId },
      select: { aiEnabled: true },
    });
    if (!deps.config.available || workspace?.aiEnabled !== true) {
      return await fail(prisma, claimed.id, 'ai_disabled', meta);
    }
    const facts = await loadIncidentFacts(prisma, claimed.workspaceId, claimed.incidentId);
    if (facts === null) return await fail(prisma, claimed.id, 'incident_not_found', meta);

    const input = buildProviderInput(facts);
    meta = { ...meta, redactions: input.redactions };

    const hits = await searchDocumentChunks(
      prisma,
      claimed.workspaceId,
      searchQuery([
        facts.rule.name,
        facts.incident.datasetName,
        facts.incident.sourceName,
        ...Object.values(facts.rule.parameters).filter((v): v is string => typeof v === 'string'),
      ]),
      { limit: PROMPT_LIMITS.excerpts, snippetChars: PROMPT_LIMITS.excerptChars },
    );
    const excerpts: Excerpt[] = hits.map((h) => ({
      documentName: h.documentName,
      sectionPath: h.sectionPath,
      text: h.snippet,
    }));

    const prompt = buildInvestigationPrompt(input, excerpts, deps.maxOutputTokens ?? 1500);
    meta = { ...meta, excerptCount: prompt.usedExcerpts };

    const response = await callLlm(deps.llm, claimed.workspaceId, prompt.request);
    meta = { ...meta, model: response.model?.slice(0, 100) ?? null };

    const parsed = parseModelOutput(response.text, new Set(input.evidenceIds));
    if (!parsed.ok) return await fail(prisma, claimed.id, parsed.reason, meta);

    const report: InvestigationReport = parsed.report;
    const cited = [
      ...new Set([...report.facts, ...report.hypotheses].flatMap((c) => c.evidenceIds)),
    ];
    await prisma.investigationReport.updateMany({
      where: { id: claimed.id, status: 'pending' },
      data: {
        status: 'ready',
        report,
        evidenceIds: cited,
        schemaVersion: INVESTIGATION_SCHEMA_VERSION,
        templateVersion: PROMPT_TEMPLATE_VERSION,
        completedAt: new Date(),
        ...meta,
      },
    });
  } catch (error) {
    const code: InvestigationFailureCode =
      error instanceof LlmError
        ? error.code
        : error instanceof RedactionError
          ? 'redaction_failed'
          : 'unavailable';
    await fail(prisma, claimed.id, code, meta).catch(() => undefined);
  }
}
