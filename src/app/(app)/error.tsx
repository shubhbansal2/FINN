'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import { Banner } from '@/ui/Banner';
import { Button } from '@/ui/Button';

/**
 * Last-resort boundary for a page that failed to render. Pages handle their
 * expected failures (a provider down, a document missing) in place; reaching
 * this means an unexpected server error, most often the local database.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <Banner tone="error" title="This page could not be built" action={<Button size="sm" onClick={reset}>Try again</Button>}>
      The server failed while reading FINN&apos;s local database or assembling this page{error.digest ? ` (reference ${error.digest})` : ''}. Nothing was changed. Other sections may still work: <Link href="/">Signals</Link>, <Link href="/research">Research</Link>, <Link href="/watchlist">Watchlist</Link>.
    </Banner>
  );
}
