/**
 * Key estimation with the Krumhansl–Schmuckler algorithm: correlate the
 * segment's aggregated chroma against the empirical major and minor tonal
 * hierarchy profiles at all 12 rotations and keep the best fit.
 */
import type { KeyGuess } from '../types'
import { PITCH_NAMES, clamp01 } from './chords'
import { PITCH_CLASSES } from './chroma'
import { KEY } from './constants'

/** Krumhansl & Kessler (1982) probe-tone ratings. */
export const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
] as const

export const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
] as const

function pearson(a: ArrayLike<number>, b: ArrayLike<number>, rotation: number): number {
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < PITCH_CLASSES; i++) {
    meanA += a[(i + rotation) % PITCH_CLASSES]
    meanB += b[i]
  }
  meanA /= PITCH_CLASSES
  meanB /= PITCH_CLASSES

  let num = 0
  let devA = 0
  let devB = 0
  for (let i = 0; i < PITCH_CLASSES; i++) {
    const da = a[(i + rotation) % PITCH_CLASSES] - meanA
    const db = b[i] - meanB
    num += da * db
    devA += da * da
    devB += db * db
  }
  const den = Math.sqrt(devA * devB)
  return den > 1e-12 ? num / den : 0
}

/**
 * Best key for an aggregated chroma vector, or undefined when the chroma is
 * empty or fits nothing well enough to be worth showing.
 */
export function estimateKey(chroma: ArrayLike<number>): KeyGuess | undefined {
  let total = 0
  for (let c = 0; c < PITCH_CLASSES; c++) total += chroma[c]
  if (total <= 1e-9) return undefined

  let best = { r: -2, tonic: 0, mode: 'major' as 'major' | 'minor' }
  let second = -2
  for (let tonic = 0; tonic < PITCH_CLASSES; tonic++) {
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE
      const r = pearson(chroma, profile, tonic)
      if (r > best.r) {
        second = best.r
        best = { r, tonic, mode }
      } else if (r > second) {
        second = r
      }
    }
  }
  if (best.r < KEY.minCorrelation) return undefined

  // A strong fit that also clearly beats the runner-up (usually the relative
  // major/minor) is what "confident" means here.
  const margin = Math.max(0, best.r - Math.max(second, 0))
  const confidence = clamp01(0.7 * clamp01(best.r) + 0.3 * clamp01(margin * 3))
  return { tonic: PITCH_NAMES[best.tonic], mode: best.mode, confidence }
}
