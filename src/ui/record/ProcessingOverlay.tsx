import { useAppStore } from '../../state/store'

/** Full-bleed scrim + card shown while the refinement pass runs. */
export function ProcessingOverlay() {
  const message = useAppStore((s) => s.processingMessage)
  const progress = useAppStore((s) => s.processingProgress)
  const indeterminate = !(progress >= 0)
  const pct = indeterminate ? 0 : Math.round(Math.min(1, progress) * 100)

  return (
    <div className="processing" role="dialog" aria-modal="true" aria-label="Working on your jam">
      <div className="processing__card card">
        <div className="processing__strings" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        <h2 className="processing__title">Writing it down…</h2>
        <p className="processing__message" role="status" aria-live="polite">
          {message || 'Listening back to your jam.'}
        </p>

        <div
          className={`progress${indeterminate ? ' progress--indeterminate' : ''}`}
          role="progressbar"
          aria-label="Processing progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : pct}
          aria-valuetext={indeterminate ? 'Working…' : `${pct}%`}
        >
          <div className="progress__fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
        </div>

        <p className="processing__pct tabular muted">
          {indeterminate ? 'This can take a moment on the first run.' : `${pct}%`}
        </p>
      </div>
    </div>
  )
}
