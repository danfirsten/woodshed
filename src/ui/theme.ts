/**
 * Theme mode store — light / dark / follow-the-system.
 *
 * The resolved theme is stamped on <html data-theme="..."> so theme.css can key
 * off it, and the user's choice is persisted in localStorage under
 * 'woodshed.theme'. Uses a tiny external store so every consumer stays in sync
 * without a provider.
 */
import { useSyncExternalStore } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'woodshed.theme'

function readStored(): ThemeMode {
  if (typeof localStorage === 'undefined') return 'system'
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
}

function systemPrefersDark(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
}

let mode: ThemeMode = readStored()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getMode(): ThemeMode {
  return mode
}

export function resolveTheme(m: ThemeMode): ResolvedTheme {
  if (m === 'system') return systemPrefersDark() ? 'dark' : 'light'
  return m
}

/** Write the resolved theme onto <html> (and keep native widgets in step). */
export function applyTheme(): void {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(mode)
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
}

export function setThemeMode(next: ThemeMode): void {
  mode = next
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      /* private mode — the choice just won't stick */
    }
  }
  applyTheme()
  emit()
}

/** Cycle order matches the toggle's icon order: system → light → dark → system. */
export const THEME_ORDER: ThemeMode[] = ['system', 'light', 'dark']

export function cycleThemeMode(): void {
  const i = THEME_ORDER.indexOf(mode)
  setThemeMode(THEME_ORDER[(i + 1) % THEME_ORDER.length])
}

// Follow the OS while in 'system' mode.
if (typeof matchMedia !== 'undefined') {
  const mql = matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    if (mode === 'system') {
      applyTheme()
      emit()
    }
  }
  if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange)
}

applyTheme()

export function useThemeMode(): {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (next: ThemeMode) => void
  cycle: () => void
} {
  const current = useSyncExternalStore(subscribe, getMode, getMode)
  return {
    mode: current,
    resolved: resolveTheme(current),
    setMode: setThemeMode,
    cycle: cycleThemeMode,
  }
}
