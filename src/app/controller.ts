/**
 * App controller — the orchestration layer between the UI and the
 * audio/analysis/lyrics/export/storage modules. The UI only ever calls
 * these functions; it never touches the engines directly.
 */
import { AudioEngine } from '../audio/engine'
import { LiveAnalyzer } from '../analysis/live'
import { analyzeSession } from '../analysis'
import { isLyricsSupported, preloadLyricsModel, transcribeLyrics } from '../lyrics/engine'
import { exportSessionPdf } from '../export/pdf'
import { exportSessionZip } from '../export/zip'
import { audioFilename, downloadBlob, safeFilename } from '../export/download'
import {
  deleteSessionById,
  listSessions,
  loadSession,
  saveSession,
} from '../storage/db'
import { useAppStore } from '../state/store'
import {
  defaultSessionTitle,
  newId,
  type JamSegment,
  type JamSession,
  type LyricWord,
} from '../types'

let engine: AudioEngine | null = null
let liveAnalyzer: LiveAnalyzer | null = null
let elapsedTimer: ReturnType<typeof setInterval> | null = null
let lyricsWarmupStarted = false

function store() {
  return useAppStore.getState()
}

function fail(err: unknown, fallback: string): never {
  const message = err instanceof Error ? err.message : fallback
  store().update({ error: message })
  throw err instanceof Error ? err : new Error(message)
}

/** Warm the Whisper model in the background so it's ready by the time a jam ends. */
function warmLyricsModel(): void {
  const s = store()
  if (!s.lyricsEnabled || lyricsWarmupStarted) return
  if (!isLyricsSupported()) {
    s.update({ lyricsModelStatus: 'unavailable' })
    return
  }
  lyricsWarmupStarted = true
  s.update({ lyricsModelStatus: 'loading' })
  preloadLyricsModel()
    .then(() => store().update({ lyricsModelStatus: 'ready' }))
    .catch(() => {
      lyricsWarmupStarted = false
      store().update({ lyricsModelStatus: 'error' })
    })
}

/** Request mic access and start a new recording session. */
export async function startRecording(): Promise<void> {
  const s = store()
  if (s.recordingStatus !== 'idle') return
  s.update({
    recordingStatus: 'initializing',
    error: null,
    liveChords: [],
    elapsedSec: 0,
    inputLevel: 0,
  })
  try {
    liveAnalyzer = new LiveAnalyzer((chord) => {
      const cur = store()
      cur.update({ liveChords: [...cur.liveChords, chord] })
    })
    engine = new AudioEngine({
      onFrame: (frame) => liveAnalyzer?.pushFrame(frame),
      onLevel: (rms) => store().update({ inputLevel: rms }),
    })
    await engine.start()
    warmLyricsModel()
    elapsedTimer = setInterval(() => {
      const startedAt = engine?.startedAtMs ?? Date.now()
      store().update({ elapsedSec: (Date.now() - startedAt) / 1000 })
    }, 250)
    store().update({ recordingStatus: 'recording' })
  } catch (err) {
    engine = null
    liveAnalyzer = null
    store().update({ recordingStatus: 'idle' })
    fail(err, 'Could not start recording.')
  }
}

/** Overlay lyric words onto segments by time overlap (nearest segment wins strays). */
function assignLyrics(segments: JamSegment[], words: LyricWord[]): void {
  if (segments.length === 0) return
  for (const word of words) {
    const mid = (word.startSec + word.endSec) / 2
    let target = segments.find((seg) => mid >= seg.startSec && mid <= seg.endSec)
    if (!target) {
      target = segments.reduce((best, seg) => {
        const d = Math.min(Math.abs(mid - seg.startSec), Math.abs(mid - seg.endSec))
        const bd = Math.min(Math.abs(mid - best.startSec), Math.abs(mid - best.endSec))
        return d < bd ? seg : best
      })
      // Ignore words stranded far from any playing (>5s away) — likely noise.
      const dist = Math.min(Math.abs(mid - target.startSec), Math.abs(mid - target.endSec))
      if (dist > 5) continue
    }
    target.lyrics.push(word)
  }
  for (const seg of segments) {
    seg.lyrics.sort((a, b) => a.startSec - b.startSec)
  }
}

