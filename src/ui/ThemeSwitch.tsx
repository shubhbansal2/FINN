'use client';

import { useCallback, useEffect, useState } from 'react';

import { Icon } from './Icon';
import { PeriodSelector } from './PeriodSelector';
import { applyTheme, readTheme, saveTheme, THEME_STORAGE_KEY, THEMES, type Theme } from './theme';

/**
 * The saved theme and a setter that saves and applies it. Starts as "system" so
 * the server render and first client render agree; the saved choice (already
 * applied before paint by the boot script) is read after mount. Other tabs
 * follow a change through the storage event.
 */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>('system');

  useEffect(() => {
    const saved = readTheme();
    setThemeState(saved);
    applyTheme(saved);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return;
      const next = readTheme();
      setThemeState(next);
      applyTheme(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    saveTheme(next);
    applyTheme(next);
  }, []);

  return [theme, setTheme];
}

/** System / Light / Dark control. */
export function ThemeSwitch({ theme, onChange }: { theme: Theme; onChange: (theme: Theme) => void }) {
  return <PeriodSelector label="Theme" options={THEMES} value={theme} onChange={onChange} layout="stacked" />;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Whether the device prefers dark. False until mounted, so server and first client render agree. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const media = window.matchMedia?.(DARK_QUERY);
    if (!media) return;
    setDark(media.matches);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return dark;
}

/**
 * One-tap night mode for the phone masthead. It flips whatever is showing
 * (including a theme that came from the system) to the other one; "System"
 * stays available in the rail and the search menu.
 */
export function NightModeToggle({ theme, onChange, className }: { theme: Theme; onChange: (theme: Theme) => void; className?: string }) {
  const systemDark = useSystemDark();
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  return (
    <button type="button" className={className} aria-label="Night mode" aria-pressed={dark} onClick={() => onChange(dark ? 'light' : 'dark')}>
      <Icon name={dark ? 'sun' : 'moon'} />
    </button>
  );
}
