import Link from 'next/link';

import { EmptyState } from '@/ui/EmptyState';

export default function NotFound() {
  return (
    <EmptyState size="page" title="There is no page at this address." action={<Link href="/">Go to Signals</Link>}>
      The link may be from an older version of FINN.
    </EmptyState>
  );
}
