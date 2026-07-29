import { useId, useMemo, useState } from 'react'
import type { JamSegment } from '../../types'
import { formatTime } from '../../types'
import { renameSegment } from '../../app/controller'
import { runAction } from '../actions'
import { Badge } from '../components/Badge'
import { EditableText } from '../components/EditableText'
import { ChevronIcon, PlayIcon } from '../components/Icons'
import { useAudioPlayer } from './audioPlayer'
import { LeadSheet } from '../../notation/LeadSheet'

function lyricsToText(segment: JamSegment): string {
  return segment.lyrics
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;:!?'’”)\]])/g, '$1')
    .trim()
}

export function SegmentCard({ segment }: { segment: JamSegment }) {
  const { seekTo, ready } = useAudioPlayer()
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const lyricsId = useId()

  const fallbackName = `Idea ${segment.index + 1}`
  const lyrics = useMemo(() => lyricsToText(segment), [segment])
  const chordCount = segment.chords.length

  return (
    <article className="segment card" aria-labelledby={`${segment.id}-title`}>
      <header className="segment__head">
        <div className="segment__title">
          <span className="segment__num" aria-hidden="true">
            {segment.index + 1}
          </span>
          <h3 id={`${segment.id}-title`} className="segment__name">
            <EditableText
              value={segment.label ?? fallbackName}
              label="Rename this idea"
              placeholder={fallbackName}
              onCommit={(next) =>
                void runAction(() => renameSegment(segment.id, next), "Couldn't rename the idea")
              }
            />
          </h3>
        </div>

        <div className="segment__meta">
          <button
            type="button"
            className="timechip"
            onClick={() => seekTo(segment.startSec, true)}
            disabled={!ready}
            aria-label={`Play from ${formatTime(segment.startSec)}`}
            title={ready ? 'Play this idea' : 'Audio unavailable'}
          >
            <PlayIcon size={13} className="timechip__icon" />
            <span className="tabular">
              {formatTime(segment.startSec)} – {formatTime(segment.endSec)}
            </span>
          </button>

          {segment.keyGuess && (
            <Badge tone="accent">
              {segment.keyGuess.tonic} {segment.keyGuess.mode}
            </Badge>
          )}
          {segment.tempoBpm != null && (
            <Badge>
              <span className="tabular">{Math.round(segment.tempoBpm)}</span> BPM
            </Badge>
          )}
          {chordCount > 0 && (
            <Badge tone="muted">
              <span className="tabular">{chordCount}</span> chords
            </Badge>
          )}
        </div>
      </header>

      <div className="segment__sheet">
        <LeadSheet segment={segment} />
      </div>

      {lyrics.length > 0 && (
        <div className="lyrics">
          <button
            type="button"
            className="lyrics__toggle"
            aria-expanded={lyricsOpen}
            aria-controls={lyricsId}
            onClick={() => setLyricsOpen((v) => !v)}
          >
            <ChevronIcon className={`lyrics__chevron${lyricsOpen ? ' lyrics__chevron--open' : ''}`} />
            <span>{lyricsOpen ? 'Hide lyrics' : 'Show lyrics'}</span>
            <span className="lyrics__count tabular">{segment.lyrics.length} words</span>
          </button>
          {lyricsOpen && (
            <div className="lyrics__body" id={lyricsId}>
              <p>{lyrics}</p>
            </div>
          )}
        </div>
      )}
    </article>
  )
}
