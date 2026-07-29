import { useAppStore } from '../../state/store'
import { CloseIcon, WarningIcon } from './Icons'

export function ErrorBanner() {
  const error = useAppStore((s) => s.error)
  const update = useAppStore((s) => s.update)
  if (!error) return null

  return (
    <div className="errorbanner" role="alert">
      <div className="errorbanner__inner">
        <WarningIcon className="errorbanner__icon" />
        <p className="errorbanner__text">{error}</p>
        <button
          type="button"
          className="btn btn--ghost btn--icon errorbanner__close"
          aria-label="Dismiss error"
          onClick={() => update({ error: null })}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}
