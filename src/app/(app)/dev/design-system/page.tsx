import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DesignSystemGallery } from './DesignSystemGallery';

// Evaluate the gate per request so FINN_ENABLE_DEV_ROUTES works at runtime, not only at build time.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Design system',
  robots: { index: false, follow: false },
};

function devRoutesEnabled(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.FINN_ENABLE_DEV_ROUTES === 'true';
}

export default function DesignSystemPage() {
  if (!devRoutesEnabled()) notFound();
  return <DesignSystemGallery />;
}
