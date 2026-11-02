import type { Metadata } from 'next';

import { listCompanies } from '@/db/repositories';
import { evaluateAlerts } from '@/push/service';
import { listAlerts, listRules } from '@/push/store';
import { Banner } from '@/ui/Banner';
import { PageHeader } from '@/ui/PageHeader';
import { runtime } from '@/server/runtime';

import { AlertsWorkspace } from './AlertsWorkspace';

export const metadata: Metadata = { title: 'Alert settings' };
export const dynamic = 'force-dynamic';

export default function AlertsPage() {
  const rt = runtime();
  const now = rt.clock();
  // Evaluation failing must not hide the saved rules, which are what this page edits.
  let evaluatedAt: string | null = null;
  let evaluationError: string | null = null;
  try {
    evaluatedAt = evaluateAlerts(rt.db, { now, dataMode: rt.mode }).evaluatedAt;
  } catch (e) {
    console.error('alert evaluation failed', e);
    evaluationError = 'Rules could not be evaluated on this load, so the alert list may be out of date. Saved rules are shown and can still be edited.';
  }
  const companies = listCompanies(rt.db, { watchlist: true }).map((c) => ({ id: c.id, name: c.name, symbol: c.nseSymbol ?? c.bseCode ?? c.id }));
  return (
    <>
      <PageHeader
        title="Alert settings"
        description="Rules on end-of-day price, volume and filings for watchlist companies. Each event alerts once per rule; edits apply to later evaluations. Rules are stored in this server's local database and shared by anyone using it."
      />
      {evaluationError ? <Banner tone="warning" title="Alerts not evaluated">{evaluationError}</Banner> : null}
      <AlertsWorkspace alerts={listAlerts(rt.db, { limit: 200 })} rules={listRules(rt.db)} companies={companies} evaluatedAt={evaluatedAt ?? now.toISOString()} />
    </>
  );
}
