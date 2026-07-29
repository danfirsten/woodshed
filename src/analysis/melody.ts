/**
 * Monophonic melody extraction.
 *
 * A strummed chord has no single pitch, and any pitch tracker asked about one
 * will happily invent an answer. The defence is the McLeod pitch method's
 * *clarity* value: polyphonic frames score poorly, single-note frames score
 * near 1. Holding a high clarity threshold means riffs and single-note lines
 * get transcribed while strummed passages produce nothing — which is exactly
 * the trade we want. Fewer, correct notes beat many wrong ones.
 */
import { PitchDetector } from 'pitchy'
import type { NoteEvent } from '../types'
import { clamp01 } from './chords'
import { hzToMidi } from './chroma'
import { MELODY } from './constants'

export interface PitchTrack {
  /** MIDI pitch per frame, NaN where no confident pitch was found. */
  midi: Float32Array
  /** MPM clarity per frame, 0 where unvoiced. */
  clarity: Float32Array
  hopSec: number
  frameSec: number
}

/** Median of the defined (non-NaN) values in a window; NaN if there are none. */
function medianFilter(midi: Float32Array, window: number): Float32Array {
  const n = midi.length
  const out = new Float32Array(n)
  const half = window >> 1
  const buf: number[] = []
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(midi[i])) {
      out[i] = NaN
      continue
    }
    buf.length = 0
    const lo = Math.max(0, i - half)
    const hi = Math.min(n - 1, i + half)
    for (let j = lo; j <= hi; j++) {
      if (!Number.isNaN(midi[j])) buf.push(midi[j])
    }
    buf.sort((a, b) => a - b)
    out[i] = buf.length === 0 ? NaN : buf[buf.length >> 1]
  }
  return out
}

/**
 * Run the pitch detector over a buffer. Frames below `MELODY.minRms` are
 * skipped before the detector is called at all — that gate alone removes most
 * of the work on a session with a lot of empty space between phrases.
 */
export function trackPitch(pcm: Float32Array, sampleRate: number): PitchTrack {
  const frameSize = MELODY.frameSize
  const hopSize = MELODY.hopSize
  const frames = pcm.length < frameSize ? 0 : Math.floor((pcm.length - frameSize) / hopSize) + 1
  const midi = new Float32Array(frames)
  const clarity = new Float32Array(frames)
  if (frames === 0) {
    return { midi, clarity, hopSec: hopSize / sampleRate, frameSec: frameSize / sampleRate }
  }

  const detector = PitchDetector.forFloat32Array(frameSize)
  detector.minVolumeAbsolute = MELODY.minRms

  for (let f = 0; f < frames; f++) {
    const offset = f * hopSize
    const view = pcm.subarray(offset, offset + frameSize)
    let sumSq = 0
    for (let i = 0; i < frameSize; i++) sumSq += view[i] * view[i]
    if (Math.sqrt(sumSq / frameSize) < MELODY.minRms) {
      midi[f] = NaN
      continue
    }
    const [hz, c] = detector.findPitch(view, sampleRate)
    if (c >= MELODY.minClarity && hz >= MELODY.minHz && hz <= MELODY.maxHz) {
      midi[f] = hzToMidi(hz)
      clarity[f] = c
    } else {
      midi[f] = NaN
    }
  }

  return {
    midi: medianFilter(midi, MELODY.medianFrames),
    clarity,
    hopSec: hopSize / sampleRate,
    frameSec: frameSize / sampleRate,
  }
}

/**
 * Merge a pitch track into note events. A run continues while frames stay
 * within `maxDeviationSemitones` of the run's pitch; short dropouts (up to
 * `maxGapFrames`) are tolerated so vibrato or a brief mute doesn't split a note.
 */
export function pitchTrackToNotes(track: PitchTrack, offsetSec: number): NoteEvent[] {
  const { midi, clarity, hopSec, frameSec } = track
  const notes: NoteEvent[] = []
  const minFrames = Math.max(1, Math.ceil(MELODY.minDurationSec / hopSec))

  let startFrame = -1
  let lastFrame = -1
  let target = 0
  let sumMidi = 0
  let sumClarity = 0
  let count = 0

  const flush = () => {
    if (startFrame >= 0 && count > 0 && lastFrame - startFrame + 1 >= minFrames) {
      const start = offsetSec + startFrame * hopSec + frameSec / 2 - hopSec / 2
      const end = offsetSec + lastFrame * hopSec + frameSec / 2 + hopSec / 2
      notes.push({
        startSec: Math.max(0, start),
        endSec: Math.max(0, end),
        midi: Math.round(sumMidi / count),
        confidence: clamp01(sumClarity / count),
      })
    }
    startFrame = -1
    lastFrame = -1
    count = 0
    sumMidi = 0
    sumClarity = 0
  }

  for (let f = 0; f < midi.length; f++) {
    const value = midi[f]
    if (Number.isNaN(value)) {
      if (startFrame >= 0 && f - lastFrame > MELODY.maxGapFrames) flush()
      continue
    }
    if (startFrame < 0) {
      startFrame = f
      target = value
    } else if (
      Math.abs(value - target) > MELODY.maxDeviationSemitones ||
      Math.round(value) !== Math.round(target) ||
      f - lastFrame > MELODY.maxGapFrames + 1
    ) {
      flush()
      startFrame = f
      target = value
    }
    lastFrame = f
    sumMidi += value
    sumClarity += clarity[f] || MELODY.minClarity
    count++
    // Track the run's centre so slow bends don't drag it off pitch.
    target = sumMidi / count
  }
  flush()
  return notes
}

/** Full melody pass for one chunk of audio. */
export function detectNotes(pcm: Float32Array, sampleRate: number, offsetSec: number): NoteEvent[] {
  return pitchTrackToNotes(trackPitch(pcm, sampleRate), offsetSec)
}
