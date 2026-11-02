'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { CommandPalette, type Command } from './CommandPalette';
import { Icon, type IconName } from './Icon';
import { THEMES } from './theme';
import { ThemeSwitch, useTheme } from './ThemeSwitch';
import styles from './AppShell.module.css';

/** `short` is the bottom-tab label on phones, where four tabs share the width. */
export type NavItem = { href: string; label: string; short: string; icon: IconName };

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Signals', short: 'Signals', icon: 'brief' },
  { href: '/research', label: 'Research', short: 'Research', icon: 'research' },
  { href: '/watchlist', label: 'Watchlist', short: 'Watchlist', icon: 'list' },
  { href: '/alerts', label: 'Alert settings', short: 'Alerts', icon: 'bell' },
];

/** A company the palette can jump to; the id is the same one the feed, watchlist and research use. */
export type PaletteCompany = { id: string; symbol: string; name: string };

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

type AppShellProps = {
  children: ReactNode;
  /** Extra palette commands contributed by the current view. */
  commands?: Command[];
  /** Status line in the rail footer, e.g. data freshness. */
  status?: ReactNode;
  /** Companies offered by search: each opens its research or its signals. */
  companies?: PaletteCompany[];
};

/** Logo: the app's own high-priority mark (three rising bars) beside the name. */
function Wordmark() {
  return (
    <Link href="/" className={styles.wordmark} aria-label="FINN, go to Signals">
      <span className={styles.logoBars} aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      FINN
    </Link>
  );
}

/**
 * Navigation frame. Compact (< 720px): masthead + bottom tab bar, the thumb
 * zone. Medium and wide: a left rail. The command palette is reachable from
 * both (search button, Ctrl/⌘ K, or "/").
 */
export function AppShell({ children, commands = [], status, companies = [] }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isK = event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey);
      const isSlash = event.key === '/' && !event.metaKey && !event.ctrlKey && !isTypingTarget(event.target);
      if (isK || isSlash) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const allCommands = useMemo<Command[]>(
    () => [
      ...NAV_ITEMS.map((item) => ({
        id: `nav:${item.href}`,
        label: item.label,
        group: 'Go to',
        hint: item.href,
        perform: () => router.push(item.href),
      })),
      ...companies.flatMap((c) => [
        { id: `research:${c.id}`, label: `${c.symbol} · ${c.name}`, group: 'Research a company', hint: 'Research', perform: () => router.push(`/research?company=${encodeURIComponent(c.id)}`) },
        { id: `signals:${c.id}`, label: `${c.symbol} · ${c.name}`, group: 'Signals for a company', hint: 'Signals', perform: () => router.push(`/?company=${encodeURIComponent(c.id)}&window=7d`) },
      ]),
      // On phones the rail is hidden, so the search menu is where the theme is changed.
      ...THEMES.map((t) => ({
        id: `theme:${t.value}`,
        label: `${t.label} theme`,
        group: 'Theme',
        hint: t.value === theme ? 'Current' : undefined,
        keywords: ['theme', 'appearance', 'dark mode', 'light mode', t.description],
        perform: () => setTheme(t.value),
      })),
      ...commands,
    ],
    [commands, companies, router, theme, setTheme],
  );

  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>

      <header className={styles.masthead}>
        <Wordmark />
        <button type="button" className={styles.searchIcon} onClick={() => setPaletteOpen(true)} aria-label="Search and navigate">
          <Icon name="search" />
        </button>
      </header>

      <nav className={styles.rail} aria-label="Primary">
        <Wordmark />
        <button type="button" className={styles.searchField} onClick={() => setPaletteOpen(true)}>
          <Icon name="search" size={16} />
          <span>Search</span>
          <kbd className={styles.kbd} aria-label="Shortcut: Control K">
            Ctrl K
          </kbd>
        </button>
        <ul className={styles.railList}>
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link href={item.href} className={styles.railLink} aria-current={active ? 'page' : undefined}>
                  <Icon name={item.icon} size={18} />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className={styles.railFooter}>
          <ThemeSwitch theme={theme} onChange={setTheme} />
          {status ? <div className={styles.railStatus}>{status}</div> : null}
        </div>
      </nav>

      <main id="main" className={styles.main} tabIndex={-1}>
        {children}
      </main>

      <nav className={styles.tabbar} aria-label="Primary">
        <ul className={styles.tabList}>
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link href={item.href} className={styles.tab} aria-current={active ? 'page' : undefined} aria-label={item.label}>
                  <Icon name={item.icon} size={20} />
                  <span aria-hidden="true">{item.short}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <CommandPalette open={paletteOpen} onClose={closePalette} commands={allCommands} />
    </div>
  );
}
