import { create } from 'zustand'
import type { ChordEvent, JamSession, SessionSummary } from '../types'

export type AppView = 'record' | 'review' | 'library'
export type RecordingStatus = 'idle' | 'initializing' | 'recording' | 'processing'
export type LyricsModelStatus = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'

export interface AppState {
  view: AppView
  recordingStatus: RecordingStatus
  /** Seconds since recording started (updated ~4x/sec while recording). */
  elapsedSec: number
  /** Mic input RMS level 0..1 (updated continuously while recording). */
  inputLevel: number
  /** Chords detected so far in the live pass, oldest first. */
  liveChords: ChordEvent[]
  /** What the app is doing during processing/loading, for the UI. */
  processingMessage: string
  /** 0..1, or -1 for indeterminate. */
  processingProgress: number
  /** The session currently open in the review view. */
  session: JamSession | null
  /** Audio blob for the open session (for playback + export). */
  audioBlob: Blob | null
  /** Saved sessions for the library view, newest first. */
  sessions: SessionSummary[]
  lyricsModelStatus: LyricsModelStatus
  /** User toggle: transcribe lyrics at all. Persisted in localStorage. */
  lyricsEnabled: boolean
  error: string | null

  update: (patch: Partial<Omit<AppState, 'update'>>) => void
}

const LYRICS_PREF_KEY = 'woodshed.lyricsEnabled'

export const useAppStore = create<AppState>((set) => ({
  view: 'record',
  recordingStatus: 'idle',
  elapsedSec: 0,
  inputLevel: 0,
  liveChords: [],
  processingMessage: '',
  processingProgress: -1,
  session: null,
  audioBlob: null,
  sessions: [],
  lyricsModelStatus: 'idle',
  lyricsEnabled:
    typeof localStorage === 'undefined' ? true : localStorage.getItem(LYRICS_PREF_KEY) !== 'off',
  error: null,

  update: (patch) => {
    if (patch.lyricsEnabled !== undefined && typeof localStorage !== 'undefined') {
      localStorage.setItem(LYRICS_PREF_KEY, patch.lyricsEnabled ? 'on' : 'off')
    }
    set(patch)
  },
}))
