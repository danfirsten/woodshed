/**
 * Splitting a jam into musical "ideas".
 *
 * There are no song boundaries in a jam, so the only reliable structural cue is
 * the player stopping. The envelope is thresholded relative to the room's own
 * noise floor (an absolute threshold would fail in both a quiet and a noisy
 * room), then short gaps are bridged and short bursts discarded so that a
 * missed note or a cough doesn't create a segment.
 */
import { SEGMENT } from './constants'

export interface RawSegment {
  startSec: number
  endSec: number
  /** Seconds of actually-playing audio inside the segment. */
  activeSec: number
}

export interface Envelope {
  /** RMS per hop. */
  rms: Float32Array
  hopSec: number
  /** Total duration of the analysed buffer, seconds. */
  durationSec: number
}

/** Short-time RMS envelope. */
export function rmsEnvelope(
  pcm: Float32Array,
  sampleRate: number,
  hopSec: number = SEGMENT.hopSec,
  windowSec: number = SEGMENT.windowSec,
): Envelope {
  const hop = Math.max(1, Math.round(hopSec * sampleRate))
  const win = Math.max(hop, Math.round(windowSec * sampleRate))
  const frames = pcm.length === 0 ? 0 : Math.ceil(pcm.length / hop)
  const rms = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const start = f * hop
    const end = Math.min(pcm.length, start + win)
    let sumSq = 0
    for (let i = start; i < end; i++) sumSq += pcm[i] * pcm[i]
    rms[f] = end > start ? Math.sqrt(sumSq / (end - start)) : 0
  }
  return { rms, hopSec: hop / sampleRate, durationSec: pcm.length / sampleRate }
}

/** Value at `p` (0..1) of a copy of `values`, sorted ascending. */
export function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length
  if (n === 0) return 0
  const sorted = Float32Array.from(values as ArrayLike<number>)
  sorted.sort()
  const idx = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))
  return sorted[idx]
}

const toDb = (x: number) => 20 * Math.log10(Math.max(x, 1e-7))

/**
 * Boolean "is playing" decision per envelope frame, plus the threshold used
 * (exposed mostly so the reasoning is inspectable from tests).
 */
export function activityMask(env: Envelope): { active: Uint8Array; thresholdDb: number } {
  const floorDb = toDb(percentile(env.rms, SEGMENT.noiseFloorPercentile))
  const thresholdDb = Math.max(floorDb + SEGMENT.activeAboveFloorDb, SEGMENT.minActiveDb)
  const active = new Uint8Array(env.rms.length)
  for (let f = 0; f < env.rms.length; f++) {
    active[f] = toDb(env.rms[f]) > thresholdDb ? 1 : 0
  }
  return { active, thresholdDb }
}

/** Split a session into segments. Times are relative to the buffer's start. */
export function detectSegments(pcm: Float32Array, sampleRate: number): RawSegment[] {
  const env = rmsEnvelope(pcm, sampleRate)
  if (env.rms.length === 0) return []
  const { active } = activityMask(env)
  const { hopSec, durationSec } = env

  // Contiguous runs of activity.
  const runs: Array<{ start: number; end: number }> = []
  let runStart = -1
  for (let f = 0; f < active.length; f++) {
    if (active[f]) {
      if (runStart < 0) runStart = f
    } else if (runStart >= 0) {
      runs.push({ start: runStart, end: f })
      runStart = -1
    }
  }
  if (runStart >= 0) runs.push({ start: runStart, end: active.length })
  if (runs.length === 0) return []

  // Bridge gaps shorter than minGapSec — a pause inside a phrase is not a split.
  const gapFrames = SEGMENT.minGapSec / hopSec
  const merged: Array<{ start: number; end: number; activeFrames: number }> = []
  for (const run of runs) {
    const last = merged[merged.length - 1]
    if (last && run.start - last.end < gapFrames) {
      last.end = run.end
      last.activeFrames += run.end - run.start
    } else {
      merged.push({ start: run.start, end: run.end, activeFrames: run.end - run.start })
    }
  }

  const totalActiveSec = merged.reduce((s, m) => s + m.activeFrames * hopSec, 0)
  let kept = merged.filter((m) => m.activeFrames * hopSec >= SEGMENT.minActiveSec)

  // Never hand back an empty analysis for a session that clearly has playing in
  // it: fall back to one segment spanning everything audible.
  if (kept.length === 0 && totalActiveSec >= SEGMENT.fallbackMinActiveSec) {
    kept = [
      {
        start: merged[0].start,
        end: merged[merged.length - 1].end,
        activeFrames: merged.reduce((s, m) => s + m.activeFrames, 0),
      },
    ]
  }
  if (kept.length === 0) return []

  // Pad edges, clamping into the buffer and never letting neighbours overlap.
  const segments: RawSegment[] = []
  for (let i = 0; i < kept.length; i++) {
    const m = kept[i]
    const prev = kept[i - 1]
    const next = kept[i + 1]
    const rawStart = m.start * hopSec
    const rawEnd = Math.min(durationSec, m.end * hopSec)
    const lowerBound = prev ? (prev.end * hopSec + rawStart) / 2 : 0
    const upperBound = next ? (rawEnd + next.start * hopSec) / 2 : durationSec
    segments.push({
      startSec: Math.max(0, lowerBound, rawStart - SEGMENT.padSec),
      endSec: Math.min(durationSec, upperBound, rawEnd + SEGMENT.padSec),
      activeSec: m.activeFrames * hopSec,
    })
  }
  return segments.filter((s) => s.endSec > s.startSec)
}
