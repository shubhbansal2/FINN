import type { ReactNode } from 'react';

import { readEnv } from '@/config/env';
import { listCompanies } from '@/db/repositories';
import { runtime } from '@/server/runtime';
import { AppShell, type PaletteCompany } from '@/ui/AppShell';

// The data-mode line must reflect the running server, not the build machine.
export const dynamic = 'force-dynamic';

export default function AppLayout({ children }: { children: ReactNode }) {
  const mode = readEnv().FINN_DATA_MODE;
  // Search is a convenience: if the database cannot be read, navigation still works without it.
  let companies: PaletteCompany[] = [];
  try {
    companies = listCompanies(runtime().db).map((c) => ({ id: c.id, symbol: c.nseSymbol ?? c.bseCode ?? c.id, name: c.name }));
  } catch (e) {
    console.error('company list for search failed', e);
  }
  return (
    <AppShell
      companies={companies}
      status={
        mode === 'live' ? (
          <>
            Live data: Yahoo EOD prices,
            <br />
            exchange filings, company documents.
          </>
        ) : (
          <>
            Demo data: recorded fixtures.
            <br />
            Not current market data.
          </>
        )
      }
    >
      {children}
    </AppShell>
  );
}
