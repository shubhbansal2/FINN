/**
 * Management statements from earnings-call transcripts.
 *
 * Deterministic first pass: forward-looking sentences, verbatim, with the
 * speaker where the transcript names one. A statement is `quantitative` only
 * if the sentence itself contains an explicit figure tied to a known metric;
 * "strong", "double-digit" or "healthy" never become numbers. A time horizon
 * is normalised (FY27, Q3 FY27) only when the sentence states it; relative
 * horizons ("this year", "medium term") are kept as text and not evaluated.
 */

export const GUIDANCE_EXTRACTOR_VERSION = 'guidance-rules.v1';

export type Subject = 'revenue_growth' | 'revenue' | 'ebitda_margin' | 'margin' | 'ebitda' | 'pat' | 'capex' | 'volume' | 'debt' | 'guidance_policy' | 'business';
export type TargetUnit = 'percent' | 'inr_crore' | 'bps' | 'count';

export type StatementDraft = {
  chunkId: string;
  quote: string;
  speaker: string | null;
  subject: Subject;
  nature: 'quantitative' | 'qualitative';
  targetLow: number | null;
  targetHigh: number | null;
  targetUnit: TargetUnit | null;
  horizonText: string | null;
  horizonPeriod: string | null;
};

// Genuine forward-looking language only. "We will grow" / "we will continue" alone is too weak to count.
const CUE =
  /\b(we (expect|anticipate|are (targeting|aiming|guiding)|aim|intend|target)|(expect|anticipate)s?|guidance|guiding|guided|outlook|target(?:ing|ed)?|aspir(?:e|ation)|should (grow|deliver|reach|improve|remain|be in)|likely to|expected to|in the (range|region|band) of|will (double|reach|achieve|commission|be commissioned))\b/i;
