import {
  parseReportedNumber,
  parseUnitScale,
  periodEnding,
  reportedCurrencyFact,
  type FinancialFact,
  type Period,
  type StatementBasis,
  type UnitScale,
} from '@/domain/facts';

/**
 * Deterministic parser for Indian listed-company results filings (SEBI LODR
 * Reg. 33 format). It extracts only rows it can name exactly, keeps every
 * printed figure verbatim, assigns columns by the standard layout, and then
 * proves or disproves that assignment with arithmetic:
 *   - PBT − tax = PAT, per column;
 *   - year-to-date = sum of its quarters (Q2: H1 = Q1 + Q2), when both are present.
 * A figure is `checks_passed` only if every applicable check holds;
 * `check_failed` if any fails; `unverified` if no check could run.
 */

export const RESULTS_PARSER_VERSION = 'results-rows.v2';

export type ParsedMetric =
  | 'revenue_from_operations'
  | 'other_income'
  | 'total_income'
  | 'finance_costs'
  | 'depreciation_amortisation'
  | 'exceptional_items'
  | 'pbt'
  | 'tax_current'
  | 'tax_deferred'
  | 'tax_expense'
  | 'profit_after_tax'
  | 'profit_after_associates'
  | 'cash_from_operations'
  | 'capex_ppe';

const METRIC_PATTERNS: [ParsedMetric, RegExp][] = [
  ['revenue_from_operations', /^(i+)?revenuefromoperations$/],
  ['other_income', /^(i+)?otherincome$/],
  ['total_income', /^(i+)?totalincome$/],
  ['finance_costs', /^(i+|[a-h])?financecosts?$/],
  ['depreciation_amortisation', /^(i+|[a-h])?depreciation(and)?amorti[sz]ation.*$/],
  ['exceptional_items', /^(i+)?exceptionalitems?(net)?$/],
  ['pbt', /^(i+|v+i*)?(net)?profit(loss)?beforetax$/],
  ['tax_current', /^(i+|[a-h])?currenttax$/],
  ['tax_deferred', /^(i+|[a-h])?deferredtax(charge)?(credit)?$/],
  ['tax_expense', /^(i+|v+i*)?(total)?taxexpenses?$/],
  ['profit_after_tax', /^(i+|v+i*)?(net)?profit(loss)?(aftertax|forthe(period|year|quarter))$/],
  ['profit_after_associates', /^profit(loss)?aftertaxandshareof/],
  ['cash_from_operations', /^netcash(flows?)?(generated)?(from|used)?(in)?(\/)?(from)?operatingactivities$/],
  ['capex_ppe', /^(purchase|acquisition)sofpropertyplantandequipment|^(purchase|acquisition)ofpropertyplantandequipment/],
];

const STOP_LINE = /registered office|corporate communications|^cin\b|page \d+ of/i;

/** Normalizes OCR artefacts in numeric text: braces for brackets, spaces inside digit groups. */
export function repairNumericText(line: string): string {
  let s = line.replace(/\{/g, '(').replace(/\}/g, ')').replace(/[−–]/g, '-');
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    s = s.replace(/(\d)\s+,\s*(\d)/g, '$1,$2').replace(/(\d),\s+(\d)/g, '$1,$2');
    // Indian grouping: the final group after a comma is 3 digits; "13 5" → "135", "4 00" → "400".
    s = s.replace(/(,\d{1,2}) (\d{1,2})(?=\D|$)/g, (m, a: string, b: string) => (a.length - 1 + b.length === 3 ? `${a}${b}` : m));
    if (s === before) break;
  }
  return s;
}

// The grouped form needs at least one comma; otherwise "3994.57" (printed without separators) would split into "399" and "4.57".
const NUMBER = /\(?-?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\)?|\(?-?\d+(?:\.\d+)?\)?/g;

export type ParsedRow = { label: string; key: string; numbers: string[] };

