/**
 * Chromagram extraction.
 *
 * A chromagram folds the spectrum into the 12 pitch classes, which is the right
 * representation for chord and key work: it throws away octave and timbre and
 * keeps harmony.
 *
 * The naive "map each FFT bin to its pitch class" version smears badly on
 * guitar, because a plucked string puts a lot of energy into its 3rd harmonic
 * (a fifth) and 5th harmonic (a major third) — exactly the notes that decide
 * whether a chord reads as major, minor or something else. So instead of
 * mapping bins to pitch classes directly we build a *pitch salience* first: for
 * every guitar-range MIDI pitch, sum the peak magnitude around its fundamental
 * and its first few harmonics with a decaying weight. A real fundamental gets
 * reinforced by its own overtones, while an overtone with no fundamental under
 * it stays weak. Those saliences are then folded into 12 bins.
 *
 * The pitch→bin mapping is precomputed once as a flat sparse table, so the
 * per-frame cost is one FFT plus a few hundred array reads.
 */
import { CHROMA, MAX_PITCH_HZ, MIN_PITCH_HZ } from './constants'
import { FFT, hannWindow } from './fft'

export const PITCH_CLASSES = 12

/** MIDI note number of a frequency in Hz. */
export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440)
}

/** Frequency in Hz of a MIDI note number. */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

export interface Chromagram {
  /** Flat frames × 12 array, each frame L2-normalised. */
  data: Float32Array
  /** Number of frames. */
  frames: number
  /** RMS of each frame's time-domain window (used for silence gating). */
  rms: Float32Array
  /** Start time of each frame, seconds relative to the analysed buffer. */
  times: Float32Array
  /** Seconds between consecutive frames. */
  hopSec: number
  /** Length of each analysis window, seconds. */
  frameSec: number
}

/**
 * Reusable chromagram engine. One instance per (sampleRate, frameSize) pair;
 * the expensive tables are built in the constructor.
 */
export class ChromaExtractor {
  readonly frameSize: number
  readonly hopSize: number
  readonly sampleRate: number

  private readonly fft: FFT
  private readonly window: Float32Array
  private readonly mags: Float32Array
  /** Pitch class of each entry in the sparse table. */
  private readonly entryClass: Uint8Array
  private readonly entryLo: Uint32Array
  private readonly entryHi: Uint32Array
  private readonly entryWeight: Float32Array

  constructor(
    sampleRate: number,
    frameSize: number = CHROMA.frameSize,
    hopSize: number = CHROMA.hopSize,
  ) {
    this.sampleRate = sampleRate
    this.frameSize = frameSize
    this.hopSize = hopSize
    this.fft = new FFT(frameSize)
    this.window = hannWindow(frameSize)
    const bins = (frameSize >> 1) + 1
    this.mags = new Float32Array(bins)

    const binHz = sampleRate / frameSize
    const maxHz = Math.min(CHROMA.maxHarmonicHz, sampleRate * 0.475)
    const lowMidi = Math.ceil(hzToMidi(MIN_PITCH_HZ))
    const highMidi = Math.floor(hzToMidi(Math.min(MAX_PITCH_HZ, maxHz)))
    const halfStep = Math.pow(2, CHROMA.binWindowSemitones / 12)

    const cls: number[] = []
    const lo: number[] = []
    const hi: number[] = []
    const weight: number[] = []
    for (let midi = lowMidi; midi <= highMidi; midi++) {
      const f0 = midiToHz(midi)
      for (let h = 1; h <= CHROMA.harmonics; h++) {
        const f = f0 * h
        if (f > maxHz) break
        let binLo = Math.round((f / halfStep) / binHz)
        let binHi = Math.round((f * halfStep) / binHz)
        if (binLo < 1) binLo = 1
        if (binHi >= bins) binHi = bins - 1
        if (binHi < binLo) binHi = binLo
        if (binLo >= bins) break
        cls.push(((midi % 12) + 12) % 12)
        lo.push(binLo)
        hi.push(binHi)
        weight.push(Math.pow(CHROMA.harmonicRolloff, h - 1))
      }
    }
    this.entryClass = Uint8Array.from(cls)
    this.entryLo = Uint32Array.from(lo)
    this.entryHi = Uint32Array.from(hi)
    this.entryWeight = Float32Array.from(weight)
  }