/** Stop recording, run the refinement pass (analysis + lyrics), save, and open review. */
export async function stopRecording(): Promise<void> {
  const s = store()
  if (s.recordingStatus !== 'recording' || !engine) return
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
  s.update({
    recordingStatus: 'processing',
    processingMessage: 'Finishing the recording…',
    processingProgress: -1,
    inputLevel: 0,
  })
  try {
    const result = await engine.stop()
    const startedAt = engine.startedAtMs
    engine = null
    liveAnalyzer?.reset()
    liveAnalyzer = null

    store().update({ processingMessage: 'Listening back for chords, keys, and melodies…' })
    const analysis = await analyzeSession(result.pcm16k, (p) =>
      store().update({ processingMessage: p.status, processingProgress: p.progress }),
    )

    const cur = store()
    if (cur.lyricsEnabled && isLyricsSupported() && analysis.segments.length > 0) {
      try {
        store().update({
          processingMessage: 'Warming up the lyrics engine…',
          processingProgress: -1,
        })
        await preloadLyricsModel((p) =>
          store().update({ processingMessage: p.status, processingProgress: p.progress }),
        )
        store().update({ lyricsModelStatus: 'ready' })
        const words = await transcribeLyrics(result.pcm16k, (p) =>
          store().update({ processingMessage: p.status, processingProgress: p.progress }),
        )
        assignLyrics(analysis.segments, words)
      } catch {
        // Lyrics are a bonus — never lose a session over them.
        store().update({ lyricsModelStatus: 'error' })
      }
    }

    const session: JamSession = {
      id: newId(),
      title: defaultSessionTitle(startedAt),
      startedAt,
      durationSec: result.durationSec,
      sampleRate: 16000,
      audioMimeType: result.mimeType,
      segments: analysis.segments,
    }

    store().update({ processingMessage: 'Saving your session…', processingProgress: -1 })
    await saveSession(session, result.blob)

    store().update({
      recordingStatus: 'idle',
      session,
      audioBlob: result.blob,
      view: 'review',
      processingMessage: '',
      processingProgress: -1,
      liveChords: [],
      elapsedSec: 0,
    })
  } catch (err) {
    engine = null
    liveAnalyzer = null
    store().update({ recordingStatus: 'idle', processingMessage: '' })
    fail(err, 'Something went wrong while processing the session.')
  }
}

/** Open a saved session in the review view. */
export async function openSession(id: string): Promise<void> {
  try {
    const loaded = await loadSession(id)
    if (!loaded) throw new Error('That session could not be found.')
    store().update({
      session: loaded.session,
      audioBlob: loaded.audio,
      view: 'review',
      error: null,
    })
  } catch (err) {
    fail(err, 'Could not open the session.')
  }
}

/** Delete a saved session and refresh the library list. */
export async function deleteSession(id: string): Promise<void> {
  try {
    await deleteSessionById(id)
    const cur = store()
    if (cur.session?.id === id) {
      cur.update({ session: null, audioBlob: null })
    }
    await refreshLibrary()
  } catch (err) {
    fail(err, 'Could not delete the session.')
  }
}

async function persistOpenSession(): Promise<void> {
  const { session, audioBlob } = store()
  if (session && audioBlob) await saveSession(session, audioBlob)
}

/** Rename the currently open session (persists). */
export async function renameSession(title: string): Promise<void> {
  const cur = store()
  if (!cur.session) return
  const trimmed = title.trim()
  if (!trimmed || trimmed === cur.session.title) return
  cur.update({ session: { ...cur.session, title: trimmed } })
  try {
    await persistOpenSession()
  } catch (err) {
    fail(err, 'Could not save the new title.')
  }
}

/** Rename a segment label within the open session (persists). */
export async function renameSegment(segmentId: string, label: string): Promise<void> {
  const cur = store()
  if (!cur.session) return
  const segments = cur.session.segments.map((seg) =>
    seg.id === segmentId ? { ...seg, label: label.trim() || undefined } : seg,
  )
  cur.update({ session: { ...cur.session, segments } })
  try {
    await persistOpenSession()
  } catch (err) {
    fail(err, 'Could not save the segment name.')
  }
}

/** Refresh the library list from storage. */
export async function refreshLibrary(): Promise<void> {
  try {
    const sessions = await listSessions()
    store().update({ sessions })
  } catch (err) {
    fail(err, 'Could not load your saved sessions.')
  }
}

/** Download the lead sheet PDF for the open session. */
export async function exportPdf(): Promise<void> {
  const { session } = store()
  if (!session) return
  try {
    const pdf = await exportSessionPdf(session)
    downloadBlob(pdf, safeFilename(session.title, 'pdf'))
  } catch (err) {
    fail(err, 'Could not build the PDF.')
  }
}

/** Download the session audio (original compressed recording). */
export async function exportAudio(): Promise<void> {
  const { session, audioBlob } = store()
  if (!session || !audioBlob) return
  try {
    downloadBlob(audioBlob, audioFilename(session))
  } catch (err) {
    fail(err, 'Could not download the audio.')
  }
}

/** Download a ZIP: PDF + audio + session JSON. */
export async function exportZip(): Promise<void> {
  const { session, audioBlob } = store()
  if (!session || !audioBlob) return
  try {
    const zip = await exportSessionZip(session, audioBlob)
    downloadBlob(zip, safeFilename(session.title, 'zip'))
  } catch (err) {
    fail(err, 'Could not build the ZIP.')
  }
}

/** Navigation helpers. */
export function goToRecord(): void {
  store().update({ view: 'record', error: null })
}

export function goToLibrary(): void {
  store().update({ view: 'library', error: null })
  void refreshLibrary().catch(() => {})
}
