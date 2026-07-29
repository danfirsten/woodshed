/**
 * Public API for lyrics transcription (see docs/CONTRACTS.md — src/lyrics).
 *
 * Whisper runs entirely in the browser via transformers.js, inside a module
 * Web Worker that is kept alive between calls so the model stays warm. Nothing
 * leaves the device and no API keys are involved.
 */
import type { LyricWord, ModelProgress } from '../types'
import { LYRICS_SAMPLE_RATE } from './constants'
import { humanizeError, LyricsError } from './errors'
import { modelReadyProgress } from './progress'
import type { WorkerRequest, WorkerRequestInit, WorkerResponse } from './protocol'

type ProgressFn = (p: ModelProgress) => void

interface PendingCall {
  resolve: (words: LyricWord[]) => void
  reject: (err: Error) => void
  onProgress?: ProgressFn
}

const UNSUPPORTED =
  "This browser can't run on-device speech recognition (WebAssembly is unavailable). Lyrics transcription is disabled."

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, PendingCall>()

/** Model load is shared by every caller; progress is fanned out to all of them. */
let loadPromise: Promise<void> | null = null
let modelReady = false
let lastLoadProgress: ModelProgress | null = null
const loadListeners = new Set<ProgressFn>()

/** Only one transcription at a time — a single worker, a single ONNX session. */
let queue: Promise<unknown> = Promise.resolve()

/** WebAssembly is the hard requirement; WebGPU is a bonus the worker probes for. */
export function isLyricsSupported(): boolean {
  try {
    if (typeof WebAssembly === 'undefined') return false
    if (typeof WebAssembly.instantiate !== 'function') return false
    if (typeof Worker === 'undefined') return false
    return true
  } catch {
    return false
  }
}

function teardown(message: string): void {
  const failed = [...pending.values()]
  pending.clear()
  if (worker) {
    worker.terminate()
    worker = null
  }
  modelReady = false
  loadPromise = null
  lastLoadProgress = null
  for (const call of failed) call.reject(new LyricsError(message))
}

function handleMessage(response: WorkerResponse): void {
  const call = pending.get(response.id)
  if (!call) return
  switch (response.type) {
    case 'progress':
      call.onProgress?.(response.progress)
      break
    case 'loaded':
      pending.delete(response.id)
      call.resolve([])
      break
    case 'transcribed':
      pending.delete(response.id)
      call.resolve(response.words)
      break
    case 'error':
      pending.delete(response.id)
      call.reject(new LyricsError(response.message))
      break
  }
}

function ensureWorker(): Worker {
  if (worker) return worker
  const created = new Worker(new URL('./worker.ts', import.meta.url), {
    type: 'module',
  })
  created.onmessage = (event: MessageEvent<WorkerResponse>) => {
    handleMessage(event.data)
  }
  created.onerror = () => {
    teardown('The lyrics engine stopped unexpectedly. Reload the page and try again.')
  }
  created.onmessageerror = () => {
    teardown('The lyrics engine sent a message that could not be read.')
  }
  worker = created
  return created
}

function send(
  message: WorkerRequestInit,
  onProgress?: ProgressFn,
  transfer: Transferable[] = [],
): Promise<LyricWord[]> {
  return new Promise<LyricWord[]>((resolve, reject) => {
    let target: Worker
    try {
      target = ensureWorker()
    } catch (err) {
      reject(humanizeError(err, 'load'))
      return
    }
    const id = nextId++
    pending.set(id, { resolve, reject, onProgress })
    try {
      target.postMessage({ ...message, id } as WorkerRequest, transfer)
    } catch (err) {
      pending.delete(id)
      reject(humanizeError(err, 'transcribe'))
    }
  })
}

function emitLoadProgress(progress: ModelProgress): void {
  lastLoadProgress = progress
  for (const listener of [...loadListeners]) {
    try {
      listener(progress)
    } catch {
      // A misbehaving progress callback must not break the download.
    }
  }
}

function startLoad(): Promise<void> {
  const run = send({ type: 'load' }, emitLoadProgress).then(() => {
    modelReady = true
    emitLoadProgress(modelReadyProgress())
  })
  run.catch(() => {
    // Allow a retry after a transient failure (offline, etc.).
    if (loadPromise === run) loadPromise = null
    modelReady = false
  })
  return run
}

/**
 * Download + warm up the Whisper model. Idempotent: concurrent and repeat
 * callers share one download, and each caller's `onProgress` receives the
 * aggregated progress of that shared download.
 */
export function preloadLyricsModel(onProgress?: ProgressFn): Promise<void> {
  if (!isLyricsSupported()) {
    return Promise.reject(new LyricsError(UNSUPPORTED))
  }

  if (modelReady) {
    onProgress?.(modelReadyProgress())
    return Promise.resolve()
  }

  if (onProgress) {
    loadListeners.add(onProgress)
    if (lastLoadProgress) onProgress(lastLoadProgress)
  }

  if (!loadPromise) {
    lastLoadProgress = null
    loadPromise = startLoad()
  }

  const done = () => {
    if (onProgress) loadListeners.delete(onProgress)
  }
  return loadPromise.then(done, (err: unknown) => {
    done()
    throw humanizeError(err, 'load')
  })
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Transcribe 16 kHz mono PCM to words with ABSOLUTE times from the start of
 * `pcm16k`. Heavily filtered for Whisper's instrumental-audio hallucinations —
 * a jam with no singing comes back empty rather than full of "Thanks for
 * watching".
 *
 * The caller's buffer is copied, never detached.
 */
export async function transcribeLyrics(
  pcm16k: Float32Array,
  onProgress?: ProgressFn,
): Promise<LyricWord[]> {
  if (!isLyricsSupported()) throw new LyricsError(UNSUPPORTED)
  if (!pcm16k || pcm16k.length === 0) return []

  await preloadLyricsModel(onProgress)

  // Copy into a fresh ArrayBuffer so transferring it can't detach the caller's.
  const audio = new Float32Array(pcm16k.length)
  audio.set(pcm16k)
  const durationSec = audio.length / LYRICS_SAMPLE_RATE

  return enqueue(() =>
    send({ type: 'transcribe', audio, durationSec }, onProgress, [audio.buffer]),
  )
}
