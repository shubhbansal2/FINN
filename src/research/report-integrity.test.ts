// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { passageFor } from './engine';
import { ResearchReportSchema, type ResearchReport } from './report';

/**
 * Source-integrity checks over every recorded demo report (real live runs,
 * committed under fixtures/research). These assert properties of the output,
 * so they catch citation mistakes however the engine produced them.
 */

const DIR = path.join(process.cwd(), 'fixtures', 'research');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const load = (f: string): { recordedAt: string; report: ResearchReport } => {
  const raw = JSON.parse(readFileSync(path.join(DIR, f), 'utf8')) as { recordedAt: string; source: string; report: unknown };
  return { recordedAt: raw.recordedAt, report: ResearchReportSchema.parse(raw.report) };
};

/** Every evidence id referenced anywhere in the modules. */
function referencedIds(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => referencedIds(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'evidenceIds' || k === 'actualEvidenceIds') && Array.isArray(v)) v.forEach((id) => out.add(String(id)));
      else if (k === 'evidenceId' && typeof v === 'string') out.add(v);
      else referencedIds(v, out);
    }
  }
  return out;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

describe.each(files)('recorded report %s', (file) => {
  const { report } = load(file);
  const used = new Set(report.sources.filter((s) => s.state === 'used').map((s) => s.documentId));

  it('every cited id resolves to stored evidence (no invented citations)', () => {
    const missing = [...referencedIds(report.modules)].filter((id) => !report.evidence[id]);
    expect(missing).toEqual([]);
  });

  it('every citation points at a document this run actually used, with an https link', () => {
    for (const e of Object.values(report.evidence)) {
      expect(used.has(e.documentId), `${e.id} cites ${e.documentId}`).toBe(true);
      if (e.url) expect(new URL(e.url).protocol).toBe('https:');
    }
  });

  it('every quoted span appears verbatim in its passage', () => {
    for (const e of Object.values(report.evidence)) if (e.quote) expect(collapse(e.passage), e.id).toContain(collapse(e.quote));
    for (const s of report.modules.guidance.data?.statements ?? []) expect(collapse(report.evidence[s.evidenceId]?.passage ?? ''), s.id).toContain(collapse(s.quote));
  });

  it('every reported figure in the table cites evidence for the same value, period and basis', () => {
    for (const t of report.modules.trajectory.data?.tables ?? []) {
      for (const row of t.rows) {
        row.cells.forEach((cell, i) => {
          if (cell.state !== 'value' || cell.formula !== null) return; // derived cells cite their inputs
          const col = t.columns[i];
          expect(cell.evidenceIds).toHaveLength(1);
          const ev = report.evidence[cell.evidenceIds[0] ?? ''];
          expect(ev?.reported, `${row.key} ${col?.label}`).toMatchObject({ period: col?.label, basis: t.basis, normalizedInr: cell.value });
          expect(ev?.page).not.toBeNull();
        });
      }
    }
  });

  it('is labelled with the company it was run for and no other', () => {
    expect(file).toBe(`${report.company.id.replace(/[^a-z0-9]+/gi, '_')}.json`);
    for (const s of report.sources) {
      expect(new URL(s.url).protocol).toBe('https:');
      if (s.origin === 'exchange_filed') expect(s.url).toMatch(/^https:\/\/(www\.)?bseindia\.com\//);
    }
  });
});

describe('passageFor', () => {
  const long = `${'a '.repeat(2_000)}The target is 18 to 20   percent for FY27. ${'b '.repeat(2_000)}`;

  it('keeps short chunks whole and centres long ones on the quoted span', () => {
    expect(passageFor('short text', 'short')).toBe('short text');
    const p = passageFor(long, 'The target is 18 to 20 percent for FY27.', 400);
    expect(p).toContain('The target is 18 to 20   percent for FY27.');
    expect(p.length).toBe(400);
  });

  it('falls back to the start when the quote is absent', () => {
    expect(passageFor(long, 'not in the text', 100)).toBe(long.slice(0, 100));
  });
});
