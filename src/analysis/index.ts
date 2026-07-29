/**
 * Public entry point for the music analysis module.
 *
 * `analyzeSession` is the post-recording refinement pass: segmentation, chords,
 * key, tempo and melody for the whole take. The work happens in a Web Worker;
 * this file is only the client for it.
 */
import { ANALYSIS_SAMPLE_RATE, type ModelProgress, type SessionAnalysis } from '../types'
import type { WorkerRequest, WorkerResponse } from './protocol'

export { LiveAnalyzer } from './live'
export type { AnalysisProgress } from './pipeline'

/** How long we wait for the worker module to load before giving up on it. */
const WORKER_READY_TIMEOUT_MS = 15000

function createWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null
  try {
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

/** Last-resort path: no workers available (or the worker failed to boot). */
async function analyzeOnMainThread(
  pcm: Float32Array,
  sampleRate: number,
  onProgress?: (p: ModelProgress) => void,
): Promise<SessionAnalysis> {
  const { runAnalysis } = await import('./pipeline')
  const segments = runAnalysis(pcm, sampleRate, (p) =>
    onProgress?.({ status: p.status, progress: p.progress }),
  )
  return { segments }
}

/**
 * Analyse a full session of 16 kHz mono PCM.
 *
 * The caller's buffer is never detached: the PCM is copied before being
 * transferred to the worker, so the same `Float32Array` can still be handed to
 * the lyrics engine afterwards.
 */
export function analyzeSession(
  pcm16k: Float32Array,
  onProgress?: (p: ModelProgress) => void,
): Promise<SessionAnalysis> {
  const sampleRate = ANALYSIS_SAMPLE_RATE
  onProgress?.({ status: 'Getting the recording ready to analyse…', progress: 0 })

  if (pcm16k.length === 0) {
    onProgress?.({ status: 'Nothing to analyse.', progress: 1 })
    return Promise.resolve({ segments: [] })
  }

  // The copy is what gets transferred; pcm16k itself stays intact for lyrics.
  const pcm = pcm16k.slice()
  const worker = createWorker()
  if (!worker) return analyzeOnMainThread(pcm, sampleRate, onProgress)

  return new Promise<SessionAnalysis>((resolve, reject) => {
    let settled = false
    let started = false
    let readyTimer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      if (readyTimer !== undefined) clearTimeout(readyTimer)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
    }

    const finish = (result: SessionAnalysis) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const fail = (message: string) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(message))
    }

    /** Worker never came up — run in this thread with the (untransferred) copy. */
    const fallback = () => {
      if (settled || started) return
      settled = true
      cleanup()
      analyzeOnMainThread(pcm, sampleRate, onProgress).then(resolve, reject)
    }

    const start = () => {
      if (started || settled) return
      started = true
      if (readyTimer !== undefined) clearTimeout(readyTimer)
      const request: WorkerRequest = { type: 'analyze', pcm, sampleRate }
      worker.postMessage(request, [pcm.buffer])
    }

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as WorkerResponse
      switch (message.type) {
        case 'ready':
          start()
          break
        case 'progress':
          onProgress?.({ status: message.status, progress: message.progress })
          break
        case 'done':
          onProgress?.({ status: 'Analysis complete.', progress: 1 })
          finish({ segments: message.segments })
          break
        case 'error':
          fail(message.message)
          break
      }
    }

    worker.onerror = (event: ErrorEvent) => {
      if (started) fail(event.message || 'The analysis worker failed.')
      else fallback()
    }

    readyTimer = setTimeout(fallback, WORKER_READY_TIMEOUT_MS)
  })
}