const NO_GUIDANCE = /\b(no|not (give|giving|provide|providing)|don'?t (give|provide)|do not (give|provide)|refrain from (giving|providing))\b[^.]{0,30}\bguidance\b/i;

// A speaker label is a personal name of 2–4 capitalised words followed by a colon ("V. Srikanth:", "Kiran Thomas:").
// Words are capitalised names or single-letter initials ("V."); a word ending in "." is never a name word.
const SPEAKER = /(?:^|[.!?]\s+|\s)((?:(?:[A-Z]\.|[A-Z][a-zA-Z'’-]+)\s){1,3}[A-Z][a-zA-Z'’-]+)\s?:\s+(?=[A-Z"“])/g;
const NOT_A_NAME = /\b(sub|subject|encl|regd|office|duration|link|audio|code|symbol|cin|note|disclaimer|source|page|tel|fax|email|website|date|time|ref|annexure)\b/i;

const SUBJECTS: [Subject, RegExp][] = [
  ['ebitda_margin', /\bebitda margins?\b/i],
  ['margin', /\b(operating|gross|pat|net)?\s?margins?\b/i],
  ['revenue_growth', /\b(revenue|sales|top[- ]?line|turnover)\b[^.]{0,40}\b(grow|growth)\b|\b(grow|growth)\b[^.]{0,40}\b(revenue|sales|top[- ]?line|turnover)\b/i],
  ['revenue', /\b(revenue|sales|top[- ]?line|turnover)\b/i],
  ['ebitda', /\bebitda\b/i],
  ['pat', /\b(pat|net profit|profit after tax|bottom[- ]?line)\b/i],
  ['capex', /\b(capex|capital expenditure|capital spend)\b/i],
  ['debt', /\b(net debt|debt|borrowings|leverage)\b/i],
  ['volume', /\b(volumes?|capacity|throughput|units)\b/i],
];

const PCT_RANGE = /(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)?\s*(?:to|-|–|and)\s*(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/i;
const PCT = /(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/i;
const CRORE = /(?:₹|rs\.?|inr)\s*(\d[\d,]*(?:\.\d+)?)\s*(?:crores?|cr)\b|(\d[\d,]*(?:\.\d+)?)\s*(?:crores?|cr)\b/i;
const BPS = /(\d+(?:\.\d+)?)\s*(?:bps|basis points)/i;
const OPERATIONAL = /(\d+(?:\.\d+)?)\s*-?\s*(?:gigawatt[- ]?hours?|gwh|gigawatts?|gw|megawatts?|mw|mtpa|million (?:tonnes|tons)|lakh tonnes|stores)\b/i;

const num = (s: string | undefined) => (s === undefined ? null : Number(s.replace(/,/g, '')));

/** Explicit horizon only. "FY27", "FY2027", "2026-27", "Q3 FY27". */
export function explicitHorizon(sentence: string): string | null {
  const q = /\bQ([1-4])\s*(?:of\s*)?FY\s?['’]?(\d{2,4})\b/i.exec(sentence);
  if (q?.[1] && q[2]) return `Q${q[1]} FY${q[2].slice(-2)}`;
  const fy = /\bFY\s?['’]?(\d{4}|\d{2})(?!\d)/i.exec(sentence);
  if (fy?.[1]) return `FY${fy[1].slice(-2)}`;
  const span = /\b20(\d{2})\s*[-–/]\s*(?:20)?(\d{2})\b/.exec(sentence);
  if (span?.[1] && span[2] && Number(span[2]) === (Number(span[1]) + 1) % 100) return `FY${span[2]}`;
  return null;
}

const RELATIVE = /\b((this|current|next|coming) (year|fiscal|financial year|quarter|few quarters|couple of quarters)|(medium|long|near|short)[- ]term|over the next \w+ (years|quarters)|in the next \w+ (years|quarters)|by (20\d{2}|fy\s?\d{2,4})|going forward|h[12])\b/i;

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z₹"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function subjectOf(sentence: string): Subject {
  if (NO_GUIDANCE.test(sentence)) return 'guidance_policy';
  for (const [subject, re] of SUBJECTS) if (re.test(sentence)) return subject;
  return 'business';
}

function target(sentence: string, subject: Subject): Pick<StatementDraft, 'nature' | 'targetLow' | 'targetHigh' | 'targetUnit'> {
  const none = { nature: 'qualitative' as const, targetLow: null, targetHigh: null, targetUnit: null };
  if (subject === 'business' || subject === 'guidance_policy') return none;
  const range = PCT_RANGE.exec(sentence);
  if (range) {
    const a = num(range[1]);
    const b = num(range[2]);
    if (a !== null && b !== null && a <= b) return { nature: 'quantitative', targetLow: a, targetHigh: b, targetUnit: 'percent' };
  }
  const pct = PCT.exec(sentence);
  if (pct) return { nature: 'quantitative', targetLow: num(pct[1]), targetHigh: num(pct[1]), targetUnit: 'percent' };
  const bps = BPS.exec(sentence);
  if (bps) return { nature: 'quantitative', targetLow: num(bps[1]), targetHigh: num(bps[1]), targetUnit: 'bps' };
  const cr = CRORE.exec(sentence);
  if (cr) {
    const v = num(cr[1] ?? cr[2]);
    if (v !== null) return { nature: 'quantitative', targetLow: v, targetHigh: v, targetUnit: 'inr_crore' };
  }
  // Operational targets stated with a physical unit ("40-gigawatt hour capacity", "10 mtpa").
  const qty = OPERATIONAL.exec(sentence);
  if (qty && (subject === 'volume' || subject === 'capex')) {
    const v = num(qty[1]);
    if (v !== null) return { nature: 'quantitative', targetLow: v, targetHigh: v, targetUnit: 'count' };
  }
  return none;
}

/**
 * Extracts candidate statements from a transcript's chunks, in order. The
 * speaker carries across chunks until a new speaker label appears.
 */
export function extractStatements(chunks: { id: string; text: string }[], limit = 15): StatementDraft[] {
  const out: StatementDraft[] = [];
  const seen = new Set<string>();
  let speaker: string | null = null;

  for (const chunk of chunks) {
    // Speaker labels inside the chunk, by character offset.
    const marks: { at: number; name: string }[] = [];
    for (const m of chunk.text.matchAll(SPEAKER)) {
      const name = (m[1] ?? '').trim();
      if (name.split(' ').length <= 4 && !NOT_A_NAME.test(name)) marks.push({ at: (m.index ?? 0) + m[0].indexOf(name), name }); // position where the label starts
    }
    let cursor = 0;
    for (const sentence of splitSentences(chunk.text)) {
      const at = chunk.text.indexOf(sentence.slice(0, 40), cursor);
      if (at >= 0) cursor = at;
      for (const mark of marks) if (mark.at <= cursor + 1) speaker = mark.name;

      const isNoGuidance = NO_GUIDANCE.test(sentence);
      if ((!isNoGuidance && sentence.length < 30) || sentence.length > 600) continue;
      if (sentence.trim().endsWith('?')) continue; // questions are not management statements
      if (speaker && /moderator|operator/i.test(speaker)) continue;
      if (!isNoGuidance && !CUE.test(sentence)) continue;

      const quote = sentence.replace(SPEAKER, ' ').trim();
      const key = quote.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const subject = subjectOf(quote);
      const t = target(quote, subject);
      out.push({
        chunkId: chunk.id,
        quote,
        speaker,
        subject,
        ...t,
        horizonText: explicitHorizon(quote) ?? RELATIVE.exec(quote)?.[0] ?? null,
        horizonPeriod: explicitHorizon(quote),
      });
    }
  }
  // Metric-specific and policy statements first, then general commentary; cap per call, keep transcript order.
  const rank = (d: StatementDraft) => (d.subject === 'guidance_policy' ? 0 : d.nature === 'quantitative' ? 1 : d.subject !== 'business' ? 2 : d.horizonPeriod ? 3 : 4);
  return out
    .map((d, i) => ({ d, i }))
    .sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.d);
}

/**
 * Checks a (model-proposed) refinement against the verbatim quote. Figures and
 * an explicit horizon are accepted only if they literally appear in the quote.
 */
export function figuresAppearInQuote(quote: string, values: (number | null)[], horizonPeriod: string | null): boolean {
  const normalized = quote.replace(/,/g, '');
  for (const v of values) {
    if (v === null) continue;
    const s = String(v);
    if (!new RegExp(`(^|[^\\d.])${s.replace('.', '\\.')}(?![\\d])`).test(normalized)) return false;
  }
  if (horizonPeriod && explicitHorizon(quote) !== horizonPeriod) return false;
  return true;
}
