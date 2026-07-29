/**
 * Analysis worker entry point. All the heavy DSP runs here so the UI stays
 * responsive while a long jam is refined.
 *
 * The worker announces itself with `ready` as soon as its module graph has
 * loaded; the client waits for that before transferring the PCM buffer, so a
 * worker that fails to start can be detected without losing the audio.
 */
import { runAnalysis } from './pipeline'
import type { WorkerRequest, WorkerResponse } from './protocol'

/** Minimal view of DedicatedWorkerGlobalScope (lib.webworker is not in tsconfig). */
interface WorkerScope {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

const ctx = self as unknown as WorkerScope

function post(message: WorkerResponse): void {
  ctx.postMessage(message)
}

ctx.addEventListener('message', (event: MessageEvent) => {
  const request = event.data as WorkerRequest | undefined
  if (!request || request.type !== 'analyze') return
  try {
    const segments = runAnalysis(request.pcm, request.sampleRate, (p) =>
      post({ type: 'progress', status: p.status, progress: p.progress }),
    )
    post({ type: 'done', segments })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
})

post({ type: 'ready' })
