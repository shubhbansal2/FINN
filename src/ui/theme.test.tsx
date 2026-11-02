import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyTheme, readTheme, THEME_BOOT_SCRIPT, THEME_STORAGE_KEY } from './theme';
import { ThemeSwitch, useTheme } from './ThemeSwitch';

function Harness() {
  const [theme, setTheme] = useTheme();
  return <ThemeSwitch theme={theme} onChange={setTheme} />;
}

const root = () => document.documentElement;
const forcedChrome = () => document.head.querySelector('meta[name="theme-color"][data-finn-theme]');

afterEach(() => {
  window.localStorage.clear();
  applyTheme('system');
  vi.restoreAllMocks();
});

describe('theme switch', () => {
  it('forces light or dark, remembers it, and returns to the system setting', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: /^Dark/ }));
    expect(root().getAttribute('data-theme')).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(forcedChrome()?.getAttribute('content')).toBe('#121315');

    fireEvent.click(screen.getByRole('radio', { name: /^Light/ }));
    expect(root().getAttribute('data-theme')).toBe('light');
    expect(forcedChrome()?.getAttribute('content')).toBe('#f6f4ee');

    fireEvent.click(screen.getByRole('radio', { name: /^System/ }));
    expect(root().hasAttribute('data-theme')).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(forcedChrome()).toBeNull();
  });

  it('shows the saved choice after mount', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(<Harness />);
    expect(screen.getByRole('radio', { name: /^Dark/ })).toHaveAttribute('aria-checked', 'true');
    expect(root().getAttribute('data-theme')).toBe('dark');
  });
});

describe('saved theme', () => {
  it('ignores unknown values and blocked storage, falling back to the system setting', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(readTheme()).toBe('system');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readTheme()).toBe('system');
  });

  it('is applied by the boot script before React runs, and junk is ignored', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    new Function(THEME_BOOT_SCRIPT)();
    expect(root().getAttribute('data-theme')).toBe('light');

    applyTheme('system');
    window.localStorage.setItem(THEME_STORAGE_KEY, '"><script>');
    new Function(THEME_BOOT_SCRIPT)();
    expect(root().hasAttribute('data-theme')).toBe(false);
  });
});
