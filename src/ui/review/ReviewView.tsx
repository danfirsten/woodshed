import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../state/store'
import { formatTime } from '../../types'
import { exportAudio, exportPdf, exportZip, goToLibrary, goToRecord, renameSession } from '../../app/controller'
import { runAction } from '../actions'
import { Button } from '../components/Button'
import { EditableText } from '../components/EditableText'
import { DownloadIcon, LibraryIcon, MicIcon, NoteIcon } from '../components/Icons'
import { AudioPlayerContext } from './audioPlayer'
import type { AudioPlayerApi } from './audioPlayer'
import { SegmentCard } from './SegmentCard'
import './ReviewView.css'

type ExportKind = 'pdf' | 'audio' | 'zip'

function ExportRow() {
  const [busy, setBusy] = useState<ExportKind | null>(null)

  const run = async (kind: ExportKind, fn: () => Promise<void>, fallback: string) => {
    if (busy) return
    setBusy(kind)
    try {
      await fn()
    } catch (err) {
      useAppStore.getState().update({
        error: err instanceof Error && err.message ? `${fallback}: ${err.message}` : fallback,
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="exports" aria-label="Export this session">
      <Button
        variant="primary"
        icon={<DownloadIcon size={16} />}
        busy={busy === 'pdf'}
        onClick={() => void run('pdf', exportPdf, "Couldn't build the PDF")}
      >
        PDF
      </Button>
      <Button
        icon={<DownloadIcon size={16} />}
        busy={busy === 'audio'}
        onClick={() => void run('audio', exportAudio, "Couldn't save the audio")}
      >
        Audio
      </Button>
      <Button
        icon={<DownloadIcon size={16} />}
        busy={busy === 'zip'}
        onClick={() => void run('zip', exportZip, "Couldn't build the ZIP")}
      >
        ZIP
      </Button>
    </div>
  )
}

function EmptyReview() {
  return (
    <div className="page">
      <div className="emptystate card">
        <NoteIcon size={30} className="emptystate__icon" />
        <h1 className="emptystate__title">No jam open</h1>
        <p className="emptystate__body muted">
          Record something new, or pick a session from your library.
        </p>
        <div className="emptystate__actions">
          <Button variant="primary" icon={<MicIcon size={16} />} onClick={goToRecord}>
            Record a jam
          </Button>
          <Button icon={<LibraryIcon size={16} />} onClick={goToLibrary}>
            Open library
          </Button>
        </div>
      </div>
    </div>
  )
}

export function ReviewView() {
  const session = useAppStore((s) => s.session)
  const audioBlob = useAppStore((s) => s.audioBlob)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!audioBlob) {
      setAudioUrl(null)
      return
    }
    const url = URL.createObjectURL(audioBlob)
    setAudioUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [audioBlob])

  const seekTo = useCallback((sec: number, play = false) => {
    const el = audioRef.current
    if (!el) return
    try {
      el.currentTime = Math.max(0, sec)
    } catch {
      /* metadata not loaded yet — ignore */
    }
    if (play) void el.play().catch(() => {})
  }, [])

  const playerApi = useMemo<AudioPlayerApi>(
    () => ({ seekTo, ready: audioUrl != null }),
    [seekTo, audioUrl],
  )

  if (!session) return <EmptyReview />

  const started = new Date(session.startedAt)
  const segmentCount = session.segments.length

  return (
    <AudioPlayerContext.Provider value={playerApi}>
      <div className="page review">
        <header className="review__head">
          <p className="eyebrow">Lead sheet</p>
          <h1 className="review__title">
            <EditableText
              value={session.title}
              label="Rename session"
              onCommit={(next) => void runAction(() => renameSession(next), "Couldn't rename the session")}
            />
          </h1>
          <p className="review__sub muted">
            <span>{started.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
            <span className="review__dot" aria-hidden="true">
              ·
            </span>
            <span className="tabular">{formatTime(session.durationSec)}</span>
            <span className="review__dot" aria-hidden="true">
              ·
            </span>
            <span>
              {segmentCount} {segmentCount === 1 ? 'idea' : 'ideas'}
            </span>
          </p>
        </header>

        <div className="playerbar">
          <div className="playerbar__inner">
            {audioUrl ? (
              <audio
                ref={audioRef}
                className="playerbar__audio"
                src={audioUrl}
                controls
                preload="metadata"
                aria-label={`Recording of ${session.title}`}
              />
            ) : (
              <p className="playerbar__missing muted">Audio for this session isn’t loaded.</p>
            )}
            <ExportRow />
          </div>
        </div>

        {segmentCount === 0 ? (
          <div className="emptystate card">
            <NoteIcon size={28} className="emptystate__icon" />
            <h2 className="emptystate__title">Nothing came through</h2>
            <p className="emptystate__body muted">
              Woodshed didn’t find any playing in this take. Try again a little closer to the mic.
            </p>
            <div className="emptystate__actions">
              <Button variant="primary" icon={<MicIcon size={16} />} onClick={goToRecord}>
                Record again
              </Button>
            </div>
          </div>
        ) : (
          <section className="review__segments" aria-label="Ideas in this jam">
            {session.segments.map((segment) => (
              <SegmentCard key={segment.id} segment={segment} />
            ))}
          </section>
        )}
      </div>
    </AudioPlayerContext.Provider>
  )
}
