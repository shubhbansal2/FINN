'use client';

import { useCallback, useEffect, useState } from 'react';

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
