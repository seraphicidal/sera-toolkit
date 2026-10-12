'use client';

import { useEffect, useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon } from './icons';
import { cx } from '@/lib/format';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'sera-theme';

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

const OPTIONS: readonly {
  readonly value: ThemePreference;
  readonly label: string;
  readonly Icon: typeof SunIcon;
}[] = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
];

function readStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function writeStoredTheme(value: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {}
}

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>('system');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setPreference(readStoredTheme());
    setReady(true);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (document.documentElement.dataset.themePreference === 'system') applyTheme('system');
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const choose = (value: ThemePreference): void => {
    setPreference(value);
    writeStoredTheme(value);
    applyTheme(value);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="inline-flex items-center gap-0.5 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }, index) => {
        const selected = ready && preference === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            aria-label={label}
            title={label}
            onClick={() => choose(value)}
            onKeyDown={(event) => {
              let offset = 0;
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') offset = 1;
              else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') offset = -1;
              if (!offset) return;
              event.preventDefault();
              const nextIndex = (index + offset + OPTIONS.length) % OPTIONS.length;
              const nextOption = OPTIONS[nextIndex];
              if (!nextOption) return;
              choose(nextOption.value);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                [nextIndex]?.focus();
            }}
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
