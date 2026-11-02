/** Evidence as the UI receives it (mirrors the SourceRef DTO in docs/ARCHITECTURE.md §3.7). */
export type Evidence = {
  documentTitle: string;
  documentKind: 'Annual report' | 'Concall transcript' | 'Results filing' | 'Investor presentation' | 'Exchange filing';
  fiscalLabel?: string;
  filedAtIso?: string;
  page: number;
  /** Plain-text passage. Never interpreted as HTML. */
  passageText: string;
  /** Verbatim supporting span within the passage, if the claim quotes one. */
  quote?: string;
  pdfUrl?: string;
  extractionMethod: string;
  verification: 'verified' | 'unverified';
  /** What "verified" means for this evidence, e.g. "Arithmetic checks passed". Defaults to "Quote verified". */
  verifiedLabel?: string;
  dataMode: 'live' | 'demo';
  /** For a reported figure: the value as printed and how it was converted. */
  reported?: { printed: string; scaleLabel: string; normalized: string; period: string; basis: string };
  /** The statement this source supports, and whether it is a reported fact or FINN's interpretation. */
  claim?: { text: string; kind: ClaimNature };
};

export type ClaimNature = 'reported_fact' | 'quotation' | 'computed' | 'interpretation';

export const CLAIM_NATURE_LABEL: Record<ClaimNature, { label: string; description: string }> = {
  reported_fact: { label: 'Reported fact', description: 'A figure as the company reported it in this document.' },
  quotation: { label: 'Quotation', description: 'Words taken verbatim from this document.' },
  computed: { label: 'Computed by FINN', description: 'Arithmetic on reported figures; the formula is stated with the figure.' },
  interpretation: { label: 'Analysis', description: "FINN's interpretation of the sources. The source supports it; it is not the company's statement." },
};

export type HighlightedPassage =
  | { found: true; before: string; match: string; after: string }
  | { found: false; text: string };

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Locates `quote` inside `passage`, ignoring differences in whitespace and case,
 * and splits the (whitespace-collapsed) passage around it for highlighting.
 * Display-only: authoritative quote verification happens server-side.
 */
export function highlightQuote(passage: string, quote: string | undefined): HighlightedPassage {
  const text = collapse(passage);
  if (!quote) return { found: false, text };
  const needle = collapse(quote);
  if (needle.length === 0) return { found: false, text };
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index === -1) return { found: false, text };
  return {
    found: true,
    before: text.slice(0, index),
    match: text.slice(index, index + needle.length),
    after: text.slice(index + needle.length),
  };
}

/**
 * Returns an https URL (optionally pointing at a PDF page) or null. Anything
 * that is not https — javascript:, data:, http:, relative paths — is refused.
 */
export function safeDocumentUrl(raw: string | undefined, page?: number): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not an absolute URL: refuse rather than resolve against our own origin.
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (page !== undefined && Number.isInteger(page) && page > 0) url.hash = `page=${page}`;
  return url.toString();
}
