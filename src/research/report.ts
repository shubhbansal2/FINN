import { z } from 'zod';

/**
 * The research report contract shared by the engine, the API and the UI.
 * Validated when written and when read. Every claim points at evidence ids;
 * every evidence item points at a stored document location.
 */

export const ENGINE_VERSION = 'research.v8';

export const ResearchRequestSchema = z.object({
  ticker: z.string().trim().min(1).max(60),
  question: z.string().trim().max(500).optional().transform((q) => (q ? q : undefined)),
  /** Restricts the financial view to periods up to this one, e.g. "Q2 FY27" or "FY26". */
  period: z
    .string()
    .trim()
    .regex(/^(Q[1-4] )?FY\d{2}$/, 'Use a period like "Q2 FY27" or "FY26"')
    .optional()
    .transform((p) => (p ? p : undefined)),
});
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

const EvidenceSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  documentTitle: z.string(),
  documentKind: z.string(),
  /** When the document was filed or published (UTC ISO), if known. */
  publishedAt: z.string().nullable(),
  origin: z.enum(['exchange_filed', 'company_issued']),
  page: z.number().int().positive().nullable(),
  locationLabel: z.string(),
  passage: z.string(),
  quote: z.string().nullable(),
  url: z.string().nullable(),
  verification: z.enum(['verified', 'unverified', 'check_failed']),
  /** What `verification` refers to: arithmetic checks on a figure, a quote located in the passage, or a verbatim passage. */
  basis: z.enum(['arithmetic', 'quote', 'passage']),
  /** For a reported figure: the value exactly as printed, the stated unit, and the normalised rupee value. */
  reported: z.object({ printed: z.string(), scale: z.string(), normalizedInr: z.number(), period: z.string(), basis: z.string() }).nullable(),
  extraction: z.string(),
});
export type EvidenceItem = z.infer<typeof EvidenceSchema>;

const ClaimSchema = z.object({
  text: z.string(),
  /** sourced_fact: a reported figure; quotation: verbatim source text; computed: arithmetic on facts; inference: analytical interpretation. */
  kind: z.enum(['sourced_fact', 'quotation', 'computed', 'inference']),
  evidenceIds: z.array(z.string()),
});
export type Claim = z.infer<typeof ClaimSchema>;

const moduleOf = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ status: z.enum(['ok', 'partial', 'unavailable']), note: z.string().nullable(), data: data.nullable() });

const CellSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('value'), value: z.number(), unit: z.enum(['inr', 'ratio']), verified: z.boolean(), formula: z.string().nullable(), evidenceIds: z.array(z.string()) }),
  z.object({ state: z.literal('missing'), reason: z.string() }),
  z.object({ state: z.literal('conflict'), reason: z.string(), evidenceIds: z.array(z.string()) }),
]);
export type ReportCell = z.infer<typeof CellSchema>;

const TableSchema = z.object({
  basis: z.enum(['consolidated', 'standalone']),
  columns: z.array(z.object({ label: z.string(), end: z.string(), type: z.string() })),
  rows: z.array(z.object({ key: z.string(), label: z.string(), cells: z.array(CellSchema) })),
});

const EvaluationSchema = z.object({
  verdict: z.enum(['met', 'exceeded', 'missed', 'not_evaluable', 'awaiting_results', 'actual_unavailable']),
  reason: z.string(),
  actualPercent: z.number().nullable(),
  variancePp: z.number().nullable(),
  method: z.string().nullable(),
  actualVerified: z.boolean().nullable(),
  actualEvidenceIds: z.array(z.string()),
});

const StatementViewSchema = z.object({
  id: z.string(),
  callLabel: z.string(),
  quote: z.string(),
  speaker: z.string().nullable(),
  subject: z.string(),
  nature: z.enum(['quantitative', 'qualitative']),
  target: z.object({ low: z.number(), high: z.number(), unit: z.string() }).nullable(),
  horizonText: z.string().nullable(),
  horizonPeriod: z.string().nullable(),
  evidenceId: z.string(),
  method: z.string(),
  evaluation: EvaluationSchema,
});
export type StatementView = z.infer<typeof StatementViewSchema>;

const SourceSchema = z.object({
  documentId: z.string(),
  title: z.string(),
  kind: z.string(),
  origin: z.string(),
  url: z.string(),
  periodLabel: z.string().nullable(),
  publishedAt: z.string().nullable(),
  state: z.enum(['used', 'download_failed', 'no_text', 'extraction_failed', 'not_attempted']),
  detail: z.string().nullable(),
  pages: z.number().nullable(),
});

export const ResearchReportSchema = z.object({
  engineVersion: z.string(),
  generatedAt: z.string(),
  dataMode: z.enum(['live', 'fixture']),
  status: z.enum(['complete', 'partial']),
  company: z.object({ id: z.string(), name: z.string(), nseSymbol: z.string().nullable(), bseCode: z.string().nullable(), role: z.string() }),
  request: z.object({ ticker: z.string(), question: z.string().nullable(), period: z.string().nullable() }),
  sources: z.array(SourceSchema),
  evidence: z.record(EvidenceSchema),
  modules: z.object({
    snapshot: moduleOf(z.object({ mode: z.enum(['model', 'extractive']), claims: z.array(ClaimSchema) })),
    trajectory: moduleOf(
      z.object({
        tables: z.array(TableSchema),
        latestQuarter: z.string().nullable(),
        /** Latest-quarter headline figures with comparisons, all computed in the engine. */
        highlights: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            period: z.string(),
            basis: z.enum(['consolidated', 'standalone']),
            cell: CellSchema,
            comparisons: z.array(z.object({ basis: z.string(), kind: z.enum(['ratio', 'pp']), value: z.number().nullable(), reason: z.string().nullable(), evidenceIds: z.array(z.string()) })),
          }),
        ),
      }),
    ),
    balanceSheet: moduleOf(z.object({ items: z.array(z.object({ key: z.string(), label: z.string(), period: z.string().nullable(), cell: CellSchema, explanation: z.string() })) })),
    guidance: moduleOf(z.object({ statements: z.array(StatementViewSchema) })),
    scorecard: moduleOf(
      z.object({
        /** `inferredQuarter`: the latest quarter that had ended before the call month, e.g. a Jul 2026 call → Q1 FY27. An inference, labelled as such. */
        calls: z.array(z.object({ callLabel: z.string(), documentId: z.string(), statementIds: z.array(z.string()), inferredQuarter: z.string().nullable() })),
        counts: z.record(z.number()),
      }),
    ),
    narrative: moduleOf(z.object({ items: z.array(z.object({ statementId: z.string(), related: z.array(ClaimSchema) })) })),
    bullBear: moduleOf(z.object({ mode: z.enum(['model', 'computed']), bull: z.array(ClaimSchema), bear: z.array(ClaimSchema) })),
    question: moduleOf(z.object({ question: z.string(), mode: z.enum(['model', 'extractive']), claims: z.array(ClaimSchema) })),
  }),
  diagnostics: z.array(z.string()),
  model: z.object({ configured: z.boolean(), description: z.string(), calls: z.array(z.object({ task: z.string(), model: z.string().nullable(), status: z.string(), cached: z.boolean() })) }),
});
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
