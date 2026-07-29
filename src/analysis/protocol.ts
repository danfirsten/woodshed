/**
 * Message shapes exchanged with the analysis worker. Kept in its own module so
 * the main thread can type the channel without importing worker code.
 */
import type { JamSegment } from '../types'

export type WorkerRequest = {
  type: 'analyze'
  pcm: Float32Array
  sampleRate: number
}

export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; status: string; progress: number }
  | { type: 'done'; segments: JamSegment[] }
  | { type: 'error'; message: string }
