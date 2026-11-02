import { readdirSync } from 'node:fs';
import path from 'node:path';

import type { Metadata } from 'next';

import { getCompany, listCompanies } from '@/db/repositories';
import { researchHistory } from '@/research/engine';
import { runtime } from '@/server/runtime';
import { PageHeader } from '@/ui/PageHeader';

import { ResearchWorkspace, type CompanyRef, type HistoryEntry } from './ResearchWorkspace';

export const metadata: Metadata = { title: 'Research' };
export const dynamic = 'force-dynamic';

const refOf = (c: { id: string; name: string; nseSymbol: string | null; bseCode: string | null }): CompanyRef => ({ id: c.id, name: c.name, symbol: c.nseSymbol ?? c.bseCode ?? c.id });

/** Demo mode's history is the set of recorded reports; live mode's is what has been run on this server. */
function history(mode: 'live' | 'fixture'): HistoryEntry[] {
  const { db } = runtime();
  const byId = new Map(listCompanies(db).map((c) => [c.id, c]));
  if (mode === 'live') {
    return researchHistory(db).flatMap((h) => {
      const c = byId.get(h.companyId);
      return c ? [{ company: refOf(c), kind: 'stored' as const, generatedAt: h.generatedAt, status: h.status }] : [];
    });
  }
  let files: string[] = [];
  try {
    files = readdirSync(path.join(process.cwd(), 'fixtures', 'research')).filter((f) => f.endsWith('.json'));
  } catch (e) {
    console.error('demo report directory unreadable', e);
  }
  return [...byId.values()].filter((c) => files.includes(`${c.id.replace(/[^a-z0-9]+/gi, '_')}.json`)).map((c) => ({ company: refOf(c), kind: 'demo' as const, generatedAt: null, status: null }));
}

export default async function ResearchPage({ searchParams }: { searchParams: Promise<{ company?: string }> }) {
  const { company } = await searchParams;
  const rt = runtime();
  const universe = listCompanies(rt.db, { role: 'research' }).map(refOf);
  const initial = company ? getCompany(rt.db, company) : null;
  let past: HistoryEntry[] = [];
  try {
    past = history(rt.mode);
  } catch (e) {
    console.error('research history read failed', e);
  }
  return (
    <>
      <PageHeader
        title="Research"
        description="Company research built only from annual reports, results filings, earnings-call transcripts and presentations. Every figure and quote links to its page."
      />
      <ResearchWorkspace
        key={initial?.id ?? 'none'}
        suggestions={universe}
        history={past}
        initial={initial ? refOf(initial) : null}
        unknownCompany={company && !initial ? company : null}
        dataMode={rt.mode}
      />
    </>
  );
}
