import { useThemeMode } from '../theme'
import { AutoThemeIcon, MoonIcon, SunIcon } from './Icons'

const LABEL = {
  system: 'Theme: match system. Switch to light.',
  light: 'Theme: light. Switch to dark.',
  dark: 'Theme: dark. Match system.',
} as const

export function ThemeToggle() {
  const { mode, cycle } = useThemeMode()

  return (
    <button
      type="button"
      className="btn btn--ghost btn--icon themetoggle"
      onClick={cycle}
      aria-label={LABEL[mode]}
      title={LABEL[mode]}
    >
      <span className="themetoggle__icon" key={mode}>
        {mode === 'system' ? <AutoThemeIcon /> : mode === 'light' ? <SunIcon /> : <MoonIcon />}
      </span>
    </button>
  )
}
