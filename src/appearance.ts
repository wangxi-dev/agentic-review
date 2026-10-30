export type ThemePreference = 'light' | 'dark' | 'system';
export type TextSize = 'standard' | 'large' | 'extra-large';
export interface Appearance { theme: ThemePreference; textSize: TextSize }

const STORAGE_KEY = 'agentic-review.appearance.v1';
const defaults: Appearance = { theme: 'light', textSize: 'standard' };

export function parseAppearance(value: string | null): Appearance {
  try {
    const parsed = JSON.parse(value ?? 'null');
    return {
      theme: ['light', 'dark', 'system'].includes(parsed?.theme) ? parsed.theme : defaults.theme,
      textSize: ['standard', 'large', 'extra-large'].includes(parsed?.textSize) ? parsed.textSize : defaults.textSize,
    };
  } catch {
    return { ...defaults };
  }
}

export function resolvedTheme(preference: ThemePreference, systemDark: boolean): 'light' | 'dark' {
  return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
}

// Applied independently of the heavy renderer entry point. Preferences belong to
// the app's WebView storage, never to a repository or its exported comments.
export function initializeAppearance(): () => void {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = { ...defaults };
  try { preference = parseAppearance(localStorage.getItem(STORAGE_KEY)); } catch { /* Storage can be unavailable. */ }

  const apply = () => {
    document.documentElement.dataset.theme = resolvedTheme(preference.theme, system.matches);
    document.documentElement.dataset.textSize = preference.textSize;
  };
  apply();
  system.addEventListener('change', apply);

  return () => {
    const theme = document.getElementById('theme-select') as HTMLSelectElement;
    const textSize = document.getElementById('text-size') as HTMLSelectElement;
    const status = document.getElementById('appearance-status')!;
    theme.value = preference.theme;
    textSize.value = preference.textSize;
    const change = () => {
      preference = parseAppearance(JSON.stringify({ theme: theme.value, textSize: textSize.value }));
      apply(); // CSS only: retain selection, scroll position, comment drafts, and file contents.
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
        status.textContent = 'Appearance saved.';
      } catch {
        status.textContent = 'Appearance changed for this session; preferences could not be saved.';
      }
    };
    theme.addEventListener('change', change);
    textSize.addEventListener('change', change);
  };
}

// Keep the parsing helpers usable in non-browser unit tests.
export const connectAppearanceControls = typeof window === 'undefined' ? () => {} : initializeAppearance();
