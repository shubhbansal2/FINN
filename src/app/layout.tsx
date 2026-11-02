import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import '@fontsource/libre-caslon-text/400.css';
import '@fontsource/libre-caslon-text/400-italic.css';
import '@fontsource/libre-caslon-text/700.css';
import '@fontsource-variable/libre-franklin/wght.css';
import '@fontsource-variable/libre-franklin/wght-italic.css';
import '@fontsource-variable/roboto-mono/wght.css';
import './globals.css';

import { THEME_BOOT_SCRIPT } from '@/ui/theme';

export const metadata: Metadata = {
  title: { default: 'FINN', template: '%s · FINN' },
  description: 'Portfolio filings, end-of-day alerts and primary-source company research.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f4ee' },
    { media: '(prefers-color-scheme: dark)', color: '#121315' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The boot script may set data-theme on <html> before React hydrates; that difference is expected.
    <html lang="en-IN" suppressHydrationWarning>
      <head>
        {/* Applies a saved light/dark choice before first paint. A fixed string, never user content. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
