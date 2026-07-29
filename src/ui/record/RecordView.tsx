import { useState } from 'react'
import { useAppStore } from '../../state/store'
import type { LyricsModelStatus } from '../../state/store'
import { startRecording, stopRecording } from '../../app/controller'
import { formatTime } from '../../types'
import { runAction } from '../actions'
import { MicIcon, StopIcon } from '../components/Icons'
import { LevelMeter } from './LevelMeter'
import { WaveformCanvas } from './WaveformCanvas'
import { ChordTicker } from './ChordTicker'
import { ProcessingOverlay } from './ProcessingOverlay'
import './RecordView.css'

/* -------------------------------------------------------------------------- */

function LyricsToggle() {
  const enabled = useAppStore((s) => s.lyricsEnabled)
  const update = useAppStore((s) => s.update)

  return (
    <button
      type="button"
      className="switch"
      aria-pressed={enabled}
      onClick={() => update({ lyricsEnabled: !enabled })}
    >
      <span className="switch__track" aria-hidden="true">
        <span className="switch__thumb" />
      </span>
      <span className="switch__label">Transcribe lyrics</span>
    </button>
  )
}

const MODEL_COPY: Record<LyricsModelStatus, { text: string; tone: string }> = {
  idle: { text: 'Lyrics model loads on first use', tone: 'muted' },
  loading: { text: 'Loading lyrics model…', tone: 'busy' },
  ready: { text: 'Lyrics model ready', tone: 'ready' },
  error: { text: "Lyrics model didn't load", tone: 'error' },
  unavailable: { text: 'Lyrics unavailable in this browser', tone: 'error' },
}

function ModelStatusPill() {
  const status = useAppStore((s) => s.lyricsModelStatus)
  const enabled = useAppStore((s) => s.lyricsEnabled)

  if (!enabled) {
    return (
      <span className="statuspill statuspill--muted">
        <span className="statuspill__dot" aria-hidden="true" />
        Lyrics off — chords only
      </span>
    )
  }

  const { text, tone } = MODEL_COPY[status]
  return (
    <span className={`statuspill statuspill--${tone}`}>
      {tone === 'busy' ? (
        <span className="spinner statuspill__spinner" aria-hidden="true" />
      ) : (
        <span className="statuspill__dot" aria-hidden="true" />
      )}
      {text}
    </span>
  )
}

/* -------------------------------------------------------------------------- */

function RecordButton({
  status,
}: {
  status: 'idle' | 'initializing' | 'recording' | 'processing'
}) {
  const [busy, setBusy] = useState(false)
  const recording = status === 'recording'
  const disabled = busy || status === 'initializing' || status === 'processing'

  async function toggle() {
    setBusy(true)
    if (recording) await runAction(stopRecording, "Couldn't finish the recording")
    else await runAction(startRecording, "Couldn't start recording")
    setBusy(false)
  }

  return (
    <div className="recorder">
      <button
        type="button"
        className={`recbtn${recording ? ' recbtn--live' : ''}`}
        onClick={toggle}
        disabled={disabled}
        aria-label={recording ? 'Stop recording' : 'Start recording'}
      >
        <span className="recbtn__halo" aria-hidden="true" />
        <span className="recbtn__face">
          {recording ? <StopIcon size={38} /> : <MicIcon size={40} strokeWidth={1.6} />}
        </span>
      </button>
      <span className="recorder__hint">
        {status === 'initializing'
          ? 'Waking the mic…'
          : recording
            ? 'Tap to finish'
            : 'Tap to start'}
      </span>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function IdlePanel() {
  const status = useAppStore((s) => s.recordingStatus)

  return (
    <div className="idle">
      <p className="eyebrow idle__eyebrow">The practice room</p>
      <h2 className="idle__pitch">Just play. Woodshed writes it down.</h2>

      <RecordButton status={status} />

      <div className="idle__settings card">
        <LyricsToggle />
        <ModelStatusPill />
      </div>

      <ol className="idle__steps">
        <li>
          <span className="idle__stepnum">1</span> Hit record and jam — playing, singing, stopping
          to think.
        </li>
        <li>
          <span className="idle__stepnum">2</span> Chords appear live as Woodshed hears them.
        </li>
        <li>
          <span className="idle__stepnum">3</span> Stop, and get a lead sheet for every idea.
        </li>
      </ol>
    </div>
  )
}

function LivePanel({ frozen }: { frozen: boolean }) {
  const elapsedSec = useAppStore((s) => s.elapsedSec)
  const status = useAppStore((s) => s.recordingStatus)

  return (
    <div className="live">
      <div className="live__head">
        <span className={`livebadge${frozen ? ' livebadge--done' : ''}`}>
          <span className="livebadge__dot" aria-hidden="true" />
          {frozen ? 'Wrapping up' : 'Recording'}
        </span>
        <p className="live__timer tabular" aria-live="off">
          {formatTime(elapsedSec)}
        </p>
        <p className="live__sub muted">
          {frozen ? 'Hold tight — sorting your ideas.' : 'Take your time. Pauses become new ideas.'}
        </p>
      </div>

      <div className="waveform card">
        <WaveformCanvas active={!frozen} />
        <LevelMeter active={!frozen} />
      </div>

      <ChordTicker />

      <RecordButton status={status} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */

export function RecordView() {
  const status = useAppStore((s) => s.recordingStatus)
  const live = status === 'recording' || status === 'processing'

  return (
    <div className="page recordview">
      <h1 className="visually-hidden">Record a jam</h1>
      {live ? <LivePanel frozen={status === 'processing'} /> : <IdlePanel />}
      {status === 'processing' && <ProcessingOverlay />}
    </div>
  )
}