/** Splits a line into label text and printed numbers. Returns null for lines without a label or numbers. */
export function parseRow(raw: string): ParsedRow | null {
  const line = repairNumericText(raw.trim()).replace(/^\d{1,2}\s+(?=[A-Za-z(])/, '');
  const first = line.search(/\(?-?\d/);
  if (first <= 0) return null;
  const label = line.slice(0, first).trim();
  const key = label.toLowerCase().replace(/[^a-z]/g, '');
  if (key.length < 3) return null;
  const numbers = (line.slice(first).match(NUMBER) ?? []).filter((t) => /\d/.test(t));
  return numbers.length ? { label, key, numbers } : null;
}

const isNumberOnly = (line: string) => {
  const t = repairNumericText(line.trim());
  return t.length > 0 && (t.match(/[A-Za-z]/g) ?? []).length <= 1 && (t.match(NUMBER) ?? []).length >= 1;
};

export function metricForKey(key: string): ParsedMetric | null {
  for (const [metric, re] of METRIC_PATTERNS) if (re.test(key)) return metric;
  return null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** The quarter-end the filing reports on, from "… ENDED 30TH SEPTEMBER, 2026" (tolerant of OCR noise in the day). */
export function detectPeriodEnd(text: string): string | null {
  const re = /ended[^a-z\n]{0,12}(?:[a-z0-9]{1,6}\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)[\s,.'’]*(\d{4})/gi;
  const counts = new Map<string, number>();
  for (const m of text.matchAll(re)) {
    const month = MONTHS[(m[1] ?? '').slice(0, 3).toLowerCase()];
    const year = Number(m[2]);
    if (!month || ![3, 6, 9, 12].includes(month) || year < 2000 || year > 2100) continue;
    const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    counts.set(end, (counts.get(end) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];
  return best?.[0] ?? null;
}

function shiftEnd(end: string, months: number): string {
  const [y, m] = end.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + months + 1, 0)).toISOString().slice(0, 10);
}

function mustPeriod(type: Period['type'], end: string): Period | null {
  const r = periodEnding(type, end);
  return r.ok ? r.value : null;
}

/**
 * Standard column order of a Reg. 33 results table, by the quarter reported:
 *   Q1: Q, Q−1, Q−4, FY−1
 *   Q2: Q, Q−1, Q−4, H1, H1−1, FY−1
 *   Q3: Q, Q−1, Q−4, 9M, 9M−1, FY−1
 *   Q4: Q, Q−1, Q−4, FY, FY−1
 */
export function standardColumns(quarterEnd: string): (Period | null)[] {
  const month = Number(quarterEnd.slice(5, 7));
  const q = mustPeriod('quarter', quarterEnd);
  const prevQ = mustPeriod('quarter', shiftEnd(quarterEnd, -3));
  const yoyQ = mustPeriod('quarter', shiftEnd(quarterEnd, -12));
  const lastFyEnd = month === 3 ? shiftEnd(quarterEnd, -12) : `${Number(quarterEnd.slice(0, 4)) - (month < 3 ? 1 : 0)}-03-31`;
  const prevFy = mustPeriod('financial_year', month === 3 ? shiftEnd(quarterEnd, -12) : lastFyEnd);
  if (month === 6) return [q, prevQ, yoyQ, prevFy];
  if (month === 9) return [q, prevQ, yoyQ, mustPeriod('half_year', quarterEnd), mustPeriod('half_year', shiftEnd(quarterEnd, -12)), prevFy];
  if (month === 12) return [q, prevQ, yoyQ, mustPeriod('nine_months', quarterEnd), mustPeriod('nine_months', shiftEnd(quarterEnd, -12)), prevFy];
  return [q, prevQ, yoyQ, mustPeriod('financial_year', quarterEnd), prevFy];
}

export type PageInput = { pageNumber: number; text: string };

export type ResultsParse = {
  quarterEnd: string | null;
  facts: FinancialFact[];
  diagnostics: string[];
};

type RowWithColumns = { label: string; metric: ParsedMetric | null; cells: string[]; repaired?: boolean; suspect?: boolean };

/**
 * OCR sometimes splits one figure into two tokens ("166,013" → "16 6,013").
 * When a row has exactly one token more than the table, merge the one adjacent
 * pair that forms a well-formed number. The row is then flagged as repaired:
 * its figures stay unverified unless another source confirms them.
 */
export function repairSplitTokens(cells: string[], expected: number): string[] | null {
  if (cells.length !== expected + 1) return null;
  const candidates: string[][] = [];
  for (let i = 0; i < cells.length - 1; i += 1) {
    const a = cells[i] ?? '';
    const b = cells[i + 1] ?? '';
    if (!/^\(?\d{1,3}$/.test(a) || !/^\d{1,3}(,\d{2,3})*\)?$/.test(b)) continue;
    const merged = `${a}${b}`;
    if (!/^\(?\d{1,3}(,\d{2})*,\d{3}\)?$|^\(?\d{1,3},\d{3}\)?$/.test(merged)) continue;
    candidates.push([...cells.slice(0, i), merged, ...cells.slice(i + 2)]);
  }
  // Ambiguous (more than one plausible merge): do not guess.
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

const EXPENSE_METRICS: ReadonlySet<ParsedMetric> = new Set(['finance_costs', 'depreciation_amortisation', 'tax_current', 'tax_deferred', 'tax_expense']);

function pageBasis(text: string): StatementBasis | null {
  const head = text.slice(0, 600).toLowerCase().replace(/[^a-z]/g, '');
  const c = head.includes('consolidated');
  const s = head.includes('standalone');
  if (c === s) return null;
  return c ? 'consolidated' : 'standalone';
}

/** Rows of one page, with trailing number blocks aligned to rows when counts match exactly. */
function pageRows(text: string): RowWithColumns[] {
  const lines = text.split('\n');
  const rows: RowWithColumns[] = [];
  let lastRowLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (STOP_LINE.test(line)) break;
    const r = parseRow(line);
    if (!r) continue;
    rows.push({ label: r.label, metric: metricForKey(r.key), cells: r.numbers });
    lastRowLine = i;
  }
  if (rows.length < 3) return rows;

  // Layout split: labels carry the first columns inline; remaining columns follow as
  // number-only lines in the same row order. Align a run only if its length equals the row count.
  const inline = rows[0]?.cells.length ?? 0;
  if (!rows.every((r) => r.cells.length === inline)) return rows;
  const runs: string[][][] = [];
  let run: string[][] = [];
  for (let i = lastRowLine + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (isNumberOnly(line)) run.push((repairNumericText(line).match(NUMBER) ?? []).filter((t) => /\d/.test(t)));
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  for (const candidate of runs) {
    if (candidate.length !== rows.length) continue;
    const width = candidate[0]?.length ?? 0;
    if (!width || !candidate.every((c) => c.length === width)) continue;
    candidate.forEach((cells, i) => rows[i]?.cells.push(...cells));
  }
  return rows;
}

const value = (printed: string | undefined): number | null => {
  if (printed === undefined) return null;
  const p = parseReportedNumber(printed);
  return p.kind === 'number' ? p.value : null;
};

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(2, Math.abs(b) * 0.0005);

export function parseResultsPages(pages: PageInput[], ctx: { companyId: string; documentId: string; ingestedAt: string }): ResultsParse {
  const diagnostics: string[] = [];
  const quarterEnd = detectPeriodEnd(pages.slice(0, 12).map((p) => p.text).join('\n'));
  if (!quarterEnd) return { quarterEnd: null, facts: [], diagnostics: ['reporting period not found in the filing title; no figures extracted'] };
  const columns = standardColumns(quarterEnd);
  const facts: FinancialFact[] = [];

  for (const page of pages) {
    const basis = pageBasis(page.text);
    const rows = pageRows(page.text).filter((r) => r.metric);
    if (rows.length === 0) continue;
    if (!basis) {
      diagnostics.push(`p. ${page.pageNumber}: statement basis (consolidated/standalone) not stated in page title; skipped`);
      continue;
    }
    const scale: UnitScale | null = parseUnitScale(page.text);
    if (!scale) {
      diagnostics.push(`p. ${page.pageNumber}: unit (crore/lakh/million) not stated; skipped`);
      continue;
    }

    // First occurrence of each metric on the page wins; later repeats are usually notes.
    const byMetric = new Map<ParsedMetric, RowWithColumns>();
    for (const r of rows) if (r.metric && !byMetric.has(r.metric)) byMetric.set(r.metric, r);

    // The table's column count is the most common row width; rows that differ are suspect.
    const widths = [...byMetric.values()].map((r) => r.cells.length);
    const modal = [...new Set(widths)].sort((a, b) => widths.filter((w) => w === b).length - widths.filter((w) => w === a).length || b - a)[0] ?? 0;
    for (const r of byMetric.values()) {
      if (r.cells.length === modal) continue;
      const fixed = repairSplitTokens(r.cells, modal);
      if (fixed) {
        r.cells = fixed;
        r.repaired = true;
        diagnostics.push(`p. ${page.pageNumber}: "${r.label.slice(0, 40)}" had a split figure; merged OCR tokens (unverified unless confirmed elsewhere)`);
      } else {
        r.suspect = true;
        diagnostics.push(`p. ${page.pageNumber}: "${r.label.slice(0, 40)}" has ${r.cells.length} figures where the table has ${modal}; row not used`);
      }
    }
    for (const [m, r] of byMetric) if (r.suspect) byMetric.delete(m);
    const width = Math.min(columns.length, modal);

    // Column checks. Some tables print taxes as deductions "(5,250)": accept either convention.
    const colStatus: ('passed' | 'failed' | 'none')[] = [];
    const notes: string[] = [];
    let deductionStyle = false;
    for (let j = 0; j < width; j += 1) {
      const pbt = value(byMetric.get('pbt')?.cells[j]);
      const pat = value(byMetric.get('profit_after_tax')?.cells[j]);
      const taxTotal = value(byMetric.get('tax_expense')?.cells[j]);
      const cur = value(byMetric.get('tax_current')?.cells[j]);
      const def = value(byMetric.get('tax_deferred')?.cells[j]);
      const tax = taxTotal ?? (cur !== null && def !== null ? cur + def : null);
      let status: 'passed' | 'failed' | 'none' = 'none';
      if (pbt !== null && pat !== null && tax !== null) {
        if (close(pbt - tax, pat)) status = 'passed';
        else if (close(pbt + tax, pat)) {
          status = 'passed';
          deductionStyle = true;
        } else {
          status = 'failed';
          notes.push(`column ${j + 1}: PBT ${pbt} − tax ${Math.abs(tax)} ≠ PAT ${pat}`);
        }
      }
      colStatus.push(status);
    }
    if (deductionStyle) {
      // Expense lines printed as negatives belong to a reconciliation layout; take expenses from the statement page instead.
      for (const m of EXPENSE_METRICS) byMetric.delete(m);
    }
    // Year-to-date additivity proves the column mapping (Q2 and Q3 filings).
    const month = Number(quarterEnd.slice(5, 7));
    if ((month === 9 || month === 12) && width >= 4) {
      for (const metric of ['revenue_from_operations', 'pbt'] as const) {
        const r = byMetric.get(metric);
        const q = value(r?.cells[0]);
        const prev = value(r?.cells[1]);
        const ytd = value(r?.cells[3]);
        if (q === null || prev === null || ytd === null) continue;
        // H1 = Q1 + Q2 exactly; for 9M only a lower bound (Q1 is not in the table).
        const ok = month === 9 ? close(q + prev, ytd) : ytd > q + prev;
        if (!ok) {
          notes.push(`${metric}: year-to-date column does not reconcile with the quarters; column mapping not confirmed`);
          for (let j = 3; j < width; j += 1) colStatus[j] = 'failed';
        } else if (colStatus[3] === 'none') colStatus[3] = 'passed';
      }
    }
    if (notes.length) diagnostics.push(`p. ${page.pageNumber} (${basis}): ${notes.join('; ')}`);

    for (const [metric, row] of byMetric) {
      for (let j = 0; j < width; j += 1) {
        const period = columns[j];
        const printed = row.cells[j];
        if (!period || printed === undefined) continue;
        // A repaired row never inherits a pass from other rows' arithmetic.
        const status = row.repaired ? 'none' : (colStatus[j] ?? 'none');
        try {
          const fact = reportedCurrencyFact({
            companyId: ctx.companyId,
            metric,
            basis,
            period,
            printed,
            scale,
            sourceDocumentId: ctx.documentId,
            sourceLocation: { page: page.pageNumber, rowLabel: row.label.slice(0, 200), columnLabel: `${period.label} (column ${j + 1}, standard Reg. 33 order)` },
            extractionMethod: 'rule_parser',
            extractorVersion: RESULTS_PARSER_VERSION,
            verificationStatus: status === 'passed' ? 'checks_passed' : status === 'failed' ? 'check_failed' : 'unverified',
            ingestedAt: ctx.ingestedAt,
          });
          facts.push(status === 'failed' ? { ...fact, verificationNote: notes.join('; ').slice(0, 500) } : fact);
        } catch (e) {
          diagnostics.push(`p. ${page.pageNumber}: could not record ${metric} column ${j + 1} (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    }
  }
  if (facts.length === 0) diagnostics.push('no recognisable results rows with inline figures were found');
  return { quarterEnd, facts, diagnostics };
}
