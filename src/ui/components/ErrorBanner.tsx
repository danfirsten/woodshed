import { useAppStore } from '../../state/store'
import { IconButton } from './Button'
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
        <IconButton
          label="Dismiss error"
          className="errorbanner__close"
          onClick={() => update({ error: null })}
        >
          <CloseIcon />
        </IconButton>
      </div>
    </div>
  )
}
