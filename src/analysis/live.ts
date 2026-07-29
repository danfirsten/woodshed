/**
 * Real-time chord tracking during recording.
 *
 * This runs on the main thread while the user is playing, so it has to be
 * cheap: one 500 ms chromagram every 250 ms (six small FFTs) and a dot product
 * against 60 templates. That is a rounding error next to the UI's own work.
 *
 * The output is deliberately conservative. A chord candidate has to win three
 * consecutive detections (~750 ms) before it is accepted, which is what stops
 * the on-screen chord from flickering between a chord and its relative
 * minor while a string rings out. Nothing is emitted during silence — the live
 * strip shows what was played, never "N.C.".
 *
 * Everything here is superseded by `analyzeSession` once recording stops; this
 * is the "am I being heard correctly?" feedback loop, not the transcript.
 */
import type { AudioFrame, ChordEvent } from '../types'
import { ChromaExtractor, PITCH_CLASSES } from './chroma'
import { CHORD_VOCABULARY, clamp01, matchChord } from './chords'
import { LIVE } from './constants'
import { floorPow2 } from './fft'

interface StableChord {
  symbol: string
  startSec: number
  scoreSum: number
  scoreCount: number
}

export class LiveAnalyzer {
  private readonly onChord: (chord: ChordEvent) => void

  private sampleRate = 0
  private extractor: ChromaExtractor | null = null
  private buffer = new Float32Array(0)
  /** Number of valid samples currently held (right-aligned in `buffer`). */
  private filled = 0
  private windowSamples = 0
  private strideSamples = 0
  private samplesSinceDetect = 0
  /** Absolute time of the sample just past the end of `buffer`. */
  private bufferEndSec = 0

  private readonly chroma = new Float32Array(PITCH_CLASSES)
  private readonly frameChroma = new Float32Array(PITCH_CLASSES)

  private candidate: string | null = null
  private candidateCount = 0
  private candidateStartSec = 0
  private candidateScoreSum = 0
  private stable: StableChord | null = null

  constructor(onChord: (chord: ChordEvent) => void) {
    this.onChord = onChord
  }

  /** Feed one chunk of mono PCM from the audio engine. */
  pushFrame(frame: AudioFrame): void {
    const { samples, sampleRate } = frame
    if (samples.length === 0 || sampleRate <= 0) return
    if (sampleRate !== this.sampleRate) this.configure(sampleRate)

    this.bufferEndSec = frame.timeSec + samples.length / sampleRate

    const { buffer, windowSamples } = this
    if (samples.length >= windowSamples) {
      buffer.set(samples.subarray(samples.length - windowSamples))
      this.filled = windowSamples
    } else {
      buffer.copyWithin(0, samples.length)
      buffer.set(samples, windowSamples - samples.length)
      this.filled = Math.min(windowSamples, this.filled + samples.length)
    }

    this.samplesSinceDetect += samples.length
    while (this.samplesSinceDetect >= this.strideSamples && this.filled >= windowSamples) {
      this.samplesSinceDetect -= this.strideSamples
      this.detect()
    }
    // Don't let a long silent stretch accumulate a detection backlog.
    if (this.samplesSinceDetect > this.strideSamples * 4) {
      this.samplesSinceDetect = this.samplesSinceDetect % this.strideSamples
    }
  }

  /**
   * Clear all state. Any chord still in progress is finalised first (ending at
   * the last audio received), so the final chord of a take isn't lost.
   */
  reset(): void {
    this.finalize(this.bufferEndSec)
    this.buffer.fill(0)
    this.filled = 0
    this.samplesSinceDetect = 0
    this.bufferEndSec = 0
    this.candidate = null
    this.candidateCount = 0
    this.candidateScoreSum = 0
    this.candidateStartSec = 0
    this.stable = null
  }

  private configure(sampleRate: number): void {
    this.sampleRate = sampleRate
    const frameSize = Math.max(256, floorPow2(Math.round(LIVE.frameSec * sampleRate)))
    const hopSize = Math.max(64, Math.round(LIVE.frameHopSec * sampleRate))
    this.windowSamples = Math.max(frameSize, Math.round(LIVE.windowSec * sampleRate))
    this.strideSamples = Math.max(1, Math.round(LIVE.strideSec * sampleRate))
    this.extractor = new ChromaExtractor(sampleRate, frameSize, hopSize)
    this.buffer = new Float32Array(this.windowSamples)
    this.filled = 0
    this.samplesSinceDetect = 0
  }

  /** One detection over the current 500 ms window. */
  private detect(): void {
    const extractor = this.extractor
    if (!extractor) return
    const { buffer, windowSamples, chroma, frameChroma } = this

    chroma.fill(0)
    let frames = 0
    let peakRms = 0
    for (
      let offset = 0;
      offset + extractor.frameSize <= windowSamples;
      offset += extractor.hopSize
    ) {
      const rms = extractor.frameChroma(buffer, offset, frameChroma)
      if (rms > peakRms) peakRms = rms
      for (let c = 0; c < PITCH_CLASSES; c++) chroma[c] += frameChroma[c]
      frames++
    }
    if (frames === 0) return

    const windowEndSec = this.bufferEndSec
    const windowStartSec = Math.max(0, windowEndSec - windowSamples / this.sampleRate)

    let symbol: string | null = null
    let score = 0
    if (peakRms >= LIVE.silenceRms) {
      let norm = 0
      for (let c = 0; c < PITCH_CLASSES; c++) norm += chroma[c] * chroma[c]
      norm = Math.sqrt(norm)
      if (norm > 1e-9) {
        for (let c = 0; c < PITCH_CLASSES; c++) chroma[c] /= norm
        const match = matchChord(chroma, 0, LIVE.minScore, CHORD_VOCABULARY)
        if (match.label >= 0) {
          symbol = CHORD_VOCABULARY[match.label].symbol
          score = match.score
        }
      }
    }

    // Run bookkeeping for the hysteresis window.
    if (symbol === this.candidate) {
      this.candidateCount++
      this.candidateScoreSum += score
    } else {
      this.candidate = symbol
      this.candidateCount = 1
      this.candidateScoreSum = score
      this.candidateStartSec = windowStartSec
    }

    if (this.stable && this.stable.symbol === symbol) {
      this.stable.scoreSum += score
      this.stable.scoreCount++
    }

    if (this.candidateCount < LIVE.stableDetections) return
    const stableSymbol = this.stable?.symbol ?? null
    if (stableSymbol === this.candidate) return

    // The stable chord just changed (or silence began): close the old one out.
    this.finalize(this.candidateStartSec)
    this.stable = symbol
      ? {
          symbol,
          startSec: this.candidateStartSec,
          scoreSum: this.candidateScoreSum,
          scoreCount: this.candidateCount,
        }
      : null
  }

  private finalize(endSec: number): void {
    const stable = this.stable
    this.stable = null
    if (!stable) return
    const end = Math.max(stable.startSec, endSec)
    if (end - stable.startSec < LIVE.minDurationSec) return
    this.onChord({
      startSec: stable.startSec,
      endSec: end,
      symbol: stable.symbol,
      confidence: clamp01(stable.scoreCount > 0 ? stable.scoreSum / stable.scoreCount : 0),
    })
  }
}
