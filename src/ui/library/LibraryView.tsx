import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import type { SessionSummary } from '../../types'
import { formatTime } from '../../types'
import { deleteSession, goToRecord, openSession, refreshLibrary } from '../../app/controller'
import { runAction } from '../actions'
import { Button } from '../components/Button'
import { LibraryIcon, MicIcon, TrashIcon } from '../components/Icons'
import './LibraryView.css'

function JamCard({
  summary,
  confirming,
  onConfirmChange,
}: {
  summary: SessionSummary
  confirming: boolean
  onConfirmChange: (id: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const started = new Date(summary.startedAt)

  async function remove() {
    setBusy(true)
    await runAction(() => deleteSession(summary.id), "Couldn't delete that jam")
    setBusy(false)
    onConfirmChange(null)
  }

  return (
    <li className="jamcard card card--lift">
      <button
        type="button"
        className="jamcard__open"
        onClick={() => void runAction(() => openSession(summary.id), "Couldn't open that jam")}
      >
        <span className="jamcard__title">{summary.title}</span>
        <span className="jamcard__meta">
          <span>{started.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
        </span>
        <span className="jamcard__stats">
          <span className="badge">
            <span className="tabular">{formatTime(summary.durationSec)}</span>
          </span>
          <span className="badge badge--muted">
            <span className="tabular">{summary.segmentCount}</span>{' '}
            {summary.segmentCount === 1 ? 'idea' : 'ideas'}
          </span>
        </span>
      </button>

      <div className="jamcard__actions">
        {confirming ? (
          <div className="confirm" role="group" aria-label={`Delete ${summary.title}?`}>
            <span className="confirm__label">Delete?</span>
            <Button size="sm" variant="danger" busy={busy} onClick={() => void remove()}>
              Yes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onConfirmChange(null)}>
              No
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn--ghost btn--icon jamcard__trash"
            aria-label={`Delete ${summary.title}`}
            title="Delete"
            onClick={() => onConfirmChange(summary.id)}
          >
            <TrashIcon size={17} />
          </button>
        )}
      </div>
    </li>
  )
}

export function LibraryView() {
  const sessions = useAppStore((s) => s.sessions)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const refreshed = useRef(false)

  useEffect(() => {
    if (refreshed.current) return
    refreshed.current = true
    // goToLibrary already kicks this off; this covers a direct landing on the view.
    void Promise.resolve(refreshLibrary()).catch(() => {})
  }, [])

  return (
    <div className="page library">
      <header className="library__head">
        <p className="eyebrow">Saved jams</p>
        <h1 className="library__title">Your library</h1>
        <p className="library__sub muted">
          {sessions.length === 0
            ? 'Everything you record stays on this device.'
            : `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}, newest first.`}
        </p>
      </header>

      {sessions.length === 0 ? (
        <div className="emptystate card">
          <LibraryIcon size={30} className="emptystate__icon" />
          <h2 className="emptystate__title">Your saved jams will live here</h2>
          <p className="emptystate__body muted">
            Record a session and Woodshed keeps the audio, the chords and the lyrics together.
          </p>
          <div className="emptystate__actions">
            <Button variant="primary" icon={<MicIcon size={16} />} onClick={goToRecord}>
              Record your first jam
            </Button>
          </div>
        </div>
      ) : (
        <ul className="library__grid">
          {sessions.map((summary) => (
            <JamCard
              key={summary.id}
              summary={summary}
              confirming={confirmId === summary.id}
              onConfirmChange={setConfirmId}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
