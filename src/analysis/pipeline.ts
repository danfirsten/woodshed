/**
 * The offline refinement pipeline, as one pure(ish) synchronous function.
 *
 * Keeping this free of worker/DOM concerns means it can run inside the worker
 * (normal case), on the main thread (fallback when workers are unavailable),
 * or in a test harness.
 */
import { ANALYSIS_SAMPLE_RATE, newId, type JamSegment } from '../types'
import { ChromaExtractor, sumChroma } from './chroma'
import { CHORD_VOCABULARY, recognizeChords } from './chords'
import { CHORD, TEMPO } from './constants'
import { estimateKey } from './key'
import { detectNotes } from './melody'
import { detectSegments } from './segmentation'
import { estimateTempo } from './tempo'

export interface AnalysisProgress {
  status: string
  /** 0..1 */
  progress: number
}

export type ProgressReporter = (p: AnalysisProgress) => void

const noop: ProgressReporter = () => {}

function ordinal(index: number, total: number): string {
  return total > 1 ? ` ${index + 1} of ${total}` : ''
}

/**
 * Full analysis of a mono PCM buffer. Returns segments with absolute times,
 * ready to drop into a JamSession. `lyrics` is always empty here — the lyrics
 * engine fills it in later.
 */
export function runAnalysis(
  pcm: Float32Array,
  sampleRate: number = ANALYSIS_SAMPLE_RATE,
  report: ProgressReporter = noop,
): JamSegment[] {
  report({ status: 'Listening for where the ideas start and stop…', progress: 0.02 })
  const raw = detectSegments(pcm, sampleRate)
  if (raw.length === 0) {
    report({ status: 'No playing found in this take.', progress: 1 })
    return []
  }

  // One extractor for the whole session: the tables and FFT scratch buffers are
  // the expensive part and they're identical for every segment.
  const extractor = new ChromaExtractor(sampleRate)
  const segments: JamSegment[] = []
  const total = raw.length
  const span = 0.94

  for (let i = 0; i < total; i++) {
    const { startSec, endSec } = raw[i]
    const base = 0.04 + span * (i / total)
    const step = span / total / 4
    const label = ordinal(i, total)
    const from = Math.max(0, Math.floor(startSec * sampleRate))
    const to = Math.min(pcm.length, Math.ceil(endSec * sampleRate))
    const slice = pcm.subarray(from, to)
    const bounds = { start: startSec, end: endSec }

    report({ status: `Working out the chords in idea${label}…`, progress: base })
    const chromagram = extractor.compute(slice)
    const chords = recognizeChords(chromagram, startSec, bounds, CHORD_VOCABULARY)

    report({ status: `Finding the key of idea${label}…`, progress: base + step })
    // Weight the aggregate chroma by frame loudness so quiet decay tails don't
    // count as much as the notes actually being played.
    let peakRms = 0
    for (let f = 0; f < chromagram.frames; f++) {
      if (chromagram.rms[f] > peakRms) peakRms = chromagram.rms[f]
    }
    const gate = peakRms * CHORD.silenceRatio
    const weights = new Float32Array(chromagram.frames)
    for (let f = 0; f < chromagram.frames; f++) {
      weights[f] = chromagram.rms[f] >= gate ? chromagram.rms[f] : 0
    }
    const keyGuess = estimateKey(sumChroma(chromagram, weights))

    report({ status: `Looking for a pulse in idea${label}…`, progress: base + step * 2 })
    const tempo =
      endSec - startSec >= TEMPO.minSegmentSec ? estimateTempo(slice, sampleRate) : undefined

    report({ status: `Transcribing single notes in idea${label}…`, progress: base + step * 3 })
    const notes = detectNotes(slice, sampleRate, startSec)

    segments.push({
      id: newId(),
      index: i,
      startSec,
      endSec,
      keyGuess,
      tempoBpm: tempo?.bpm,
      chords,
      notes,
      lyrics: [],
    })
  }

  report({ status: 'Analysis complete.', progress: 1 })
  return segments
}