  /**
   * Chroma of a single frame starting at `offset` in `input`. Writes 12
   * L2-normalised values into `out` and returns the frame's RMS.
   */
  frameChroma(input: Float32Array, offset: number, out: Float32Array): number {
    const { frameSize, fft, window, mags } = this

    let sumSq = 0
    const available = Math.max(0, Math.min(frameSize, input.length - offset))
    for (let i = 0; i < available; i++) {
      const v = input[offset + i]
      sumSq += v * v
    }
    const rms = Math.sqrt(sumSq / frameSize)

    fft.forwardWindowed(input, offset, window)
    fft.magnitudes(mags)

    // Log compression: keeps a loud root from swamping the quieter chord tones.
    const gamma = CHROMA.logCompressionGamma
    for (let k = 0; k < mags.length; k++) {
      mags[k] = Math.log1p(gamma * mags[k])
    }

    out.fill(0)
    const { entryClass, entryLo, entryHi, entryWeight } = this
    for (let e = 0; e < entryClass.length; e++) {
      const end = entryHi[e]
      let peak = 0
      for (let k = entryLo[e]; k <= end; k++) {
        const m = mags[k]
        if (m > peak) peak = m
      }
      out[entryClass[e]] += peak * entryWeight[e]
    }

    let norm = 0
    for (let c = 0; c < PITCH_CLASSES; c++) norm += out[c] * out[c]
    norm = Math.sqrt(norm)
    if (norm > 1e-9) {
      for (let c = 0; c < PITCH_CLASSES; c++) out[c] /= norm
    } else {
      out.fill(0)
    }
    return rms
  }

  /** Number of frames `computeChromagram` will produce for a buffer length. */
  frameCount(length: number): number {
    if (length < this.frameSize) return length > 0 ? 1 : 0
    return Math.floor((length - this.frameSize) / this.hopSize) + 1
  }

  /** Full chromagram of a buffer. */
  compute(input: Float32Array): Chromagram {
    const frames = this.frameCount(input.length)
    const data = new Float32Array(frames * PITCH_CLASSES)
    const rms = new Float32Array(frames)
    const times = new Float32Array(frames)
    const scratch = new Float32Array(PITCH_CLASSES)
    const hopSec = this.hopSize / this.sampleRate
    for (let f = 0; f < frames; f++) {
      const offset = f * this.hopSize
      rms[f] = this.frameChroma(input, offset, scratch)
      data.set(scratch, f * PITCH_CLASSES)
      times[f] = offset / this.sampleRate
    }
    return { data, frames, rms, times, hopSec, frameSec: this.frameSize / this.sampleRate }
  }
}

/** Convenience wrapper — allocates a fresh extractor, so prefer reusing one. */
export function computeChromagram(
  input: Float32Array,
  sampleRate: number,
  frameSize: number = CHROMA.frameSize,
  hopSize: number = CHROMA.hopSize,
): Chromagram {
  return new ChromaExtractor(sampleRate, frameSize, hopSize).compute(input)
}

/** Sum of every frame's chroma (frames are already normalised). */
export function sumChroma(chromagram: Chromagram, weights?: Float32Array): Float32Array {
  const total = new Float32Array(PITCH_CLASSES)
  for (let f = 0; f < chromagram.frames; f++) {
    const w = weights ? weights[f] : 1
    if (w <= 0) continue
    const base = f * PITCH_CLASSES
    for (let c = 0; c < PITCH_CLASSES; c++) total[c] += chromagram.data[base + c] * w
  }
  return total
}
