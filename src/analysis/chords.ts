/**
 * Chord vocabulary, template matching, and the frame-track → ChordEvent[] pass.
 *
 * Everything here is a pure function of a chromagram, which makes it easy to
 * reason about and to reuse from both the offline worker and the live analyzer.
 */
import type { ChordEvent } from '../types'
import { CHORD } from './constants'
import { PITCH_CLASSES, type Chromagram } from './chroma'

/** Pitch class names, using the spellings guitarists actually write. */
export const PITCH_NAMES = [
  'C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B',
] as const

export type ChordQuality = 'maj' | 'min' | '7' | 'maj7' | 'm7'

/** Interval → weight for each quality. Roots and thirds decide the chord, so
 *  they carry the most weight; the fifth is discounted because guitar overtones
 *  put energy there anyway. */
const QUALITY_INTERVALS: Record<ChordQuality, ReadonlyArray<readonly [number, number]>> = {
  maj: [[0, 1], [4, 1], [7, 0.8]],
  min: [[0, 1], [3, 1], [7, 0.8]],
  '7': [[0, 1], [4, 1], [7, 0.7], [10, 0.9]],
  maj7: [[0, 1], [4, 1], [7, 0.7], [11, 0.9]],
  m7: [[0, 1], [3, 1], [7, 0.7], [10, 0.9]],
}

const QUALITY_SUFFIX: Record<ChordQuality, string> = {
  maj: '',
  min: 'm',
  '7': '7',
  maj7: 'maj7',
  m7: 'm7',
}

export interface ChordTemplate {
  symbol: string
  root: number
  quality: ChordQuality
  /** L2-normalised 12-vector. */
  weights: Float32Array
  /** Multiplied into the match score; see CHORD.qualityPrior. */
  prior: number
}

/** The full vocabulary: 12 roots × 5 qualities = 60 chords. "No chord" is
 *  represented by label -1 rather than by a template. */
export function buildChordVocabulary(): ChordTemplate[] {
  const vocab: ChordTemplate[] = []
  const qualities = Object.keys(QUALITY_INTERVALS) as ChordQuality[]
  for (let root = 0; root < PITCH_CLASSES; root++) {
    for (const quality of qualities) {
      const weights = new Float32Array(PITCH_CLASSES)
      for (const [interval, w] of QUALITY_INTERVALS[quality]) {
        weights[(root + interval) % PITCH_CLASSES] = w
      }
      let norm = 0
      for (let c = 0; c < PITCH_CLASSES; c++) norm += weights[c] * weights[c]
      norm = Math.sqrt(norm)
      for (let c = 0; c < PITCH_CLASSES; c++) weights[c] /= norm
      vocab.push({
        symbol: `${PITCH_NAMES[root]}${QUALITY_SUFFIX[quality]}`,
        root,
        quality,
        weights,
        prior: CHORD.qualityPrior[quality],
      })
    }
  }
  return vocab
}

/** Shared vocabulary — templates are immutable, so one copy is enough. */
export const CHORD_VOCABULARY: ChordTemplate[] = buildChordVocabulary()

export interface ChordMatch {
  /** Index into the vocabulary, or -1 for "no chord". */
  label: number
  /** Cosine similarity × quality prior, 0..1. */
  score: number
}

/**
 * Best template for one (already L2-normalised) chroma vector, read from
 * `chroma` at `offset`.
 */
export function matchChord(
  chroma: Float32Array,
  offset = 0,
  minScore: number = CHORD.minScore,
  vocab: ChordTemplate[] = CHORD_VOCABULARY,
): ChordMatch {
  let bestScore = 0
  let bestLabel = -1
  for (let t = 0; t < vocab.length; t++) {
    const w = vocab[t].weights
    let dot = 0
    for (let c = 0; c < PITCH_CLASSES; c++) dot += chroma[offset + c] * w[c]
    const score = dot * vocab[t].prior
    if (score > bestScore) {
      bestScore = score
      bestLabel = t
    }
  }
  return bestScore >= minScore ? { label: bestLabel, score: bestScore } : { label: -1, score: bestScore }
}

export interface ChordTrack {
  /** Vocabulary index per frame, -1 for silence / no confident match. */
  labels: Int16Array
  /** Score of the winning template per frame. */
  scores: Float32Array
}

/**
 * Frame-wise chord labels for a chromagram. Frames quieter than
 * `CHORD.silenceRatio` of the loudest frame are forced to "no chord" so that
 * decaying room noise between phrases doesn't get a chord name.
 */
export function chordTrack(
  chromagram: Chromagram,
  vocab: ChordTemplate[] = CHORD_VOCABULARY,
): ChordTrack {
  const { frames, data, rms } = chromagram
  const labels = new Int16Array(frames)
  const scores = new Float32Array(frames)
  let peakRms = 0
  for (let f = 0; f < frames; f++) if (rms[f] > peakRms) peakRms = rms[f]
  const silenceRms = peakRms * CHORD.silenceRatio

  for (let f = 0; f < frames; f++) {
    if (rms[f] < silenceRms) {
      labels[f] = -1
      scores[f] = 0
      continue
    }
    const m = matchChord(data, f * PITCH_CLASSES, CHORD.minScore, vocab)
    labels[f] = m.label
    scores[f] = m.score
  }
  return { labels, scores }
}

