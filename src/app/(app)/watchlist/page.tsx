import type { Metadata } from 'next';

import { runtime } from '@/server/runtime';
import { getWatchlist } from '@/server/watchlist';
import { Banner } from '@/ui/Banner';
import { PageHeader } from '@/ui/PageHeader';

import { WatchlistView } from './WatchlistView';

export const metadata: Metadata = { title: 'Watchlist' };
export const dynamic = 'force-dynamic';

export default function WatchlistPage() {
  const rt = runtime();
  let data: ReturnType<typeof getWatchlist> | null = null;
  let error: string | null = null;
  try {
    data = getWatchlist(rt.db, { now: rt.clock(), dataMode: rt.mode });
  } catch (e) {
    console.error('watchlist read failed', e);
    error = 'The watchlist could not be read from the local database. Signals and research are unaffected; reload to try again.';
  }
  return (
    <>
      <PageHeader
        title="Watchlist"
        description="The companies the signal feed and alert rules cover. Stored in this server's local database and shared by anyone using it; FINN has no user accounts."
      />
      {error || !data ? <Banner tone="error" title="Watchlist unavailable">{error}</Banner> : <WatchlistView data={data} dataMode={rt.mode} />}
    </>
  );
}
