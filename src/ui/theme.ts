/**
 * Colour theme. "system" follows the device; "light" and "dark" force a theme
 * through `data-theme` on <html> (see tokens.css). The choice is a per-browser
 * convenience kept in localStorage; if storage is unavailable FINN simply
 * follows the system.
 */

export type Theme = 'system' | 'light' | 'dark';

export const THEMES: readonly { value: Theme; label: string; description: string }[] = [
  { value: 'system', label: 'System', description: 'Follow the device setting' },
  { value: 'light', label: 'Light', description: 'Always light' },
  { value: 'dark', label: 'Dark', description: 'Always dark' },
];

export const THEME_STORAGE_KEY = 'finn.theme';

/** Browser chrome colour per theme; mirrors the viewport themeColor in app/layout.tsx. */
const CHROME: Record<Exclude<Theme, 'system'>, string> = { light: '#f6f4ee', dark: '#121315' };

const isTheme = (v: unknown): v is Theme => v === 'system' || v === 'light' || v === 'dark';

export function readTheme(): Theme {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(v) ? v : 'system';
  } catch {
    // Storage blocked (private mode, site data off): follow the system.
    return 'system';
  }
}

export function saveTheme(theme: Theme): void {
  try {
    if (theme === 'system') window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage blocked: the theme still applies for this page view, it just isn't remembered.
    return;
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  // Keep the mobile browser chrome in step with a forced theme.
  const forced = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-finn-theme]');
  if (theme === 'system') {
    forced?.remove();
    return;
  }
  const meta = forced ?? document.createElement('meta');
  meta.name = 'theme-color';
  meta.setAttribute('data-finn-theme', '');
  meta.content = CHROME[theme];
  if (!forced) document.head.prepend(meta);
}

/**
 * Runs in <head> before the page paints, so a saved theme never flashes the
 * other one first. Static text, no user input.
 */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){/* storage unavailable: follow the system */}`;
