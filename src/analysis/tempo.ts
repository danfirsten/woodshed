/**
 * Tempo estimation: spectral-flux onset strength followed by autocorrelation of
 * the onset envelope.
 *
 * Jams are often rubato or free-time, and a confidently wrong tempo is worse
 * than none at all, so `estimateTempo` returns undefined unless the
 * autocorrelation peak really stands out.
 */
import { clamp01 } from './chords'
import { TEMPO } from './constants'
import { FFT, hannWindow } from './fft'

export interface TempoEstimate {
  bpm: number
  /** 0..1 */
  confidence: number
}

export interface OnsetEnvelope {
  /** Half-wave rectified, locally mean-subtracted onset strength per frame. */
  values: Float32Array
  /** Frames per second. */
  rate: number
}

/**
 * Spectral flux onset strength. Magnitudes are log-compressed first so that a
 * quiet fingerpicked attack registers as strongly as a loud strum.
 */
export function onsetEnvelope(
  pcm: Float32Array,
  sampleRate: number,
  frameSize: number = TEMPO.frameSize,
  hopSize: number = TEMPO.hopSize,
): OnsetEnvelope {
  const rate = sampleRate / hopSize
  if (pcm.length < frameSize * 2) return { values: new Float32Array(0), rate }

  const fft = new FFT(frameSize)
  const window = hannWindow(frameSize)
  const bins = (frameSize >> 1) + 1
  const mags = new Float32Array(bins)
  const prev = new Float32Array(bins)
  const frames = Math.floor((pcm.length - frameSize) / hopSize) + 1
  const flux = new Float32Array(frames)

  for (let f = 0; f < frames; f++) {
    fft.forwardWindowed(pcm, f * hopSize, window)
    fft.magnitudes(mags)
    let sum = 0
    for (let k = 1; k < bins; k++) {
      const m = Math.log1p(100 * mags[k])
      const d = m - prev[k]
      if (d > 0) sum += d
      prev[k] = m
    }
    flux[f] = f === 0 ? 0 : sum
  }

  // Subtract a ~0.5 s moving average and rectify: removes the slow loudness
  // contour and leaves the beat-rate structure the autocorrelation wants.
  const half = Math.max(1, Math.round(rate * 0.25))
  const values = new Float32Array(frames)
  let acc = 0
  for (let f = 0; f < Math.min(frames, half); f++) acc += flux[f]
  let lo = 0
  let hi = Math.min(frames, half)
  for (let f = 0; f < frames; f++) {
    const newLo = Math.max(0, f - half)
    const newHi = Math.min(frames, f + half + 1)
    while (hi < newHi) acc += flux[hi++]
    while (lo < newLo) acc -= flux[lo++]
    const mean = acc / Math.max(1, hi - lo)
    const v = flux[f] - mean
    values[f] = v > 0 ? v : 0
  }
  return { values, rate }
}

/**
 * Autocorrelation of an onset envelope over the musically plausible lag range,
 * weighted by a log-normal prior around `TEMPO.priorCenterBpm` so the estimate
 * doesn't settle on a half- or double-time peak.
 */
export function tempoFromEnvelope(env: OnsetEnvelope): TempoEstimate | undefined {
  const { values, rate } = env
  const minLag = Math.max(2, Math.floor((60 / TEMPO.maxBpm) * rate))
  const maxLag = Math.ceil((60 / TEMPO.minBpm) * rate)
  const n = values.length - maxLag
  if (n < maxLag * 2) return undefined

  let energy = 0
  for (let i = 0; i < n; i++) energy += values[i] * values[i]
  if (energy <= 1e-9) return undefined

  const lags = maxLag - minLag + 1
  const ac = new Float32Array(lags)
  let acSum = 0
  for (let l = 0; l < lags; l++) {
    const lag = minLag + l
    let sum = 0
    for (let i = 0; i < n; i++) sum += values[i] * values[i + lag]
    const norm = sum / energy
    ac[l] = norm
    acSum += norm
  }

  let bestIdx = -1
  let bestWeighted = -Infinity
  for (let l = 0; l < lags; l++) {
    const bpm = (60 * rate) / (minLag + l)
    const octaves = Math.log2(bpm / TEMPO.priorCenterBpm) / TEMPO.priorWidthOctaves
    const weighted = ac[l] * Math.exp(-0.5 * octaves * octaves)
    if (weighted > bestWeighted) {
      bestWeighted = weighted
      bestIdx = l
    }
  }
  if (bestIdx < 0) return undefined

  const peak = ac[bestIdx]
  const meanAc = acSum / lags
  const salience = meanAc > 1e-9 ? peak / meanAc : 0
  if (peak < TEMPO.minPeakRatio || salience < TEMPO.minPeakSalience) return undefined

  // Parabolic interpolation for sub-frame lag resolution.
  let lag = minLag + bestIdx
  if (bestIdx > 0 && bestIdx < lags - 1) {
    const a = ac[bestIdx - 1]
    const b = ac[bestIdx]
    const c = ac[bestIdx + 1]
    const denom = a - 2 * b + c
    if (Math.abs(denom) > 1e-9) {
      const shift = (0.5 * (a - c)) / denom
      if (Math.abs(shift) <= 1) lag += shift
    }
  }

  const bpm = (60 * rate) / lag
  const confidence = clamp01(0.6 * clamp01((salience - 1) / 0.8) + 0.4 * clamp01(peak / 0.45))
  if (confidence < TEMPO.minConfidence) return undefined
  return { bpm: Math.round(bpm * 10) / 10, confidence }
}

/** Convenience: onset envelope + autocorrelation for a chunk of audio. */
export function estimateTempo(pcm: Float32Array, sampleRate: number): TempoEstimate | undefined {
  if (pcm.length < sampleRate * TEMPO.minSegmentSec) return undefined
  return tempoFromEnvelope(onsetEnvelope(pcm, sampleRate))
}
