/**
 * Shared data model for Woodshed — the whole app codes against these types.
 * Times are always absolute seconds from the start of the session recording
 * unless a name says otherwise.
 */

/** A full recorded jam session. */
export interface JamSession {
  id: string
  title: string
  /** Epoch ms when recording started. */
  startedAt: number
  durationSec: number
  /** Sample rate of the analysis PCM (always 16000 in practice). */
  sampleRate: number
  /** MIME type of the stored audio blob (e.g. audio/webm;codecs=opus). */
  audioMimeType: string
  segments: JamSegment[]
}

/**
 * One musical "idea" within a jam — a contiguous stretch of playing
 * bounded by silence/pauses. Jams are loose, so a segment is the unit
 * of transcription, not a song or a fixed measure count.
 */
export interface JamSegment {
  id: string
  /** 0-based position within the session. */
  index: number
  startSec: number
  endSec: number
  /** Optional user-editable name ("that dreamy riff"). */
  label?: string
  keyGuess?: KeyGuess
  /** Detected tempo, if confident enough to be useful. */
  tempoBpm?: number
  chords: ChordEvent[]
  notes: NoteEvent[]
  lyrics: LyricWord[]
}

export interface ChordEvent {
  startSec: number
  endSec: number
  /** Chord symbol, e.g. "Am", "G", "Cmaj7", "N.C." for no chord. */
  symbol: string
  /** 0..1 */
  confidence: number
}

export interface NoteEvent {
  startSec: number
  endSec: number
  /** MIDI note number (A4 = 69). */
  midi: number
  /** 0..1 */
  confidence: number
}

export interface LyricWord {
  startSec: number
  endSec: number
  text: string
  /** 0..1 when the engine provides it. */
  confidence?: number
}

export interface KeyGuess {
  /** Pitch class name, e.g. "C", "F#", "Bb". */
  tonic: string
  mode: 'major' | 'minor'
  /** 0..1 */
  confidence: number
}

/** A chunk of mono PCM streamed from the audio engine during recording. */
export interface AudioFrame {
  samples: Float32Array
  sampleRate: number
  /** Time of the FIRST sample in this frame, seconds from session start. */
  timeSec: number
}

/** What the audio engine hands back when recording stops. */
export interface RecordingResult {
  /** Compressed full-quality recording (MediaRecorder output). */
  blob: Blob
  mimeType: string
  durationSec: number
  /** Full session downmixed + resampled to 16 kHz mono, for analysis & lyrics. */
  pcm16k: Float32Array
}

/** Result of the post-session refinement analysis pass. */
export interface SessionAnalysis {
  segments: JamSegment[]
}

/** Progress reporting for long-running work (model download, analysis, export). */
export interface ModelProgress {
  /** Human-readable, e.g. "Downloading speech model (12 MB / 40 MB)". */
  status: string
  /** 0..1, or -1 when indeterminate. */
  progress: number
}

/** Lightweight listing entry for the session library. */
export interface SessionSummary {
  id: string
  title: string
  startedAt: number
  durationSec: number
  segmentCount: number
}

/** Analysis PCM sample rate used everywhere downstream of the mic. */
export const ANALYSIS_SAMPLE_RATE = 16000

/** Default session title from a start timestamp, e.g. "Jam — Jul 29, 3:14 PM". */
export function defaultSessionTitle(startedAt: number): string {
  const d = new Date(startedAt)
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `Jam — ${date}, ${time}`
}

/** Format seconds as m:ss or h:mm:ss for timestamps in the UI and PDF. */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}

/** MIDI note number to name, e.g. 69 -> "A4". */
export function midiToName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}
