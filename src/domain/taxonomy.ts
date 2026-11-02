/**
 * Announcement taxonomy (reference document §1) and the deterministic,
 * title-based classifier. Classification never edits source text; it returns
 * a separate record that cites the rule that fired.
 */

export const CATEGORIES = [
  'results',
  'ma',
  'fund_raise',
  'management_change',
  'litigation',
  'insider_trading',
  'earnings_call',
  'investor_meetings',
  'credit_rating',
  'dividend',
  'bonus_split',
  'capex',
  'press_release',
  'postal_ballot',
  'agm_egm',
  'pledging',
  'unclassified',
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  results: 'Results',
  ma: 'M&A',
  fund_raise: 'Fund raise',
  management_change: 'Management change',
  litigation: 'Litigation',
  insider_trading: 'Insider trading',
  earnings_call: 'Earnings call',
  investor_meetings: 'Investor meetings',
  credit_rating: 'Credit rating',
  dividend: 'Dividend',
  bonus_split: 'Bonus / split',
  capex: 'Capex',
  press_release: 'Press release',
  postal_ballot: 'Postal ballot',
  agm_egm: 'AGM / EGM',
  pledging: 'Pledging',
  unclassified: 'Unclassified',
};

export const CLASSIFIER_VERSION = 'rules.v2';

export type ClassificationStatus =
  /** One or more rules matched; `category` is the primary match. */
  | 'matched'
  /** Matched a known routine-paperwork pattern; category is `unclassified`. */
  | 'routine'
  /** Title is too generic to classify safely; category is `unclassified`. */
  | 'ambiguous'
  /** No rule matched. Category is `unclassified`; a model may be consulted later. */
  | 'no_match';

export type Classification = {
  category: Category;
  status: ClassificationStatus;
  /** Other categories the title also matched, e.g. results + fund_raise in one board outcome. */
  secondary: Category[];
  /** Rule ids that fired, for audit. */
  ruleIds: string[];
  method: 'rule';
  version: string;
};

type Rule = {
  id: string;
  test: RegExp;
  /** Must NOT match for the rule to apply. */
  unless?: RegExp;
} & ({ category: Exclude<Category, 'unclassified'> } | { routine: true } | { ambiguous: Category[] });

// Order matters only within the routine/ambiguous groups, which short-circuit.
// Category rules are all evaluated; precedence below picks the primary.
const ROUTINE_RULES: Rule[] = [
  { id: 'routine:trading_window', test: /trading window/i, routine: true },
  { id: 'routine:esop', test: /\b(esop|esos|employee stock|stock option)/i, routine: true },
  { id: 'routine:compliance_certificate', test: /compliance certificate|regulation 74\s*\(5\)|reg\.?\s*74\s*\(5\)|regulation 40\s*\(9\)|certificate under regulation/i, routine: true },
  { id: 'routine:investor_complaints', test: /investor (complaints|grievance)/i, routine: true },
  { id: 'routine:share_certificate', test: /(loss of|duplicate) share certificate|transmission of shares/i, routine: true },
  { id: 'routine:esg', test: /\b(brsr|business responsibility|esg|sustainability report)\b/i, routine: true },
  { id: 'routine:shareholding_pattern', test: /shareholding pattern/i, routine: true },
  {
    id: 'routine:auditor',
    test: /\b(secretarial|statutory|cost|internal) auditors?\b/i,
    unless: /\b(director|ceo|cfo|managing director|chief|key managerial)\b/i,
    routine: true,
  },
  {
    id: 'routine:newspaper',
    test: /newspaper (publication|advertisement)/i,
    unless: /\bresults?\b/i,
    routine: true,
  },
];

const AMBIGUOUS_RULES: Rule[] = [
  // Usually a results deck, but also used for strategy days and conference decks.
  {
    id: 'ambiguous:investor_presentation',
    test: /investor presentation/i,
    unless: /\b(results?|quarter|q[1-4]|half year|annual)\b/i,
    ambiguous: ['results', 'investor_meetings'],
  },
  // An outcome or intimation with no stated subject could be anything the board approved.
  // Observed on BSE: "Board Meeting Outcome for Outcome Of Board Meeting Held On 30Th October, 2026".
  {
    id: 'ambiguous:board_outcome',
    test: /^\s*(board meeting (outcome|intimation) for )?(outcome of |notice of )?(the )?board meeting( outcome)?( held on [^,]*(, \d{4})?)?\s*\.?\s*$/i,
    ambiguous: ['results', 'ma', 'fund_raise', 'dividend'],
  },
  // "(LODR)-Allotment" alone: could be ESOP shares (routine) or securities (fund raise).
  {
    id: 'ambiguous:allotment',
    test: /-\s*allotment\s*$/i,
    ambiguous: ['fund_raise'],
  },
];

