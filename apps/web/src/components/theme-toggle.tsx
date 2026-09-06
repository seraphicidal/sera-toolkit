'use client';

import { useEffect, useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon } from './icons';
import { cx } from '@/lib/format';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'sera-theme';

/**
 * Applies a preference to the document.
 *
 * `system` removes the attribute entirely rather than resolving it to a value, so the
 * page keeps following the OS if it changes while the tab is open.
 */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.themePreference = 'system';
  } else {
    root.dataset.theme = preference;
    root.dataset.themePreference = preference;
  }
}

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
];

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>('system');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as ThemePreference | null;
    const initial: ThemePreference =
      stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
    setPreference(initial);
    setReady(true);

    // Keep following the OS while `system` is selected.
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (document.documentElement.dataset.themePreference === 'system') applyTheme('system');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const choose = (value: ThemePreference): void => {
    setPreference(value);
    localStorage.setItem(STORAGE_KEY, value);
    applyTheme(value);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex items-center gap-0.5 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const selected = ready && preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={() => choose(value)}
            className={cx(
              'grid size-7 cursor-pointer place-items-center rounded-full transition-colors duration-150',
              selected
                ? 'bg-[var(--color-sunken)] text-[var(--color-ink)]'
                : 'text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]',
            )}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The inline script that sets the theme before first paint.
 *
 * Without it the page renders light, then corrects itself once React hydrates — a white
 * flash on every navigation for anyone using dark mode. It is deliberately tiny and runs
 * synchronously in `<head>`.
 */
export const themeScript = `
(function(){try{
  var s=localStorage.getItem('${STORAGE_KEY}');
  var p=(s==='light'||s==='dark')?s:'system';
  var d=p==='dark'||(p==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
  var r=document.documentElement;
  r.dataset.theme=d?'dark':'light';
  r.dataset.themePreference=p;
}catch(e){}})();
`.trim();