/**
 * Median (for categorical data: mode) filter over a label track. Ties keep the
 * centre frame's own label, which stops the filter from inventing labels.
 */
export function modeFilter(labels: Int16Array, window: number): Int16Array {
  const n = labels.length
  const out = new Int16Array(n)
  if (window <= 1 || n === 0) {
    out.set(labels)
    return out
  }
  const half = window >> 1
  const counts = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    counts.clear()
    const lo = Math.max(0, i - half)
    const hi = Math.min(n - 1, i + half)
    for (let j = lo; j <= hi; j++) {
      const l = labels[j]
      counts.set(l, (counts.get(l) ?? 0) + 1)
    }
    let best = labels[i]
    let bestCount = counts.get(best) ?? 0
    for (const [label, count] of counts) {
      if (count > bestCount) {
        best = label
        bestCount = count
      }
    }
    out[i] = best
  }
  return out
}

interface Run {
  label: number
  start: number
  /** Exclusive. */
  end: number
}

function runsOf(labels: Int16Array): Run[] {
  const runs: Run[] = []
  for (let i = 0; i < labels.length; i++) {
    const last = runs[runs.length - 1]
    if (last && last.label === labels[i]) last.end = i + 1
    else runs.push({ label: labels[i], start: i, end: i + 1 })
  }
  return runs
}

/**
 * Absorb runs shorter than `minFrames` into their longer neighbour, repeatedly,
 * until every run is long enough (or only one run is left). This is what kills
 * the sub-300 ms flicker between, say, C and Am when a chord is ringing out.
 */
export function suppressShortRuns(labels: Int16Array, minFrames: number): Int16Array {
  const out = Int16Array.from(labels)
  if (minFrames <= 1) return out
  for (let pass = 0; pass < 8; pass++) {
    const runs = runsOf(out)
    if (runs.length <= 1) break
    let changed = false
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r]
      if (run.end - run.start >= minFrames) continue
      const prev = runs[r - 1]
      const next = runs[r + 1]
      let take: Run | undefined
      if (prev && next) take = prev.end - prev.start >= next.end - next.start ? prev : next
      else take = prev ?? next
      if (!take) continue
      out.fill(take.label, run.start, run.end)
      run.label = take.label
      changed = true
    }
    if (!changed) break
  }
  return out
}

/**
 * Turn a smoothed label track into merged ChordEvents with absolute times.
 *
 * @param original  the pre-smoothing labels, used to score confidence honestly
 *                  (only frames that actually voted for the winning chord count)
 * @param offsetSec added to every timestamp so events are absolute from the
 *                  start of the session
 */
export function labelsToChordEvents(
  labels: Int16Array,
  original: Int16Array,
  scores: Float32Array,
  chromagram: Chromagram,
  offsetSec: number,
  boundsSec: { start: number; end: number },
  vocab: ChordTemplate[] = CHORD_VOCABULARY,
): ChordEvent[] {
  const { times, hopSec, frameSec } = chromagram
  const events: ChordEvent[] = []
  const centre = (f: number) => offsetSec + times[f] + frameSec / 2

  for (const run of runsOf(labels)) {
    if (run.label < 0) continue
    const startSec = Math.max(boundsSec.start, centre(run.start) - hopSec / 2)
    const endSec = Math.min(boundsSec.end, centre(run.end - 1) + hopSec / 2)
    if (endSec - startSec < CHORD.minDurationSec) continue

    let sum = 0
    let count = 0
    for (let f = run.start; f < run.end; f++) {
      if (original[f] === run.label) {
        sum += scores[f]
        count++
      }
    }
    if (count === 0) {
      for (let f = run.start; f < run.end; f++) sum += scores[f]
      count = run.end - run.start
    }
    events.push({
      startSec,
      endSec,
      symbol: vocab[run.label].symbol,
      confidence: clamp01(count > 0 ? sum / count : 0),
    })
  }
  return events
}

/** Full chord pass for one segment's chromagram. */
export function recognizeChords(
  chromagram: Chromagram,
  offsetSec: number,
  boundsSec: { start: number; end: number },
  vocab: ChordTemplate[] = CHORD_VOCABULARY,
): ChordEvent[] {
  const track = chordTrack(chromagram, vocab)
  const smoothed = modeFilter(track.labels, CHORD.smoothingFrames)
  const minFrames = Math.max(1, Math.round(CHORD.minDurationSec / chromagram.hopSec))
  const cleaned = suppressShortRuns(smoothed, minFrames)
  return labelsToChordEvents(cleaned, track.labels, track.scores, chromagram, offsetSec, boundsSec, vocab)
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}
