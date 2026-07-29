/**
 * Message protocol between engine.ts (main thread) and worker.ts.
 * Internal to src/lyrics — nothing outside the module should import this.
 */
import type { LyricWord, ModelProgress } from '../types'

export interface LoadRequest {
  type: 'load'
  id: number
}

export interface TranscribeRequest {
  type: 'transcribe'
  id: number
  /** 16 kHz mono PCM. Ownership is transferred to the worker. */
  audio: Float32Array
  durationSec: number
}

export type WorkerRequest = LoadRequest | TranscribeRequest

/** A request before the engine stamps it with a correlation id. */
export type WorkerRequestInit = Omit<LoadRequest, 'id'> | Omit<TranscribeRequest, 'id'>

export interface ProgressResponse {
  type: 'progress'
  id: number
  progress: ModelProgress
}

export interface LoadedResponse {
  type: 'loaded'
  id: number
}

export interface TranscribedResponse {
  type: 'transcribed'
  id: number
  words: LyricWord[]
}

export interface ErrorResponse {
  type: 'error'
  id: number
  message: string
}

export type WorkerResponse =
  | ProgressResponse
  | LoadedResponse
  | TranscribedResponse
  | ErrorResponse

/** Minimal view of `self` inside a module worker (tsconfig only pulls in the DOM lib). */
export interface LyricsWorkerScope {
  postMessage(message: WorkerResponse): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<WorkerRequest>) => void,
  ): void
}
