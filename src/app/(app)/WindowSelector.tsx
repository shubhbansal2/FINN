'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';

import { PeriodSelector } from '@/ui/PeriodSelector';

const OPTIONS = [
  { value: '24h', label: '24h', description: 'Last 24 hours' },
  { value: '3d', label: '3d', description: 'Last 3 days' },
  { value: '7d', label: '7d', description: 'Last 7 days' },
  { value: '30d', label: '30d', description: 'Last 30 days' },
] as const;

type Value = (typeof OPTIONS)[number]['value'];

/**
 * Digest window control. The window lives in the URL so it is shareable; the
 * choice is also saved as the default for the next visit without a window.
 */
export function WindowSelector({ value }: { value: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const choose = (v: Value) => {
    const next = new URLSearchParams(params.toString());
    next.set('window', v);
    start(() => router.push(`${pathname}?${next.toString()}`));
    fetch('/api/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'signals.window', value: v }) })
      .then((r) => {
        if (!r.ok) console.warn(`Default window not saved (HTTP ${r.status}); this view is unaffected.`);
      })
      .catch((e: unknown) => console.warn('Default window not saved; this view is unaffected.', e));
  };
  const current = (OPTIONS.find((o) => o.value === value)?.value ?? '24h') as Value;
  return (
    <span aria-busy={pending || undefined}>
      <PeriodSelector label="Window" options={OPTIONS} value={current} onChange={choose} />
    </span>
  );
}