const CATEGORY_RULES: Rule[] = [
  { id: 'results:financial_results', test: /financial results?|\bresults? for the (quarter|half|year|period)|\b(audited|unaudited) (financial )?results/i, category: 'results' },
  { id: 'results:investor_presentation', test: /investor presentation/i, category: 'results' },
  { id: 'results:presentation', test: /\bresults? presentation\b|\b(q[1-4]|h[12]|fy\s?\d{2,4})\b.*\bresults\b/i, category: 'results' },
  { id: 'results:newspaper', test: /newspaper (publication|advertisement)/i, category: 'results' },
  { id: 'earnings_call:transcript', test: /(earnings|conference|concall|con-call|analyst)[\s-]*call|transcript|audio recording|video recording/i, category: 'earnings_call' },
  { id: 'investor_meetings:meet', test: /analyst\s*\/?\s*investor meet|investor meet|analyst meet|institutional investor|investor conference|non-deal roadshow/i, category: 'investor_meetings' },
  { id: 'ma:deal', test: /\b(acquisition|acquire[sd]?|amalgamation|merger|demerger|scheme of arrangement|joint venture|\bjv\b|wholly[- ]owned subsidiary|incorporation of (a )?(new )?subsidiary|divest|disinvest|sale of (stake|shares|business)|slump sale|stake (sale|purchase))/i, category: 'ma' },
  { id: 'fund_raise:instrument', test: /\b(qualified institutions? placement|\bqip\b|rights issue|preferential (issue|allotment)|buy[- ]?back|commercial paper|non[- ]convertible debentures?|\bncds?\b|debentures?|fund raising|raising of funds|issue of (equity|securities|bonds))/i, unless: /\bbonus\b/i, category: 'fund_raise' },
  { id: 'management_change:kmp', test: /change in (directors?|directorate|key managerial|management|kmp|senior management)|\b(appointment|re-?appointment|resignation|cessation|retirement) of\b.*\b(director|ceo|cfo|chief|managing director|whole[- ]time|key managerial|company secretary|compliance officer)|\b(ceo|cfo|managing director) (appointed|resigns)|\(lodr\)\s*-\s*(cessation|resignation|appointment)\b/i, category: 'management_change' },
  { id: 'litigation:legal', test: /\b(litigation|dispute|penalty|show cause|insolvency|\bnclt\b|\bcirp\b|arbitration|lawsuit|demand (notice|order)|tax demand|regulatory action|adverse order|order (passed|received) (by|from) (the )?(sebi|court|tribunal|authority|commissioner|nclt|cci))/i, category: 'litigation' },
  { id: 'insider_trading:pit', test: /insider trading|sebi \(pit\)|prohibition of insider|regulation 7\s*\(2\)|substantial acquisition|\bsast\b|regulation 29|disclosure of (acquisition|disposal)/i, category: 'insider_trading', unless: /trading window/i },
  { id: 'credit_rating:rating', test: /credit rating|rating (action|assigned|reaffirmed|upgrade|downgrade|revised)|\b(crisil|icra|care ratings|india ratings|fitch|moody)/i, category: 'credit_rating' },
  { id: 'dividend:declared', test: /\bdividend\b/i, category: 'dividend' },
  { id: 'bonus_split:corporate_action', test: /\bbonus (issue|shares?)\b|sub[- ]?division|stock split|split of (equity )?shares/i, category: 'bonus_split' },
  { id: 'capex:capacity', test: /\bcapex\b|capital expenditure|capacity expansion|(new|greenfield|brownfield) (plant|facility|unit)|commissioning of|commercial production|setting up (of )?(a )?(new )?(plant|facility|unit)/i, category: 'capex' },
  { id: 'press_release:release', test: /press release|media release|\border (win|received|bagged)|bags? (an? )?orders?|receipt of orders?|new product|clarification|partnership|\bmou\b|^[\w&.' -]+ announces\b/i, category: 'press_release' },
  { id: 'postal_ballot:ballot', test: /postal ballot/i, category: 'postal_ballot' },
  { id: 'agm_egm:meeting', test: /\b(annual general meeting|extra[- ]?ordinary general meeting|\bagm\b|\begm\b)/i, category: 'agm_egm' },
  { id: 'pledging:encumbrance', test: /\bpledge|encumbrance|regulation 31\b|invocation of/i, category: 'pledging' },
];

/** Primary-category precedence when several rules match one title. */
const PRECEDENCE: Exclude<Category, 'unclassified'>[] = [
  'results',
  'ma',
  'management_change',
  'litigation',
  'fund_raise',
  'credit_rating',
  'pledging',
  'insider_trading',
  'capex',
  'bonus_split',
  'dividend',
  'earnings_call',
  'investor_meetings',
  'postal_ballot',
  'agm_egm',
  'press_release',
];

const applies = (rule: Rule, text: string) => rule.test.test(text) && !(rule.unless && rule.unless.test(text));

/** Classifies an announcement from its filed title (and optional exchange category string). */
export function classifyAnnouncement(title: string, exchangeCategory?: string | null): Classification {
  const text = (exchangeCategory ? `${title} — ${exchangeCategory}` : title).replace(/\s+/g, ' ').trim();
  const base = { method: 'rule' as const, version: CLASSIFIER_VERSION };

  const routine = ROUTINE_RULES.find((r) => applies(r, text));
  if (routine) return { ...base, category: 'unclassified', status: 'routine', secondary: [], ruleIds: [routine.id] };

  const matched = CATEGORY_RULES.filter((r) => applies(r, text) && 'category' in r);
  const ambiguous = AMBIGUOUS_RULES.find((r) => applies(r, text));

  if (ambiguous && 'ambiguous' in ambiguous) {
    // A specific rule can still resolve it (e.g. "results" wording elsewhere in the title).
    const specific = matched.filter((r) => r.id !== 'results:investor_presentation');
    if (specific.length === 0) {
      return { ...base, category: 'unclassified', status: 'ambiguous', secondary: ambiguous.ambiguous, ruleIds: [ambiguous.id] };
    }
  }

  const categories = [...new Set(matched.map((r) => ('category' in r ? r.category : null)).filter((c): c is Exclude<Category, 'unclassified'> => c !== null))];
  if (categories.length === 0) return { ...base, category: 'unclassified', status: 'no_match', secondary: [], ruleIds: [] };

  const ordered = PRECEDENCE.filter((c) => categories.includes(c));
  const [primary, ...secondary] = ordered;
  if (!primary) return { ...base, category: 'unclassified', status: 'no_match', secondary: [], ruleIds: [] };
  return { ...base, category: primary, status: 'matched', secondary, ruleIds: matched.map((r) => r.id) };
}
